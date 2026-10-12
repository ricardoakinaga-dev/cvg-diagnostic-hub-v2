import { readFile, writeFile } from "node:fs/promises";
import { isDeepStrictEqual } from "node:util";
import { PERMISSION_CODES } from "../src/server/security/access-group-policy.ts";
import { API_OPERATIONS } from "../src/server/http/api-operation-manifest.ts";
import { PLANNER_SEARCH_TYPES } from "../packages/contracts/src/hospital-tasks.ts";
import { hospitalPlanningRequestSchemas, hospitalPlanningResponseSchemas } from "./openapi-hospital-planning.mjs";
import { hospitalCollaborationRequestSchemas, hospitalCollaborationResponseSchemas } from "./openapi-hospital-collaboration.mjs";
import { hospitalWorkRequestSchemas, hospitalWorkResponseSchemas } from "./openapi-hospital-work.mjs";
import { hospitalExternalRequestSchemas, hospitalExternalResponseSchemas } from "./openapi-hospital-external.mjs";

const documentUrl = new URL("../docs/api/openapi.json", import.meta.url);
const schemaReference = (name) => ({ $ref: `#/components/schemas/${name}` });
const stringSchema = (minimum, maximum) => ({ type: "string", minLength: minimum, maxLength: maximum });
const normalizedTextSchema = (minimum, maximum) => {
  const core = minimum === 1
    ? maximum === 1 ? "\\S" : `\\S(?:[\\s\\S]{0,${maximum - 2}}\\S)?`
    : `\\S[\\s\\S]{${minimum - 2},${maximum - 2}}\\S`;
  return {
    type: "string",
    minLength: 1,
    pattern: `^[\\s]*${core}[\\s]*$`,
    "x-normalization": "trim",
    "x-normalized-min-length": minimum,
    "x-normalized-max-length": maximum
  };
};
const nonBlankStringSchema = (minimum, maximum) => ({
  ...stringSchema(minimum, maximum),
  pattern: "\\S"
});
const normalizedDepartmentCodeSchema = {
  type: "string",
  minLength: 1,
  pattern: "^[\\s]*[A-Za-z0-9_-]{1,60}[\\s]*$",
  "x-normalization": "trim and uppercase",
  "x-normalized-max-length": 60
};
const normalizedCatalogCodeSchema = {
  type: "string",
  minLength: 2,
  pattern: "^[\\s]*[A-Za-z][A-Za-z0-9_]{1,59}[\\s]*$",
  "x-normalization": "trim and uppercase",
  "x-normalized-min-length": 2,
  "x-normalized-max-length": 60
};
const identifier = stringSchema(1, 100);
const serviceIdentifier = { ...identifier, pattern: "^[A-Za-z0-9_-]+$" };
const pathIdentifier = { ...identifier, pattern: "^[^/%]+$" };
const strictDateTime = { type: "string", format: "date-time", minLength: 1, maxLength: 100, pattern: "^[0-9]{4}-[0-9]{2}-[0-9]{2}T.*(?:Z|[+-][0-9]{2}:[0-9]{2})$" };
const expectedVersion = { type: "integer", minimum: 1, maximum: 999999999999999 };
const expectedSampleVersion = { ...expectedVersion, description: "Versão da amostra física; independente da versão de cada exame. Recomendada para recoleta e obrigatória para receber tubos compartilhados com versões de exames divergentes." };
const accessionCodeSchema = { type: "string", minLength: 3, maxLength: 40, pattern: "^[A-Z0-9][A-Z0-9-]{2,39}$" };
const passwordPattern = "^(?=.*[A-Za-z])(?=.*[0-9]).+$";
const supportedAttachmentMediaTypes = ["application/pdf", "image/jpeg", "image/png"];
const roleCodes = ["SUPERADMIN", "ADMIN", "MANAGER", "VETERINARIAN", "INPATIENT_TEAM", "LAB_TECH", "RADIOLOGY_TEAM", "ULTRASOUND_TEAM", "VIEWER"];
const itemStates = ["REQUESTED", "RECEIVED", "IN_PROGRESS", "SCHEDULED", "AWAITING_REPORT", "RESULT_AVAILABLE", "REVIEWED", "COMPLETED", "CANCELLED", "REJECTED", "RECOLLECTION_REQUIRED", "FAILED", "RESULT_VOIDED"];

const strictObject = (properties, required = []) => ({
  type: "object",
  additionalProperties: false,
  ...(required.length ? { required } : {}),
  properties
});
const hasProperty = (name) => ({ properties: { [name]: {} }, required: [name] });

