"use client";

import type { SessionUser } from "@cvg/contracts";
import { usePlannerResource } from "./use-planner-resource";

export interface PlannerManagementOptions { departments: Array<{ code: string; name: string }>; staff: Array<{ id: string; displayName: string; role: string; departmentCode: string }> }
export type PlannerManagementAction = "plan.create" | "plan.update" | "shift.manage" | "handoff.offer" | "recurrence.manage" | "checklist_template.manage";
export function useHospitalPlannerOptions(user: SessionUser | undefined, action: PlannerManagementAction) {
  return usePlannerResource<PlannerManagementOptions>(user?.id, `/hospital-planner/options?action=${action}`, user?.permissions?.includes(action) === true);
}
