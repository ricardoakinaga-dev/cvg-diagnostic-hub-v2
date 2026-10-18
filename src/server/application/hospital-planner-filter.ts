import type { HospitalTaskFilters } from "@cvg/contracts";
import type { StoreState, User } from "../domain/models";
import { findOrThrowScoped } from "./service-common";
import { requireHospitalPlanAccess } from "./hospital-plan-policy";
import { requireHospitalTaskAccess } from "./hospital-task-policy";

export function requirePlannerFilterReferences(state: StoreState, actor: User, filters: HospitalTaskFilters): void {
  if (filters.planId) { const plan = findOrThrowScoped(state.hospitalPlans.find((entry) => entry.id === filters.planId)); requireHospitalPlanAccess(state, actor, "plan.view", plan); }
  if (filters.shiftId) { const shift = findOrThrowScoped(state.hospitalShifts.find((entry) => entry.id === filters.shiftId)); requireHospitalTaskAccess(state, actor, "shift.view", shift); }
}
export function matchesPlanActivity(state: StoreState, filters: HospitalTaskFilters, type: "HOSPITAL_TASK" | "DIAGNOSTIC_ITEM", id: string): boolean {
  return !filters.planId || state.hospitalPlans.some((plan) => plan.id === filters.planId && plan.links.some((link) => link.targetType === type && link.targetId === id));
}
