import { HOSPITAL_TASK_PHASES, type HospitalTask, type HospitalTaskState, type HospitalTaskType, type Permission } from "@cvg/contracts";
import type { StoreState, User } from "../domain/models";
import { ApiError } from "../http/envelope";
import { canAccessResource, managerCanAccessDepartment } from "../security/authorization";
import { hydrateUserPermissions } from "../security/access-group-policy";
import { canViewItem, findOrThrowScoped, requirePatientPermission, requirePermission, requireText } from "./service-common";
import { requireActiveDepartment } from "./department-registry";

export { initialHospitalTaskTypes } from "../domain/hospital-task-types";

export function validatedTaskStates(states: HospitalTaskState[]): HospitalTaskState[] {
  if (!Array.isArray(states) || states.length < 4 || states.length > 20 || new Set(states.map((entry) => entry.code)).size !== states.length || HOSPITAL_TASK_PHASES.some((phase) => !states.some((entry) => entry.phase === phase))) throw new ApiError("VALIDATION_ERROR", "Configure estados distintos para as quatro fases da tarefa.", 400);
  return states.map((entry) => {
    if (!/^[A-Z][A-Z0-9_]{1,39}$/.test(entry.code) || !HOSPITAL_TASK_PHASES.includes(entry.phase)) throw new ApiError("VALIDATION_ERROR", "Estado de tarefa inválido.", 400);
    return { code: entry.code, label: requireText(entry.label, "nome do estado", 80), phase: entry.phase };
  });
}

export type TaskContext = Pick<HospitalTask, "departmentCode" | "patientId" | "encounterId"> & Pick<HospitalTask, "checklistSnapshot">;
export function requireHospitalTaskAccess(state: StoreState, actor: User, permission: Permission, context: TaskContext): void {
  const task = context as Partial<HospitalTask>;
  if (task.isDraft && actor.id !== task.authorId && actor.role !== "SUPERADMIN" && actor.role !== "MANAGER") throw new ApiError("SCOPE_DENIED", "Você não tem acesso a este rascunho.", 404);
  if (task.isDraft && !["hospital_task.view", "hospital_task.create", "hospital_task.update", "hospital_task.assign", "hospital_task.priority.update"].includes(permission)) throw new ApiError("SCOPE_DENIED", "Publique o rascunho antes de executar ou vincular atividade operacional.", 404);
  const sectorAllowed = actor.role === "SUPERADMIN" || (actor.role === "MANAGER" ? managerCanAccessDepartment(actor, context.departmentCode) : actor.departmentCode === context.departmentCode);
  if (!sectorAllowed) throw new ApiError("SCOPE_DENIED", "Você não tem acesso a este recurso.", 404);
  requirePermission(actor, permission, { departmentCode: context.departmentCode });
  if (context.patientId) {
    requirePatientPermission(state, actor, "patient.view", context.patientId);
    requirePatientPermission(state, actor, permission, context.patientId);
  }
}

export function canAccessHospitalTask(state: StoreState, actor: User, permission: Permission, context: TaskContext): boolean {
  try { requireHospitalTaskAccess(state, actor, permission, context); return true; } catch { return false; }
}

export function validateNewTaskContext(state: StoreState, context: TaskContext, careContextRequired: boolean): void {
  requireActiveDepartment(state, context.departmentCode);
  if (Boolean(context.patientId) !== Boolean(context.encounterId) || (careContextRequired && !context.patientId)) throw new ApiError("VALIDATION_ERROR", "Tarefa assistencial exige paciente e atendimento; vínculos devem ser informados juntos.", 400);
  if (!context.patientId) return;
  const patient = findOrThrowScoped(state.patients.find((entry) => entry.id === context.patientId));
  const encounter = findOrThrowScoped(state.encounters.find((entry) => entry.id === context.encounterId && entry.patientId === patient.id));
  if (!patient.active || encounter.status !== "OPEN") throw new ApiError("INVALID_STATE_TRANSITION", "Novas atividades exigem paciente ativo e atendimento aberto.", 409);
}

export function eligibleTaskUser(state: StoreState, userId: string, task: TaskContext, execute: boolean): User {
  const user = state.users.find((entry) => entry.id === userId);
  if (!user?.active || user.mustChangePassword) throw new ApiError("VALIDATION_ERROR", "Selecione um profissional ativo e habilitado.", 400);
  const effective = hydrateUserPermissions(state, user);
  const process = task.checklistSnapshot?.clinicalProcess;
  if (execute && process && (!process.allowedExecutorRoles.includes(effective.role) || !canAccessHospitalTask(state, effective, "care.execute", task))) throw new ApiError("SCOPE_DENIED", "O processo aprovado não autoriza este executor clínico.", 404);
  if (!canAccessHospitalTask(state, effective, "hospital_task.view", task) || (execute && !canAccessHospitalTask(state, effective, "hospital_task.execute", task))) throw new ApiError("SCOPE_DENIED", "Profissional sem acesso ao contexto da tarefa.", 404);
  if (execute && effective.role !== "SUPERADMIN" && effective.role !== "MANAGER" && !state.departments.some((department) => department.code === task.departmentCode && department.memberUserIds.includes(userId))) throw new ApiError("SCOPE_DENIED", "O executor deve pertencer à equipe cadastrada do setor.", 404);
  return effective;
}