const serviceAccessPolicySchema = {
  ...strictObject({ mode: { type: "string", enum: ["NONE", "SELECTED", "ALL_CURRENT"] }, includeFuture: { type: "boolean" } }, ["mode", "includeFuture"]),
  "x-cross-field-constraints": ["includeFuture=true requires mode=ALL_CURRENT; execution uses materialized serviceCodes"]
};
const permissionSchema = { type: "string", enum: [...PERMISSION_CODES] };
const taskStateInputSchema = strictObject({ code: { type: "string", pattern: "^[A-Z][A-Z0-9_]{1,39}$" }, label: normalizedTextSchema(1, 80), phase: schemaReference("HospitalTaskPhase") }, ["code", "label", "phase"]);
const taskStatesInputSchema = { type: "array", minItems: 4, maxItems: 20, items: taskStateInputSchema, "x-cross-field-constraints": ["state codes must be distinct and all four phases must be present"] };
const taskCollaborators = { type: "array", maxItems: 100, uniqueItems: true, items: identifier };
const requestSchemas = {
  ...hospitalPlanningRequestSchemas,
  ...hospitalCollaborationRequestSchemas,
  ...hospitalExternalRequestSchemas,
  HospitalTaskTypeCreate: strictObject({ code: { ...stringSchema(2, 40), pattern: "^[A-Za-z][A-Za-z0-9_]{1,39}$" }, name: normalizedTextSchema(1, 120), careContextRequired: { type: "boolean" }, states: taskStatesInputSchema }, ["code", "name", "careContextRequired", "states"]),
  HospitalTaskTypePatch: strictObject({ name: normalizedTextSchema(1, 120), careContextRequired: { type: "boolean" }, states: taskStatesInputSchema, active: { type: "boolean" }, expectedVersion }),
  HospitalTaskCreate: strictObject({ title: normalizedTextSchema(1, 200), description: stringSchema(0, 4000), typeId: identifier, departmentCode: stringSchema(1, 60), patientId: identifier, encounterId: identifier, responsibleUserId: identifier, executorTeamUserIds: taskCollaborators, participantUserIds: taskCollaborators, priority: schemaReference("Priority"), plannedStartAt: strictDateTime, plannedEndAt: strictDateTime, parentTaskId: identifier, sortOrder: { type: "integer", minimum: 0, maximum: 1000000 }, serviceId: identifier, checklistTemplateId: identifier, documentIds: { type: "array", maxItems: 20, uniqueItems: true, items: identifier } }, ["title", "typeId", "departmentCode", "priority"]),
  HospitalTaskPatch: strictObject({ title: normalizedTextSchema(1, 200), description: stringSchema(0, 4000), plannedStartAt: { oneOf: [strictDateTime, { type: "null" }] }, plannedEndAt: { oneOf: [strictDateTime, { type: "null" }] }, parentTaskId: { oneOf: [identifier, { type: "null" }] }, sortOrder: { type: "integer", minimum: 0, maximum: 1000000 }, expectedVersion }),
  HospitalTaskContext: strictObject({ patientId: { oneOf: [identifier, { type: "null" }] }, encounterId: { oneOf: [identifier, { type: "null" }] }, expectedVersion }, ["patientId", "encounterId"]),
  HospitalTaskAssignment: strictObject({ responsibleUserId: { oneOf: [identifier, { type: "null" }] }, executorTeamUserIds: taskCollaborators, participantUserIds: taskCollaborators, expectedVersion }, ["responsibleUserId"]),
  HospitalTaskPriority: strictObject({ priority: schemaReference("Priority"), reason: normalizedTextSchema(1, 500), expectedVersion }, ["priority", "reason"]),
  HospitalTaskCommand: strictObject({ command: { type: "string", enum: ["START", "COMPLETE", "CANCEL"] }, stateCode: identifier, note: stringSchema(0, 4000), reason: normalizedTextSchema(1, 500), expectedVersion }, ["command"]),
  HospitalTaskDependencyCommand: strictObject({ targetType: { type: "string", enum: ["HOSPITAL_TASK", "DIAGNOSTIC_ITEM"] }, targetId: identifier, blocks: { type: "string", enum: ["START", "COMPLETE"] }, active: { type: "boolean" }, expectedVersion }, ["targetType", "targetId", "blocks", "active"]),
  HospitalIntakeCreate: strictObject({ title: normalizedTextSchema(1, 200), description: stringSchema(0, 4000), typeId: identifier, departmentCode: stringSchema(1, 60), patientId: identifier, encounterId: identifier, priority: schemaReference("Priority"), source: { type: "string", enum: ["MANUAL", "DIAGNOSTIC_REQUEST"] }, sourceRequestId: identifier, sourceLabel: normalizedTextSchema(1, 120) }, ["title", "departmentCode", "priority", "source"]),
  HospitalIntakeTriage: { ...strictObject({ decision: { type: "string", enum: ["ACCEPT", "REJECT", "DEFER", "DUPLICATE"] }, reason: normalizedTextSchema(1, 500), reasonCode: { type: "string", pattern: "^[A-Z][A-Z0-9_]{0,59}$" }, reasonPolicyVersion: normalizedTextSchema(1, 100), destinationDepartmentCode: stringSchema(1, 60), destinationTaskId: identifier, duplicateOfIntakeId: identifier, expectedVersion }, ["decision"]), "x-cross-field-constraints": ["reasonCode and reasonPolicyVersion must be supplied together and only for REJECT; the server resolves and snapshots the current approved reason"] },
  HospitalServiceCreate: strictObject({ code: normalizedDepartmentCodeSchema, name: normalizedTextSchema(1, 160), description: normalizedTextSchema(1, 1000), kind: schemaReference("HospitalServiceKind"), departmentCode: normalizedDepartmentCodeSchema, teamUserIds: { type: "array", maxItems: 500, uniqueItems: true, items: identifier, default: [] }, resourceIds: { type: "array", maxItems: 500, uniqueItems: true, items: identifier, default: [] }, active: { type: "boolean", default: true } }, ["code", "name", "kind", "departmentCode"]),
  HospitalServicePatch: strictObject({ name: normalizedTextSchema(1, 160), description: { oneOf: [normalizedTextSchema(1, 1000), { type: "null" }] }, kind: schemaReference("HospitalServiceKind"), departmentCode: normalizedDepartmentCodeSchema, teamUserIds: { type: "array", maxItems: 500, uniqueItems: true, items: identifier }, resourceIds: { type: "array", maxItems: 500, uniqueItems: true, items: identifier }, active: { type: "boolean" }, expectedVersion }),
  HospitalServiceImport: strictObject({ csv: stringSchema(1, 2000000), dryRun: { type: "boolean", default: true } }, ["csv"]),
  PlannerViewCreate: strictObject({ name: normalizedTextSchema(1, 120), sharedDepartmentCode: normalizedDepartmentCodeSchema, filters: schemaReference("PlannerViewFilters"), display: schemaReference("PlannerViewDisplay") }, ["name", "filters", "display"]),
  PlannerViewPatch: strictObject({ name: normalizedTextSchema(1, 120), sharedDepartmentCode: { oneOf: [normalizedDepartmentCodeSchema, { type: "null" }] }, filters: schemaReference("PlannerViewFilters"), display: schemaReference("PlannerViewDisplay"), active: { type: "boolean", const: true }, expectedVersion }),
  PlannerViewDeactivate: strictObject({ expectedVersion }),
  DiagnosticItemAssignment: strictObject({ userId: { oneOf: [identifier, { type: "null" }] }, expectedVersion }, ["userId"]),
  DiagnosticItemPlanning: { ...strictObject({ plannedStartsAt: { oneOf: [strictDateTime, { type: "null" }] }, plannedEndsAt: { oneOf: [strictDateTime, { type: "null" }] }, expectedVersion }, ["plannedStartsAt", "plannedEndsAt"]), "x-cross-field-constraints": ["both dates must be null or startsAt must precede endsAt"] },
  DiagnosticItemPriority: strictObject({ priority: { type: "string", enum: ["ROUTINE", "URGENT", "EMERGENCY"] }, reason: normalizedTextSchema(1, 500), expectedVersion }, ["priority", "reason"]),
  PrepareExamTemplate: strictObject({ expectedVersion, template: strictObject({ code: { ...normalizedTextSchema(2, 60), pattern: "^[A-Za-z][A-Za-z0-9_]{1,59}$" }, name: normalizedTextSchema(1, 160), schemaVersion: normalizedTextSchema(1, 80), analytes: { type: "array", minItems: 1, maxItems: 200, items: schemaReference("ExamTemplateAnalyteInput") } }, ["code", "name", "schemaVersion", "analytes"]) }, ["expectedVersion", "template"]),
  PublishExamTemplate: strictObject({ expectedVersion, policyReference: normalizedTextSchema(1, 500), population: schemaReference("LaboratoryPopulation"), confirm: { type: "boolean", const: true } }, ["expectedVersion", "policyReference", "population", "confirm"]),
  RetireExamTemplate: strictObject({ expectedVersion, reason: normalizedTextSchema(1, 500) }, ["expectedVersion", "reason"]),
  AccessGroupCreate: strictObject({ code: { ...stringSchema(1, 120), pattern: "^[\\s]*[A-Za-z][A-Za-z0-9_-]{1,59}[\\s]*$" }, description: normalizedTextSchema(1, 160), permissions: { type: "array", maxItems: PERMISSION_CODES.length, uniqueItems: true, items: permissionSchema } }, ["code", "description", "permissions"]),
  AccessGroupPatch: strictObject({ description: normalizedTextSchema(1, 160), permissions: { type: "array", maxItems: PERMISSION_CODES.length, uniqueItems: true, items: permissionSchema }, active: { type: "boolean" }, expectedVersion, expectedImpactToken: { type: "string", pattern: "^[a-f0-9]{64}$" } }, ["expectedVersion"]),
  AccessGroupImpactPreviewRequest: strictObject({ description: normalizedTextSchema(1, 160), permissions: { type: "array", maxItems: PERMISSION_CODES.length, uniqueItems: true, items: permissionSchema }, active: { type: "boolean" }, expectedVersion }, ["expectedVersion"]),
  UserGroupAssignment: strictObject({ accessGroupId: identifier, expectedVersion, expectedGroupVersion: expectedVersion }, ["accessGroupId", "expectedVersion"]),
  EffectiveAccessPreviewRequest: strictObject({ accessGroupId: identifier, permissions: { type: "array", maxItems: PERMISSION_CODES.length, uniqueItems: true, items: permissionSchema } }),
  PatientGrantCommand: strictObject({ patientId: identifier, active: { type: "boolean" }, reason: normalizedTextSchema(1, 500), expectedVersion }, ["patientId", "active", "reason", "expectedVersion"]),
  DepartmentCreate: strictObject({ code: normalizedDepartmentCodeSchema, name: normalizedTextSchema(1, 120), type: { type: "string", enum: ["CLINICAL", "DIAGNOSTIC", "ADMINISTRATIVE", "SUPPORT"] } }, ["code", "name", "type"]),
  DepartmentPatch: strictObject({ name: normalizedTextSchema(1, 120), type: { type: "string", enum: ["CLINICAL", "DIAGNOSTIC", "ADMINISTRATIVE", "SUPPORT"] }, active: { type: "boolean", const: true }, expectedVersion }),
  DepartmentDeactivate: strictObject({ expectedVersion }),
  DepartmentMembers: strictObject({ memberUserIds: { type: "array", maxItems: 500, items: identifier }, responsibleUserId: { oneOf: [identifier, { type: "null" }] }, expectedVersion }, ["memberUserIds"]),
  LoginRequest: strictObject({
    email: { type: "string", format: "email", maxLength: 320 },
    password: stringSchema(1, 200)
  }, ["email", "password"]),
  ReauthenticationRequest: strictObject({ password: stringSchema(1, 200) }, ["password"]),
  InitialPasswordRequest: strictObject({ password: { ...stringSchema(12, 200), pattern: passwordPattern } }, ["password"]),
  PasswordChangeRequest: strictObject({ currentPassword: stringSchema(1, 200), newPassword: { ...stringSchema(12, 200), pattern: passwordPattern } }, ["currentPassword", "newPassword"]),
  PatientCreate: {
    ...strictObject({
      displayName: normalizedTextSchema(2, 120), species: normalizedTextSchema(2, 60), breed: normalizedTextSchema(2, 120),
      sex: normalizedTextSchema(1, 40), birthDate: { type: "string", format: "date", pattern: "^[0-9]{4}-[0-9]{2}-[0-9]{2}$" },
      ownerLabel: normalizedTextSchema(2, 160), externalId: normalizedTextSchema(1, 100),
      encounterType: { type: "string", enum: ["INPATIENT", "EMERGENCY", "OUTPATIENT"] },
      ward: normalizedTextSchema(1, 100), bed: normalizedTextSchema(1, 100), bedResourceId: identifier
    }, ["displayName", "species", "breed", "sex", "ownerLabel", "encounterType"]),
    "x-cross-field-constraints": [
      "encounterType=INPATIENT requires bedResourceId in production or configured inventory; complete ward and bed are accepted only by the legacy demo policy",
      "ward, bed and bedResourceId are only accepted for encounterType=INPATIENT; supplied labels must match the selected bed",
      "externalId is generated when omitted"
    ]
  },
  EncounterOpen: {
    ...strictObject({
      encounterType: { type: "string", enum: ["INPATIENT", "EMERGENCY", "OUTPATIENT"] },
      ward: normalizedTextSchema(1, 100), bed: normalizedTextSchema(1, 100), bedResourceId: identifier, reason: normalizedTextSchema(1, 500)
    }, ["encounterType"]),
    "x-cross-field-constraints": [
      "encounterType=INPATIENT requires bedResourceId in production or configured inventory; complete ward and bed are accepted only by the legacy demo policy",
      "ward, bed and bedResourceId are only accepted for encounterType=INPATIENT; supplied labels must match the selected bed",
      "the patient must be active and have no open encounter"
    ]
  },
  EncounterClose: strictObject({ reason: normalizedTextSchema(1, 500) }),
  ManagedUserCreate: {
    ...strictObject({
    email: { type: "string", format: "email", maxLength: 320 }, displayName: normalizedTextSchema(2, 160),
    password: { ...stringSchema(12, 200), pattern: passwordPattern }, role: { type: "string", enum: roleCodes }, departmentCode: normalizedDepartmentCodeSchema,
    managedDepartmentCodes: { type: "array", maxItems: 20, items: normalizedDepartmentCodeSchema }, serviceCodes: { type: "array", maxItems: 200, items: normalizedCatalogCodeSchema },
    serviceAccessPolicy: serviceAccessPolicySchema,
    timezone: { ...normalizedTextSchema(1, 80), "x-runtime-validation": "IANA time zone identifier validated by Intl.DateTimeFormat" },
    reason: normalizedTextSchema(1, 500), confirm: { type: "boolean", const: true }
    }, ["email", "displayName", "role"]),
    "x-role-constraints": { managedDepartmentCodes: "allowed only when role is MANAGER" }
  },
  ManagedUserDeactivate: strictObject({ expectedVersion, reason: normalizedTextSchema(1, 500), confirm: { type: "boolean", const: true } }),
  ManagedUserPasswordReset: strictObject({ expectedVersion }),
  PasswordResetLinkRequest: strictObject({ expectedVersion }),
  PasswordResetCompletion: strictObject({ token: stringSchema(1, 200), password: { ...stringSchema(12, 200), pattern: passwordPattern } }, ["token", "password"]),
  UserOnCallUpdate: strictObject({ onCall: { type: "boolean" }, expectedVersion, reason: normalizedTextSchema(1, 500) }, ["onCall"]),
  AlertContactUpdate: {
    ...strictObject({
      whatsappPhone: { oneOf: [{ ...stringSchema(1, 40), pattern: "^[0-9+()\\s.-]+$", "x-runtime-validation": "normalized to E.164; 10 or 11 digits without a country code are a Brazilian number with area code" }, { type: "null" }] },
      consent: { type: "boolean", const: true }
    }, ["whatsappPhone"]),
    "x-cross-field-constraints": ["a non-null whatsappPhone requires consent=true", "whatsappPhone=null removes the number and its consent"]
  },
  UserRoleUpdate: {
    ...strictObject({
      email: { type: "string", format: "email", maxLength: 320 }, displayName: normalizedTextSchema(2, 160),
      role: { type: "string", enum: roleCodes }, departmentCode: normalizedDepartmentCodeSchema,
      managedDepartmentCodes: { type: "array", maxItems: 20, items: normalizedDepartmentCodeSchema }, serviceCodes: { type: "array", maxItems: 200, items: normalizedCatalogCodeSchema }, active: { type: "boolean" }, serviceAccessPolicy: serviceAccessPolicySchema,
      expectedVersion, reason: normalizedTextSchema(1, 500), confirm: { type: "boolean", const: true }
    }, ["role", "departmentCode"]),
    "x-role-constraints": { managedDepartmentCodes: "allowed only when role is MANAGER" }
  },
  SessionRevoke: strictObject({ reason: normalizedTextSchema(1, 500), confirm: { type: "boolean", const: true } }),
  WhatsAppWebhookEvent: {
    ...strictObject({ object: { type: "string", maxLength: 100 }, entry: { type: "array", maxItems: 1000, items: { type: "object", additionalProperties: true } } }, ["object", "entry"]),
    "x-runtime-validation": "Meta webhook envelope; only entry[].changes[field=messages].value.statuses[] are read, recipient and pricing data are discarded"
  },
  DeadLetterCommand: strictObject({ reason: normalizedTextSchema(1, 500), confirm: { type: "boolean", const: true } }),
  DiagnosticServiceCreate: {
    ...strictObject({
    code: normalizedCatalogCodeSchema, name: normalizedTextSchema(1, 120), category: { type: "string", enum: ["LABORATORY", "IMAGING"] },
    departmentCode: normalizedDepartmentCodeSchema, workflowType: { type: "string", enum: ["LABORATORY", "RADIOLOGY", "ULTRASOUND"] },
    requiresSample: { type: "boolean" }, sampleType: normalizedTextSchema(1, 60), requiresSchedule: { type: "boolean" }, allowsAttachment: { type: "boolean" },
    resultSchema: { type: "string", enum: ["NUMERIC_PANEL", "NARRATIVE"] }, duplicateOfServiceId: identifier, slaHours: schemaReference("SlaHours")
    }, ["code", "name", "category", "departmentCode", "workflowType", "requiresSample", "requiresSchedule", "allowsAttachment", "resultSchema", "slaHours"]),
    oneOf: [
      { required: ["category", "workflowType"], properties: { category: { const: "LABORATORY" }, workflowType: { const: "LABORATORY" } } },
      { required: ["category", "workflowType"], properties: { category: { const: "IMAGING" }, workflowType: { enum: ["RADIOLOGY", "ULTRASOUND"] } } }
    ],
    "x-cross-field-constraints": [
      "category=LABORATORY requires workflowType=LABORATORY",
      "category=IMAGING requires workflowType=RADIOLOGY or ULTRASOUND"
    ]
  },
  CatalogImportRequest: strictObject({
    services: stringSchema(1, 1000000), analytes: stringSchema(1, 1000000), dryRun: { type: "boolean" }
  }, ["services"]),
  DiagnosticServicePatch: {
    ...strictObject({
    name: normalizedTextSchema(1, 120), category: { type: "string", enum: ["LABORATORY", "IMAGING"] }, departmentCode: normalizedDepartmentCodeSchema,
    workflowType: { type: "string", enum: ["LABORATORY", "RADIOLOGY", "ULTRASOUND"] }, requiresSample: { type: "boolean" },
    sampleType: { oneOf: [normalizedTextSchema(1, 60), { type: "null" }] },
    requiresSchedule: { type: "boolean" }, active: { type: "boolean" }, allowsAttachment: { type: "boolean" },
    resultSchema: { type: "string", enum: ["NUMERIC_PANEL", "NARRATIVE"] }, slaHours: schemaReference("SlaHours"), expectedVersion
    }),
    allOf: [
      {
        if: { required: ["category", "workflowType"], properties: { category: { const: "LABORATORY" }, workflowType: {} } },
        then: { properties: { workflowType: { const: "LABORATORY" } } }
      },
      {
        if: { required: ["category", "workflowType"], properties: { category: { const: "IMAGING" }, workflowType: {} } },
        then: { properties: { workflowType: { enum: ["RADIOLOGY", "ULTRASOUND"] } } }
      }
    ],
    "x-cross-field-constraints": [
      "when category and workflowType are both supplied, LABORATORY requires LABORATORY and IMAGING requires RADIOLOGY or ULTRASOUND",
      "when only one field is supplied, compatibility is evaluated against the persisted counterpart"
    ]
  },
  ReasonCodeCreate: strictObject({ type: { type: "string", enum: ["RECOLLECTION", "CANCEL", "REJECT", "AMEND"] }, code: normalizedCatalogCodeSchema, label: normalizedTextSchema(1, 160) }, ["type", "code", "label"]),
  ReasonCodePatch: strictObject({ label: normalizedTextSchema(1, 160), active: { type: "boolean" }, expectedVersion }),
  DiagnosticRequestCreate: strictObject({
    patientId: identifier, encounterId: identifier, admissionId: identifier,
    priority: { type: "string", enum: ["ROUTINE", "URGENT", "EMERGENCY"] },
    items: { type: "array", minItems: 1, maxItems: 20, items: strictObject({ serviceId: identifier, note: normalizedTextSchema(1, 2000) }, ["serviceId"]) },
    overrideReason: normalizedTextSchema(1, 500)
  }, ["patientId", "encounterId", "priority", "items"]),
  AdmissionContextCommand: {
    ...strictObject({
      action: { type: "string", enum: ["TRANSFER", "BED_CHANGE", "DISCHARGE", "RESPONSIBILITY_CHANGE"] },
      effectiveAt: strictDateTime,
      reason: normalizedTextSchema(1, 500),
      departmentCode: normalizedDepartmentCodeSchema,
      ward: normalizedTextSchema(1, 100),
      bed: normalizedTextSchema(1, 100),
      bedResourceId: identifier,
      responsibleUserId: normalizedTextSchema(1, 100),
      expectedVersion
    }, ["action", "effectiveAt", "reason"]),
    oneOf: [
      { properties: { action: { const: "TRANSFER" } }, required: ["departmentCode", "responsibleUserId"], anyOf: [hasProperty("bedResourceId"), { required: ["ward", "bed"] }] },
      {
        properties: { action: { const: "BED_CHANGE" } }, anyOf: [hasProperty("bedResourceId"), { required: ["ward", "bed"] }],
        not: { anyOf: [hasProperty("departmentCode"), hasProperty("responsibleUserId")] }
      },
      {
        properties: { action: { const: "DISCHARGE" } },
        not: { anyOf: [hasProperty("departmentCode"), hasProperty("ward"), hasProperty("bed"), hasProperty("bedResourceId"), hasProperty("responsibleUserId")] }
      },
      {
        properties: { action: { const: "RESPONSIBILITY_CHANGE" } }, required: ["responsibleUserId"],
        not: { anyOf: [hasProperty("departmentCode"), hasProperty("ward"), hasProperty("bed"), hasProperty("bedResourceId")] }
      }
    ],
    "x-policy-gate": "D-01 must be approved and configured; missing or invalid policy fails closed with 503"
  },
  VersionCommand: strictObject({ expectedVersion }),
  CancelCommand: strictObject({ reasonCode: normalizedTextSchema(1, 60), reason: normalizedTextSchema(1, 500), itemIds: { type: "array", maxItems: 20, uniqueItems: true, items: normalizedTextSchema(1, 100) }, expectedVersion }, ["reasonCode"]),
  RejectCommand: strictObject({ reasonCode: normalizedTextSchema(1, 60), note: normalizedTextSchema(1, 2000), expectedVersion }, ["reasonCode"]),
  SampleCommand: strictObject({ accessionCode: accessionCodeSchema, sampleType: normalizedTextSchema(1, 100), expectedVersion, expectedSampleVersion }),
  RecollectionCommand: strictObject({ reasonCode: normalizedTextSchema(1, 60), note: normalizedTextSchema(1, 2000), expectedVersion, expectedSampleVersion }, ["reasonCode"]),
  ScheduleCommand: {
    ...strictObject({
      startsAt: strictDateTime,
      endsAt: strictDateTime,
      resource: normalizedTextSchema(1, 100), resourceIds: { type: "array", minItems: 1, maxItems: 20, uniqueItems: true, items: identifier }, reason: normalizedTextSchema(1, 500), expectedVersion
    }, ["startsAt", "endsAt"]),
    anyOf: [hasProperty("resourceIds"), hasProperty("resource")],
    "x-cross-field-constraints": ["endsAt must be after startsAt", "endsAt - startsAt must be at most 24 hours", "resourceIds are required in production or configured inventory; text-only reservation is limited to legacy demo policy"]
  },
  ResultDraftCommand: strictObject({
    narrative: normalizedTextSchema(1, 20000), conclusion: normalizedTextSchema(1, 5000),
    content: { anyOf: [schemaReference("StructuredLaboratoryResultCommandContent"), { type: "object", maxProperties: 100, propertyNames: { maxLength: 100 }, additionalProperties: true }] }, expectedVersion
  }, ["narrative", "content"]),
  ReleaseResultCommand: strictObject({ critical: { type: "boolean" }, expectedVersion }),
  AmendResultCommand: strictObject({
    reason: normalizedTextSchema(1, 500), narrative: normalizedTextSchema(1, 20000), conclusion: normalizedTextSchema(1, 5000),
    content: { anyOf: [schemaReference("StructuredLaboratoryResultCommandContent"), { type: "object", maxProperties: 100, propertyNames: { maxLength: 100 }, additionalProperties: true }] },
    critical: { type: "boolean" }, expectedVersion
  }, ["reason", "narrative", "content"]),
  VoidResultCommand: strictObject({ reason: normalizedTextSchema(1, 500), expectedVersion }, ["reason"]),
  ReviewResultCommand: strictObject({ versionId: normalizedTextSchema(1, 100), expectedVersion }, ["versionId"]),
  AttachmentUploadSessionRequest: strictObject({
    filename: normalizedTextSchema(1, 255), mimeType: { type: "string", enum: supportedAttachmentMediaTypes }, sizeBytes: { type: "integer", minimum: 1, maximum: 26214400 },
    checksum: { type: "string", pattern: "^[a-fA-F0-9]{64}$" }, expectedVersion
  }, ["filename", "mimeType", "sizeBytes", "checksum"]),
  AttachmentBinary: { type: "string", format: "binary", maxLength: 26214400 },
  NotificationAcknowledge: strictObject({ expectedVersion, reason: normalizedTextSchema(1, 500), confirm: { type: "boolean", const: true } }, ["reason", "confirm"])
};
Object.assign(requestSchemas, hospitalWorkRequestSchemas);

