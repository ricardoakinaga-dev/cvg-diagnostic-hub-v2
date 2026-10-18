import { z } from "zod";
import * as documents from "../src/server/http/hospital-document-schemas.ts";
import * as analytics from "../src/server/http/hospital-analytics-schemas.ts";
import { HOSPITAL_METRIC_CODES } from "../packages/contracts/src/hospital-analytics.ts";
const ref = (name) => ({ $ref: `#/components/schemas/${name}` });
const text = (max = 200) => ({ type: "string", minLength: 1, maxLength: max });
const id = text(100), date = { type: "string", format: "date-time" }, revision = { type: "integer", minimum: 1 }, integer = { type: "integer", minimum: 0 }, bool = { type: "boolean" };
const array = (items) => ({ type: "array", items });
const enumeration = (...values) => ({ type: "string", enum: values });
const object = (properties, optional = []) => ({ type: "object", additionalProperties: false, properties, required: Object.keys(properties).filter((key) => !optional.includes(key)) });
function input(schema, versioned = false, constraints = []) {
  const converted = z.toJSONSchema(schema, { io: "input", target: "draft-2020-12" }); delete converted.$schema;
  if (versioned) converted.required = converted.required.filter((key) => key !== "expectedVersion");
  if (constraints.length) converted["x-cross-field-constraints"] = constraints;
  return converted;
}
const draftConstraints = ["header and draft version must both match current versions", "at least one title or content change is required", "structured content is limited to 200000 UTF-8 bytes; links require HTTPS without credentials; table rows have equal widths"];
export const hospitalCollaborationRequestSchemas = {
  HospitalDocumentCreate: input(documents.hospitalDocumentCreateSchema, false, draftConstraints.slice(2)),
  HospitalDocumentMetadata: input(documents.hospitalDocumentMetadataSchema, true),
  HospitalDocumentDraft: input(documents.hospitalDocumentDraftSchema, true, draftConstraints),
  HospitalDocumentRevisionCreate: input(documents.hospitalDocumentRevisionSchema, true),
  HospitalDocumentApprove: input(documents.hospitalDocumentApproveSchema, true, ["explicit confirmation and adopted policy reference required; draft/header versions are checked atomically"]),
  HospitalDocumentRetire: input(documents.hospitalDocumentRetireSchema, true),
  HospitalDocumentLock: input(documents.hospitalDocumentLockSchema, true),
  HospitalDocumentArchive: input(documents.hospitalDocumentArchiveSchema, true),
  HospitalDocumentDuplicate: input(documents.hospitalDocumentDuplicateSchema, true),
  HospitalReportCreate: input(analytics.hospitalReportCreateSchema),
  HospitalReportPatch: input(analytics.hospitalReportPatchSchema, true),
  HospitalReportJobCreate: input(analytics.hospitalReportJobCreateSchema),
  HospitalReportJobRetry: input(analytics.hospitalReportJobRetrySchema, true)
};
const metricCode = enumeration(...HOSPITAL_METRIC_CODES);
const metricFilters = object({ from: date, to: date, departmentCode: text(60) }, ["departmentCode"]);
const reportSnapshot = object({ name: text(160), metricCode, metricDefinitionVersion: enumeration("HPL-OPERATIONAL-1"), filters: metricFilters, format: enumeration("CSV", "JSONL"), version: revision });
const page = (items) => object({ items: array(items), total: integer, limit: revision, nextCursor: text(2000) }, ["nextCursor"]);
export const hospitalCollaborationResponseSchemas = {
  HospitalDocumentContent: input(documents.hospitalDocumentContentSchema),
  HospitalDocumentRevision: object({ id, revision, title: text(200), content: ref("HospitalDocumentContent"), status: enumeration("DRAFT", "APPROVED", "RETIRED"), version: revision, createdBy: id, createdAt: date, updatedBy: id, updatedAt: date, approvedBy: id, approvedAt: date, policyReference: text(500), retiredBy: id, retiredAt: date, retirementReason: text(1000) }, ["approvedBy", "approvedAt", "policyReference", "retiredBy", "retiredAt", "retirementReason"]),
  HospitalDocument: object({ id, code: text(60), title: text(200), departmentCode: text(60), responsibleUserId: id, locked: bool, archived: bool, currentPublishedRevisionId: id, draftRevisionId: id, revisions: array(ref("HospitalDocumentRevision")), sourceDocumentId: id, sourceRevisionId: id, createdBy: id, createdAt: date, updatedAt: date, version: revision }, ["currentPublishedRevisionId", "draftRevisionId", "sourceDocumentId", "sourceRevisionId"]),
  HospitalDocumentSnapshot: object({ documentId: id, code: text(60), title: text(200), departmentCode: text(60), revisionId: id, revision, content: ref("HospitalDocumentContent"), approvedBy: id, approvedAt: date, policyReference: text(500), capturedAt: date }),
  HospitalDocumentView: object({ document: ref("HospitalDocument"), permissions: array(ref("Permission")), favorite: bool }),
  HospitalDocumentSummary: object({ id, code: text(60), title: text(200), departmentCode: text(60), responsibleUserId: id, locked: bool, archived: bool, currentRevision: revision, currentStatus: enumeration("APPROVED", "RETIRED"), hasDraft: bool, favorite: bool, version: revision, updatedAt: date }, ["currentRevision", "currentStatus"]),
  HospitalDocumentPage: page(ref("HospitalDocumentSummary")), HospitalDocumentRevisionList: array(ref("HospitalDocumentRevision")),
  HospitalDocumentOptions: object({ departments: array(object({ code: text(60), name: text(120) })), responsibles: array(object({ id, displayName: text(160), departmentCode: text(60) })) }),
  HospitalMetricCode: metricCode,
  HospitalMetricDefinition: object({ code: metricCode, label: text(200), version: enumeration("HPL-OPERATIONAL-1"), unit: enumeration("COUNT"), source: text(500), denominator: enumeration("AUTHORIZED_UNIQUE_OBJECTS", "AUTHORIZED_UNIQUE_ACTIVITIES"), timeBasis: enumeration("EVENT_IN_WINDOW", "COHORT_IN_WINDOW_CURRENT_STATE"), description: text(2000), approval: enumeration("TECHNICAL_DEFINITION_REQUIRES_PILOT_ACCEPTANCE") }),
  HospitalMetricRow: object({ targetType: enumeration("HOSPITAL_TASK", "DIAGNOSTIC_ITEM", "HOSPITAL_PLAN", "HOSPITAL_SHIFT"), id, label: text(500), departmentCode: text(60), occurredAt: date, status: text(100), deepLink: text(500) }),
  HospitalMetricRowPage: page(ref("HospitalMetricRow")),
  HospitalPlannerMetrics: object({ asOf: date, window: object({ ...metricFilters.properties, convention: enumeration("START_INCLUSIVE_END_EXCLUSIVE") }, ["departmentCode"]), scope: object({ departmentCodes: array(text(60)), policy: enumeration("CURRENT_OBJECT_AUTHORIZATION") }), values: array(object({ definition: ref("HospitalMetricDefinition"), value: { type: ["integer", "null"], minimum: 0 }, availability: enumeration("AUTHORIZED", "NOT_AUTHORIZED") })) }),
  HospitalReportDefinition: object({ id, name: text(160), ownerId: id, sharedDepartmentCode: text(60), metricCode, metricDefinitionVersion: enumeration("HPL-OPERATIONAL-1"), filters: metricFilters, format: enumeration("CSV", "JSONL"), active: bool, version: revision, createdAt: date, updatedAt: date }, ["sharedDepartmentCode"]),
  HospitalReportDefinitionList: array(ref("HospitalReportDefinition")),
  HospitalReportJob: object({ id, reportId: id, ownerId: id, definitionSnapshot: reportSnapshot, status: enumeration("PENDING", "SUCCEEDED", "FAILED"), attempts: integer, rowCount: integer, errorCode: text(100), generatedAt: date, version: revision, createdAt: date, updatedAt: date }, ["rowCount", "errorCode", "generatedAt"]),
  HospitalReportJobView: object({ job: ref("HospitalReportJob"), downloadAvailable: bool }), HospitalReportJobViewList: array(ref("HospitalReportJobView")),
  HospitalReportArtifact: object({ jobId: id, name: text(160), format: enumeration("CSV", "JSONL"), contentType: enumeration("text/csv", "application/x-ndjson"), content: { type: "string" }, rowCount: integer, generatedAt: date, definition: reportSnapshot })
};
