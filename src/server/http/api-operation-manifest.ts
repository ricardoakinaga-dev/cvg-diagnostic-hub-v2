import type { Permission } from "@cvg/contracts";

export type ApiMethod = "DELETE" | "GET" | "PATCH" | "POST" | "PUT";
export type ApiAuthentication = "public" | "session";
export type ApiMediaType = "application/json" | "application/pdf" | "image/jpeg" | "image/png" | "text/event-stream" | "text/plain";
export type ApiRequestHeaderName = "x-correlation-id" | "x-csrf-token" | "idempotency-key" | "if-match" | "last-event-id" | "x-duplicate-override" | "x-hub-signature-256";

export const API_SUCCESS_DATA_SCHEMAS = Object.freeze({
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
  listPatientArchive: "ClinicalArchiveEntryList",
  getArchivedRequest: "ArchivedRequestView",
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
  | "temporary password must be replaced before any operational action"
  | "current password must be confirmed; every session of the user is rotated"
  | "available only while WHATSAPP_ENABLED=true with WHATSAPP_VERIFY_TOKEN and WHATSAPP_APP_SECRET configured"
  | "X-Hub-Signature-256 must be the HMAC-SHA256 of the exact body under WHATSAPP_APP_SECRET"
  | "only the signed-in user sets their own alert number; registering it requires consent and it is only returned masked"
  | "target must be active to go on call; delegated MANAGER only changes operational-role targets in managed departments"
  | "only active reasons for clinical actions authorized in the actor department are returned"
  | "granting ADMIN requires recent reauthentication"
  | "deactivating ADMIN requires recent reauthentication"
  | "granting or removing ADMIN requires recent reauthentication"
  | "regenerating an ADMIN credential requires recent reauthentication"
  | "issuing a reset link for an ADMIN requires recent reauthentication"
  | "actor cannot reset self; target must be active and within managed role and department scope"
  | "authenticated active session"
  | "permission is evaluated against the actor's current role"
  | "patient access is limited to the actor's patient scope or an authorized service/request context"
  | "request access is limited to patient scope, executor department context, or a manager delegated department"
  | "departmentCode must match the actor department or a manager delegated department"
  | "serviceCode must be assigned to executor roles"
  | "draft ownerId must equal the actor id"
  | "executor actors may amend or void only their own released result; managers use department-scoped policy"
  | "includeInactive=true substitutes service.catalog.manage for service.catalog.view"
  | "MANAGER catalog visibility is limited to delegated departments"
  | "x-duplicate-override=true additionally requires request.duplicate_override"
  | "the result state selects result.view or result.draft.edit_own"
  | "the result state selects result.view or result.draft.edit_own and attachment.view is always required"
  | "notification must belong to the actor; a manager may use authorized request context"
  | "role must be MANAGER"
  | "patient must be active and have no open encounter"
  | "encounter must be OPEN; pending diagnostic items stay with the requester"
  | "delegated MANAGER only sees operational-role targets in managed departments"
  | "delegated MANAGER only creates operational-role targets in managed departments"
  | "actor cannot update self; delegated MANAGER must manage both current and proposed target role and department"
  | "actor cannot deactivate self; delegated MANAGER only deactivates operational-role targets in managed departments"
  | "delegated MANAGER only revokes sessions for operational-role targets in managed departments"
  | "role must be ADMIN"
  | "download is limited to released or superseded results and a finalized CLEAN attachment"
  | "current and destination departments must remain inside manager delegation and responsibility never grants patient scope";

export type ApiConditionalPermissionPredicate =
  | "includeInactive is false or omitted"
  | "includeInactive is true"
  | "x-duplicate-override is true"
  | "current result version status is DRAFT and draft ownerId equals the actor id"
  | "current result version status is RELEASED";

export type ApiConditionalPermissionRule = Readonly<{
  when: ApiConditionalPermissionPredicate;
  allOf: ReadonlyArray<Permission>;
}>;

export type ApiAuthorization = Readonly<{
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
}>;

type ApiOperationDraft = Omit<ApiOperation, "authorization">;

const CORRELATION = { name: "x-correlation-id", required: false } as const;
const CSRF = { name: "x-csrf-token", required: true } as const;
const IDEMPOTENCY = { name: "idempotency-key", required: false } as const;
const IDEMPOTENCY_REQUIRED = { name: "idempotency-key", required: true } as const;
const IF_MATCH = { name: "if-match", required: false } as const;
const LAST_EVENT_ID = { name: "last-event-id", required: false } as const;
const DUPLICATE_OVERRIDE = { name: "x-duplicate-override", required: false } as const;
const HUB_SIGNATURE = { name: "x-hub-signature-256", required: true } as const;

const PUBLIC_READ_ERRORS = [429, 500] as const;
const PUBLIC_COMMAND_ERRORS = [400, 401, 429, 500] as const;
const PUBLIC_JSON_COMMAND_ERRORS = [400, 401, 415, 429, 500] as const;
const READ_ERRORS = [400, 401, 403, 404, 429, 500] as const;
const COMMAND_ERRORS = [400, 401, 403, 404, 409, 429, 500] as const;
const JSON_COMMAND_ERRORS = [400, 401, 403, 404, 409, 415, 429, 500] as const;
const JSON_COMMAND_WITH_POLICY_ERRORS = [400, 401, 403, 404, 409, 415, 422, 429, 500] as const;

const jsonBody = (schema: string): ApiRequestBody => Object.freeze({ mediaType: "application/json", schema, required: true });
const binaryBody = (schema: string): ApiRequestBody => Object.freeze({ mediaType: "application/octet-stream", schema, required: true });

const read = (
  path: `/${string}`,
  operationId: string,
  summary: string,
  tag: string,
  options: Readonly<{
    authentication?: ApiAuthentication;
    queryParameters?: ReadonlyArray<ApiQueryParameter>;
    queryConstraints?: ApiQueryConstraints;
    requestHeaders?: ReadonlyArray<ApiRequestHeader>;
    successMediaTypes?: ReadonlyArray<ApiMediaType>;
    successHeaders?: ReadonlyArray<string>;
    errorStatuses?: ReadonlyArray<number>;
    serviceTokenScheme?: "metricsBearer";
  }> = {}
): ApiOperationDraft => Object.freeze({
  method: "GET",
  path,
  operationId,
  summary,
  tag,
  authentication: options.authentication ?? "session",
  csrf: false,
  requestHeaders: Object.freeze([CORRELATION, ...(options.requestHeaders ?? [])]),
  ...(options.queryParameters ? { queryParameters: Object.freeze([...options.queryParameters]) } : {}),
  ...(options.queryConstraints ? { queryConstraints: Object.freeze({
    ...(options.queryConstraints.atLeastOneOf ? { atLeastOneOf: Object.freeze([...options.queryConstraints.atLeastOneOf]) } : {}),
    ...(options.queryConstraints.fromMustNotExceedTo ? { fromMustNotExceedTo: true as const } : {})
  }) } : {}),
  successStatuses: Object.freeze([200]),
  successMediaTypes: Object.freeze([...(options.successMediaTypes ?? ["application/json"])]),
  successHeaders: Object.freeze([...(options.successHeaders ?? ["x-correlation-id", "cache-control"])]),
  errorStatuses: Object.freeze([...(options.errorStatuses ?? READ_ERRORS)]),
  ...(options.serviceTokenScheme ? { serviceTokenScheme: options.serviceTokenScheme } : {})
});

const command = (
  method: Exclude<ApiMethod, "GET">,
  path: `/${string}`,
  operationId: string,
  summary: string,
  tag: string,
  requestBody: ApiRequestBody | undefined,
  options: Readonly<{
    authentication?: ApiAuthentication;
    headers?: ReadonlyArray<ApiRequestHeader>;
    successHeaders?: ReadonlyArray<string>;
    successStatus?: 200 | 201;
    errorStatuses?: ReadonlyArray<number>;
    conditionalRequestRules?: ReadonlyArray<ApiConditionalRequestRule>;
    concurrencyResource?: string;
  }> = {}
): ApiOperationDraft => {
  const authentication = options.authentication ?? "session";
  const csrf = authentication === "session";
  const defaultErrors = authentication === "public"
    ? requestBody?.mediaType === "application/json" ? PUBLIC_JSON_COMMAND_ERRORS : PUBLIC_COMMAND_ERRORS
    : requestBody?.mediaType === "application/json" ? JSON_COMMAND_ERRORS : COMMAND_ERRORS;
  const requestHeaders = [CORRELATION, ...(csrf ? [CSRF] : []), ...(options.headers ?? [])] as const;
  const hasConcurrencyGuard = requestHeaders.some((header) => header.name === "if-match");
  if (hasConcurrencyGuard && !options.concurrencyResource) throw new Error(`${method} ${path} is missing its concurrency resource.`);
  return Object.freeze({
    method,
    path,
    operationId,
    summary,
    tag,
    authentication,
    csrf,
    requestHeaders: Object.freeze([...requestHeaders]),
    ...(requestBody ? { requestBody } : {}),
    ...(hasConcurrencyGuard ? { concurrencyGuard: Object.freeze({
      atLeastOneOf: Object.freeze(["If-Match", "body.expectedVersion"] as const),
      malformedHeader: "reject" as const,
      conflictingSources: "reject" as const,
      resourceVersion: options.concurrencyResource!
    }) } : {}),
    ...(options.conditionalRequestRules ? { conditionalRequestRules: Object.freeze(options.conditionalRequestRules.map((rule) => Object.freeze({
      when: Object.freeze({ ...rule.when }),
      requiredHeaders: Object.freeze([...rule.requiredHeaders]),
      requiredBodyFields: Object.freeze([...rule.requiredBodyFields])
    }))) } : {}),
    successStatuses: Object.freeze([options.successStatus ?? 200]),
    successMediaTypes: Object.freeze(["application/json"] as const),
    successHeaders: Object.freeze([...(options.successHeaders ?? ["x-correlation-id", "cache-control"])]),
    errorStatuses: Object.freeze([...(options.errorStatuses ?? defaultErrors)])
  });
};

const pagination = [
  { name: "cursor", schema: "Cursor" },
  { name: "limit", schema: "Limit" }
] as const;

const operations: ReadonlyArray<ApiOperationDraft> = [
  read("/livez", "getLiveness", "Check process liveness", "Health", { authentication: "public", errorStatuses: PUBLIC_READ_ERRORS }),
  read("/readyz", "getReadiness", "Check dependency readiness", "Health", { authentication: "public", errorStatuses: [429, 500, 503] }),
  read("/metrics", "getMetrics", "Read Prometheus metrics", "Observability", { successMediaTypes: ["text/plain"], errorStatuses: [401, 404, 429, 500], serviceTokenScheme: "metricsBearer" }),

  command("POST", "/session/login", "login", "Create an authenticated session", "Session", jsonBody("LoginRequest"), { authentication: "public", successHeaders: ["x-correlation-id", "cache-control", "set-cookie"] }),
  read("/session/me", "getCurrentSession", "Read the current session", "Session", { errorStatuses: [401, 429, 500] }),
  command("POST", "/session/logout", "logout", "Revoke the current session", "Session", undefined, { successHeaders: ["x-correlation-id", "cache-control", "set-cookie"], errorStatuses: [401, 403, 429, 500] }),
  command("POST", "/session/reauth", "reauthenticate", "Refresh privileged-action authentication", "Session", jsonBody("ReauthenticationRequest"), { errorStatuses: [400, 401, 403, 415, 429, 500] }),
  command("POST", "/session/password", "changeInitialPassword", "Replace a temporary password and rotate sessions", "Session", jsonBody("InitialPasswordRequest"), { successHeaders: ["x-correlation-id", "cache-control", "set-cookie"] }),
  command("POST", "/session/password/reset", "completePasswordReset", "Complete an administrator-issued password reset with a one-time token", "Session", jsonBody("PasswordResetCompletion"), { authentication: "public" }),
  command("POST", "/session/password/change", "changeOwnPassword", "Change the signed-in user's password and rotate sessions", "Session", jsonBody("PasswordChangeRequest"), { successHeaders: ["x-correlation-id", "cache-control", "set-cookie"] }),
  command("PUT", "/session/alert-contact", "updateOwnAlertContact", "Register or remove the signed-in user's WhatsApp number for critical-result alerts", "Session", jsonBody("AlertContactUpdate"), { errorStatuses: [400, 401, 403, 415, 429, 500] }),

  read("/users", "listUsers", "List managed users", "Administration"),
  read("/sessions", "listSessions", "List managed sessions", "Administration"),
  command("POST", "/users", "createUser", "Create a managed user", "Administration", jsonBody("ManagedUserCreate"), { headers: [IDEMPOTENCY_REQUIRED], successStatus: 201 }),
  command("DELETE", "/users/{userId}", "deactivateUser", "Deactivate a managed user", "Administration", jsonBody("ManagedUserDeactivate"), { headers: [IDEMPOTENCY_REQUIRED, IF_MATCH], concurrencyResource: "managedUser.version" }),
  command("POST", "/users/{userId}/roles", "updateUserRole", "Update a managed user's role", "Administration", jsonBody("UserRoleUpdate"), { headers: [IDEMPOTENCY_REQUIRED, IF_MATCH], concurrencyResource: "managedUser.version" }),
  command("PUT", "/users/{userId}/on-call", "updateUserOnCall", "Mark or unmark a managed user as on call for critical-result escalation", "Administration", jsonBody("UserOnCallUpdate"), { headers: [IDEMPOTENCY_REQUIRED, IF_MATCH], concurrencyResource: "managedUser.version" }),
  command("POST", "/users/{userId}/password", "regenerateUserPassword", "Generate a one-time temporary password and revoke target sessions", "Administration", jsonBody("ManagedUserPasswordReset"), { headers: [IDEMPOTENCY_REQUIRED, IF_MATCH], concurrencyResource: "managedUser.version" }),
  command("POST", "/users/{userId}/password-reset-link", "issuePasswordResetLink", "Issue a one-time password reset link and revoke target sessions", "Administration", jsonBody("PasswordResetLinkRequest"), { headers: [IDEMPOTENCY_REQUIRED, IF_MATCH], concurrencyResource: "managedUser.version", successStatus: 201 }),
  command("POST", "/sessions/{sessionId}/revoke", "revokeSession", "Revoke a managed session", "Administration", jsonBody("SessionRevoke"), { headers: [IDEMPOTENCY_REQUIRED], errorStatuses: [400, 401, 403, 404, 409, 415, 429, 500] }),

  read("/diagnostic-services", "listDiagnosticServices", "List diagnostic services", "Catalog", { queryParameters: [{ name: "includeInactive", schema: "Boolean" }] }),
  read("/diagnostic-services/{serviceId}/result-template", "getResultTemplate", "Read the configured laboratory result template", "Catalog"),
  command("POST", "/diagnostic-services", "createDiagnosticService", "Create a diagnostic service", "Catalog", jsonBody("DiagnosticServiceCreate"), { headers: [IDEMPOTENCY], successStatus: 201 }),
  command("POST", "/diagnostic-services/import", "importDiagnosticServices", "Validate or apply a catalog import sheet", "Catalog", jsonBody("CatalogImportRequest"), { headers: [IDEMPOTENCY_REQUIRED] }),
  command("PATCH", "/diagnostic-services/{serviceId}", "updateDiagnosticService", "Update a diagnostic service", "Catalog", jsonBody("DiagnosticServicePatch"), { headers: [IDEMPOTENCY, IF_MATCH], concurrencyResource: "diagnosticService.version" }),
  read("/reason-codes", "listReasonCodes", "List reason codes", "Catalog"),
  read("/clinical-reasons", "listClinicalReasons", "List active reasons for authorized clinical actions", "Catalog"),
  command("POST", "/reason-codes", "createReasonCode", "Create a reason code", "Catalog", jsonBody("ReasonCodeCreate"), { headers: [IDEMPOTENCY], successStatus: 201 }),
  command("PATCH", "/reason-codes/{reasonCodeId}", "updateReasonCode", "Update a reason code", "Catalog", jsonBody("ReasonCodePatch"), { headers: [IDEMPOTENCY, IF_MATCH], concurrencyResource: "reasonCode.version" }),

  read("/patients", "listPatients", "Search patients", "Patients", { queryParameters: [{ name: "q", schema: "PatientQuery" }] }),
  command("POST", "/patients", "createPatient", "Register a patient and initial encounter", "Patients", jsonBody("PatientCreate"), { headers: [IDEMPOTENCY_REQUIRED], successStatus: 201 }),
  read("/patients/{patientId}", "getPatient", "Read a patient", "Patients"),
  read("/patients/{patientId}/diagnostics", "getPatientDiagnostics", "List a patient's diagnostics", "Patients", { queryParameters: pagination }),
  read("/patients/{patientId}/archive", "listPatientArchive", "List a patient's archived diagnostics", "Patients", { queryParameters: [{ name: "limit", schema: "Limit" }] }),
  read("/archive/requests/{requestId}", "getArchivedRequest", "Read an archived diagnostic request (read-only)", "Patients"),
  read("/patients/{patientId}/encounters", "listPatientEncounters", "List a patient's encounters", "Patients"),
  command("POST", "/patients/{patientId}/encounters", "openPatientEncounter", "Open a new encounter for a registered patient", "Patients", jsonBody("EncounterOpen"), { headers: [IDEMPOTENCY_REQUIRED], successStatus: 201 }),
  read("/encounters/{encounterId}", "getEncounter", "Read an encounter", "Patients"),
  command("POST", "/encounters/{encounterId}/close", "closeEncounter", "Close an open encounter without cancelling pending exams", "Patients", jsonBody("EncounterClose"), { headers: [IDEMPOTENCY_REQUIRED] }),
  read("/admissions/{admissionId}", "getAdmission", "Read an admission", "Patients"),
  command("POST", "/admissions/{admissionId}/context", "updateAdmissionContext", "Apply an approved admission context transition", "Patients", jsonBody("AdmissionContextCommand"), {
    headers: [IDEMPOTENCY_REQUIRED, IF_MATCH],
    concurrencyResource: "admission.version",
    errorStatuses: [400, 401, 403, 404, 409, 415, 422, 429, 500, 503]
  }),

  read("/diagnostic-requests", "listDiagnosticRequests", "List diagnostic requests", "Diagnostics", { queryParameters: [
    { name: "status", schema: "ItemState" }, { name: "departmentCode", schema: "DepartmentCode" },
    { name: "departmentId", schema: "DepartmentCode" }, { name: "priority", schema: "Priority" },
    { name: "serviceId", schema: "ServiceIdentifier" }, { name: "overdue", schema: "Boolean" },
    { name: "from", schema: "DateTime" }, { name: "to", schema: "DateTime" }, ...pagination
  ], queryConstraints: { fromMustNotExceedTo: true } }),
  command("POST", "/diagnostic-requests", "createDiagnosticRequest", "Create a diagnostic request", "Diagnostics", jsonBody("DiagnosticRequestCreate"), {
    headers: [IDEMPOTENCY, DUPLICATE_OVERRIDE],
    successStatus: 201,
    conditionalRequestRules: [{
      when: { header: "X-Duplicate-Override", equals: "true" },
      requiredHeaders: ["Idempotency-Key"],
      requiredBodyFields: ["overrideReason"]
    }]
  }),
  read("/diagnostic-requests/{requestId}", "getDiagnosticRequest", "Read a diagnostic request", "Diagnostics"),
  command("POST", "/diagnostic-requests/{requestId}/cancel", "cancelDiagnosticRequest", "Cancel a diagnostic request", "Diagnostics", jsonBody("CancelCommand"), { headers: [IDEMPOTENCY_REQUIRED, IF_MATCH], concurrencyResource: "diagnosticRequest.version" }),

  read("/diagnostic-items/{itemId}", "getDiagnosticItem", "Read a diagnostic item", "Diagnostics"),
  command("POST", "/diagnostic-items/{itemId}/receive-sample", "receiveDiagnosticItemSample", "Receive a diagnostic item sample", "Diagnostics", jsonBody("SampleCommand"), { headers: [IDEMPOTENCY, IF_MATCH], concurrencyResource: "diagnosticItem.version" }),
  command("POST", "/diagnostic-items/{itemId}/start-processing", "startDiagnosticItemProcessing", "Start diagnostic item processing", "Diagnostics", jsonBody("VersionCommand"), { headers: [IDEMPOTENCY, IF_MATCH], concurrencyResource: "diagnosticItem.version" }),
  command("POST", "/diagnostic-items/{itemId}/cancel", "cancelDiagnosticItem", "Cancel a diagnostic item", "Diagnostics", jsonBody("CancelCommand"), { headers: [IDEMPOTENCY_REQUIRED, IF_MATCH], concurrencyResource: "diagnosticItem.version" }),
  command("POST", "/diagnostic-items/{itemId}/reject", "rejectDiagnosticItem", "Reject a diagnostic item", "Diagnostics", jsonBody("RejectCommand"), { headers: [IDEMPOTENCY_REQUIRED, IF_MATCH], concurrencyResource: "diagnosticItem.version" }),
  command("POST", "/diagnostic-items/{itemId}/complete", "completeDiagnosticItem", "Complete a diagnostic item", "Diagnostics", jsonBody("VersionCommand"), { headers: [IDEMPOTENCY_REQUIRED, IF_MATCH], concurrencyResource: "diagnosticItem.version" }),
  command("POST", "/diagnostic-items/{itemId}/schedule", "scheduleDiagnosticItem", "Schedule a diagnostic item procedure", "Diagnostics", jsonBody("ScheduleCommand"), { headers: [IDEMPOTENCY, IF_MATCH], concurrencyResource: "diagnosticItem.version" }),
  command("POST", "/diagnostic-items/{itemId}/start-procedure", "startDiagnosticItemProcedure", "Start a diagnostic item procedure", "Diagnostics", jsonBody("VersionCommand"), { headers: [IDEMPOTENCY, IF_MATCH], concurrencyResource: "diagnosticItem.version" }),
  command("POST", "/diagnostic-items/{itemId}/mark-performed", "markDiagnosticItemPerformed", "Mark a diagnostic item procedure as performed", "Diagnostics", jsonBody("VersionCommand"), { headers: [IDEMPOTENCY, IF_MATCH], concurrencyResource: "diagnosticItem.version" }),
  command("POST", "/diagnostic-items/{itemId}/request-recollection", "requestDiagnosticItemRecollection", "Request recollection for a diagnostic item", "Diagnostics", jsonBody("RecollectionCommand"), { headers: [IDEMPOTENCY_REQUIRED, IF_MATCH], concurrencyResource: "diagnosticItem.version" }),
  command("POST", "/diagnostic-items/{itemId}/results", "createDiagnosticItemResult", "Create a result draft for a diagnostic item", "Results", jsonBody("ResultDraftCommand"), { headers: [IDEMPOTENCY, IF_MATCH], concurrencyResource: "diagnosticItem.version", successStatus: 201, errorStatuses: JSON_COMMAND_WITH_POLICY_ERRORS }),

  read("/samples/{sampleId}/label", "getSampleLabel", "Read the printable label of a sample", "Diagnostics"),
  command("POST", "/samples/{sampleId}/receive-replacement", "receiveReplacementSample", "Receive a replacement sample", "Diagnostics", jsonBody("SampleCommand"), { headers: [IDEMPOTENCY_REQUIRED, IF_MATCH], concurrencyResource: "linkedDiagnosticItem.version" }),
  command("POST", "/procedures/{procedureId}/reschedule", "rescheduleProcedure", "Reschedule a procedure", "Diagnostics", jsonBody("ScheduleCommand"), { headers: [IDEMPOTENCY, IF_MATCH], concurrencyResource: "procedure.version" }),

  command("POST", "/result-versions/{versionId}/attachments/upload-session", "createAttachmentUploadSession", "Create an attachment upload session", "Attachments", jsonBody("AttachmentUploadSessionRequest"), { headers: [IDEMPOTENCY_REQUIRED, IF_MATCH], concurrencyResource: "resultVersion.version", successStatus: 201 }),
  command("PUT", "/attachments/{attachmentId}/content", "uploadAttachmentContent", "Upload attachment content", "Attachments", binaryBody("AttachmentBinary")),
  command("POST", "/attachments/{attachmentId}/finalize", "finalizeAttachment", "Finalize an attachment upload", "Attachments", jsonBody("VersionCommand"), { headers: [IDEMPOTENCY_REQUIRED, IF_MATCH], concurrencyResource: "owningResultVersion.version", errorStatuses: JSON_COMMAND_WITH_POLICY_ERRORS }),
  read("/attachments/{attachmentId}/download", "downloadAttachment", "Download an attachment", "Attachments", {
    successMediaTypes: ["application/pdf", "image/jpeg", "image/png"], errorStatuses: [401, 403, 404, 429, 500, 503],
    successHeaders: ["x-correlation-id", "cache-control", "content-length", "content-disposition"]
  }),

  read("/results/{resultId}", "getResult", "Read a result", "Results"),
  read("/results/{resultId}/versions", "listResultVersions", "List result versions", "Results"),
  command("PATCH", "/results/{resultId}/draft", "updateResultDraft", "Update a result draft", "Results", jsonBody("ResultDraftCommand"), { headers: [IDEMPOTENCY, IF_MATCH], concurrencyResource: "result.version" }),
  command("POST", "/results/{resultId}/release", "releaseResult", "Release a result", "Results", jsonBody("ReleaseResultCommand"), { headers: [IDEMPOTENCY_REQUIRED, IF_MATCH], concurrencyResource: "result.version", errorStatuses: JSON_COMMAND_WITH_POLICY_ERRORS }),
  command("POST", "/results/{resultId}/amend", "amendResult", "Amend a released result", "Results", jsonBody("AmendResultCommand"), { headers: [IDEMPOTENCY_REQUIRED, IF_MATCH], concurrencyResource: "result.version" }),
  command("POST", "/results/{resultId}/void", "voidResult", "Void a result", "Results", jsonBody("VoidResultCommand"), { headers: [IDEMPOTENCY_REQUIRED, IF_MATCH], concurrencyResource: "result.version" }),
  command("POST", "/results/{resultId}/view", "viewResult", "Record a result view", "Results", jsonBody("ReviewResultCommand"), { headers: [IDEMPOTENCY_REQUIRED, IF_MATCH], concurrencyResource: "diagnosticItem.version" }),
  command("POST", "/results/{resultId}/review", "reviewResult", "Review a result", "Results", jsonBody("ReviewResultCommand"), { headers: [IDEMPOTENCY_REQUIRED, IF_MATCH], concurrencyResource: "diagnosticItem.version" }),
  read("/reports/{reportId}", "getReport", "Read a report", "Results"),

  read("/audit-events", "listAuditEvents", "List audit events", "Operations", { queryParameters: pagination }),
  read("/notifications", "listNotifications", "List notifications", "Operations", { queryParameters: [{ name: "filter", schema: "NotificationFilter" }, ...pagination] }),
  command("POST", "/notifications/{notificationId}/acknowledge", "acknowledgeNotification", "Acknowledge a notification", "Operations", jsonBody("NotificationAcknowledge"), { headers: [IDEMPOTENCY_REQUIRED, IF_MATCH], concurrencyResource: "notification.version" }),
  read("/queues/{departmentCode}/items", "listQueueItems", "List department queue items", "Operations", { queryParameters: [{ name: "status", schema: "ItemState" }, { name: "overdue", schema: "Boolean" }, ...pagination] }),
  read("/search", "searchDiagnostics", "Search diagnostic requests and items", "Operations", { queryParameters: [
    { name: "q", required: true, schema: "SearchQuery" }, { name: "types", schema: "SearchTypes" },
    { name: "status", schema: "ItemState" }, { name: "department", schema: "DepartmentCode" },
    { name: "departmentCode", schema: "DepartmentCode" }, { name: "from", schema: "DateTime" },
    { name: "to", schema: "DateTime" }, ...pagination
  ], queryConstraints: { fromMustNotExceedTo: true } }),
  read("/timeline", "getTimeline", "Read the diagnostic timeline", "Operations", {
    queryParameters: [{ name: "requestId", schema: "Identifier" }, { name: "itemId", schema: "Identifier" }, ...pagination],
    queryConstraints: { atLeastOneOf: ["requestId", "itemId"] }
  }),
  read("/dashboard", "getDashboard", "Read the operational dashboard", "Operations"),
  read("/management/overview", "getManagementOverview", "Read the management overview", "Operations"),
  read("/outbox/dead-letters", "listDeadLetters", "List outbox dead-letter messages", "Operations", { queryParameters: [{ name: "limit", schema: "Limit" }] }),
  command("POST", "/outbox/dead-letters/{messageId}/reprocess", "reprocessDeadLetter", "Reprocess an outbox dead-letter message", "Operations", jsonBody("DeadLetterCommand"), { headers: [IDEMPOTENCY_REQUIRED], errorStatuses: [400, 401, 403, 404, 409, 415, 429, 500] }),
  command("POST", "/outbox/dead-letters/{messageId}/discard", "discardDeadLetter", "Discard an outbox dead-letter message", "Operations", jsonBody("DeadLetterCommand"), { headers: [IDEMPOTENCY_REQUIRED], errorStatuses: [400, 401, 403, 404, 409, 415, 429, 500] }),
  read("/webhooks/whatsapp", "verifyWhatsAppWebhook", "Answer Meta's WhatsApp webhook verification challenge", "Webhooks", {
    authentication: "public", successMediaTypes: ["text/plain"], errorStatuses: [403, 404, 429, 500],
    queryParameters: [{ name: "hub.mode", required: true, schema: "WebhookMode" }, { name: "hub.verify_token", required: true, schema: "WebhookVerifyToken" }, { name: "hub.challenge", required: true, schema: "WebhookChallenge" }]
  }),
  command("POST", "/webhooks/whatsapp", "receiveWhatsAppStatus", "Record WhatsApp delivery reports of critical-result alerts", "Webhooks", jsonBody("WhatsAppWebhookEvent"), {
    authentication: "public", headers: [HUB_SIGNATURE], errorStatuses: [400, 401, 404, 415, 429, 500]
  }),
  read("/realtime/events", "streamRealtimeEvents", "Stream authorized realtime events", "Realtime", {
    queryParameters: [{ name: "snapshot", schema: "Boolean" }], requestHeaders: [LAST_EVENT_ID],
    successMediaTypes: ["text/event-stream"], successHeaders: ["x-correlation-id", "cache-control", "connection"],
    errorStatuses: [401, 404, 429, 500]
  })
];

const SESSION = ["authenticated active session"] as const;
const ROLE = ["authenticated active session", "permission is evaluated against the actor's current role"] as const;
const PATIENT = [...ROLE, "patient access is limited to the actor's patient scope or an authorized service/request context"] as const;
const REQUEST = [...ROLE, "request access is limited to patient scope, executor department context, or a manager delegated department"] as const;
const DEPARTMENT = [...ROLE, "departmentCode must match the actor department or a manager delegated department"] as const;
const SERVICE = [...DEPARTMENT, "serviceCode must be assigned to executor roles"] as const;
const OWNER = [...SERVICE, "draft ownerId must equal the actor id"] as const;
const RESULT_MUTATION = [...SERVICE, "executor actors may amend or void only their own released result; managers use department-scoped policy"] as const;
const RESULT_SCOPE = [...SERVICE, "patient access is limited to the actor's patient scope or an authorized service/request context"] as const;

const authorization = (
  requiredPermissions: ReadonlyArray<Permission>,
  conditions: ReadonlyArray<ApiAuthorizationCondition>,
  stepUpRequired = false,
  conditionalPermissionRules: ReadonlyArray<ApiConditionalPermissionRule> = []
): ApiAuthorization => Object.freeze({
  requiredPermissions: Object.freeze([...requiredPermissions]),
  conditionalPermissionRules: Object.freeze(conditionalPermissionRules.map((rule) => Object.freeze({
    when: rule.when,
    allOf: Object.freeze([...rule.allOf])
  }))),
  conditions: Object.freeze([...conditions]),
  stepUpRequired
});

const AUTHORIZATION_BY_OPERATION = Object.freeze({
  getLiveness: authorization([], []),
  getReadiness: authorization([], []),
  getMetrics: authorization(["health.readiness"], ROLE),
  login: authorization([], []),
  getCurrentSession: authorization([], SESSION),
  logout: authorization([], SESSION),
  reauthenticate: authorization([], SESSION),
  changeInitialPassword: authorization([], [...SESSION, "temporary password must be replaced before any operational action"]),
  changeOwnPassword: authorization([], [...SESSION, "current password must be confirmed; every session of the user is rotated"]),
  updateOwnAlertContact: authorization([], [...SESSION, "only the signed-in user sets their own alert number; registering it requires consent and it is only returned masked"]),
  listClinicalReasons: authorization([], [...ROLE, "only active reasons for clinical actions authorized in the actor department are returned"]),
  listUsers: authorization(["user_role.manage"], [...ROLE, "delegated MANAGER only sees operational-role targets in managed departments"]),
  listSessions: authorization(["user_role.manage"], [...ROLE, "role must be ADMIN"]),
  createUser: authorization(["user_role.manage"], [...ROLE, "delegated MANAGER only creates operational-role targets in managed departments", "granting ADMIN requires recent reauthentication"]),
  deactivateUser: authorization(["user_role.manage"], [...ROLE, "actor cannot deactivate self; delegated MANAGER only deactivates operational-role targets in managed departments", "deactivating ADMIN requires recent reauthentication"]),
  updateUserRole: authorization(["user_role.manage"], [...ROLE, "actor cannot update self; delegated MANAGER must manage both current and proposed target role and department", "granting or removing ADMIN requires recent reauthentication"]),
  updateUserOnCall: authorization(["user_role.manage"], [...ROLE, "target must be active to go on call; delegated MANAGER only changes operational-role targets in managed departments"]),
  regenerateUserPassword: authorization(["user_role.manage"], [...ROLE, "actor cannot reset self; target must be active and within managed role and department scope", "regenerating an ADMIN credential requires recent reauthentication"]),
  issuePasswordResetLink: authorization(["user_role.manage"], [...ROLE, "actor cannot reset self; target must be active and within managed role and department scope", "issuing a reset link for an ADMIN requires recent reauthentication"]),
  completePasswordReset: authorization([], []),
  revokeSession: authorization(["user_role.manage"], [...ROLE, "role must be ADMIN"]),
  listDiagnosticServices: authorization([], [...ROLE, "includeInactive=true substitutes service.catalog.manage for service.catalog.view", "MANAGER catalog visibility is limited to delegated departments"], false, [
    { when: "includeInactive is false or omitted", allOf: ["service.catalog.view"] },
    { when: "includeInactive is true", allOf: ["service.catalog.manage"] }
  ]),
  getResultTemplate: authorization(["service.catalog.view"], SERVICE),
  createDiagnosticService: authorization(["service.catalog.manage"], DEPARTMENT),
  updateDiagnosticService: authorization(["service.catalog.manage"], DEPARTMENT),
  importDiagnosticServices: authorization(["service.catalog.manage"], DEPARTMENT),
  listReasonCodes: authorization(["reason_code.manage"], ROLE),
  createReasonCode: authorization(["reason_code.manage"], ROLE),
  updateReasonCode: authorization(["reason_code.manage"], ROLE),
  listPatients: authorization(["patient.view"], PATIENT),
  createPatient: authorization(["patient.create"], ROLE),
  getPatient: authorization(["patient.view"], PATIENT),
  getPatientDiagnostics: authorization(["patient.view", "diagnostic.timeline.view"], PATIENT),
  listPatientArchive: authorization(["patient.view", "diagnostic.timeline.view"], PATIENT),
  getArchivedRequest: authorization(["request.view"], REQUEST),
  listPatientEncounters: authorization(["encounter.view"], PATIENT),
  openPatientEncounter: authorization(["encounter.manage"], [...PATIENT, "patient must be active and have no open encounter"]),
  closeEncounter: authorization(["encounter.manage"], [...PATIENT, "encounter must be OPEN; pending diagnostic items stay with the requester"]),
  getEncounter: authorization(["encounter.view"], PATIENT),
  getAdmission: authorization(["admission.view"], PATIENT),
  updateAdmissionContext: authorization(["admission.context.manage"], [...PATIENT, "current and destination departments must remain inside manager delegation and responsibility never grants patient scope"]),
  listDiagnosticRequests: authorization(["request.list"], REQUEST),
  createDiagnosticRequest: authorization(["request.create"], [...PATIENT, "x-duplicate-override=true additionally requires request.duplicate_override"], false, [
    { when: "x-duplicate-override is true", allOf: ["request.duplicate_override"] }
  ]),
  getDiagnosticRequest: authorization(["request.view"], REQUEST),
  cancelDiagnosticRequest: authorization(["request.cancel"], REQUEST),
  getDiagnosticItem: authorization(["item.view"], REQUEST),
  receiveDiagnosticItemSample: authorization(["sample.receive"], DEPARTMENT),
  startDiagnosticItemProcessing: authorization(["sample.process"], DEPARTMENT),
  cancelDiagnosticItem: authorization(["item.cancel"], [...DEPARTMENT, "patient access is limited to the actor's patient scope or an authorized service/request context"]),
  rejectDiagnosticItem: authorization(["item.reject"], DEPARTMENT),
  completeDiagnosticItem: authorization(["item.complete"], DEPARTMENT),
  scheduleDiagnosticItem: authorization(["procedure.schedule"], DEPARTMENT),
  startDiagnosticItemProcedure: authorization(["procedure.start"], DEPARTMENT),
  markDiagnosticItemPerformed: authorization(["procedure.mark_performed"], DEPARTMENT),
  requestDiagnosticItemRecollection: authorization(["sample.recollection.request"], DEPARTMENT),
  createDiagnosticItemResult: authorization(["result.draft.create"], SERVICE),
  receiveReplacementSample: authorization(["sample.replacement.receive"], DEPARTMENT),
  getSampleLabel: authorization(["item.view"], REQUEST),
  rescheduleProcedure: authorization(["procedure.reschedule"], DEPARTMENT),
  createAttachmentUploadSession: authorization(["attachment.upload_session"], SERVICE),
  uploadAttachmentContent: authorization(["attachment.finalize"], SERVICE),
  finalizeAttachment: authorization(["attachment.finalize"], SERVICE),
  downloadAttachment: authorization(["attachment.download", "attachment.view"], [...SERVICE, "patient access is limited to the actor's patient scope or an authorized service/request context", "download is limited to released or superseded results and a finalized CLEAN attachment"]),
  getResult: authorization([], [...RESULT_SCOPE, "the result state selects result.view or result.draft.edit_own"], false, [
    { when: "current result version status is DRAFT and draft ownerId equals the actor id", allOf: ["result.draft.edit_own"] },
    { when: "current result version status is RELEASED", allOf: ["result.view"] }
  ]),
  listResultVersions: authorization(["result.history.view"], [...SERVICE, "patient access is limited to the actor's patient scope or an authorized service/request context"]),
  updateResultDraft: authorization(["result.draft.edit_own"], OWNER),
  releaseResult: authorization(["result.release"], SERVICE),
  amendResult: authorization(["result.amend"], RESULT_MUTATION),
  voidResult: authorization(["result.void"], RESULT_MUTATION),
  viewResult: authorization(["result.view", "result.view.record"], [...SERVICE, "patient access is limited to the actor's patient scope or an authorized service/request context"]),
  reviewResult: authorization(["result.review"], [...SERVICE, "patient access is limited to the actor's patient scope or an authorized service/request context"]),
  getReport: authorization(["attachment.view"], [...RESULT_SCOPE, "the result state selects result.view or result.draft.edit_own and attachment.view is always required"], false, [
    { when: "current result version status is DRAFT and draft ownerId equals the actor id", allOf: ["result.draft.edit_own"] },
    { when: "current result version status is RELEASED", allOf: ["result.view"] }
  ]),
  listAuditEvents: authorization(["audit.view"], DEPARTMENT),
  listNotifications: authorization(["notification.view"], ROLE),
  acknowledgeNotification: authorization(["notification.view", "notification.acknowledge"], [...ROLE, "notification must belong to the actor; a manager may use authorized request context"]),
  listQueueItems: authorization(["queue.view"], DEPARTMENT),
  searchDiagnostics: authorization(["search.execute"], REQUEST),
  getTimeline: authorization(["timeline.view"], REQUEST),
  getDashboard: authorization(["dashboard.view"], DEPARTMENT),
  getManagementOverview: authorization(["dashboard.view", "user_role.manage"], [...DEPARTMENT, "role must be MANAGER"]),
  listDeadLetters: authorization(["outbox.manage"], [...ROLE, "role must be ADMIN"]),
  reprocessDeadLetter: authorization(["outbox.manage"], [...ROLE, "role must be ADMIN"]),
  discardDeadLetter: authorization(["outbox.manage"], [...ROLE, "role must be ADMIN"]),
  streamRealtimeEvents: authorization(["realtime.connect"], ROLE),
  verifyWhatsAppWebhook: authorization([], ["available only while WHATSAPP_ENABLED=true with WHATSAPP_VERIFY_TOKEN and WHATSAPP_APP_SECRET configured"]),
  receiveWhatsAppStatus: authorization([], ["available only while WHATSAPP_ENABLED=true with WHATSAPP_VERIFY_TOKEN and WHATSAPP_APP_SECRET configured", "X-Hub-Signature-256 must be the HMAC-SHA256 of the exact body under WHATSAPP_APP_SECRET"])
} satisfies Record<string, ApiAuthorization>);

const ERROR_STATUSES_BY_OPERATION = Object.freeze({
  getLiveness: [429, 500], getReadiness: [429, 500, 503], getMetrics: [401, 404, 429, 500],
  login: [400, 401, 415, 429, 500], getCurrentSession: [401, 429, 500], logout: [401, 403, 429, 500],
  changeInitialPassword: [400, 401, 403, 409, 415, 429, 500], changeOwnPassword: [400, 401, 403, 415, 429, 500], updateOwnAlertContact: [400, 401, 403, 415, 429, 500], listClinicalReasons: [401, 403, 404, 429, 500],
  reauthenticate: [400, 401, 403, 415, 429, 500], listUsers: [401, 404, 429, 500], listSessions: [401, 404, 429, 500],
  createUser: [400, 401, 403, 404, 409, 415, 429, 500], deactivateUser: [400, 401, 403, 404, 409, 415, 429, 500],
  regenerateUserPassword: [400, 401, 403, 404, 409, 415, 429, 500],
  issuePasswordResetLink: [400, 401, 403, 404, 409, 415, 429, 500],
  completePasswordReset: [400, 415, 429, 500],
  updateUserRole: [400, 401, 403, 404, 409, 415, 429, 500], updateUserOnCall: [400, 401, 403, 404, 409, 415, 429, 500], revokeSession: [400, 401, 403, 404, 409, 415, 429, 500], listDiagnosticServices: [400, 401, 404, 429, 500],
  getResultTemplate: [400, 401, 403, 404, 429, 500], createDiagnosticService: [400, 401, 403, 404, 409, 415, 429, 500], importDiagnosticServices: [400, 401, 403, 404, 409, 415, 422, 429, 500], updateDiagnosticService: [400, 401, 403, 404, 409, 415, 429, 500],
  listReasonCodes: [401, 404, 429, 500], createReasonCode: [400, 401, 403, 404, 409, 415, 429, 500],
  updateReasonCode: [400, 401, 403, 404, 409, 415, 429, 500], listPatients: [400, 401, 404, 429, 500],
  createPatient: [400, 401, 404, 409, 415, 429, 500], getPatient: [401, 404, 429, 500], getPatientDiagnostics: [400, 401, 404, 429, 500], listPatientArchive: [400, 401, 404, 429, 500], getArchivedRequest: [401, 404, 429, 500],
  listPatientEncounters: [401, 404, 429, 500], openPatientEncounter: [400, 401, 404, 409, 415, 429, 500], closeEncounter: [400, 401, 404, 409, 415, 429, 500], getEncounter: [401, 404, 429, 500], getAdmission: [401, 404, 429, 500],
  updateAdmissionContext: [400, 401, 403, 404, 409, 415, 422, 429, 500, 503],
  listDiagnosticRequests: [400, 401, 404, 429, 500], createDiagnosticRequest: [400, 401, 403, 404, 409, 415, 429, 500],
  getDiagnosticRequest: [401, 404, 429, 500], cancelDiagnosticRequest: [400, 401, 403, 404, 409, 415, 429, 500],
  getDiagnosticItem: [401, 404, 429, 500], receiveDiagnosticItemSample: [400, 401, 403, 404, 409, 415, 429, 500],
  startDiagnosticItemProcessing: [400, 401, 403, 404, 409, 415, 429, 500], cancelDiagnosticItem: [400, 401, 403, 404, 409, 415, 429, 500],
  rejectDiagnosticItem: [400, 401, 403, 404, 409, 415, 429, 500], completeDiagnosticItem: [400, 401, 403, 404, 409, 415, 429, 500],
  scheduleDiagnosticItem: [400, 401, 403, 404, 409, 415, 429, 500], startDiagnosticItemProcedure: [400, 401, 403, 404, 409, 415, 429, 500],
  markDiagnosticItemPerformed: [400, 401, 403, 404, 409, 415, 429, 500], requestDiagnosticItemRecollection: [400, 401, 403, 404, 409, 415, 429, 500],
  createDiagnosticItemResult: [400, 401, 403, 404, 409, 415, 422, 429, 500], receiveReplacementSample: [400, 401, 403, 404, 409, 415, 429, 500],
  getSampleLabel: [401, 404, 429, 500],
  rescheduleProcedure: [400, 401, 403, 404, 409, 415, 429, 500], createAttachmentUploadSession: [400, 401, 403, 404, 409, 415, 429, 500],
  uploadAttachmentContent: [400, 401, 403, 404, 409, 415, 429, 500, 503], finalizeAttachment: [400, 401, 403, 404, 409, 415, 422, 429, 500],
  downloadAttachment: [401, 404, 429, 500, 503], getResult: [401, 404, 429, 500], listResultVersions: [401, 404, 429, 500],
  updateResultDraft: [400, 401, 403, 404, 409, 415, 429, 500], releaseResult: [400, 401, 403, 404, 409, 415, 422, 429, 500],
  amendResult: [400, 401, 403, 404, 409, 415, 429, 500], voidResult: [400, 401, 403, 404, 409, 415, 429, 500],
  viewResult: [400, 401, 403, 404, 409, 415, 429, 500], reviewResult: [400, 401, 403, 404, 409, 415, 429, 500],
  getReport: [401, 404, 429, 500], listAuditEvents: [400, 401, 404, 429, 500], listNotifications: [400, 401, 404, 429, 500],
  acknowledgeNotification: [400, 401, 403, 404, 409, 415, 429, 500], listQueueItems: [400, 401, 404, 429, 500],
  searchDiagnostics: [400, 401, 404, 429, 500], getTimeline: [400, 401, 404, 429, 500], getDashboard: [401, 404, 429, 500],
  getManagementOverview: [401, 404, 429, 500], listDeadLetters: [400, 401, 403, 404, 429, 500], reprocessDeadLetter: [400, 401, 403, 404, 409, 415, 429, 500], discardDeadLetter: [400, 401, 403, 404, 409, 415, 429, 500], streamRealtimeEvents: [400, 401, 404, 429, 500],
  verifyWhatsAppWebhook: [403, 404, 429, 500], receiveWhatsAppStatus: [400, 401, 404, 415, 429, 500]
} satisfies Record<string, ReadonlyArray<number>>);

export const API_OPERATIONS: ReadonlyArray<ApiOperation> = Object.freeze(operations.map((operation) => {
  const operationAuthorization = AUTHORIZATION_BY_OPERATION[operation.operationId as keyof typeof AUTHORIZATION_BY_OPERATION];
  const errorStatuses = ERROR_STATUSES_BY_OPERATION[operation.operationId as keyof typeof ERROR_STATUSES_BY_OPERATION];
  if (!operationAuthorization) throw new Error(`${operation.method} ${operation.path} is missing explicit authorization metadata.`);
  if (!errorStatuses) throw new Error(`${operation.method} ${operation.path} is missing explicit error statuses.`);
  // Every operation can meet an unavailable dependency (database, distributed rate limit) and
  // answers 503 DEPENDENCY_UNAVAILABLE, retryable, instead of a generic 500.
  const requestBoundaryErrors = Object.freeze([...new Set([400, 503, ...errorStatuses])].sort((left, right) => left - right));
  const enriched = { ...operation, authorization: operationAuthorization, errorStatuses: requestBoundaryErrors };
  if (!operation.successMediaTypes.includes("application/json")) return Object.freeze(enriched);
  const successDataSchema = API_SUCCESS_DATA_SCHEMAS[operation.operationId as keyof typeof API_SUCCESS_DATA_SCHEMAS];
  if (!successDataSchema) throw new Error(`${operation.method} ${operation.path} is missing an explicit JSON success data schema.`);
  return Object.freeze({ ...enriched, successDataSchema });
}));

function pathMatches(template: string, pathSegments: ReadonlyArray<string>): boolean {
  const templateSegments = template.slice(1).split("/");
  if (templateSegments.length !== pathSegments.length) return false;
  return templateSegments.every((segment, index) => {
    const candidate = pathSegments[index];
    const isParameter = /^\{[^{}]+\}$/.test(segment);
    return candidate !== undefined && candidate.length > 0 && !candidate.includes("/") && !candidate.includes("%") && (isParameter ? Array.from(candidate).length <= 100 : segment === candidate);
  });
}

export function matchApiOperation(method: string, pathSegments: ReadonlyArray<string>): ApiOperation | undefined {
  const normalizedMethod = method.toUpperCase();
  return API_OPERATIONS.find((operation) => operation.method === normalizedMethod && pathMatches(operation.path, pathSegments));
}
