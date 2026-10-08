import { createHash, randomUUID } from "node:crypto";
import { ITEM_STATES, PRIORITIES, ROLES } from "@cvg/contracts";
import type { ItemState, Permission, Priority, RoleCode, WorkflowType } from "@cvg/contracts";
import type { Admission, Attachment, AuditEvent, DiagnosticItem, DiagnosticRequest, DiagnosticService, Notification, Procedure, ProcedureSchedule, ReasonCode, Result, ResultVersion, Sample, StateStore, StoreState, User } from "../domain/models";
import type { CommandMeta, NotificationAcknowledgeInput, CreateRequestInput, ReceiveSampleInput, RecollectionInput, ResultDraftInput, ReleaseInput, ReviewInput, AmendInput, ScheduleInput, CancelInput, RejectInput, VoidInput, AttachmentUploadInput, DiagnosticServiceCreateInput, DiagnosticServicePatchInput, ReasonCodeCreateInput, ReasonCodePatchInput, UserRoleUpdateInput, ManagedUserCreateInput, ManagedUserDeactivateInput, ManagedUser, ManagementOverview, DashboardIndicatorKey, DashboardIndicator, DashboardWindow, DashboardView, QueueItemView, RequestListFilters, SearchResultType, SearchFilters, SearchResult, TimelineFilters, TimelineResult, RequestView, ResultView, ItemView, SampleCommandResult, ResultDraftCommandResult, ResultReleaseCommandResult, ReviewCommandResult, ItemCommandResult, ProcedureScheduleCommandResult, ProcedureRescheduleCommandResult, ProcedureExecutionCommandResult, AmendCommandResult, VoidCommandResult, PublicAttachment, AttachmentSessionResult, AttachmentFinalizationResult, PatientDiagnosticsResult, ReportView } from "./service-types";
import { canAccessResource, managerCanAccessDepartment, managerDepartmentCodes } from "../security/authorization";
import { ApiError } from "../http/envelope";
import { hashPassword } from "../security/password";
import type { ApplicationServiceContext } from "./service-context";
import { decodeQueueCursor, encodeQueueCursor } from "./queue-pagination";
import * as helpers from "./service-common";
import { auditScopeForActor, requestAuditScope } from "./audit-read";
import { encountersForPatient, findById, samplesForItem } from "../domain/state-index";
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
  findOrThrowScoped,
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
  canViewItem,
  requireItemPermission,
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
  operationalContextFor,
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
      const page = await store.readAuditEvents({ scope: auditScopeForActor(state, currentActor), order: "desc", limit, cursor });
      const items = page.items.map((event) => ({ ...event, metadata: { ...event.metadata } }));
      const last = page.items.at(-1);
      const nextCursor = last && page.hasMore ? encodeKeysetCursor({ occurredAt: last.occurredAt, id: last.id }) : undefined;
      return { items, nextCursor, limit, total: page.total };
    },

    async getPatient(actor: User, patientId: string) {
      const state = await store.readState();
      const currentActor = requireActiveUser(state, actor);
      requirePatientPermission(state, currentActor, "patient.view", patientId);
      const patient = findOrThrowScoped(findById(state.patients, patientId));
      return patient;
    },

    async listEncounters(actor: User, patientId: string) {
      const state = await store.readState();
      const currentActor = requireActiveUser(state, actor);
      requirePatientPermission(state, currentActor, "encounter.view", patientId);
      const patient = findOrThrowScoped(findById(state.patients, patientId));
      return encountersForPatient(state, patient.id)
        .map((encounter) => ({ ...encounter }))
        .sort((left, right) => Number(right.status === "OPEN") - Number(left.status === "OPEN") || right.openedAt.localeCompare(left.openedAt) || left.id.localeCompare(right.id));
    },

    async getEncounter(actor: User, encounterId: string) {
      const state = await store.readState();
      const currentActor = requireActiveUser(state, actor);
      const encounter = findOrThrowScoped(findById(state.encounters, encounterId));
      requirePatientPermission(state, currentActor, "encounter.view", encounter.patientId);
      return encounter;
    },

    async getAdmission(actor: User, admissionId: string): Promise<Admission> {
      const state = await store.readState();
      const currentActor = requireActiveUser(state, actor);
      const admission = findOrThrowScoped(findById(state.admissions, admissionId));
      const encounter = findOrThrowScoped(findById(state.encounters, admission.encounterId));
      requirePatientPermission(state, currentActor, "admission.view", encounter.patientId);
      if (!canAccessResource(currentActor, "admission.view", { patientId: encounter.patientId, departmentCode: admission.departmentCode })) {
        throw new ApiError("SCOPE_DENIED", "Você não tem acesso a este recurso.", 404);
      }
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
          const overdue = new Date(item.dueAt).getTime() < currentTime && !["COMPLETED", "CANCELLED", "REJECTED"].includes(item.status);
          return canViewItem(state, currentActor, item) &&
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
        const idempotent = withIdempotency(originalState, currentActor.id, scope, input.idempotencyKey, { notificationId, input });
        if (idempotent.found) return { state: originalState, result: idempotent.existing! };
        const acknowledgedAt = now();
        const updated = { ...notification, state: "ACKNOWLEDGED" as const, acknowledgedAt, acknowledgedBy: currentActor.id, version: notification.version + 1 };
        const correlationId = input.correlationId ?? id("corr");
        const nextState = { ...originalState, notifications: originalState.notifications.map((entry) => entry.id === notification.id ? updated : entry), auditEvents: [...originalState.auditEvents, createAudit("NotificationAcknowledged", currentActor.id, "Notification", notification.id, correlationId, notification.state, "ACKNOWLEDGED", { reason })] };
        const result = updated;
        return { state: saveIdempotency(nextState, currentActor.id, scope, input.idempotencyKey, result, { notificationId, input }), result };
      });
    },

    async listQueuePage(actor: User, departmentCode: string, filters: { status?: ItemState; overdue?: boolean; limit?: number; cursor?: string } = {}) {
      const state = await store.readState();
      const currentActor = requireActiveUser(state, actor);
      const normalizedDepartment = departmentCode.trim().toUpperCase();
      if (!/^[A-Z0-9_-]{1,60}$/.test(normalizedDepartment)) throw new ApiError("VALIDATION_ERROR", "O departamento informado é inválido.", 400);
      requirePermission(currentActor, "queue.view", { departmentCode: normalizedDepartment });
      if (currentActor.role !== "MANAGER" && currentActor.departmentCode !== normalizedDepartment) throw new ApiError("NOT_FOUND", "Fila não encontrada.", 404);
      const currentTime = Date.now();
      const asOf = new Date(currentTime).toISOString();
      const priorityRank: Record<Priority, number> = { EMERGENCY: 0, URGENT: 1, ROUTINE: 2 };
      const limit = pageSize(filters.limit);
      const cursor = decodeQueueCursor(filters.cursor);
      const items = state.items
        .filter((item) => canViewItem(state, currentActor, item))
        .filter((item) => item.departmentCode === normalizedDepartment)
        .filter((item) => !filters.status || item.status === filters.status)
        .filter((item) => filters.overdue === undefined || (new Date(item.dueAt).getTime() < currentTime && !["COMPLETED", "CANCELLED", "REJECTED"].includes(item.status)) === filters.overdue)
        .sort((left, right) => priorityRank[left.priority] - priorityRank[right.priority] || left.dueAt.localeCompare(right.dueAt) || left.id.localeCompare(right.id));
      const afterCursor = cursor
        ? items.filter((item) => priorityRank[item.priority] > cursor.priorityRank || (priorityRank[item.priority] === cursor.priorityRank && (item.dueAt > cursor.dueAt || (item.dueAt === cursor.dueAt && item.id > cursor.id))))
        : items;
      const pageItems = afterCursor.slice(0, limit);
      const page = pageItems.map((item) => {
        const request = requestFor(state, item.requestId);
        const patient = findOrThrow(findById(state.patients, request.patientId));
        const service = serviceFor(state, item.serviceId);
        const procedure = item.procedureId ? findById(state.procedures, item.procedureId) : undefined;
        const overdue = new Date(item.dueAt).getTime() < currentTime && !["COMPLETED", "CANCELLED", "REJECTED"].includes(item.status);
        const operationalContext = operationalContextFor(item, service, asOf, request.requestingDepartmentCode);
        return {
          ...item,
          ...(procedure ? { procedureVersion: procedure.version } : {}),
          requestId: request.id,
          requestCode: request.requestCode,
          patient: { id: patient.id, displayName: patient.displayName, species: patient.species, sex: patient.sex, externalId: patient.externalId },
          service: { id: service.id, code: service.code, name: service.name },
          overdue,
          nextAction: operationalContext.nextAction.label,
          operationalContext,
          currentOwner: operationalContext.currentOwner,
          blockedBy: operationalContext.blockedBy,
          waitingSince: operationalContext.waitingSince,
          expectedBy: operationalContext.expectedBy,
          escalationLevel: operationalContext.escalationLevel
        };
      });
      const last = pageItems.at(-1);
      const nextCursor = last && pageItems.length < afterCursor.length
        ? encodeQueueCursor({ priorityRank: priorityRank[last.priority], dueAt: last.dueAt, id: last.id })
        : undefined;
      return { items: page, nextCursor, limit, total: items.length };
    },

    async listQueue(actor: User, departmentCode: string, filters: { status?: ItemState; overdue?: boolean; limit?: number } = {}): Promise<QueueItemView[]> {
      return (await service.listQueuePage(actor, departmentCode, filters)).items;
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
      const visibleRequests = state.requests.flatMap((request) => {
        if ((from !== undefined && Date.parse(request.createdAt) < from) || (to !== undefined && Date.parse(request.createdAt) > to)) return [];
        const visibleItems = request.itemIds.map((itemId) => itemFor(state, itemId)).filter((item) =>
          canViewItem(state, currentActor, item) && (!filters.status || item.status === filters.status) && (!departmentCode || item.departmentCode === departmentCode));
        return visibleItems.length ? [{ request, visibleItems }] : [];
      });
      // Reviewer matching has always used entity IDs regardless of event type.
      // The store returns distinct actor pairs for those authorized IDs.
      const auditActors = await store.readAuditActors(visibleRequests.flatMap(({ request, visibleItems }) => [
        { entityType: "DiagnosticRequest", entityId: request.id },
        ...visibleItems.map((item) => ({ entityType: "DiagnosticRequestItem", entityId: item.id }))
      ]));
      const actorsByEntityId = new Map<string, Set<string>>();
      for (const { entityId, actorId } of auditActors) {
        const actors = actorsByEntityId.get(entityId) ?? new Set<string>();
        actors.add(actorId);
        actorsByEntityId.set(entityId, actors);
      }
      for (const { request, visibleItems } of visibleRequests) {
        const patient = findOrThrow(findById(state.patients, request.patientId));
        const requester = findById(state.users, request.requesterId);
        const visibleEntityIds = new Set([request.id, ...visibleItems.map((item) => item.id)]);
        const reviewerFields = [...visibleEntityIds]
          .flatMap((entityId) => [...(actorsByEntityId.get(entityId) ?? [])])
          .flatMap((actorId) => {
            const user = findById(state.users, actorId);
            return [actorId, user?.displayName ?? "", user?.email ?? ""];
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
            const sampleFields = samplesForItem(state, item.id).map((sample) => sample.accessionCode);
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
      if (item) requireItemPermission(state, currentActor, "timeline.view", item);
      const limit = pageSize(filters.limit);
      const cursor = decodeTimelineCursor(filters.cursor);
      const page = await store.readAuditEvents({ scope: requestAuditScope(state, currentActor, request), order: "asc", limit, cursor });
      const last = page.items.at(-1);
      const nextCursor = last && page.hasMore ? encodeKeysetCursor({ occurredAt: last.occurredAt, id: last.id }) : undefined;
      const items = page.items.map((event) => ({ ...event, metadata: { ...event.metadata } }));
      return { items, nextCursor, limit, total: page.total };
    },

    async dashboard(actor: User): Promise<DashboardView> {
      const state = await store.readState();
      const currentActor = requireActiveUser(state, actor);
      requirePermission(currentActor, "dashboard.view", { departmentCode: currentActor.departmentCode });
      const visibleItems = state.items.filter((item) => canViewItem(state, currentActor, item));
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
      const priorityRank: Record<Priority, number> = { EMERGENCY: 0, URGENT: 1, ROUTINE: 2 };
      const escalationRank: Record<DashboardView["attention"][number]["operationalContext"]["escalationLevel"], number> = { URGENT: 0, ATTENTION: 1, WATCH: 2, NONE: 3 };
      const attention = activeItems
        .map((item) => {
          const request = requestFor(state, item.requestId);
          const patient = findOrThrow(findById(state.patients, request.patientId));
          const service = serviceFor(state, item.serviceId);
          const operationalContext = operationalContextFor(item, service, asOf, request.requestingDepartmentCode);
          return {
            id: item.id,
            requestId: request.id,
            requestCode: request.requestCode,
            patient: { id: patient.id, displayName: patient.displayName, species: patient.species, externalId: patient.externalId },
            service: { id: service.id, name: service.name, workflowType: service.workflowType },
            departmentCode: item.departmentCode,
            status: item.status,
            priority: item.priority,
            dueAt: item.dueAt,
            overdue: Date.parse(item.dueAt) < currentTime,
            nextAction: operationalContext.nextAction.label,
            operationalContext,
            deepLink: `/requests/${request.id}#${item.id}`
          };
        })
        .filter((item) => item.operationalContext.escalationLevel !== "NONE")
        .sort((left, right) => escalationRank[left.operationalContext.escalationLevel] - escalationRank[right.operationalContext.escalationLevel] || priorityRank[left.priority] - priorityRank[right.priority] || left.dueAt.localeCompare(right.dueAt))
        .slice(0, 24);
      const scopedDepartments = currentActor.role === "MANAGER"
        ? managerDepartmentCodes(currentActor)
        : Array.from(new Set([currentActor.departmentCode, ...visibleItems.map((item) => item.departmentCode)])).filter(Boolean).sort();
      const departments = scopedDepartments.map((departmentCode) => {
        const departmentItems = activeItems.filter((item) => item.departmentCode === departmentCode);
        const departmentAttention = attention.filter((item) => item.departmentCode === departmentCode && item.operationalContext.escalationLevel !== "NONE").length;
        const overdueCount = departmentItems.filter((item) => Date.parse(item.dueAt) < currentTime).length;
        return {
          departmentCode,
          label: departmentCode === "LABORATORY" ? "Laboratório" : departmentCode === "RADIOLOGY" ? "Radiologia" : departmentCode === "ULTRASOUND" ? "Ultrassom" : departmentCode,
          activeItems: departmentItems.length,
          overdue: overdueCount,
          attention: departmentAttention,
          state: overdueCount > 0 || departmentAttention > 0 ? "ATTENTION" as const : departmentItems.length > 0 ? "ACTIVE" as const : "CLEAR" as const
        };
      });
      const window: DashboardWindow = { kind: "CURRENT_STATE", label: "Estado atual", timezone: dashboardTimezone(currentActor), asOf };
      return {
        overdue,
        recollections,
        newResults,
        critical,
        totalActive,
        updatedAt: asOf,
        window,
        indicators,
        attention,
        departments,
        dataQuality: { status: "FRESH", asOf }
      };
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
        .map((item) => ({ item, request: requestFor(state, item.requestId), service: findOrThrow(findById(state.services, item.serviceId)) }));
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
          patient: findOrThrow(findById(state.patients, request.patientId)).displayName,
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
          patient: findOrThrow(findById(state.patients, request.patientId)).displayName,
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
