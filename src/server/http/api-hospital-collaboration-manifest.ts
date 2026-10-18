import type { Permission } from "@cvg/contracts";
import type { ApiAuthorization, ApiOperationDraft } from "./api-operation-model";
import { command, read, jsonBody, IDEMPOTENCY_REQUIRED, IF_MATCH } from "./api-operation-builders";

const paging = [{ name: "limit", schema: "Limit" }, { name: "cursor", schema: "Cursor" }] as const;
const window = [{ name: "from", schema: "DateTime", required: true }, { name: "to", schema: "DateTime", required: true }, { name: "departmentCode", schema: "DepartmentCode" }] as const;
const documentCommands = [
  ["PATCH", "/hospital-documents/{documentId}/metadata", "updateHospitalDocumentMetadata", "HospitalDocumentMetadata", "hospital_document.update"],
  ["PATCH", "/hospital-documents/{documentId}/draft", "updateHospitalDocumentDraft", "HospitalDocumentDraft", "hospital_document.update"],
  ["POST", "/hospital-documents/{documentId}/revisions", "createHospitalDocumentRevision", "HospitalDocumentRevisionCreate", "hospital_document.update"],
  ["POST", "/hospital-documents/{documentId}/approve", "approveHospitalDocument", "HospitalDocumentApprove", "hospital_document.approve"],
  ["POST", "/hospital-documents/{documentId}/retire", "retireHospitalDocument", "HospitalDocumentRetire", "hospital_document.retire"],
  ["POST", "/hospital-documents/{documentId}/lock", "lockHospitalDocument", "HospitalDocumentLock", "hospital_document.lock"],
  ["POST", "/hospital-documents/{documentId}/archive", "archiveHospitalDocument", "HospitalDocumentArchive", "hospital_document.archive"],
  ["POST", "/hospital-documents/{documentId}/duplicate", "duplicateHospitalDocument", "HospitalDocumentDuplicate", "hospital_document.create"]
] as const;
export const hospitalCollaborationOperations: readonly ApiOperationDraft[] = [
  read("/hospital-reports", "listHospitalReports", "List private and authorized shared operational reports", "Planner"),
  command("POST", "/hospital-reports", "createHospitalReport", "Save an operational report definition", "Planner", jsonBody("HospitalReportCreate"), { headers: [IDEMPOTENCY_REQUIRED], successStatus: 201 }),
  command("PATCH", "/hospital-reports/{reportId}", "updateHospitalReport", "Revise an owned operational report definition", "Planner", jsonBody("HospitalReportPatch"), { headers: [IDEMPOTENCY_REQUIRED, IF_MATCH], concurrencyResource: "hospitalReport.version" }),
  read("/hospital-report-jobs", "listHospitalReportJobs", "List owned currently authorized export jobs", "Planner"),
  command("POST", "/hospital-report-jobs", "createHospitalReportJob", "Queue a versioned operational export", "Planner", jsonBody("HospitalReportJobCreate"), { headers: [IDEMPOTENCY_REQUIRED], successStatus: 201 }),
  read("/hospital-report-jobs/{jobId}", "getHospitalReportJob", "Read export progress without exposing saved rows", "Planner"),
  command("POST", "/hospital-report-jobs/{jobId}/retry", "retryHospitalReportJob", "Explicitly retry a failed owned export", "Planner", jsonBody("HospitalReportJobRetry"), { headers: [IDEMPOTENCY_REQUIRED, IF_MATCH], concurrencyResource: "hospitalReportJob.version" }),
  read("/hospital-report-jobs/{jobId}/download", "downloadHospitalReportJob", "Download CSV or JSONL after current object authorization", "Planner", { errorStatuses: [400, 401, 403, 404, 409, 429, 500] }),
  read("/hospital-documents/options", "getHospitalDocumentOptions", "Read scoped document creation options", "Planner"),
  read("/hospital-documents", "listHospitalDocuments", "List currently authorized operational documents", "Planner", { queryParameters: [...paging, { name: "departmentCode", schema: "DepartmentCode" }, { name: "query", schema: "PlannerQuery" }, { name: "includeArchived", schema: "Boolean" }, { name: "favoritesOnly", schema: "Boolean" }] }),
  read("/hospital-documents/{documentId}", "getHospitalDocument", "Read document revisions and contextual commands", "Planner"),
  read("/hospital-documents/{documentId}/history", "getHospitalDocumentHistory", "Read immutable document revision history", "Planner"),
  command("POST", "/hospital-documents", "createHospitalDocument", "Create an operational document draft", "Planner", jsonBody("HospitalDocumentCreate"), { headers: [IDEMPOTENCY_REQUIRED], successStatus: 201 }),
  ...documentCommands.map(([method, path, operationId, schema]) => command(method, path, operationId, "Apply an explicit versioned document command", "Planner", jsonBody(schema), { headers: [IDEMPOTENCY_REQUIRED, IF_MATCH], concurrencyResource: "hospitalDocument.version" })),
  read("/hospital-metrics", "getHospitalPlannerMetrics", "Read operational metrics with definitions and current authorization", "Planner", { queryParameters: window, queryConstraints: { fromMustNotExceedTo: true } }),
  read("/hospital-metrics/{metricCode}/rows", "listHospitalMetricRows", "Inspect the authorized unique objects counted by a metric", "Planner", { queryParameters: [...window, ...paging], queryConstraints: { fromMustNotExceedTo: true } })
];
const authorization = (permissions: readonly Permission[], document = false): ApiAuthorization => ({ requiredPermissions: permissions, conditionalPermissionRules: [], stepUpRequired: false, conditions: ["authenticated active session", ...(document ? ["document revisions retain explicit publication evidence and immutable approved content; current department access is required" as const] : ["metrics and report rows are filtered by current underlying object authorization before counting or downloading" as const])] });
export const hospitalCollaborationAuthorization: Readonly<Record<string, ApiAuthorization>> = {
  listHospitalReports: authorization(["hospital_report.view"]), createHospitalReport: authorization(["hospital_report.manage", "hospital_metric.view"]), updateHospitalReport: authorization(["hospital_report.manage", "hospital_metric.view"]), listHospitalReportJobs: authorization(["hospital_report.export"]), createHospitalReportJob: authorization(["hospital_report.export", "hospital_report.view", "hospital_metric.view"]), getHospitalReportJob: authorization(["hospital_report.export", "hospital_report.view"]), retryHospitalReportJob: authorization(["hospital_report.export", "hospital_report.view"]), downloadHospitalReportJob: authorization(["hospital_report.export", "hospital_report.view", "hospital_metric.view"]),
  getHospitalDocumentOptions: { ...authorization([], true), anyOfPermissions: ["hospital_document.create", "hospital_document.update"] },
  listHospitalDocuments: authorization(["hospital_document.view"], true), getHospitalDocument: authorization(["hospital_document.view"], true), getHospitalDocumentHistory: authorization(["hospital_document.view"], true), createHospitalDocument: authorization(["hospital_document.create"], true),
  ...Object.fromEntries(documentCommands.map(([, , operationId, , permission]) => [operationId, authorization([permission], true)])),
  getHospitalPlannerMetrics: authorization(["hospital_metric.view"]), listHospitalMetricRows: authorization(["hospital_metric.view"])
};
export const hospitalCollaborationErrors: Readonly<Record<string, readonly number[]>> = Object.fromEntries(hospitalCollaborationOperations.map((operation) => [operation.operationId, operation.errorStatuses]));
