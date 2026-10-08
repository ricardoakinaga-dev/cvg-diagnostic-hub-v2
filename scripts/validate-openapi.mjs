import { readFile, writeFile } from "node:fs/promises";
import { isDeepStrictEqual } from "node:util";
import { API_OPERATIONS } from "../src/server/http/api-operation-manifest.ts";

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
const accessionCodeSchema = { type: "string", minLength: 3, maxLength: 40, pattern: "^[A-Z0-9][A-Z0-9-]{2,39}$" };
const passwordPattern = "^(?=.*[A-Za-z])(?=.*[0-9]).+$";
const supportedAttachmentMediaTypes = ["application/pdf", "image/jpeg", "image/png"];
const roleCodes = ["ADMIN", "MANAGER", "VETERINARIAN", "INPATIENT_TEAM", "LAB_TECH", "RADIOLOGY_TEAM", "ULTRASOUND_TEAM", "VIEWER"];
const itemStates = ["REQUESTED", "RECEIVED", "IN_PROGRESS", "SCHEDULED", "AWAITING_REPORT", "RESULT_AVAILABLE", "REVIEWED", "COMPLETED", "CANCELLED", "REJECTED", "RECOLLECTION_REQUIRED", "FAILED", "RESULT_VOIDED"];

const strictObject = (properties, required = []) => ({
  type: "object",
  additionalProperties: false,
  ...(required.length ? { required } : {}),
  properties
});
const hasProperty = (name) => ({ properties: { [name]: {} }, required: [name] });