const timestamp = { type: "string", format: "date-time" };
const boundedString = { type: "string", maxLength: 20000 };
const nonNegativeInteger = { type: "integer", minimum: 0 };
const positiveVersion = { type: "integer", minimum: 1 };
const prioritySchema = { type: "string", enum: ["ROUTINE", "URGENT", "EMERGENCY"] };
const workflowSchema = { type: "string", enum: ["LABORATORY", "RADIOLOGY", "ULTRASOUND"] };
const aggregateStatusSchema = { type: "string", enum: ["REQUESTED", "IN_PROGRESS", "PARTIALLY_AVAILABLE", "RESULTS_AVAILABLE", "COMPLETED", "CANCELLED"] };
const resultVersionStateSchema = { type: "string", enum: ["DRAFT", "RELEASED", "SUPERSEDED", "VOIDED"] };
const arrayOf = (schema, options = {}) => ({ type: "array", items: schema, ...options });

const userIdentityProperties = {
  id: identifier, email: { type: "string", format: "email", maxLength: 320 }, displayName: stringSchema(1, 160),
  role: { type: "string", enum: roleCodes }, departmentCode: stringSchema(1, 60),
  managedDepartmentCodes: arrayOf(stringSchema(1, 60), { maxItems: 20 }), timezone: stringSchema(1, 80), mustChangePassword: { type: "boolean" }
};
const publicUserSchema = strictObject({
  ...userIdentityProperties, permissions: arrayOf(permissionSchema, { uniqueItems: true }), onCall: { type: "boolean" },
  alertContact: strictObject({ maskedPhone: stringSchema(8, 20), consentAt: timestamp }, ["maskedPhone", "consentAt"])
}, ["id", "email", "displayName", "role", "departmentCode", "timezone"]);
const managedUserSchema = strictObject({
  ...userIdentityProperties, accessGroupId: identifier, serviceAccessPolicy: serviceAccessPolicySchema, serviceCodes: arrayOf(normalizedCatalogCodeSchema, { maxItems: 200 }), active: { type: "boolean" }, createdAt: timestamp, version: positiveVersion,
  onCall: { type: "boolean" }, alertContactReady: { type: "boolean" }
}, ["id", "email", "displayName", "role", "departmentCode", "timezone", "active", "createdAt", "version"]);
const patientSchema = strictObject({
  id: identifier, displayName: stringSchema(1, 200), species: stringSchema(1, 100), breed: stringSchema(1, 100),
  sex: stringSchema(1, 40), birthDate: { type: "string", format: "date" }, ownerLabel: stringSchema(1, 200),
  externalId: stringSchema(1, 100), active: { type: "boolean" }
}, ["id", "displayName", "species", "breed", "sex", "ownerLabel", "externalId", "active"]);
const encounterSchema = strictObject({
  id: identifier, patientId: identifier, externalId: stringSchema(1, 100), type: { type: "string", enum: ["INPATIENT", "EMERGENCY", "OUTPATIENT"] },
  status: { type: "string", enum: ["OPEN", "CLOSED"] }, openedAt: timestamp, closedAt: timestamp
}, ["id", "patientId", "externalId", "type", "status", "openedAt"]);
const admissionSchema = strictObject({
  id: identifier, encounterId: identifier, departmentCode: stringSchema(1, 60), ward: stringSchema(1, 100), bed: stringSchema(1, 100), bedResourceId: identifier,
  admittedAt: timestamp, dischargedAt: timestamp, responsibleUserId: identifier, contextEffectiveAt: timestamp, updatedAt: timestamp, version: positiveVersion
}, ["id", "encounterId", "departmentCode", "ward", "bed", "admittedAt", "version"]);
const admissionContextCommandResultSchema = strictObject({
  admission: schemaReference("Admission"), encounter: schemaReference("Encounter"), affectedRequestCount: nonNegativeInteger,
  openItemCount: nonNegativeInteger, openItemsPreserved: { type: "boolean", const: true }, policyVersion: stringSchema(1, 100)
}, ["admission", "encounter", "affectedRequestCount", "openItemCount", "openItemsPreserved", "policyVersion"]);
const laboratoryReferenceRangeSchema = strictObject({
  kind: { type: "string", enum: ["NUMERIC", "PENDING_POLICY"] }, unitCode: stringSchema(1, 100),
  low: { type: "number" }, high: { type: "number" },
  source: { type: "string", enum: ["HUMAN_APPROVED", "SYNTHETIC_FIXTURE", "PENDING_HUMAN_POLICY"] }, note: stringSchema(1, 500)
}, ["kind", "unitCode", "source"]);
const laboratoryAnalyteDefinitionSchema = strictObject({
  code: stringSchema(1, 100), label: stringSchema(1, 200), valueType: { type: "string", enum: ["NUMERIC", "QUALITATIVE", "TEXT"] },
  unitCode: stringSchema(1, 100), required: { type: "boolean" }, displayOrder: { type: "integer", minimum: 0, maximum: 10000 },
  referenceRange: laboratoryReferenceRangeSchema, allowedValues: arrayOf(stringSchema(1, 200), { maxItems: 100 })
}, ["code", "label", "valueType", "unitCode", "required", "displayOrder"]);
const laboratoryPanelTemplateSchema = strictObject({
  kind: { type: "string", const: "LABORATORY_PANEL" }, code: stringSchema(1, 100), name: stringSchema(1, 200),
  version: positiveVersion, schemaVersion: stringSchema(1, 40), status: { type: "string", enum: ["DRAFT", "ACTIVE", "RETIRED"] },
  approval: schemaReference("LaboratoryTemplateApproval"),
  analytes: arrayOf(schemaReference("LaboratoryAnalyteDefinition"), { minItems: 1, maxItems: 200 })
}, ["kind", "code", "name", "version", "schemaVersion", "status", "analytes"]);
const laboratoryObservationSchema = strictObject({
  analyteCode: stringSchema(1, 100), value: { oneOf: [{ type: "number" }, stringSchema(1, 2000)] }, unitCode: stringSchema(1, 100),
  flag: { type: "string", enum: ["NORMAL", "LOW", "HIGH", "UNINTERPRETED"] }, referenceRange: { oneOf: [schemaReference("LaboratoryReferenceRange"), { type: "null" }] }
}, ["analyteCode", "value", "unitCode", "flag", "referenceRange"]);
const structuredLaboratoryResultSchema = strictObject({
  kind: { type: "string", const: "LABORATORY_STRUCTURED" }, panelCode: stringSchema(1, 100), panelVersion: positiveVersion,
  observations: arrayOf(schemaReference("LaboratoryObservation"), { maxItems: 100 })
}, ["kind", "panelCode", "panelVersion", "observations"]);
const structuredLaboratoryResultCommandSchema = strictObject({
  kind: { type: "string", const: "LABORATORY_STRUCTURED" }, panelCode: stringSchema(1, 100), panelVersion: positiveVersion,
  observations: arrayOf(strictObject({ analyteCode: stringSchema(1, 100), value: { oneOf: [{ type: "number" }, stringSchema(1, 2000)] }, unitCode: stringSchema(1, 100) }, ["analyteCode", "value", "unitCode"]), { maxItems: 100 })
}, ["kind", "panelCode", "panelVersion", "observations"]);
const laboratoryPopulationSchema = {
  ...strictObject({ species: arrayOf(normalizedTextSchema(1, 100), { minItems: 1, maxItems: 20 }), sex: arrayOf(normalizedTextSchema(1, 80), { minItems: 1, maxItems: 20 }), minAgeDays: { type: "integer", minimum: 0, maximum: 365000 }, maxAgeDays: { type: "integer", minimum: 0, maximum: 365000 } }, ["species"]),
  "x-cross-field-constraints": ["minAgeDays must not exceed maxAgeDays"]
};
const examTemplateRangeInputSchema = {
  ...strictObject({ kind: { type: "string", enum: ["NUMERIC", "PENDING_POLICY"] }, unitCode: normalizedTextSchema(1, 80), low: { type: "number" }, high: { type: "number" }, source: { type: "string", enum: ["HUMAN_APPROVED", "SYNTHETIC_FIXTURE", "PENDING_HUMAN_POLICY"] }, note: normalizedTextSchema(1, 500) }, ["kind", "unitCode", "source"]),
  "x-cross-field-constraints": ["NUMERIC requires at least one bound", "low must not exceed high", "prepare always stores source PENDING_HUMAN_POLICY; human approval is a separate command"]
};
const examTemplateAnalyteInputSchema = {
  ...strictObject({ code: { ...normalizedTextSchema(2, 60), pattern: "^[A-Za-z][A-Za-z0-9_]{1,59}$" }, label: normalizedTextSchema(1, 160), valueType: { type: "string", enum: ["NUMERIC", "QUALITATIVE", "TEXT"] }, unitCode: normalizedTextSchema(1, 80), required: { type: "boolean" }, displayOrder: { type: "integer", minimum: 0, maximum: 10000 }, referenceRange: schemaReference("ExamTemplateRangeInput"), allowedValues: arrayOf(normalizedTextSchema(1, 160), { maxItems: 100 }) }, ["code", "label", "valueType", "unitCode", "required", "displayOrder"]),
  "x-cross-field-constraints": ["referenceRange.unitCode must equal unitCode", "analyte codes must be distinct within the panel"]
};
const diagnosticServiceSchema = strictObject({
  id: identifier, code: stringSchema(2, 60), name: stringSchema(1, 120), category: { type: "string", enum: ["LABORATORY", "IMAGING"] },
  departmentCode: stringSchema(1, 60), workflowType: workflowSchema, requiresSample: { type: "boolean" }, sampleType: stringSchema(1, 60), requiresSchedule: { type: "boolean" },
  allowsAttachment: { type: "boolean" }, active: { type: "boolean" }, resultSchema: { type: "string", enum: ["NUMERIC_PANEL", "NARRATIVE"] },
  resultTemplate: schemaReference("LaboratoryPanelTemplate"),
  slaHours: schemaReference("SlaHours"), version: positiveVersion
}, ["id", "code", "name", "category", "departmentCode", "workflowType", "requiresSample", "requiresSchedule", "allowsAttachment", "active", "resultSchema", "slaHours", "version"]);
const examDefinitionSchema = strictObject(Object.fromEntries(Object.entries(diagnosticServiceSchema.properties).filter(([key]) => !["id", "version", "active"].includes(key))), diagnosticServiceSchema.required.filter((key) => !["id", "version", "active"].includes(key)));
const examDefinitionSnapshotSchema = strictObject({ schemaVersion: { type: "integer", const: 1 }, capturedAt: timestamp, provenance: { type: "string", enum: ["REQUEST_CAPTURE", "COMMAND_CAPTURE_LEGACY_REQUEST"] }, definitionId: identifier, serviceId: identifier, serviceVersion: positiveVersion, definition: schemaReference("ExamDefinition"), patientContext: strictObject({ species: stringSchema(1, 100), sex: stringSchema(1, 80), birthDate: { type: "string", format: "date" } }, ["species"]) }, ["schemaVersion", "capturedAt", "provenance", "definitionId", "serviceId", "serviceVersion", "definition", "patientContext"]);
const examDefinitionVersionSchema = strictObject({ id: identifier, serviceId: identifier, serviceVersion: positiveVersion, status: { type: "string", enum: ["DRAFT", "ACTIVE", "RETIRED"] }, recordedAt: timestamp, recordedBy: identifier, provenance: { type: "string", enum: ["CATALOG_WRITE", "CATALOG_OBSERVATION"] }, definition: schemaReference("ExamDefinition") }, ["id", "serviceId", "serviceVersion", "status", "recordedAt", "recordedBy", "provenance", "definition"]);
const reasonCodeSchema = strictObject({
  id: identifier, type: { type: "string", enum: ["RECOLLECTION", "CANCEL", "REJECT", "AMEND"] }, code: stringSchema(2, 60),
  label: stringSchema(1, 160), active: { type: "boolean" }, version: positiveVersion
}, ["id", "type", "code", "label", "active", "version"]);
const diagnosticRequestSchema = strictObject({
  id: identifier, requestCode: stringSchema(1, 100), patientId: identifier, encounterId: identifier, admissionId: identifier,
  requesterId: identifier, requestingDepartmentCode: stringSchema(1, 60), priority: prioritySchema, aggregateStatus: aggregateStatusSchema,
  itemIds: arrayOf(identifier), createdAt: timestamp, updatedAt: timestamp, version: positiveVersion
}, ["id", "requestCode", "patientId", "encounterId", "requesterId", "requestingDepartmentCode", "priority", "aggregateStatus", "itemIds", "createdAt", "updatedAt", "version"]);
const diagnosticItemSchema = strictObject({
  id: identifier, requestId: identifier, serviceId: identifier, departmentCode: stringSchema(1, 60), workflowType: workflowSchema,
  priority: prioritySchema, status: { type: "string", enum: itemStates }, note: { type: "string", maxLength: 2000 }, requestedAt: timestamp, receivedAt: timestamp,
  startedAt: timestamp, performedAt: timestamp, releasedAt: timestamp, reviewedAt: timestamp, completedAt: timestamp,
  slaStartedAt: timestamp, dueAt: timestamp, slaPolicyVersion: positiveVersion, version: positiveVersion,
  cancellationReason: stringSchema(1, 500), rejectionReason: stringSchema(1, 2000), currentResultId: identifier,
  assignedUserId: identifier, assignedAt: timestamp, assignedBy: identifier, plannedStartsAt: timestamp, plannedEndsAt: timestamp, shiftId: identifier,
  currentSampleId: identifier, procedureId: identifier, definitionSnapshot: schemaReference("ExamDefinitionSnapshot")
}, ["id", "requestId", "serviceId", "departmentCode", "workflowType", "priority", "status", "requestedAt", "slaStartedAt", "dueAt", "slaPolicyVersion", "version"]);
const requestItemSchema = strictObject({ ...diagnosticItemSchema.properties, service: schemaReference("DiagnosticService") }, [
  ...diagnosticItemSchema.required, "service"
]);
requestItemSchema.properties.procedureVersion = positiveVersion;
const requestViewSchema = strictObject({
  ...diagnosticRequestSchema.properties, patient: schemaReference("Patient"), encounter: schemaReference("Encounter"), items: arrayOf(schemaReference("RequestItem")),
  samples: arrayOf(schemaReference("Sample"), { maxItems: 20 })
}, [...diagnosticRequestSchema.required, "patient", "encounter", "items", "samples"]);
const patientWorkspaceSampleSummarySchema = strictObject({
  id: identifier, requestId: identifier, accessionCode: accessionCodeSchema, sampleType: stringSchema(1, 100),
  status: { type: "string", enum: ["EXPECTED", "RECEIVED", "REJECTED", "REPLACED"] }, collectedAt: timestamp, receivedAt: timestamp
}, ["id", "requestId", "accessionCode", "sampleType", "status"]);
const patientWorkspaceResultSummarySchema = strictObject({
  id: identifier, versionId: identifier, status: { type: "string", const: "RELEASED" }, releasedAt: timestamp, needsReReview: { type: "boolean" }
}, ["id", "versionId", "status", "needsReReview"]);
const patientWorkspaceAttachmentSummarySchema = strictObject({
  id: identifier, resultVersionId: identifier, safeName: stringSchema(1, 120), detectedMime: stringSchema(1, 100),
  sizeBytes: { type: "integer", minimum: 1, maximum: 26214400 }, scanStatus: { type: "string", const: "CLEAN" },
  uploadStatus: { type: "string", const: "FINALIZED" }, createdAt: timestamp
}, ["id", "resultVersionId", "safeName", "detectedMime", "sizeBytes", "scanStatus", "uploadStatus", "createdAt"]);
const patientWorkspaceItemContextSchema = strictObject({
  operationalContext: schemaReference("OperationalContext"),
  sample: { oneOf: [schemaReference("PatientWorkspaceSampleSummary"), { type: "null" }] },
  result: { oneOf: [schemaReference("PatientWorkspaceResultSummary"), { type: "null" }] },
  attachments: arrayOf(schemaReference("PatientWorkspaceAttachmentSummary"), { maxItems: 100 })
}, ["operationalContext", "sample", "result", "attachments"]);
const patientWorkspaceRequestItemSchema = strictObject({
  ...requestItemSchema.properties, workspaceContext: schemaReference("PatientWorkspaceItemContext")
}, [...requestItemSchema.required, "workspaceContext"]);
const patientWorkspaceRequestViewSchema = strictObject({
  ...diagnosticRequestSchema.properties, patient: schemaReference("Patient"), encounter: schemaReference("Encounter"),
  items: arrayOf(schemaReference("PatientWorkspaceRequestItem"))
}, [...diagnosticRequestSchema.required, "patient", "encounter", "items"]);
const sampleLabelSchema = strictObject({
  sample: strictObject({ id: identifier, accessionCode: accessionCodeSchema, sampleType: stringSchema(1, 100), status: { type: "string", enum: ["EXPECTED", "RECEIVED", "REJECTED", "REPLACED"] }, version: expectedVersion }, ["id", "accessionCode", "sampleType", "status", "version"]),
  request: strictObject({ id: identifier, requestCode: stringSchema(1, 40), priority: { type: "string", enum: ["ROUTINE", "URGENT", "EMERGENCY"] } }, ["id", "requestCode", "priority"]),
  patient: strictObject({ id: identifier, displayName: stringSchema(1, 120), species: stringSchema(1, 60), externalId: stringSchema(1, 80) }, ["id", "displayName", "species", "externalId"]),
  services: arrayOf(strictObject({ code: stringSchema(1, 60), name: stringSchema(1, 120) }, ["code", "name"]), { maxItems: 20 }),
  encounter: strictObject({ externalId: stringSchema(1, 80) }, ["externalId"]),
  requestedAt: timestamp,
  label: strictObject({
    widthMm: { type: "number", minimum: 20, maximum: 150 }, heightMm: { type: "number", minimum: 20, maximum: 150 },
    barcode: strictObject({ symbology: { type: "string", const: "code128" }, modules: { type: "integer", minimum: 1, maximum: 2000 }, bars: arrayOf(strictObject({ x: { type: "integer", minimum: 0 }, width: { type: "integer", minimum: 1, maximum: 4 } }, ["x", "width"]), { maxItems: 400 }) }, ["symbology", "modules", "bars"])
  }, ["widthMm", "heightMm", "barcode"])
}, ["sample", "request", "patient", "services", "encounter", "requestedAt", "label"]);
const itemViewSchema = strictObject({
  item: schemaReference("DiagnosticItem"), request: schemaReference("RequestView"), patient: schemaReference("Patient"), service: schemaReference("DiagnosticService")
}, ["item", "request", "patient", "service"]);
const sampleSchema = strictObject({
  id: identifier, requestId: identifier, accessionCode: accessionCodeSchema, sampleType: stringSchema(1, 100),
  status: { type: "string", enum: ["EXPECTED", "RECEIVED", "REJECTED", "REPLACED"] }, replacesSampleId: identifier,
  rejectionCode: stringSchema(1, 60), rejectionNote: stringSchema(1, 2000), itemIds: arrayOf(identifier),
  collectedAt: timestamp, receivedAt: timestamp, receivedBy: identifier, version: positiveVersion
}, ["id", "requestId", "accessionCode", "sampleType", "status", "itemIds", "version"]);
const procedureSchema = strictObject({
  id: identifier, itemId: identifier, workflowType: { type: "string", enum: ["RADIOLOGY", "ULTRASOUND"] },
  status: { type: "string", enum: ["EXPECTED", "SCHEDULED", "IN_PROGRESS", "PERFORMED", "AWAITING_REPORT"] },
  scheduleIds: arrayOf(identifier), performedAt: timestamp, performedBy: identifier, version: positiveVersion
}, ["id", "itemId", "workflowType", "status", "scheduleIds", "version"]);
const procedureScheduleSchema = { ...hospitalPlanningResponseSchemas.HospitalSchedule, required: [...hospitalPlanningResponseSchemas.HospitalSchedule.required, "procedureId"] };
const resultSchema = strictObject({
  id: identifier, itemId: identifier, currentVersionId: identifier, lifecycleStatus: { type: "string", enum: ["DRAFT", "RELEASED", "VOIDED"] },
  needsReReview: { type: "boolean" }, version: positiveVersion
}, ["id", "itemId", "lifecycleStatus", "needsReReview", "version"]);
const resultVersionSchema = strictObject({
  definitionSnapshot: schemaReference("ExamDefinitionSnapshot"),
  id: identifier, resultId: identifier, sequence: positiveVersion, status: resultVersionStateSchema, content: { anyOf: [schemaReference("StructuredLaboratoryResultContent"), schemaReference("JsonObject")] },
  narrative: boundedString, conclusion: { type: "string", maxLength: 5000 }, authorId: identifier, createdAt: timestamp, releasedAt: timestamp,
  releasedBy: identifier, amendmentReason: stringSchema(1, 500), supersedesId: identifier, critical: { type: "boolean" },
  needsReReview: { type: "boolean" }, version: positiveVersion
}, ["id", "resultId", "sequence", "status", "content", "narrative", "authorId", "createdAt", "critical", "needsReReview", "version"]);
const clinicalArchiveEntrySchema = strictObject({ updatedAt: timestamp,
  requestId: identifier, requestCode: stringSchema(1, 100), patientId: identifier, encounterId: identifier,
  requestingDepartmentCode: stringSchema(1, 60), archivedAt: timestamp, completedAt: timestamp,
  services: arrayOf(strictObject({ code: stringSchema(1, 100), name: stringSchema(1, 120), departmentCode: stringSchema(1, 60), attachmentCount: nonNegativeInteger }, ["code", "name", "departmentCode", "attachmentCount"]), { maxItems: 100 }),
  attachmentCount: nonNegativeInteger
}, ["requestId", "requestCode", "patientId", "encounterId", "requestingDepartmentCode", "archivedAt", "completedAt", "services", "attachmentCount"]);
const archivedResultVersionSchema = strictObject({
  definitionSnapshot: schemaReference("ExamDefinitionSnapshot"),
  id: identifier, sequence: positiveVersion, status: { type: "string", enum: ["RELEASED", "SUPERSEDED", "VOIDED"] },
  content: { anyOf: [schemaReference("StructuredLaboratoryResultContent"), schemaReference("JsonObject")] }, narrative: boundedString,
  conclusion: { type: "string", maxLength: 5000 }, releasedAt: timestamp, critical: { type: "boolean" }, amendmentReason: stringSchema(1, 500)
}, ["id", "sequence", "status", "content", "narrative", "critical"]);
// PROD-502 (D-048): the data subject's export; no staff identity, no draft, no audit trail, no storage key.
const patientDataExportSchema = strictObject({
  format: { type: "string", const: "cvg-hub.patient-data-export.v1" }, exportedAt: timestamp,
  patient: strictObject({
    externalId: stringSchema(1, 100), displayName: stringSchema(1, 200), species: stringSchema(1, 100), breed: stringSchema(0, 100), sex: stringSchema(0, 40),
    birthDate: stringSchema(1, 40), ownerLabel: stringSchema(0, 200), active: { type: "boolean" }
  }, ["externalId", "displayName", "species", "breed", "sex", "ownerLabel", "active"]),
  encounters: arrayOf(strictObject({ externalId: stringSchema(1, 100), type: stringSchema(1, 40), status: stringSchema(1, 40), openedAt: timestamp, closedAt: timestamp }, ["externalId", "type", "status", "openedAt"])),
  admissions: arrayOf(strictObject({ encounterExternalId: stringSchema(1, 100), departmentCode: stringSchema(1, 60), ward: stringSchema(0, 120), bed: stringSchema(0, 120), admittedAt: timestamp, dischargedAt: timestamp }, ["departmentCode", "ward", "bed", "admittedAt"])),
  requests: arrayOf(strictObject({
    requestCode: stringSchema(1, 100), encounterExternalId: stringSchema(1, 100), requestingDepartmentCode: stringSchema(1, 60), priority: prioritySchema,
    status: aggregateStatusSchema, createdAt: timestamp, updatedAt: timestamp, archived: { type: "boolean" },
    items: arrayOf(strictObject({
      service: strictObject({ code: stringSchema(1, 100), name: stringSchema(1, 120) }, ["code", "name"]), departmentCode: stringSchema(1, 60),
      status: { type: "string", enum: itemStates }, priority: prioritySchema, requestedAt: timestamp, completedAt: timestamp,
      cancellationReason: stringSchema(1, 500), rejectionReason: stringSchema(1, 2000),
      samples: arrayOf(strictObject({ accessionCode: stringSchema(1, 40), sampleType: stringSchema(1, 100), status: { type: "string", enum: ["EXPECTED", "RECEIVED", "REJECTED", "REPLACED"] }, collectedAt: timestamp, receivedAt: timestamp }, ["accessionCode", "sampleType", "status"])),
      results: arrayOf(strictObject({
        status: { type: "string", enum: ["DRAFT", "RELEASED", "VOIDED"] },
        versions: arrayOf(strictObject({
          sequence: positiveVersion, status: { type: "string", enum: ["RELEASED", "SUPERSEDED", "VOIDED"] }, releasedAt: timestamp, narrative: boundedString,
          conclusion: { type: "string", maxLength: 5000 }, content: { anyOf: [schemaReference("StructuredLaboratoryResultContent"), schemaReference("JsonObject")] },
          critical: { type: "boolean" }, amendmentReason: stringSchema(1, 500)
        }, ["sequence", "status", "narrative", "content", "critical"]))
      }, ["status", "versions"])),
      attachments: arrayOf(strictObject({ safeName: stringSchema(1, 120), detectedMime: stringSchema(1, 100), sizeBytes: { type: "integer", minimum: 1 }, createdAt: timestamp }, ["safeName", "detectedMime", "sizeBytes", "createdAt"]))
    }, ["service", "departmentCode", "status", "priority", "requestedAt", "samples", "results", "attachments"]))
  }, ["requestCode", "requestingDepartmentCode", "priority", "status", "createdAt", "updatedAt", "archived", "items"])),
  omitted: arrayOf(stringSchema(1, 300))
}, ["format", "exportedAt", "patient", "encounters", "admissions", "requests", "omitted"]);
const archivedRequestViewSchema = strictObject({
  readOnly: { type: "boolean", const: true }, archivedAt: timestamp,
  request: strictObject({
    id: identifier, requestCode: stringSchema(1, 100), patientId: identifier, encounterId: identifier, requestingDepartmentCode: stringSchema(1, 60),
    priority: prioritySchema, aggregateStatus: aggregateStatusSchema, createdAt: timestamp, updatedAt: timestamp
  }, ["id", "requestCode", "patientId", "encounterId", "requestingDepartmentCode", "priority", "aggregateStatus", "createdAt", "updatedAt"]),
  patient: { oneOf: [strictObject({ id: identifier, displayName: stringSchema(1, 200), species: stringSchema(1, 100), externalId: stringSchema(1, 100) }, ["id", "displayName", "species", "externalId"]), { type: "null" }] },
  items: arrayOf(strictObject({
    id: identifier, service: strictObject({ code: stringSchema(1, 100), name: stringSchema(1, 120) }, ["code", "name"]), departmentCode: stringSchema(1, 60),
    status: { type: "string", enum: itemStates }, priority: prioritySchema, requestedAt: timestamp, completedAt: timestamp,
    cancellationReason: stringSchema(1, 500), rejectionReason: stringSchema(1, 2000), note: { type: "string", maxLength: 2000 },
    results: arrayOf(strictObject({ id: identifier, lifecycleStatus: { type: "string", enum: ["DRAFT", "RELEASED", "VOIDED"] }, versions: arrayOf(schemaReference("ArchivedResultVersion")) }, ["id", "lifecycleStatus", "versions"]))
  }, ["id", "service", "departmentCode", "status", "priority", "requestedAt", "results"])),
  samples: arrayOf(strictObject({
    id: identifier, accessionCode: accessionCodeSchema, sampleType: stringSchema(1, 100),
    status: { type: "string", enum: ["EXPECTED", "RECEIVED", "REJECTED", "REPLACED"] }, collectedAt: timestamp, receivedAt: timestamp
  }, ["id", "accessionCode", "sampleType", "status"])),
  attachments: arrayOf(strictObject({ id: identifier, resultVersionId: identifier, safeName: stringSchema(1, 120), detectedMime: stringSchema(1, 100), sizeBytes: { type: "integer", minimum: 1 } }, ["id", "resultVersionId", "safeName", "detectedMime", "sizeBytes"]))
}, ["readOnly", "archivedAt", "request", "patient", "items", "samples", "attachments"]);
const resultViewSchema = strictObject({
  currentVersionId: identifier, definitionProvenance: { type: "string", enum: ["REQUEST_CAPTURE", "COMMAND_CAPTURE_LEGACY_REQUEST", "UNKNOWN_LEGACY"] },
  permissions: arrayOf(permissionSchema, { uniqueItems: true }), result: schemaReference("Result"), version: schemaReference("ResultVersion"), item: schemaReference("DiagnosticItem"),
  request: schemaReference("RequestView"), patient: schemaReference("Patient"), service: schemaReference("DiagnosticService")
}, ["result", "version", "item", "request", "patient", "service"]);
const publicAttachmentSchema = strictObject({
  id: identifier, resultVersionId: identifier, safeName: stringSchema(1, 120), detectedMime: stringSchema(1, 100), sizeBytes: { type: "integer", minimum: 1, maximum: 26214400 },
  checksum: { type: "string", pattern: "^[a-fA-F0-9]{64}$" }, scanStatus: { type: "string", enum: ["PENDING", "CLEAN", "QUARANTINED", "FAILED"] },
  uploadStatus: { type: "string", enum: ["INITIATED", "UPLOADED", "FINALIZED"] }, expiresAt: timestamp, createdBy: identifier, createdAt: timestamp
}, ["id", "resultVersionId", "safeName", "detectedMime", "sizeBytes", "checksum", "scanStatus", "uploadStatus", "createdBy", "createdAt"]);
const notificationSchema = strictObject({
  id: identifier, category: { type: "string", enum: ["INFORMATIONAL", "ACTIONABLE", "CRITICAL", "ADMINISTRATIVE"] },
  priority: { type: "string", enum: ["NORMAL", "HIGH", "URGENT"] }, recipientUserId: identifier,
  entityType: { type: "string", enum: ["REQUEST", "ITEM", "RESULT_VERSION", "SAMPLE"] }, entityId: identifier,
  deepLink: stringSchema(1, 500), title: stringSchema(1, 500), body: stringSchema(1, 2000), dedupeKey: stringSchema(1, 500),
  state: { type: "string", enum: ["PENDING", "DELIVERED", "SEEN", "ACKNOWLEDGED", "FAILED", "SUPERSEDED", "ESCALATED"] },
  createdAt: timestamp, acknowledgedAt: timestamp, acknowledgedBy: identifier, attempts: nonNegativeInteger, version: positiveVersion,
  whatsapp: strictObject({
    status: { type: "string", enum: ["QUEUED", "SENT", "DELIVERED", "READ", "FAILED", "SKIPPED"] }, updatedAt: timestamp,
    messageId: stringSchema(1, 200), errorCode: stringSchema(1, 100)
  }, ["status", "updatedAt"]),
  escalation: strictObject({ level: { type: "integer", minimum: 1, maximum: 8 }, lastEscalatedAt: timestamp, unreachableAt: timestamp }, ["level", "lastEscalatedAt"]),
  escalationOf: identifier
}, ["id", "category", "priority", "recipientUserId", "entityType", "entityId", "deepLink", "title", "body", "dedupeKey", "state", "createdAt", "attempts", "version"]);
const auditEventSchema = strictObject({
  id: identifier, eventType: stringSchema(1, 200), actorId: identifier, entityType: stringSchema(1, 200), entityId: identifier,
  previousState: boundedString, newState: boundedString, correlationId: stringSchema(1, 100),
  metadata: { type: "object", additionalProperties: { type: ["string", "number", "boolean", "null"] } }, occurredAt: timestamp
}, ["id", "eventType", "entityType", "entityId", "correlationId", "metadata", "occurredAt"]);
const metaSchema = strictObject({
  requestId: { type: "string", pattern: "^req_" }, correlationId: stringSchema(1, 100), nextCursor: { type: "string" },
  limit: { type: "integer", minimum: 1, maximum: 100 }, total: { type: "integer", minimum: 0 }
}, ["requestId", "correlationId"]);

