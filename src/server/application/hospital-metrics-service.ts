import type { HospitalMetricCode, HospitalMetricFilters, HospitalMetricRow, HospitalMetricRowPage, HospitalPlannerMetrics } from "@cvg/contracts";
import { HOSPITAL_METRIC_CODES } from "@cvg/contracts";
import type { StoreState, User } from "../domain/models";
import type { ApplicationServiceContext } from "./service-context";
import { ApiError } from "../http/envelope";
import { hospitalMetricFiltersSchema, hospitalMetricRowsFiltersSchema } from "../http/hospital-analytics-schemas";
import { canViewItem, requireActiveUser, requirePermission } from "./service-common";
import { canAccessHospitalTask, requireHospitalTaskAccess } from "./hospital-task-policy";
import { canAccessHospitalPlan } from "./hospital-plan-policy";
import { hospitalHandoffView } from "./hospital-shift-policy";
import { HOSPITAL_METRIC_DEFINITIONS, hospitalMetricSourcePermission } from "./hospital-metric-definitions";

const terminal = new Set(["COMPLETED", "CANCELLED", "REJECTED", "FAILED", "RESULT_VOIDED"]);
const inWindow = (at: string | undefined, filters: HospitalMetricFilters) => at !== undefined && Date.parse(at) >= Date.parse(filters.from) && Date.parse(at) < Date.parse(filters.to);
export function requireHospitalMetricAccess(state: StoreState, actor: User, filters: HospitalMetricFilters, code?: HospitalMetricCode) {
  requirePermission(actor, "hospital_metric.view", {});
  if (filters.departmentCode) requireHospitalTaskAccess(state, actor, "hospital_metric.view", { departmentCode: filters.departmentCode });
  if (code) {
    if (!HOSPITAL_METRIC_CODES.includes(code)) throw new ApiError("VALIDATION_ERROR", "Indicador desconhecido.", 400);
    requirePermission(actor, hospitalMetricSourcePermission(code), {});
  }
}
/** Current object authorization applies before every numerator, denominator and drill-down. */
export function deriveHospitalMetricRows(state: StoreState, actor: User, code: HospitalMetricCode, filters: HospitalMetricFilters, asOf: string): HospitalMetricRow[] {
  requireHospitalMetricAccess(state, actor, filters, code);
  const withinDepartment = (departmentCode: string) => !filters.departmentCode || filters.departmentCode === departmentCode;
  const taskRows = (id?: string) => state.hospitalTasks.filter((task) => !task.isDraft && !task.draftCancelledAt && (!id || task.id === id) && withinDepartment(task.departmentCode) && canAccessHospitalTask(state, actor, "hospital_task.view", task));
  const itemRows = (id?: string) => state.items.filter((item) => (!id || item.id === id) && withinDepartment(item.departmentCode) && canViewItem(state, actor, item));
  let rows: HospitalMetricRow[] = [];
  if (code.startsWith("TASK_")) for (const task of taskRows()) {
    const occurredAt = code === "TASK_COMPLETED" ? task.completedAt : code === "TASK_CANCELLED" ? task.cancelledAt : task.createdAt;
    if (!inWindow(occurredAt, filters) || code === "TASK_PENDING" && !["PENDING", "IN_PROGRESS"].includes(task.phase)) continue;
    rows.push({ targetType: "HOSPITAL_TASK", id: task.id, label: `${task.taskCode} · ${task.title}`, departmentCode: task.departmentCode, occurredAt: occurredAt!, status: task.status, deepLink: `/planner/tasks/${task.id}` });
  } else if (code.startsWith("DIAGNOSTIC_")) for (const item of itemRows()) {
    const occurredAt = code === "DIAGNOSTIC_EXECUTED" ? item.performedAt ?? (item.workflowType === "LABORATORY" ? item.completedAt : undefined) : code === "DIAGNOSTIC_REVIEWED" ? item.reviewedAt : item.requestedAt;
    if (!inWindow(occurredAt, filters) || ["DIAGNOSTIC_PENDING", "DIAGNOSTIC_OVERDUE"].includes(code) && terminal.has(item.status) || code === "DIAGNOSTIC_OVERDUE" && (!Number.isFinite(Date.parse(item.dueAt)) || Date.parse(item.dueAt) >= Date.parse(asOf))) continue;
    rows.push({ targetType: "DIAGNOSTIC_ITEM", id: item.id, label: state.services.find((service) => service.id === item.serviceId)?.name ?? "Exame", departmentCode: item.departmentCode, occurredAt: occurredAt!, status: item.status, deepLink: `/requests/${item.requestId}#${item.id}` });
  } else if (code.startsWith("PLAN_")) for (const plan of state.hospitalPlans) {
    if (!canAccessHospitalPlan(state, actor, "plan.view", plan)) continue;
    const departmentCode = plan.departmentCodes.find((departmentCode) => withinDepartment(departmentCode) && canAccessHospitalTask(state, actor, "plan.view", { departmentCode, patientId: plan.patientId }));
    const occurredAt = code === "PLAN_CLOSED" ? plan.closedAt : plan.createdAt;
    if (!departmentCode || !inWindow(occurredAt, filters)) continue;
    rows.push({ targetType: "HOSPITAL_PLAN", id: plan.id, label: `${plan.code} · ${plan.title}`, departmentCode, occurredAt: occurredAt!, status: plan.state, deepLink: `/planner/plans/${plan.id}` });
  } else if (code === "SHIFT_STARTED") for (const shift of state.hospitalShifts) {
    if (!withinDepartment(shift.departmentCode) || !inWindow(shift.startAt, filters) || !canAccessHospitalTask(state, actor, "shift.view", shift)) continue;
    rows.push({ targetType: "HOSPITAL_SHIFT", id: shift.id, label: `${shift.code} · ${shift.name}`, departmentCode: shift.departmentCode, occurredAt: shift.startAt, status: shift.status, deepLink: `/planner/shifts/${shift.id}` });
  } else for (const handoff of state.hospitalHandoffs) {
    if (handoff.state !== "ACCEPTED" || !withinDepartment(handoff.departmentCode) || !inWindow(handoff.acceptedAt, filters)) continue;
    try {
      const visible = hospitalHandoffView(state, actor, handoff).activities;
      for (const entry of visible) {
        const target = entry.targetType === "HOSPITAL_TASK" ? taskRows(entry.targetId)[0] : itemRows(entry.targetId)[0];
        if (target) rows.push({ targetType: entry.targetType, id: entry.targetId, label: entry.label, departmentCode: target.departmentCode, occurredAt: handoff.acceptedAt!, status: entry.status, deepLink: entry.targetType === "HOSPITAL_TASK" ? `/planner/tasks/${entry.targetId}` : `/requests/${(target as StoreState["items"][number]).requestId}#${entry.targetId}` });
      }
    } catch { continue; }
  }
  const unique = new Map<string, HospitalMetricRow>();
  for (const row of rows) { const key = `${row.targetType}:${row.id}`; const previous = unique.get(key); if (!previous || Date.parse(row.occurredAt) > Date.parse(previous.occurredAt)) unique.set(key, row); }
  rows = [...unique.values()];
  return rows.sort((left, right) => Date.parse(right.occurredAt) - Date.parse(left.occurredAt) || `${left.targetType}:${left.id}`.localeCompare(`${right.targetType}:${right.id}`));
}
export function createHospitalMetricsService({ store }: ApplicationServiceContext) {
  return {
    async getHospitalPlannerMetrics(actor: User, filters: HospitalMetricFilters): Promise<HospitalPlannerMetrics> {
      if (!hospitalMetricFiltersSchema.safeParse(filters).success) throw new ApiError("VALIDATION_ERROR", "Filtros de indicadores inválidos.", 400);
      const state = await store.readState(); const current = requireActiveUser(state, actor); requireHospitalMetricAccess(state, current, filters); const asOf = new Date().toISOString();
      const values = HOSPITAL_METRIC_DEFINITIONS.map((definition) => {
        try { requirePermission(current, hospitalMetricSourcePermission(definition.code), {}); } catch { return { definition, value: null, availability: "NOT_AUTHORIZED" as const }; }
        return { definition, value: deriveHospitalMetricRows(state, current, definition.code, filters, asOf).length, availability: "AUTHORIZED" as const };
      });
      const departmentCodes = state.departments.filter((department) => (!filters.departmentCode || filters.departmentCode === department.code) && canAccessHospitalTask(state, current, "hospital_metric.view", { departmentCode: department.code })).map((department) => department.code);
      return { asOf, window: { ...filters, convention: "START_INCLUSIVE_END_EXCLUSIVE" }, scope: { departmentCodes, policy: "CURRENT_OBJECT_AUTHORIZATION" }, values };
    },
    async listHospitalMetricRows(actor: User, code: HospitalMetricCode, filters: HospitalMetricFilters & { limit?: number; cursor?: string }): Promise<HospitalMetricRowPage> {
      if (!hospitalMetricRowsFiltersSchema.safeParse(filters).success) throw new ApiError("VALIDATION_ERROR", "Filtros de indicador inválidos.", 400);
      const state = await store.readState(); const current = requireActiveUser(state, actor); const rows = deriveHospitalMetricRows(state, current, code, filters, new Date().toISOString()); const limit = filters.limit ?? 25;
      const binding = JSON.stringify([code, filters.from, filters.to, filters.departmentCode ?? null]); let after = rows;
      if (filters.cursor) {
        try {
          const cursor = JSON.parse(Buffer.from(filters.cursor, "base64url").toString("utf8"));
          if (cursor.binding !== binding || typeof cursor.id !== "string" || cursor.id.length > 160 || typeof cursor.at !== "string" || Number.isNaN(Date.parse(cursor.at))) throw new Error("invalid");
          after = rows.filter((row) => Date.parse(row.occurredAt) < Date.parse(cursor.at) || Date.parse(row.occurredAt) === Date.parse(cursor.at) && `${row.targetType}:${row.id}`.localeCompare(cursor.id) > 0);
        } catch { throw new ApiError("VALIDATION_ERROR", "Cursor inválido para este indicador e intervalo.", 400); }
      }
      const items = after.slice(0, limit); const last = items.at(-1);
      return { items, total: rows.length, limit, ...(last && after.length > items.length ? { nextCursor: Buffer.from(JSON.stringify({ binding, id: `${last.targetType}:${last.id}`, at: last.occurredAt })).toString("base64url") } : {}) };
    }
  };
}
