import { captureApprovedHospitalDocuments } from "./hospital-document-policy";
import { requirePlannerFilterReferences, matchesPlanActivity } from "./hospital-planner-filter";
import { validateTaskReservationStart } from "./hospital-resource-policy";
import { requireChecklistComplete } from "./hospital-checklist-policy";
import type { HospitalTask, HospitalTaskFilters, HospitalTaskOptions, HospitalTaskPage, HospitalTaskType, HospitalTaskView } from "@cvg/contracts";
import type { User } from "../domain/models";
import type { ApplicationServiceContext } from "./service-context";
import type { HospitalTaskAssignmentInput, HospitalTaskCommandInput, HospitalTaskContextInput, HospitalTaskCreateInput, HospitalTaskDependencyInput, HospitalTaskPatchInput, HospitalTaskPriorityInput, HospitalTaskTypeCreateInput, HospitalTaskTypePatchInput } from "./hospital-task-types";
import { ApiError } from "../http/envelope";
import { hospitalTaskAssignmentSchema, hospitalTaskCommandSchema, hospitalTaskContextSchema, hospitalTaskCreateSchema, hospitalTaskDependencySchema, hospitalTaskFiltersSchema, hospitalTaskPatchSchema, hospitalTaskPrioritySchema, hospitalTaskTypeCreateSchema, hospitalTaskTypePatchSchema } from "../http/hospital-task-schemas";
import { createAudit, ensureExpectedVersion, findOrThrowScoped, id, now, requireActiveUser, requireIdempotencyKey, requirePermission, requireText, saveIdempotency, withIdempotency } from "./service-common";
import { assertTaskGraphAcyclic, canAccessHospitalTask, dependencyTarget, eligibleTaskUser, mayAssignTask, mayExecuteTask, requireHospitalTaskAccess, taskDate, taskTypeReadable, validatedTaskStates, validateNewTaskContext, validateTaskDates, validateTaskMembers } from "./hospital-task-policy";
import { buildHospitalTask, existingTask, hospitalTaskView, matchesTaskFilters, recordTaskChange, requireOpenTask, validateParent, validateTaskBody } from "./hospital-task-common";
import { pageHospitalTasks } from "./hospital-task-pagination";
import { decodeAuditCursor, encodeKeysetCursor } from "./service-pagination";
import type { TimelineFilters, TimelineResult } from "./service-types";

