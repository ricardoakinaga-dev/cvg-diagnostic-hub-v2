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

export function createReadService({ store, storage }: ApplicationServiceContext) {
  const service = {
    async listPatients(actor: User, query = "") {
      const state = await store.readState();
      const currentActor = requireActiveUser(state, actor);
      requirePermission(currentActor, "patient.view", {});
      const normalizedQuery = query.trim().toLocaleLowerCase("pt-BR");
      if (Array.from(normalizedQuery).length > 200) throw new ApiError("VALIDATION_ERROR", "A busca de pacientes é muito longa.", 400);
      return state.patients
        .filter((patient) => currentActor.role === "MANAGER" ? hasManagerPatientContext(state, currentActor, patient.id) : Boolean(currentActor.patientIds?.includes(patient.id)) || (isExecutorRole(currentActor) && hasServicePatientContext(state, currentActor, patient.id)))
        .filter((patient) => !normalizedQuery || [patient.displayName, patient.externalId, patient.species, patient.ownerLabel].some((field) => field.toLocaleLowerCase("pt-BR").includes(normalizedQuery)))
        .map((patient) => ({ ...patient }))
        .slice(0, 100);
    },

    async listAuditEvents(actor: User, filters: { limit?: number; cursor?: string } = {}) {
      const state = await store.readState();
      const currentActor = requireActiveUser(state, actor);
      requirePermission(currentActor, "audit.view", { departmentCode: currentActor.departmentCode });
      const limit = pageSize(filters.limit);
      const cursor = decodeAuditCursor(filters.cursor);
      const events = state.auditEvents
        .filter((event) => {
          const request = requestForAuditEvent(state, event);
          if (!request) return currentActor.role === "ADMIN" || (currentActor.role === "MANAGER" && canViewManagementAudit(state, currentActor, event));
          const eventDepartmentCode = auditEventDepartmentCode(state, event);
          if (currentActor.role === "MANAGER" && eventDepartmentCode && !managerCanAccessDepartment(currentActor, eventDepartmentCode)) return false;
          return canViewRequest(state, currentActor, request);
        })
        .sort((left, right) => right.occurredAt.localeCompare(left.occurredAt) || left.id.localeCompare(right.id));
      const afterCursor = cursor ? events.filter((event) => event.occurredAt < cursor.occurredAt || (event.occurredAt === cursor.occurredAt && event.id > cursor.id)) : events;
      const page = afterCursor.slice(0, limit);
      const items = page.map((event) => ({ ...event, metadata: { ...event.metadata } }));
      const last = page.at(-1);
      const nextCursor = last && page.length < afterCursor.length ? encodeKeysetCursor({ occurredAt: last.occurredAt, id: last.id }) : undefined;
      return { items, nextCursor, limit, total: events.length };
    },

    async getPatient(actor: User, patientId: string) {
      const state = await store.readState();
      const currentActor = requireActiveUser(state, actor);
      const patient = findOrThrow(state.patients.find((entry) => entry.id === patientId));
      requirePatientPermission(state, currentActor, "patient.view", patient.id);
      return patient;
    },

    async listEncounters(actor: User, patientId: string) {
      const state = await store.readState();
      const currentActor = requireActiveUser(state, actor);
      const patient = findOrThrow(state.patients.find((entry) => entry.id === patientId));
      requirePatientPermission(state, currentActor, "encounter.view", patient.id);
      return state.encounters.filter((encounter) => encounter.patientId === patient.id).map((encounter) => ({ ...encounter }));
    },

    async getEncounter(actor: User, encounterId: string) {
      const state = await store.readState();
      const currentActor = requireActiveUser(state, actor);
      const encounter = findOrThrow(state.encounters.find((entry) => entry.id === encounterId));
      requirePatientPermission(state, currentActor, "encounter.view", encounter.patientId);
      return encounter;
    },

    async getAdmission(actor: User, admissionId: string): Promise<Admission> {
      const state = await store.readState();
      const currentActor = requireActiveUser(state, actor);
      const admission = findOrThrow(state.admissions.find((entry) => entry.id === admissionId));
      const encounter = findOrThrow(state.encounters.find((entry) => entry.id === admission.encounterId));
      requirePatientPermission(state, currentActor, "admission.view", encounter.patientId);
      return admission;
    },

    async listRequests(actor: User, filters: RequestListFilters = {}) {
      const state = await store.readState();
      const currentActor = requireActiveUser(state, actor);
      requirePermission(currentActor, "request.list", {});
      if (filters.status && !ITEM_STATES.includes(filters.status)) throw new ApiError("VALIDATION_ERROR", "O status informado é inválido.", 400);
      if (filters.priority && !PRIORITIES.includes(filters.priority)) throw new ApiError("VALIDATION_ERROR", "A prioridade informada é inválida.", 400);
      const limit = pageSize(filters.limit);
      const cursor = decodeRequestCursor(filters.cursor);
      const departmentCode = filters.departmentCode?.trim().toUpperCase();
      if (departmentCode && !/^[A-Z0-9_-]{1,60}$/.test(departmentCode)) throw new ApiError("VALIDATION_ERROR", "O departamento informado é inválido.", 400);
      const serviceId = filters.serviceId?.trim();
      if (serviceId && (serviceId.length > 100 || !/^[A-Za-z0-9_-]+$/.test(serviceId))) throw new ApiError("VALIDATION_ERROR", "O serviço informado é inválido.", 400);
      const from = dateFilter(filters.from, "from");
      const to = dateFilter(filters.to, "to");
      if (from !== undefined && to !== undefined && from > to) throw new ApiError("VALIDATION_ERROR", "O intervalo de datas é inválido.", 400);
      const currentTime = Date.now();
      const requests = state.requests
        .filter((request) => (from === undefined || Date.parse(request.createdAt) >= from) && (to === undefined || Date.parse(request.createdAt) <= to))
        .filter((request) => request.itemIds.some((itemId) => {
          const item = itemFor(state, itemId);
          const service = serviceFor(state, item.serviceId);
          const visibleByPatient = canViewRequest(state, currentActor, request) || Boolean(currentActor.patientIds?.includes(request.patientId));
          const visibleByService = ["LAB_TECH", "RADIOLOGY_TEAM", "ULTRASOUND_TEAM"].includes(currentActor.role) && service.departmentCode === currentActor.departmentCode;
          const managerItemScope = currentActor.role !== "MANAGER" || managerCanAccessDepartment(currentActor, item.departmentCode);
          const overdue = new Date(item.dueAt).getTime() < currentTime && !["COMPLETED", "CANCELLED", "REJECTED"].includes(item.status);
          return (visibleByPatient || visibleByService) && managerItemScope &&
            (!filters.status || item.status === filters.status) &&
            (!departmentCode || item.departmentCode === departmentCode) &&
            (!filters.priority || item.priority === filters.priority) &&
            (!serviceId || item.serviceId === serviceId) &&
            (filters.overdue === undefined || overdue === filters.overdue);
        }))
        .sort((left, right) => right.createdAt.localeCompare(left.createdAt) || left.id.localeCompare(right.id));
      const afterCursor = cursor ? requests.filter((request) => request.createdAt < cursor.createdAt || (request.createdAt === cursor.createdAt && request.id > cursor.id)) : requests;
      const pageRequests = afterCursor.slice(0, limit);
      const page = pageRequests.map((request) => requestViewForActor(state, currentActor, request));
      const last = pageRequests.at(-1);
      const nextCursor = last && pageRequests.length < afterCursor.length ? encodeKeysetCursor({ createdAt: last.createdAt, id: last.id }) : undefined;
      return { items: page, nextCursor, limit, total: requests.length };
    },

    async listNotifications(
      actor: User,
      filter: "ALL" | "UNREAD" | "ACTIONABLE" | "CRITICAL" = "ALL",
      options: { cursor?: string; limit?: number } = {}
    ) {
      const state = await store.readState();
      const currentActor = requireActiveUser(state, actor);
      requirePermission(currentActor, "notification.view", {});
      if (!["ALL", "UNREAD", "ACTIONABLE", "CRITICAL"].includes(filter)) throw new ApiError("VALIDATION_ERROR", "O filtro de notificações é inválido.", 400);
      const limit = pageSize(options.limit);
      const cursor = decodeRequestCursor(options.cursor);
      const notifications = state.notifications
        .filter((notification) => notification.recipientUserId === currentActor.id)
        .filter((notification) => filter === "ALL" || (filter === "UNREAD" && notification.state !== "SEEN" && notification.state !== "ACKNOWLEDGED" && notification.state !== "SUPERSEDED") || (filter === "ACTIONABLE" && notification.category === "ACTIONABLE") || (filter === "CRITICAL" && notification.category === "CRITICAL"))
        .sort((left, right) => right.createdAt.localeCompare(left.createdAt) || left.id.localeCompare(right.id));
      const afterCursor = cursor
        ? notifications.filter((notification) => notification.createdAt < cursor.createdAt || (notification.createdAt === cursor.createdAt && notification.id > cursor.id))
        : notifications;
      const items = afterCursor.slice(0, limit);
      const last = items.at(-1);
      const nextCursor = last && items.length < afterCursor.length ? encodeKeysetCursor({ createdAt: last.createdAt, id: last.id }) : undefined;
      return { items, nextCursor, limit, total: notifications.length };
    },

    async acknowledgeNotification(actor: User, notificationId: string, input: NotificationAcknowledgeInput) {
      const scope = "POST:/notifications/acknowledge";
      return store.transaction(async (originalState) => {
        const currentActor = requireActiveUser(originalState, actor);
        requireIdempotencyKey(input.idempotencyKey);
        requirePermission(currentActor, "notification.view", {});
        requirePermission(currentActor, "notification.acknowledge", {});
        if (input.confirm !== true) throw new ApiError("VALIDATION_ERROR", "A confirmação explícita é obrigatória.", 400);
        const reason = requireText(input.reason, "reason", 500);
        const idempotent = withIdempotency(originalState, currentActor.id, scope, input.idempotencyKey, { notificationId, input });
        if (idempotent.found) return { state: originalState, result: idempotent.existing! };
        const notification = findOrThrow(originalState.notifications.find((entry) => entry.id === notificationId));
        ensureExpectedVersion(notification.version, input.expectedVersion);
        if (notification.category === "CRITICAL" && notification.entityType === "RESULT_VERSION") {
          const version = originalState.resultVersions.find((entry) => entry.id === notification.entityId);
          const result = version && originalState.results.find((entry) => entry.id === version.resultId);
          if (!version || !result || result.currentVersionId !== version.id || version.status !== "RELEASED") {
            throw new ApiError("NOTIFICATION_STALE", "O resultado crítico mudou; abra o contexto atual antes de confirmar.", 409, { retryable: false });
          }
        }
        if (notification.state !== "DELIVERED" && notification.state !== "SEEN") {
          throw new ApiError("NOTIFICATION_NOT_DELIVERED", "A notificação ainda não foi entregue pelo canal operacional.", 409, { retryable: true });
        }
        if (notification.recipientUserId !== currentActor.id) {
          const request = requestForNotification(originalState, notification);
          if (currentActor.role !== "MANAGER" || !request || !hasManagerRequestContext(originalState, currentActor, request)) throw new ApiError("NOT_FOUND", "Notificação não encontrada.", 404);
        }
        const acknowledgedAt = now();
        const updated = { ...notification, state: "ACKNOWLEDGED" as const, acknowledgedAt, acknowledgedBy: currentActor.id, version: notification.version + 1 };
        const correlationId = input.correlationId ?? id("corr");
        const nextState = { ...originalState, notifications: originalState.notifications.map((entry) => entry.id === notification.id ? updated : entry), auditEvents: [...originalState.auditEvents, createAudit("NotificationAcknowledged", currentActor.id, "Notification", notification.id, correlationId, notification.state, "ACKNOWLEDGED", { reason })] };
        const result = updated;
        return { state: saveIdempotency(nextState, currentActor.id, scope, input.idempotencyKey, result, { notificationId, input }), result };
      });
    },

    async listQueue(actor: User, departmentCode: string, filters: { status?: ItemState; overdue?: boolean; limit?: number } = {}) {
      const state = await store.readState();
      const currentActor = requireActiveUser(state, actor);
      const normalizedDepartment = departmentCode.trim().toUpperCase();
      if (!/^[A-Z0-9_-]{1,60}$/.test(normalizedDepartment)) throw new ApiError("VALIDATION_ERROR", "O departamento informado é inválido.", 400);
      requirePermission(currentActor, "queue.view", { departmentCode: normalizedDepartment });
      if (currentActor.role !== "MANAGER" && currentActor.departmentCode !== normalizedDepartment) throw new ApiError("NOT_FOUND", "Fila não encontrada.", 404);
      const currentTime = Date.now();
      const priorityRank: Record<Priority, number> = { EMERGENCY: 0, URGENT: 1, ROUTINE: 2 };
      const items = state.items
        .filter((item) => item.departmentCode === normalizedDepartment)
        .filter((item) => !filters.status || item.status === filters.status)
        .filter((item) => filters.overdue === undefined || (new Date(item.dueAt).getTime() < currentTime && !["COMPLETED", "CANCELLED", "REJECTED"].includes(item.status)) === filters.overdue)
        .sort((left, right) => priorityRank[left.priority] - priorityRank[right.priority] || left.dueAt.localeCompare(right.dueAt))
        .slice(0, pageSize(filters.limit));
      return items.map((item) => {
        const request = requestFor(state, item.requestId);
        const patient = findOrThrow(state.patients.find((entry) => entry.id === request.patientId));
        const service = serviceFor(state, item.serviceId);
        const procedure = item.procedureId ? state.procedures.find((entry) => entry.id === item.procedureId) : undefined;
        return { ...item, ...(procedure ? { procedureVersion: procedure.version } : {}), requestId: request.id, requestCode: request.requestCode, patient: { id: patient.id, displayName: patient.displayName, species: patient.species, sex: patient.sex, externalId: patient.externalId }, service: { id: service.id, code: service.code, name: service.name }, overdue: new Date(item.dueAt).getTime() < currentTime && !["COMPLETED", "CANCELLED", "REJECTED"].includes(item.status), nextAction: nextActionFor(item, service) };
      });
    },

    async search(actor: User, query: string, filters: SearchFilters = {}) {
      const normalized = query.trim().toLocaleLowerCase("pt-BR");
      const boundedLimit = pageSize(filters.limit);
      const cursor = decodeSearchCursor(filters.cursor);
      if (Array.from(normalized).length < 2) throw new ApiError("VALIDATION_ERROR", "Digite pelo menos 2 caracteres ou use um protocolo completo.", 400);
      const state = await store.readState();
      const currentActor = requireActiveUser(state, actor);
      requirePermission(currentActor, "search.execute", {});
      if (filters.status && !ITEM_STATES.includes(filters.status)) throw new ApiError("VALIDATION_ERROR", "O status informado é inválido.", 400);
      const departmentCode = filters.departmentCode?.trim().toUpperCase();
      if (departmentCode && !/^[A-Z0-9_-]{1,60}$/.test(departmentCode)) throw new ApiError("VALIDATION_ERROR", "O setor informado é inválido.", 400);
      const from = dateFilter(filters.from, "from");
      const to = dateFilter(filters.to, "to");
      if (from !== undefined && to !== undefined && from > to) throw new ApiError("VALIDATION_ERROR", "O intervalo de datas é inválido.", 400);
      const requestedTypes = filters.types?.length ? new Set(filters.types) : new Set<SearchResultType>(["REQUEST"]);
      if ([...requestedTypes].some((type) => !["REQUEST", "ITEM"].includes(type))) throw new ApiError("VALIDATION_ERROR", "O tipo de busca é inválido.", 400);
      const rankFor = (fields: string[]): number | undefined => {
        const normalizedFields = fields.map((field) => field.toLocaleLowerCase("pt-BR"));
        if (normalizedFields.some((field) => field === normalized)) return 0;
        if (normalizedFields.some((field) => field.startsWith(normalized))) return 1;
        if (normalizedFields.some((field) => field.includes(normalized))) return 2;
        return undefined;
      };
      const ranked: Array<{ result: SearchResult; rank: number }> = [];
      for (const request of state.requests) {
        if ((from !== undefined && Date.parse(request.createdAt) < from) || (to !== undefined && Date.parse(request.createdAt) > to)) continue;
        const items = request.itemIds.map((itemId) => itemFor(state, itemId));
        const visibleItems = items.filter((item) => {
          const service = serviceFor(state, item.serviceId);
          const visibleByRequest = canViewRequest(state, currentActor, request) || currentActor.patientIds?.includes(request.patientId);
          const visibleByService = ["LAB_TECH", "RADIOLOGY_TEAM", "ULTRASOUND_TEAM"].includes(currentActor.role) && service.departmentCode === currentActor.departmentCode;
          const managerItemScope = currentActor.role !== "MANAGER" || managerCanAccessDepartment(currentActor, service.departmentCode);
          const visible = Boolean(visibleByRequest || visibleByService) && managerItemScope;
          return visible && (!filters.status || item.status === filters.status) && (!departmentCode || item.departmentCode === departmentCode);
        });
        if (!visibleItems.length) continue;
        const patient = findOrThrow(state.patients.find((entry) => entry.id === request.patientId));
        const requester = state.users.find((user) => user.id === request.requesterId);
        const visibleEntityIds = new Set([request.id, ...visibleItems.map((item) => item.id)]);
        const reviewerFields = state.auditEvents
          .filter((event) => visibleEntityIds.has(event.entityId) && event.actorId)
          .flatMap((event) => {
            const user = state.users.find((entry) => entry.id === event.actorId);
            return [event.actorId!, user?.displayName ?? "", user?.email ?? ""];
          });
        const requestFields = [request.requestCode, patient.displayName, patient.ownerLabel, patient.externalId, request.requesterId, requester?.displayName ?? "", requester?.email ?? "", ...reviewerFields];
        const requestRank = rankFor(requestFields);
        if (requestRank !== undefined && requestedTypes.has("REQUEST")) {
          ranked.push({
            rank: requestRank,
            result: {
              type: "REQUEST",
              id: request.id,
              label: request.requestCode,
              patient: patient.displayName,
              status: request.aggregateStatus,
              priority: request.priority,
              updatedAt: request.updatedAt,
              departmentCode: visibleItems[0].departmentCode,
              deepLink: `/requests/${request.id}`
            }
          });
        }
        if (requestedTypes.has("ITEM")) {
          for (const item of visibleItems) {
            const service = serviceFor(state, item.serviceId);
            const sampleFields = state.samples.filter((sample) => sample.itemIds.includes(item.id)).map((sample) => sample.accessionCode);
            const itemRank = rankFor([item.id, item.departmentCode, service.id, service.code, service.name, ...sampleFields]);
            if (itemRank === undefined) continue;
            ranked.push({
              rank: itemRank,
              result: {
                type: "ITEM",
                id: item.id,
                label: `${service.code} · ${request.requestCode}`,
                patient: patient.displayName,
                status: item.status,
                priority: item.priority,
                updatedAt: request.updatedAt,
                departmentCode: item.departmentCode,
                deepLink: `/requests/${request.id}#${item.id}`
              }
            });
          }
        }
      }
      const sorted = ranked.sort((left, right) => left.rank - right.rank || right.result.updatedAt.localeCompare(left.result.updatedAt) || left.result.id.localeCompare(right.result.id));
      const afterCursor = cursor
        ? sorted.filter((entry) => entry.rank > cursor.rank || (entry.rank === cursor.rank && (entry.result.updatedAt < cursor.updatedAt || (entry.result.updatedAt === cursor.updatedAt && entry.result.id > cursor.id))))
        : sorted;
      const page = afterCursor.slice(0, boundedLimit);
      const last = page.at(-1);
      const nextCursor = last && page.length < afterCursor.length ? encodeKeysetCursor({ rank: last.rank, updatedAt: last.result.updatedAt, id: last.result.id }) : undefined;
      return { items: page.map((entry) => entry.result), nextCursor, limit: boundedLimit, total: sorted.length };
    },

    async timeline(actor: User, requestId?: string, itemId?: string, filters: TimelineFilters = {}): Promise<TimelineResult> {
      const state = await store.readState();
      const currentActor = requireActiveUser(state, actor);
      const item = itemId ? itemFor(state, itemId) : undefined;
      const request = requestId ? requestFor(state, requestId) : item ? requestFor(state, item.requestId) : undefined;
      if (!request) throw new ApiError("VALIDATION_ERROR", "Informe requestId ou itemId.", 400);
      if (item && item.requestId !== request.id) throw new ApiError("NOT_FOUND", "A solicitação e o item não pertencem ao mesmo contexto.", 404);
      requireRequestPermission(state, currentActor, "timeline.view", request);
      const visibleItemIds = isExecutorRole(currentActor)
        ? request.itemIds.filter((entryId) => itemFor(state, entryId).departmentCode === currentActor.departmentCode)
        : currentActor.role === "MANAGER"
          ? request.itemIds.filter((entryId) => managerCanAccessDepartment(currentActor, itemFor(state, entryId).departmentCode))
          : request.itemIds;
      const limit = pageSize(filters.limit);
      const cursor = decodeTimelineCursor(filters.cursor);
      const events = state.auditEvents
        .filter((event) => {
          const eventRequest = requestForAuditEvent(state, event);
          if (!eventRequest || eventRequest.id !== request.id) return false;
          const eventItemIds = auditEventItemIds(state, event);
          return eventItemIds.length === 0 || eventItemIds.some((eventItemId) => visibleItemIds.includes(eventItemId));
        })
        .sort((left, right) => left.occurredAt.localeCompare(right.occurredAt) || left.id.localeCompare(right.id));
      const afterCursor = cursor
        ? events.filter((event) => event.occurredAt > cursor.occurredAt || (event.occurredAt === cursor.occurredAt && event.id > cursor.id))
        : events;
      const page = afterCursor.slice(0, limit);
      const last = page.at(-1);
      const nextCursor = last && page.length < afterCursor.length ? encodeKeysetCursor({ occurredAt: last.occurredAt, id: last.id }) : undefined;
      const items = page.map((event) => ({ ...event, metadata: { ...event.metadata } }));
      return { items, nextCursor, limit, total: events.length };
    },

    async dashboard(actor: User): Promise<DashboardView> {
      const state = await store.readState();
      const currentActor = requireActiveUser(state, actor);
      requirePermission(currentActor, "dashboard.view", { departmentCode: currentActor.departmentCode });
      const visibleItems = state.items.filter((item) => {
        const request = requestFor(state, item.requestId);
        const service = serviceFor(state, item.serviceId);
        if (currentActor.role === "MANAGER") return managerCanAccessDepartment(currentActor, item.departmentCode);
        return Boolean(currentActor.patientIds?.includes(request.patientId)) || (["LAB_TECH", "RADIOLOGY_TEAM", "ULTRASOUND_TEAM"].includes(currentActor.role) && service.departmentCode === currentActor.departmentCode);
      });
      const asOf = now();
      const currentTime = Date.parse(asOf);
      const terminalStatuses = new Set(["COMPLETED", "CANCELLED", "REJECTED"]);
      const activeItems = visibleItems.filter((item) => !terminalStatuses.has(item.status));
      const laboratoryItems = visibleItems.filter((item) => item.workflowType === "LABORATORY");
      const criticalNotifications = state.notifications.filter((notification) => notification.recipientUserId === currentActor.id && notification.category === "CRITICAL");
      const overdue = activeItems.filter((item) => new Date(item.dueAt).getTime() < currentTime).length;
      const recollections = visibleItems.filter((item) => item.status === "RECOLLECTION_REQUIRED").length;
      const newResults = visibleItems.filter((item) => item.status === "RESULT_AVAILABLE").length;
      const critical = criticalNotifications.filter((notification) => notification.state !== "ACKNOWLEDGED").length;
      const totalActive = activeItems.length;
      const counts: Record<DashboardIndicatorKey, number> = { overdue, recollections, newResults, critical, totalActive };
      const denominators: Record<DashboardIndicatorKey, number> = {
        overdue: totalActive,
        recollections: laboratoryItems.length,
        newResults: visibleItems.length,
        critical: criticalNotifications.length,
        totalActive: visibleItems.length
      };
      const indicators = (Object.keys(INDICATOR_DEFINITIONS) as DashboardIndicatorKey[]).map((key) => ({
        key,
        count: counts[key],
        denominator: denominators[key],
        ...INDICATOR_DEFINITIONS[key]
      }));
      const window: DashboardWindow = { kind: "CURRENT_STATE", label: "Estado atual", timezone: dashboardTimezone(currentActor), asOf };
      return { overdue, recollections, newResults, critical, totalActive, updatedAt: asOf, window, indicators };
    },

    async managementOverview(actor: User): Promise<ManagementOverview> {
      const state = await store.readState();
      const currentActor = requireActiveUser(state, actor);
      if (currentActor.role !== "MANAGER") throw new ApiError("SCOPE_DENIED", "Este centro é exclusivo da gestão operacional.", 404);
      requirePermission(currentActor, "dashboard.view", { departmentCode: currentActor.departmentCode });
      requirePermission(currentActor, "user_role.manage", { departmentCode: currentActor.departmentCode });
      const asOf = now();
      const currentTime = Date.parse(asOf);
      const terminalStatuses = new Set<ItemState>(["COMPLETED", "CANCELLED", "REJECTED"]);
      const visibleItems = state.items
        .filter((item) => managerCanAccessDepartment(currentActor, item.departmentCode))
        .map((item) => ({ item, request: requestFor(state, item.requestId), service: findOrThrow(state.services.find((entry) => entry.id === item.serviceId)) }));
      const activeItems = visibleItems.filter(({ item }) => !terminalStatuses.has(item.status));
      const visibleRequestIds = new Set(visibleItems.map(({ request }) => request.id));
      const overdueItems = activeItems.filter(({ item }) => Date.parse(item.dueAt) < currentTime);
      const pendingItems = activeItems
        .slice()
        .sort((left, right) => {
          const priorityRank: Record<Priority, number> = { EMERGENCY: 0, URGENT: 1, ROUTINE: 2 };
          return priorityRank[left.item.priority] - priorityRank[right.item.priority] || left.item.dueAt.localeCompare(right.item.dueAt);
        });
      const critical = state.notifications.filter((notification) => {
        if (notification.category !== "CRITICAL" || notification.state === "ACKNOWLEDGED" || notification.state === "SUPERSEDED") return false;
        const request = requestForNotification(state, notification);
        return Boolean(request && request.itemIds.some((itemId) => managerCanAccessDepartment(currentActor, itemFor(state, itemId).departmentCode)));
      }).length;
      const departments = managerDepartmentCodes(currentActor)
        .filter((departmentCode) => state.services.some((service) => service.departmentCode === departmentCode))
        .sort()
        .map((departmentCode) => {
          const departmentItems = visibleItems.filter(({ item }) => item.departmentCode === departmentCode);
          const departmentRequests = new Set(departmentItems.map(({ request }) => request.id));
          return {
            departmentCode,
            serviceCount: state.services.filter((service) => service.departmentCode === departmentCode && service.active).length,
            totalRequests: departmentRequests.size,
            activeItems: departmentItems.filter(({ item }) => !terminalStatuses.has(item.status)).length,
            overdue: departmentItems.filter(({ item }) => !terminalStatuses.has(item.status) && Date.parse(item.dueAt) < currentTime).length,
            pending: departmentItems.filter(({ item }) => !terminalStatuses.has(item.status)).length
          };
        });
      const today = asOf.slice(0, 10);
      const recentRequests = Array.from(visibleRequestIds)
        .map((requestId) => requestFor(state, requestId))
        .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
        .slice(0, 12)
        .map((request) => ({
          id: request.id,
          requestCode: request.requestCode,
          patient: findOrThrow(state.patients.find((patient) => patient.id === request.patientId)).displayName,
          aggregateStatus: request.aggregateStatus,
          priority: request.priority,
          updatedAt: request.updatedAt,
          itemCount: request.itemIds.filter((itemId) => managerCanAccessDepartment(currentActor, itemFor(state, itemId).departmentCode)).length,
          deepLink: `/requests/${request.id}`
        }));
      return {
        asOf,
        scope: { departments: managerDepartmentCodes(currentActor), label: managerDepartmentCodes(currentActor).join(" · ") },
        summary: {
          totalRequests: visibleRequestIds.size,
          activeItems: activeItems.length,
          overdue: overdueItems.length,
          recollections: visibleItems.filter(({ item }) => item.status === "RECOLLECTION_REQUIRED").length,
          newResults: visibleItems.filter(({ item }) => item.status === "RESULT_AVAILABLE").length,
          critical,
          pendingRequests: new Set(activeItems.map(({ request }) => request.id)).size,
          completedToday: visibleItems.filter(({ item }) => item.completedAt?.slice(0, 10) === today).length
        },
        departments,
        pending: pendingItems.slice(0, 50).map(({ item, request, service }) => ({
          id: item.id,
          requestId: request.id,
          requestCode: request.requestCode,
          patient: findOrThrow(state.patients.find((patient) => patient.id === request.patientId)).displayName,
          service: service.name,
          departmentCode: item.departmentCode,
          status: item.status,
          priority: item.priority,
          dueAt: item.dueAt,
          overdue: Date.parse(item.dueAt) < currentTime,
          nextAction: nextActionFor(item, service),
          deepLink: `/requests/${request.id}#${item.id}`
        })),
        recentRequests
      };
    }
  };
  return service;
}
