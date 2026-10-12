import { captureApprovedHospitalDocuments, visibleHospitalDocumentSnapshots } from "./hospital-document-policy";
import type { HospitalTask, HospitalTaskFilters, HospitalTaskView } from "@cvg/contracts";
import type { StoreState, User } from "../domain/models";
import type { ZodType } from "zod";
import { ApiError } from "../http/envelope";
import { createAudit, createOutbox, findOrThrowScoped, id, now, requireText } from "./service-common";
import { assertTaskGraphAcyclic, canAccessHospitalTask, dependencyTarget, eligibleTaskUser, requireHospitalTaskAccess, taskDate, taskPermissions, validateNewTaskContext, validateTaskDates, validateTaskMembers } from "./hospital-task-policy";
import { captureHospitalServiceForActivity } from "./hospital-service-registry";
import type { HospitalTaskCreateInput } from "./hospital-task-types";
import { decodeRequestCursor, encodeKeysetCursor } from "./service-pagination";
import { captureApprovedChecklist } from "./hospital-checklist-policy";
import { appendWorkNotifications, workActivityFollowers } from "./work-notification-policy";
import { requireHospitalCapability } from "./hospital-institution-policy";

export function validateTaskBody(schema: ZodType, input: object): void {
  const { idempotencyKey: _key, correlationId: _correlation, ...body } = input as Record<string, unknown>;
  if (!schema.safeParse(Object.fromEntries(Object.entries(body).filter(([, value]) => value !== undefined))).success) throw new ApiError("VALIDATION_ERROR", "Dados da atividade hospitalar inválidos.", 400);
}

export function existingTask(state: StoreState, actor: User, taskId: string, permission: "hospital_task.view" | "hospital_task.update" | "hospital_task.execute" | "hospital_task.assign" | "hospital_task.priority.update" | "hospital_task.dependency.manage") {
  const task = findOrThrowScoped(state.hospitalTasks.find((entry) => entry.id === taskId));
  requireHospitalTaskAccess(state, actor, permission, task);
  return task;
}

export function requireOpenTask(task: HospitalTask): void {
  if (task.archivedAt || task.draftCancelledAt) throw new ApiError("INVALID_STATE_TRANSITION", "A atividade está arquivada ou o rascunho foi descartado.", 409);
  if (task.phase === "COMPLETED" || task.phase === "CANCELLED") throw new ApiError("INVALID_STATE_TRANSITION", "A tarefa já foi encerrada.", 409);
}

export function validateParent(state: StoreState, actor: User, task: Pick<HospitalTask, "id" | "patientId" | "encounterId">, parentTaskId: string | undefined): void {
  if (!parentTaskId) return;
  if ((task as Partial<HospitalTask>).isDraft) throw new ApiError("INVALID_STATE_TRANSITION", "Publique o rascunho antes de compor subtarefas.", 409);
  const parent = existingTask(state, actor, parentTaskId, "hospital_task.view");
  if (parent.isDraft || parent.archivedAt) throw new ApiError("INVALID_STATE_TRANSITION", "O pai deve ser uma tarefa publicada e disponível.", 409);
  if (parent.id === task.id) throw new ApiError("CONFLICT", "A tarefa não pode ser sua própria subtarefa.", 409);
  requireOpenTask(parent);
  if (parent.patientId !== task.patientId || parent.encounterId !== task.encounterId) throw new ApiError("VALIDATION_ERROR", "Pai e subtarefa devem compartilhar o mesmo contexto assistencial.", 400);
}