export function createHospitalTaskService({ store }: ApplicationServiceContext) {
  async function change(actor: User, taskId: string, input: HospitalTaskPatchInput | HospitalTaskAssignmentInput | HospitalTaskPriorityInput | HospitalTaskCommandInput | HospitalTaskDependencyInput, action: "UPDATE" | "ASSIGN" | "PRIORITY" | "COMMAND" | "DEPENDENCY"): Promise<HospitalTaskView> {
    return store.transaction((state) => {
      const current = requireActiveUser(state, actor);
      const permission = action === "ASSIGN" ? "hospital_task.assign" : action === "PRIORITY" ? "hospital_task.priority.update" : action === "COMMAND" ? "hospital_task.execute" : action === "DEPENDENCY" ? "hospital_task.dependency.manage" : "hospital_task.update";
      const previous = existingTask(state, current, taskId, permission);
      // Replays must pass the latest view policy as well as the write capability.
      existingTask(state, current, taskId, "hospital_task.view");
      requireIdempotencyKey(input.idempotencyKey);
      const scope = `${action}:/hospital-tasks/${taskId}`;
      const replay = withIdempotency<HospitalTaskView>(state, current.id, scope, input.idempotencyKey, { input });
      if (replay.found) return { state, result: hospitalTaskView(state, current, previous) };
      validateTaskBody(action === "ASSIGN" ? hospitalTaskAssignmentSchema : action === "PRIORITY" ? hospitalTaskPrioritySchema : action === "COMMAND" ? hospitalTaskCommandSchema : action === "DEPENDENCY" ? hospitalTaskDependencySchema : hospitalTaskPatchSchema, input);
      ensureExpectedVersion(previous.version, input.expectedVersion);
      requireOpenTask(previous);
      let patch: Partial<HospitalTask> = {};
      let next = state;
      let metadata: Record<string, string | number | boolean | null> = {};
      if (action === "UPDATE") {
        const edit = input as HospitalTaskPatchInput;
        if (edit.documentIds && previous.phase !== "PENDING") throw new ApiError("INVALID_STATE_TRANSITION", "Documentos usados na execução já iniciada permanecem congelados.", 409);
        if (edit.parentTaskId !== undefined || edit.sortOrder !== undefined) existingTask(state, current, taskId, "hospital_task.dependency.manage");
        const plannedStartAt = edit.plannedStartAt === undefined ? previous.plannedStartAt : taskDate(edit.plannedStartAt);
        const plannedEndAt = edit.plannedEndAt === undefined ? previous.plannedEndAt : taskDate(edit.plannedEndAt);
        validateTaskDates(plannedStartAt, plannedEndAt);
        const parentTaskId = edit.parentTaskId === undefined ? previous.parentTaskId : edit.parentTaskId ?? undefined;
        validateParent(state, current, previous, parentTaskId);
        patch = { title: edit.title === undefined ? previous.title : requireText(edit.title, "título", 200), description: edit.description === undefined ? previous.description : edit.description.trim() || undefined, plannedStartAt, plannedEndAt, parentTaskId, sortOrder: edit.sortOrder ?? previous.sortOrder, documentSnapshots: edit.documentIds ? captureApprovedHospitalDocuments(state, current, edit.documentIds, [previous.departmentCode], now()) : previous.documentSnapshots };
        if (Object.keys(edit).every((key) => ["idempotencyKey", "correlationId", "expectedVersion"].includes(key))) throw new ApiError("VALIDATION_ERROR", "Informe uma alteração na tarefa.", 400);
        patch = { ...patch, descriptionContent: edit.descriptionContent === undefined ? previous.descriptionContent : edit.descriptionContent === null ? undefined : structuredClone(edit.descriptionContent), estimatedMinutes: edit.estimatedMinutes === null ? undefined : edit.estimatedMinutes ?? previous.estimatedMinutes, labels: edit.labels ? [...edit.labels] : previous.labels, externalReferences: edit.externalReferences ? structuredClone(edit.externalReferences) : previous.externalReferences };
        metadata = { previousPlannedStartAt: previous.plannedStartAt ?? null, plannedStartAt: plannedStartAt ?? null, previousPlannedEndAt: previous.plannedEndAt ?? null, plannedEndAt: plannedEndAt ?? null, previousParentTaskId: previous.parentTaskId ?? null, parentTaskId: parentTaskId ?? null, previousSortOrder: previous.sortOrder, sortOrder: patch.sortOrder! };
      } else if (action === "ASSIGN") {
        const assignment = input as HospitalTaskAssignmentInput;
        const responsibleUserId = assignment.responsibleUserId ?? undefined;
        const executorTeamUserIds = assignment.executorTeamUserIds ?? previous.executorTeamUserIds;
        const participantUserIds = assignment.participantUserIds ?? previous.participantUserIds;
        if (!mayAssignTask(state, current, previous, responsibleUserId, executorTeamUserIds, participantUserIds)) throw new ApiError("SCOPE_DENIED", "Somente a gestão pode reatribuir ou alterar a equipe.", 404);
        validateTaskMembers(state, previous, responsibleUserId, executorTeamUserIds, participantUserIds);
        patch = { responsibleUserId, executorTeamUserIds: [...executorTeamUserIds], participantUserIds: [...participantUserIds] };
        metadata = { previousResponsibleUserId: previous.responsibleUserId ?? null, responsibleUserId: responsibleUserId ?? null, previousExecutorTeamUserIds: JSON.stringify(previous.executorTeamUserIds), executorTeamUserIds: JSON.stringify(executorTeamUserIds), previousParticipantUserIds: JSON.stringify(previous.participantUserIds), participantUserIds: JSON.stringify(participantUserIds), grantsChanged: false };
      } else if (action === "PRIORITY") {
        const priority = input as HospitalTaskPriorityInput;
        patch = { priority: priority.priority };
        metadata = { previousPriority: previous.priority, priority: priority.priority, reason: requireText(priority.reason, "motivo da prioridade", 500), unit: "HOSPITAL_TASK", clinicalStateChanged: false, datesChanged: false };
      } else if (action === "COMMAND") {
        const command = input as HospitalTaskCommandInput;
        if (!mayExecuteTask(state, current, previous)) throw new ApiError("SCOPE_DENIED", "Assuma a tarefa ou integre sua equipe antes de executá-la.", 404);
        if (command.command === "START" && previous.phase !== "PENDING" || command.command === "COMPLETE" && previous.phase !== "IN_PROGRESS") throw new ApiError("INVALID_STATE_TRANSITION", "Este comando não se aplica à fase atual da tarefa.", 409);
        if (command.command === "COMPLETE") {
          if (previous.checklistSnapshot?.clinicalProcess) throw new ApiError("CLINICAL_CONFIRMATION_REQUIRED", "Use o registro de cuidado com confirmação e referência clínica para concluir esta atividade.", 409);
          requireChecklistComplete(previous);
        }
        const pending = state.hospitalTaskDependencies.filter((entry) => entry.taskId === taskId && entry.active && entry.blocks === command.command);
        if (pending.some((entry) => { try { return !dependencyTarget(state, current, entry.targetType, entry.targetId).satisfied; } catch { return true; } })) throw new ApiError("TASK_DEPENDENCY_PENDING", "Existe uma dependência pendente para este comando.", 409);
        const phase = command.command === "START" ? "IN_PROGRESS" : command.command === "COMPLETE" ? "COMPLETED" : "CANCELLED";
        const target = previous.typeSnapshot.states.find((entry) => entry.phase === phase && (!command.stateCode || entry.code === command.stateCode));
        if (!target) throw new ApiError("VALIDATION_ERROR", "Selecione um estado da fase deste comando.", 400);
        const timestamp = now();
        if (command.command === "START") validateTaskReservationStart(state, previous, current.id, timestamp);
        if (previous.startedAt && timestamp < previous.startedAt) throw new ApiError("INVALID_STATE_TRANSITION", "O horário atual antecede o início registrado.", 409);
        patch = { phase, status: target.code, ...(command.command === "START" ? { startedAt: timestamp, startedBy: current.id } : command.command === "COMPLETE" ? { completedAt: timestamp, completedBy: current.id, completionNote: command.note?.trim() || undefined } : { cancelledAt: timestamp, cancelledBy: current.id, cancellationReason: requireText(command.reason ?? "", "motivo do cancelamento", 500) }) };
        metadata = { command: command.command, reason: patch.cancellationReason ?? null, executorId: current.id, clinicalStateChanged: false };
      } else {
        const dependency = input as HospitalTaskDependencyInput;
        dependencyTarget(state, current, dependency.targetType, dependency.targetId);
        const old = state.hospitalTaskDependencies.find((entry) => entry.taskId === taskId && entry.targetType === dependency.targetType && entry.targetId === dependency.targetId && entry.blocks === dependency.blocks);
        const timestamp = now();
        const changed = { ...(old ?? { id: id("task-dependency"), taskId, targetType: dependency.targetType, targetId: dependency.targetId, blocks: dependency.blocks, createdAt: timestamp }), active: dependency.active, version: (old?.version ?? 0) + 1, updatedAt: timestamp };
        const dependencies = old ? state.hospitalTaskDependencies.map((entry) => entry.id === old.id ? changed : entry) : [...state.hospitalTaskDependencies, changed];
        assertTaskGraphAcyclic(state, state.hospitalTasks, dependencies);
        next = { ...state, hospitalTaskDependencies: dependencies };
        metadata = { dependencyId: changed.id, targetType: changed.targetType, targetId: changed.targetId, blocks: changed.blocks, active: changed.active, clinicalStateChanged: false };
      }
      const updated = { ...previous, ...patch, version: previous.version + 1, updatedAt: now() };
      next = recordTaskChange(next, current, previous, updated, `HospitalTask${action === "ASSIGN" ? "Assigned" : action === "PRIORITY" ? "Reprioritized" : action === "COMMAND" ? "Transitioned" : action === "DEPENDENCY" ? "DependencyUpdated" : "Updated"}`, input.correlationId, metadata);
      if (action === "COMMAND" && ["COMPLETED", "CANCELLED"].includes(updated.phase)) {
        const reservations = next.schedules.filter((schedule) => schedule.hospitalTaskId === taskId && schedule.status === "SCHEDULED");
        const correlation = input.correlationId ?? id("corr"); const eventType = updated.phase === "COMPLETED" ? "HospitalTaskReservationCompleted" : "HospitalTaskReservationCancelled";
        next = { ...next, schedules: next.schedules.map((schedule) => reservations.some((entry) => entry.id === schedule.id) ? { ...schedule, status: updated.phase === "COMPLETED" ? "COMPLETED" : "CANCELLED", reason: updated.phase === "CANCELLED" ? updated.cancellationReason : schedule.reason, version: schedule.version + 1 } : schedule), auditEvents: [...next.auditEvents, ...reservations.map((schedule) => createAudit(eventType, current.id, "HospitalTask", taskId, correlation, schedule.status, updated.phase === "COMPLETED" ? "COMPLETED" : "CANCELLED", { scheduleId: schedule.id, scheduleVersion: schedule.version + 1, executorId: current.id, recordedAt: updated.updatedAt }))] };
      }
      const result = hospitalTaskView(next, current, updated);
      return { state: saveIdempotency(next, current.id, scope, input.idempotencyKey, result, { input }), result };
    });
  }
  return {
    async listHospitalTaskOptions(actor: User): Promise<HospitalTaskOptions> {
      const state = await store.readState(); const current = requireActiveUser(state, actor);
      requirePermission(current, "hospital_task.create", {});
      const departments = state.departments.filter((entry) => entry.active && canAccessHospitalTask(state, current, "hospital_task.create", { departmentCode: entry.code }));
      const assignees = state.users.flatMap((user) => {
        try { const candidate = departments.map((department) => { try { return eligibleTaskUser(state, user.id, { departmentCode: department.code }, true); } catch { return undefined; } }).find(Boolean); return candidate ? [{ id: candidate.id, displayName: candidate.displayName, role: candidate.role, departmentCode: candidate.departmentCode }] : []; } catch { return []; }
      });
      return { departments: departments.map(({ code, name }) => ({ code, name })), types: state.hospitalTaskTypes.filter((entry) => entry.active), assignees };
    },
    async listHospitalTaskTypes(actor: User): Promise<HospitalTaskType[]> {
      const state = await store.readState(); const current = requireActiveUser(state, actor);
      if (!taskTypeReadable(current)) throw new ApiError("SCOPE_DENIED", "Você não tem acesso a este recurso.", 404);
      return state.hospitalTaskTypes;
    },
    async createHospitalTaskType(actor: User, input: HospitalTaskTypeCreateInput): Promise<HospitalTaskType> {
      return store.transaction((state) => {
        const current = requireActiveUser(state, actor); requirePermission(current, "hospital_task_type.manage", {}); requireIdempotencyKey(input.idempotencyKey);
        const scope = "POST:/hospital-task-types"; const replay = withIdempotency<HospitalTaskType>(state, current.id, scope, input.idempotencyKey, { input });
        if (replay.found) return { state, result: replay.existing! };
        validateTaskBody(hospitalTaskTypeCreateSchema, input);
        const code = input.code.trim().toUpperCase();
        if (state.hospitalTaskTypes.some((entry) => entry.code === code)) throw new ApiError("CONFLICT", "Código de tipo já utilizado.", 409);
        const timestamp = now(); const type: HospitalTaskType = { id: id("task-type"), code, name: requireText(input.name, "nome do tipo", 120), careContextRequired: input.careContextRequired, states: validatedTaskStates(input.states), active: true, version: 1, createdAt: timestamp, updatedAt: timestamp };
        const next = { ...state, hospitalTaskTypes: [...state.hospitalTaskTypes, type], auditEvents: [...state.auditEvents, createAudit("HospitalTaskTypeCreated", current.id, "HospitalTaskType", type.id, input.correlationId ?? id("corr"), undefined, "ACTIVE", { code, version: type.version })] };
        return { state: saveIdempotency(next, current.id, scope, input.idempotencyKey, type, { input }), result: type };
      });
    },
    async updateHospitalTaskType(actor: User, typeId: string, input: HospitalTaskTypePatchInput): Promise<HospitalTaskType> {
      return store.transaction((state) => {
        const current = requireActiveUser(state, actor); requirePermission(current, "hospital_task_type.manage", {}); requireIdempotencyKey(input.idempotencyKey);
        const previous = findOrThrowScoped(state.hospitalTaskTypes.find((entry) => entry.id === typeId));
        const scope = `PATCH:/hospital-task-types/${typeId}`; const replay = withIdempotency<HospitalTaskType>(state, current.id, scope, input.idempotencyKey, { input });
        if (replay.found) return { state, result: replay.existing! };
        validateTaskBody(hospitalTaskTypePatchSchema, input); ensureExpectedVersion(previous.version, input.expectedVersion);
        const updated = { ...previous, name: input.name === undefined ? previous.name : requireText(input.name, "nome do tipo", 120), states: input.states === undefined ? previous.states : validatedTaskStates(input.states), careContextRequired: input.careContextRequired ?? previous.careContextRequired, active: input.active ?? previous.active, version: previous.version + 1, updatedAt: now() };
        const next = { ...state, hospitalTaskTypes: state.hospitalTaskTypes.map((entry) => entry.id === typeId ? updated : entry), auditEvents: [...state.auditEvents, createAudit("HospitalTaskTypeUpdated", current.id, "HospitalTaskType", typeId, input.correlationId ?? id("corr"), String(previous.version), String(updated.version), { active: updated.active, existingTaskSnapshotsChanged: false })] };
        return { state: saveIdempotency(next, current.id, scope, input.idempotencyKey, updated, { input }), result: updated };
      });
    },
    async listHospitalTasks(actor: User, filters: HospitalTaskFilters = {}): Promise<HospitalTaskPage> {
      validateTaskBody(hospitalTaskFiltersSchema, filters);
      const state = await store.readState(); const current = requireActiveUser(state, actor); requirePermission(current, "hospital_task.view", {});
      requirePlannerFilterReferences(state, current, filters);
      validateTaskDates(taskDate(filters.from), taskDate(filters.to));
      const query = filters.query?.trim().toLocaleLowerCase("pt-BR");
      const rows = state.hospitalTasks.filter((task) => canAccessHospitalTask(state, current, "hospital_task.view", task) && matchesTaskFilters(task, current, filters) && matchesPlanActivity(state, filters, "HOSPITAL_TASK", task.id) && (!query || `${task.taskCode} ${task.title} ${task.description ?? ""} ${task.patientId ? state.patients.find((patient) => patient.id === task.patientId)?.displayName ?? "" : ""}`.toLocaleLowerCase("pt-BR").includes(query)));
      const page = pageHospitalTasks(rows, filters);
      return { ...page, items: page.items.map((task) => hospitalTaskView(state, current, task)) };
    },
    async getHospitalTask(actor: User, taskId: string): Promise<HospitalTaskView> {
      const state = await store.readState(); const current = requireActiveUser(state, actor);
      return hospitalTaskView(state, current, existingTask(state, current, taskId, "hospital_task.view"));
    },
    async getHospitalTaskHistory(actor: User, taskId: string, filters: TimelineFilters = {}): Promise<TimelineResult> {
      const state = await store.readState(); const current = requireActiveUser(state, actor);
      existingTask(state, current, taskId, "hospital_task.view");
      const limit = filters.limit ?? 25;
      if (!Number.isInteger(limit) || limit < 1 || limit > 100 || (filters.cursor?.length ?? 0) > 2000) throw new ApiError("VALIDATION_ERROR", "Página inválida.", 400);
      const page = await store.readAuditEvents({ scope: { entities: [{ entityType: "HospitalTask", entityId: taskId }] }, order: "desc", limit, cursor: decodeAuditCursor(filters.cursor) });
      const fresh = await store.readState(); const refreshed = requireActiveUser(fresh, actor);
      existingTask(fresh, refreshed, taskId, "hospital_task.view");
      const items = page.items.map((event) => ({ ...event, metadata: Object.fromEntries(Object.entries(event.metadata).filter(([key, value]) => {
        if (["scheduleId", "scheduleVersion", "resourceIds", "startsAt", "endsAt"].includes(key) && !canAccessHospitalTask(fresh, refreshed, "hospital_calendar.view", fresh.hospitalTasks.find((task) => task.id === taskId)!)) return false;
        if ((key === "patientId" || key === "previousPatientId") && typeof value === "string") return canAccessHospitalTask(fresh, refreshed, "hospital_task.view", { departmentCode: fresh.hospitalTasks.find((task) => task.id === taskId)!.departmentCode, patientId: value });
        if ((key === "encounterId" || key === "previousEncounterId") && typeof value === "string") { const encounter = fresh.encounters.find((entry) => entry.id === value); return Boolean(encounter && canAccessHospitalTask(fresh, refreshed, "hospital_task.view", { departmentCode: fresh.hospitalTasks.find((task) => task.id === taskId)!.departmentCode, patientId: encounter.patientId })); }
        if (key === "targetId" && typeof value === "string") { try { const targetType = event.metadata.targetType; if (targetType !== "HOSPITAL_TASK" && targetType !== "DIAGNOSTIC_ITEM") return false; dependencyTarget(fresh, refreshed, targetType, value); return true; } catch { return false; } }
        if ((key === "parentTaskId" || key === "previousParentTaskId") && typeof value === "string") return fresh.hospitalTasks.some((task) => task.id === value && canAccessHospitalTask(fresh, refreshed, "hospital_task.view", task));
        return true;
      })) }));
      const last = page.items.at(-1);
      return { items, total: page.total, limit, ...(last && page.hasMore ? { nextCursor: encodeKeysetCursor({ occurredAt: last.occurredAt, id: last.id }) } : {}) };
    },
    async createHospitalTask(actor: User, input: HospitalTaskCreateInput): Promise<HospitalTaskView> {
      return store.transaction((state) => {
        const current = requireActiveUser(state, actor); requireIdempotencyKey(input.idempotencyKey); validateTaskBody(hospitalTaskCreateSchema, input);
        // Scope checks precede replay: a withdrawn grant cannot retrieve a cached activity.
        const context = { departmentCode: input.departmentCode.toUpperCase(), patientId: input.patientId, encounterId: input.encounterId };
        if (!canAccessHospitalTask(state, current, "hospital_task.create", context)) throw new ApiError("SCOPE_DENIED", "Você não tem acesso a este recurso.", 404);
        const scope = "POST:/hospital-tasks"; const replay = withIdempotency<HospitalTaskView>(state, current.id, scope, input.idempotencyKey, { input });
        if (replay.found) { const previous = findOrThrowScoped(state.hospitalTasks.find((entry) => entry.id === replay.existing!.task.id)); return { state, result: hospitalTaskView(state, current, previous, "hospital_task.create") }; }
        const task = buildHospitalTask(state, current, input);
        if (task.parentTaskId) requirePermission(current, "hospital_task.dependency.manage", { departmentCode: task.departmentCode });
        const next = recordTaskChange(state, current, undefined, task, "HospitalTaskCreated", input.correlationId, { authorId: current.id, responsibleUserId: task.responsibleUserId ?? null, typeVersion: task.typeSnapshot.version });
        const result = hospitalTaskView(next, current, task, "hospital_task.create");
        return { state: saveIdempotency(next, current.id, scope, input.idempotencyKey, result, { input }), result };
      });
    },
    async updateHospitalTaskContext(actor: User, taskId: string, input: HospitalTaskContextInput): Promise<HospitalTaskView> {
      return store.transaction((state) => {
        const current = requireActiveUser(state, actor); const previous = existingTask(state, current, taskId, "hospital_task.update");
        existingTask(state, current, taskId, "hospital_task.view"); requireIdempotencyKey(input.idempotencyKey);
        const context = { departmentCode: previous.departmentCode, patientId: input.patientId ?? undefined, encounterId: input.encounterId ?? undefined };
        requireHospitalTaskAccess(state, current, "hospital_task.update", context);
        const scope = `PUT:/hospital-tasks/${taskId}/context`; const replay = withIdempotency<HospitalTaskView>(state, current.id, scope, input.idempotencyKey, { input });
        if (replay.found) return { state, result: hospitalTaskView(state, current, previous) };
        validateTaskBody(hospitalTaskContextSchema, input); ensureExpectedVersion(previous.version, input.expectedVersion);
        if (previous.phase !== "PENDING") throw new ApiError("INVALID_STATE_TRANSITION", "O contexto só pode mudar antes do início da execução.", 409);
        validateNewTaskContext(state, context, previous.typeSnapshot.careContextRequired || previous.serviceSnapshot?.kind === "CARE" || Boolean(previous.checklistSnapshot?.careContextRequired));
        if (context.patientId === previous.patientId && context.encounterId === previous.encounterId) return { state: saveIdempotency(state, current.id, scope, input.idempotencyKey, hospitalTaskView(state, current, previous), { input }), result: hospitalTaskView(state, current, previous) };
        if (state.hospitalTaskComments.some((entry) => entry.taskId === taskId) || state.hospitalTaskAttachments.some((entry) => entry.taskId === taskId) || previous.recurrenceId || state.hospitalPlans.some((plan) => plan.links.some((link) => link.targetType === "HOSPITAL_TASK" && link.targetId === taskId)) || previous.parentTaskId || state.hospitalTasks.some((task) => task.parentTaskId === taskId) || state.hospitalTaskDependencies.some((entry) => entry.active && (entry.taskId === taskId || entry.targetType === "HOSPITAL_TASK" && entry.targetId === taskId))) throw new ApiError("CONFLICT", "A tarefa possui histórico ou vínculos que impedem a troca de contexto.", 409);
        validateTaskMembers(state, { ...context, checklistSnapshot: previous.checklistSnapshot }, previous.responsibleUserId, previous.executorTeamUserIds, previous.participantUserIds);
        const updated = { ...previous, ...context, version: previous.version + 1, updatedAt: now() };
        const next = recordTaskChange(state, current, previous, updated, "HospitalTaskContextUpdated", input.correlationId, { previousPatientId: previous.patientId ?? null, patientId: context.patientId ?? null, previousEncounterId: previous.encounterId ?? null, encounterId: context.encounterId ?? null, grantsChanged: false, authorChanged: false });
        const result = hospitalTaskView(next, current, updated);
        return { state: saveIdempotency(next, current.id, scope, input.idempotencyKey, result, { input }), result };
      });
    },
    updateHospitalTask: (actor: User, taskId: string, input: HospitalTaskPatchInput) => change(actor, taskId, input, "UPDATE"),
    assignHospitalTask: (actor: User, taskId: string, input: HospitalTaskAssignmentInput) => change(actor, taskId, input, "ASSIGN"),
    reprioritizeHospitalTask: (actor: User, taskId: string, input: HospitalTaskPriorityInput) => change(actor, taskId, input, "PRIORITY"),
    commandHospitalTask: (actor: User, taskId: string, input: HospitalTaskCommandInput) => change(actor, taskId, input, "COMMAND"),
    putHospitalTaskDependency: (actor: User, taskId: string, input: HospitalTaskDependencyInput) => change(actor, taskId, input, "DEPENDENCY")
  };
}