const hospitalServiceSchema = strictObject({ id: identifier, code: stringSchema(1, 60), name: stringSchema(1, 160), description: stringSchema(1, 1000), kind: schemaReference("HospitalServiceKind"), departmentCode: stringSchema(1, 60), teamUserIds: arrayOf(identifier, { maxItems: 500 }), resourceIds: arrayOf(identifier, { maxItems: 500 }), active: { type: "boolean" }, version: positiveVersion, createdAt: timestamp, updatedAt: timestamp }, ["id", "code", "name", "kind", "departmentCode", "teamUserIds", "resourceIds", "active", "version", "createdAt", "updatedAt"]);
const plannerViewFiltersSchema = { ...strictObject({ departmentCode: stringSchema(1, 60), responsibleUserId: identifier, typeId: identifier, priority: prioritySchema, phase: { type: "string", enum: ["PENDING", "IN_PROGRESS", "COMPLETED", "CANCELLED"] }, from: strictDateTime, to: strictDateTime, planId: identifier }), "x-cross-field-constraints": ["from must not exceed to; planId requires the work-plan capability"] };
const plannerViewDisplaySchema = { ...strictObject({ layout: { type: "string", enum: ["LIST", "BOARD", "TABLE", "CALENDAR"] }, orderBy: { type: "string", enum: ["UPDATED", "PRIORITY", "PLANNED_START"] }, direction: { type: "string", enum: ["ASC", "DESC"] }, groupBy: { type: "string", enum: ["NONE", "DEPARTMENT", "RESPONSIBLE", "TYPE", "PHASE"] }, columns: arrayOf({ type: "string", enum: ["title", "department", "responsible", "type", "priority", "phase", "plannedStart", "plannedEnd", "updatedAt"] }, { minItems: 1, maxItems: 9, uniqueItems: true }) }, ["layout", "orderBy", "direction", "groupBy", "columns"]) };
const savedPlannerViewSchema = strictObject({ id: identifier, name: stringSchema(1, 120), ownerId: identifier, sharedDepartmentCode: stringSchema(1, 60), filters: schemaReference("PlannerViewFilters"), display: schemaReference("PlannerViewDisplay"), active: { type: "boolean" }, version: positiveVersion, createdAt: timestamp, updatedAt: timestamp }, ["id", "name", "ownerId", "filters", "display", "active", "version", "createdAt", "updatedAt"]);
const hospitalTaskTypeSchema = strictObject({ id: identifier, code: stringSchema(2, 40), name: stringSchema(1, 120), careContextRequired: { type: "boolean" }, states: taskStatesInputSchema, active: { type: "boolean" }, version: positiveVersion, createdAt: timestamp, updatedAt: timestamp }, ["id", "code", "name", "careContextRequired", "states", "active", "version", "createdAt", "updatedAt"]);
const hospitalTaskTypeSnapshotSchema = strictObject({ id: identifier, code: stringSchema(2, 40), name: stringSchema(1, 120), careContextRequired: { type: "boolean" }, states: taskStatesInputSchema, version: positiveVersion }, ["id", "code", "name", "careContextRequired", "states", "version"]);
const hospitalServiceSnapshotSchema = strictObject({ source: { type: "string", enum: ["HOSPITAL_SERVICE", "DIAGNOSTIC_SERVICE"] }, serviceId: identifier, serviceVersion: positiveVersion, code: stringSchema(1, 60), name: stringSchema(1, 160), kind: schemaReference("HospitalServiceCatalogKind"), departmentCode: stringSchema(1, 60), teamUserIds: arrayOf(identifier), resourceIds: arrayOf(identifier), capturedAt: timestamp }, ["source", "serviceId", "serviceVersion", "code", "name", "kind", "departmentCode", "teamUserIds", "resourceIds", "capturedAt"]);
const hospitalTaskSchema = strictObject({ id: identifier, taskCode: stringSchema(1, 100), title: stringSchema(1, 200), description: stringSchema(0, 4000), typeId: identifier, typeSnapshot: schemaReference("HospitalTaskTypeSnapshot"), status: stringSchema(2, 40), phase: schemaReference("HospitalTaskPhase"), departmentCode: stringSchema(1, 60), patientId: identifier, encounterId: identifier, authorId: identifier, responsibleUserId: identifier, executorTeamUserIds: taskCollaborators, participantUserIds: taskCollaborators, priority: prioritySchema, plannedStartAt: timestamp, plannedEndAt: timestamp, startedAt: timestamp, startedBy: identifier, completedAt: timestamp, completedBy: identifier, cancelledAt: timestamp, cancelledBy: identifier, completionNote: stringSchema(0, 4000), cancellationReason: stringSchema(1, 500), parentTaskId: identifier, sortOrder: { type: "integer", minimum: 0, maximum: 1000000 }, serviceSnapshot: schemaReference("HospitalServiceSnapshot"), version: positiveVersion, createdAt: timestamp, updatedAt: timestamp }, ["id", "taskCode", "title", "typeId", "typeSnapshot", "status", "phase", "departmentCode", "authorId", "executorTeamUserIds", "participantUserIds", "priority", "sortOrder", "version", "createdAt", "updatedAt"]);
Object.assign(hospitalTaskSchema.properties, { descriptionContent: schemaReference("HospitalDocumentContent"), estimatedMinutes: { type: "integer", minimum: 1, maximum: 525600 }, labels: { type: "array", maxItems: 30, uniqueItems: true, items: stringSchema(1, 50) }, externalReferences: { type: "array", maxItems: 10, items: strictObject({ label: stringSchema(1,120), url: stringSchema(1,2000) }, ["label", "url"]) }, reactions: arrayOf(schemaReference("HospitalTaskReaction")), archivedAt: timestamp, archivedBy: identifier, isDraft: { type: "boolean" }, draftCancelledAt: timestamp, draftCancelledBy: identifier, documentSnapshots: arrayOf(schemaReference("HospitalDocumentSnapshot")), shiftId: identifier, checklistSnapshot: schemaReference("HospitalChecklistSnapshot"), checklistExecutions: arrayOf(schemaReference("HospitalChecklistExecution")), recurrenceId: identifier, occurrenceAt: timestamp, careExecution: schemaReference("HospitalCareExecution") });
const hospitalTaskDependencySchema = strictObject({ id: identifier, taskId: identifier, targetType: { type: "string", enum: ["HOSPITAL_TASK", "DIAGNOSTIC_ITEM"] }, targetId: identifier, blocks: { type: "string", enum: ["START", "COMPLETE"] }, active: { type: "boolean" }, version: positiveVersion, createdAt: timestamp, updatedAt: timestamp }, ["id", "taskId", "targetType", "targetId", "blocks", "active", "version", "createdAt", "updatedAt"]);
const hospitalIntakeSchema = strictObject({ id: identifier, title: stringSchema(1, 200), description: stringSchema(0, 4000), typeId: identifier, departmentCode: stringSchema(1, 60), patientId: identifier, encounterId: identifier, priority: prioritySchema, source: { type: "string", enum: ["MANUAL", "DIAGNOSTIC_REQUEST"] }, sourceRequestId: identifier, sourceLabel: stringSchema(1, 120), state: schemaReference("HospitalIntakeState"), submittedBy: identifier, decisionBy: identifier, decisionAt: timestamp, reason: stringSchema(1, 500), reasonPolicy: schemaReference("HospitalIntakeReasonSnapshot"), destinationTaskId: identifier, destinationRequestId: identifier, duplicateOfIntakeId: identifier, version: positiveVersion, createdAt: timestamp, updatedAt: timestamp }, ["id", "title", "departmentCode", "priority", "source", "state", "submittedBy", "version", "createdAt", "updatedAt"]);
const plannerSearchResultSchema = strictObject({ type: { type: "string", enum: [...PLANNER_SEARCH_TYPES] }, id: identifier, label: stringSchema(1, 500), patient: stringSchema(1, 200), patientId: identifier, departmentCode: stringSchema(1, 60), status: stringSchema(1, 100), priority: prioritySchema, responsibleUserId: identifier, plannedStartAt: timestamp, updatedAt: timestamp, deepLink: stringSchema(1, 500) }, ["type", "id", "label", "updatedAt", "deepLink"]);
const plannerPageSchema = (item) => strictObject({ items: arrayOf(schemaReference(item)), total: nonNegativeInteger, limit: { type: "integer", minimum: 1, maximum: 100 }, nextCursor: stringSchema(1, 2000) }, ["items", "total", "limit"]);
const responseDataSchemas = {
  ...hospitalPlanningResponseSchemas,
  ...hospitalCollaborationResponseSchemas,
  ...hospitalWorkResponseSchemas,
  ...hospitalExternalResponseSchemas,
  HospitalTaskPhase: { type: "string", enum: ["PENDING", "IN_PROGRESS", "COMPLETED", "CANCELLED"] },
  HospitalIntakeState: { type: "string", enum: ["RECEIVED", "DEFERRED", "ACCEPTED", "REJECTED", "DUPLICATE"] },
  PlannerOrder: { type: "string", enum: ["UPDATED", "PRIORITY", "PLANNED_START"] }, PlannerDirection: { type: "string", enum: ["ASC", "DESC"] },
  PlannerSearchTypes: { type: "array", maxItems: PLANNER_SEARCH_TYPES.length, items: { type: "string", enum: [...PLANNER_SEARCH_TYPES] } },
  HospitalTaskType: hospitalTaskTypeSchema, HospitalTaskTypeList: arrayOf(schemaReference("HospitalTaskType")), HospitalTaskTypeSnapshot: hospitalTaskTypeSnapshotSchema,
  HospitalServiceSnapshot: hospitalServiceSnapshotSchema, HospitalTask: hospitalTaskSchema,
  HospitalTaskDependencyView: { oneOf: [strictObject({ ...hospitalTaskDependencySchema.properties, restricted: { type: "boolean", const: false }, label: stringSchema(1, 500), satisfied: { type: "boolean" }, responsibleUserId: identifier }, [...hospitalTaskDependencySchema.required, "label", "satisfied"]), strictObject({ id: identifier, restricted: { type: "boolean", const: true }, blocks: { type: "string", enum: ["START", "COMPLETE"] }, satisfied: { type: "boolean", const: false } }, ["id", "restricted", "blocks", "satisfied"])] },
  HospitalTaskView: strictObject({ task: schemaReference("HospitalTask"), permissions: arrayOf(permissionSchema), eligibleAssignees: schemaReference("DiagnosticAssigneeList"), dependencies: arrayOf(schemaReference("HospitalTaskDependencyView")), children: arrayOf(schemaReference("HospitalTask")), reservations: arrayOf(schemaReference("HospitalSchedule")), patient: strictObject({ id: identifier, displayName: stringSchema(1, 200), externalId: stringSchema(1, 100), species: stringSchema(1, 100), ownerLabel: stringSchema(1, 200) }, ["id", "displayName", "externalId", "species", "ownerLabel"]), encounter: strictObject({ id: identifier, externalId: stringSchema(1, 100), status: { type: "string", enum: ["OPEN", "CLOSED"] }, type: { type: "string", enum: ["INPATIENT", "EMERGENCY", "OUTPATIENT"] } }, ["id", "externalId", "status", "type"]) }, ["task", "permissions", "eligibleAssignees", "dependencies", "children"]),
  HospitalTaskPage: plannerPageSchema("HospitalTaskView"),
  HospitalTaskOptions: strictObject({ departments: arrayOf(strictObject({ code: stringSchema(1, 60), name: stringSchema(1, 120) }, ["code", "name"])), types: schemaReference("HospitalTaskTypeList"), assignees: schemaReference("DiagnosticAssigneeList") }, ["departments", "types", "assignees"]),
  HospitalIntakeView: strictObject({ ...hospitalIntakeSchema.properties, permissions: arrayOf(permissionSchema) }, [...hospitalIntakeSchema.required, "permissions"]),
  HospitalIntakeRejectionPolicy: strictObject({ version: stringSchema(1, 100), approvedAt: timestamp, approvalReference: stringSchema(1, 500), departmentCodes: arrayOf(stringSchema(1, 60), { minItems: 1, maxItems: 100, uniqueItems: true }), reasons: arrayOf(strictObject({ code: { type: "string", pattern: "^[A-Z][A-Z0-9_]{0,59}$" }, label: stringSchema(1, 500) }, ["code", "label"]), { minItems: 1, maxItems: 100 }), defaultReasonCode: { type: "string", pattern: "^[A-Z][A-Z0-9_]{0,59}$" } }, ["version", "approvedAt", "approvalReference", "departmentCodes", "reasons"]),
  HospitalIntakeReasonSnapshot: strictObject({ code: { type: "string", pattern: "^[A-Z][A-Z0-9_]{0,59}$" }, label: stringSchema(1, 500), policyVersion: stringSchema(1, 100), approvedAt: timestamp, approvalReference: stringSchema(1, 500) }, ["code", "label", "policyVersion", "approvedAt", "approvalReference"]),
  HospitalIntakeOptions: strictObject({ rejectionPolicyStatus: { type: "string", enum: ["OFF", "INVALID", "AVAILABLE"] }, rejectionPolicy: schemaReference("HospitalIntakeRejectionPolicy") }, ["rejectionPolicyStatus"]),
  HospitalIntakePage: plannerPageSchema("HospitalIntakeView"), PlannerSearchResult: plannerSearchResultSchema, PlannerSearchPage: plannerPageSchema("PlannerSearchResult"),
  HospitalService: hospitalServiceSchema,
  HospitalServiceKind: { type: "string", enum: ["CARE", "PROCEDURE", "OPERATIONAL"] },
  HospitalServiceCatalogKind: { type: "string", enum: ["CARE", "PROCEDURE", "OPERATIONAL", "DIAGNOSTIC"] },
  HospitalServiceCatalogEntry: { oneOf: [strictObject({ ...hospitalServiceSchema.properties, source: { type: "string", const: "HOSPITAL_SERVICE" } }, [...hospitalServiceSchema.required, "source"]), strictObject({ source: { type: "string", const: "DIAGNOSTIC_SERVICE" }, id: identifier, code: stringSchema(1, 60), name: stringSchema(1, 160), kind: { type: "string", const: "DIAGNOSTIC" }, departmentCode: stringSchema(1, 60), teamUserIds: arrayOf(identifier), resourceIds: arrayOf(identifier), active: { type: "boolean" }, version: positiveVersion }, ["source", "id", "code", "name", "kind", "departmentCode", "teamUserIds", "resourceIds", "active", "version"]) ] },
  HospitalServiceCatalogPage: strictObject({ items: arrayOf(schemaReference("HospitalServiceCatalogEntry")), total: nonNegativeInteger, nextCursor: stringSchema(1, 2000) }, ["items", "total"]),
  HospitalServiceImportReport: strictObject({ applied: { type: "boolean" }, dryRun: { type: "boolean" }, rows: arrayOf(strictObject({ line: positiveVersion, code: stringSchema(0, 60), action: { type: "string", enum: ["CREATE", "UPDATE", "UNCHANGED", "ERROR"] }, errors: arrayOf(stringSchema(1, 1000)) }, ["line", "code", "action"])), summary: strictObject({ create: nonNegativeInteger, update: nonNegativeInteger, unchanged: nonNegativeInteger, error: nonNegativeInteger }, ["create", "update", "unchanged", "error"]) }, ["applied", "dryRun", "rows", "summary"]),
  PlannerViewFilters: plannerViewFiltersSchema, PlannerViewDisplay: plannerViewDisplaySchema,
  SavedPlannerView: savedPlannerViewSchema, SavedPlannerViewList: arrayOf(schemaReference("SavedPlannerView")),
  DiagnosticAssigneeList: arrayOf(strictObject({ id: identifier, displayName: stringSchema(1, 160), role: { type: "string", enum: roleCodes }, departmentCode: stringSchema(1, 60) }, ["id", "displayName", "role", "departmentCode"])),
  PermissionList: arrayOf(permissionSchema, { uniqueItems: true }),
  LaboratoryPopulation: laboratoryPopulationSchema,
  LaboratoryTemplateApproval: strictObject({ approvedBy: identifier, approvedAt: timestamp, policyReference: stringSchema(1, 500), population: schemaReference("LaboratoryPopulation") }, ["approvedBy", "approvedAt", "policyReference", "population"]),
  ExamTemplateRangeInput: examTemplateRangeInputSchema,
  ExamTemplateAnalyteInput: examTemplateAnalyteInputSchema,
  ExamDefinition: examDefinitionSchema,
  ExamDefinitionSnapshot: examDefinitionSnapshotSchema,
  ExamDefinitionVersion: examDefinitionVersionSchema,
  ExamDefinitionVersionList: arrayOf(schemaReference("ExamDefinitionVersion")),
  AccessGroup: strictObject({ id: identifier, code: stringSchema(2, 60), description: stringSchema(1, 160), permissions: arrayOf(permissionSchema, { uniqueItems: true }), active: { type: "boolean" }, version: positiveVersion, createdAt: timestamp, updatedAt: timestamp, systemRole: { type: "string", enum: roleCodes } }, ["id", "code", "description", "permissions", "active", "version", "createdAt", "updatedAt"]),
  AccessGroupList: arrayOf(schemaReference("AccessGroup")),
  AccessGroupImpactPreview: strictObject({ groupId: identifier, groupVersion: positiveVersion, proposedActive: { type: "boolean" }, permissions: arrayOf(permissionSchema), impactToken: { type: "string", pattern: "^[a-f0-9]{64}$" }, boundUserCount: nonNegativeInteger, affectedUserCount: nonNegativeInteger, activeAffectedUserCount: nonNegativeInteger, requiresReauthentication: { type: "boolean" }, users: arrayOf(strictObject({ userId: identifier, displayName: stringSchema(1, 160), role: { type: "string", enum: roleCodes }, userVersion: positiveVersion, active: { type: "boolean" }, departmentCode: stringSchema(1, 60), managedDepartmentCodes: arrayOf(stringSchema(1, 60)), serviceCodes: arrayOf(stringSchema(1, 60)), patientCount: nonNegativeInteger, beforePermissions: arrayOf(permissionSchema), permissions: arrayOf(permissionSchema), addedPermissions: arrayOf(permissionSchema), removedPermissions: arrayOf(permissionSchema), effectiveAccessChanges: { type: "boolean" } }, ["userId", "displayName", "role", "userVersion", "active", "departmentCode", "managedDepartmentCodes", "serviceCodes", "patientCount", "beforePermissions", "permissions", "addedPermissions", "removedPermissions", "effectiveAccessChanges"])) }, ["groupId", "groupVersion", "proposedActive", "permissions", "impactToken", "boundUserCount", "affectedUserCount", "activeAffectedUserCount", "requiresReauthentication", "users"]),
  PatientGrant: strictObject({ id: identifier, userId: identifier, patientId: identifier, active: { type: "boolean" }, version: positiveVersion, createdAt: timestamp, updatedAt: timestamp, source: { type: "string", enum: ["LEGACY", "PATIENT_CREATION", "ADMIN"] }, grantedBy: identifier }, ["id", "userId", "patientId", "active", "version", "createdAt", "updatedAt", "source"]),
  PatientGrantList: arrayOf(schemaReference("PatientGrant")),
  EffectiveAccessPreview: strictObject({ userId: identifier, userVersion: positiveVersion, groupVersion: positiveVersion, role: { type: "string", enum: roleCodes }, accessGroupId: identifier, groupActive: { type: "boolean" }, origin: { type: "string", enum: ["GROUP", "LEGACY_PROFILE"] }, permissions: arrayOf(permissionSchema), deniedByProfile: arrayOf(permissionSchema), addedPermissions: arrayOf(permissionSchema), removedPermissions: arrayOf(permissionSchema), scopes: strictObject({ departmentCode: stringSchema(1, 60), managedDepartmentCodes: arrayOf(stringSchema(1, 60)), serviceCodes: arrayOf(stringSchema(1, 60)), patientCount: nonNegativeInteger, globalPatients: { type: "boolean" } }, ["departmentCode", "managedDepartmentCodes", "serviceCodes", "patientCount", "globalPatients"]), restrictions: arrayOf(stringSchema(1, 500)) }, ["userId", "userVersion", "role", "groupActive", "origin", "permissions", "deniedByProfile", "addedPermissions", "removedPermissions", "scopes", "restrictions"]),
  Department: strictObject({ id: identifier, code: normalizedDepartmentCodeSchema, name: stringSchema(1, 120), type: { type: "string", enum: ["CLINICAL", "DIAGNOSTIC", "ADMINISTRATIVE", "SUPPORT"] }, responsibleUserId: identifier, memberUserIds: arrayOf(identifier, { maxItems: 500, uniqueItems: true }), active: { type: "boolean" }, version: positiveVersion, createdAt: timestamp, updatedAt: timestamp }, ["id", "code", "name", "type", "memberUserIds", "active", "version", "createdAt", "updatedAt"]),
  DepartmentList: arrayOf(schemaReference("Department")),
  JsonValue: { oneOf: [{ type: "string" }, { type: "number" }, { type: "boolean" }, { type: "null" }, { type: "array", items: schemaReference("JsonValue") }, { type: "object", additionalProperties: schemaReference("JsonValue") }] },
  JsonObject: { type: "object", additionalProperties: schemaReference("JsonValue"), maxProperties: 100 },
  PublicUser: publicUserSchema,
  ManagedUser: managedUserSchema,
  CatalogImportReport: strictObject({
    applied: { type: "boolean" }, dryRun: { type: "boolean" },
    summary: strictObject({ create: nonNegativeInteger, update: nonNegativeInteger, unchanged: nonNegativeInteger, error: nonNegativeInteger }, ["create", "update", "unchanged", "error"]),
    rows: arrayOf(strictObject({
      line: { type: "integer", minimum: 1 }, code: stringSchema(0, 100), action: { type: "string", enum: ["CREATE", "UPDATE", "UNCHANGED", "ERROR"] },
      changes: arrayOf(stringSchema(1, 1000)), errors: arrayOf(stringSchema(1, 1000)),
      removedAnalytes: arrayOf(strictObject({ code: stringSchema(1, 60), label: stringSchema(1, 120), required: { type: "boolean" } }, ["code", "label", "required"]))
    }, ["line", "code", "action"]))
  }, ["applied", "dryRun", "summary", "rows"]),
  ManagedUserCreation: strictObject({ ...managedUserSchema.properties, initialPassword: stringSchema(12, 200) }, managedUserSchema.required),
  PasswordResetLinkIssued: strictObject({
    user: schemaReference("ManagedUser"), resetUrl: { type: "string", maxLength: 2048, description: "Shown once; absent on an idempotent replay." }, expiresAt: timestamp
  }, ["user", "expiresAt"]),
  PasswordResetCompleted: strictObject({ email: { type: "string", format: "email", maxLength: 320 } }, ["email"]),
  PasswordResetLinkIssued: strictObject({
    user: schemaReference("ManagedUser"), resetUrl: { type: "string", maxLength: 2048, description: "Shown once; absent on an idempotent replay." }, expiresAt: timestamp
  }, ["user", "expiresAt"]),
  PasswordResetCompleted: strictObject({ email: { type: "string", format: "email", maxLength: 320 } }, ["email"]),
  ManagedSession: strictObject({
    id: identifier, userId: identifier, userDisplayName: stringSchema(1, 160), userEmail: { type: "string", format: "email", maxLength: 320 },
    userRole: { type: "string", enum: roleCodes }, departmentCode: stringSchema(1, 60), createdAt: timestamp, expiresAt: timestamp,
    status: { type: "string", enum: ["ACTIVE", "EXPIRED", "REVOKED"] }, current: { type: "boolean" }, revokedAt: timestamp
  }, ["id", "userId", "userDisplayName", "userEmail", "userRole", "departmentCode", "createdAt", "expiresAt", "status", "current"]),
  DeadLetterMessage: strictObject({
    id: identifier, eventType: stringSchema(1, 200), aggregateType: stringSchema(1, 200), aggregateId: identifier,
    status: { type: "string", enum: ["PENDING", "FAILED", "DISCARDED"] }, attempts: nonNegativeInteger, availableAt: timestamp,
    correlationId: stringSchema(1, 100), lastError: stringSchema(1, 240), deadLetteredAt: timestamp, discardedAt: timestamp,
    discardedBy: identifier, discardReason: stringSchema(1, 500)
  }, ["id", "eventType", "aggregateType", "aggregateId", "status", "attempts", "availableAt", "correlationId"]),
  Patient: patientSchema,
  Encounter: encounterSchema,
  Admission: admissionSchema,
  AdmissionContextCommandResult: admissionContextCommandResultSchema,
  DiagnosticService: diagnosticServiceSchema,
  LaboratoryReferenceRange: laboratoryReferenceRangeSchema,
  LaboratoryAnalyteDefinition: laboratoryAnalyteDefinitionSchema,
  LaboratoryPanelTemplate: laboratoryPanelTemplateSchema,
  LaboratoryObservation: laboratoryObservationSchema,
  StructuredLaboratoryResultContent: structuredLaboratoryResultSchema,
  StructuredLaboratoryResultCommandContent: structuredLaboratoryResultCommandSchema,
  DiagnosticServiceResultTemplate: { oneOf: [schemaReference("LaboratoryPanelTemplate"), { type: "null" }] },
  ReasonCode: reasonCodeSchema,
  DiagnosticRequest: diagnosticRequestSchema,
  DiagnosticItem: diagnosticItemSchema,
  RequestItem: requestItemSchema,
  RequestView: requestViewSchema,
  PatientWorkspaceRequestItem: patientWorkspaceRequestItemSchema,
  PatientWorkspaceRequestView: patientWorkspaceRequestViewSchema,
  ItemView: itemViewSchema,
  Sample: sampleSchema,
  SampleLabel: sampleLabelSchema,
  PatientWorkspaceSampleSummary: patientWorkspaceSampleSummarySchema,
  Procedure: procedureSchema,
  ProcedureSchedule: procedureScheduleSchema,
  Result: resultSchema,
  ResultVersion: resultVersionSchema,
  ResultView: resultViewSchema,
  PatientWorkspaceResultSummary: patientWorkspaceResultSummarySchema,
  PublicAttachment: publicAttachmentSchema,
  PatientWorkspaceAttachmentSummary: patientWorkspaceAttachmentSummarySchema,
  PatientWorkspaceItemContext: patientWorkspaceItemContextSchema,
  Notification: notificationSchema,
  AuditEvent: auditEventSchema,
  LivenessData: strictObject({ status: { type: "string", const: "ok" }, service: { type: "string", const: "cvg-diagnostics-hub" } }, ["status", "service"]),
  ReadinessData: strictObject({ status: { type: "string", const: "ready" }, dataMode: { type: "string", enum: ["memory", "postgres"] }, storageMode: stringSchema(1, 100) }, ["status", "dataMode", "storageMode"]),
  LoginData: strictObject({ user: schemaReference("PublicUser"), expiresAt: timestamp }, ["user", "expiresAt"]),
  CurrentSessionData: strictObject({ user: schemaReference("PublicUser") }, ["user"]),
  LogoutData: strictObject({ loggedOut: { type: "boolean", const: true } }, ["loggedOut"]),
  WhatsAppWebhookReceipt: strictObject({ received: nonNegativeInteger, applied: nonNegativeInteger }, ["received", "applied"]),
  ReauthenticationData: strictObject({ user: schemaReference("PublicUser"), reauthenticatedAt: timestamp }, ["user", "reauthenticatedAt"]),
  ManagedUserList: arrayOf(schemaReference("ManagedUser")),
  ManagedSessionList: arrayOf(schemaReference("ManagedSession"), { maxItems: 100 }),
  DeadLetterList: arrayOf(schemaReference("DeadLetterMessage"), { maxItems: 100 }),
  CriticalReadiness: strictObject({
    asOf: timestamp,
    policy: strictObject({ status: { type: "string", enum: ["ACTIVE", "OFF", "INVALID"] }, version: stringSchema(1, 100), approvalRef: stringSchema(1, 200) }, ["status"]),
    redundantChannel: strictObject({ status: { type: "string", enum: ["WHATSAPP", "IN_APP_ONLY_ACCEPTED", "MISSING"] }, approvalRef: stringSchema(1, 200) }, ["status"]),
    onCall: strictObject({
      departments: arrayOf(strictObject({ departmentCode: stringSchema(1, 60), requesters: nonNegativeInteger, onCall: nonNegativeInteger }, ["departmentCode", "requesters", "onCall"]), { maxItems: 100 }),
      departmentsWithoutOnCall: arrayOf(stringSchema(1, 60), { maxItems: 100 }),
      total: nonNegativeInteger
    }, ["departments", "departmentsWithoutOnCall", "total"]),
    administrators: nonNegativeInteger,
    ready: { type: "boolean" }
  }, ["asOf", "policy", "redundantChannel", "onCall", "administrators", "ready"]),
  DeadLetterMutation: strictObject({ message: schemaReference("DeadLetterMessage"), action: { type: "string", enum: ["REPROCESSED", "DISCARDED"] } }, ["message", "action"]),
  DiagnosticServiceList: arrayOf(schemaReference("DiagnosticService")),
  ReasonCodeList: arrayOf(schemaReference("ReasonCode")),
  PatientList: arrayOf(schemaReference("Patient"), { maxItems: 100 }),
  EncounterOpenResult: strictObject({ encounter: schemaReference("Encounter"), admission: schemaReference("Admission") }, ["encounter"]),
  EncounterCloseResult: strictObject({ encounter: schemaReference("Encounter"), admission: schemaReference("Admission"), pendingItems: nonNegativeInteger }, ["encounter", "pendingItems"]),
  PatientCreateResult: strictObject({ patient: schemaReference("Patient"), encounter: schemaReference("Encounter"), admission: schemaReference("Admission") }, ["patient", "encounter"]),
  PatientWorkspaceSummary: strictObject({
    asOf: timestamp,
    dataQuality: strictObject({ status: { type: "string", enum: ["FRESH", "DEGRADED"] }, asOf: timestamp, note: stringSchema(1, 500) }, ["status", "asOf"]),
    currentContext: strictObject({
      hasOpenEncounter: { type: "boolean" }, encounterId: { oneOf: [identifier, { type: "null" }] }, admissionId: { oneOf: [identifier, { type: "null" }] },
      departmentCode: { oneOf: [normalizedDepartmentCodeSchema, { type: "null" }] }, ward: { oneOf: [stringSchema(1, 100), { type: "null" }] },
      bed: { oneOf: [stringSchema(1, 100), { type: "null" }] }, responsibleLabel: { oneOf: [stringSchema(1, 160), { type: "null" }] }
    }, ["hasOpenEncounter", "encounterId", "admissionId", "departmentCode", "ward", "bed", "responsibleLabel"]),
    summary: strictObject({
      requestCount: nonNegativeInteger, itemCount: nonNegativeInteger, activeItemCount: nonNegativeInteger,
      availableResultCount: nonNegativeInteger, sampleCount: nonNegativeInteger, attachmentCount: nonNegativeInteger
    }, ["requestCount", "itemCount", "activeItemCount", "availableResultCount", "sampleCount", "attachmentCount"])
  }, ["asOf", "currentContext", "summary"]),
  PatientDiagnostics: strictObject({ patient: schemaReference("Patient"), encounters: arrayOf(schemaReference("Encounter")), admissions: arrayOf(schemaReference("Admission")), items: arrayOf(schemaReference("PatientWorkspaceRequestView")), events: arrayOf(schemaReference("AuditEvent")), timelineNextCursor: schemaReference("Cursor"), timelineTotal: nonNegativeInteger, nextActions: arrayOf(schemaReference("PatientNextAction")), workspace: schemaReference("PatientWorkspaceSummary"), nextCursor: schemaReference("Cursor"), limit: schemaReference("Limit"), total: nonNegativeInteger }, ["patient", "encounters", "admissions", "items", "events", "nextActions", "workspace", "limit", "total"]),
  PatientNextAction: strictObject({ id: identifier, requestId: identifier, requestCode: identifier, itemId: identifier, label: nonBlankStringSchema(1, 240), deepLink: nonBlankStringSchema(1, 240), status: { type: "string", enum: itemStates }, priority: { type: "string", enum: ["ROUTINE", "URGENT", "EMERGENCY"] }, dueAt: strictDateTime, departmentCode: normalizedDepartmentCodeSchema }, ["id", "requestId", "requestCode", "itemId", "label", "deepLink", "status", "priority", "dueAt", "departmentCode"]),
  ClinicalArchiveEntry: clinicalArchiveEntrySchema,
  ClinicalArchiveEntryList: arrayOf(schemaReference("ClinicalArchiveEntry")),
  ArchivedResultVersion: archivedResultVersionSchema,
  ArchivedRequestView: archivedRequestViewSchema,
  PatientDataExport: patientDataExportSchema,
  EncounterList: arrayOf(schemaReference("Encounter")),
  RequestViewList: arrayOf(schemaReference("RequestView")),
  ItemCommandResult: strictObject({ item: schemaReference("DiagnosticItem"), request: schemaReference("RequestView") }, ["item", "request"]),
  SampleCommandResult: strictObject({ sample: schemaReference("Sample"), items: arrayOf(schemaReference("DiagnosticItem")), request: schemaReference("RequestView") }, ["sample", "items", "request"]),
  RecollectionCommandResult: strictObject({ sample: schemaReference("Sample"), replacement: schemaReference("Sample"), items: arrayOf(schemaReference("DiagnosticItem")), request: schemaReference("RequestView") }, ["sample", "replacement", "items", "request"]),
  ProcedureScheduleCommandResult: strictObject({ item: schemaReference("DiagnosticItem"), procedure: schemaReference("Procedure"), schedule: schemaReference("ProcedureSchedule"), request: schemaReference("RequestView") }, ["item", "procedure", "schedule", "request"]),
  ProcedureExecutionCommandResult: strictObject({ item: schemaReference("DiagnosticItem"), procedure: schemaReference("Procedure"), request: schemaReference("RequestView") }, ["item", "procedure", "request"]),
  ProcedureRescheduleCommandResult: strictObject({ procedure: schemaReference("Procedure"), schedule: schemaReference("ProcedureSchedule"), history: arrayOf(schemaReference("ProcedureSchedule")), item: schemaReference("DiagnosticItem"), request: schemaReference("DiagnosticRequest") }, ["procedure", "schedule", "history", "item", "request"]),
  ResultCommandResult: strictObject({ result: schemaReference("Result"), version: schemaReference("ResultVersion"), item: schemaReference("DiagnosticItem"), request: schemaReference("RequestView") }, ["result", "version", "item", "request"]),
  AmendCommandResult: strictObject({ result: schemaReference("Result"), version: schemaReference("ResultVersion"), previousVersion: schemaReference("ResultVersion"), item: schemaReference("DiagnosticItem"), request: schemaReference("RequestView") }, ["result", "version", "previousVersion", "item", "request"]),
  VoidCommandResult: strictObject({ result: schemaReference("Result"), version: schemaReference("ResultVersion"), item: schemaReference("DiagnosticItem"), request: schemaReference("RequestView"), replacementRequired: { type: "boolean", const: true } }, ["result", "version", "item", "request", "replacementRequired"]),
  AttachmentSessionResult: strictObject({ attachment: schemaReference("PublicAttachment"), uploadUrl: { type: "string", pattern: "^/api/v1/attachments/" }, expiresAt: timestamp }, ["attachment", "uploadUrl", "expiresAt"]),
  AttachmentFinalizationResult: strictObject({ attachment: schemaReference("PublicAttachment") }, ["attachment"]),
  ResultVersionList: arrayOf(schemaReference("ResultVersion")),
  ResultViewedData: strictObject({ versionId: identifier, resultId: identifier, viewedAt: timestamp }, ["versionId", "resultId", "viewedAt"]),
  ReportView: strictObject({ ...resultViewSchema.properties, attachments: arrayOf(schemaReference("PublicAttachment")) }, [...resultViewSchema.required, "attachments"]),
  AuditEventList: arrayOf(schemaReference("AuditEvent"), { maxItems: 100 }),
  NotificationList: arrayOf(schemaReference("Notification"), { maxItems: 100 }),
  OperationalOwner: strictObject({ code: { type: "string", enum: ["REQUESTING_TEAM", "LABORATORY", "RADIOLOGY", "ULTRASOUND", "DIAGNOSTICS_OPERATIONS", "UNKNOWN"] }, label: stringSchema(1, 200) }, ["code", "label"]),
  OperationalAction: strictObject({ code: { type: "string", enum: ["COLLECT_SAMPLE", "SCHEDULE_EXAM", "ROUTE_PATIENT", "START_PROCESSING", "REGISTER_RESULT", "MARK_PERFORMED", "PRODUCE_REPORT", "REVIEW_RESULT", "REGISTER_REPLACEMENT_RESULT", "COLLECT_REPLACEMENT_SAMPLE", "MONITOR_ITEM"] }, label: stringSchema(1, 200) }, ["code", "label"]),
  OperationalBlocker: strictObject({ code: { type: "string", enum: ["WAITING_SAMPLE", "WAITING_REPLACEMENT_SAMPLE", "WAITING_SCHEDULE", "WAITING_REPORT"] }, label: stringSchema(1, 200) }, ["code", "label"]),
  OperationalContext: strictObject({
    currentOwner: schemaReference("OperationalOwner"), nextAction: schemaReference("OperationalAction"),
    blockedBy: { oneOf: [schemaReference("OperationalBlocker"), { type: "null" }] },
    waitingSince: { oneOf: [timestamp, { type: "null" }] }, expectedBy: { oneOf: [timestamp, { type: "null" }] },
    escalationLevel: { type: "string", enum: ["NONE", "WATCH", "ATTENTION", "URGENT"] }
  }, ["currentOwner", "nextAction", "blockedBy", "waitingSince", "expectedBy", "escalationLevel"]),
  QueueItem: strictObject({ ...diagnosticItemSchema.properties, requestCode: stringSchema(1, 100), patient: strictObject({ id: identifier, displayName: stringSchema(1, 200), species: stringSchema(1, 100), sex: stringSchema(1, 40), externalId: stringSchema(1, 100) }, ["id", "displayName", "species", "sex", "externalId"]), service: strictObject({ id: identifier, code: stringSchema(1, 60), name: stringSchema(1, 120) }, ["id", "code", "name"]), overdue: { type: "boolean" }, nextAction: stringSchema(1, 200), operationalContext: schemaReference("OperationalContext"), currentOwner: schemaReference("OperationalOwner"), blockedBy: { oneOf: [schemaReference("OperationalBlocker"), { type: "null" }] }, waitingSince: { oneOf: [timestamp, { type: "null" }] }, expectedBy: { oneOf: [timestamp, { type: "null" }] }, escalationLevel: { type: "string", enum: ["NONE", "WATCH", "ATTENTION", "URGENT"] } }, [...diagnosticItemSchema.required, "requestCode", "patient", "service", "overdue", "nextAction", "operationalContext", "currentOwner", "blockedBy", "waitingSince", "expectedBy", "escalationLevel"]),
  QueueItemList: arrayOf(schemaReference("QueueItem"), { maxItems: 100 }),
  SearchResult: strictObject({ type: { type: "string", enum: ["REQUEST", "ITEM"] }, id: identifier, label: stringSchema(1, 500), patient: stringSchema(1, 200), status: { type: "string", enum: [...itemStates, "PARTIALLY_AVAILABLE", "RESULTS_AVAILABLE"] }, priority: prioritySchema, updatedAt: timestamp, departmentCode: stringSchema(1, 60), deepLink: stringSchema(1, 500) }, ["type", "id", "label", "patient", "status", "priority", "updatedAt", "departmentCode", "deepLink"]),
  SearchResultList: arrayOf(schemaReference("SearchResult"), { maxItems: 100 }),
  TimelineEventList: arrayOf(schemaReference("AuditEvent"), { maxItems: 100 }),
  DashboardIndicator: strictObject({ key: { type: "string", enum: ["overdue", "recollections", "newResults", "critical", "totalActive"] }, label: stringSchema(1, 200), count: nonNegativeInteger, denominator: nonNegativeInteger, denominatorDefinition: stringSchema(1, 500), definition: stringSchema(1, 1000), nextAction: stringSchema(1, 500) }, ["key", "label", "count", "denominator", "denominatorDefinition", "definition", "nextAction"]),
  DashboardAttentionItem: strictObject({ id: identifier, requestId: identifier, requestCode: stringSchema(1, 100), patient: strictObject({ id: identifier, displayName: stringSchema(1, 200), species: stringSchema(1, 100), externalId: stringSchema(1, 100) }, ["id", "displayName", "species", "externalId"]), service: strictObject({ id: identifier, name: stringSchema(1, 120), workflowType: { type: "string", enum: ["LABORATORY", "RADIOLOGY", "ULTRASOUND"] } }, ["id", "name", "workflowType"]), departmentCode: stringSchema(1, 60), status: { type: "string", enum: itemStates }, priority: prioritySchema, dueAt: timestamp, overdue: { type: "boolean" }, nextAction: stringSchema(1, 200), operationalContext: schemaReference("OperationalContext"), deepLink: stringSchema(1, 500) }, ["id", "requestId", "requestCode", "patient", "service", "departmentCode", "status", "priority", "dueAt", "overdue", "nextAction", "operationalContext", "deepLink"]),
  DashboardDepartment: strictObject({ departmentCode: stringSchema(1, 60), label: stringSchema(1, 120), activeItems: nonNegativeInteger, overdue: nonNegativeInteger, attention: nonNegativeInteger, state: { type: "string", enum: ["CLEAR", "ACTIVE", "ATTENTION"] } }, ["departmentCode", "label", "activeItems", "overdue", "attention", "state"]),
  DashboardView: strictObject({ overdue: nonNegativeInteger, recollections: nonNegativeInteger, newResults: nonNegativeInteger, critical: nonNegativeInteger, totalActive: nonNegativeInteger, updatedAt: timestamp, window: strictObject({ kind: { type: "string", const: "CURRENT_STATE" }, label: { type: "string", const: "Estado atual" }, timezone: stringSchema(1, 80), asOf: timestamp }, ["kind", "label", "timezone", "asOf"]), indicators: arrayOf(schemaReference("DashboardIndicator"), { minItems: 5, maxItems: 5 }), attention: arrayOf(schemaReference("DashboardAttentionItem"), { maxItems: 24 }), departments: arrayOf(schemaReference("DashboardDepartment"), { maxItems: 20 }), dataQuality: strictObject({ status: { type: "string", enum: ["FRESH", "DEGRADED"] }, asOf: timestamp, note: stringSchema(1, 500) }, ["status", "asOf"]) }, ["overdue", "recollections", "newResults", "critical", "totalActive", "updatedAt", "window", "indicators", "attention", "departments", "dataQuality"]),
  ManagementOverview: strictObject({ asOf: timestamp, scope: strictObject({ departments: arrayOf(stringSchema(1, 60)), label: stringSchema(1, 500) }, ["departments", "label"]), summary: strictObject({ totalRequests: nonNegativeInteger, activeItems: nonNegativeInteger, overdue: nonNegativeInteger, recollections: nonNegativeInteger, newResults: nonNegativeInteger, critical: nonNegativeInteger, pendingRequests: nonNegativeInteger, completedToday: nonNegativeInteger }, ["totalRequests", "activeItems", "overdue", "recollections", "newResults", "critical", "pendingRequests", "completedToday"]), departments: arrayOf(strictObject({ departmentCode: stringSchema(1, 60), serviceCount: nonNegativeInteger, totalRequests: nonNegativeInteger, activeItems: nonNegativeInteger, overdue: nonNegativeInteger, pending: nonNegativeInteger }, ["departmentCode", "serviceCount", "totalRequests", "activeItems", "overdue", "pending"])), pending: arrayOf(strictObject({ id: identifier, requestId: identifier, requestCode: stringSchema(1, 100), patient: stringSchema(1, 200), service: stringSchema(1, 120), departmentCode: stringSchema(1, 60), status: { type: "string", enum: itemStates }, priority: prioritySchema, dueAt: timestamp, overdue: { type: "boolean" }, nextAction: stringSchema(1, 500), deepLink: stringSchema(1, 500) }, ["id", "requestId", "requestCode", "patient", "service", "departmentCode", "status", "priority", "dueAt", "overdue", "nextAction", "deepLink"])), recentRequests: arrayOf(strictObject({ id: identifier, requestCode: stringSchema(1, 100), patient: stringSchema(1, 200), aggregateStatus: aggregateStatusSchema, priority: prioritySchema, updatedAt: timestamp, itemCount: nonNegativeInteger, deepLink: stringSchema(1, 500) }, ["id", "requestCode", "patient", "aggregateStatus", "priority", "updatedAt", "itemCount", "deepLink"])) }, ["asOf", "scope", "summary", "departments", "pending", "recentRequests"])
};

