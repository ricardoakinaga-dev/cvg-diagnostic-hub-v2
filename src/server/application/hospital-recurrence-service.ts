import type { HospitalRecurrence, HospitalRecurrenceGenerationReport, HospitalRecurrenceView } from "@cvg/contracts";
import type { StateStore, StoreState, User } from "../domain/models";
import type { ApplicationServiceContext } from "./service-context";
import type { HospitalRecurrenceCreateInput, HospitalRecurrenceFilters, HospitalRecurrenceGenerationInput, HospitalRecurrencePatchInput } from "./hospital-checklist-types";
import { ApiError } from "../http/envelope";
import { appendWorkNotifications, workActivityFollowers } from "./work-notification-policy";
import { hospitalRecurrenceCreateSchema, hospitalRecurrenceFiltersSchema, hospitalRecurrenceGenerationSchema, hospitalRecurrencePatchSchema } from "../http/hospital-checklist-schemas";
import { createAudit, createOutbox, ensureExpectedVersion, findOrThrowScoped, id, now, requireActiveUser, requireIdempotencyKey, requirePermission, saveIdempotency, withIdempotency } from "./service-common";
import { canAccessHospitalTask, eligibleTaskUser, requireHospitalTaskAccess, taskDate, validateTaskDates } from "./hospital-task-policy";
import { buildHospitalTask, pagePlannerObjects, recordTaskChange, validateTaskBody } from "./hospital-task-common";
import { captureApprovedChecklist } from "./hospital-checklist-policy";
import { requireHospitalCapability } from "./hospital-institution-policy";

function view(state: StoreState, actor: User, recurrence: HospitalRecurrence, permission: "recurrence.view" | "recurrence.manage" = "recurrence.view"): HospitalRecurrenceView {
  requireHospitalTaskAccess(state, actor, permission, recurrence);
  return { recurrence: structuredClone(recurrence), permissions: (["recurrence.view", "recurrence.manage"] as const).filter((action) => canAccessHospitalTask(state, actor, action, recurrence)) };
}
function validateBindings(state: StoreState, actor: User, recurrence: HospitalRecurrence) {
  requireHospitalTaskAccess(state, actor, "recurrence.manage", recurrence);
  captureApprovedChecklist(state, recurrence.templateId, recurrence, now());
  if (recurrence.responsibleUserId) {
    eligibleTaskUser(state, recurrence.responsibleUserId, recurrence, true);
    if (recurrence.responsibleUserId !== actor.id && actor.role !== "MANAGER" && actor.role !== "SUPERADMIN") throw new ApiError("SCOPE_DENIED", "Somente a gestão pode planejar rotinas para outro responsável.", 404);
  }
  validateTaskDates(recurrence.startAt, recurrence.endAt);
  if (recurrence.endAt && recurrence.endAt <= recurrence.startAt) throw new ApiError("VALIDATION_ERROR", "O fim da recorrência deve suceder seu início.", 400);
}
function record(state: StoreState, actor: User, previous: HospitalRecurrence | undefined, recurrence: HospitalRecurrence, correlationId?: string): StoreState {
  const correlation = correlationId ?? id("corr"); const eventType = previous ? "HospitalRecurrenceUpdated" : "HospitalRecurrenceCreated";
  return { ...state, hospitalRecurrences: previous ? state.hospitalRecurrences.map((entry) => entry.id === recurrence.id ? recurrence : entry) : [...state.hospitalRecurrences, recurrence], auditEvents: [...state.auditEvents, createAudit(eventType, actor.id, "HospitalRecurrence", recurrence.id, correlation, previous ? String(previous.version) : undefined, String(recurrence.version), { departmentCode: recurrence.departmentCode, patientId: recurrence.patientId ?? null, active: recurrence.active, templateId: recurrence.templateId, existingOccurrencesChanged: false })], outbox: [...state.outbox, createOutbox(eventType, "HospitalRecurrence", recurrence.id, correlation, { recurrenceId: recurrence.id, version: recurrence.version })] };
}

