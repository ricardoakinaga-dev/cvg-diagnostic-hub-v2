import type { Permission } from "@cvg/contracts";
import { hospitalWorkSuccessSchemas } from "./api-hospital-work-success";
import { hospitalExternalSuccessSchemas } from "./api-hospital-external-success";

export type ApiMethod = "DELETE" | "GET" | "PATCH" | "POST" | "PUT";
export type ApiAuthentication = "public" | "session";
export type ApiMediaType = "application/json" | "application/pdf" | "image/jpeg" | "image/png" | "text/event-stream" | "text/plain";
export type ApiRequestHeaderName = "x-correlation-id" | "x-csrf-token" | "idempotency-key" | "if-match" | "last-event-id" | "x-duplicate-override" | "x-hub-signature-256" | "authorization" | "x-webhook-id" | "x-webhook-event" | "x-webhook-delivery-id" | "x-webhook-signature" | "x-webhook-timestamp" | "x-webhook-signature-version";

export const API_SUCCESS_DATA_SCHEMAS = Object.freeze({
  ...hospitalWorkSuccessSchemas,
  ...hospitalExternalSuccessSchemas,
  listHospitalReports: "HospitalReportDefinitionList", createHospitalReport: "HospitalReportDefinition", updateHospitalReport: "HospitalReportDefinition", listHospitalReportJobs: "HospitalReportJobViewList", createHospitalReportJob: "HospitalReportJobView", getHospitalReportJob: "HospitalReportJobView", retryHospitalReportJob: "HospitalReportJobView", downloadHospitalReportJob: "HospitalReportArtifact",
  getHospitalPlannerMetrics: "HospitalPlannerMetrics", listHospitalMetricRows: "HospitalMetricRowPage",
  getHospitalDocumentOptions: "HospitalDocumentOptions", listHospitalDocuments: "HospitalDocumentPage", getHospitalDocument: "HospitalDocumentView", getHospitalDocumentHistory: "HospitalDocumentRevisionList", createHospitalDocument: "HospitalDocumentView", updateHospitalDocumentMetadata: "HospitalDocumentView", updateHospitalDocumentDraft: "HospitalDocumentView", createHospitalDocumentRevision: "HospitalDocumentView", approveHospitalDocument: "HospitalDocumentView", retireHospitalDocument: "HospitalDocumentView", lockHospitalDocument: "HospitalDocumentView", archiveHospitalDocument: "HospitalDocumentView", duplicateHospitalDocument: "HospitalDocumentView",
  getAdmissionContextOptions: "AdmissionContextOptions",
  listHospitalPlannerOptions: "HospitalPlannerOptions",
  listHospitalPlans: "HospitalPlanPage", getHospitalPlan: "HospitalPlanView", createHospitalPlan: "HospitalPlanView", updateHospitalPlan: "HospitalPlanView", putHospitalPlanLink: "HospitalPlanView", commandHospitalPlan: "HospitalPlanView",
  listHospitalShifts: "HospitalShiftPage", getHospitalShift: "HospitalShiftView", createHospitalShift: "HospitalShiftView", updateHospitalShift: "HospitalShiftView", assignHospitalActivityShift: "HospitalActivityShiftResult", listHospitalHandoffs: "HospitalHandoffPage", offerHospitalHandoff: "HospitalHandoffView", decideHospitalHandoff: "HospitalHandoffView",
  listHospitalChecklistTemplates: "HospitalChecklistTemplatePage", createHospitalChecklistTemplate: "HospitalChecklistTemplateView", updateHospitalChecklistTemplate: "HospitalChecklistTemplateView", approveHospitalChecklistTemplate: "HospitalChecklistTemplateView", retireHospitalChecklistTemplate: "HospitalChecklistTemplateView", recordHospitalChecklistStep: "HospitalTaskView", executeHospitalCare: "HospitalTaskView",
  listHospitalRecurrences: "HospitalRecurrencePage", createHospitalRecurrence: "HospitalRecurrenceView", updateHospitalRecurrence: "HospitalRecurrenceView", generateHospitalRecurrences: "HospitalRecurrenceGenerationReport",
  getHospitalResourceOptions: "HospitalResourceOptions", listHospitalResources: "HospitalResourcePage", getHospitalResource: "HospitalResource", createHospitalResource: "HospitalResource", updateHospitalResource: "HospitalResource",
  listHospitalCalendar: "HospitalCalendarPage", reserveHospitalTaskSchedule: "HospitalSchedule", rescheduleHospitalTaskSchedule: "HospitalScheduleRescheduleResult", cancelHospitalTaskSchedule: "HospitalSchedule", getBedCensus: "HospitalBedCensus", getHospitalCapacity: "HospitalCapacityView",
  listHospitalTaskTypes: "HospitalTaskTypeList", createHospitalTaskType: "HospitalTaskType", updateHospitalTaskType: "HospitalTaskType",
  listHospitalTaskOptions: "HospitalTaskOptions", listHospitalTasks: "HospitalTaskPage", getHospitalTask: "HospitalTaskView", getHospitalTaskHistory: "TimelineEventList", createHospitalTask: "HospitalTaskView", updateHospitalTask: "HospitalTaskView", updateHospitalTaskContext: "HospitalTaskView", assignHospitalTask: "HospitalTaskView", reprioritizeHospitalTask: "HospitalTaskView", commandHospitalTask: "HospitalTaskView", putHospitalTaskDependency: "HospitalTaskView",
  getHospitalIntakeOptions: "HospitalIntakeOptions", listHospitalIntakes: "HospitalIntakePage", createHospitalIntake: "HospitalIntakeView", triageHospitalIntake: "HospitalIntakeView", searchPlanner: "PlannerSearchPage",
  listPlannerViews: "SavedPlannerViewList", createPlannerView: "SavedPlannerView", updatePlannerView: "SavedPlannerView", deactivatePlannerView: "SavedPlannerView",
  listHospitalServices: "HospitalServiceCatalogPage", getHospitalService: "HospitalServiceCatalogEntry", createHospitalService: "HospitalService", updateHospitalService: "HospitalService", importHospitalServices: "HospitalServiceImportReport",
  listDiagnosticItemAssignees: "DiagnosticAssigneeList", assignDiagnosticItem: "ItemCommandResult", planDiagnosticItem: "ItemCommandResult", reprioritizeDiagnosticItem: "ItemCommandResult",
  listDelegablePermissions: "PermissionList",
  listExamDefinitions: "ExamDefinitionVersionList", prepareExamTemplate: "DiagnosticService", publishExamTemplate: "DiagnosticService", retireExamTemplate: "DiagnosticService",
  listAccessGroups: "AccessGroupList", createAccessGroup: "AccessGroup", updateAccessGroup: "AccessGroup", previewAccessGroupImpact: "AccessGroupImpactPreview", assignUserAccessGroup: "ManagedUser", previewUserAccess: "EffectiveAccessPreview", listPatientGrants: "PatientGrantList", changePatientGrant: "PatientGrant",
  listDepartments: "DepartmentList", getDepartment: "Department", createDepartment: "Department", updateDepartment: "Department", deactivateDepartment: "Department", setDepartmentMembers: "Department",
  getLiveness: "LivenessData",
  getReadiness: "ReadinessData",
  login: "LoginData",
  getCurrentSession: "CurrentSessionData",
  logout: "LogoutData",
  receiveWhatsAppStatus: "WhatsAppWebhookReceipt",
  reauthenticate: "ReauthenticationData",
  changeInitialPassword: "LoginData",
  changeOwnPassword: "LoginData",
  updateOwnAlertContact: "CurrentSessionData",
  listUsers: "ManagedUserList",
  listSessions: "ManagedSessionList",
  revokeSession: "ManagedSession",
  createUser: "ManagedUserCreation",
  regenerateUserPassword: "ManagedUserCreation",
  issuePasswordResetLink: "PasswordResetLinkIssued",
  completePasswordReset: "PasswordResetCompleted",
  deactivateUser: "ManagedUser",
  updateUserRole: "ManagedUser",
  updateUserOnCall: "ManagedUser",
  listDiagnosticServices: "DiagnosticServiceList",
  getResultTemplate: "DiagnosticServiceResultTemplate",
  createDiagnosticService: "DiagnosticService",
  importDiagnosticServices: "CatalogImportReport",
  updateDiagnosticService: "DiagnosticService",
  listReasonCodes: "ReasonCodeList",
  listClinicalReasons: "ReasonCodeList",
  createReasonCode: "ReasonCode",
  updateReasonCode: "ReasonCode",
  listPatients: "PatientList",
  createPatient: "PatientCreateResult",
  getPatient: "Patient",
  getPatientDiagnostics: "PatientDiagnostics",
  getPatientTimeline: "TimelineEventList",
  listPatientArchive: "ClinicalArchiveEntryList",
  getArchivedRequest: "ArchivedRequestView",
  exportPatientData: "PatientDataExport",
  listPatientEncounters: "EncounterList",
  openPatientEncounter: "EncounterOpenResult",
  closeEncounter: "EncounterCloseResult",
  getEncounter: "Encounter",
  getAdmission: "Admission",
  updateAdmissionContext: "AdmissionContextCommandResult",
  listDiagnosticRequests: "RequestViewList",
  createDiagnosticRequest: "RequestView",
  getDiagnosticRequest: "RequestView",
  cancelDiagnosticRequest: "RequestView",
  getDiagnosticItem: "ItemView",
  receiveDiagnosticItemSample: "SampleCommandResult",
  startDiagnosticItemProcessing: "ItemCommandResult",
  cancelDiagnosticItem: "ItemCommandResult",
  rejectDiagnosticItem: "ItemCommandResult",
  completeDiagnosticItem: "ItemCommandResult",
  scheduleDiagnosticItem: "ProcedureScheduleCommandResult",
  startDiagnosticItemProcedure: "ProcedureExecutionCommandResult",
  markDiagnosticItemPerformed: "ProcedureExecutionCommandResult",
  requestDiagnosticItemRecollection: "RecollectionCommandResult",
  createDiagnosticItemResult: "ResultCommandResult",
  receiveReplacementSample: "SampleCommandResult",
  getSampleLabel: "SampleLabel",
  rescheduleProcedure: "ProcedureRescheduleCommandResult",
  createAttachmentUploadSession: "AttachmentSessionResult",
  uploadAttachmentContent: "AttachmentFinalizationResult",
  finalizeAttachment: "AttachmentFinalizationResult",
  getResult: "ResultView",
  listResultVersions: "ResultVersionList",
  updateResultDraft: "ResultCommandResult",
  releaseResult: "ResultCommandResult",
  amendResult: "AmendCommandResult",
  voidResult: "VoidCommandResult",
  viewResult: "ResultViewedData",
  reviewResult: "ResultCommandResult",
  getReport: "ReportView",
  listAuditEvents: "AuditEventList",
  listNotifications: "NotificationList",
  acknowledgeNotification: "Notification",
  listQueueItems: "QueueItemList",
  searchDiagnostics: "SearchResultList",
  getTimeline: "TimelineEventList",
  getDashboard: "DashboardView",
  getManagementOverview: "ManagementOverview",
  getCriticalReadiness: "CriticalReadiness",
  listDeadLetters: "DeadLetterList",
  reprocessDeadLetter: "DeadLetterMutation",
  discardDeadLetter: "DeadLetterMutation"
} as const);