const supportSchemas = {
  SlaHours: strictObject({
    ROUTINE: { type: "number", exclusiveMinimum: 0, maximum: 720 }, URGENT: { type: "number", exclusiveMinimum: 0, maximum: 720 },
    EMERGENCY: { type: "number", exclusiveMinimum: 0, maximum: 720 }
  }, ["ROUTINE", "URGENT", "EMERGENCY"]),
  Identifier: identifier,
  ServiceIdentifier: serviceIdentifier,
  PlannerQuery: stringSchema(0, 200),
  Boolean: { type: "boolean" },
  DateTime: strictDateTime,
  Cursor: { type: "string", maxLength: 200, pattern: "^[A-Za-z0-9_-]+$" },
  Limit: { type: "integer", minimum: 1, maximum: 100, default: 25 },
  ExternalId: { type: "string", minLength: 1, maxLength: 100, pattern: "^[A-Za-z0-9._-]+$" },
  DepartmentCode: normalizedDepartmentCodeSchema,
  Priority: { type: "string", enum: ["ROUTINE", "URGENT", "EMERGENCY"] },
  ItemState: { type: "string", enum: itemStates },
  PatientQuery: { type: "string", maxLength: 200 },
  SearchQuery: { ...stringSchema(2, 200), pattern: "^\\s*\\S(?:[\\s\\S]*\\S|\\S)\\s*$" },
  SearchTypes: { type: "string", pattern: "^(REQUEST|ITEM)(\\s*,\\s*(REQUEST|ITEM))*$" },
  NotificationFilter: { type: "string", enum: ["ALL", "UNREAD", "ACTIONABLE", "CRITICAL"] },
  WebhookMode: { type: "string", enum: ["subscribe"] },
  WebhookVerifyToken: stringSchema(1, 200),
  WebhookChallenge: { type: "string", maxLength: 200, pattern: "^[A-Za-z0-9_-]+$" },
  ResponseMeta: metaSchema,
  ErrorEnvelope: strictObject({
    error: strictObject({ code: stringSchema(1, 100), message: stringSchema(1, 1000), details: { type: "object", additionalProperties: true }, correlationId: stringSchema(1, 100) }, ["code", "message", "correlationId"])
  }, ["error"])
};

