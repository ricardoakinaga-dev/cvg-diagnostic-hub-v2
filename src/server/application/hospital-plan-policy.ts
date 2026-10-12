import { visibleHospitalDocumentSnapshots } from "./hospital-document-policy";
import { diagnosticPlannerPhase } from "@cvg/domain";
import type { HospitalPlan, HospitalPlanActivity, HospitalPlanLink, HospitalPlanView, Permission } from "@cvg/contracts";
import type { StoreState, User } from "../domain/models";
import { ApiError } from "../http/envelope";
import { requirePatientPermission, requirePermission, canViewItem, findOrThrowScoped } from "./service-common";
import { canAccessHospitalTask, dependencyTarget, requireHospitalTaskAccess, requirePublishedHospitalTask } from "./hospital-task-policy";
import { hydrateUserPermissions } from "../security/access-group-policy";

export function requireHospitalPlanAccess(state: StoreState, actor: User, permission: Permission, plan: Pick<HospitalPlan, "departmentCodes" | "patientId">): void {
  if (!plan.departmentCodes.some((departmentCode) => canAccessHospitalTask(state, actor, permission, { departmentCode, patientId: plan.patientId }))) throw new ApiError("SCOPE_DENIED", "Você não tem acesso a este recurso.", 404);
  requirePatientPermission(state, actor, "patient.view", plan.patientId);
}
export function canAccessHospitalPlan(state: StoreState, actor: User, permission: Permission, plan: Pick<HospitalPlan, "departmentCodes" | "patientId">): boolean {
  try { requireHospitalPlanAccess(state, actor, permission, plan); return true; } catch { return false; }
}
export function requirePlanResponsible(state: StoreState, userId: string | undefined, plan: Pick<HospitalPlan, "departmentCodes" | "patientId">): void {
  if (!userId) return;
  const user = findOrThrowScoped(state.users.find((entry) => entry.id === userId && entry.active && !entry.mustChangePassword));
  requireHospitalPlanAccess(state, hydrateUserPermissions(state, user), "plan.update", plan);
}

export function planActivity(state: StoreState, actor: User, plan: HospitalPlan, link: HospitalPlanLink): HospitalPlanActivity {
  if (link.targetType === "HOSPITAL_TASK") {
    const task = findOrThrowScoped(state.hospitalTasks.find((entry) => entry.id === link.targetId));
    if (task.isDraft) requirePublishedHospitalTask(task);
    requireHospitalTaskAccess(state, actor, "hospital_task.view", task);
    if (task.patientId && (task.patientId !== plan.patientId || task.encounterId !== plan.encounterId)) throw new ApiError("VALIDATION_ERROR", "A atividade pertence a outro contexto assistencial.", 400);
    const command = task.phase === "PENDING" ? "START" : task.phase === "IN_PROGRESS" ? "COMPLETE" : undefined;
    const blocked = Boolean(command && state.hospitalTaskDependencies.some((entry) => entry.taskId === task.id && entry.active && entry.blocks === command && (() => { try { return !dependencyTarget(state, actor, entry.targetType, entry.targetId).satisfied; } catch { return true; } })()));
    return { ...link, label: task.title, phase: task.phase, status: task.status, departmentCode: task.departmentCode, responsibleUserId: task.responsibleUserId, blocked };
  }
  const item = findOrThrowScoped(state.items.find((entry) => entry.id === link.targetId));
  if (!canViewItem(state, actor, item)) throw new ApiError("SCOPE_DENIED", "Você não tem acesso a este recurso.", 404);
  const request = findOrThrowScoped(state.requests.find((entry) => entry.id === item.requestId));
  if (request.patientId !== plan.patientId || request.encounterId !== plan.encounterId) throw new ApiError("VALIDATION_ERROR", "O exame pertence a outro contexto assistencial.", 400);
  return { ...link, label: state.services.find((entry) => entry.id === item.serviceId)?.name ?? "Exame", phase: diagnosticPlannerPhase(item.status), status: item.status, departmentCode: item.departmentCode, responsibleUserId: item.assignedUserId, blocked: false };
}

export function hospitalPlanView(state: StoreState, actor: User, plan: HospitalPlan, permission: Permission = "plan.view"): HospitalPlanView {
  requireHospitalPlanAccess(state, actor, permission, plan);
  const activities = plan.links.flatMap((link) => { try { return [planActivity(state, actor, plan, link)]; } catch { return []; } });
  const unique = new Map(activities.map((entry) => [`${entry.targetType}:${entry.targetId}`, entry]));
  const completed = [...unique.values()].filter((entry) => entry.phase === "COMPLETED").length;
  const permissions: Permission[] = [];
  for (const action of ["plan.view", "plan.update", "plan.archive"] as const) if (canAccessHospitalPlan(state, actor, action, plan) && (action === "plan.view" || action === "plan.archive" && plan.state !== "ARCHIVED" || action === "plan.update" && plan.state === "ACTIVE")) permissions.push(action);
  const steps = plan.steps.map((step) => {
    const rows = new Map(activities.filter((activity) => activity.stepId === step.id).map((entry) => [`${entry.targetType}:${entry.targetId}`, entry]));
    const completedActivities = [...rows.values()].filter((entry) => entry.phase === "COMPLETED").length;
    const blockedActivities = [...rows.values()].filter((entry) => entry.blocked).length;
    const state = !rows.size ? "NO_VISIBLE_ACTIVITIES" as const : completedActivities === rows.size ? "COMPLETED" as const : blockedActivities ? "BLOCKED" as const : [...rows.values()].some((entry) => entry.phase === "IN_PROGRESS") ? "IN_PROGRESS" as const : "PENDING" as const;
    return { ...step, visibleActivities: rows.size, completedActivities, blockedActivities, state };
  }).sort((a, b) => a.sortOrder - b.sortOrder || a.id.localeCompare(b.id));
  return { plan: { ...plan, documentSnapshots: visibleHospitalDocumentSnapshots(state, actor, plan.documentSnapshots, plan.departmentCodes), links: activities.map(({ id, stepId, targetId, targetType }) => ({ id, stepId, targetId, targetType })) }, permissions, activities, steps, summary: { visibleActivities: unique.size, completedActivities: completed, pendingActivities: unique.size - completed, blockedActivities: [...unique.values()].filter((entry) => entry.blocked).length, denominator: "AUTHORIZED_UNIQUE_ACTIVITIES" } };
}

export function requirePlanDepartmentBindings(state: StoreState, actor: User, departments: string[], permission: "plan.create" | "plan.update" = "plan.create"): void {
  if (!departments.length || new Set(departments).size !== departments.length) throw new ApiError("VALIDATION_ERROR", "Selecione setores distintos para o plano.", 400);
  for (const code of departments) {
    const department = findOrThrowScoped(state.departments.find((entry) => entry.code === code && entry.active));
    requirePermission(actor, permission, { departmentCode: department.code });
  }
}