/** A persisted occurrence key and its cursor advance commit together, including after downtime. */
export async function generateDueHospitalRecurrences(store: StateStore, options: { asOf?: string; limit?: number; actor?: User } = {}): Promise<HospitalRecurrenceGenerationReport> {
  const asOf = taskDate(options.asOf) ?? now(); const limit = options.limit ?? 50;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100 || Date.parse(asOf) > Date.now()) throw new ApiError("VALIDATION_ERROR", "A geração exige limite válido e horário já ocorrido.", 400);
  const report: HospitalRecurrenceGenerationReport = { generated: 0, alreadyGenerated: 0, blocked: 0, pending: 0, asOf };
  const blockedIds = new Set<string>();
  for (let index = 0; index < limit; index += 1) {
    const result = await store.transaction<{ kind: "NONE" | "GENERATED" | "EXISTING" | "BLOCKED"; id?: string }>((state) => {
      const viewer = options.actor ? requireActiveUser(state, options.actor) : undefined;
      if (viewer) requirePermission(viewer, "recurrence.manage", {});
      const due = state.hospitalRecurrences.filter((entry) => entry.active && entry.nextOccurrenceAt <= asOf && (!entry.endAt || entry.nextOccurrenceAt < entry.endAt) && !blockedIds.has(entry.id) && (!viewer || canAccessHospitalTask(state, viewer, "recurrence.manage", entry))).sort((a, b) => a.nextOccurrenceAt.localeCompare(b.nextOccurrenceAt) || a.id.localeCompare(b.id));
      const recurrence = due[0]; if (!recurrence) return { state, result: { kind: "NONE" as const } };
      const timestamp = now(); const occurrenceAt = recurrence.nextOccurrenceAt;
      const nextOccurrenceAt = new Date(Date.parse(occurrenceAt) + recurrence.intervalMinutes * 60_000).toISOString();
      const updated = { ...recurrence, nextOccurrenceAt, lastError: undefined, version: recurrence.version + 1, updatedAt: timestamp };
      let next = state; let kind: "GENERATED" | "EXISTING" = "EXISTING";
      try {
        const owner = findOrThrowScoped(state.users.find((entry) => entry.id === recurrence.createdBy)); const creator = requireActiveUser(state, owner);
        requireHospitalCapability(state, recurrence.departmentCode, "RECURRENCES");
        validateBindings(state, creator, recurrence);
        if (!state.hospitalTasks.some((task) => task.recurrenceId === recurrence.id && task.occurrenceAt === occurrenceAt)) {
          const type = findOrThrowScoped(state.hospitalTaskTypes.find((entry) => entry.active && entry.code === (recurrence.patientId ? "CARE" : "ROUTINE")));
          const created = buildHospitalTask(state, creator, { title: recurrence.title, departmentCode: recurrence.departmentCode, patientId: recurrence.patientId, encounterId: recurrence.encounterId, typeId: type.id, priority: recurrence.priority, responsibleUserId: recurrence.responsibleUserId, plannedStartAt: occurrenceAt, checklistTemplateId: recurrence.templateId });
          const task = { ...created, recurrenceId: recurrence.id, occurrenceAt };
          next = recordTaskChange(state, creator, undefined, task, "HospitalTaskRecurrenceGenerated", undefined, { recurrenceId: recurrence.id, occurrenceAt, templateVersion: task.checklistSnapshot!.templateVersion }); kind = "GENERATED";
        }
        next = { ...next, hospitalRecurrences: next.hospitalRecurrences.map((entry) => entry.id === recurrence.id ? updated : entry) };
        return { state: next, result: { kind, id: recurrence.id } };
      } catch (error) {
        const code = error instanceof ApiError ? error.code : "GENERATION_FAILED";
        if (recurrence.lastError === code) return { state, result: { kind: "BLOCKED" as const, id: recurrence.id } };
        const failed = { ...recurrence, lastError: code, version: recurrence.version + 1, updatedAt: timestamp };
        next = { ...state, hospitalRecurrences: state.hospitalRecurrences.map((entry) => entry.id === recurrence.id ? failed : entry), auditEvents: [...state.auditEvents, createAudit("HospitalRecurrenceGenerationBlocked", recurrence.createdBy, "HospitalRecurrence", recurrence.id, id("corr"), undefined, code, { occurrenceAt, cursorAdvanced: false })] };
        next = appendWorkNotifications(next, { sourceKey: `recurrence-blocked:${recurrence.id}:${failed.version}`, targetType: "HOSPITAL_RECURRENCE", targetId: recurrence.id, eventType: "RECURRENCE_BLOCKED", recipientUserIds: [recurrence.createdBy, ...workActivityFollowers(next, "HOSPITAL_RECURRENCE", recurrence.id)], createdAt: timestamp });
        return { state: next, result: { kind: "BLOCKED" as const, id: recurrence.id } };
      }
    });
    if (result.kind === "NONE") break;
    if (result.kind === "GENERATED") report.generated += 1;
    else if (result.kind === "EXISTING") report.alreadyGenerated += 1;
    else { report.blocked += 1; blockedIds.add(result.id!); }
  }
  const final = await store.readState(); const current = options.actor ? requireActiveUser(final, options.actor) : undefined;
  for (const entry of final.hospitalRecurrences) if (entry.active && entry.nextOccurrenceAt <= asOf && (!entry.endAt || entry.nextOccurrenceAt < entry.endAt) && (!current || canAccessHospitalTask(final, current, "recurrence.manage", entry))) {
    const boundary = Math.min(Date.parse(asOf), entry.endAt ? Date.parse(entry.endAt) - 1 : Infinity);
    report.pending += Math.floor((boundary - Date.parse(entry.nextOccurrenceAt)) / (entry.intervalMinutes * 60_000)) + 1;
  }
  return report;
}

