import type { HospitalCapacityFilters, HospitalCapacityView, HospitalResource, HospitalResourceCapacity, HospitalResourceWindow, HospitalSchedule } from "@cvg/contracts";
import type { StoreState, User } from "../domain/models";
import type { ApplicationServiceContext } from "./service-context";
import { hospitalCapacityFiltersSchema } from "../http/hospital-resource-schemas";
import { canViewItem, requireActiveUser, requirePermission } from "./service-common";
import { validateCommand } from "./hospital-service-policy";
import { canAccessHospitalResource, requireHospitalResourceAccess, resourceWindows } from "./hospital-resource-policy";
import { canAccessHospitalTask } from "./hospital-task-policy";
import { calendarWindow } from "./hospital-calendar-read-service";
import { hasUnreconciledAdmissions } from "./hospital-bed-policy";

function clipped(windows: HospitalResourceWindow[], window: HospitalResourceWindow): HospitalResourceWindow[] {
  return windows.flatMap((entry) => {
    const startsAt = entry.startsAt > window.startsAt ? entry.startsAt : window.startsAt; const endsAt = entry.endsAt < window.endsAt ? entry.endsAt : window.endsAt;
    return startsAt < endsAt ? [{ startsAt, endsAt }] : [];
  });
}
function minutes(windows: HospitalResourceWindow[]): number { return resourceWindows(windows).reduce((sum, entry) => sum + (Date.parse(entry.endsAt) - Date.parse(entry.startsAt)) / 60_000, 0); }
function executionCrossesWindow(state: StoreState, resource: HospitalResource, schedule: HospitalSchedule, window: HospitalResourceWindow, asOf: string): boolean {
  if (Boolean(schedule.procedureId) === Boolean(schedule.hospitalTaskId)) return false;
  let startedAt: string | undefined;
  if (schedule.procedureId) {
    const procedure = state.procedures.find(entry => entry.id === schedule.procedureId && entry.status === "IN_PROGRESS" && entry.scheduleIds.includes(schedule.id));
    const item = procedure && state.items.find(entry => entry.id === procedure.itemId && entry.procedureId === procedure.id && entry.status === "IN_PROGRESS" && entry.departmentCode === resource.departmentCode);
    if (!item || !state.requests.some(request => request.id === item.requestId)) return false;
    startedAt = item.startedAt;
  } else {
    const task = state.hospitalTasks.find(entry => entry.id === schedule.hospitalTaskId && entry.phase === "IN_PROGRESS" && entry.departmentCode === resource.departmentCode && !entry.isDraft && !entry.draftCancelledAt && !entry.archivedAt && !entry.completedAt && !entry.cancelledAt);
    if (!task) return false;
    startedAt = task.startedAt;
  }
  const start = startedAt ? Date.parse(startedAt) : NaN;
  const now = Date.parse(asOf); const end = Date.parse(window.endsAt);
  // The current authority still blocks new reservations when its real start is
  // missing or inconsistent. Do not infer historical occupancy from that state.
  return Number.isFinite(start) && start <= now ? start < end : now < end;
}
function resourceCapacity(state: StoreState, resource: HospitalResource, window: HospitalResourceWindow, asOf: string): HospitalResourceCapacity {
  const base = { resourceId: resource.id, code: resource.code, name: resource.name, kind: resource.kind, departmentCode: resource.departmentCode };
  const available = resource.active && resource.availability === "AVAILABLE" && state.departments.some((department) => department.code === resource.departmentCode && department.active) && (resource.kind !== "PROFESSIONAL" || state.users.some((user) => user.id === resource.userId && user.active && !user.mustChangePassword && user.departmentCode === resource.departmentCode && state.departments.some((department) => department.code === resource.departmentCode && department.memberUserIds.includes(user.id))));
  if (resource.kind === "BED") {
    const occupied = state.admissions.some((admission) => admission.bedResourceId === resource.id && !admission.dischargedAt);
    if (hasUnreconciledAdmissions(state, resource.departmentCode)) return { ...base, unit: "BEDS", nominal: 1, reserved: occupied ? 1 : 0, available: null, unavailable: available ? 0 : 1, availabilityKnown: false, reason: "LEGACY_OCCUPANCY_NOT_LINKED" };
    return { ...base, unit: "BEDS", nominal: 1, reserved: occupied ? 1 : 0, available: available && !occupied ? 1 : 0, unavailable: available ? 0 : 1, availabilityKnown: true, ...(!available ? { reason: "RESOURCE_UNAVAILABLE" as const } : {}) };
  }
  const reservations = state.schedules.filter((schedule) => schedule.status === "SCHEDULED" && schedule.resourceIds?.includes(resource.id));
  const reserved = minutes(clipped(reservations, window)); const windows = resourceWindows(resource.availabilityWindows);
  if (!windows.length) return { ...base, unit: "MINUTES", nominal: null, reserved, available: null, unavailable: null, availabilityKnown: false, reason: "CALENDAR_NOT_CONFIGURED" };
  const nominal = minutes(clipped(windows, window)); const unavailable = available ? 0 : nominal;
  // Reservations retain their planned bounds. Actual execution has no inferred
  // end, so it cannot establish how many minutes remain available in this window.
  if (available && reservations.some(schedule => executionCrossesWindow(state, resource, schedule, window, asOf))) return { ...base, unit: "MINUTES", nominal, reserved, available: null, unavailable, availabilityKnown: false, reason: "EXECUTION_END_UNKNOWN" };
  return { ...base, unit: "MINUTES", nominal, reserved, available: Math.max(0, nominal - unavailable - reserved), unavailable, availabilityKnown: true, ...(!available ? { reason: "RESOURCE_UNAVAILABLE" as const } : {}) };
}