const requestSchemas = {
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
      ward: normalizedTextSchema(1, 100), bed: normalizedTextSchema(1, 100)
    }, ["displayName", "species", "breed", "sex", "ownerLabel", "encounterType"]),
    "x-cross-field-constraints": [
      "encounterType=INPATIENT requires ward and bed",
      "ward and bed are only accepted for encounterType=INPATIENT",
      "externalId is generated when omitted"
    ]
  },
  ManagedUserCreate: {
    ...strictObject({
    email: { type: "string", format: "email", maxLength: 320 }, displayName: normalizedTextSchema(2, 160),
    password: { ...stringSchema(12, 200), pattern: passwordPattern }, role: { type: "string", enum: roleCodes }, departmentCode: normalizedDepartmentCodeSchema,
    managedDepartmentCodes: { type: "array", maxItems: 20, items: normalizedDepartmentCodeSchema }, serviceCodes: { type: "array", maxItems: 200, items: normalizedCatalogCodeSchema },
    timezone: { ...normalizedTextSchema(1, 80), "x-runtime-validation": "IANA time zone identifier validated by Intl.DateTimeFormat" },
    reason: normalizedTextSchema(1, 500), confirm: { type: "boolean", const: true }
    }, ["email", "displayName", "role"]),
    "x-role-constraints": { managedDepartmentCodes: "allowed only when role is MANAGER" }
  },
  ManagedUserDeactivate: strictObject({ expectedVersion, reason: normalizedTextSchema(1, 500), confirm: { type: "boolean", const: true } }),
  ManagedUserPasswordReset: strictObject({ expectedVersion }),
  UserRoleUpdate: {
    ...strictObject({
      role: { type: "string", enum: roleCodes }, departmentCode: normalizedDepartmentCodeSchema,
      managedDepartmentCodes: { type: "array", maxItems: 20, items: normalizedDepartmentCodeSchema }, serviceCodes: { type: "array", maxItems: 200, items: normalizedCatalogCodeSchema }, active: { type: "boolean" },
      expectedVersion, reason: normalizedTextSchema(1, 500), confirm: { type: "boolean", const: true }
    }, ["role", "departmentCode"]),
    "x-role-constraints": { managedDepartmentCodes: "allowed only when role is MANAGER" }
  },
  SessionRevoke: strictObject({ reason: normalizedTextSchema(1, 500), confirm: { type: "boolean", const: true } }),
  DeadLetterCommand: strictObject({ reason: normalizedTextSchema(1, 500), confirm: { type: "boolean", const: true } }),
  DiagnosticServiceCreate: {
    ...strictObject({
    code: normalizedCatalogCodeSchema, name: normalizedTextSchema(1, 120), category: { type: "string", enum: ["LABORATORY", "IMAGING"] },
    departmentCode: normalizedDepartmentCodeSchema, workflowType: { type: "string", enum: ["LABORATORY", "RADIOLOGY", "ULTRASOUND"] },
    requiresSample: { type: "boolean" }, sampleType: normalizedTextSchema(1, 60), requiresSchedule: { type: "boolean" }, allowsAttachment: { type: "boolean" },
    resultSchema: { type: "string", enum: ["NUMERIC_PANEL", "NARRATIVE"] }, duplicateOfServiceId: identifier, slaHours: schemaReference("SlaHours")
    }, ["code", "name", "category", "departmentCode", "workflowType", "requiresSample", "requiresSchedule", "allowsAttachment", "resultSchema", "slaHours"]),
    oneOf: [
      { properties: { category: { const: "LABORATORY" }, workflowType: { const: "LABORATORY" } } },
      { properties: { category: { const: "IMAGING" }, workflowType: { enum: ["RADIOLOGY", "ULTRASOUND"] } } }
    ],
    "x-cross-field-constraints": [
      "category=LABORATORY requires workflowType=LABORATORY",
      "category=IMAGING requires workflowType=RADIOLOGY or ULTRASOUND"
    ]
  },
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
      responsibleUserId: normalizedTextSchema(1, 100),
      expectedVersion
    }, ["action", "effectiveAt", "reason"]),
    oneOf: [
      { properties: { action: { const: "TRANSFER" } }, required: ["departmentCode", "ward", "bed", "responsibleUserId"] },
      {
        properties: { action: { const: "BED_CHANGE" } }, required: ["ward", "bed"],
        not: { anyOf: [hasProperty("departmentCode"), hasProperty("responsibleUserId")] }
      },
      {
        properties: { action: { const: "DISCHARGE" } },
        not: { anyOf: [hasProperty("departmentCode"), hasProperty("ward"), hasProperty("bed"), hasProperty("responsibleUserId")] }
      },
      {
        properties: { action: { const: "RESPONSIBILITY_CHANGE" } }, required: ["responsibleUserId"],
        not: { anyOf: [hasProperty("departmentCode"), hasProperty("ward"), hasProperty("bed")] }
      }
    ],
    "x-policy-gate": "D-01 must be approved and configured; missing or invalid policy fails closed with 503"
  },
  VersionCommand: strictObject({ expectedVersion }),
  CancelCommand: strictObject({ reasonCode: normalizedTextSchema(1, 60), reason: normalizedTextSchema(1, 500), itemIds: { type: "array", maxItems: 20, uniqueItems: true, items: normalizedTextSchema(1, 100) }, expectedVersion }, ["reasonCode"]),
  RejectCommand: strictObject({ reasonCode: normalizedTextSchema(1, 60), note: normalizedTextSchema(1, 2000), expectedVersion }, ["reasonCode"]),
  SampleCommand: strictObject({ accessionCode: accessionCodeSchema, sampleType: normalizedTextSchema(1, 100), expectedVersion }, ["accessionCode", "sampleType"]),
  RecollectionCommand: strictObject({ reasonCode: normalizedTextSchema(1, 60), note: normalizedTextSchema(1, 2000), expectedVersion }, ["reasonCode"]),
  ScheduleCommand: {
    ...strictObject({
      startsAt: strictDateTime,
      endsAt: strictDateTime,
      resource: normalizedTextSchema(1, 100), reason: normalizedTextSchema(1, 500), expectedVersion
    }, ["startsAt", "endsAt", "resource"]),
    "x-cross-field-constraints": ["endsAt must be after startsAt", "endsAt - startsAt must be at most 24 hours"]
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

const timestamp = { type: "string", format: "date-time" };
const boundedString = { type: "string", maxLength: 20000 };
const nonNegativeInteger = { type: "integer", minimum: 0 };
const positiveVersion = { type: "integer", minimum: 1 };
const prioritySchema = { type: "string", enum: ["ROUTINE", "URGENT", "EMERGENCY"] };
const workflowSchema = { type: "string", enum: ["LABORATORY", "RADIOLOGY", "ULTRASOUND"] };
const aggregateStatusSchema = { type: "string", enum: ["REQUESTED", "IN_PROGRESS", "PARTIALLY_AVAILABLE", "RESULTS_AVAILABLE", "COMPLETED", "CANCELLED"] };
const resultVersionStateSchema = { type: "string", enum: ["DRAFT", "RELEASED", "SUPERSEDED", "VOIDED"] };
const arrayOf = (schema, options = {}) => ({ type: "array", items: schema, ...options });

const publicUserSchema = strictObject({
  id: identifier, email: { type: "string", format: "email", maxLength: 320 }, displayName: stringSchema(1, 160),
  role: { type: "string", enum: roleCodes }, departmentCode: stringSchema(1, 60),
  managedDepartmentCodes: arrayOf(stringSchema(1, 60), { maxItems: 20 }), timezone: stringSchema(1, 80), mustChangePassword: { type: "boolean" }
}, ["id", "email", "displayName", "role", "departmentCode", "timezone"]);
const managedUserSchema = strictObject({
  ...publicUserSchema.properties, serviceCodes: arrayOf(normalizedCatalogCodeSchema, { maxItems: 200 }), active: { type: "boolean" }, createdAt: timestamp, version: positiveVersion
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
  id: identifier, encounterId: identifier, departmentCode: stringSchema(1, 60), ward: stringSchema(1, 100), bed: stringSchema(1, 100),
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
  unitCode: stringSchema(1, 100), required: { type: "boolean" }, displayOrder: { type: "integer", minimum: 0, maximum: 1000 },
  referenceRange: laboratoryReferenceRangeSchema, allowedValues: arrayOf(stringSchema(1, 200), { maxItems: 100 })
}, ["code", "label", "valueType", "unitCode", "required", "displayOrder"]);
const laboratoryPanelTemplateSchema = strictObject({
  kind: { type: "string", const: "LABORATORY_PANEL" }, code: stringSchema(1, 100), name: stringSchema(1, 200),
  version: positiveVersion, schemaVersion: stringSchema(1, 40), status: { type: "string", enum: ["DRAFT", "ACTIVE", "RETIRED"] },
  analytes: arrayOf(schemaReference("LaboratoryAnalyteDefinition"), { minItems: 1, maxItems: 100 })
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
const diagnosticServiceSchema = strictObject({
  id: identifier, code: stringSchema(2, 60), name: stringSchema(1, 120), category: { type: "string", enum: ["LABORATORY", "IMAGING"] },
  departmentCode: stringSchema(1, 60), workflowType: workflowSchema, requiresSample: { type: "boolean" }, sampleType: stringSchema(1, 60), requiresSchedule: { type: "boolean" },
  allowsAttachment: { type: "boolean" }, active: { type: "boolean" }, resultSchema: { type: "string", enum: ["NUMERIC_PANEL", "NARRATIVE"] },
  resultTemplate: schemaReference("LaboratoryPanelTemplate"),
  slaHours: schemaReference("SlaHours"), version: positiveVersion
}, ["id", "code", "name", "category", "departmentCode", "workflowType", "requiresSample", "requiresSchedule", "allowsAttachment", "active", "resultSchema", "slaHours", "version"]);
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
  currentSampleId: identifier, procedureId: identifier
}, ["id", "requestId", "serviceId", "departmentCode", "workflowType", "priority", "status", "requestedAt", "slaStartedAt", "dueAt", "slaPolicyVersion", "version"]);
const requestItemSchema = strictObject({ ...diagnosticItemSchema.properties, service: schemaReference("DiagnosticService") }, [
  ...diagnosticItemSchema.required, "service"
]);
requestItemSchema.properties.procedureVersion = positiveVersion;
const requestViewSchema = strictObject({
  ...diagnosticRequestSchema.properties, patient: schemaReference("Patient"), encounter: schemaReference("Encounter"), items: arrayOf(schemaReference("RequestItem"))
}, [...diagnosticRequestSchema.required, "patient", "encounter", "items"]);
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
const procedureScheduleSchema = strictObject({
  id: identifier, procedureId: identifier, startsAt: timestamp, endsAt: timestamp, resource: stringSchema(1, 100),
  status: { type: "string", enum: ["SCHEDULED", "CANCELLED", "COMPLETED"] }, reason: stringSchema(1, 500),
  actorId: identifier, createdAt: timestamp, version: positiveVersion
}, ["id", "procedureId", "startsAt", "endsAt", "resource", "status", "actorId", "createdAt", "version"]);
const resultSchema = strictObject({
  id: identifier, itemId: identifier, currentVersionId: identifier, lifecycleStatus: { type: "string", enum: ["DRAFT", "RELEASED", "VOIDED"] },
  needsReReview: { type: "boolean" }, version: positiveVersion
}, ["id", "itemId", "lifecycleStatus", "needsReReview", "version"]);
const resultVersionSchema = strictObject({
  id: identifier, resultId: identifier, sequence: positiveVersion, status: resultVersionStateSchema, content: { anyOf: [schemaReference("StructuredLaboratoryResultContent"), schemaReference("JsonObject")] },
  narrative: boundedString, conclusion: { type: "string", maxLength: 5000 }, authorId: identifier, createdAt: timestamp, releasedAt: timestamp,
  releasedBy: identifier, amendmentReason: stringSchema(1, 500), supersedesId: identifier, critical: { type: "boolean" },
  needsReReview: { type: "boolean" }, version: positiveVersion
}, ["id", "resultId", "sequence", "status", "content", "narrative", "authorId", "createdAt", "critical", "needsReReview", "version"]);
const resultViewSchema = strictObject({
  result: schemaReference("Result"), version: schemaReference("ResultVersion"), item: schemaReference("DiagnosticItem"),
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
  createdAt: timestamp, acknowledgedAt: timestamp, acknowledgedBy: identifier, attempts: nonNegativeInteger, version: positiveVersion
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

const responseDataSchemas = {
  JsonValue: { oneOf: [{ type: "string" }, { type: "number" }, { type: "boolean" }, { type: "null" }, { type: "array", items: schemaReference("JsonValue") }, { type: "object", additionalProperties: schemaReference("JsonValue") }] },
  JsonObject: { type: "object", additionalProperties: schemaReference("JsonValue"), maxProperties: 100 },
  PublicUser: publicUserSchema,
  ManagedUser: managedUserSchema,
  ManagedUserCreation: strictObject({ ...managedUserSchema.properties, initialPassword: stringSchema(12, 200) }, managedUserSchema.required),
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
  ReauthenticationData: strictObject({ user: schemaReference("PublicUser"), reauthenticatedAt: timestamp }, ["user", "reauthenticatedAt"]),
  ManagedUserList: arrayOf(schemaReference("ManagedUser")),
  ManagedSessionList: arrayOf(schemaReference("ManagedSession"), { maxItems: 100 }),
  DeadLetterList: arrayOf(schemaReference("DeadLetterMessage"), { maxItems: 100 }),
  DeadLetterMutation: strictObject({ message: schemaReference("DeadLetterMessage"), action: { type: "string", enum: ["REPROCESSED", "DISCARDED"] } }, ["message", "action"]),
  DiagnosticServiceList: arrayOf(schemaReference("DiagnosticService")),
  ReasonCodeList: arrayOf(schemaReference("ReasonCode")),
  PatientList: arrayOf(schemaReference("Patient"), { maxItems: 100 }),
  PatientCreateResult: strictObject({ patient: schemaReference("Patient"), encounter: schemaReference("Encounter"), admission: schemaReference("Admission") }, ["patient", "encounter"]),
  PatientWorkspaceSummary: strictObject({
    asOf: timestamp,
    dataQuality: strictObject({ status: { type: "string", enum: ["FRESH", "DEGRADED"] }, asOf: timestamp, note: stringSchema(1, 500) }, ["status", "asOf"]),
    currentContext: strictObject({
      encounterId: { oneOf: [identifier, { type: "null" }] }, admissionId: { oneOf: [identifier, { type: "null" }] },
      departmentCode: { oneOf: [normalizedDepartmentCodeSchema, { type: "null" }] }, ward: { oneOf: [stringSchema(1, 100), { type: "null" }] },
      bed: { oneOf: [stringSchema(1, 100), { type: "null" }] }, responsibleLabel: { oneOf: [stringSchema(1, 160), { type: "null" }] }
    }, ["encounterId", "admissionId", "departmentCode", "ward", "bed", "responsibleLabel"]),
    summary: strictObject({
      requestCount: nonNegativeInteger, itemCount: nonNegativeInteger, activeItemCount: nonNegativeInteger,
      availableResultCount: nonNegativeInteger, sampleCount: nonNegativeInteger, attachmentCount: nonNegativeInteger
    }, ["requestCount", "itemCount", "activeItemCount", "availableResultCount", "sampleCount", "attachmentCount"])
  }, ["asOf", "currentContext", "summary"]),
  PatientDiagnostics: strictObject({ patient: schemaReference("Patient"), encounters: arrayOf(schemaReference("Encounter")), admissions: arrayOf(schemaReference("Admission")), items: arrayOf(schemaReference("PatientWorkspaceRequestView")), events: arrayOf(schemaReference("AuditEvent")), nextActions: arrayOf(schemaReference("PatientNextAction")), workspace: schemaReference("PatientWorkspaceSummary"), nextCursor: schemaReference("Cursor"), limit: schemaReference("Limit"), total: nonNegativeInteger }, ["patient", "encounters", "admissions", "items", "events", "nextActions", "workspace", "limit", "total"]),
  PatientNextAction: strictObject({ id: identifier, requestId: identifier, requestCode: identifier, itemId: identifier, label: nonBlankStringSchema(1, 240), deepLink: nonBlankStringSchema(1, 240), status: { type: "string", enum: itemStates }, priority: { type: "string", enum: ["ROUTINE", "URGENT", "EMERGENCY"] }, dueAt: strictDateTime, departmentCode: normalizedDepartmentCodeSchema }, ["id", "requestId", "requestCode", "itemId", "label", "deepLink", "status", "priority", "dueAt", "departmentCode"]),
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
  Boolean: { type: "boolean" },
  DateTime: strictDateTime,
  Cursor: { type: "string", maxLength: 200, pattern: "^[A-Za-z0-9_-]+$" },
  Limit: { type: "integer", minimum: 1, maximum: 100, default: 25 },
  DepartmentCode: normalizedDepartmentCodeSchema,
  Priority: { type: "string", enum: ["ROUTINE", "URGENT", "EMERGENCY"] },
  ItemState: { type: "string", enum: itemStates },
  PatientQuery: { type: "string", maxLength: 200 },
  SearchQuery: { ...stringSchema(2, 200), pattern: "^\\s*\\S(?:[\\s\\S]*\\S|\\S)\\s*$" },
  SearchTypes: { type: "string", pattern: "^(REQUEST|ITEM)(\\s*,\\s*(REQUEST|ITEM))*$" },
  NotificationFilter: { type: "string", enum: ["ALL", "UNREAD", "ACTIONABLE", "CRITICAL"] },
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
  429: "Rate limit exceeded", 500: "Unexpected safe server error", 503: "Required dependency is unavailable"
};

function headerParameter(header) {
  const schemas = {
    "x-correlation-id": { type: "string", minLength: 1, maxLength: 100, pattern: "^[A-Za-z0-9._:-]+$" },
    "x-csrf-token": stringSchema(1, 500), "idempotency-key": nonBlankStringSchema(1, 200),
    "if-match": { type: "string", pattern: "^(?:[1-9][0-9]{0,14}|\\\"[1-9][0-9]{0,14}\\\"|W/\\\"[1-9][0-9]{0,14}\\\")$" }, "last-event-id": stringSchema(1, 200),
    "x-duplicate-override": { type: "string", enum: ["true"] }
  };
  const names = {
    "x-correlation-id": "X-Correlation-Id", "x-csrf-token": "X-CSRF-Token", "idempotency-key": "Idempotency-Key",
    "if-match": "If-Match", "last-event-id": "Last-Event-ID", "x-duplicate-override": "X-Duplicate-Override"
  };
  return { name: names[header.name], in: "header", required: header.required, schema: schemas[header.name] };
}

function pathParameters(path) {
  return [...path.matchAll(/\{([^}]+)\}/g)].map((match) => ({ name: match[1], in: "path", required: true, schema: pathIdentifier }));
}

function queryParameter(parameter) {
  return { name: parameter.name, in: "query", ...(parameter.required ? { required: true } : {}), schema: schemaReference(parameter.schema) };
}

function responseHeaders(names, operation) {
  const cacheControl = operation?.successMediaTypes.includes("text/event-stream")
    ? "no-cache, no-transform"
    : operation?.path === "/attachments/{attachmentId}/download" ? "private, no-store" : "no-store";
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
  const security = operation.authentication === "public"
    ? []
    : operation.csrf ? [{ session: [], csrfCookie: [] }] : [{ session: [] }, ...(operation.serviceTokenScheme ? [{ [operation.serviceTokenScheme]: [] }] : [])];
  return {
    operationId: operation.operationId,
    summary: operation.summary,
    description: `${operation.summary}. Responses never expose internal exception or persistence details.`,
    tags: [operation.tag],
    security,
    "x-required-permissions": operation.authorization.requiredPermissions,
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
        metricsBearer: { type: "http", scheme: "bearer", description: "Static Prometheus scrape token (METRICS_SCRAPE_TOKEN, at least 32 characters). Accepted only by GET /metrics." }
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
  // 74/69 since PROD-201 added POST /session/password/change (2026-10-08).
  if (API_OPERATIONS.length !== 74 || new Set(API_OPERATIONS.map(({ path }) => path)).size !== 69) throw new Error("The audited API surface must remain exactly 74 operations across 69 paths.");
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