const responseEnvelopeSchemas = Object.fromEntries(API_OPERATIONS.flatMap((operation) => {
  if (!operation.successMediaTypes.includes("application/json")) return [];
  if (!operation.successDataSchema) throw new Error(`${operation.method} ${operation.path} is missing successDataSchema.`);
  return [[`${operation.operationId}SuccessResponse`, strictObject({
    data: schemaReference(operation.successDataSchema),
    meta: schemaReference("ResponseMeta")
  }, ["data", "meta"])]];
}));

const errorDescriptions = {
  400: "Invalid or malformed request", 401: "Authentication failed", 403: "Authenticated actor is not authorized",
  404: "Resource or concealed route not found", 409: "State, concurrency, or idempotency conflict",
  413: "Request body exceeds the configured limit", 415: "Request media type is not supported", 422: "Semantically invalid command",
  429: "Rate limit exceeded", 500: "Unexpected safe server error", 502: "Configured upstream returned an unavailable or invalid response", 503: "Required dependency is unavailable"
};

function headerParameter(header) {
  const schemas = {
    "x-webhook-id": { type: "string", pattern: "^[A-Za-z0-9._:-]{1,100}$" },
    "x-webhook-event": { type: "string", pattern: "^[A-Za-z0-9._:-]{1,120}$" },
    "x-webhook-delivery-id": { type: "string", pattern: "^[A-Za-z0-9._:-]{1,100}$" },
    "x-webhook-signature": { type: "string", pattern: "^sha256=[0-9a-f]{64}$" },
    "x-webhook-timestamp": { type: "string", pattern: "^[1-9][0-9]{0,14}$" },
    "x-webhook-signature-version": { type: "string", enum: ["v2"] },
    "x-correlation-id": { type: "string", minLength: 1, maxLength: 100, pattern: "^[A-Za-z0-9._:-]+$" },
    "x-csrf-token": stringSchema(1, 500), "idempotency-key": nonBlankStringSchema(1, 200),
    "if-match": { type: "string", pattern: "^(?:[1-9][0-9]{0,14}|\\\"[1-9][0-9]{0,14}\\\"|W/\\\"[1-9][0-9]{0,14}\\\")$" }, "last-event-id": stringSchema(1, 200),
    "x-duplicate-override": { type: "string", enum: ["true"] }, "x-hub-signature-256": { type: "string", pattern: "^sha256=[0-9a-fA-F]{64}$" }, "authorization": { type: "string", pattern: "^Bearer cvg_int_[A-Za-z0-9_-]{43}$" }
  };
  const names = {
    "x-webhook-id": "X-Webhook-ID", "x-webhook-event": "X-Webhook-Event", "x-webhook-delivery-id": "X-Webhook-Delivery-ID",
    "x-webhook-signature": "X-Webhook-Signature", "x-webhook-timestamp": "X-Webhook-Timestamp", "x-webhook-signature-version": "X-Webhook-Signature-Version",
    "x-correlation-id": "X-Correlation-Id", "x-csrf-token": "X-CSRF-Token", "idempotency-key": "Idempotency-Key",
    "if-match": "If-Match", "last-event-id": "Last-Event-ID", "x-duplicate-override": "X-Duplicate-Override",
    "x-hub-signature-256": "X-Hub-Signature-256", "authorization": "Authorization"
  };
  return { name: names[header.name], in: "header", required: header.required, schema: schemas[header.name] };
}

