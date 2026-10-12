import type { HospitalResource, HospitalResourceSnapshot, HospitalResourceWindow, HospitalSchedule, HospitalTask, Permission } from "@cvg/contracts";
import type { DiagnosticItem, StoreState, User } from "../domain/models";
import { ApiError } from "../http/envelope";
import { canAccessResource, managerCanAccessDepartment } from "../security/authorization";
import { hydrateUserPermissions } from "../security/access-group-policy";
import { requireActiveDepartment } from "./department-registry";
import { eligibleTaskUser, taskDate, type TaskContext } from "./hospital-task-policy";
import { requireItemPermission, requirePermission } from "./service-common";

export function canAccessHospitalResource(actor: User, permission: Permission, departmentCode: string): boolean {
  const sectorAllowed = actor.role === "ADMIN" || actor.role === "SUPERADMIN" || (actor.role === "MANAGER" ? managerCanAccessDepartment(actor, departmentCode) : actor.departmentCode === departmentCode);
  return sectorAllowed && canAccessResource(actor, permission, { departmentCode });
}
export function requireHospitalResourceAccess(actor: User, permission: Permission, departmentCode: string): void {
  if (!canAccessHospitalResource(actor, permission, departmentCode)) throw new ApiError("SCOPE_DENIED", "Você não tem acesso a este recurso.", 404);
}
export function resourceWindows(windows: HospitalResourceWindow[]): HospitalResourceWindow[] {
  const sorted = windows.map((window) => ({ startsAt: taskDate(window.startsAt)!, endsAt: taskDate(window.endsAt)! })).sort((a, b) => a.startsAt.localeCompare(b.startsAt));
  const merged: HospitalResourceWindow[] = [];
  for (const entry of sorted) {
    if (entry.endsAt <= entry.startsAt) throw new ApiError("VALIDATION_ERROR", "Intervalo de disponibilidade inválido.", 400);
    const previous = merged.at(-1);
    if (previous && entry.startsAt <= previous.endsAt) previous.endsAt = previous.endsAt > entry.endsAt ? previous.endsAt : entry.endsAt;
    else merged.push(entry);
  }
  return merged;
}
export function validateResourceDefinition(state: StoreState, resource: HospitalResource, previous?: HospitalResource): void {
  const needsLiveBinding = !previous || resource.active && (!previous.active || resource.departmentCode !== previous.departmentCode);
  const department = needsLiveBinding ? requireActiveDepartment(state, resource.departmentCode) : state.departments.find((entry) => entry.code === resource.departmentCode);
  if (!department) throw new ApiError("VALIDATION_ERROR", "O setor informado não existe.", 400);
  if (resource.kind === "PROFESSIONAL" && needsLiveBinding) {
    const user = state.users.find((entry) => entry.id === resource.userId);
    if (!user?.active || user.departmentCode !== department.code || !department.memberUserIds.includes(user.id)) throw new ApiError("RESOURCE_PROFESSIONAL_UNAVAILABLE", "Selecione um colaborador ativo da equipe deste setor.", 422);
    if (state.hospitalResources.some((entry) => entry.id !== resource.id && entry.kind === "PROFESSIONAL" && entry.userId === resource.userId)) throw new ApiError("CONFLICT", "O colaborador já possui um recurso cadastrado.", 409);
  }
  if (resource.kind !== "BED" && (resource.ward !== undefined || resource.bedLabel !== undefined || resource.allowedSpecies !== undefined) || resource.kind === "BED" && (!resource.ward || !resource.bedLabel || !resource.allowedSpecies?.length || resource.availabilityWindows.length)) throw new ApiError("VALIDATION_ERROR", "A configuração do leito ou recurso é inválida.", 400);
  if (previous && resource.departmentCode !== previous.departmentCode && (state.schedules.some((schedule) => schedule.status === "SCHEDULED" && schedule.resourceIds?.includes(resource.id)) || state.admissions.some((admission) => admission.bedResourceId === resource.id && !admission.dischargedAt))) throw new ApiError("RESOURCE_IN_USE", "Transfira as ocupações e remaneje as reservas antes de mudar o setor do recurso.", 409);
  if (resource.kind === "BED" && resource.active && state.hospitalResources.some((entry) => entry.id !== resource.id && entry.active && entry.kind === "BED" && entry.departmentCode === resource.departmentCode && entry.ward === resource.ward && entry.bedLabel === resource.bedLabel)) throw new ApiError("CONFLICT", "Já existe um leito ativo com esta identificação no setor.", 409);
  if (previous && resource.kind === "BED" && (previous.ward !== resource.ward || previous.bedLabel !== resource.bedLabel || JSON.stringify(previous.allowedSpecies) !== JSON.stringify(resource.allowedSpecies)) && state.admissions.some((admission) => admission.bedResourceId === resource.id && !admission.dischargedAt)) throw new ApiError("RESOURCE_IN_USE", "Transfira a ocupação antes de mudar a identidade ou compatibilidade do leito.", 409);
}
export function captureResource(resource: HospitalResource, capturedAt: string): HospitalResourceSnapshot {
  return { resourceId: resource.id, resourceVersion: resource.version, code: resource.code, name: resource.name, kind: resource.kind, departmentCode: resource.departmentCode, ...(resource.userId ? { userId: resource.userId } : {}), capturedAt };
}
export function intervalsOverlap(left: HospitalResourceWindow, right: HospitalResourceWindow): boolean {
  return Date.parse(left.startsAt) < Date.parse(right.endsAt) && Date.parse(left.endsAt) > Date.parse(right.startsAt);
}
export function scheduleResourceIds(schedule: HospitalSchedule): string[] { return schedule.resourceIds ?? []; }
/** Both kinds of activity compete in the same persistent schedules collection. */
export function validateReservationResources(state: StoreState, context: TaskContext, ids: string[], window: HospitalResourceWindow, capturedAt: string, excludeScheduleId?: string, diagnosticItem?: DiagnosticItem) {
  if (!ids.length || ids.length > 20 || new Set(ids).size !== ids.length) throw new ApiError("VALIDATION_ERROR", "Selecione recursos distintos para a reserva.", 400);
  requireActiveDepartment(state, context.departmentCode);
  const resources = ids.map((resourceId) => {
    const resource = state.hospitalResources.find((entry) => entry.id === resourceId);
    if (!resource?.active || resource.availability !== "AVAILABLE" || resource.kind === "BED" || resource.departmentCode !== context.departmentCode) throw new ApiError("RESOURCE_UNAVAILABLE", "O recurso está indisponível para este setor ou modalidade.", 422);
    const windows = resourceWindows(resource.availabilityWindows);
    if (!windows.some((available) => available.startsAt <= window.startsAt && available.endsAt >= window.endsAt)) throw new ApiError("RESOURCE_UNAVAILABLE", windows.length ? "A reserva está fora da disponibilidade cadastrada." : "A disponibilidade horária do recurso ainda não foi cadastrada.", 422);
    if (resource.kind === "PROFESSIONAL") {
      const user = state.users.find((entry) => entry.id === resource.userId);
      if (!user?.active || user.mustChangePassword || user.departmentCode !== resource.departmentCode || !state.departments.some((department) => department.code === resource.departmentCode && department.memberUserIds.includes(user.id))) throw new ApiError("RESOURCE_PROFESSIONAL_UNAVAILABLE", "O profissional não está ativo na equipe deste setor.", 422);
      if (diagnosticItem) requireItemPermission(state, hydrateUserPermissions(state, user), "procedure.start", diagnosticItem);
      else eligibleTaskUser(state, user.id, context, true);
    }
    return resource;
  });
  if (state.schedules.some((schedule) => schedule.id !== excludeScheduleId && schedule.status === "SCHEDULED" && scheduleResourceIds(schedule).some((resourceId) => ids.includes(resourceId)) && intervalsOverlap(schedule, window))) throw new ApiError("SCHEDULE_CONFLICT", "Um dos recursos já está reservado neste intervalo.", 409);
  if (window.startsAt <= capturedAt && window.endsAt > capturedAt && state.schedules.some((schedule) => schedule.id !== excludeScheduleId && schedule.status === "SCHEDULED" && scheduleResourceIds(schedule).some((resourceId) => ids.includes(resourceId)) && (schedule.procedureId ? state.procedures.some((procedure) => procedure.id === schedule.procedureId && procedure.status === "IN_PROGRESS") : state.hospitalTasks.some((task) => task.id === schedule.hospitalTaskId && task.phase === "IN_PROGRESS")))) throw new ApiError("RESOURCE_EXECUTION_IN_PROGRESS", "Um recurso ainda está ocupado por outra execução; aguarde sua conclusão real.", 409);
  return { resourceIds: [...ids], resourceSnapshots: resources.map((resource) => captureResource(resource, capturedAt)), resource: resources.map((resource) => resource.name).join(" / ").slice(0, 100) };
}
export function requireCalendarPermission(actor: User, permission: Permission, context: TaskContext): void {
  requirePermission(actor, permission, context);
}
export function validateTaskReservationStart(state: StoreState, task: HospitalTask, actorId: string, at: string): void {
  const schedule = state.schedules.find((entry) => entry.hospitalTaskId === task.id && entry.status === "SCHEDULED");
  if (!schedule) return;
  if (!schedule.resourceIds?.length || at < schedule.startsAt || at >= schedule.endsAt) throw new ApiError("RESERVATION_NOT_CURRENT", "A atividade deve iniciar dentro do horário da reserva vigente.", 409);
  const binding = validateReservationResources(state, task, schedule.resourceIds, schedule, at, schedule.id);
  const professionals = binding.resourceSnapshots.filter((resource) => resource.kind === "PROFESSIONAL");
  if (professionals.length && !professionals.some((resource) => resource.userId === actorId)) throw new ApiError("CARE_EXECUTOR_NOT_RESERVED", "O executor não é um dos profissionais desta reserva.", 422);
}