export function buildHospitalTask(state: StoreState, actor: User, input: HospitalTaskCreateInput): HospitalTask {
  const departmentCode = requireText(input.departmentCode, "setor", 60).toUpperCase();
  const context = { departmentCode, patientId: input.patientId, encounterId: input.encounterId };
  requireHospitalTaskAccess(state, actor, "hospital_task.create", context);
  requireHospitalCapability(state, departmentCode, "TASKS");
  const type = findOrThrowScoped(state.hospitalTaskTypes.find((entry) => entry.id === input.typeId && entry.active));
  if (type.careContextRequired) requireHospitalCapability(state, departmentCode, "CARE");
  const timestamp = now();
  const documentSnapshots = input.documentIds ? captureApprovedHospitalDocuments(state, actor, input.documentIds, [departmentCode], timestamp) : undefined;
  const checklistSnapshot = input.checklistTemplateId ? captureApprovedChecklist(state, input.checklistTemplateId, context, timestamp) : undefined;
  if (checklistSnapshot?.careContextRequired) requireHospitalCapability(state, departmentCode, "CARE");
  const serviceSnapshot = input.serviceId ? captureHospitalServiceForActivity(state, input.serviceId, timestamp) : undefined;
  if (serviceSnapshot?.kind === "CARE") requireHospitalCapability(state, departmentCode, "CARE");
  if (serviceSnapshot && (serviceSnapshot.source === "DIAGNOSTIC_SERVICE" || serviceSnapshot.departmentCode !== departmentCode)) throw new ApiError("VALIDATION_ERROR", "Use o serviço hospitalar deste setor; exames conservam suas próprias solicitações e comandos.", 400);
  validateNewTaskContext(state, context, type.careContextRequired || serviceSnapshot?.kind === "CARE");
  const plannedStartAt = taskDate(input.plannedStartAt); const plannedEndAt = taskDate(input.plannedEndAt);
  validateTaskDates(plannedStartAt, plannedEndAt);
  const executorTeamUserIds = input.executorTeamUserIds ?? []; const participantUserIds = input.participantUserIds ?? [];
  if (input.responsibleUserId || executorTeamUserIds.length || participantUserIds.length) {
    requireHospitalTaskAccess(state, actor, "hospital_task.assign", context);
    if (actor.role !== "SUPERADMIN" && actor.role !== "MANAGER" && (input.responsibleUserId !== actor.id || executorTeamUserIds.length || participantUserIds.length)) throw new ApiError("SCOPE_DENIED", "Somente a gestão pode atribuir outros profissionais.", 404);
  }
  validateTaskMembers(state, { ...context, checklistSnapshot }, input.responsibleUserId, executorTeamUserIds, participantUserIds);
  const taskId = id("hospital-task");
  validateParent(state, actor, { id: taskId, patientId: input.patientId, encounterId: input.encounterId }, input.parentTaskId);
  const initial = findOrThrowScoped(type.states.find((entry) => entry.phase === "PENDING"));
  return { id: taskId, taskCode: `TAR-${taskId.slice(-12).toUpperCase()}`, title: requireText(input.title, "título", 200), description: input.description?.trim() || undefined, descriptionContent: input.descriptionContent ? structuredClone(input.descriptionContent) : undefined, typeId: type.id, typeSnapshot: { id: type.id, code: type.code, name: type.name, careContextRequired: type.careContextRequired, states: structuredClone(type.states), version: type.version }, status: initial.code, phase: "PENDING", ...context, authorId: actor.id, responsibleUserId: input.responsibleUserId, executorTeamUserIds: [...executorTeamUserIds], participantUserIds: [...participantUserIds], priority: input.priority, plannedStartAt, plannedEndAt, parentTaskId: input.parentTaskId, sortOrder: input.sortOrder ?? 0, serviceSnapshot, documentSnapshots, checklistSnapshot, checklistExecutions: checklistSnapshot ? [] : undefined, estimatedMinutes: input.estimatedMinutes, labels: input.labels ? [...input.labels] : undefined, externalReferences: input.externalReferences ? structuredClone(input.externalReferences) : undefined, version: 1, createdAt: timestamp, updatedAt: timestamp };
}

export function recordTaskChange(state: StoreState, actor: User, previous: HospitalTask | undefined, task: HospitalTask, eventType: string, correlationId?: string, metadata: Record<string, string | number | boolean | null> = {}): StoreState {
  const tasks = previous ? state.hospitalTasks.map((entry) => entry.id === task.id ? task : entry) : [...state.hospitalTasks, task];
  assertTaskGraphAcyclic(state, tasks);
  const correlation = correlationId ?? id("corr");
  const next = { ...state, hospitalTasks: tasks, auditEvents: [...state.auditEvents, createAudit(eventType, actor.id, "HospitalTask", task.id, correlation, previous?.status, task.status, { ...metadata, departmentCode: task.departmentCode, patientId: task.patientId ?? null, previousVersion: previous?.version ?? 0, version: task.version })], outbox: [...state.outbox, createOutbox(eventType, "HospitalTask", task.id, correlation, { taskId: task.id, version: task.version })] };
  return task.isDraft || task.archivedAt ? next : appendWorkNotifications(next, { sourceKey: `task:${task.id}:${task.version}`, targetType: "HOSPITAL_TASK", targetId: task.id, eventType: previous?.responsibleUserId !== task.responsibleUserId && task.responsibleUserId ? "TASK_ASSIGNED" : "TASK_CHANGED", recipientUserIds: [task.responsibleUserId, ...task.executorTeamUserIds, ...task.participantUserIds, ...workActivityFollowers(next, "HOSPITAL_TASK", task.id)].filter((entry): entry is string => Boolean(entry) && entry !== actor.id), createdAt: task.updatedAt });
}