export function createHospitalCapacityService({ store }: ApplicationServiceContext) {
  return {
    async getHospitalCapacity(actor: User, filters: HospitalCapacityFilters): Promise<HospitalCapacityView> {
      const parsed = validateCommand(hospitalCapacityFiltersSchema, filters); const window = calendarWindow(parsed.from, parsed.to); const state = await store.readState(); const current = requireActiveUser(state, actor);
      requirePermission(current, "hospital_capacity.view", { departmentCode: parsed.departmentCode });
      if (parsed.departmentCode) requireHospitalResourceAccess(current, "hospital_capacity.view", parsed.departmentCode);
      const asOf = new Date().toISOString();
      const resources = state.hospitalResources.filter((resource) => (!parsed.departmentCode || resource.departmentCode === parsed.departmentCode) && canAccessHospitalResource(current, "hospital_capacity.view", resource.departmentCode)).map((resource) => resourceCapacity(state, resource, window, asOf));
      const items = state.items.filter((item) => !["COMPLETED", "CANCELLED", "REJECTED"].includes(item.status) && (!parsed.departmentCode || item.departmentCode === parsed.departmentCode) && canViewItem(state, current, item));
      const tasks = state.hospitalTasks.filter((task) => !task.isDraft && !task.draftCancelledAt && !task.archivedAt && !["COMPLETED", "CANCELLED"].includes(task.phase) && (!parsed.departmentCode || task.departmentCode === parsed.departmentCode) && canAccessHospitalTask(state, current, "hospital_task.view", task));
      // This is the complete current authorized load, not a partial sum or a window cohort.
      // Diagnostic items have no effort estimate; their clinical SLA must never supply one.
      const estimatedMinutes = items.length || tasks.some((task) => typeof task.estimatedMinutes !== "number" || !Number.isFinite(task.estimatedMinutes) || task.estimatedMinutes <= 0)
        ? null : tasks.reduce((total, task) => total + task.estimatedMinutes!, 0);
      return { from: window.startsAt, to: window.endsAt, asOf, resources, authorizedLoad: { openDiagnosticItems: items.length, overdueDiagnosticItems: items.filter((item) => item.dueAt < asOf).length, openHospitalTasks: tasks.length, estimatedMinutes }, sla: { source: "REQUEST_CAPTURE", unit: "ELAPSED_HOURS", calendarPausesDeadline: false } };
    }
  };
}