export function createHospitalRecurrenceService({ store }: ApplicationServiceContext) {
  return {
    async listHospitalRecurrences(actor: User, filters: HospitalRecurrenceFilters = {}) {
      validateTaskBody(hospitalRecurrenceFiltersSchema, filters); const state = await store.readState(); const current = requireActiveUser(state, actor); requirePermission(current, "recurrence.view", {});
      const rows = state.hospitalRecurrences.filter((entry) => canAccessHospitalTask(state, current, "recurrence.view", entry) && (!filters.departmentCode || entry.departmentCode === filters.departmentCode) && (!filters.patientId || entry.patientId === filters.patientId) && (filters.active === undefined || entry.active === filters.active));
      const page = pagePlannerObjects(rows, filters); return { ...page, items: page.items.map((entry) => view(state, current, entry)) };
    },
    async createHospitalRecurrence(actor: User, input: HospitalRecurrenceCreateInput): Promise<HospitalRecurrenceView> {
      return store.transaction((state) => {
        const current = requireActiveUser(state, actor); requireIdempotencyKey(input.idempotencyKey); validateTaskBody(hospitalRecurrenceCreateSchema, input); const departmentCode = input.departmentCode.trim().toUpperCase();
        requireHospitalTaskAccess(state, current, "recurrence.manage", { departmentCode, patientId: input.patientId });
        const scope = "POST:/hospital-recurrences"; const replay = withIdempotency<HospitalRecurrenceView>(state, current.id, scope, input.idempotencyKey, { input });
        if (replay.found) return { state, result: view(state, current, findOrThrowScoped(state.hospitalRecurrences.find((entry) => entry.id === replay.existing!.recurrence.id)), "recurrence.manage") };
        const timestamp = now(); const startAt = taskDate(input.startAt)!; const recurrence: HospitalRecurrence = { id: id("hospital-recurrence"), templateId: input.templateId, departmentCode, patientId: input.patientId, encounterId: input.encounterId, title: input.title.trim(), priority: input.priority, responsibleUserId: input.responsibleUserId, startAt, intervalMinutes: input.intervalMinutes, endAt: taskDate(input.endAt), active: true, nextOccurrenceAt: startAt, createdBy: current.id, version: 1, createdAt: timestamp, updatedAt: timestamp };
        requireHospitalCapability(state, recurrence.departmentCode, "RECURRENCES");
        validateBindings(state, current, recurrence); const next = record(state, current, undefined, recurrence, input.correlationId); const result = view(next, current, recurrence, "recurrence.manage"); return { state: saveIdempotency(next, current.id, scope, input.idempotencyKey, result, { input }), result };
      });
    },
    async updateHospitalRecurrence(actor: User, recurrenceId: string, input: HospitalRecurrencePatchInput): Promise<HospitalRecurrenceView> {
      return store.transaction((state) => {
        const current = requireActiveUser(state, actor); const previous = findOrThrowScoped(state.hospitalRecurrences.find((entry) => entry.id === recurrenceId)); requireHospitalTaskAccess(state, current, "recurrence.manage", previous); requireIdempotencyKey(input.idempotencyKey);
        const scope = `PATCH:/hospital-recurrences/${recurrenceId}`; const replay = withIdempotency<HospitalRecurrenceView>(state, current.id, scope, input.idempotencyKey, { input }); if (replay.found) return { state, result: view(state, current, previous, "recurrence.manage") };
        validateTaskBody(hospitalRecurrencePatchSchema, input); ensureExpectedVersion(previous.version, input.expectedVersion);
        const recurrence = { ...previous, title: input.title?.trim() ?? previous.title, priority: input.priority ?? previous.priority, responsibleUserId: input.responsibleUserId === null ? undefined : input.responsibleUserId ?? previous.responsibleUserId, endAt: input.endAt === undefined ? previous.endAt : taskDate(input.endAt), active: input.active ?? previous.active, version: previous.version + 1, updatedAt: now() };
        if (recurrence.active) validateBindings(state, current, recurrence);
        const next = record(state, current, previous, recurrence, input.correlationId); const result = view(next, current, recurrence, "recurrence.manage"); return { state: saveIdempotency(next, current.id, scope, input.idempotencyKey, result, { input }), result };
      });
    },
    async generateHospitalRecurrences(actor: User, input: HospitalRecurrenceGenerationInput): Promise<HospitalRecurrenceGenerationReport> {
      validateTaskBody(hospitalRecurrenceGenerationSchema, input); const state = await store.readState(); const current = requireActiveUser(state, actor); requirePermission(current, "recurrence.manage", {});
      requireIdempotencyKey(input.idempotencyKey); const scope = "POST:/hospital-recurrences/generate";
      const policy = { role: current.role, permissions: current.permissions, departmentCode: current.departmentCode, managedDepartmentCodes: current.managedDepartmentCodes, patientIds: current.patientIds, serviceCodes: current.serviceCodes };
      const replay = withIdempotency<HospitalRecurrenceGenerationReport>(state, current.id, scope, input.idempotencyKey, { input, policy });
      if (replay.found) return replay.existing!;
      const report = await generateDueHospitalRecurrences(store, { ...input, actor: current });
      return store.transaction((fresh) => {
        const refreshed = requireActiveUser(fresh, actor); requirePermission(refreshed, "recurrence.manage", {});
        const refreshedPolicy = { role: refreshed.role, permissions: refreshed.permissions, departmentCode: refreshed.departmentCode, managedDepartmentCodes: refreshed.managedDepartmentCodes, patientIds: refreshed.patientIds, serviceCodes: refreshed.serviceCodes };
        if (JSON.stringify(refreshedPolicy) !== JSON.stringify(policy)) throw new ApiError("SCOPE_DENIED", "O acesso à recorrência mudou durante a geração.", 404);
        const existing = withIdempotency<HospitalRecurrenceGenerationReport>(fresh, current.id, scope, input.idempotencyKey, { input, policy });
        if (existing.found) return { state: fresh, result: existing.existing! };
        return { state: saveIdempotency(fresh, current.id, scope, input.idempotencyKey, report, { input, policy }), result: report };
      });
    }
  };
}