function pathParameters(path) {
  return [...path.matchAll(/\{([^}]+)\}/g)].map((match) => ({ name: match[1], in: "path", required: true, schema: match[1] === "metricCode" ? schemaReference("HospitalMetricCode") : match[1] === "system" ? schemaReference("HospitalIntegrationSystem") : match[1] === "departmentCode" ? schemaReference("DepartmentCode") : pathIdentifier }));
}

function queryParameter(parameter) {
  return { name: parameter.name, in: "query", ...(parameter.required ? { required: true } : {}), ...(parameter.style ? { style: parameter.style } : {}), ...(parameter.explode !== undefined ? { explode: parameter.explode } : {}), schema: schemaReference(parameter.schema) };
}

function responseHeaders(names, operation) {
  const cacheControl = operation?.successMediaTypes.includes("text/event-stream")
    ? "no-cache, no-transform"
    : operation?.path === "/attachments/{attachmentId}/download" || operation?.path === "/hospital-task-attachments/{attachmentId}/content" ? "private, no-store" : "no-store";
  const headers = {
    "x-correlation-id": ["X-Correlation-Id", { $ref: "#/components/headers/CorrelationId" }],
    "cache-control": ["Cache-Control", { required: true, schema: { type: "string", enum: [cacheControl] } }],
    "set-cookie": ["Set-Cookie", { required: true, description: "Opaque session and CSRF cookies; multiple Set-Cookie fields may be emitted.", schema: { type: "string" } }],
    "content-length": ["Content-Length", { required: true, schema: { type: "string", pattern: "^[0-9]+$" } }],
    "content-disposition": ["Content-Disposition", { required: true, schema: { type: "string", pattern: "^attachment; filename=\\\"[^\\\"]+\\\"$" } }],
    connection: ["Connection", { required: true, schema: { type: "string", enum: ["keep-alive"] } }]
  };
  return Object.fromEntries(names.map((name) => headers[name]));
}

