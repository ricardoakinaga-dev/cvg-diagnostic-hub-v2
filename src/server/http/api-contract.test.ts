import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { API_OPERATIONS, matchApiOperation, type ApiOperation } from "./api-operation-manifest";

type JsonObject = Record<string, unknown>;

const document = JSON.parse(
  readFileSync(new URL("../../../docs/api/openapi.json", import.meta.url), "utf8")
) as JsonObject;
const methods = ["delete", "get", "patch", "post", "put"] as const;

const EXPECTED_RUNTIME_DATA_KINDS = Object.freeze({
  listAuditEvents: "array",
  searchDiagnostics: "array",
  getTimeline: "array"
} as const);

const EXPECTED_PERMISSION_ANCHORS = Object.freeze({
  getLiveness: [],
  getReadiness: [],
  getMetrics: ["health.readiness"],
  createUser: ["user_role.manage"],
  updateUserRole: ["user_role.manage"],
  deactivateUser: ["user_role.manage"],
  regenerateUserPassword: ["user_role.manage"],
  updateUserOnCall: ["user_role.manage"],
  reauthenticate: [],
  getPatientDiagnostics: ["patient.view", "diagnostic.timeline.view"],
  updateAdmissionContext: ["admission.context.manage"],
  viewResult: ["result.view", "result.view.record"],
  downloadAttachment: ["attachment.download", "attachment.view"],
  getManagementOverview: ["dashboard.view", "user_role.manage"]
} as const);

const expectedOperations = API_OPERATIONS.map(({ method, path }) => `${method} ${path}`).sort();

function object(value: unknown): JsonObject {
  expect(value).toBeTruthy();
  expect(typeof value).toBe("object");
  expect(Array.isArray(value)).toBe(false);
  return value as JsonObject;
}

function operations(): Array<{ key: string; path: string; method: string; operation: JsonObject }> {
  const paths = object(document.paths);
  return Object.entries(paths).flatMap(([path, rawPathItem]) => {
    const pathItem = object(rawPathItem);
    return methods.flatMap((method) => {
      const rawOperation = pathItem[method];
      return rawOperation === undefined
        ? []
        : [{ key: `${method.toUpperCase()} ${path}`, path, method, operation: object(rawOperation) }];
    });
  });
}

function parameterNames(operation: JsonObject): Set<string> {
  const parameters = Array.isArray(operation.parameters) ? operation.parameters : [];
  return new Set(parameters.flatMap((parameter) => {
    const candidate = object(parameter);
    return candidate.in === "path" && typeof candidate.name === "string" ? [candidate.name] : [];
  }));
}

function parametersIn(operation: JsonObject, location: string): Array<JsonObject> {
  const parameters = Array.isArray(operation.parameters) ? operation.parameters : [];
  return parameters.map(object).filter((parameter) => parameter.in === location);
}

function responseStatuses(operation: JsonObject, pattern: RegExp): Array<number> {
  return Object.keys(object(operation.responses)).filter((status) => pattern.test(status)).map(Number).sort((left, right) => left - right);
}

function schemaReference(value: unknown): string | undefined {
  const candidate = object(value);
  return typeof candidate.$ref === "string" ? candidate.$ref.split("/").at(-1) : undefined;
}

function schemaKind(schemas: JsonObject, schemaName: string): string | undefined {
  const schema = object(schemas[schemaName]);
  if (typeof schema.type === "string") return schema.type;
  const referenced = typeof schema.$ref === "string" ? schema.$ref.split("/").at(-1) : undefined;
  return referenced ? schemaKind(schemas, referenced) : undefined;
}

function manifestOperation(key: string): ApiOperation {
  const found = API_OPERATIONS.find(({ method, path }) => `${method} ${path}` === key);
  expect(found, `${key} manifest entry`).toBeTruthy();
  return found as ApiOperation;
}

