import type { HospitalTaskPhase, ItemState, PlannerViewFilters, Priority } from "@cvg/contracts";

/** A read-only grouping for cross-surface filters; clinical states and commands remain native. */
export function diagnosticPlannerPhase(status: ItemState): HospitalTaskPhase {
  if (status === "COMPLETED") return "COMPLETED";
  if (status === "CANCELLED" || status === "REJECTED") return "CANCELLED";
  return ["IN_PROGRESS", "AWAITING_REPORT", "RESULT_AVAILABLE", "REVIEWED"].includes(status) ? "IN_PROGRESS" : "PENDING";
}

export interface DiagnosticPlannerFilterItem {
  departmentCode: string; status: ItemState; priority: Priority; assignedUserId?: string;
  plannedStartsAt?: string; createdAt: string;
}

/** Matches already authorized items. A saved configuration never authorizes its plan or patient. */
export function matchesDiagnosticPlannerFilters(item: DiagnosticPlannerFilterItem, filters: PlannerViewFilters, belongsToAuthorizedPlan = false): boolean {
  if (filters.typeId || filters.planId && !belongsToAuthorizedPlan) return false;
  if (filters.departmentCode && item.departmentCode !== filters.departmentCode || filters.responsibleUserId && item.assignedUserId !== filters.responsibleUserId || filters.priority && item.priority !== filters.priority || filters.phase && diagnosticPlannerPhase(item.status) !== filters.phase) return false;
  const at = Date.parse(item.plannedStartsAt ?? item.createdAt);
  return (!filters.from || at >= Date.parse(filters.from)) && (!filters.to || at <= Date.parse(filters.to));
}
