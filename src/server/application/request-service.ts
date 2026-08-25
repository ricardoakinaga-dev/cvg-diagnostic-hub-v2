import { createHash, randomUUID } from "node:crypto";
import { ITEM_STATES, PRIORITIES, ROLES } from "@cvg/contracts";
import type { ItemState, Permission, Priority, RoleCode, WorkflowType } from "@cvg/contracts";
import type { Admission, Attachment, AuditEvent, DiagnosticItem, DiagnosticRequest, DiagnosticService, Notification, Procedure, ProcedureSchedule, ReasonCode, Result, ResultVersion, Sample, StateStore, StoreState, User } from "../domain/models";
import type { CommandMeta, NotificationAcknowledgeInput, CreateRequestInput, ReceiveSampleInput, RecollectionInput, ResultDraftInput, ReleaseInput, ReviewInput, AmendInput, ScheduleInput, CancelInput, RejectInput, VoidInput, AttachmentUploadInput, DiagnosticServiceCreateInput, DiagnosticServicePatchInput, ReasonCodeCreateInput, ReasonCodePatchInput, UserRoleUpdateInput, ManagedUserCreateInput, ManagedUserDeactivateInput, ManagedUser, ManagementOverview, DashboardIndicatorKey, DashboardIndicator, DashboardWindow, DashboardView, RequestListFilters, SearchResultType, SearchFilters, SearchResult, TimelineFilters, TimelineResult, RequestView, ResultView, ItemView, SampleCommandResult, ResultDraftCommandResult, ResultReleaseCommandResult, ReviewCommandResult, ItemCommandResult, ProcedureScheduleCommandResult, ProcedureRescheduleCommandResult, ProcedureExecutionCommandResult, AmendCommandResult, VoidCommandResult, PublicAttachment, AttachmentSessionResult, AttachmentFinalizationResult, PatientDiagnosticsResult, ReportView } from "./service-types";
import { canAccessResource, managerCanAccessDepartment, managerDepartmentCodes } from "../security/authorization";
import { ApiError } from "../http/envelope";
import { hashPassword } from "../security/password";
import type { ApplicationServiceContext } from "./service-context";
import * as helpers from "./service-common";
const {
  MAX_NOTE_LENGTH,
  MAX_RESULT_NARRATIVE_LENGTH,
  MAX_ATTACHMENT_SIZE,
  DEFAULT_PAGE_SIZE,
  ALLOWED_ATTACHMENT_MIME,
  INDICATOR_DEFINITIONS,
  criticalPolicyIsReady,
  now,
  dashboardTimezone,
  managedUser,
  id,
  stableSerialize,
  hashPayload,
  idempotencyFingerprint,
  requireText,
  operationalManagedRoles,
  canManageUserTarget,
  normalizedEmail,
  validatedTimezone,
  validatedPassword,
  normalizedManagedDepartments,
  revokeUserSessions,
  requireRecentReauthentication,
  requireActiveUser,
  requirePermission,
  isExecutorRole,
  hasServicePatientContext,
  hasManagerRequestContext,
  hasManagerPatientContext,
  requirePatientPermission,
  requireRequestPermission,
  findOrThrow,
  createAudit,
  createOutbox,
  notificationFor,
  withIdempotency,
  saveIdempotency,
  requireIdempotencyKey,
  validatedSlaHours,
  validateServiceDefinition,
  serviceFor,
  requestFor,
  itemFor,
  resultFor,
  procedureFor,
  scheduleWindow,
  hasScheduleConflict,
  activeReason,
  attachmentFor,
  publicAttachment,
  safeAttachmentName,
  assertAttachmentMetadata,
  requireAttachmentOwner,
  attachmentSessionIsExpired,
  attachmentUploadClaimIsActive,
  attachmentStorageKeys,
  detectedMime,
  requestView,
  requestViewForActor,
  canViewRequest,
  requestForAuditEvent,
  auditEventItem,
  auditEventItemIds,
  auditEventDepartmentCode,
  canViewManagementAudit,
  requestForNotification,
  decodeKeysetCursor,
  decodeSearchCursor,
  decodeTimelineCursor,
  decodeRequestCursor,
  decodeAuditCursor,
  encodeKeysetCursor,
  pageSize,
  dateFilter,
  resultView,
  visibleResultVersions,
  requireCurrentResultRead,
  ensureExpectedVersion,
  calculateDueAt,
  nextRequestState,
  nextActionFor,
  deleteStoredObject,
  releaseUploadClaim,
  transitionItem,
} = helpers;

