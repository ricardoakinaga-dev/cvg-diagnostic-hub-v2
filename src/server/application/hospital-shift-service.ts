import type { HospitalHandoff, HospitalHandoffView, HospitalShift, HospitalShiftView } from "@cvg/contracts";
import type { StoreState, User } from "../domain/models";
import type { ApplicationServiceContext } from "./service-context";
import type { HospitalActivityShiftInput, HospitalHandoffDecisionInput, HospitalHandoffFilters, HospitalHandoffOfferInput, HospitalShiftCreateInput, HospitalShiftFilters, HospitalShiftPatchInput } from "./hospital-shift-types";
import { ApiError } from "../http/envelope";
import { hospitalActivityShiftSchema, hospitalHandoffDecisionSchema, hospitalHandoffFiltersSchema, hospitalHandoffOfferSchema, hospitalShiftCreateSchema, hospitalShiftFiltersSchema, hospitalShiftPatchSchema } from "../http/hospital-shift-schemas";
import { createAudit, createOutbox, ensureExpectedVersion, findOrThrowScoped, id, now, requireActiveUser, requireIdempotencyKey, requireItemPermission, requirePermission, requireText, saveIdempotency, withIdempotency } from "./service-common";
import { canAccessHospitalTask, eligibleTaskUser, requireHospitalTaskAccess, requirePublishedHospitalTask, taskDate, validateTaskDates } from "./hospital-task-policy";
import { pagePlannerObjects, recordTaskChange, requireOpenTask, validateTaskBody } from "./hospital-task-common";
import { eligibleDiagnosticHandoffUser, hospitalHandoffView, hospitalShiftView, requireShiftLink, shiftCurrent, validateShift } from "./hospital-shift-policy";
import { hydrateUserPermissions } from "../security/access-group-policy";
import { requireActiveDepartment } from "./department-registry";
import { appendWorkNotifications, workActivityFollowers } from "./work-notification-policy";
import { requireHospitalCapability } from "./hospital-institution-policy";