export type ApiSuccessDataSchema = (typeof API_SUCCESS_DATA_SCHEMAS)[keyof typeof API_SUCCESS_DATA_SCHEMAS];

export type ApiRequestHeader = Readonly<{
  name: ApiRequestHeaderName;
  required: boolean;
}>;

export type ApiRequestBody = Readonly<{
  mediaType: "application/json" | "application/octet-stream";
  schema: string;
  required: true;
}>;

export type ApiQueryParameter = Readonly<{
  name: string;
  required?: boolean;
  schema: string;
  style?: "form";
  explode?: boolean;
}>;

export type ApiQueryConstraints = Readonly<{
  atLeastOneOf?: ReadonlyArray<string>;
  fromMustNotExceedTo?: true;
}>;

export type ApiConcurrencyGuard = Readonly<{
  atLeastOneOf: readonly ["If-Match", "body.expectedVersion"];
  malformedHeader: "reject";
  conflictingSources: "reject";
  resourceVersion: string;
}>;

export type ApiConditionalRequestRule = Readonly<{
  when: Readonly<{ header: string; equals: string }>;
  requiredHeaders: ReadonlyArray<string>;
  requiredBodyFields: ReadonlyArray<string>;
}>;

export type ApiAuthorizationCondition =
  | "complete preview requires authority over all bound users; profile ceilings and current scopes remain mandatory"
  | "service credentials are restricted to system purpose and current actor scope; signed ingress retains native executor and result draft policies"
  | "task drafts never execute clinical commands; archive requires terminal activity and batch items each retain their own permissions, version and idempotency"
  | "private work metadata and inbox references require current owner and target access; reading an inbox never acknowledges a critical result"
  | "invitations restrict operational roles and revalidate issuer, department, group version and delegation at acceptance; raw tokens are returned once"
  | "capability configuration only denies new work and never hides or completes existing clinical obligations"
  | "document revisions retain explicit publication evidence and immutable approved content; current department access is required"
  | "metrics and report rows are filtered by current underlying object authorization before counting or downloading"
  | "inventory metadata does not grant access to patients or execution commands"
  | "resource identity is stable and active reservations and occupancy protect incompatible changes"
  | "pending activity and actual available resources are required; reservations never change SLA or clinical state"
  | "old reservation is retained canceled; conflict checks use the same schedules authority as diagnostic procedures"
  | "occupancy details require existing patient and admission access; unlinked legacy admissions do not declare beds available"
  | "capacity units and unknown availability are explicit; resources do not pause diagnostic deadlines"
  | "plan links and aggregate progress include only currently authorized activities; closing a plan does not change their workflows"
  | "shift intervals and eligible members never grant patient access or alter on-call authority"
  | "only the nominal recipient may decide a handoff; acceptance checks all target versions and current eligibility atomically"
  | "approved checklist snapshots are immutable and required steps need their prescribed evidence"
  | "recurrences use durable unique occurrences, revalidate the creator and context, and never execute care automatically"
  | "clinical execution requires explicit confirmation, an approved process and an eligible executor; the record reference is an executor declaration"
  | "continuation cursor is bound to this patient and current authorized scope"
  | "temporary password must be replaced before any operational action"
  | "current password must be confirmed; every session of the user is rotated"
  | "available only while WHATSAPP_ENABLED=true with WHATSAPP_VERIFY_TOKEN and WHATSAPP_APP_SECRET configured"
  | "X-Hub-Signature-256 must be the HMAC-SHA256 of the exact body under WHATSAPP_APP_SECRET"
  | "only the signed-in user sets their own alert number; registering it requires consent and it is only returned masked"
  | "target must be active to go on call; delegated MANAGER only changes operational-role targets in managed departments"
  | "only active reasons for clinical actions authorized in the actor department are returned"
  | "granting ADMIN or SUPERADMIN requires recent reauthentication"
  | "deactivating ADMIN or SUPERADMIN requires recent reauthentication"
  | "granting or removing ADMIN or SUPERADMIN requires recent reauthentication"
  | "regenerating an ADMIN or SUPERADMIN credential requires recent reauthentication"
  | "issuing a reset link for an ADMIN or SUPERADMIN requires recent reauthentication"
  | "exporting a data subject's records requires recent reauthentication; every export is audited"
  | "actor cannot reset self; target must be active and within managed role and department scope"
  | "authenticated active session"
  | "permission is evaluated against the actor's current role"
  | "patient access is global for SUPERADMIN; otherwise limited to patient scope or an authorized service/request context"
  | "request access is global for SUPERADMIN; otherwise limited to patient scope, executor department context, or a manager delegated department"
  | "departmentCode is unrestricted for SUPERADMIN; otherwise must match the actor department or a manager delegated department"
  | "serviceCode must be assigned to executor roles"
  | "draft ownerId must equal the actor id"
  | "executor actors may amend or void only their own released result; managers use department-scoped policy"
  | "includeInactive=true requires a catalog write command instead of service.catalog.view"
  | "MANAGER catalog visibility is limited to delegated departments"
  | "x-duplicate-override=true additionally requires request.duplicate_override"
  | "the result state selects result.view or result.draft.edit_own"
  | "the result state selects result.view or result.draft.edit_own and attachment.view is always required"
  | "only notifications whose result or request the actor can still open are listed"
  | "notification must belong to the actor and its result or request stay open to them; a manager may use authorized request context"
  | "role must be MANAGER or SUPERADMIN"
  | "patient must be active and have no open encounter"
  | "encounter must be OPEN; pending diagnostic items stay with the requester"
  | "delegated MANAGER only sees operational-role targets in managed departments"
  | "delegated MANAGER only creates operational-role targets in managed departments"
  | "actor cannot update self; delegated MANAGER must manage both current and proposed target role and department"
  | "actor cannot deactivate self; delegated MANAGER only deactivates operational-role targets in managed departments"
  | "delegated MANAGER only revokes sessions for operational-role targets in managed departments"
  | "only SUPERADMIN may manage SUPERADMIN users"
  | "role must be ADMIN or SUPERADMIN"
  | "download is limited to released or superseded results and a finalized CLEAN attachment"
  | "hospital activity requires own or delegated department and existing clinical access when linked to a patient; assignment never supplies patient access"
  | "only the responsible professional or execution team may execute; manager and superadmin retain scoped operation rights"
  | "dependencies are checked atomically for the requested command; completing a task never completes diagnostic work"
  | "context changes require PENDING, old and new clinical scope and eligible team; related tasks must be reconciled first"
  | "intake acceptance is idempotent and references diagnostic authority without executing clinical transitions"
  | "current authorized triage sectors; only currently configured institutional approval metadata, without patients or granted access"
  | "private view mutations require ownership; sharing requires an authorized department and never grants clinical data access"
  | "assignment requires an active eligible executor; assignment never changes draft ownership or grants patient access"
  | "executor may only plan their assigned item; planning dates are not a reservation or SLA clock"
  | "item priority requires a reason and recalculates dueAt from the original clock and frozen policy; it never changes result criticality or workflow"
  | "current and destination departments must remain inside manager delegation and responsibility never grants patient scope";

