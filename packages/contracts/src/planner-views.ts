import type { Priority } from "./diagnostic-catalog";
import type { HospitalTaskPhase } from "./hospital-tasks";

export interface PlannerViewFilters {
  departmentCode?: string;
  responsibleUserId?: string;
  typeId?: string;
  priority?: Priority;
  phase?: HospitalTaskPhase;
  from?: string;
  to?: string;
  planId?: string;
}
export const PLANNER_VIEW_COLUMNS = ["title", "department", "responsible", "type", "priority", "phase", "plannedStart", "plannedEnd", "updatedAt"] as const;
export interface PlannerViewDisplay {
  layout: "LIST" | "BOARD" | "TABLE" | "CALENDAR";
  orderBy: "UPDATED" | "PRIORITY" | "PLANNED_START";
  direction: "ASC" | "DESC";
  groupBy: "NONE" | "DEPARTMENT" | "RESPONSIBLE" | "TYPE" | "PHASE";
  columns: Array<(typeof PLANNER_VIEW_COLUMNS)[number]>;
}
/** Persisted configuration never supplies data access to the reader. */
export interface SavedPlannerView {
  id: string;
  name: string;
  ownerId: string;
  sharedDepartmentCode?: string;
  filters: PlannerViewFilters;
  display: PlannerViewDisplay;
  active: boolean;
  version: number;
  createdAt: string;
  updatedAt: string;
}
