import type { Permission } from "@cvg/contracts";
import { API_SUCCESS_DATA_SCHEMAS } from "./api-operation-model";
import type { ApiAuthorizationCondition, ApiConditionalPermissionRule, ApiAuthorization, ApiOperation, ApiOperationDraft } from "./api-operation-model";
import { IDEMPOTENCY, IDEMPOTENCY_REQUIRED, IF_MATCH, LAST_EVENT_ID, DUPLICATE_OVERRIDE, HUB_SIGNATURE, PUBLIC_READ_ERRORS, JSON_COMMAND_WITH_POLICY_ERRORS, jsonBody, binaryBody, read, command } from "./api-operation-builders";
import { hospitalCollaborationOperations, hospitalCollaborationAuthorization, hospitalCollaborationErrors } from "./api-hospital-collaboration-manifest";
import { hospitalWorkOperations, hospitalWorkAuthorization, hospitalWorkErrors } from "./api-hospital-work-manifest";
import { hospitalExternalOperations, hospitalExternalAuthorization, hospitalExternalErrors } from "./api-hospital-external-manifest";
export { API_SUCCESS_DATA_SCHEMAS } from "./api-operation-model";
export type * from "./api-operation-model";

const pagination = [
  { name: "cursor", schema: "Cursor" },
  { name: "limit", schema: "Limit" }
] as const;

