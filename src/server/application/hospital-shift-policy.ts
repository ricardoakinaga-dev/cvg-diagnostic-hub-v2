import type { HospitalHandoff, HospitalHandoffView, HospitalShift, HospitalShiftView, HospitalTask, Permission } from "@cvg/contracts";
import type { DiagnosticItem, StoreState, User } from "../domain/models";
import { ApiError } from "../http/envelope";
import { hydrateUserPermissions } from "../security/access-group-policy";
import { canAccessResource } from "../security/authorization";
import { canViewItem, findOrThrowScoped, isExecutorRole, requireItemPermission } from "./service-common";
import { canAccessHospitalTask, eligibleTaskUser, requireHospitalTaskAccess } from "./hospital-task-policy";

export function shiftCurrent(shift: HospitalShift, asOf = new Date().toISOString()): boolean { return shift.status === "PLANNED" && shift.startAt <= asOf && asOf < shift.endAt; }
export function validateShift(state: StoreState, shift: HospitalShift): void {
  if (shift.startAt >= shift.endAt) throw new ApiError("VALIDATION_ERROR", "O plantão exige início anterior ao fim.", 400);
  if (new Set(shift.members.map((entry) => entry.userId)).size !== shift.members.length) throw new ApiError("VALIDATION_ERROR", "Profissional duplicado no plantão.", 400);
  if (shift.status !== "PLANNED") return;
  for (const member of shift.members) {
    eligibleTaskUser(state, member.userId, shift, true);
    if (member.replacesUserId) { if (member.replacesUserId === member.userId || shift.members.some((other) => other.userId === member.replacesUserId) || !state.users.some((user) => user.id === member.replacesUserId && user.departmentCode === shift.departmentCode)) throw new ApiError("VALIDATION_ERROR", "A substituição exige outro profissional cadastrado no setor.", 400); }
    if (state.hospitalShifts.some((entry) => entry.id !== shift.id && entry.status === "PLANNED" && shift.status === "PLANNED" && entry.startAt < shift.endAt && shift.startAt < entry.endAt && entry.members.some((existing) => existing.userId === member.userId))) throw new ApiError("SHIFT_CONFLICT", "O profissional já integra outro plantão neste intervalo.", 409);
  }
}
export function currentShiftCoverage(state: StoreState, departmentCode: string, asOf = new Date().toISOString()) {
  const members = state.hospitalShifts.filter((shift) => shift.departmentCode === departmentCode && shiftCurrent(shift, asOf)).flatMap((shift) => shift.members);
  const replaced = new Set(members.flatMap((member) => member.replacesUserId ? [member.replacesUserId] : []));
  const candidates = members.filter((member) => !replaced.has(member.userId)).map((member) => member.userId);
  return [...new Set(candidates)].flatMap((userId) => { try { const user = eligibleTaskUser(state, userId, { departmentCode }, true); return [{ id: user.id, displayName: user.displayName, role: user.role, departmentCode: user.departmentCode }]; } catch { return []; } });
}
export function hospitalShiftView(state: StoreState, actor: User, shift: HospitalShift, permission: Permission = "shift.view"): HospitalShiftView {
  requireHospitalTaskAccess(state, actor, permission, shift);
  const tasks = state.hospitalTasks.filter((task) => task.shiftId === shift.id && canAccessHospitalTask(state, actor, "hospital_task.view", task));
  const items = state.items.filter((item) => item.shiftId === shift.id && canViewItem(state, actor, item));
  const visibleActivities = tasks.length + items.length; const completedActivities = tasks.filter((task) => task.phase === "COMPLETED").length + items.filter((item) => item.status === "COMPLETED").length;
  const permissions = (["shift.view", "shift.manage", "shift.assign"] as const).filter((action) => canAccessHospitalTask(state, actor, action, shift) && (action === "shift.view" || shift.status === "PLANNED"));
  return { shift: structuredClone(shift), permissions, current: shiftCurrent(shift), coverage: shiftCurrent(shift) ? currentShiftCoverage(state, shift.departmentCode) : [], workload: { visibleActivities, completedActivities, denominator: "AUTHORIZED_UNIQUE_ACTIVITIES" } };
}
export function requireShiftLink(state: StoreState, actor: User, shiftId: string | undefined, context: Pick<HospitalTask, "departmentCode">): HospitalShift | undefined {
  if (!shiftId) return;
  const shift = findOrThrowScoped(state.hospitalShifts.find((entry) => entry.id === shiftId)); requireHospitalTaskAccess(state, actor, "shift.assign", shift);
  if (shift.departmentCode !== context.departmentCode || shift.status !== "PLANNED") throw new ApiError("VALIDATION_ERROR", "Selecione um plantão aberto do setor da atividade.", 400);
  return shift;
}
export function eligibleDiagnosticHandoffUser(state: StoreState, userId: string, item: DiagnosticItem): User {
  const user = findOrThrowScoped(state.users.find((entry) => entry.id === userId && entry.active && !entry.mustChangePassword)); const current = hydrateUserPermissions(state, user);
  requireItemPermission(state, current, "item.view", item);
  if (current.role !== "SUPERADMIN" && current.role !== "MANAGER" && (!isExecutorRole(current) || current.departmentCode !== item.departmentCode || !state.departments.some((entry) => entry.code === item.departmentCode && entry.memberUserIds.includes(current.id)))) throw new ApiError("SCOPE_DENIED", "O recebedor não pode executar este exame.", 404);
  requireItemPermission(state, current, "item.assignment.update", item); return current;
}
export function handoffActivity(state: StoreState, actor: User, entry: HospitalHandoff["entries"][number]) {
  if (entry.targetType === "HOSPITAL_TASK") { const task = findOrThrowScoped(state.hospitalTasks.find((row) => row.id === entry.targetId)); requireHospitalTaskAccess(state, actor, "hospital_task.view", task); return { ...entry, label: task.title, status: task.status }; }
  const item = findOrThrowScoped(state.items.find((row) => row.id === entry.targetId)); requireItemPermission(state, actor, "item.view", item); return { ...entry, label: state.services.find((row) => row.id === item.serviceId)?.name ?? "Exame", status: item.status };
}
export function hospitalHandoffView(state: StoreState, actor: User, handoff: HospitalHandoff, permission: Permission = "shift.view"): HospitalHandoffView {
  requireHospitalTaskAccess(state, actor, permission, handoff);
  const activities = handoff.entries.flatMap((entry) => { try { return [handoffActivity(state, actor, entry)]; } catch { return []; } });
  const permissions: Permission[] = canAccessHospitalTask(state, actor, "shift.view", handoff) ? ["shift.view"] : [];
  const destination = state.hospitalShifts.find((shift) => shift.id === handoff.toShiftId && shift.status === "PLANNED" && shift.members.some((member) => member.userId === actor.id));
  if (handoff.state === "OFFERED" && actor.id === handoff.recipientUserId && destination && canAccessResource(actor, "handoff.accept", handoff) && handoff.entries.every((entry) => {
    try {
      if (entry.targetType === "HOSPITAL_TASK") { const task = findOrThrowScoped(state.hospitalTasks.find((row) => row.id === entry.targetId)); requireHospitalTaskAccess(state, actor, "handoff.accept", task); eligibleTaskUser(state, actor.id, task, true); return true; }
      eligibleDiagnosticHandoffUser(state, actor.id, findOrThrowScoped(state.items.find((row) => row.id === entry.targetId))); return true;
    } catch { return false; }
  })) permissions.push("handoff.accept");
  return { handoff: { ...structuredClone(handoff), entries: activities.map(({ label: _label, status: _status, ...entry }) => entry) }, permissions, activities };
}