const terminalItems = new Set(["COMPLETED", "CANCELLED", "REJECTED", "FAILED", "RESULT_VOIDED"]);
function recordShift(state: StoreState, actor: User, previous: HospitalShift | undefined, shift: HospitalShift, correlationId?: string): StoreState {
  const eventType = previous ? "HospitalShiftUpdated" : "HospitalShiftCreated"; const correlation = correlationId ?? id("corr");
  return { ...state, hospitalShifts: previous ? state.hospitalShifts.map((entry) => entry.id === shift.id ? shift : entry) : [...state.hospitalShifts, shift], auditEvents: [...state.auditEvents, createAudit(eventType, actor.id, "HospitalShift", shift.id, correlation, previous?.status, shift.status, { departmentCode: shift.departmentCode, startAt: shift.startAt, endAt: shift.endAt, version: shift.version, onCallChanged: false, linkedWorkflowsChanged: false })], outbox: [...state.outbox, createOutbox(eventType, "HospitalShift", shift.id, correlation, { shiftId: shift.id, version: shift.version })] };
}
function recordHandoff(state: StoreState, actor: User, previous: HospitalHandoff | undefined, handoff: HospitalHandoff, correlationId?: string): StoreState {
  const eventType = previous ? handoff.state === "ACCEPTED" ? "HospitalHandoffAccepted" : "HospitalHandoffRejected" : "HospitalHandoffOffered"; const correlation = correlationId ?? id("corr");
  const next = { ...state, hospitalHandoffs: previous ? state.hospitalHandoffs.map((entry) => entry.id === handoff.id ? handoff : entry) : [...state.hospitalHandoffs, handoff], auditEvents: [...state.auditEvents, createAudit(eventType, actor.id, "HospitalHandoff", handoff.id, correlation, previous?.state, handoff.state, { departmentCode: handoff.departmentCode, recipientUserId: handoff.recipientUserId, version: handoff.version, entryCount: handoff.entries.length, previousResponsibleRemains: handoff.state !== "ACCEPTED", grantsChanged: false, clinicalStateChanged: false, criticalAcknowledged: false })], outbox: [...state.outbox, createOutbox(eventType, "HospitalHandoff", handoff.id, correlation, { handoffId: handoff.id, version: handoff.version })] };
  return appendWorkNotifications(next, { sourceKey: `handoff:${handoff.id}:${handoff.version}`, targetType: "HOSPITAL_HANDOFF", targetId: handoff.id, eventType: previous ? "HANDOFF_DECIDED" : "HANDOFF_OFFERED", recipientUserIds: [previous ? handoff.offeredBy : handoff.recipientUserId, ...workActivityFollowers(next, "HOSPITAL_HANDOFF", handoff.id)].filter((entry) => entry !== actor.id), createdAt: handoff.updatedAt });
}
export function createHospitalShiftService({ store }: ApplicationServiceContext) {
  return {
    async listHospitalShifts(actor: User, filters: HospitalShiftFilters = {}) {
      validateTaskBody(hospitalShiftFiltersSchema, filters); const state = await store.readState(); const current = requireActiveUser(state, actor); requirePermission(current, "shift.view", {}); validateTaskDates(taskDate(filters.from), taskDate(filters.to));
      const rows = state.hospitalShifts.filter((shift) => canAccessHospitalTask(state, current, "shift.view", shift) && (!filters.departmentCode || shift.departmentCode === filters.departmentCode) && (!filters.status || shift.status === filters.status) && (filters.current === undefined || shiftCurrent(shift) === filters.current) && (!filters.from || shift.endAt > taskDate(filters.from)!) && (!filters.to || shift.startAt < taskDate(filters.to)!));
      const page = pagePlannerObjects(rows, filters); return { ...page, items: page.items.map((shift) => hospitalShiftView(state, current, shift)) };
    },
    async getHospitalShift(actor: User, shiftId: string): Promise<HospitalShiftView> { const state = await store.readState(); const current = requireActiveUser(state, actor); return hospitalShiftView(state, current, findOrThrowScoped(state.hospitalShifts.find((entry) => entry.id === shiftId))); },
    async createHospitalShift(actor: User, input: HospitalShiftCreateInput): Promise<HospitalShiftView> {
      return store.transaction((state) => {
        const current = requireActiveUser(state, actor); validateTaskBody(hospitalShiftCreateSchema, input); requireIdempotencyKey(input.idempotencyKey); const departmentCode = input.departmentCode.trim().toUpperCase(); requireHospitalTaskAccess(state, current, "shift.manage", { departmentCode });
        const scope = "POST:/hospital-shifts"; const replay = withIdempotency<HospitalShiftView>(state, current.id, scope, input.idempotencyKey, { input }); if (replay.found) return { state, result: hospitalShiftView(state, current, findOrThrowScoped(state.hospitalShifts.find((entry) => entry.id === replay.existing!.shift.id)), "shift.manage") };
        requireActiveDepartment(state, departmentCode); const timestamp = now(); const shiftId = id("hospital-shift"); const shift: HospitalShift = { id: shiftId, code: `TUR-${shiftId.slice(-12).toUpperCase()}`, name: input.name.trim(), departmentCode, startAt: taskDate(input.startAt)!, endAt: taskDate(input.endAt)!, members: structuredClone(input.members), status: "PLANNED", createdBy: current.id, version: 1, createdAt: timestamp, updatedAt: timestamp }; validateShift(state, shift);
        requireHospitalCapability(state, shift.departmentCode, "SHIFTS");
        const next = recordShift(state, current, undefined, shift, input.correlationId); const result = hospitalShiftView(next, current, shift, "shift.manage"); return { state: saveIdempotency(next, current.id, scope, input.idempotencyKey, result, { input }), result };
      });
    },
    async updateHospitalShift(actor: User, shiftId: string, input: HospitalShiftPatchInput): Promise<HospitalShiftView> {
      return store.transaction((state) => {
        const current = requireActiveUser(state, actor); const previous = findOrThrowScoped(state.hospitalShifts.find((entry) => entry.id === shiftId)); requireHospitalTaskAccess(state, current, "shift.manage", previous); requireIdempotencyKey(input.idempotencyKey);
        const scope = `PATCH:/hospital-shifts/${shiftId}`; const replay = withIdempotency<HospitalShiftView>(state, current.id, scope, input.idempotencyKey, { input }); if (replay.found) return { state, result: hospitalShiftView(state, current, previous, "shift.manage") };
        validateTaskBody(hospitalShiftPatchSchema, input); ensureExpectedVersion(previous.version, input.expectedVersion);
        if (previous.status === "ARCHIVED" || previous.status === "CLOSED" && (input.status !== "ARCHIVED" || input.members || input.startAt || input.endAt)) throw new ApiError("INVALID_STATE_TRANSITION", "O plantão encerrado conserva sua escala histórica.", 409);
        const shift = { ...previous, name: input.name?.trim() ?? previous.name, startAt: taskDate(input.startAt) ?? previous.startAt, endAt: taskDate(input.endAt) ?? previous.endAt, members: input.members ?? previous.members, status: input.status ?? previous.status, version: previous.version + 1, updatedAt: now() }; if (shift.status === "PLANNED") requireActiveDepartment(state, shift.departmentCode); validateShift(state, shift);
        const next = recordShift(state, current, previous, shift, input.correlationId); const result = hospitalShiftView(next, current, shift, "shift.manage"); return { state: saveIdempotency(next, current.id, scope, input.idempotencyKey, result, { input }), result };
      });
    },
    async assignHospitalActivityShift(actor: User, input: HospitalActivityShiftInput) {
      return store.transaction((state) => {
        const current = requireActiveUser(state, actor); validateTaskBody(hospitalActivityShiftSchema, input); requireIdempotencyKey(input.idempotencyKey);
        const target = input.targetType === "HOSPITAL_TASK" ? findOrThrowScoped(state.hospitalTasks.find((task) => task.id === input.targetId)) : findOrThrowScoped(state.items.find((item) => item.id === input.targetId));
        requireHospitalTaskAccess(state, current, "shift.assign", { departmentCode: target.departmentCode });
        if (input.targetType === "HOSPITAL_TASK") { requireHospitalTaskAccess(state, current, "hospital_task.update", target); requirePublishedHospitalTask(state.hospitalTasks.find((task) => task.id === input.targetId)!); } else requireItemPermission(state, current, "item.plan.update", state.items.find((item) => item.id === input.targetId)!);
        const scope = "PUT:/hospital-shifts/activity"; const replay = withIdempotency<{ targetType: string; targetId: string; shiftId?: string; version: number }>(state, current.id, scope, input.idempotencyKey, { input }); if (replay.found) return { state, result: { ...replay.existing!, shiftId: target.shiftId, version: target.version } };
        ensureExpectedVersion(target.version, input.expectedVersion); requireShiftLink(state, current, input.shiftId ?? undefined, target); const timestamp = now(); let next = state;
        if (input.targetType === "HOSPITAL_TASK") {
          const previous = state.hospitalTasks.find((task) => task.id === input.targetId)!; requireOpenTask(previous); const task = { ...previous, shiftId: input.shiftId ?? undefined, version: previous.version + 1, updatedAt: timestamp }; next = recordTaskChange(state, current, previous, task, "HospitalTaskShiftChanged", input.correlationId, { previousShiftId: previous.shiftId ?? null, shiftId: input.shiftId, datesChanged: false, clinicalStateChanged: false });
        } else {
          const previous = state.items.find((item) => item.id === input.targetId)!; if (terminalItems.has(previous.status)) throw new ApiError("INVALID_STATE_TRANSITION", "O exame encerrado conserva seu plantão histórico.", 409);
          const item = { ...previous, shiftId: input.shiftId ?? undefined, version: previous.version + 1 }; const correlation = input.correlationId ?? id("corr"); next = { ...state, items: state.items.map((entry) => entry.id === item.id ? item : entry), requests: state.requests.map((entry) => entry.id === item.requestId ? { ...entry, version: entry.version + 1, updatedAt: timestamp } : entry), auditEvents: [...state.auditEvents, createAudit("DiagnosticItemShiftChanged", current.id, "DiagnosticRequestItem", item.id, correlation, previous.status, item.status, { previousShiftId: previous.shiftId ?? null, shiftId: input.shiftId, datesChanged: false, slaChanged: false })], outbox: [...state.outbox, createOutbox("DiagnosticItemShiftChanged", "DiagnosticRequestItem", item.id, correlation, { itemId: item.id, version: item.version })] };
        }
        const result = { targetType: input.targetType, targetId: target.id, shiftId: input.shiftId ?? undefined, version: target.version + 1 }; return { state: saveIdempotency(next, current.id, scope, input.idempotencyKey, result, { input }), result };
      });
    },
    async listHospitalHandoffs(actor: User, filters: HospitalHandoffFilters = {}) {
      validateTaskBody(hospitalHandoffFiltersSchema, filters); const state = await store.readState(); const current = requireActiveUser(state, actor); requirePermission(current, "shift.view", {});
      const page = pagePlannerObjects(state.hospitalHandoffs.filter((entry) => canAccessHospitalTask(state, current, "shift.view", entry) && (!filters.departmentCode || entry.departmentCode === filters.departmentCode) && (!filters.state || entry.state === filters.state)), filters); return { ...page, items: page.items.map((handoff) => hospitalHandoffView(state, current, handoff)) };
    },
    async offerHospitalHandoff(actor: User, input: HospitalHandoffOfferInput): Promise<HospitalHandoffView> {
      return store.transaction((state) => {
        const current = requireActiveUser(state, actor); validateTaskBody(hospitalHandoffOfferSchema, input); requireIdempotencyKey(input.idempotencyKey);
        const from = findOrThrowScoped(state.hospitalShifts.find((entry) => entry.id === input.fromShiftId)); const to = findOrThrowScoped(state.hospitalShifts.find((entry) => entry.id === input.toShiftId)); requireHospitalTaskAccess(state, current, "handoff.offer", from); requireHospitalTaskAccess(state, current, "handoff.offer", to);
        if (from.id === to.id || from.departmentCode !== to.departmentCode || from.status === "ARCHIVED" || to.status !== "PLANNED") throw new ApiError("VALIDATION_ERROR", "A passagem exige plantões distintos disponíveis do mesmo setor.", 400);
        const recipient = eligibleTaskUser(state, input.recipientUserId, to, true); requireHospitalTaskAccess(state, recipient, "handoff.accept", to);
        if (!to.members.some((member) => member.userId === recipient.id)) throw new ApiError("SCOPE_DENIED", "O recebedor deve integrar a equipe do plantão de destino.", 404);
        const scope = "POST:/hospital-handoffs"; const replay = withIdempotency<HospitalHandoffView>(state, current.id, scope, input.idempotencyKey, { input }); if (replay.found) {
          const previous = findOrThrowScoped(state.hospitalHandoffs.find((entry) => entry.id === replay.existing!.handoff.id));
          for (const entry of previous.entries) {
            if (entry.targetType === "HOSPITAL_TASK") { const task = findOrThrowScoped(state.hospitalTasks.find((row) => row.id === entry.targetId)); requireHospitalTaskAccess(state, current, "handoff.offer", task); eligibleTaskUser(state, recipient.id, task, true); requireHospitalTaskAccess(state, recipient, "handoff.accept", task); }
            else { const item = findOrThrowScoped(state.items.find((row) => row.id === entry.targetId)); requireItemPermission(state, current, "item.assignment.update", item); eligibleDiagnosticHandoffUser(state, recipient.id, item); }
          }
          return { state, result: hospitalHandoffView(state, current, previous, "handoff.offer") };
        }
        const entries = input.entries.map((entry) => {
          const target = entry.targetType === "HOSPITAL_TASK" ? findOrThrowScoped(state.hospitalTasks.find((task) => task.id === entry.targetId)) : findOrThrowScoped(state.items.find((item) => item.id === entry.targetId));
          if (target.shiftId !== from.id || target.departmentCode !== from.departmentCode) throw new ApiError("SCOPE_DENIED", "A pendência não pertence ao plantão de origem.", 404);
          ensureExpectedVersion(target.version, entry.expectedTargetVersion); let previousResponsibleUserId: string | undefined;
          if (entry.targetType === "HOSPITAL_TASK") { const task = state.hospitalTasks.find((task) => task.id === entry.targetId)!; requireHospitalTaskAccess(state, current, "handoff.offer", task); requireOpenTask(task); eligibleTaskUser(state, recipient.id, task, true); requireHospitalTaskAccess(state, recipient, "handoff.accept", task); previousResponsibleUserId = task.responsibleUserId; }
          else { const item = state.items.find((item) => item.id === entry.targetId)!; requireItemPermission(state, current, "item.assignment.update", item); if (terminalItems.has(item.status)) throw new ApiError("INVALID_STATE_TRANSITION", "O exame já foi encerrado.", 409); eligibleDiagnosticHandoffUser(state, recipient.id, item); previousResponsibleUserId = item.assignedUserId; }
          if (current.role !== "MANAGER" && current.role !== "SUPERADMIN" && previousResponsibleUserId !== current.id) throw new ApiError("SCOPE_DENIED", "Entregue apenas atividades sob sua responsabilidade.", 404);
          return { ...entry, previousResponsibleUserId };
        });
        if (state.hospitalHandoffs.some((handoff) => handoff.state === "OFFERED" && handoff.entries.some((existing) => entries.some((entry) => entry.targetType === existing.targetType && entry.targetId === existing.targetId)))) throw new ApiError("HANDOFF_PENDING", "Uma das atividades já tem passagem aguardando decisão.", 409);
        const timestamp = now(); const handoff: HospitalHandoff = { id: id("hospital-handoff"), fromShiftId: from.id, toShiftId: to.id, departmentCode: from.departmentCode, offeredBy: current.id, recipientUserId: recipient.id, entries, state: "OFFERED", offeredAt: timestamp, version: 1, createdAt: timestamp, updatedAt: timestamp };
        const next = recordHandoff(state, current, undefined, handoff, input.correlationId); const result = hospitalHandoffView(next, current, handoff, "handoff.offer"); return { state: saveIdempotency(next, current.id, scope, input.idempotencyKey, result, { input }), result };
      });
    },
    async decideHospitalHandoff(actor: User, handoffId: string, input: HospitalHandoffDecisionInput): Promise<HospitalHandoffView> {
      return store.transaction((state) => {
        const current = requireActiveUser(state, actor); const previous = findOrThrowScoped(state.hospitalHandoffs.find((entry) => entry.id === handoffId)); requireHospitalTaskAccess(state, current, "handoff.accept", previous);
        if (current.id !== previous.recipientUserId) throw new ApiError("SCOPE_DENIED", "Apenas o recebedor nominal pode decidir esta passagem.", 404);
        validateTaskBody(hospitalHandoffDecisionSchema, input); requireIdempotencyKey(input.idempotencyKey); const scope = `POST:/hospital-handoffs/${handoffId}/decision`; const replay = withIdempotency<HospitalHandoffView>(state, current.id, scope, input.idempotencyKey, { input }); if (replay.found) return { state, result: hospitalHandoffView(state, current, previous, "handoff.accept") };
        ensureExpectedVersion(previous.version, input.expectedVersion); if (previous.state !== "OFFERED") throw new ApiError("INVALID_STATE_TRANSITION", "Esta passagem já foi decidida.", 409);
        const timestamp = now(); let next = state;
        if (input.decision === "ACCEPT") next = acceptHandoff(state, current, previous, input.correlationId);
        const handoff: HospitalHandoff = { ...previous, state: input.decision === "ACCEPT" ? "ACCEPTED" : "REJECTED", ...(input.decision === "ACCEPT" ? { acceptedAt: timestamp } : { rejectedAt: timestamp, reason: requireText(input.reason ?? "", "motivo da recusa", 500) }), decidedBy: current.id, version: previous.version + 1, updatedAt: timestamp };
        next = recordHandoff(next, current, previous, handoff, input.correlationId); const result = hospitalHandoffView(next, current, handoff, "handoff.accept"); return { state: saveIdempotency(next, current.id, scope, input.idempotencyKey, result, { input }), result };
      });
    }
  };
}