const taskFilters = [...pagination, { name: "departmentCode", schema: "DepartmentCode" }, { name: "responsibleUserId", schema: "Identifier" }, { name: "assignedToMe", schema: "Boolean" }, { name: "includeArchived", schema: "Boolean" }, { name: "includeDrafts", schema: "Boolean" }, { name: "label", schema: "HospitalTaskLabel" }, { name: "typeId", schema: "Identifier" }, { name: "patientId", schema: "Identifier" }, { name: "encounterId", schema: "Identifier" }, { name: "planId", schema: "Identifier" }, { name: "shiftId", schema: "Identifier" }, { name: "phase", schema: "HospitalTaskPhase" }, { name: "status", schema: "Identifier" }, { name: "priority", schema: "Priority" }, { name: "from", schema: "DateTime" }, { name: "to", schema: "DateTime" }, { name: "query", schema: "PlannerQuery" }, { name: "orderBy", schema: "PlannerOrder" }, { name: "direction", schema: "PlannerDirection" }] as const;
const intakeFilters = [...pagination, { name: "departmentCode", schema: "DepartmentCode" }, { name: "patientId", schema: "Identifier" }, { name: "from", schema: "DateTime" }, { name: "to", schema: "DateTime" }, { name: "query", schema: "PlannerQuery" }, { name: "state", schema: "HospitalIntakeState" }] as const;
const operations: ReadonlyArray<ApiOperationDraft> = [
  ...hospitalCollaborationOperations,
  ...hospitalWorkOperations,
  ...hospitalExternalOperations,
  read("/admissions/{admissionId}/context-options", "getAdmissionContextOptions", "Read currently eligible admission destinations and professionals", "Patients", { queryParameters: [{ name: "departmentCode", schema: "DepartmentCode" }] }),
  read("/hospital-planner/options", "listHospitalPlannerOptions", "Read metadata for a specific authorized planning action", "Planner", { queryParameters: [{ name: "action", schema: "HospitalPlannerOptionAction" }] }),
  read("/hospital-plans", "listHospitalPlans", "List authorized patient work plans", "Planner", { queryParameters: [...pagination, { name: "patientId", schema: "Identifier" }, { name: "encounterId", schema: "Identifier" }, { name: "departmentCode", schema: "DepartmentCode" }, { name: "state", schema: "HospitalPlanState" }, { name: "query", schema: "PlannerQuery" }] }),
  read("/hospital-plans/{planId}", "getHospitalPlan", "Read plan progress over authorized unique activities", "Planner"),
  command("POST", "/hospital-plans", "createHospitalPlan", "Create a patient work plan", "Planner", jsonBody("HospitalPlanCreate"), { headers: [IDEMPOTENCY_REQUIRED], successStatus: 201 }),
  command("PATCH", "/hospital-plans/{planId}", "updateHospitalPlan", "Revise an active work plan", "Planner", jsonBody("HospitalPlanPatch"), { headers: [IDEMPOTENCY_REQUIRED, IF_MATCH], concurrencyResource: "hospitalPlan.version" }),
  command("PUT", "/hospital-plans/{planId}/links", "putHospitalPlanLink", "Link an existing activity to a plan step", "Planner", jsonBody("HospitalPlanLink"), { headers: [IDEMPOTENCY_REQUIRED, IF_MATCH], concurrencyResource: "hospitalPlan.version" }),
  command("POST", "/hospital-plans/{planId}/commands", "commandHospitalPlan", "Close or archive a plan without executing its activities", "Planner", jsonBody("HospitalPlanCommand"), { headers: [IDEMPOTENCY_REQUIRED, IF_MATCH], concurrencyResource: "hospitalPlan.version" }),
  read("/hospital-shifts", "listHospitalShifts", "List authorized hospital shifts", "Planner", { queryParameters: [...pagination, { name: "departmentCode", schema: "DepartmentCode" }, { name: "status", schema: "HospitalShiftStatus" }, { name: "current", schema: "Boolean" }, { name: "from", schema: "DateTime" }, { name: "to", schema: "DateTime" }] }),
  read("/hospital-shifts/{shiftId}", "getHospitalShift", "Read shift coverage and authorized workload", "Planner"),
  command("POST", "/hospital-shifts", "createHospitalShift", "Create a shift with eligible members", "Planner", jsonBody("HospitalShiftCreate"), { headers: [IDEMPOTENCY_REQUIRED], successStatus: 201 }),
  command("PATCH", "/hospital-shifts/{shiftId}", "updateHospitalShift", "Revise or close a shift", "Planner", jsonBody("HospitalShiftPatch"), { headers: [IDEMPOTENCY_REQUIRED, IF_MATCH], concurrencyResource: "hospitalShift.version" }),
  command("PUT", "/hospital-activities/shift", "assignHospitalActivityShift", "Link a shift to an existing activity", "Planner", jsonBody("HospitalActivityShift"), { headers: [IDEMPOTENCY_REQUIRED, IF_MATCH], concurrencyResource: "targetActivity.version" }),
  read("/hospital-handoffs", "listHospitalHandoffs", "List authorized handoff offers", "Planner", { queryParameters: [...pagination, { name: "departmentCode", schema: "DepartmentCode" }, { name: "state", schema: "HospitalHandoffState" }] }),
  command("POST", "/hospital-handoffs", "offerHospitalHandoff", "Offer a handoff retaining current responsibilities until acceptance", "Planner", jsonBody("HospitalHandoffOffer"), { headers: [IDEMPOTENCY_REQUIRED], successStatus: 201 }),
  command("POST", "/hospital-handoffs/{handoffId}/decision", "decideHospitalHandoff", "Accept or reject a nominal handoff atomically", "Planner", jsonBody("HospitalHandoffDecision"), { headers: [IDEMPOTENCY_REQUIRED, IF_MATCH], concurrencyResource: "hospitalHandoff.version" }),
  read("/hospital-checklist-templates", "listHospitalChecklistTemplates", "List authorized checklist models and approval status", "Planner", { queryParameters: [...pagination, { name: "departmentCode", schema: "DepartmentCode" }, { name: "status", schema: "HospitalChecklistStatus" }, { name: "query", schema: "PlannerQuery" }] }),
  command("POST", "/hospital-checklist-templates", "createHospitalChecklistTemplate", "Prepare a draft checklist model", "Planner", jsonBody("HospitalChecklistCreate"), { headers: [IDEMPOTENCY_REQUIRED], successStatus: 201 }),
  command("PATCH", "/hospital-checklist-templates/{templateId}", "updateHospitalChecklistTemplate", "Revise a draft checklist model", "Planner", jsonBody("HospitalChecklistPatch"), { headers: [IDEMPOTENCY_REQUIRED, IF_MATCH], concurrencyResource: "hospitalChecklistTemplate.version" }),
  command("POST", "/hospital-checklist-templates/{templateId}/approve", "approveHospitalChecklistTemplate", "Approve an adopted checklist model", "Planner", jsonBody("HospitalChecklistApproval"), { headers: [IDEMPOTENCY_REQUIRED, IF_MATCH], concurrencyResource: "hospitalChecklistTemplate.version" }),
  command("POST", "/hospital-checklist-templates/{templateId}/retire", "retireHospitalChecklistTemplate", "Retire a model without modifying captured activities", "Planner", jsonBody("HospitalChecklistApproval"), { headers: [IDEMPOTENCY_REQUIRED, IF_MATCH], concurrencyResource: "hospitalChecklistTemplate.version" }),
  command("POST", "/hospital-tasks/{taskId}/checklist-steps", "recordHospitalChecklistStep", "Record or invalidate an execution step with evidence", "Planner", jsonBody("HospitalChecklistStep"), { headers: [IDEMPOTENCY_REQUIRED, IF_MATCH], concurrencyResource: "hospitalTask.version" }),
  command("POST", "/hospital-tasks/{taskId}/care-execution", "executeHospitalCare", "Confirm approved non-diagnostic care with an adopted record reference", "Planner", jsonBody("HospitalCareExecute"), { headers: [IDEMPOTENCY_REQUIRED, IF_MATCH], concurrencyResource: "hospitalTask.version", errorStatuses: JSON_COMMAND_WITH_POLICY_ERRORS }),
  read("/hospital-recurrences", "listHospitalRecurrences", "List authorized recurring work definitions", "Planner", { queryParameters: [...pagination, { name: "departmentCode", schema: "DepartmentCode" }, { name: "patientId", schema: "Identifier" }, { name: "active", schema: "Boolean" }] }),
  command("POST", "/hospital-recurrences", "createHospitalRecurrence", "Create recurring work from an approved model", "Planner", jsonBody("HospitalRecurrenceCreate"), { headers: [IDEMPOTENCY_REQUIRED], successStatus: 201 }),
  command("PATCH", "/hospital-recurrences/{recurrenceId}", "updateHospitalRecurrence", "Revise future recurrence configuration without rewriting occurrences", "Planner", jsonBody("HospitalRecurrencePatch"), { headers: [IDEMPOTENCY_REQUIRED, IF_MATCH], concurrencyResource: "hospitalRecurrence.version" }),
  command("POST", "/hospital-recurrences/generate", "generateHospitalRecurrences", "Generate a bounded set of due authorized occurrences", "Planner", jsonBody("HospitalRecurrenceGeneration"), { headers: [IDEMPOTENCY_REQUIRED] }),
  read("/hospital-resources/options", "getHospitalResourceOptions", "Read scoped resource creation metadata", "Planner"),
  read("/hospital-resources", "listHospitalResources", "List authorized hospital resource inventory", "Planner", { queryParameters: [...pagination, { name: "departmentCode", schema: "DepartmentCode" }, { name: "kind", schema: "HospitalResourceKind" }, { name: "query", schema: "PlannerQuery" }, { name: "includeInactive", schema: "Boolean" }] }),
  read("/hospital-resources/{resourceId}", "getHospitalResource", "Read an authorized resource", "Planner"),
  command("POST", "/hospital-resources", "createHospitalResource", "Register a real hospital resource", "Planner", jsonBody("HospitalResourceCreate"), { headers: [IDEMPOTENCY_REQUIRED], successStatus: 201 }),
  command("PATCH", "/hospital-resources/{resourceId}", "updateHospitalResource", "Revise or inactivate hospital resource metadata", "Planner", jsonBody("HospitalResourcePatch"), { headers: [IDEMPOTENCY_REQUIRED, IF_MATCH], concurrencyResource: "hospitalResource.version" }),
  read("/hospital-calendar", "listHospitalCalendar", "Read authorized reservations, deadlines and executions", "Planner", { queryParameters: [...pagination, { name: "departmentCode", schema: "DepartmentCode" }, { name: "resourceId", schema: "Identifier" }, { name: "from", schema: "DateTime", required: true }, { name: "to", schema: "DateTime", required: true }, { name: "kinds", schema: "HospitalCalendarKinds", style: "form", explode: false }], queryConstraints: { fromMustNotExceedTo: true } }),
  command("POST", "/hospital-tasks/{taskId}/reservations", "reserveHospitalTaskSchedule", "Reserve resources for a pending hospital activity", "Planner", jsonBody("HospitalTaskReserve"), { headers: [IDEMPOTENCY_REQUIRED, IF_MATCH], successStatus: 201, concurrencyResource: "hospitalTask.version" }),
  command("POST", "/hospital-reservations/{scheduleId}/reschedule", "rescheduleHospitalTaskSchedule", "Reschedule resources preserving the previous reservation", "Planner", jsonBody("HospitalScheduleReschedule"), { headers: [IDEMPOTENCY_REQUIRED, IF_MATCH], concurrencyResource: "hospitalSchedule.version" }),
  command("POST", "/hospital-reservations/{scheduleId}/cancel", "cancelHospitalTaskSchedule", "Cancel a reservation without canceling its activity", "Planner", jsonBody("HospitalScheduleCancel"), { headers: [IDEMPOTENCY_REQUIRED, IF_MATCH], concurrencyResource: "hospitalSchedule.version" }),
  read("/bed-census", "getBedCensus", "Read authorized admission occupancy and unresolved bed links", "Planner", { queryParameters: [{ name: "departmentCode", schema: "DepartmentCode" }] }),
  read("/hospital-capacity", "getHospitalCapacity", "Read resource capacity and authorized load with explicit units", "Planner", { queryParameters: [{ name: "departmentCode", schema: "DepartmentCode" }, { name: "from", schema: "DateTime", required: true }, { name: "to", schema: "DateTime", required: true }], queryConstraints: { fromMustNotExceedTo: true } }),
  read("/hospital-task-types", "listHospitalTaskTypes", "Read configurable task types", "Planner"),
  command("POST", "/hospital-task-types", "createHospitalTaskType", "Create a hospital task type", "Planner", jsonBody("HospitalTaskTypeCreate"), { headers: [IDEMPOTENCY_REQUIRED], successStatus: 201 }),
  command("PATCH", "/hospital-task-types/{typeId}", "updateHospitalTaskType", "Revise a task type without rewriting captured activities", "Planner", jsonBody("HospitalTaskTypePatch"), { headers: [IDEMPOTENCY_REQUIRED, IF_MATCH], concurrencyResource: "hospitalTaskType.version" }),
  read("/hospital-tasks/options", "listHospitalTaskOptions", "Read scoped metadata for task creation", "Planner"),
  read("/hospital-tasks", "listHospitalTasks", "List authorized hospital activities", "Planner", { queryParameters: taskFilters, queryConstraints: { fromMustNotExceedTo: true } }),
  command("POST", "/hospital-tasks", "createHospitalTask", "Create a hospital activity", "Planner", jsonBody("HospitalTaskCreate"), { headers: [IDEMPOTENCY_REQUIRED], successStatus: 201 }),
  read("/hospital-tasks/{taskId}", "getHospitalTask", "Read an authorized activity and its contextual commands", "Planner"),
  read("/hospital-tasks/{taskId}/history", "getHospitalTaskHistory", "Read an authorized activity history", "Planner", { queryParameters: pagination }),
  command("PATCH", "/hospital-tasks/{taskId}", "updateHospitalTask", "Update hospital activity planning", "Planner", jsonBody("HospitalTaskPatch"), { headers: [IDEMPOTENCY_REQUIRED, IF_MATCH], concurrencyResource: "hospitalTask.version" }),
  command("PUT", "/hospital-tasks/{taskId}/context", "updateHospitalTaskContext", "Change a pending activity's clinical context", "Planner", jsonBody("HospitalTaskContext"), { headers: [IDEMPOTENCY_REQUIRED, IF_MATCH], concurrencyResource: "hospitalTask.version" }),
  command("PUT", "/hospital-tasks/{taskId}/assignment", "assignHospitalTask", "Explicitly assume or assign a hospital activity", "Planner", jsonBody("HospitalTaskAssignment"), { headers: [IDEMPOTENCY_REQUIRED, IF_MATCH], concurrencyResource: "hospitalTask.version" }),
  command("PUT", "/hospital-tasks/{taskId}/priority", "reprioritizeHospitalTask", "Reclassify hospital activity priority", "Planner", jsonBody("HospitalTaskPriority"), { headers: [IDEMPOTENCY_REQUIRED, IF_MATCH], concurrencyResource: "hospitalTask.version" }),
  command("POST", "/hospital-tasks/{taskId}/commands", "commandHospitalTask", "Start, complete or cancel an activity using its own authority", "Planner", jsonBody("HospitalTaskCommand"), { headers: [IDEMPOTENCY_REQUIRED, IF_MATCH], concurrencyResource: "hospitalTask.version" }),
  command("PUT", "/hospital-tasks/{taskId}/dependencies", "putHospitalTaskDependency", "Set a scoped activity prerequisite", "Planner", jsonBody("HospitalTaskDependencyCommand"), { headers: [IDEMPOTENCY_REQUIRED, IF_MATCH], concurrencyResource: "hospitalTask.version" }),
  read("/hospital-intakes/options", "getHospitalIntakeOptions", "Read currently approved rejection reasons for authorized triage sectors", "Planner", { queryParameters: [{ name: "departmentCode", schema: "DepartmentCode" }] }),
  read("/hospital-intakes", "listHospitalIntakes", "List authorized operational demands", "Planner", { queryParameters: intakeFilters, queryConstraints: { fromMustNotExceedTo: true } }),
  command("POST", "/hospital-intakes", "createHospitalIntake", "Receive an operational or diagnostic demand", "Planner", jsonBody("HospitalIntakeCreate"), { headers: [IDEMPOTENCY_REQUIRED], successStatus: 201 }),
  command("POST", "/hospital-intakes/{intakeId}/triage", "triageHospitalIntake", "Accept, reject, defer or link duplicate demands", "Planner", jsonBody("HospitalIntakeTriage"), { headers: [IDEMPOTENCY_REQUIRED, IF_MATCH], concurrencyResource: "hospitalIntake.version" }),
  read("/planner/search", "searchPlanner", "Search only objects the current user may open", "Planner", { queryParameters: [...taskFilters, { name: "types", schema: "PlannerSearchTypes", style: "form", explode: false }], queryConstraints: { fromMustNotExceedTo: true } }),
  read("/hospital-services", "listHospitalServices", "List authorized hospital and diagnostic capabilities", "Catalog", { queryParameters: [...pagination, { name: "departmentCode", schema: "DepartmentCode" }, { name: "kind", schema: "HospitalServiceCatalogKind" }, { name: "query", schema: "PlannerQuery" }, { name: "includeInactive", schema: "Boolean" }] }),
  read("/hospital-services/{serviceId}", "getHospitalService", "Read a hospital capability", "Catalog"),
  command("POST", "/hospital-services", "createHospitalService", "Create a hospital capability", "Catalog", jsonBody("HospitalServiceCreate"), { headers: [IDEMPOTENCY_REQUIRED], successStatus: 201 }),
  command("PATCH", "/hospital-services/{serviceId}", "updateHospitalService", "Update or inactivate a hospital capability", "Catalog", jsonBody("HospitalServicePatch"), { headers: [IDEMPOTENCY_REQUIRED, IF_MATCH], concurrencyResource: "hospitalService.version" }),
  command("POST", "/hospital-services/import", "importHospitalServices", "Validate or atomically import hospital capabilities", "Catalog", jsonBody("HospitalServiceImport"), { headers: [IDEMPOTENCY_REQUIRED] }),
  read("/planner-views", "listPlannerViews", "List private and authorized shared planner configurations", "Planner"),
  command("POST", "/planner-views", "createPlannerView", "Save a planner configuration", "Planner", jsonBody("PlannerViewCreate"), { headers: [IDEMPOTENCY_REQUIRED], successStatus: 201 }),
  command("PATCH", "/planner-views/{viewId}", "updatePlannerView", "Update an owned planner configuration", "Planner", jsonBody("PlannerViewPatch"), { headers: [IDEMPOTENCY_REQUIRED, IF_MATCH], concurrencyResource: "savedPlannerView.version" }),
  command("POST", "/planner-views/{viewId}/deactivate", "deactivatePlannerView", "Deactivate an owned planner configuration", "Planner", jsonBody("PlannerViewDeactivate"), { headers: [IDEMPOTENCY_REQUIRED, IF_MATCH], concurrencyResource: "savedPlannerView.version" }),
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

  read("/access-groups/permissions", "listDelegablePermissions", "List commands the actor may delegate", "Administration"),
  read("/access-groups", "listAccessGroups", "List access groups and command matrices", "Administration"),
  command("POST", "/access-groups", "createAccessGroup", "Create an access group", "Administration", jsonBody("AccessGroupCreate"), { headers: [IDEMPOTENCY_REQUIRED], successStatus: 201 }),
  command("PATCH", "/access-groups/{groupId}", "updateAccessGroup", "Update or inactivate an access group", "Administration", jsonBody("AccessGroupPatch"), { headers: [IDEMPOTENCY_REQUIRED, IF_MATCH], concurrencyResource: "accessGroup.version" }),
  command("POST", "/access-groups/{groupId}/preview", "previewAccessGroupImpact", "Preview all affected bindings before changing an access group", "Administration", jsonBody("AccessGroupImpactPreviewRequest")),
  command("PUT", "/users/{userId}/access-group", "assignUserAccessGroup", "Assign the user's access group and revoke affected sessions", "Administration", jsonBody("UserGroupAssignment"), { headers: [IDEMPOTENCY_REQUIRED, IF_MATCH], concurrencyResource: "managedUser.version" }),
  command("POST", "/users/{userId}/access-preview", "previewUserAccess", "Preview effective permissions without granting access", "Administration", jsonBody("EffectiveAccessPreviewRequest")),
  read("/users/{userId}/patient-grants", "listPatientGrants", "List a user's authorized patient grant references", "Administration"),
  command("PUT", "/users/{userId}/patient-grants", "changePatientGrant", "Grant or revoke individual patient scope", "Administration", jsonBody("PatientGrantCommand"), { headers: [IDEMPOTENCY_REQUIRED, IF_MATCH], concurrencyResource: "managedUser.version" }),

  read("/departments", "listDepartments", "List hospital departments", "Administration", { queryParameters: [{ name: "includeInactive", schema: "Boolean" }] }),
  command("POST", "/departments", "createDepartment", "Create a hospital department", "Administration", jsonBody("DepartmentCreate"), { headers: [IDEMPOTENCY_REQUIRED], successStatus: 201 }),
  read("/departments/{departmentId}", "getDepartment", "Read a hospital department", "Administration"),
  command("PATCH", "/departments/{departmentId}", "updateDepartment", "Update or reactivate a hospital department", "Administration", jsonBody("DepartmentPatch"), { headers: [IDEMPOTENCY_REQUIRED, IF_MATCH], concurrencyResource: "department.version" }),
  command("POST", "/departments/{departmentId}/deactivate", "deactivateDepartment", "Deactivate a hospital department while preserving history", "Administration", jsonBody("DepartmentDeactivate"), { headers: [IDEMPOTENCY_REQUIRED, IF_MATCH], concurrencyResource: "department.version" }),
  command("PUT", "/departments/{departmentId}/members", "setDepartmentMembers", "Manage department members and responsibility", "Administration", jsonBody("DepartmentMembers"), { headers: [IDEMPOTENCY_REQUIRED, IF_MATCH], concurrencyResource: "department.version" }),

  read("/diagnostic-items/{itemId}/assignees", "listDiagnosticItemAssignees", "List eligible execution assignees", "Workflow"),
  command("PUT", "/diagnostic-items/{itemId}/assignment", "assignDiagnosticItem", "Assign or assume a diagnostic item", "Workflow", jsonBody("DiagnosticItemAssignment"), { headers: [IDEMPOTENCY_REQUIRED, IF_MATCH], concurrencyResource: "diagnosticItem.version" }),
  command("PUT", "/diagnostic-items/{itemId}/planning", "planDiagnosticItem", "Set planning dates without reserving or restarting SLA", "Workflow", jsonBody("DiagnosticItemPlanning"), { headers: [IDEMPOTENCY_REQUIRED, IF_MATCH], concurrencyResource: "diagnosticItem.version" }),
  command("PUT", "/diagnostic-items/{itemId}/priority", "reprioritizeDiagnosticItem", "Reclassify an item using its original SLA clock", "Workflow", jsonBody("DiagnosticItemPriority"), { headers: [IDEMPOTENCY_REQUIRED, IF_MATCH], concurrencyResource: "diagnosticItem.version" }),
  read("/diagnostic-services/{serviceId}/definitions", "listExamDefinitions", "Read immutable exam definition history", "Catalog"),
  command("PUT", "/diagnostic-services/{serviceId}/template", "prepareExamTemplate", "Prepare a draft laboratory panel", "Catalog", jsonBody("PrepareExamTemplate"), { headers: [IDEMPOTENCY_REQUIRED, IF_MATCH], concurrencyResource: "diagnosticService.version" }),
  command("POST", "/diagnostic-services/{serviceId}/template/publish", "publishExamTemplate", "Approve a laboratory panel for its population", "Catalog", jsonBody("PublishExamTemplate"), { headers: [IDEMPOTENCY_REQUIRED, IF_MATCH], concurrencyResource: "diagnosticService.version" }),
  command("POST", "/diagnostic-services/{serviceId}/template/retire", "retireExamTemplate", "Retire a laboratory panel", "Catalog", jsonBody("RetireExamTemplate"), { headers: [IDEMPOTENCY_REQUIRED, IF_MATCH], concurrencyResource: "diagnosticService.version" }),
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
  read("/patients/{patientId}/archive", "listPatientArchive", "List a patient's archived diagnostics", "Patients", { queryParameters: pagination }),
  read("/patients/{patientId}/timeline", "getPatientTimeline", "Continue a patient's authorized timeline", "Patients", { queryParameters: pagination }),
  read("/archive/requests/{requestId}", "getArchivedRequest", "Read an archived diagnostic request (read-only)", "Patients"),
  read("/data-subject-exports", "exportPatientData", "Export a patient's records for the data subject (LGPD)", "Patients", { queryParameters: [{ name: "externalId", required: true, schema: "ExternalId" }] }),
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

  read("/results/{resultId}", "getResult", "Read a result or a read-only historical version", "Results", { queryParameters: [{ name: "versionId", schema: "ServiceIdentifier" }] }),
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
  read("/critical-results/readiness", "getCriticalReadiness", "Read critical-result readiness: approved policy, redundant channel and on-call coverage by department", "Operations", { errorStatuses: [401, 404, 429, 500] }),
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
const PATIENT = [...ROLE, "patient access is global for SUPERADMIN; otherwise limited to patient scope or an authorized service/request context"] as const;
const REQUEST = [...ROLE, "request access is global for SUPERADMIN; otherwise limited to patient scope, executor department context, or a manager delegated department"] as const;
const DEPARTMENT = [...ROLE, "departmentCode is unrestricted for SUPERADMIN; otherwise must match the actor department or a manager delegated department"] as const;
const SERVICE = [...DEPARTMENT, "serviceCode must be assigned to executor roles"] as const;
const OWNER = [...SERVICE, "draft ownerId must equal the actor id"] as const;
const RESULT_MUTATION = [...SERVICE, "executor actors may amend or void only their own released result; managers use department-scoped policy"] as const;
const RESULT_SCOPE = [...SERVICE, "patient access is global for SUPERADMIN; otherwise limited to patient scope or an authorized service/request context"] as const;

const authorization = (
  requiredPermissions: ReadonlyArray<Permission>,
  conditions: ReadonlyArray<ApiAuthorizationCondition>,
  stepUpRequired = false,
  conditionalPermissionRules: ReadonlyArray<ApiConditionalPermissionRule> = [],
  anyOfPermissions: ReadonlyArray<Permission> = []
): ApiAuthorization => Object.freeze({
  requiredPermissions: Object.freeze([...requiredPermissions]),
  ...(anyOfPermissions.length ? { anyOfPermissions: Object.freeze([...anyOfPermissions]) } : {}),
  conditionalPermissionRules: Object.freeze(conditionalPermissionRules.map((rule) => Object.freeze({
    when: rule.when,
    allOf: Object.freeze([...rule.allOf]),
    ...(rule.anyOf ? { anyOf: Object.freeze([...rule.anyOf]) } : {})
  }))),
  conditions: Object.freeze([...conditions]),
  stepUpRequired
});

const ACTIVITY_SCOPE = [...ROLE, "hospital activity requires own or delegated department and existing clinical access when linked to a patient; assignment never supplies patient access"] as const;
const AUTHORIZATION_BY_OPERATION = Object.freeze({
  ...hospitalCollaborationAuthorization,
  ...hospitalWorkAuthorization,
  ...hospitalExternalAuthorization,
  getAdmissionContextOptions: authorization(["admission.context.manage", "patient.view"], [...ACTIVITY_SCOPE, "current and destination departments must remain inside manager delegation and responsibility never grants patient scope"]),
  listHospitalPlannerOptions: authorization([], ROLE, false, [], ["plan.create", "plan.update", "shift.manage", "handoff.offer", "recurrence.manage", "checklist_template.manage"]),
  listHospitalPlans: authorization(["plan.view", "patient.view"], ACTIVITY_SCOPE),
  getHospitalPlan: authorization(["plan.view", "patient.view"], [...ACTIVITY_SCOPE, "plan links and aggregate progress include only currently authorized activities; closing a plan does not change their workflows"]),
  createHospitalPlan: authorization(["plan.create", "patient.view"], ACTIVITY_SCOPE),
  updateHospitalPlan: authorization(["plan.update", "patient.view"], ACTIVITY_SCOPE),
  putHospitalPlanLink: authorization(["plan.update", "patient.view"], [...ACTIVITY_SCOPE, "plan links and aggregate progress include only currently authorized activities; closing a plan does not change their workflows"]),
  commandHospitalPlan: authorization(["patient.view"], ACTIVITY_SCOPE, false, [{ when: "plan command is CLOSE", allOf: ["plan.update"] }, { when: "plan command is ARCHIVE", allOf: ["plan.archive"] }], ["plan.update", "plan.archive"]),
  listHospitalShifts: authorization(["shift.view"], ACTIVITY_SCOPE),
  getHospitalShift: authorization(["shift.view"], [...ACTIVITY_SCOPE, "shift intervals and eligible members never grant patient access or alter on-call authority"]),
  createHospitalShift: authorization(["shift.manage"], ACTIVITY_SCOPE),
  updateHospitalShift: authorization(["shift.manage"], ACTIVITY_SCOPE),
  assignHospitalActivityShift: authorization(["shift.assign"], ACTIVITY_SCOPE, false, [{ when: "shift target is HOSPITAL_TASK", allOf: ["hospital_task.view"] }, { when: "shift target is DIAGNOSTIC_ITEM", allOf: ["item.view"] }]),
  listHospitalHandoffs: authorization(["shift.view"], ACTIVITY_SCOPE),
  offerHospitalHandoff: authorization(["handoff.offer"], [...ACTIVITY_SCOPE, "shift intervals and eligible members never grant patient access or alter on-call authority"]),
  decideHospitalHandoff: authorization(["handoff.accept"], [...ACTIVITY_SCOPE, "only the nominal recipient may decide a handoff; acceptance checks all target versions and current eligibility atomically"]),
  listHospitalChecklistTemplates: authorization(["checklist_template.view"], ROLE),
  createHospitalChecklistTemplate: authorization(["checklist_template.manage"], ROLE),
  updateHospitalChecklistTemplate: authorization(["checklist_template.manage"], ROLE),
  approveHospitalChecklistTemplate: authorization(["checklist_template.approve"], [...ROLE, "approved checklist snapshots are immutable and required steps need their prescribed evidence"]),
  retireHospitalChecklistTemplate: authorization(["checklist_template.manage"], ROLE),
  recordHospitalChecklistStep: authorization(["checklist.execute", "hospital_task.view"], [...ACTIVITY_SCOPE, "approved checklist snapshots are immutable and required steps need their prescribed evidence"]),
  executeHospitalCare: authorization(["care.execute", "hospital_task.view"], [...ACTIVITY_SCOPE, "clinical execution requires explicit confirmation, an approved process and an eligible executor; the record reference is an executor declaration"]),
  listHospitalRecurrences: authorization(["recurrence.view"], ACTIVITY_SCOPE),
  createHospitalRecurrence: authorization(["recurrence.manage"], [...ACTIVITY_SCOPE, "recurrences use durable unique occurrences, revalidate the creator and context, and never execute care automatically"]),
  updateHospitalRecurrence: authorization(["recurrence.manage"], ACTIVITY_SCOPE),
  generateHospitalRecurrences: authorization(["recurrence.manage"], [...ACTIVITY_SCOPE, "recurrences use durable unique occurrences, revalidate the creator and context, and never execute care automatically"]),
  getHospitalResourceOptions: authorization([], ROLE, false, [], ["hospital_resource.create", "hospital_resource.update"]),
  listHospitalResources: authorization(["hospital_resource.view"], ROLE),
  getHospitalResource: authorization(["hospital_resource.view"], ROLE),
  createHospitalResource: authorization(["hospital_resource.create"], [...ROLE, "inventory metadata does not grant access to patients or execution commands"]),
  updateHospitalResource: authorization([], [...ROLE, "resource identity is stable and active reservations and occupancy protect incompatible changes"], false, [{ when: "resource metadata is updated", allOf: ["hospital_resource.update"] }, { when: "resource activation changes", allOf: ["hospital_resource.deactivate"] }], ["hospital_resource.update", "hospital_resource.deactivate"]),
  listHospitalCalendar: authorization(["hospital_calendar.view"], ACTIVITY_SCOPE),
  reserveHospitalTaskSchedule: authorization(["hospital_calendar.reserve", "hospital_task.view"], [...ACTIVITY_SCOPE, "pending activity and actual available resources are required; reservations never change SLA or clinical state"]),
  rescheduleHospitalTaskSchedule: authorization(["hospital_calendar.reschedule", "hospital_task.view"], [...ACTIVITY_SCOPE, "old reservation is retained canceled; conflict checks use the same schedules authority as diagnostic procedures"]),
  cancelHospitalTaskSchedule: authorization(["hospital_calendar.cancel", "hospital_task.view"], ACTIVITY_SCOPE),
  getBedCensus: authorization(["admission.view"], [...ACTIVITY_SCOPE, "occupancy details require existing patient and admission access; unlinked legacy admissions do not declare beds available"]),
  getHospitalCapacity: authorization(["hospital_capacity.view"], [...ACTIVITY_SCOPE, "capacity units and unknown availability are explicit; resources do not pause diagnostic deadlines"]),
  listHospitalTaskTypes: authorization([], ROLE, false, [], ["hospital_task.view", "hospital_task_type.manage"]),
  createHospitalTaskType: authorization(["hospital_task_type.manage"], ROLE),
  updateHospitalTaskType: authorization(["hospital_task_type.manage"], ROLE),
  commandHospitalTask: authorization(["hospital_task.execute", "hospital_task.view"], [...ACTIVITY_SCOPE, "only the responsible professional or execution team may execute; manager and superadmin retain scoped operation rights", "dependencies are checked atomically for the requested command; completing a task never completes diagnostic work"]),
  updateHospitalTaskContext: authorization(["hospital_task.update", "hospital_task.view"], [...ACTIVITY_SCOPE, "context changes require PENDING, old and new clinical scope and eligible team; related tasks must be reconciled first"]),
  searchPlanner: authorization(["search.execute"], ACTIVITY_SCOPE),
  listHospitalTaskOptions: authorization(["hospital_task.create"], ACTIVITY_SCOPE, false, [{ when: "hospital activity is linked to a patient", allOf: ["patient.view"] }]),
  listHospitalTasks: authorization(["hospital_task.view"], ACTIVITY_SCOPE, false, [{ when: "hospital activity is linked to a patient", allOf: ["patient.view"] }]),
  getHospitalTask: authorization(["hospital_task.view"], ACTIVITY_SCOPE, false, [{ when: "hospital activity is linked to a patient", allOf: ["patient.view"] }]),
  getHospitalTaskHistory: authorization(["hospital_task.view"], ACTIVITY_SCOPE, false, [{ when: "hospital activity is linked to a patient", allOf: ["patient.view"] }]),
  createHospitalTask: authorization(["hospital_task.create"], ACTIVITY_SCOPE, false, [{ when: "hospital activity is linked to a patient", allOf: ["patient.view"] }]),
  updateHospitalTask: authorization(["hospital_task.update", "hospital_task.view"], ACTIVITY_SCOPE, false, [{ when: "hospital activity is linked to a patient", allOf: ["patient.view"] }]),
  assignHospitalTask: authorization(["hospital_task.assign", "hospital_task.view"], ACTIVITY_SCOPE, false, [{ when: "hospital activity is linked to a patient", allOf: ["patient.view"] }]),
  reprioritizeHospitalTask: authorization(["hospital_task.priority.update", "hospital_task.view"], ACTIVITY_SCOPE, false, [{ when: "hospital activity is linked to a patient", allOf: ["patient.view"] }]),
  putHospitalTaskDependency: authorization(["hospital_task.dependency.manage", "hospital_task.view"], ACTIVITY_SCOPE, false, [{ when: "hospital activity is linked to a patient", allOf: ["patient.view"] }]),
  getHospitalIntakeOptions: authorization(["hospital_intake.triage"], ["current authorized triage sectors; only currently configured institutional approval metadata, without patients or granted access"]),
  listHospitalIntakes: authorization(["hospital_intake.view"], ACTIVITY_SCOPE, false, [{ when: "hospital activity is linked to a patient", allOf: ["patient.view"] }]),
  createHospitalIntake: authorization(["hospital_intake.create"], ACTIVITY_SCOPE, false, [{ when: "hospital activity is linked to a patient", allOf: ["patient.view"] }]),
  triageHospitalIntake: authorization(["hospital_intake.triage"], [...ACTIVITY_SCOPE, "intake acceptance is idempotent and references diagnostic authority without executing clinical transitions"], false, [
    { when: "hospital activity is linked to a patient", allOf: ["patient.view"] },
    { when: "intake accepts a manual demand by creating a task", allOf: ["hospital_task.create"] },
    { when: "intake accepts a manual demand by linking a task", allOf: ["hospital_task.view"] },
    { when: "intake accepts a diagnostic demand", allOf: ["request.view"] },
    { when: "intake marks a duplicate demand", allOf: ["hospital_intake.view"] }
  ]),

  listHospitalServices: authorization(["service.catalog.view"], DEPARTMENT),
  getHospitalService: authorization(["service.catalog.view"], DEPARTMENT),
  createHospitalService: authorization([], DEPARTMENT, false, [], ["service.catalog.manage", "service.catalog.create"]),
  updateHospitalService: authorization([], DEPARTMENT, false, [
    { when: "active is false", allOf: [], anyOf: ["service.catalog.manage", "service.catalog.deactivate"] },
    { when: "catalog metadata is present or active is not false", allOf: [], anyOf: ["service.catalog.manage", "service.catalog.update"] }
  ], ["service.catalog.manage", "service.catalog.update", "service.catalog.deactivate"]),
  importHospitalServices: authorization([], DEPARTMENT, false, [
    { when: "an import row creates a service", allOf: [], anyOf: ["service.catalog.manage", "service.catalog.create"] },
    { when: "an import row updates metadata or reactivates a service", allOf: [], anyOf: ["service.catalog.manage", "service.catalog.update"] },
    { when: "an import row deactivates a service", allOf: [], anyOf: ["service.catalog.manage", "service.catalog.deactivate"] }
  ], ["service.catalog.manage", "service.catalog.create", "service.catalog.update", "service.catalog.deactivate"]),
  listPlannerViews: authorization(["planner_view.view"], [...ROLE, "private view mutations require ownership; sharing requires an authorized department and never grants clinical data access"]),
  createPlannerView: authorization(["planner_view.create"], [...ROLE, "private view mutations require ownership; sharing requires an authorized department and never grants clinical data access"], false, [{ when: "view configuration is shared with a department", allOf: ["planner_view.share"] }]),
  updatePlannerView: authorization(["planner_view.update"], [...ROLE, "private view mutations require ownership; sharing requires an authorized department and never grants clinical data access"], false, [{ when: "view configuration is shared with a department", allOf: ["planner_view.share"] }]),
  deactivatePlannerView: authorization(["planner_view.deactivate"], [...ROLE, "private view mutations require ownership; sharing requires an authorized department and never grants clinical data access"]),
  listDiagnosticItemAssignees: authorization(["item.assignment.update"], SERVICE),
  assignDiagnosticItem: authorization(["item.assignment.update"], [...SERVICE, "assignment requires an active eligible executor; assignment never changes draft ownership or grants patient access"]),
  planDiagnosticItem: authorization(["item.plan.update"], [...SERVICE, "executor may only plan their assigned item; planning dates are not a reservation or SLA clock"]),
  reprioritizeDiagnosticItem: authorization(["item.priority.update"], [...SERVICE, "item priority requires a reason and recalculates dueAt from the original clock and frozen policy; it never changes result criticality or workflow"]),
  listDelegablePermissions: authorization([], ROLE, false, [], ["user_role.manage", "access_group.view"]),
  listExamDefinitions: authorization(["service.catalog.view"], SERVICE),
  prepareExamTemplate: authorization([], SERVICE, false, [], ["service.catalog.manage", "service.catalog.update"]),
  publishExamTemplate: authorization(["exam_definition.approve"], SERVICE),
  retireExamTemplate: authorization([], SERVICE, false, [], ["service.catalog.manage", "service.catalog.update"]),
  listAccessGroups: authorization([], ROLE, false, [], ["user_role.manage", "access_group.view"]),
  createAccessGroup: authorization([], ROLE, false, [], ["user_role.manage", "access_group.create"]),
  updateAccessGroup: authorization([], ROLE, false, [
    { when: "active is false", allOf: [], anyOf: ["user_role.manage", "access_group.deactivate"] },
    { when: "access group metadata is present or active is not false", allOf: [], anyOf: ["user_role.manage", "access_group.update"] }
  ], ["user_role.manage", "access_group.update", "access_group.deactivate"]),
  previewAccessGroupImpact: authorization([], [...ROLE, "complete preview requires authority over all bound users; profile ceilings and current scopes remain mandatory"], false, [
    { when: "active is false", allOf: [], anyOf: ["user_role.manage", "access_group.deactivate"] },
    { when: "access group metadata is present or active is not false", allOf: [], anyOf: ["user_role.manage", "access_group.update"] }
  ], ["user_role.manage", "access_group.update", "access_group.deactivate"]),
  assignUserAccessGroup: authorization([], ROLE, false, [], ["user_role.manage", "access_group.assign"]),
  previewUserAccess: authorization([], ROLE, false, [], ["user_role.manage", "access_group.view"]),
  listPatientGrants: authorization([], ROLE, false, [], ["user_role.manage", "patient_scope.manage"]),
  changePatientGrant: authorization([], ROLE, false, [], ["user_role.manage", "patient_scope.manage"]),
  listDepartments: authorization(["department.view"], DEPARTMENT),
  getDepartment: authorization(["department.view"], DEPARTMENT),
  createDepartment: authorization(["department.create"], ROLE),
  updateDepartment: authorization(["department.update"], DEPARTMENT),
  deactivateDepartment: authorization(["department.deactivate"], DEPARTMENT),
  setDepartmentMembers: authorization(["department.members.manage"], DEPARTMENT),
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
  listUsers: authorization([], [...ROLE, "delegated MANAGER only sees operational-role targets in managed departments"], false, [], ["user_role.manage", "user.view"]),
  listSessions: authorization([], [...ROLE, "role must be ADMIN or SUPERADMIN"], false, [], ["user_role.manage", "user.view"]),
  createUser: authorization([], [...ROLE, "only SUPERADMIN may manage SUPERADMIN users", "delegated MANAGER only creates operational-role targets in managed departments", "granting ADMIN or SUPERADMIN requires recent reauthentication"], false, [], ["user_role.manage", "user.create"]),
  deactivateUser: authorization([], [...ROLE, "only SUPERADMIN may manage SUPERADMIN users", "actor cannot deactivate self; delegated MANAGER only deactivates operational-role targets in managed departments", "deactivating ADMIN or SUPERADMIN requires recent reauthentication"], false, [], ["user_role.manage", "user.deactivate"]),
  updateUserRole: authorization([], [...ROLE, "only SUPERADMIN may manage SUPERADMIN users", "actor cannot update self; delegated MANAGER must manage both current and proposed target role and department", "granting or removing ADMIN or SUPERADMIN requires recent reauthentication"], false, [{ when: "active is false", allOf: [], anyOf: ["user_role.manage", "user.deactivate"] }], ["user_role.manage", "user.update"]),
  updateUserOnCall: authorization([], [...ROLE, "only SUPERADMIN may manage SUPERADMIN users", "target must be active to go on call; delegated MANAGER only changes operational-role targets in managed departments"], false, [], ["user_role.manage", "user.update"]),
  regenerateUserPassword: authorization([], [...ROLE, "only SUPERADMIN may manage SUPERADMIN users", "actor cannot reset self; target must be active and within managed role and department scope", "regenerating an ADMIN or SUPERADMIN credential requires recent reauthentication"], false, [], ["user_role.manage", "user.update"]),
  issuePasswordResetLink: authorization([], [...ROLE, "only SUPERADMIN may manage SUPERADMIN users", "actor cannot reset self; target must be active and within managed role and department scope", "issuing a reset link for an ADMIN or SUPERADMIN requires recent reauthentication"], false, [], ["user_role.manage", "user.update"]),
  completePasswordReset: authorization([], []),
  revokeSession: authorization([], [...ROLE, "role must be ADMIN or SUPERADMIN"], false, [], ["user_role.manage", "user.update"]),
  listDiagnosticServices: authorization([], [...ROLE, "includeInactive=true requires a catalog write command instead of service.catalog.view", "MANAGER catalog visibility is limited to delegated departments"], false, [
    { when: "includeInactive is false or omitted", allOf: ["service.catalog.view"] },
    { when: "includeInactive is true", allOf: [], anyOf: ["service.catalog.manage", "service.catalog.create", "service.catalog.update", "service.catalog.deactivate"] }
  ]),
  getResultTemplate: authorization(["service.catalog.view"], SERVICE),
  createDiagnosticService: authorization([], DEPARTMENT, false, [], ["service.catalog.manage", "service.catalog.create"]),
  updateDiagnosticService: authorization([], DEPARTMENT, false, [
    { when: "active is false", allOf: [], anyOf: ["service.catalog.manage", "service.catalog.deactivate"] },
    { when: "catalog metadata is present or active is not false", allOf: [], anyOf: ["service.catalog.manage", "service.catalog.update"] }
  ], ["service.catalog.manage", "service.catalog.update", "service.catalog.deactivate"]),
  importDiagnosticServices: authorization([], DEPARTMENT, false, [
    { when: "an import row creates a service", allOf: [], anyOf: ["service.catalog.manage", "service.catalog.create"] },
    { when: "an import row updates metadata or reactivates a service", allOf: [], anyOf: ["service.catalog.manage", "service.catalog.update"] },
    { when: "an import row deactivates a service", allOf: [], anyOf: ["service.catalog.manage", "service.catalog.deactivate"] }
  ], ["service.catalog.manage", "service.catalog.create", "service.catalog.update", "service.catalog.deactivate"]),
  listReasonCodes: authorization(["reason_code.manage"], ROLE),
  createReasonCode: authorization(["reason_code.manage"], ROLE),
  updateReasonCode: authorization(["reason_code.manage"], ROLE),
  listPatients: authorization(["patient.view"], PATIENT),
  createPatient: authorization(["patient.create"], ROLE),
  getPatient: authorization(["patient.view"], PATIENT),
  getPatientDiagnostics: authorization(["patient.view", "diagnostic.timeline.view"], PATIENT),
  getPatientTimeline: authorization(["patient.view", "diagnostic.timeline.view"], [...PATIENT, "continuation cursor is bound to this patient and current authorized scope"]),
  listPatientArchive: authorization(["patient.view", "diagnostic.timeline.view"], PATIENT),
  getArchivedRequest: authorization(["request.view"], REQUEST),
  exportPatientData: authorization(["patient.data_export"], [...ROLE, "exporting a data subject's records requires recent reauthentication; every export is audited"]),
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
  cancelDiagnosticItem: authorization(["item.cancel"], [...DEPARTMENT, "patient access is global for SUPERADMIN; otherwise limited to patient scope or an authorized service/request context"]),
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
  downloadAttachment: authorization(["attachment.download", "attachment.view"], [...SERVICE, "patient access is global for SUPERADMIN; otherwise limited to patient scope or an authorized service/request context", "download is limited to released or superseded results and a finalized CLEAN attachment"]),
  getResult: authorization([], [...RESULT_SCOPE, "the result state selects result.view or result.draft.edit_own"], false, [
    { when: "versionId is omitted and current result version status is DRAFT and draft ownerId equals the actor id", allOf: ["result.draft.edit_own"] },
    { when: "versionId is omitted and current result version status is RELEASED", allOf: ["result.view"] },
    { when: "versionId selects a RELEASED, SUPERSEDED or VOIDED historical version of this result; response is read-only", allOf: ["result.history.view", "result.view"] }
  ]),
  listResultVersions: authorization(["result.history.view", "result.view"], [...SERVICE, "patient access is global for SUPERADMIN; otherwise limited to patient scope or an authorized service/request context"]),
  updateResultDraft: authorization(["result.draft.edit_own"], OWNER),
  releaseResult: authorization(["result.release"], SERVICE),
  amendResult: authorization(["result.amend"], RESULT_MUTATION),
  voidResult: authorization(["result.void"], RESULT_MUTATION),
  viewResult: authorization(["result.view", "result.view.record"], [...SERVICE, "patient access is global for SUPERADMIN; otherwise limited to patient scope or an authorized service/request context"]),
  reviewResult: authorization(["result.review"], [...SERVICE, "patient access is global for SUPERADMIN; otherwise limited to patient scope or an authorized service/request context"]),
  getReport: authorization(["attachment.view"], [...RESULT_SCOPE, "the result state selects result.view or result.draft.edit_own and attachment.view is always required"], false, [
    { when: "current result version status is DRAFT and draft ownerId equals the actor id", allOf: ["result.draft.edit_own"] },
    { when: "current result version status is RELEASED", allOf: ["result.view"] }
  ]),
  listAuditEvents: authorization(["audit.view"], DEPARTMENT),
  listNotifications: authorization(["notification.view"], [...ROLE, "only notifications whose result or request the actor can still open are listed"]),
  acknowledgeNotification: authorization(["notification.view", "notification.acknowledge"], [...ROLE, "notification must belong to the actor and its result or request stay open to them; a manager may use authorized request context"]),
  listQueueItems: authorization(["queue.view"], DEPARTMENT),
  searchDiagnostics: authorization(["search.execute"], REQUEST),
  getTimeline: authorization(["timeline.view"], REQUEST),
  getDashboard: authorization(["dashboard.view"], DEPARTMENT),
  getManagementOverview: authorization(["dashboard.view", "user_role.manage"], [...DEPARTMENT, "role must be MANAGER or SUPERADMIN"]),
  getCriticalReadiness: authorization(["critical_result_policy.manage"], [...ROLE, "role must be ADMIN or SUPERADMIN"]),
  listDeadLetters: authorization(["outbox.manage"], [...ROLE, "role must be ADMIN or SUPERADMIN"]),
  reprocessDeadLetter: authorization(["outbox.manage"], [...ROLE, "role must be ADMIN or SUPERADMIN"]),
  discardDeadLetter: authorization(["outbox.manage"], [...ROLE, "role must be ADMIN or SUPERADMIN"]),
  streamRealtimeEvents: authorization(["realtime.connect"], ROLE),
  verifyWhatsAppWebhook: authorization([], ["available only while WHATSAPP_ENABLED=true with WHATSAPP_VERIFY_TOKEN and WHATSAPP_APP_SECRET configured"]),
  receiveWhatsAppStatus: authorization([], ["available only while WHATSAPP_ENABLED=true with WHATSAPP_VERIFY_TOKEN and WHATSAPP_APP_SECRET configured", "X-Hub-Signature-256 must be the HMAC-SHA256 of the exact body under WHATSAPP_APP_SECRET"])
} satisfies Record<string, ApiAuthorization>);

const ERROR_STATUSES_BY_OPERATION = Object.freeze({
  ...hospitalCollaborationErrors,
  ...hospitalWorkErrors,
  ...hospitalExternalErrors,
  getAdmissionContextOptions: [400, 401, 404, 409, 429, 500],
  listHospitalPlannerOptions: [400, 401, 404, 429, 500],
  listHospitalPlans: [400, 401, 404, 429, 500], getHospitalPlan: [400, 401, 404, 429, 500],
  createHospitalPlan: [400, 401, 403, 404, 409, 415, 429, 500], updateHospitalPlan: [400, 401, 403, 404, 409, 415, 429, 500], putHospitalPlanLink: [400, 401, 403, 404, 409, 415, 429, 500], commandHospitalPlan: [400, 401, 403, 404, 409, 415, 429, 500],
  listHospitalShifts: [400, 401, 404, 429, 500], getHospitalShift: [400, 401, 404, 429, 500],
  createHospitalShift: [400, 401, 403, 404, 409, 415, 429, 500], updateHospitalShift: [400, 401, 403, 404, 409, 415, 429, 500], assignHospitalActivityShift: [400, 401, 403, 404, 409, 415, 429, 500],
  listHospitalHandoffs: [400, 401, 404, 429, 500], offerHospitalHandoff: [400, 401, 403, 404, 409, 415, 429, 500], decideHospitalHandoff: [400, 401, 403, 404, 409, 415, 429, 500],
  listHospitalChecklistTemplates: [400, 401, 404, 429, 500], createHospitalChecklistTemplate: [400, 401, 403, 404, 409, 415, 429, 500], updateHospitalChecklistTemplate: [400, 401, 403, 404, 409, 415, 429, 500], approveHospitalChecklistTemplate: [400, 401, 403, 404, 409, 415, 429, 500], retireHospitalChecklistTemplate: [400, 401, 403, 404, 409, 415, 429, 500], recordHospitalChecklistStep: [400, 401, 403, 404, 409, 415, 429, 500], executeHospitalCare: [400, 401, 403, 404, 409, 415, 422, 429, 500],
  listHospitalRecurrences: [400, 401, 404, 429, 500], createHospitalRecurrence: [400, 401, 403, 404, 409, 415, 429, 500], updateHospitalRecurrence: [400, 401, 403, 404, 409, 415, 429, 500], generateHospitalRecurrences: [400, 401, 403, 404, 409, 415, 429, 500],
  getHospitalResourceOptions: [400, 401, 404, 429, 500], listHospitalResources: [400, 401, 404, 429, 500], getHospitalResource: [400, 401, 404, 429, 500],
  createHospitalResource: [400, 401, 403, 404, 409, 415, 422, 429, 500], updateHospitalResource: [400, 401, 403, 404, 409, 415, 422, 429, 500],
  listHospitalCalendar: [400, 401, 404, 429, 500], reserveHospitalTaskSchedule: [400, 401, 403, 404, 409, 415, 422, 429, 500], rescheduleHospitalTaskSchedule: [400, 401, 403, 404, 409, 415, 422, 429, 500], cancelHospitalTaskSchedule: [400, 401, 403, 404, 409, 415, 429, 500],
  getBedCensus: [400, 401, 404, 429, 500], getHospitalCapacity: [400, 401, 404, 429, 500],
  listHospitalTaskTypes: [400, 401, 404, 429, 500],
  listHospitalTaskOptions: [400, 401, 404, 429, 500],
  listHospitalTasks: [400, 401, 404, 429, 500],
  getHospitalTask: [400, 401, 404, 429, 500],
  getHospitalTaskHistory: [400, 401, 404, 429, 500],
  getHospitalIntakeOptions: [400, 401, 404, 429, 500], listHospitalIntakes: [400, 401, 404, 429, 500],
  searchPlanner: [400, 401, 404, 429, 500],
  createHospitalTaskType: [400, 401, 403, 404, 409, 415, 429, 500],
  updateHospitalTaskType: [400, 401, 403, 404, 409, 415, 429, 500],
  createHospitalTask: [400, 401, 403, 404, 409, 415, 429, 500],
  updateHospitalTask: [400, 401, 403, 404, 409, 415, 429, 500],
  updateHospitalTaskContext: [400, 401, 403, 404, 409, 415, 429, 500],
  assignHospitalTask: [400, 401, 403, 404, 409, 415, 429, 500],
  reprioritizeHospitalTask: [400, 401, 403, 404, 409, 415, 429, 500],
  commandHospitalTask: [400, 401, 403, 404, 409, 415, 429, 500],
  putHospitalTaskDependency: [400, 401, 403, 404, 409, 415, 429, 500],
  createHospitalIntake: [400, 401, 403, 404, 409, 415, 429, 500],
  triageHospitalIntake: [400, 401, 403, 404, 409, 415, 429, 500],

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
  listHospitalServices: [400, 401, 404, 429, 500], getHospitalService: [401, 404, 429, 500], createHospitalService: [400, 401, 403, 404, 409, 415, 429, 500], updateHospitalService: [400, 401, 403, 404, 409, 415, 429, 500], importHospitalServices: [400, 401, 403, 404, 409, 415, 422, 429, 500],
  listPlannerViews: [401, 404, 429, 500], createPlannerView: [400, 401, 403, 404, 409, 415, 429, 500], updatePlannerView: [400, 401, 403, 404, 409, 415, 429, 500], deactivatePlannerView: [400, 401, 403, 404, 409, 415, 429, 500],
  listDiagnosticItemAssignees: [401, 404, 429, 500], assignDiagnosticItem: [400, 401, 403, 404, 409, 415, 429, 500], planDiagnosticItem: [400, 401, 403, 404, 409, 415, 429, 500], reprioritizeDiagnosticItem: [400, 401, 403, 404, 409, 415, 429, 500],
  listDelegablePermissions: [401, 404, 429, 500], listExamDefinitions: [401, 404, 429, 500],
  prepareExamTemplate: [400, 401, 403, 404, 409, 415, 422, 429, 500], publishExamTemplate: [400, 401, 403, 404, 409, 415, 422, 429, 500], retireExamTemplate: [400, 401, 403, 404, 409, 415, 422, 429, 500],
  listAccessGroups: [401, 404, 429, 500], createAccessGroup: [400, 401, 403, 404, 409, 415, 429, 500],
  updateAccessGroup: [400, 401, 403, 404, 409, 415, 429, 500], assignUserAccessGroup: [400, 401, 403, 404, 409, 415, 429, 500],
  previewAccessGroupImpact: [400, 401, 403, 404, 409, 415, 429, 500],
  previewUserAccess: [400, 401, 403, 404, 415, 429, 500], listPatientGrants: [401, 404, 429, 500], changePatientGrant: [400, 401, 404, 409, 415, 429, 500],
  listDepartments: [400, 401, 404, 429, 500], getDepartment: [401, 404, 429, 500],
  createDepartment: [400, 401, 404, 409, 415, 429, 500], updateDepartment: [400, 401, 404, 409, 415, 429, 500],
  deactivateDepartment: [400, 401, 404, 409, 415, 429, 500], setDepartmentMembers: [400, 401, 404, 409, 415, 429, 500],
  createPatient: [400, 401, 404, 409, 415, 429, 500], getPatient: [401, 404, 429, 500], getPatientDiagnostics: [400, 401, 404, 429, 500], getPatientTimeline: [400, 401, 404, 429, 500], listPatientArchive: [400, 401, 404, 429, 500], exportPatientData: [400, 401, 403, 404, 429, 500], getArchivedRequest: [401, 404, 429, 500],
  listPatientEncounters: [401, 404, 429, 500], openPatientEncounter: [400, 401, 404, 409, 415, 429, 500], closeEncounter: [400, 401, 404, 409, 415, 429, 500], getEncounter: [401, 404, 429, 500], getAdmission: [401, 404, 429, 500],
  updateAdmissionContext: [400, 401, 403, 404, 409, 415, 422, 429, 500, 503],
  listDiagnosticRequests: [400, 401, 404, 429, 500], createDiagnosticRequest: [400, 401, 403, 404, 409, 415, 429, 500],
  getDiagnosticRequest: [401, 404, 429, 500], cancelDiagnosticRequest: [400, 401, 403, 404, 409, 415, 429, 500],
  getDiagnosticItem: [401, 404, 429, 500], receiveDiagnosticItemSample: [400, 401, 403, 404, 409, 415, 429, 500],
  startDiagnosticItemProcessing: [400, 401, 403, 404, 409, 415, 429, 500], cancelDiagnosticItem: [400, 401, 403, 404, 409, 415, 429, 500],
  rejectDiagnosticItem: [400, 401, 403, 404, 409, 415, 429, 500], completeDiagnosticItem: [400, 401, 403, 404, 409, 415, 429, 500],
  scheduleDiagnosticItem: [400, 401, 403, 404, 409, 415, 422, 429, 500], startDiagnosticItemProcedure: [400, 401, 403, 404, 409, 415, 429, 500],
  markDiagnosticItemPerformed: [400, 401, 403, 404, 409, 415, 429, 500], requestDiagnosticItemRecollection: [400, 401, 403, 404, 409, 415, 429, 500],
  createDiagnosticItemResult: [400, 401, 403, 404, 409, 415, 422, 429, 500], receiveReplacementSample: [400, 401, 403, 404, 409, 415, 429, 500],
  getSampleLabel: [401, 404, 429, 500],
  rescheduleProcedure: [400, 401, 403, 404, 409, 415, 422, 429, 500], createAttachmentUploadSession: [400, 401, 403, 404, 409, 415, 429, 500],
  uploadAttachmentContent: [400, 401, 403, 404, 409, 415, 429, 500, 503], finalizeAttachment: [400, 401, 403, 404, 409, 415, 422, 429, 500],
  downloadAttachment: [401, 404, 429, 500, 503], getResult: [400, 401, 404, 429, 500], listResultVersions: [401, 404, 429, 500],
  updateResultDraft: [400, 401, 403, 404, 409, 415, 429, 500], releaseResult: [400, 401, 403, 404, 409, 415, 422, 429, 500],
  amendResult: [400, 401, 403, 404, 409, 415, 429, 500], voidResult: [400, 401, 403, 404, 409, 415, 429, 500],
  viewResult: [400, 401, 403, 404, 409, 415, 429, 500], reviewResult: [400, 401, 403, 404, 409, 415, 429, 500],
  getReport: [401, 404, 429, 500], listAuditEvents: [400, 401, 404, 429, 500], listNotifications: [400, 401, 404, 429, 500],
  acknowledgeNotification: [400, 401, 403, 404, 409, 415, 429, 500], listQueueItems: [400, 401, 404, 429, 500],
  searchDiagnostics: [400, 401, 404, 429, 500], getTimeline: [400, 401, 404, 429, 500], getDashboard: [401, 404, 429, 500],
  getManagementOverview: [401, 404, 429, 500], getCriticalReadiness: [401, 404, 429, 500], listDeadLetters: [400, 401, 403, 404, 429, 500], reprocessDeadLetter: [400, 401, 403, 404, 409, 415, 429, 500], discardDeadLetter: [400, 401, 403, 404, 409, 415, 429, 500], streamRealtimeEvents: [400, 401, 404, 429, 500],
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