function successContent(operation) {
  return Object.fromEntries(operation.successMediaTypes.map((mediaType) => {
    const schema = mediaType === "application/json" ? schemaReference(`${operation.operationId}SuccessResponse`)
      : mediaType === "application/pdf" || mediaType === "image/jpeg" || mediaType === "image/png"
        ? schemaReference("AttachmentBinary") : { type: "string" };
    return [mediaType, { schema }];
  }));
}

function responsesFor(operation) {
  const responses = {};
  for (const status of operation.successStatuses) {
    responses[String(status)] = {
      description: status === 201 ? "Resource created" : "Operation completed",
      headers: responseHeaders(operation.successHeaders, operation),
      content: successContent(operation)
    };
  }
  for (const status of operation.errorStatuses) {
    responses[String(status)] = {
      description: errorDescriptions[status], headers: responseHeaders(["x-correlation-id", "cache-control"]),
      content: { "application/json": { schema: schemaReference("ErrorEnvelope") } }
    };
  }
  return responses;
}

function operationObject(operation) {
  const security = operation.integrationTokenScheme ? [{ [operation.integrationTokenScheme]: [] }] : operation.authentication === "public"
    ? []
    : operation.csrf ? [{ session: [], csrfCookie: [] }] : [{ session: [] }, ...(operation.serviceTokenScheme ? [{ [operation.serviceTokenScheme]: [] }] : [])];
  return {
    operationId: operation.operationId,
    summary: operation.summary,
    description: `${operation.summary}. Responses never expose internal exception or persistence details.`,
    tags: [operation.tag],
    security,
    "x-required-permissions": operation.authorization.requiredPermissions,
    ...(operation.authorization.anyOfPermissions ? { "x-any-of-permissions": operation.authorization.anyOfPermissions } : {}),
    "x-conditional-permission-rules": operation.authorization.conditionalPermissionRules,
    "x-authorization-conditions": operation.authorization.conditions,
    "x-step-up-required": operation.authorization.stepUpRequired,
    ...(operation.concurrencyGuard ? { "x-concurrency-guard": operation.concurrencyGuard } : {}),
    ...(operation.conditionalRequestRules ? { "x-conditional-request-rules": operation.conditionalRequestRules } : {}),
    ...(operation.queryConstraints ? { "x-query-constraints": operation.queryConstraints } : {}),
    parameters: [...operation.requestHeaders.map(headerParameter), ...pathParameters(operation.path), ...(operation.queryParameters ?? []).map(queryParameter)],
    ...(operation.requestBody ? { requestBody: { required: true, content: { [operation.requestBody.mediaType]: { schema: schemaReference(operation.requestBody.schema) } } } } : {}),
    responses: responsesFor(operation)
  };
}

function createDocument() {
  const paths = {};
  for (const operation of API_OPERATIONS) {
    const method = operation.method.toLowerCase();
    paths[operation.path] = { ...(paths[operation.path] ?? {}), [method]: operationObject(operation) };
  }
  const tags = [...new Set(API_OPERATIONS.map(({ tag }) => tag))].sort().map((name) => ({ name, description: `${name} operations for the CVG diagnostic workflow.` }));
  return {
    openapi: "3.1.0",
    jsonSchemaDialect: "https://json-schema.org/draft/2020-12/schema",
    info: {
      title: "CVG Diagnostics Hub API", version: "1.0.0",
      description: "Exact, executable contract for the versioned CVG veterinary diagnostics API. All examples and local identities are synthetic.",
      license: { name: "Proprietary", identifier: "LicenseRef-Proprietary" }
    },
    servers: [{ url: "/api/v1", description: "Same-origin versioned API" }],
    tags,
    paths,
    components: {
      securitySchemes: {
        session: { type: "apiKey", in: "cookie", name: "cvg_session", description: "Opaque HttpOnly session cookie." },
        csrfCookie: { type: "apiKey", in: "cookie", name: "cvg_csrf", description: "Readable double-submit CSRF cookie. Authenticated mutations require this cookie and the matching X-CSRF-Token header." },
        metricsBearer: { type: "http", scheme: "bearer", description: "Static Prometheus scrape token (METRICS_SCRAPE_TOKEN, at least 32 characters). Accepted only by GET /metrics." },
        integrationBearer: { type: "http", scheme: "bearer", description: "Scoped, expiring and revocable service credential, accepted only by the dedicated integration ingress together with a valid body HMAC. Never accepted as a browser session or general API token." },
        hisV4WebhookSignature: { type: "apiKey", in: "header", name: "X-Webhook-Signature", description: "HIS v4 signature v2: sha256 HMAC of Unix seconds, a period and the exact raw JSON body. Requires the configured webhook/credential binding and matching timestamp/version/identity headers. Accepted only by the dedicated HIS v4 webhook route; never authenticates general API access." }
      },
      headers: {
        CorrelationId: { description: "Stable correlation identifier for support and audit tracing.", required: true, schema: stringSchema(1, 100) }
      },
      schemas: { ...requestSchemas, ...supportSchemas, ...responseDataSchemas, ...responseEnvelopeSchemas }
    }
  };
}

function operationKeys(document) {
  const methods = new Set(["delete", "get", "patch", "post", "put"]);
  return Object.entries(document.paths ?? {}).flatMap(([path, pathItem]) =>
    Object.keys(pathItem ?? {}).filter((method) => methods.has(method)).map((method) => `${method.toUpperCase()} ${path}`)
  ).sort();
}

function assertSemanticDrift(document, expected) {
  const actualKeys = operationKeys(document);
  const expectedKeys = operationKeys(expected);
  if (!isDeepStrictEqual(actualKeys, expectedKeys)) {
    const missing = expectedKeys.filter((key) => !actualKeys.includes(key));
    const extra = actualKeys.filter((key) => !expectedKeys.includes(key));
    throw new Error(`OpenAPI method/path drift. Missing: ${missing.join(", ") || "none"}. Extra: ${extra.join(", ") || "none"}.`);
  }
  if (!isDeepStrictEqual(document, expected)) {
    throw new Error("OpenAPI semantic drift: regenerate after changing manifest identity, auth, headers, request body/media/schema, query parameters, or responses.");
  }
  if (document.components?.operations !== undefined) throw new Error("components.operations is not a standard OpenAPI component category.");
  // 87/80 since PROD-502 added GET /data-subject-exports; 86/79 since PROD-202 added POST /users/{userId}/password-reset-link and POST /session/password/reset; 84/77 since PROD-501 added GET /patients/{patientId}/archive and GET /archive/requests/{requestId}; 82/75 since PROD-406 added POST /patients/{patientId}/encounters and POST /encounters/{encounterId}/close; 80/74 since PROD-402 added GET/POST /webhooks/whatsapp; 78/73 since PROD-405 added GET /samples/{sampleId}/label; 77/72 since PROD-407 added POST /diagnostic-services/import; 76/71 since PROD-402 added PUT /session/alert-contact and PUT /users/{userId}/on-call (2026-10-08).
  if (API_OPERATIONS.length !== 248 || new Set(API_OPERATIONS.map(({ path }) => path)).size !== 209) throw new Error("The audited API surface must remain exactly 248 operations across 209 paths.");
  const operationIds = API_OPERATIONS.map(({ operationId }) => operationId);
  if (new Set(operationIds).size !== operationIds.length) throw new Error("Manifest operationId values must be unique.");
  for (const operation of API_OPERATIONS) {
    const csrf = operation.requestHeaders.find(({ name }) => name === "x-csrf-token");
    if (operation.csrf !== Boolean(csrf?.required)) throw new Error(`${operation.method} ${operation.path} CSRF drift.`);
    if (operation.authentication === "public" && csrf) throw new Error(`${operation.method} ${operation.path} cannot be public and require CSRF.`);
    if (operation.successMediaTypes.includes("application/json") && !operation.successDataSchema) {
      throw new Error(`${operation.method} ${operation.path} must declare an explicit JSON success data schema.`);
    }
    if (!operation.successMediaTypes.includes("application/json") && operation.successDataSchema) {
      throw new Error(`${operation.method} ${operation.path} cannot declare JSON success data for a non-JSON operation.`);
    }
  }
}

const expectedDocument = createDocument();
if (process.argv.includes("--write")) {
  await writeFile(documentUrl, `${JSON.stringify(expectedDocument, null, 2)}\n`, "utf8");
  console.log(`OpenAPI generated: ${API_OPERATIONS.length} operations across ${Object.keys(expectedDocument.paths).length} paths.`);
} else {
  const document = JSON.parse(await readFile(documentUrl, "utf8"));
  assertSemanticDrift(document, expectedDocument);
  console.log(`OpenAPI manifest drift validation PASS: ${API_OPERATIONS.length} operations across ${Object.keys(document.paths).length} paths.`);
}