function referencedPropertyNames(schemas: JsonObject, schemaName: string, seen = new Set<string>()): Set<string> {
  if (seen.has(schemaName)) return new Set();
  const nextSeen = new Set([...seen, schemaName]);
  const schema = object(schemas[schemaName]);
  const names = new Set<string>();
  const visit = (candidate: unknown): void => {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return;
    const value = candidate as JsonObject;
    if (typeof value.$ref === "string") {
      const referenced = value.$ref.split("/").at(-1);
      if (referenced) for (const name of referencedPropertyNames(schemas, referenced, nextSeen)) names.add(name);
    }
    if (value.properties && typeof value.properties === "object" && !Array.isArray(value.properties)) {
      for (const [name, property] of Object.entries(value.properties as JsonObject)) {
        names.add(name);
        visit(property);
      }
    }
    visit(value.items);
    for (const keyword of ["allOf", "anyOf", "oneOf"] as const) {
      if (Array.isArray(value[keyword])) for (const branch of value[keyword]) visit(branch);
    }
    if (value.additionalProperties && typeof value.additionalProperties === "object") visit(value.additionalProperties);
  };
  visit(schema);
  return names;
}

describe("exact OpenAPI contract", () => {
  it("requires an idempotency key for attachment upload sessions", () => {
    const operation = API_OPERATIONS.find((entry) => entry.operationId === "createAttachmentUploadSession");
    expect(operation?.requestHeaders).toContainEqual({ name: "idempotency-key", required: true });
  });

  it("requires an idempotency key for item rejection", () => {
    const operation = API_OPERATIONS.find((entry) => entry.operationId === "rejectDiagnosticItem");
    expect(operation?.requestHeaders).toContainEqual({ name: "idempotency-key", required: true });
  });

  it("paginates the notification collection at the public contract boundary", () => {
    const operation = API_OPERATIONS.find((entry) => entry.operationId === "listNotifications");
    expect(operation?.queryParameters?.map((parameter) => parameter.name)).toEqual(["filter", "cursor", "limit"]);
    const schemas = object(object(document.components).schemas);
    expect(object(schemas.NotificationList).maxItems).toBe(100);
  });

  it("keeps body expectedVersion optional wherever If-Match is an alternative", () => {
    const schemas = object(object(document.components).schemas);
    for (const schemaName of ["ManagedUserDeactivate", "UserRoleUpdate", "NotificationAcknowledge"]) {
      expect((object(schemas[schemaName]).required as string[] | undefined) ?? [], schemaName).not.toContain("expectedVersion");
    }
  });

  it("declares duplicate override replay and justification requirements", () => {
    const operation = operations().find(({ operation }) => operation.operationId === "createDiagnosticRequest")?.operation;
    expect(object(operation)["x-conditional-request-rules"]).toEqual([{
      when: { header: "X-Duplicate-Override", equals: "true" },
      requiredHeaders: ["Idempotency-Key"],
      requiredBodyFields: ["overrideReason"]
    }]);
  });

  it("uses only standard OpenAPI 3.1 component categories and explicit operations", () => {
    expect(document.openapi).toBe("3.1.0");
    expect(object(document.components)).not.toHaveProperty("operations");
    for (const { operation } of operations()) {
      expect(operation).not.toHaveProperty("$ref");
    }
  });

  it("matches every concrete runtime method and path without a wildcard action", () => {
    expect(operations().map(({ key }) => key).sort()).toEqual(expectedOperations);
    expect(API_OPERATIONS).toHaveLength(79);
    expect(new Set(API_OPERATIONS.map(({ path }) => path))).toHaveProperty("size", 73);
    expect(expectedOperations.some((key) => key.includes("{action}"))).toBe(false);
  });

  it("matches the manifest identity, auth, headers, bodies, media types, and responses", () => {
    const operationIds = new Set<string>();

    for (const { key, path, method, operation } of operations()) {
      const expected = manifestOperation(key);
      expect(operation.operationId, `${key} operationId`).toBe(expected.operationId);
      expect(operation.summary, `${key} summary`).toBe(expected.summary);
      expect(operation.tags, `${key} tags`).toEqual([expected.tag]);
      expect(operation.responses, `${key} responses`).toEqual(expect.any(Object));
      expect(operationIds.has(String(operation.operationId)), `${key} duplicate operationId`).toBe(false);
      operationIds.add(String(operation.operationId));

      if (expected.authentication === "public") {
        expect(operation.security, `${key} must be public`).toEqual([]);
      } else if (expected.csrf) {
        expect(operation.security, `${key} must require the session and CSRF cookie together`).toEqual([{ session: [], csrfCookie: [] }]);
      } else if (expected.serviceTokenScheme) {
        // GET /metrics: the session, or the Prometheus scrape token as an alternative (PROD-511).
        expect(operation.security, `${key} must accept the session or its service token`).toEqual([{ session: [] }, { [expected.serviceTokenScheme]: [] }]);
      } else {
        expect(operation.security, `${key} must use the opaque session`).toEqual([{ session: [] }]);
      }

      expect(operation["x-required-permissions"], `${key} permissions`).toEqual(expected.authorization.requiredPermissions);
      expect(operation["x-conditional-permission-rules"], `${key} conditional permissions`).toEqual(expected.authorization.conditionalPermissionRules);
      expect(operation["x-authorization-conditions"], `${key} authorization conditions`).toEqual(expected.authorization.conditions);
      expect(operation["x-step-up-required"], `${key} step-up`).toBe(expected.authorization.stepUpRequired);
      expect(operation["x-concurrency-guard"], `${key} concurrency guard`).toEqual(expected.concurrencyGuard);
      expect(operation["x-conditional-request-rules"], `${key} conditional request rules`).toEqual(expected.conditionalRequestRules);

      const headers = parametersIn(operation, "header").map((parameter) => ({
        name: String(parameter.name).toLowerCase(),
        required: parameter.required === true
      }));
      expect(headers, `${key} request headers`).toEqual(expected.requestHeaders);

      const names = parameterNames(operation);
      for (const name of path.matchAll(/\{([^}]+)\}/g)) {
        expect(names.has(name[1]), `${key} path parameter ${name[1]}`).toBe(true);
      }

      const queryNames = parametersIn(operation, "query").map((parameter) => String(parameter.name));
      expect(queryNames, `${key} query parameters`).toEqual((expected.queryParameters ?? []).map(({ name }) => name));

      if (expected.requestBody) {
        const requestBody = object(operation.requestBody);
        expect(requestBody.required, `${key} required request body`).toBe(true);
        const media = object(object(requestBody.content)[expected.requestBody.mediaType]);
        expect(schemaReference(media.schema), `${key} request schema`).toBe(expected.requestBody.schema);
        if (expected.requestBody.mediaType === "application/json") {
          const schemas = object(object(document.components).schemas);
          expect(object(schemas[expected.requestBody.schema]).additionalProperties, `${key} strict request object`).toBe(false);
        }
      } else {
        expect(operation.requestBody, `${key} must not accept a body`).toBeUndefined();
      }

      expect(responseStatuses(operation, /^2\d\d$/), `${key} success statuses`).toEqual(expected.successStatuses);
      expect(responseStatuses(operation, /^[45]\d\d$/), `${key} error statuses`).toEqual(expected.errorStatuses);
      for (const status of expected.successStatuses) {
        const response = object(object(operation.responses)[String(status)]);
        const content = object(response.content);
        expect(Object.keys(content), `${key} ${status} media types`).toEqual(expected.successMediaTypes);
        expect(Object.keys(object(response.headers)).map((name) => name.toLowerCase()), `${key} ${status} response headers`).toEqual(expected.successHeaders);
      }
      for (const status of expected.errorStatuses) {
        const response = object(object(operation.responses)[String(status)]);
        expect(Object.keys(object(response.headers)), `${key} ${status} safe response headers`).toEqual(["X-Correlation-Id", "Cache-Control"]);
        expect(object(response.content), `${key} ${status} safe error media`).toHaveProperty("application/json");
      }

      expect(expected.csrf, `${key} CSRF manifest invariant`).toBe(method !== "get" && expected.authentication === "session");
    }
  });

  it("matches paths exactly and rejects trailing segments or undeclared methods", () => {
    expect(matchApiOperation("post", ["diagnostic-items", "item-1", "cancel"])?.operationId).toBe("cancelDiagnosticItem");
    expect(matchApiOperation("POST", ["diagnostic-items", "item-1", "cancel", "trailing"])).toBeUndefined();
    expect(matchApiOperation("PATCH", ["diagnostic-items", "item-1", "cancel"])).toBeUndefined();
    expect(matchApiOperation("GET", ["patients", "encoded/slash"])).toBeUndefined();
    expect(matchApiOperation("GET", ["patients", "%"])).toBeUndefined();
    expect(matchApiOperation("GET", ["patients", "x".repeat(100)])?.operationId).toBe("getPatient");
    expect(matchApiOperation("GET", ["patients", "x".repeat(101)])).toBeUndefined();
    expect(matchApiOperation("GET", ["patients", "😀".repeat(100)])?.operationId).toBe("getPatient");
    expect(matchApiOperation("GET", ["patients", "😀".repeat(101)])).toBeUndefined();
    const getPatient = operations().find(({ operation }) => operation.operationId === "getPatient")?.operation;
    const patientId = parametersIn(object(getPatient), "path").find((parameter) => parameter.name === "patientId");
    expect(object(object(patientId).schema).pattern).toBe("^[^/%]+$");
  });

  it("describes each JSON success payload instead of accepting arbitrary data", () => {
    const schemas = object(object(document.components).schemas);
    expect(schemas).not.toHaveProperty("SuccessEnvelope");
    for (const { key, operation } of operations()) {
      const expected = manifestOperation(key);
      for (const status of responseStatuses(operation, /^2\d\d$/)) {
        const response = object(object(operation.responses)[String(status)]);
        const json = object(response.content)["application/json"];
        if (json === undefined) {
          expect(expected.successDataSchema, `${key} non-JSON success cannot declare JSON data`).toBeUndefined();
          continue;
        }
        expect(expected.successDataSchema, `${key} explicit manifest data schema`).toBeTruthy();
        const responseSchemaName = schemaReference(object(json).schema);
        expect(responseSchemaName, `${key} ${status} operation-specific response schema`).toBe(`${expected.operationId}SuccessResponse`);
        const responseSchema = object(schemas[String(responseSchemaName)]);
        expect(responseSchema.additionalProperties, `${key} ${status} strict response envelope`).toBe(false);
        expect(responseSchema.required, `${key} ${status} required response envelope fields`).toEqual(["data", "meta"]);
        const data = object(object(responseSchema.properties).data);
        expect(schemaReference(data), `${key} ${status} response data reference`).toBe(expected.successDataSchema);
        const dataSchema = object(schemas[String(expected.successDataSchema)]);
        const constrained = Object.keys(dataSchema).some((keyword) => ["type", "properties", "items", "oneOf", "allOf", "anyOf", "$ref"].includes(keyword));
        expect(constrained, `${key} ${status} data schema must be constrained`).toBe(true);
        const exposedNames = referencedPropertyNames(schemas, String(expected.successDataSchema));
        for (const forbidden of ["passwordHash", "sessionId", "tokenHash", "csrfTokenHash", "storageKey"]) {
          expect(exposedNames.has(forbidden), `${key} ${status} must not expose ${forbidden}`).toBe(false);
        }
      }
    }
  });

  it("documents the exact bounded search query language", () => {
    const schemas = object(object(document.components).schemas);
    expect(object(schemas.SearchQuery)).toMatchObject({ type: "string", minLength: 2, maxLength: 200 });
    const queryPattern = new RegExp(String(object(schemas.SearchQuery).pattern));
    expect(queryPattern.test("Thor")).toBe(true);
    expect(queryPattern.test("  Thor  ")).toBe(true);
    expect(queryPattern.test("  ")).toBe(false);
    expect(queryPattern.test("a ")).toBe(false);
    const pattern = new RegExp(String(object(schemas.SearchTypes).pattern));
    expect(pattern.test("REQUEST, ITEM")).toBe(true);
    expect(pattern.test("REQUEST,  ITEM,REQUEST")).toBe(true);
    expect(pattern.test("REQUEST,RESULT")).toBe(false);
  });

  it("publishes the runtime service identifier grammar for request filters", () => {
    const schemas = object(object(document.components).schemas);
    const serviceIdentifier = object(schemas.ServiceIdentifier);
    expect(serviceIdentifier).toMatchObject({ type: "string", minLength: 1, maxLength: 100, pattern: "^[A-Za-z0-9_-]+$" });
    const operation = operations().find(({ operation }) => operation.operationId === "listDiagnosticRequests")?.operation;
    const serviceId = parametersIn(object(operation), "query").find((parameter) => parameter.name === "serviceId");
    expect(schemaReference(object(serviceId).schema)).toBe("ServiceIdentifier");
    expect(new RegExp(String(serviceIdentifier.pattern)).test("service-hemogram")).toBe(true);
    expect(new RegExp(String(serviceIdentifier.pattern)).test("svc.test")).toBe(false);
  });

  it("uses independently declared runtime response kinds for paginated endpoint data", () => {
    const schemas = object(object(document.components).schemas);
    for (const [operationId, expectedKind] of Object.entries(EXPECTED_RUNTIME_DATA_KINDS)) {
      const manifest = API_OPERATIONS.find((operation) => operation.operationId === operationId);
      expect(manifest, `${operationId} manifest operation`).toBeTruthy();
      expect(schemaKind(schemas, String(manifest?.successDataSchema)), `${operationId} runtime data kind`).toBe(expectedKind);
    }
  });

  it("documents canonical permission anchors, scope conditions, and privileged step-up", () => {
    expect(object(object(document.components).securitySchemes)).toHaveProperty("csrfCookie");
    for (const [operationId, expectedPermissions] of Object.entries(EXPECTED_PERMISSION_ANCHORS)) {
      const manifest = API_OPERATIONS.find((operation) => operation.operationId === operationId);
      expect(manifest?.authorization.requiredPermissions, `${operationId} canonical permissions`).toEqual(expectedPermissions);
    }
    for (const operationId of ["createUser", "updateUserRole", "deactivateUser"]) {
      const manifest = API_OPERATIONS.find((operation) => operation.operationId === operationId);
      expect(manifest?.authorization.stepUpRequired, `${operationId} only requires step-up for ADMIN transitions`).toBe(false);
      expect(manifest?.authorization.conditions.join(" ")).toMatch(/ADMIN.*reauthentication/);
    }
    expect(API_OPERATIONS.find(({ operationId }) => operationId === "reauthenticate")?.authorization.stepUpRequired).toBe(false);
    expect(API_OPERATIONS.find(({ operationId }) => operationId === "getManagementOverview")?.authorization.conditions).toContain("role must be MANAGER");

    const userScopeConditions = {
      listUsers: "delegated MANAGER only sees operational-role targets in managed departments",
      createUser: "delegated MANAGER only creates operational-role targets in managed departments",
      updateUserRole: "actor cannot update self; delegated MANAGER must manage both current and proposed target role and department",
      deactivateUser: "actor cannot deactivate self; delegated MANAGER only deactivates operational-role targets in managed departments"
    } as const;
    for (const [operationId, condition] of Object.entries(userScopeConditions)) {
      const manifest = API_OPERATIONS.find((operation) => operation.operationId === operationId);
      expect(manifest?.authorization.conditions, `${operationId} target scope`).toContain(condition);
    }
  });

  it("separates unconditional permissions from state and input dependent permission rules", () => {
    const expected = {
      listDiagnosticServices: {
        required: [],
        conditional: [
          { when: "includeInactive is false or omitted", allOf: ["service.catalog.view"] },
          { when: "includeInactive is true", allOf: ["service.catalog.manage"] }
        ]
      },
      createDiagnosticRequest: {
        required: ["request.create"],
        conditional: [
          { when: "x-duplicate-override is true", allOf: ["request.duplicate_override"] }
        ]
      },
      getResult: {
        required: [],
        conditional: [
          { when: "current result version status is DRAFT and draft ownerId equals the actor id", allOf: ["result.draft.edit_own"] },
          { when: "current result version status is RELEASED", allOf: ["result.view"] }
        ]
      },
      getReport: {
        required: ["attachment.view"],
        conditional: [
          { when: "current result version status is DRAFT and draft ownerId equals the actor id", allOf: ["result.draft.edit_own"] },
          { when: "current result version status is RELEASED", allOf: ["result.view"] }
        ]
      }
    } as const;

    for (const [operationId, authorization] of Object.entries(expected)) {
      const operation = operations().find(({ operation }) => operation.operationId === operationId)?.operation;
      expect(operation?.["x-required-permissions"], `${operationId} unconditional permissions`).toEqual(authorization.required);
      expect(operation?.["x-conditional-permission-rules"], `${operationId} conditional permissions`).toEqual(authorization.conditional);
    }
  });

  it("locks conditional queries and boundary-sensitive request and response schemas", () => {
    const schemas = object(object(document.components).schemas);
    const search = operations().find(({ operation }) => operation.operationId === "searchDiagnostics")?.operation;
    expect(parametersIn(object(search), "query").find((parameter) => parameter.name === "q")?.required).toBe(true);
    const timeline = operations().find(({ operation }) => operation.operationId === "getTimeline")?.operation;
    expect(object(timeline)["x-query-constraints"]).toEqual({ atLeastOneOf: ["requestId", "itemId"] });
    for (const operationId of ["listDiagnosticRequests", "searchDiagnostics"]) {
      const operation = operations().find(({ operation }) => operation.operationId === operationId)?.operation;
      expect(object(operation)["x-query-constraints"], `${operationId} ordered date range`).toEqual({ fromMustNotExceedTo: true });
    }

    const schedule = object(schemas.ScheduleCommand);
    expect(object(object(schedule.properties).startsAt)).toMatchObject({ type: "string", format: "date-time", maxLength: 100, pattern: expect.any(String) });
    expect(object(object(schedule.properties).endsAt)).toMatchObject({ type: "string", format: "date-time", maxLength: 100, pattern: expect.any(String) });
    expect(schedule["x-cross-field-constraints"]).toEqual(["endsAt must be after startsAt", "endsAt - startsAt must be at most 24 hours"]);

    const procedureSchedule = object(schemas.ProcedureSchedule);
    expect(procedureSchedule.required).toContain("version");
    expect(object(procedureSchedule.properties).version).toMatchObject({ type: "integer", minimum: 1 });
    const sample = object(schemas.Sample);
    expect(object(sample.properties).accessionCode).toMatchObject({ minLength: 3, maxLength: 40, pattern: "^[A-Z0-9][A-Z0-9-]{2,39}$" });
    const patientSample = object(schemas.PatientWorkspaceSampleSummary);
    expect(object(patientSample.properties).accessionCode).toMatchObject({ minLength: 3, maxLength: 40, pattern: "^[A-Z0-9][A-Z0-9-]{2,39}$" });

    expect(object(object(object(schemas.AttachmentUploadSessionRequest).properties).mimeType).enum).toEqual(["application/pdf", "image/jpeg", "image/png"]);
    const managedUser = object(schemas.ManagedUserCreate);
    expect(object(object(managedUser.properties).password).pattern).toBe("^(?=.*[A-Za-z])(?=.*[0-9]).+$");
    expect(object(object(managedUser.properties).timezone)["x-runtime-validation"]).toBe("IANA time zone identifier validated by Intl.DateTimeFormat");
    expect(managedUser["x-role-constraints"]).toEqual({ managedDepartmentCodes: "allowed only when role is MANAGER" });
    expect(object(schemas.UserRoleUpdate)["x-role-constraints"]).toEqual({ managedDepartmentCodes: "allowed only when role is MANAGER" });

    expect(object(object(object(schemas.DiagnosticItem).properties).note).maxLength).toBe(2000);
    const requestItem = object(object(object(object(schemas.DiagnosticRequestCreate).properties).items).items);
    expect(object(object(requestItem.properties).note)["x-normalization"]).toBe("trim");
    expect(object(object(object(schemas.DiagnosticRequestCreate).properties).overrideReason)["x-normalization"]).toBe("trim");
    expect(object(object(object(schemas.ResultVersion).properties).conclusion).maxLength).toBe(5000);
  });

  it("does not assign one helper-wide generic error set to every operation family", () => {
    // 400 and 503 (dependency unavailable) apply to every operation; the rest stays per family.
    expect(API_OPERATIONS.every(({ errorStatuses }) => errorStatuses.includes(400) && errorStatuses.includes(503))).toBe(true);
    const serializedSets = API_OPERATIONS.map((operation) => JSON.stringify(operation.errorStatuses));
    expect(new Set(serializedSets).size).toBeGreaterThanOrEqual(11);
    expect(API_OPERATIONS.find(({ operationId }) => operationId === "getCurrentSession")?.errorStatuses).toEqual([400, 401, 429, 500, 503]);
    expect(API_OPERATIONS.find(({ operationId }) => operationId === "listUsers")?.errorStatuses).toEqual([400, 401, 404, 429, 500, 503]);
    expect(API_OPERATIONS.find(({ operationId }) => operationId === "uploadAttachmentContent")?.errorStatuses).toEqual([400, 401, 403, 404, 409, 415, 429, 500, 503]);
    expect(API_OPERATIONS.find(({ operationId }) => operationId === "finalizeAttachment")?.errorStatuses).toEqual([400, 401, 403, 404, 409, 415, 422, 429, 500, 503]);
  });
});
