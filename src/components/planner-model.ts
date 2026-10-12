import type { HospitalTaskFilters, HospitalTaskPhase, HospitalTaskView, PlannerViewDisplay, PlannerViewFilters } from "@cvg/contracts";
import { PLANNER_VIEW_COLUMNS } from "@cvg/contracts";
export const PHASE_LABELS: Record<HospitalTaskPhase, string> = { PENDING: "Pendente", IN_PROGRESS: "Em execução", COMPLETED: "Concluída", CANCELLED: "Cancelada" };
export const PLANNER_DEFAULT_DISPLAY: PlannerViewDisplay = { layout: "LIST", orderBy: "UPDATED", direction: "DESC", groupBy: "NONE", columns: ["title", "department", "responsible", "type", "priority", "phase", "plannedStart"] };
export const PLANNER_EMPTY_FILTERS: PlannerViewFilters = {};
export const COLUMN_LABELS: Record<PlannerViewDisplay["columns"][number], string> = { title: "Título", department: "Setor", responsible: "Responsável", type: "Tipo", priority: "Prioridade", phase: "Estado", plannedStart: "Início planejado", plannedEnd: "Fim planejado", updatedAt: "Atualização" };

export function normalizePlannerDisplay(value: unknown): PlannerViewDisplay {
  if (!value || typeof value !== "object" || Array.isArray(value)) return PLANNER_DEFAULT_DISPLAY;
  const input = value as Record<string, unknown>;
  const columns = Array.isArray(input.columns) ? input.columns.filter((column): column is PlannerViewDisplay["columns"][number] => typeof column === "string" && PLANNER_VIEW_COLUMNS.includes(column as PlannerViewDisplay["columns"][number])) : PLANNER_DEFAULT_DISPLAY.columns;
  return {
    layout: ["LIST", "BOARD", "TABLE", "CALENDAR"].includes(String(input.layout)) ? input.layout as PlannerViewDisplay["layout"] : "LIST",
    orderBy: ["UPDATED", "PRIORITY", "PLANNED_START"].includes(String(input.orderBy)) ? input.orderBy as PlannerViewDisplay["orderBy"] : "UPDATED",
    direction: input.direction === "ASC" ? "ASC" : "DESC",
    groupBy: ["NONE", "DEPARTMENT", "RESPONSIBLE", "TYPE", "PHASE"].includes(String(input.groupBy)) ? input.groupBy as PlannerViewDisplay["groupBy"] : "NONE",
    columns: [...new Set(["title" as const, ...columns])]
  };
}
export function normalizePlannerFilters(value: unknown): PlannerViewFilters {
  if (!value || typeof value !== "object" || Array.isArray(value)) return PLANNER_EMPTY_FILTERS;
  const input = value as Record<string, unknown>;
  const result: PlannerViewFilters = {};
  for (const key of ["departmentCode", "responsibleUserId", "typeId", "planId"] as const) if (typeof input[key] === "string" && /^[A-Za-z0-9_-]{1,100}$/.test(input[key])) result[key] = input[key];
  if (["PENDING", "IN_PROGRESS", "COMPLETED", "CANCELLED"].includes(String(input.phase))) result.phase = input.phase as HospitalTaskPhase;
  if (["ROUTINE", "URGENT", "EMERGENCY"].includes(String(input.priority))) result.priority = input.priority as PlannerViewFilters["priority"];
  for (const key of ["from", "to"] as const) if (typeof input[key] === "string" && Number.isFinite(Date.parse(input[key]))) result[key] = input[key];
  return result;
}
export function plannerQuery(filters: HospitalTaskFilters | PlannerViewFilters): string {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(filters)) if (value !== undefined && value !== "") query.set(key, String(value));
  return query.toString();
}
export function taskMatchesFilters(view: HospitalTaskView, filters: PlannerViewFilters, query = ""): boolean {
  const { task } = view;
  // A newly created task has not yet been explicitly linked to a plan.
  if (filters.planId) return false;
  if (filters.departmentCode && task.departmentCode !== filters.departmentCode || filters.typeId && task.typeId !== filters.typeId || filters.phase && task.phase !== filters.phase || filters.priority && task.priority !== filters.priority || filters.responsibleUserId && task.responsibleUserId !== filters.responsibleUserId) return false;
  const date = task.plannedStartAt ?? task.createdAt;
  if (filters.from && date < filters.from || filters.to && date > filters.to) return false;
  return !query.trim() || [task.title, task.description, task.taskCode, view.patient?.displayName, view.patient?.externalId].some((value) => value?.toLocaleLowerCase("pt-BR").includes(query.trim().toLocaleLowerCase("pt-BR")));
}