export function createRequestService({ store, storage }: ApplicationServiceContext) {
  const service = {
    async createRequest(actor: User, input: CreateRequestInput, meta: CommandMeta & { allowDuplicateOverride?: boolean } = {}): Promise<RequestView> {
      const scope = "POST:/diagnostic-requests";
      return store.transaction(async (originalState) => {
        const currentActor = requireActiveUser(originalState, actor);
        requirePermission(currentActor, "request.create", { patientId: input.patientId, departmentCode: currentActor.departmentCode });
        if (meta.allowDuplicateOverride) requireIdempotencyKey(meta.idempotencyKey);
        const idempotent = withIdempotency<RequestView>(originalState, currentActor.id, scope, meta.idempotencyKey, { input, allowDuplicateOverride: meta.allowDuplicateOverride });
        if (idempotent.found) return { state: originalState, result: idempotent.existing as RequestView };
        if (!input.patientId || !input.encounterId || !Array.isArray(input.items) || input.items.length < 1 || input.items.length > 20) {
          throw new ApiError("VALIDATION_ERROR", "Paciente, atendimento e pelo menos um serviço são obrigatórios.", 400);
        }
        const patient = findOrThrow(originalState.patients.find((entry) => entry.id === input.patientId));
        const encounter = findOrThrow(originalState.encounters.find((entry) => entry.id === input.encounterId));
        if (encounter.patientId !== patient.id) throw new ApiError("VALIDATION_ERROR", "Atendimento não pertence ao paciente informado.", 400);
        const admission = input.admissionId ? findOrThrow(originalState.admissions.find((entry) => entry.id === input.admissionId)) : undefined;
        if (admission && admission.encounterId !== encounter.id) throw new ApiError("VALIDATION_ERROR", "Internação não pertence ao atendimento informado.", 400);
        const services = input.items.map((entry) => serviceFor(originalState, entry.serviceId));
        const duplicateItems = originalState.items.filter((item) =>
          item.status !== "COMPLETED" && item.status !== "CANCELLED" && item.status !== "REJECTED" &&
          item.requestId && input.items.some((requested) => requested.serviceId === item.serviceId) &&
          originalState.requests.some((request) => request.id === item.requestId && request.patientId === patient.id)
        );
        if (duplicateItems.length > 0 && !meta.allowDuplicateOverride) {
          throw new ApiError("DUPLICATE_WARNING", "Já existe um exame ativo compatível para este paciente.", 409, {
            existingRequestCodes: duplicateItems.map((item) => requestFor(originalState, item.requestId).requestCode)
          });
        }
        const duplicateOverrideReason = meta.allowDuplicateOverride ? requireText(input.overrideReason ?? "", "overrideReason", 500) : undefined;
        if (meta.allowDuplicateOverride) {
          requirePermission(currentActor, "request.duplicate_override", { patientId: patient.id, departmentCode: currentActor.departmentCode });
        }
        const createdAt = now();
        const requestId = id("request");
        const requestCode = `EX-${createdAt.slice(2, 10).replace(/-/g, "")}-${String(originalState.protocolSequence).padStart(4, "0")}`;
        const request: DiagnosticRequest = {
          id: requestId,
          requestCode,
          patientId: patient.id,
          encounterId: encounter.id,
          admissionId: admission?.id,
          requesterId: currentActor.id,
          requestingDepartmentCode: currentActor.departmentCode,
          priority: input.priority,
          aggregateStatus: "REQUESTED",
          itemIds: [],
          createdAt,
          updatedAt: createdAt,
          version: 1
        };
        const items = input.items.map((entry, index) => {
          const service = services[index];
          const itemId = id("item");
          const note = entry.note ? requireText(entry.note, "note", MAX_NOTE_LENGTH) : undefined;
          return {
            id: itemId,
            requestId,
            serviceId: service.id,
            departmentCode: service.departmentCode,
            workflowType: service.workflowType,
            priority: input.priority,
            status: "REQUESTED" as const,
            note,
            requestedAt: createdAt,
            slaStartedAt: createdAt,
            dueAt: calculateDueAt(createdAt, service, input.priority),
            slaPolicyVersion: service.version,
            version: 1
          } satisfies DiagnosticItem;
        });
        const nextRequest = { ...request, itemIds: items.map((item) => item.id) };
        const correlationId = meta.correlationId ?? id("corr");
        const audits = [
          createAudit("DiagnosticRequestCreated", currentActor.id, "DiagnosticRequest", request.id, correlationId, undefined, "REQUESTED", { requestCode, ...(duplicateOverrideReason ? { duplicateOverride: true, overrideReason: duplicateOverrideReason } : {}) }),
          ...items.map((item) => createAudit("DiagnosticItemRequested", currentActor.id, "DiagnosticRequestItem", item.id, correlationId, undefined, item.status, { serviceCode: serviceFor(originalState, item.serviceId).code }))
        ];
        const nextState: StoreState = {
          ...originalState,
          protocolSequence: originalState.protocolSequence + 1,
          requests: [...originalState.requests, nextRequest],
          items: [...originalState.items, ...items],
          auditEvents: [...originalState.auditEvents, ...audits],
          outbox: [...originalState.outbox, createOutbox("DiagnosticRequestCreated", "DiagnosticRequest", request.id, correlationId, { requestCode })]
        };
        const response = requestView(nextState, nextRequest);
        return { state: saveIdempotency(nextState, currentActor.id, scope, meta.idempotencyKey, response, { input, allowDuplicateOverride: meta.allowDuplicateOverride }), result: response };
      });
    },

    async getRequest(actor: User, requestId: string): Promise<RequestView> {
      const state = await store.readState();
      const currentActor = requireActiveUser(state, actor);
      const request = requestFor(state, requestId);
      requireRequestPermission(state, currentActor, "request.view", request);
      return requestViewForActor(state, currentActor, request);
    },

    async getPatientDiagnostics(actor: User, patientId: string, filters: { limit?: number; cursor?: string } = {}): Promise<PatientDiagnosticsResult> {
      const state = await store.readState();
      const currentActor = requireActiveUser(state, actor);
      const patient = findOrThrow(state.patients.find((entry) => entry.id === patientId));
      const limit = pageSize(filters.limit);
      requirePatientPermission(state, currentActor, "patient.view", patient.id);
      requirePatientPermission(state, currentActor, "diagnostic.timeline.view", patient.id);
      const cursor = decodeRequestCursor(filters.cursor);
      const requests = state.requests
        .filter((request) => request.patientId === patient.id && canViewRequest(state, currentActor, request))
        .sort((left, right) => right.createdAt.localeCompare(left.createdAt) || left.id.localeCompare(right.id));
      const afterCursor = cursor ? requests.filter((request) => request.createdAt < cursor.createdAt || (request.createdAt === cursor.createdAt && request.id > cursor.id)) : requests;
      const pageRequests = afterCursor.slice(0, limit);
      const page = pageRequests.map((request) => requestViewForActor(state, currentActor, request));
      const visibleRequestIds = new Set(requests.map((request) => request.id));
      const visibleItemIds = new Set(requests.flatMap((request) => request.itemIds));
      const events = state.auditEvents
        .filter((event) => {
          const request = requestForAuditEvent(state, event);
          return request?.patientId === patient.id && (visibleRequestIds.has(request.id) || (event.entityType === "DiagnosticRequestItem" && visibleItemIds.has(event.entityId)));
        })
        .sort((left, right) => left.occurredAt.localeCompare(right.occurredAt));
      const last = pageRequests.at(-1);
      const nextCursor = last && pageRequests.length < afterCursor.length ? encodeKeysetCursor({ createdAt: last.createdAt, id: last.id }) : undefined;
      return { patient: { ...patient }, items: page, events, nextCursor, limit, total: requests.length };
    },

    async getItem(actor: User, itemId: string): Promise<ItemView> {
      const state = await store.readState();
      const currentActor = requireActiveUser(state, actor);
      const item = itemFor(state, itemId);
      const request = requestFor(state, item.requestId);
      const service = serviceFor(state, item.serviceId);
      if (isExecutorRole(currentActor)) {
        requirePermission(currentActor, "item.view", { departmentCode: service.departmentCode });
      } else if (currentActor.role === "MANAGER") {
        if (!hasManagerRequestContext(state, currentActor, request) || service.departmentCode !== currentActor.departmentCode) throw new ApiError("SCOPE_DENIED", "Você não tem acesso a este recurso.", 404);
        requirePermission(currentActor, "item.view", { departmentCode: service.departmentCode });
      } else {
        requirePermission(currentActor, "item.view", { patientId: request.patientId, departmentCode: request.requestingDepartmentCode });
      }
      const patient = findOrThrow(state.patients.find((entry) => entry.id === request.patientId));
      return { item, request: requestViewForActor(state, currentActor, request), patient, service };
    },

  };
  return service;
}