export type ApiConditionalPermissionPredicate =
  | "user invitation is issued or accepted"
  | "invitation binds an access group"
  | "resource metadata is updated"
  | "resource activation changes"
  | "plan command is CLOSE"
  | "plan command is ARCHIVE"
  | "shift target is HOSPITAL_TASK"
  | "shift target is DIAGNOSTIC_ITEM"
  | "versionId is omitted and current result version status is DRAFT and draft ownerId equals the actor id"
  | "versionId is omitted and current result version status is RELEASED"
  | "versionId selects a RELEASED, SUPERSEDED or VOIDED historical version of this result; response is read-only"
  | "intake accepts a manual demand by creating a task"
  | "intake accepts a manual demand by linking a task"
  | "intake accepts a diagnostic demand"
  | "intake marks a duplicate demand"
  | "hospital activity is linked to a patient"
  | "view configuration is shared with a department"
  | "active is false"
  | "access group metadata is present or active is not false"
  | "catalog metadata is present or active is not false"
  | "an import row creates a service"
  | "an import row updates metadata or reactivates a service"
  | "an import row deactivates a service"
  | "includeInactive is false or omitted"
  | "includeInactive is true"
  | "x-duplicate-override is true"
  | "current result version status is DRAFT and draft ownerId equals the actor id"
  | "current result version status is RELEASED";

