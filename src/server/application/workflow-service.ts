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

export function createWorkflowService({ store, storage }: ApplicationServiceContext) {
  const service = {
    async receiveSample(actor: User, itemIds: string[], input: ReceiveSampleInput) {
      const scope = "POST:/receive-sample";
      return store.transaction(async (originalState) => {
        const currentActor = requireActiveUser(originalState, actor);
        const idempotent = withIdempotency<SampleCommandResult>(originalState, currentActor.id, scope, input.idempotencyKey, { itemIds, input });
        if (idempotent.found) return { state: originalState, result: idempotent.existing! };
        if (!itemIds.length || itemIds.length > 20) throw new ApiError("VALIDATION_ERROR", "Selecione ao menos um item.", 400);
        const items = itemIds.map((itemId) => itemFor(originalState, itemId));
        const request = requestFor(originalState, items[0].requestId);
        const serviceItems = items.map((item) => ({ item, service: serviceFor(originalState, item.serviceId) }));
        if (serviceItems.some(({ item, service }) => item.requestId !== request.id || service.workflowType !== "LABORATORY" || item.status !== "REQUESTED")) {
          throw new ApiError("INVALID_STATE_TRANSITION", "A amostra só pode ser recebida para itens laboratoriais solicitados.", 409);
        }
        requirePermission(currentActor, "sample.receive", { departmentCode: serviceItems[0].service.departmentCode });
        items.forEach((item) => ensureExpectedVersion(item.version, input.expectedVersion));
        if (!input.accessionCode.match(/^[A-Z0-9][A-Z0-9-]{2,39}$/)) throw new ApiError("VALIDATION_ERROR", "Accession inválido.", 400);
        if (originalState.samples.some((sample) => sample.accessionCode === input.accessionCode)) throw new ApiError("CONFLICT", "Accession já utilizado.", 409);
        const receivedAt = now();
        const sample: Sample = { id: id("sample"), requestId: request.id, accessionCode: input.accessionCode, sampleType: requireText(input.sampleType, "sampleType", 100), status: "RECEIVED", itemIds: items.map((item) => item.id), receivedAt, receivedBy: currentActor.id, version: 1 };
        const updatedItems = items.map((item) => ({ ...item, status: transitionItem(item.status, "RECEIVED", item.workflowType), receivedAt, currentSampleId: sample.id, version: item.version + 1 }));
        let nextState = nextRequestState({ ...originalState, samples: [...originalState.samples, sample] }, request, updatedItems);
        const correlationId = input.correlationId ?? id("corr");
        const audits = updatedItems.map((item) => createAudit("SampleReceived", currentActor.id, "DiagnosticRequestItem", item.id, correlationId, "REQUESTED", "RECEIVED", { accessionCode: sample.accessionCode }));
        nextState = { ...nextState, auditEvents: [...nextState.auditEvents, ...audits], outbox: [...nextState.outbox, createOutbox("SampleReceived", "Sample", sample.id, correlationId, { accessionCode: sample.accessionCode, itemIds: sample.itemIds })] };
        const result = { sample, items: updatedItems, request: requestViewForActor(nextState, currentActor, requestFor(nextState, request.id)) };
        return { state: saveIdempotency(nextState, currentActor.id, scope, input.idempotencyKey, result, { itemIds, input }), result };
      });
    },

    async requestRecollection(actor: User, sampleId: string, input: RecollectionInput) {
      const scope = "POST:/request-recollection";
      return store.transaction(async (originalState) => {
        const currentActor = requireActiveUser(originalState, actor);
        requireIdempotencyKey(input.idempotencyKey);
        const idempotent = withIdempotency<SampleCommandResult & { replacement: Sample }>(originalState, currentActor.id, scope, input.idempotencyKey, { sampleId, input });
        if (idempotent.found) return { state: originalState, result: idempotent.existing! };
        const sample = findOrThrow(originalState.samples.find((entry) => entry.id === sampleId));
        const request = requestFor(originalState, sample.requestId);
        const linkedItems = sample.itemIds.map((itemId) => itemFor(originalState, itemId));
        const service = serviceFor(originalState, linkedItems[0].serviceId);
        requirePermission(currentActor, "sample.recollection.request", { departmentCode: service.departmentCode });
        linkedItems.forEach((item) => ensureExpectedVersion(item.version, input.expectedVersion));
        if (sample.status !== "RECEIVED") throw new ApiError("INVALID_STATE_TRANSITION", "A amostra não está disponível para recoleta.", 409);
        const reason = findOrThrow(originalState.reasonCodes.find((entry) => entry.type === "RECOLLECTION" && entry.code === input.reasonCode && entry.active), "VALIDATION_ERROR", "Motivo de recoleta inválido.");
        const rejectionNote = input.note ? requireText(input.note, "note", MAX_NOTE_LENGTH) : undefined;
        const rejectedSample: Sample = { ...sample, status: "REJECTED", rejectionCode: reason.code, rejectionNote, version: sample.version + 1 };
        const replacement: Sample = { id: id("sample"), requestId: request.id, accessionCode: `PENDING-${randomUUID().slice(0, 8).toUpperCase()}`, sampleType: sample.sampleType, status: "EXPECTED", replacesSampleId: sample.id, itemIds: [...sample.itemIds], version: 1 };
        const updatedItems = linkedItems.map((item) => ({ ...item, status: transitionItem(item.status, "RECOLLECTION_REQUIRED", item.workflowType), currentSampleId: replacement.id, version: item.version + 1 }));
        let nextState = nextRequestState({ ...originalState, samples: [...originalState.samples.filter((entry) => entry.id !== sample.id), rejectedSample, replacement] }, request, updatedItems);
        const requester = findOrThrow(originalState.users.find((user) => user.id === request.requesterId));
        const correlationId = input.correlationId ?? id("corr");
        const notification: Omit<Notification, "id" | "createdAt" | "attempts" | "state" | "version"> = { category: "ACTIONABLE", priority: "HIGH", recipientUserId: requester.id, entityType: "SAMPLE", entityId: replacement.id, deepLink: `/requests/${request.id}`, title: "Nova coleta necessária", body: `${requester.displayName}, a amostra ${sample.accessionCode} precisa ser recolhida: ${reason.label}.`, dedupeKey: `recollection:${sample.id}:${replacement.id}` };
        nextState = notificationFor(nextState, notification);
        const notificationId = nextState.notifications.find((entry) => entry.dedupeKey === notification.dedupeKey && entry.recipientUserId === notification.recipientUserId)?.id;
        nextState = { ...nextState, auditEvents: [...nextState.auditEvents, createAudit("SampleRejected", currentActor.id, "Sample", sample.id, correlationId, "RECEIVED", "REJECTED", { reasonCode: reason.code }), createAudit("RecollectionRequested", currentActor.id, "Sample", replacement.id, correlationId, undefined, "EXPECTED", { replacesSampleId: sample.id })], outbox: [...nextState.outbox, createOutbox("RecollectionRequested", "Sample", replacement.id, correlationId, { reasonCode: reason.code, replacesSampleId: sample.id, ...(notificationId ? { notificationId } : {}) })] };
        const result = { sample: rejectedSample, replacement, items: updatedItems, request: requestViewForActor(nextState, currentActor, requestFor(nextState, request.id)) };
        return { state: saveIdempotency(nextState, currentActor.id, scope, input.idempotencyKey, result, { sampleId, input }), result };
      });
    },

    async receiveReplacement(actor: User, sampleId: string, input: ReceiveSampleInput) {
      const scope = "POST:/receive-replacement";
      return store.transaction(async (originalState) => {
        const currentActor = requireActiveUser(originalState, actor);
        requireIdempotencyKey(input.idempotencyKey);
        const idempotent = withIdempotency<SampleCommandResult>(originalState, currentActor.id, scope, input.idempotencyKey, { sampleId, input });
        if (idempotent.found) return { state: originalState, result: idempotent.existing! };
        const expected = findOrThrow(originalState.samples.find((entry) => entry.id === sampleId));
        requirePermission(currentActor, "sample.replacement.receive", { departmentCode: "LABORATORY" });
        const guardedItems = expected.itemIds.map((itemId) => itemFor(originalState, itemId));
        guardedItems.forEach((item) => ensureExpectedVersion(item.version, input.expectedVersion));
        if (expected.status !== "EXPECTED" || !expected.replacesSampleId) throw new ApiError("INVALID_STATE_TRANSITION", "A recoleta não está aguardando recebimento.", 409);
        if (originalState.samples.some((sample) => sample.accessionCode === input.accessionCode)) throw new ApiError("CONFLICT", "Accession já utilizado.", 409);
        const receivedAt = now();
        const replacement: Sample = { ...expected, accessionCode: input.accessionCode, sampleType: requireText(input.sampleType, "sampleType", 100), status: "RECEIVED", receivedAt, receivedBy: currentActor.id, version: expected.version + 1 };
        const request = requestFor(originalState, replacement.requestId);
        const items = replacement.itemIds.map((itemId) => itemFor(originalState, itemId));
        const updatedItems = items.map((item) => ({ ...item, status: transitionItem(item.status, "RECEIVED", item.workflowType), currentSampleId: replacement.id, receivedAt, version: item.version + 1 }));
        let nextState = nextRequestState({ ...originalState, samples: originalState.samples.map((sample) => sample.id === expected.id ? replacement : sample) }, request, updatedItems);
        const correlationId = input.correlationId ?? id("corr");
        nextState = { ...nextState, auditEvents: [...nextState.auditEvents, createAudit("SampleReceived", currentActor.id, "Sample", replacement.id, correlationId, "EXPECTED", "RECEIVED", { replacesSampleId: expected.replacesSampleId })], outbox: [...nextState.outbox, createOutbox("SampleReceived", "Sample", replacement.id, correlationId, { replacesSampleId: expected.replacesSampleId })] };
        const result = { sample: replacement, items: updatedItems, request: requestViewForActor(nextState, currentActor, requestFor(nextState, request.id)) };
        return { state: saveIdempotency(nextState, currentActor.id, scope, input.idempotencyKey, result, { sampleId, input }), result };
      });
    },

    async startProcessing(actor: User, itemId: string, input: CommandMeta) {
      return service.updateItemState(actor, itemId, "IN_PROGRESS", input, "sample.process");
    },

    async updateItemState(actor: User, itemId: string, target: ItemState, input: CommandMeta, permission: Permission) {
      const scope = `POST:/items/${target}`;
      return store.transaction(async (originalState) => {
        const currentActor = requireActiveUser(originalState, actor);
        const idempotent = withIdempotency<ItemCommandResult>(originalState, currentActor.id, scope, input.idempotencyKey, { itemId, target, input });
        if (idempotent.found) return { state: originalState, result: idempotent.existing! };
        const item = itemFor(originalState, itemId);
        const service = serviceFor(originalState, item.serviceId);
        requirePermission(currentActor, permission, { departmentCode: service.departmentCode });
        ensureExpectedVersion(item.version, input.expectedVersion);
        const nextItem = { ...item, status: transitionItem(item.status, target, item.workflowType), startedAt: target === "IN_PROGRESS" ? (item.startedAt ?? now()) : item.startedAt, version: item.version + 1 };
        const request = requestFor(originalState, item.requestId);
        let nextState = nextRequestState(originalState, request, [nextItem]);
        const correlationId = input.correlationId ?? id("corr");
        nextState = { ...nextState, auditEvents: [...nextState.auditEvents, createAudit("ProcessingStarted", currentActor.id, "DiagnosticRequestItem", item.id, correlationId, item.status, nextItem.status, {})] };
        const result = { item: nextItem, request: requestViewForActor(nextState, currentActor, requestFor(nextState, request.id)) };
        return { state: saveIdempotency(nextState, currentActor.id, scope, input.idempotencyKey, result, { itemId, target, input }), result };
      });
    },

    async scheduleProcedure(actor: User, itemId: string, input: ScheduleInput) {
      const scope = "POST:/procedure/schedule";
      return store.transaction(async (originalState) => {
        const currentActor = requireActiveUser(originalState, actor);
        const idempotent = withIdempotency<ProcedureScheduleCommandResult>(originalState, currentActor.id, scope, input.idempotencyKey, { itemId, input });
        if (idempotent.found) return { state: originalState, result: idempotent.existing! };
        const item = itemFor(originalState, itemId);
        const service = serviceFor(originalState, item.serviceId);
        const request = requestFor(originalState, item.requestId);
        requirePermission(currentActor, "procedure.schedule", { departmentCode: service.departmentCode });
        ensureExpectedVersion(item.version, input.expectedVersion);
        if (!(["RADIOLOGY", "ULTRASOUND"] as WorkflowType[]).includes(item.workflowType) || !service.requiresSchedule && item.workflowType === "RADIOLOGY" && item.status !== "REQUESTED") {
          throw new ApiError("VALIDATION_ERROR", "Este item não aceita agendamento nesta etapa.", 400);
        }
        if (item.status !== "REQUESTED") throw new ApiError("INVALID_STATE_TRANSITION", "O item já possui uma execução iniciada ou agendada.", 409);
        const window = scheduleWindow(input);
        if (hasScheduleConflict(originalState, window)) throw new ApiError("SCHEDULE_CONFLICT", "O recurso já está reservado neste intervalo.", 409);
        const createdAt = now();
        const procedure: Procedure = { id: id("procedure"), itemId, workflowType: item.workflowType as "RADIOLOGY" | "ULTRASOUND", status: "SCHEDULED", scheduleIds: [], version: 1 };
        const schedule: ProcedureSchedule = { id: id("schedule"), procedureId: procedure.id, ...window, status: "SCHEDULED", actorId: currentActor.id, createdAt };
        const nextProcedure = { ...procedure, scheduleIds: [schedule.id] };
        const updatedItem = { ...item, status: transitionItem(item.status, "SCHEDULED", item.workflowType), procedureId: procedure.id, version: item.version + 1 };
        const correlationId = input.correlationId ?? id("corr");
        let nextState = nextRequestState({ ...originalState, procedures: [...originalState.procedures, nextProcedure], schedules: [...originalState.schedules, schedule] }, request, [updatedItem]);
        nextState = { ...nextState, auditEvents: [...nextState.auditEvents, createAudit("ProcedureScheduled", currentActor.id, "Procedure", procedure.id, correlationId, "REQUESTED", "SCHEDULED", { resource: window.resource }), createAudit("ScheduleCreated", currentActor.id, "ProcedureSchedule", schedule.id, correlationId, undefined, "SCHEDULED", { procedureId: procedure.id })], outbox: [...nextState.outbox, createOutbox("ProcedureScheduled", "Procedure", procedure.id, correlationId, { scheduleId: schedule.id, itemId })] };
        const result = { item: updatedItem, procedure: nextProcedure, schedule, request: requestViewForActor(nextState, currentActor, requestFor(nextState, request.id)) };
        return { state: saveIdempotency(nextState, currentActor.id, scope, input.idempotencyKey, result, { itemId, input }), result };
      });
    },

    async rescheduleProcedure(actor: User, procedureId: string, input: ScheduleInput) {
      const scope = "POST:/procedure/reschedule";
      return store.transaction(async (originalState) => {
        const currentActor = requireActiveUser(originalState, actor);
        const idempotent = withIdempotency<ProcedureRescheduleCommandResult>(originalState, currentActor.id, scope, input.idempotencyKey, { procedureId, input });
        if (idempotent.found) return { state: originalState, result: idempotent.existing! };
        const procedure = procedureFor(originalState, procedureId);
        const item = itemFor(originalState, procedure.itemId);
        const service = serviceFor(originalState, item.serviceId);
        const request = requestFor(originalState, item.requestId);
        requirePermission(currentActor, "procedure.reschedule", { departmentCode: service.departmentCode });
        ensureExpectedVersion(procedure.version, input.expectedVersion);
        if (procedure.status !== "SCHEDULED" || item.status !== "SCHEDULED") throw new ApiError("INVALID_STATE_TRANSITION", "Somente um procedimento agendado pode ser remarcado.", 409);
        const window = scheduleWindow(input);
        if (hasScheduleConflict(originalState, window, procedure.id)) throw new ApiError("SCHEDULE_CONFLICT", "O recurso já está reservado neste intervalo.", 409);
        const currentSchedule = findOrThrow(originalState.schedules.filter((schedule) => schedule.procedureId === procedure.id && schedule.status === "SCHEDULED").sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0]);
        const reason = input.reason ? requireText(input.reason, "reason", 500) : undefined;
        const cancelledSchedule = { ...currentSchedule, status: "CANCELLED" as const, reason };
        const schedule: ProcedureSchedule = { id: id("schedule"), procedureId: procedure.id, ...window, status: "SCHEDULED", actorId: currentActor.id, createdAt: now() };
        const updatedProcedure = { ...procedure, scheduleIds: [...procedure.scheduleIds, schedule.id], version: procedure.version + 1 };
        const correlationId = input.correlationId ?? id("corr");
        const nextState = { ...originalState, procedures: originalState.procedures.map((entry) => entry.id === procedure.id ? updatedProcedure : entry), schedules: [...originalState.schedules.map((entry) => entry.id === currentSchedule.id ? cancelledSchedule : entry), schedule], auditEvents: [...originalState.auditEvents, createAudit("ProcedureRescheduled", currentActor.id, "Procedure", procedure.id, correlationId, "SCHEDULED", "SCHEDULED", { reason: reason ?? null }), createAudit("ScheduleCreated", currentActor.id, "ProcedureSchedule", schedule.id, correlationId, undefined, "SCHEDULED", { supersedesScheduleId: currentSchedule.id })], outbox: [...originalState.outbox, createOutbox("ProcedureRescheduled", "Procedure", procedure.id, correlationId, { scheduleId: schedule.id, previousScheduleId: currentSchedule.id })] };
        const result = { procedure: updatedProcedure, schedule, history: nextState.schedules.filter((entry) => entry.procedureId === procedure.id), item, request };
        return { state: saveIdempotency(nextState, currentActor.id, scope, input.idempotencyKey, result, { procedureId, input }), result };
      });
    },

    async startProcedure(actor: User, itemId: string, input: CommandMeta) {
      const scope = "POST:/procedure/start";
      return store.transaction(async (originalState) => {
        const currentActor = requireActiveUser(originalState, actor);
        const idempotent = withIdempotency<ItemCommandResult & { procedure: Procedure }>(originalState, currentActor.id, scope, input.idempotencyKey, { itemId, input });
        if (idempotent.found) return { state: originalState, result: idempotent.existing! };
        const item = itemFor(originalState, itemId);
        const service = serviceFor(originalState, item.serviceId);
        const request = requestFor(originalState, item.requestId);
        requirePermission(currentActor, "procedure.start", { departmentCode: service.departmentCode });
        ensureExpectedVersion(item.version, input.expectedVersion);
        let procedure = item.procedureId ? procedureFor(originalState, item.procedureId) : undefined;
        if (item.workflowType === "ULTRASOUND" && (!procedure || procedure.status !== "SCHEDULED" || item.status !== "SCHEDULED")) throw new ApiError("INVALID_STATE_TRANSITION", "O ultrassom precisa estar agendado antes de iniciar.", 409);
        if (item.workflowType === "RADIOLOGY" && item.status === "REQUESTED" && !procedure) {
          procedure = { id: id("procedure"), itemId, workflowType: "RADIOLOGY", status: "EXPECTED", scheduleIds: [], version: 1 };
        }
        if (!procedure || !["EXPECTED", "SCHEDULED"].includes(procedure.status)) throw new ApiError("INVALID_STATE_TRANSITION", "O procedimento não está pronto para iniciar.", 409);
        const updatedProcedure = { ...procedure, status: "IN_PROGRESS" as const, version: procedure.version + 1 };
        const updatedItem = { ...item, status: transitionItem(item.status, "IN_PROGRESS", item.workflowType), startedAt: item.startedAt ?? now(), procedureId: procedure.id, version: item.version + 1 };
        const correlationId = input.correlationId ?? id("corr");
        let nextState = nextRequestState({ ...originalState, procedures: procedure.id === item.procedureId ? originalState.procedures.map((entry) => entry.id === procedure!.id ? updatedProcedure : entry) : [...originalState.procedures, updatedProcedure] }, request, [updatedItem]);
        nextState = { ...nextState, auditEvents: [...nextState.auditEvents, createAudit("ProcedureStarted", currentActor.id, "Procedure", procedure.id, correlationId, procedure.status, "IN_PROGRESS", {})], outbox: [...nextState.outbox, createOutbox("ProcedureStarted", "Procedure", procedure.id, correlationId, { itemId })] };
        const result = { item: updatedItem, procedure: updatedProcedure, request: requestViewForActor(nextState, currentActor, requestFor(nextState, request.id)) };
        return { state: saveIdempotency(nextState, currentActor.id, scope, input.idempotencyKey, result, { itemId, input }), result };
      });
    },

    async markProcedurePerformed(actor: User, itemId: string, input: CommandMeta) {
      const scope = "POST:/procedure/mark-performed";
      return store.transaction(async (originalState) => {
        const currentActor = requireActiveUser(originalState, actor);
        const idempotent = withIdempotency<ItemCommandResult & { procedure: Procedure }>(originalState, currentActor.id, scope, input.idempotencyKey, { itemId, input });
        if (idempotent.found) return { state: originalState, result: idempotent.existing! };
        const item = itemFor(originalState, itemId);
        const procedure = item.procedureId ? procedureFor(originalState, item.procedureId) : undefined;
        const service = serviceFor(originalState, item.serviceId);
        const request = requestFor(originalState, item.requestId);
        requirePermission(currentActor, "procedure.mark_performed", { departmentCode: service.departmentCode });
        ensureExpectedVersion(item.version, input.expectedVersion);
        if (!procedure || procedure.status !== "IN_PROGRESS" || item.status !== "IN_PROGRESS") throw new ApiError("INVALID_STATE_TRANSITION", "O procedimento não está em execução.", 409);
        const performedAt = now();
        const updatedProcedure = { ...procedure, status: "PERFORMED" as const, performedAt, performedBy: currentActor.id, version: procedure.version + 1 };
        const updatedItem = { ...item, status: transitionItem(item.status, "AWAITING_REPORT", item.workflowType), performedAt, version: item.version + 1 };
        const schedules = originalState.schedules.map((schedule) => procedure.scheduleIds.includes(schedule.id) && schedule.status === "SCHEDULED" ? { ...schedule, status: "COMPLETED" as const } : schedule);
        const correlationId = input.correlationId ?? id("corr");
        let nextState = nextRequestState({ ...originalState, procedures: originalState.procedures.map((entry) => entry.id === procedure.id ? updatedProcedure : entry), schedules }, request, [updatedItem]);
        nextState = { ...nextState, auditEvents: [...nextState.auditEvents, createAudit("ProcedurePerformed", currentActor.id, "Procedure", procedure.id, correlationId, "IN_PROGRESS", "PERFORMED", {})], outbox: [...nextState.outbox, createOutbox("ProcedurePerformed", "Procedure", procedure.id, correlationId, { itemId })] };
        const result = { item: updatedItem, procedure: updatedProcedure, request: requestViewForActor(nextState, currentActor, requestFor(nextState, request.id)) };
        return { state: saveIdempotency(nextState, currentActor.id, scope, input.idempotencyKey, result, { itemId, input }), result };
      });
    },

    async cancelItem(actor: User, itemId: string, input: CancelInput) {
      const scope = "POST:/diagnostic-items/cancel";
      return store.transaction(async (originalState) => {
        const currentActor = requireActiveUser(originalState, actor);
        requireIdempotencyKey(input.idempotencyKey);
        const idempotent = withIdempotency<ItemCommandResult>(originalState, currentActor.id, scope, input.idempotencyKey, { itemId, input });
        if (idempotent.found) return { state: originalState, result: idempotent.existing! };
        const item = itemFor(originalState, itemId);
        const service = serviceFor(originalState, item.serviceId);
        const request = requestFor(originalState, item.requestId);
        requirePermission(currentActor, "item.cancel", { patientId: request.patientId, departmentCode: service.departmentCode });
        ensureExpectedVersion(item.version, input.expectedVersion);
        activeReason(originalState, "CANCEL", input.reasonCode);
        if (!["REQUESTED", "RECEIVED", "SCHEDULED", "IN_PROGRESS", "AWAITING_REPORT", "RECOLLECTION_REQUIRED", "FAILED"].includes(item.status)) throw new ApiError("INVALID_STATE_TRANSITION", "Este item não pode ser cancelado nesta fase.", 409);
        const reason = input.reason ? requireText(input.reason, "reason", 500) : input.reasonCode;
        const updatedItem = { ...item, status: transitionItem(item.status, "CANCELLED", item.workflowType), cancellationReason: reason, version: item.version + 1 };
        const schedules = originalState.schedules.map((schedule) => item.procedureId && schedule.procedureId === item.procedureId && schedule.status === "SCHEDULED" ? { ...schedule, status: "CANCELLED" as const, reason } : schedule);
        const requestState = nextRequestState({ ...originalState, schedules }, request, [updatedItem]);
        const correlationId = input.correlationId ?? id("corr");
        const nextState = { ...requestState, auditEvents: [...requestState.auditEvents, createAudit("DiagnosticItemCancelled", currentActor.id, "DiagnosticRequestItem", item.id, correlationId, item.status, "CANCELLED", { reasonCode: input.reasonCode })], outbox: [...requestState.outbox, createOutbox("DiagnosticItemCancelled", "DiagnosticRequestItem", item.id, correlationId, { reasonCode: input.reasonCode })] };
        const result = { item: updatedItem, request: requestViewForActor(nextState, currentActor, requestFor(nextState, request.id)) };
        return { state: saveIdempotency(nextState, currentActor.id, scope, input.idempotencyKey, result, { itemId, input }), result };
      });
    },

    async cancelRequest(actor: User, requestId: string, input: CancelInput & { itemIds?: string[] }) {
      const scope = "POST:/diagnostic-requests/cancel";
      return store.transaction(async (originalState) => {
        const currentActor = requireActiveUser(originalState, actor);
        requireIdempotencyKey(input.idempotencyKey);
        const idempotent = withIdempotency<RequestView>(originalState, currentActor.id, scope, input.idempotencyKey, { requestId, input });
        if (idempotent.found) return { state: originalState, result: idempotent.existing! };
        const request = requestFor(originalState, requestId);
        ensureExpectedVersion(request.version, input.expectedVersion);
        requirePermission(currentActor, "request.cancel", { patientId: request.patientId, departmentCode: request.requestingDepartmentCode });
        activeReason(originalState, "CANCEL", input.reasonCode);
        const selected = input.itemIds?.length ? new Set(input.itemIds) : new Set(request.itemIds);
        const targets = request.itemIds.map((itemId) => itemFor(originalState, itemId)).filter((item) => selected.has(item.id));
        if (!targets.length) throw new ApiError("VALIDATION_ERROR", "Selecione pelo menos um item para cancelar.", 400);
        const reason = input.reason ? requireText(input.reason, "reason", 500) : input.reasonCode;
        const updatedItems = targets.map((item) => {
          if (!["REQUESTED", "RECEIVED", "SCHEDULED", "IN_PROGRESS", "AWAITING_REPORT", "RECOLLECTION_REQUIRED", "FAILED"].includes(item.status)) throw new ApiError("INVALID_STATE_TRANSITION", "Um dos itens não pode ser cancelado nesta fase.", 409);
          return { ...item, status: transitionItem(item.status, "CANCELLED", item.workflowType), cancellationReason: reason, version: item.version + 1 };
        });
        const schedules = originalState.schedules.map((schedule) => updatedItems.some((item) => item.procedureId === schedule.procedureId) && schedule.status === "SCHEDULED" ? { ...schedule, status: "CANCELLED" as const, reason } : schedule);
        let nextState = nextRequestState({ ...originalState, schedules }, request, updatedItems);
        const correlationId = input.correlationId ?? id("corr");
        nextState = { ...nextState, auditEvents: [...nextState.auditEvents, ...updatedItems.map((item) => createAudit("DiagnosticItemCancelled", currentActor.id, "DiagnosticRequestItem", item.id, correlationId, targets.find((target) => target.id === item.id)!.status, "CANCELLED", { reasonCode: input.reasonCode }))], outbox: [...nextState.outbox, createOutbox("DiagnosticRequestCancelled", "DiagnosticRequest", request.id, correlationId, { itemIds: updatedItems.map((item) => item.id), reasonCode: input.reasonCode })] };
        const result = requestViewForActor(nextState, currentActor, requestFor(nextState, request.id));
        return { state: saveIdempotency(nextState, currentActor.id, scope, input.idempotencyKey, result, { requestId, input }), result };
      });
    },

    async rejectItem(actor: User, itemId: string, input: RejectInput) {
      const scope = "POST:/diagnostic-items/reject";
      return store.transaction(async (originalState) => {
        const currentActor = requireActiveUser(originalState, actor);
        requireIdempotencyKey(input.idempotencyKey);
        const idempotent = withIdempotency<ItemCommandResult>(originalState, currentActor.id, scope, input.idempotencyKey, { itemId, input });
        if (idempotent.found) return { state: originalState, result: idempotent.existing! };
        const item = itemFor(originalState, itemId);
        const service = serviceFor(originalState, item.serviceId);
        const request = requestFor(originalState, item.requestId);
        requirePermission(currentActor, "item.reject", { departmentCode: service.departmentCode });
        ensureExpectedVersion(item.version, input.expectedVersion);
        activeReason(originalState, "REJECT", input.reasonCode);
        if (!["REQUESTED", "RECEIVED", "IN_PROGRESS"].includes(item.status)) throw new ApiError("INVALID_STATE_TRANSITION", "Este item não pode ser rejeitado nesta fase.", 409);
        const updatedItem = { ...item, status: transitionItem(item.status, "REJECTED", item.workflowType), rejectionReason: input.note ? requireText(input.note, "note", MAX_NOTE_LENGTH) : input.reasonCode, version: item.version + 1 };
        const sample = item.currentSampleId ? originalState.samples.find((entry) => entry.id === item.currentSampleId) : undefined;
        const samples = sample ? originalState.samples.map((entry) => entry.id === sample.id ? { ...entry, status: "REJECTED" as const, rejectionCode: input.reasonCode, rejectionNote: input.note, version: entry.version + 1 } : entry) : originalState.samples;
        const correlationId = input.correlationId ?? id("corr");
        let nextState = nextRequestState({ ...originalState, samples }, request, [updatedItem]);
        nextState = { ...nextState, auditEvents: [...nextState.auditEvents, createAudit("DiagnosticItemRejected", currentActor.id, "DiagnosticRequestItem", item.id, correlationId, item.status, "REJECTED", { reasonCode: input.reasonCode })], outbox: [...nextState.outbox, createOutbox("DiagnosticItemRejected", "DiagnosticRequestItem", item.id, correlationId, { reasonCode: input.reasonCode })] };
        const result = { item: updatedItem, request: requestViewForActor(nextState, currentActor, requestFor(nextState, request.id)) };
        return { state: saveIdempotency(nextState, currentActor.id, scope, input.idempotencyKey, result, { itemId, input }), result };
      });
    },

    async completeItem(actor: User, itemId: string, input: CommandMeta) {
      const scope = "POST:/diagnostic-items/complete";
      return store.transaction(async (originalState) => {
        const currentActor = requireActiveUser(originalState, actor);
        requireIdempotencyKey(input.idempotencyKey);
        const idempotent = withIdempotency<ItemCommandResult>(originalState, currentActor.id, scope, input.idempotencyKey, { itemId, input });
        if (idempotent.found) return { state: originalState, result: idempotent.existing! };
        const item = itemFor(originalState, itemId);
        const service = serviceFor(originalState, item.serviceId);
        const request = requestFor(originalState, item.requestId);
        requirePermission(currentActor, "item.complete", { departmentCode: service.departmentCode });
        ensureExpectedVersion(item.version, input.expectedVersion);
        if (item.status !== "REVIEWED") throw new ApiError("INVALID_STATE_TRANSITION", "Somente um resultado revisado pode ser concluído.", 409);
        const updatedItem = { ...item, status: transitionItem(item.status, "COMPLETED", item.workflowType), completedAt: now(), version: item.version + 1 };
        const correlationId = input.correlationId ?? id("corr");
        let nextState = nextRequestState(originalState, request, [updatedItem]);
        nextState = { ...nextState, auditEvents: [...nextState.auditEvents, createAudit("RequestItemCompleted", currentActor.id, "DiagnosticRequestItem", item.id, correlationId, "REVIEWED", "COMPLETED", {})], outbox: [...nextState.outbox, createOutbox("RequestItemCompleted", "DiagnosticRequestItem", item.id, correlationId, {})] };
        const result = { item: updatedItem, request: requestViewForActor(nextState, currentActor, requestFor(nextState, request.id)) };
        return { state: saveIdempotency(nextState, currentActor.id, scope, input.idempotencyKey, result, { itemId, input }), result };
      });
    },

  };
  return service;
}