export function hospitalTaskView(state: StoreState, actor: User, task: HospitalTask, permission: "hospital_task.view" | "hospital_task.create" = "hospital_task.view"): HospitalTaskView {
  requireHospitalTaskAccess(state, actor, permission, task);
  const dependencies = state.hospitalTaskDependencies.filter((entry) => entry.taskId === task.id && entry.active).map((entry) => {
    try { return { ...entry, ...dependencyTarget(state, actor, entry.targetType, entry.targetId) }; }
    catch { return { id: entry.id, blocks: entry.blocks, restricted: true as const, satisfied: false as const }; }
  });
  const eligibleAssignees = taskPermissions(state, actor, task).includes("hospital_task.assign") ? state.users.flatMap((user) => {
    try { const candidate = eligibleTaskUser(state, user.id, task, true); return [{ id: candidate.id, displayName: candidate.displayName, role: candidate.role, departmentCode: candidate.departmentCode }]; } catch { return []; }
  }) : [];
  const visibleTask = { ...task, documentSnapshots: visibleHospitalDocumentSnapshots(state, actor, task.documentSnapshots, [task.departmentCode]) };
  if (task.parentTaskId && !state.hospitalTasks.some((entry) => entry.id === task.parentTaskId && canAccessHospitalTask(state, actor, "hospital_task.view", entry))) delete visibleTask.parentTaskId;
  const patient = task.patientId ? state.patients.find((entry) => entry.id === task.patientId) : undefined;
  const encounter = task.encounterId ? state.encounters.find((entry) => entry.id === task.encounterId) : undefined;
  return { task: visibleTask, permissions: taskPermissions(state, actor, task), eligibleAssignees, dependencies, ...(canAccessHospitalTask(state, actor, "hospital_calendar.view", task) ? { reservations: state.schedules.filter((entry) => entry.hospitalTaskId === task.id && entry.status === "SCHEDULED") } : {}), children: state.hospitalTasks.filter((entry) => entry.parentTaskId === task.id && canAccessHospitalTask(state, actor, "hospital_task.view", entry)).sort((a, b) => a.sortOrder - b.sortOrder || a.id.localeCompare(b.id)).map((child) => ({ ...child, documentSnapshots: visibleHospitalDocumentSnapshots(state, actor, child.documentSnapshots, [child.departmentCode]) })), ...(patient ? { patient: { id: patient.id, displayName: patient.displayName, externalId: patient.externalId, species: patient.species, ownerLabel: patient.ownerLabel } } : {}), ...(encounter ? { encounter: { id: encounter.id, externalId: encounter.externalId, status: encounter.status, type: encounter.type } } : {}) };
}

export function matchesTaskFilters(task: HospitalTask, actor: User, filters: HospitalTaskFilters): boolean {
  const at = task.plannedStartAt ?? task.createdAt;
  return (filters.includeArchived || !task.archivedAt) && (filters.includeDrafts || !task.isDraft) && (!filters.label || Boolean(task.labels?.includes(filters.label))) && (!filters.phase || task.phase === filters.phase) && (!filters.status || task.status === filters.status) && (!filters.typeId || task.typeId === filters.typeId) && (!filters.departmentCode || task.departmentCode === filters.departmentCode) && (!filters.patientId || task.patientId === filters.patientId) && (!filters.shiftId || task.shiftId === filters.shiftId) && (!filters.encounterId || task.encounterId === filters.encounterId) && (!filters.priority || task.priority === filters.priority) && (!filters.responsibleUserId || task.responsibleUserId === filters.responsibleUserId) && (!filters.assignedToMe || task.responsibleUserId === actor.id) && (!filters.from || at >= taskDate(filters.from)!) && (!filters.to || at <= taskDate(filters.to)!);
}

export function pagePlannerObjects<T extends { createdAt: string; id: string }>(rows: T[], filters: { limit?: number; cursor?: string }, key: (row: T) => { createdAt: string; id: string } = (row) => row) {
  const limit = filters.limit ?? 25;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100 || (filters.cursor?.length ?? 0) > 2000) throw new ApiError("VALIDATION_ERROR", "Página inválida.", 400);
  const cursor = decodeRequestCursor(filters.cursor);
  const sorted = [...rows].sort((a, b) => key(b).createdAt.localeCompare(key(a).createdAt) || key(a).id.localeCompare(key(b).id));
  const after = cursor ? sorted.filter((row) => key(row).createdAt < cursor.createdAt || key(row).createdAt === cursor.createdAt && key(row).id > cursor.id) : sorted;
  const items = after.slice(0, limit); const last = items.at(-1);
  return { items, total: rows.length, limit, ...(last && after.length > items.length ? { nextCursor: encodeKeysetCursor(key(last)) } : {}) };
}