export type ApiConditionalPermissionRule = Readonly<{
  when: ApiConditionalPermissionPredicate;
  allOf: ReadonlyArray<Permission>;
  anyOf?: ReadonlyArray<Permission>;
}>;

export type ApiAuthorization = Readonly<{
  anyOfPermissions?: ReadonlyArray<Permission>;
  requiredPermissions: ReadonlyArray<Permission>;
  conditionalPermissionRules: ReadonlyArray<ApiConditionalPermissionRule>;
  conditions: ReadonlyArray<ApiAuthorizationCondition>;
  stepUpRequired: boolean;
}>;

export type ApiOperation = Readonly<{
  method: ApiMethod;
  path: `/${string}`;
  operationId: string;
  summary: string;
  tag: string;
  authentication: ApiAuthentication;
  authorization: ApiAuthorization;
  csrf: boolean;
  requestHeaders: ReadonlyArray<ApiRequestHeader>;
  requestBody?: ApiRequestBody;
  concurrencyGuard?: ApiConcurrencyGuard;
  conditionalRequestRules?: ReadonlyArray<ApiConditionalRequestRule>;
  queryParameters?: ReadonlyArray<ApiQueryParameter>;
  queryConstraints?: ApiQueryConstraints;
  successStatuses: ReadonlyArray<number>;
  successMediaTypes: ReadonlyArray<ApiMediaType>;
  successDataSchema?: ApiSuccessDataSchema;
  successHeaders: ReadonlyArray<string>;
  errorStatuses: ReadonlyArray<number>;
  /** An alternative to the session: the Prometheus bearer token on GET /metrics (PROD-511). */
  serviceTokenScheme?: "metricsBearer";
  integrationTokenScheme?: "integrationBearer" | "hisV4WebhookSignature";
}>;

export type ApiOperationDraft = Omit<ApiOperation, "authorization">;