function acceptHandoff(state: StoreState, actor: User, handoff: HospitalHandoff, correlationId?: string): StoreState {
  const destination = findOrThrowScoped(state.hospitalShifts.find((entry) => entry.id === handoff.toShiftId && entry.status === "PLANNED" && entry.members.some((member) => member.userId === actor.id))); requireHospitalTaskAccess(state, actor, "handoff.accept", destination);
  const offeredBy = findOrThrowScoped(state.users.find((entry) => entry.id === handoff.offeredBy && entry.active)); const offeringActor = hydrateUserPermissions(state, offeredBy); requireHospitalTaskAccess(state, offeringActor, "handoff.offer", handoff);
  const timestamp = now(); const correlation = correlationId ?? id("corr"); let next = state;
  // A failure aborts the whole transaction, including changes prepared for earlier entries.
  for (const entry of handoff.entries) {
    if (entry.targetType === "HOSPITAL_TASK") {
      const previous = findOrThrowScoped(next.hospitalTasks.find((task) => task.id === entry.targetId)); requireHospitalTaskAccess(state, actor, "handoff.accept", previous); requireHospitalTaskAccess(state, offeringActor, "handoff.offer", previous); eligibleTaskUser(state, actor.id, previous, true); requireOpenTask(previous); ensureExpectedVersion(previous.version, entry.expectedTargetVersion);
      if (previous.responsibleUserId !== entry.previousResponsibleUserId || previous.shiftId !== handoff.fromShiftId) throw new ApiError("CONFLICT", "A responsabilidade mudou; prepare uma nova passagem.", 409);
      const task = { ...previous, responsibleUserId: actor.id, shiftId: destination.id, version: previous.version + 1, updatedAt: timestamp }; next = recordTaskChange(next, actor, previous, task, "HospitalTaskHandoffAccepted", correlation, { handoffId: handoff.id, previousResponsibleUserId: previous.responsibleUserId ?? null, responsibleUserId: actor.id, previousShiftId: previous.shiftId ?? null, shiftId: destination.id, grantsChanged: false, datesChanged: false });
    } else {
      const previous = findOrThrowScoped(next.items.find((item) => item.id === entry.targetId)); requireItemPermission(next, offeringActor, "item.assignment.update", previous); eligibleDiagnosticHandoffUser(next, actor.id, previous); ensureExpectedVersion(previous.version, entry.expectedTargetVersion);
      if (terminalItems.has(previous.status) || previous.assignedUserId !== entry.previousResponsibleUserId || previous.shiftId !== handoff.fromShiftId) throw new ApiError("CONFLICT", "O exame mudou; prepare uma nova passagem.", 409);
      const item = { ...previous, assignedUserId: actor.id, assignedAt: timestamp, assignedBy: actor.id, shiftId: destination.id, version: previous.version + 1 }; next = { ...next, items: next.items.map((row) => row.id === item.id ? item : row), requests: next.requests.map((row) => row.id === item.requestId ? { ...row, version: row.version + 1, updatedAt: timestamp } : row), auditEvents: [...next.auditEvents, createAudit("DiagnosticItemHandoffAccepted", actor.id, "DiagnosticRequestItem", item.id, correlation, previous.status, item.status, { handoffId: handoff.id, previousAssignedUserId: previous.assignedUserId ?? null, assignedUserId: actor.id, shiftId: destination.id, slaChanged: false, criticalAcknowledged: false })], outbox: [...next.outbox, createOutbox("DiagnosticItemHandoffAccepted", "DiagnosticRequestItem", item.id, correlation, { itemId: item.id, version: item.version })] };
    }
  }
  return next;
}