export function validateTaskMembers(state: StoreState, task: TaskContext, responsibleUserId: string | undefined, executorTeamUserIds: string[], participantUserIds: string[]): void {
  for (const entries of [executorTeamUserIds, participantUserIds]) if (entries.length > 100 || new Set(entries).size !== entries.length) throw new ApiError("VALIDATION_ERROR", "Selecione até 100 colaboradores distintos por equipe.", 400);
  if (responsibleUserId) eligibleTaskUser(state, responsibleUserId, task, true);
  for (const userId of executorTeamUserIds) eligibleTaskUser(state, userId, task, true);
  for (const userId of participantUserIds) eligibleTaskUser(state, userId, task, false);
}

export function taskDate(value: string | null | undefined): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(value) || Number.isNaN(Date.parse(value))) throw new ApiError("VALIDATION_ERROR", "Informe data e horário com fuso válido.", 400);
  return new Date(value).toISOString();
}

export function validateTaskDates(start: string | undefined, end: string | undefined): void {
  if (start && end && start > end) throw new ApiError("VALIDATION_ERROR", "O fim planejado não pode anteceder o início.", 400);
}

/** Hierarchy and task dependencies share the same prerequisite graph. */
export function assertTaskGraphAcyclic(state: StoreState, tasks = state.hospitalTasks, dependencies = state.hospitalTaskDependencies): void {
  const edges = new Map(tasks.map((task) => [task.id, [] as string[]]));
  for (const task of tasks) if (task.parentTaskId) edges.get(task.parentTaskId)?.push(task.id);
  for (const dependency of dependencies) if (dependency.active && dependency.targetType === "HOSPITAL_TASK") edges.get(dependency.taskId)?.push(dependency.targetId);
  const visiting = new Set<string>(); const visited = new Set<string>();
  function visit(taskId: string): void {
    if (visiting.has(taskId)) throw new ApiError("CONFLICT", "A relação criaria um ciclo entre tarefas e dependências.", 409);
    if (visited.has(taskId)) return;
    visiting.add(taskId); for (const targetId of edges.get(taskId) ?? []) visit(targetId); visiting.delete(taskId); visited.add(taskId);
  }
  for (const task of tasks) visit(task.id);
}

export function dependencyTarget(state: StoreState, actor: User, targetType: "HOSPITAL_TASK" | "DIAGNOSTIC_ITEM", targetId: string) {
  if (targetType === "HOSPITAL_TASK") {
    const task = findOrThrowScoped(state.hospitalTasks.find((entry) => entry.id === targetId));
    requireHospitalTaskAccess(state, actor, "hospital_task.view", task);
    requirePublishedHospitalTask(task);
    return { label: task.title, satisfied: task.phase === "COMPLETED", responsibleUserId: task.responsibleUserId };
  }
  const item = findOrThrowScoped(state.items.find((entry) => entry.id === targetId));
  if (!canViewItem(state, actor, item)) throw new ApiError("SCOPE_DENIED", "Você não tem acesso a este recurso.", 404);
  const service = state.services.find((entry) => entry.id === item.serviceId);
  return { label: service?.name ?? "Exame", satisfied: item.status === "COMPLETED", responsibleUserId: item.assignedUserId };
}

export function mayExecuteTask(state: StoreState, actor: User, task: HospitalTask): boolean {
  if (task.isDraft || task.archivedAt) return false;
  try { eligibleTaskUser(state, actor.id, task, true); } catch { return false; }
  return canAccessHospitalTask(state, actor, "hospital_task.execute", task) && (actor.role === "SUPERADMIN" || actor.role === "MANAGER" || task.responsibleUserId === actor.id || task.executorTeamUserIds.includes(actor.id));
}

export function mayAssignTask(state: StoreState, actor: User, task: HospitalTask, responsibleUserId: string | undefined, executorTeamUserIds: string[], participantUserIds: string[]): boolean {
  if (!canAccessHospitalTask(state, actor, "hospital_task.assign", task)) return false;
  if (actor.role === "SUPERADMIN" || actor.role === "MANAGER") return true;
  // Assuming is a single explicit operation; team changes and reassignment remain delegated commands.
  return !task.responsibleUserId && responsibleUserId === actor.id && JSON.stringify(executorTeamUserIds) === JSON.stringify(task.executorTeamUserIds) && JSON.stringify(participantUserIds) === JSON.stringify(task.participantUserIds);
}

export function taskPermissions(state: StoreState, actor: User, task: HospitalTask): Permission[] {
  const permissions: Permission[] = canAccessHospitalTask(state, actor, "hospital_task.view", task) ? ["hospital_task.view"] : [];
  if (!permissions.length) return permissions;
  if (task.isDraft) { if (!task.draftCancelledAt && canAccessHospitalTask(state, actor, "hospital_task.update", task)) permissions.push("hospital_task.update"); return permissions; }
  if (canAccessHospitalTask(state, actor, "hospital_calendar.view", task)) permissions.push("hospital_calendar.view");
  if (canArchiveHospitalTask(state, actor, task, task.archivedAt ? "hospital_task.restore" : "hospital_task.archive")) permissions.push(task.archivedAt ? "hospital_task.restore" : "hospital_task.archive");
  for (const permission of ["hospital_task.comment.view", "hospital_task.comment.create", "hospital_task.comment.moderate", "hospital_task.attachment.view", "hospital_task.attachment.download"] as const) if (canAccessHospitalTask(state, actor, permission, task)) permissions.push(permission);
  if (task.archivedAt) return permissions.filter((permission) => permission !== "hospital_task.comment.create" && permission !== "hospital_task.comment.moderate");
  if (["COMPLETED", "CANCELLED"].includes(task.phase)) return permissions;
  if (canAccessHospitalTask(state, actor, "hospital_task.attachment.upload", task)) permissions.push("hospital_task.attachment.upload");
  for (const permission of ["hospital_task.update", "hospital_task.priority.update", "hospital_task.dependency.manage"] as const) if (canAccessHospitalTask(state, actor, permission, task)) permissions.push(permission);
  if (mayExecuteTask(state, actor, task)) {
    permissions.push("hospital_task.execute");
    if (task.checklistSnapshot && canAccessHospitalTask(state, actor, "checklist.execute", task)) permissions.push("checklist.execute");
    if (task.phase === "IN_PROGRESS" && task.checklistSnapshot?.clinicalProcess?.allowedExecutorRoles.includes(actor.role) && canAccessHospitalTask(state, actor, "care.execute", task)) permissions.push("care.execute");
  }
  const hasReservation = state.schedules.some((entry) => entry.hospitalTaskId === task.id && entry.status === "SCHEDULED");
  for (const permission of ["hospital_calendar.reserve", "hospital_calendar.reschedule", "hospital_calendar.cancel"] as const) if (canAccessHospitalTask(state, actor, permission, task) && (permission === "hospital_calendar.cancel" ? hasReservation : task.phase === "PENDING" && (permission === "hospital_calendar.reserve" ? !hasReservation : hasReservation))) permissions.push(permission);
  if (mayAssignTask(state, actor, task, actor.id, task.executorTeamUserIds, task.participantUserIds)) permissions.push("hospital_task.assign");
  return permissions;
}

export function taskTypeReadable(actor: User): boolean {
  return canAccessResource(actor, "hospital_task.view", {}) || canAccessResource(actor, "hospital_task_type.manage", {});
}

export function requirePublishedHospitalTask(task: HospitalTask): void {
  if (task.isDraft || task.archivedAt) throw new ApiError("INVALID_STATE_TRANSITION", "Publique ou restaure a tarefa antes de vinculá-la a execução.", 409);
}
export function requireHospitalTaskArchiveAuthority(state: StoreState, actor: User, task: HospitalTask, permission: "hospital_task.archive" | "hospital_task.restore"): void {
  requireHospitalTaskAccess(state, actor, "hospital_task.view", task); requireHospitalTaskAccess(state, actor, permission, task);
  if (task.isDraft || !["COMPLETED", "CANCELLED"].includes(task.phase)) throw new ApiError("INVALID_STATE_TRANSITION", "Somente tarefas publicadas e encerradas podem ser arquivadas ou restauradas.", 409);
  if (actor.role !== "MANAGER" && actor.role !== "SUPERADMIN" && actor.id !== task.responsibleUserId && !task.executorTeamUserIds.includes(actor.id)) throw new ApiError("SCOPE_DENIED", "Somente a gestão ou a equipe responsável pode arquivar esta atividade.", 404);
  if (state.hospitalTasks.some((entry) => entry.parentTaskId === task.id && !entry.draftCancelledAt && !["COMPLETED", "CANCELLED"].includes(entry.phase))) throw new ApiError("CONFLICT", "Encerre as subtarefas antes de arquivar a atividade.", 409);
}
function canArchiveHospitalTask(state: StoreState, actor: User, task: HospitalTask, permission: "hospital_task.archive" | "hospital_task.restore"): boolean { try { requireHospitalTaskArchiveAuthority(state, actor, task, permission); return true; } catch { return false; } }
