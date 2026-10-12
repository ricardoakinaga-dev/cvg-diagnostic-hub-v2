import type { HospitalCalendarEvent, HospitalCalendarFilters, HospitalCalendarPage, HospitalResourceWindow, HospitalSchedule } from "@cvg/contracts";
import { createHash } from "node:crypto";
import type { StoreState, User } from "../domain/models";
import type { ApplicationServiceContext } from "./service-context";
import { ApiError } from "../http/envelope";
import { canAccessResource } from "../security/authorization";
import { hospitalCalendarFiltersSchema } from "../http/hospital-resource-schemas";
import { validateCommand } from "./hospital-service-policy";
import { canViewItem, requireActiveUser, requirePermission } from "./service-common";
import { canAccessHospitalTask, taskDate } from "./hospital-task-policy";
import { decodeKeysetCursor, pageSize } from "./service-pagination";

export function calendarWindow(from: string, to: string): { startsAt: string; endsAt: string } {
  const startsAt = taskDate(from)!; const endsAt = taskDate(to)!;
  if (!startsAt || !endsAt || startsAt >= endsAt || Date.parse(endsAt) - Date.parse(startsAt) > 93 * 86_400_000) throw new ApiError("VALIDATION_ERROR", "Informe um intervalo de até 93 dias com fuso.", 400);
  return { startsAt, endsAt };
}
function eventsFor(state: StoreState, actor: User): HospitalCalendarEvent[] {
  const items = state.items.filter((item) => {
    const request = state.requests.find((entry) => entry.id === item.requestId);
    return request && canViewItem(state, actor, item) && canAccessResource(actor, "hospital_calendar.view", { patientId: request.patientId, departmentCode: item.departmentCode });
  });
  const tasks = state.hospitalTasks.filter((task) => canAccessHospitalTask(state, actor, "hospital_task.view", task) && canAccessHospitalTask(state, actor, "hospital_calendar.view", task));
  const itemIds = new Set(items.map((item) => item.id)); const taskIds = new Set(tasks.map((task) => task.id));
  const events: HospitalCalendarEvent[] = [];
  for (const schedule of state.schedules) {
    if (Boolean(schedule.procedureId) === Boolean(schedule.hospitalTaskId)) continue;
    const procedure = schedule.procedureId ? state.procedures.find((entry) => entry.id === schedule.procedureId) : undefined;
    const item = procedure && itemIds.has(procedure.itemId) ? items.find((entry) => entry.id === procedure.itemId) : undefined;
    const task = schedule.hospitalTaskId && taskIds.has(schedule.hospitalTaskId) ? tasks.find((entry) => entry.id === schedule.hospitalTaskId) : undefined;
    if (!item && !task) continue;
    const label = task?.title ?? item!.definitionSnapshot?.definition.name ?? state.services.find((entry) => entry.id === item!.serviceId)?.name ?? "Exame";
    const departmentCode = task?.departmentCode ?? item!.departmentCode; const targetId = task?.id ?? item!.id;
    events.push({ id: `reservation:${schedule.id}`, kind: "RESERVATION", targetType: task ? "HOSPITAL_TASK" : "DIAGNOSTIC_ITEM", targetId, departmentCode, label, startsAt: schedule.startsAt, endsAt: schedule.endsAt, schedule: structuredClone(schedule) as HospitalSchedule, deepLink: task ? `/planner/tasks/${task.id}` : `/requests/${item!.requestId}#${item!.id}` });
  }
  for (const item of items) {
    const label = item.definitionSnapshot?.definition.name ?? state.services.find((entry) => entry.id === item.serviceId)?.name ?? "Exame";
    events.push({ id: `deadline:${item.id}`, kind: "DEADLINE", targetType: "DIAGNOSTIC_ITEM", targetId: item.id, departmentCode: item.departmentCode, label, startsAt: item.dueAt, dueAt: item.dueAt, deepLink: `/requests/${item.requestId}#${item.id}` });
    if (item.startedAt) events.push({ id: `execution:${item.id}`, kind: "EXECUTION", targetType: "DIAGNOSTIC_ITEM", targetId: item.id, departmentCode: item.departmentCode, label, startsAt: item.startedAt, ...(item.performedAt ? { endsAt: item.performedAt } : {}), deepLink: `/requests/${item.requestId}#${item.id}` });
  }
  for (const task of tasks) {
    const endsAt = task.completedAt ?? task.cancelledAt;
    if (task.startedAt || task.careExecution?.performedAt) events.push({ id: `execution:${task.id}`, kind: "EXECUTION", targetType: "HOSPITAL_TASK", targetId: task.id, departmentCode: task.departmentCode, label: task.title, startsAt: task.startedAt ?? task.careExecution!.performedAt, ...(endsAt ? { endsAt } : {}), deepLink: `/planner/tasks/${task.id}` });
  }
  return events;
}

function intersectsWindow(state: StoreState, event: HospitalCalendarEvent, window: HospitalResourceWindow): boolean {
  if (event.startsAt >= window.endsAt) return false;
  if (event.endsAt && event.endsAt !== event.startsAt) return event.endsAt > window.startsAt;
  if (!event.endsAt && event.kind === "EXECUTION") {
    const open = event.targetType === "HOSPITAL_TASK"
      ? state.hospitalTasks.some(task => task.id === event.targetId && task.phase === "IN_PROGRESS")
      : state.items.some(item => item.id === event.targetId && item.status === "IN_PROGRESS");
    if (open) return true;
  }
  // Deadlines, instantaneous executions and legacy terminal records without an
  // actual end are points. Only a current execution can cross the window open.
  return event.startsAt >= window.startsAt;
}

export function createHospitalCalendarReadService({ store }: ApplicationServiceContext) {
  return {
    async listHospitalCalendar(actor: User, filters: HospitalCalendarFilters): Promise<HospitalCalendarPage> {
      const parsed = validateCommand(hospitalCalendarFiltersSchema, filters); const window = calendarWindow(parsed.from, parsed.to);
      const state = await store.readState(); const current = requireActiveUser(state, actor); requirePermission(current, "hospital_calendar.view", { departmentCode: parsed.departmentCode });
      const limit = pageSize(parsed.limit ?? 50); const scope = createHash("sha256").update(JSON.stringify([current.id, parsed.departmentCode ?? null, parsed.resourceId ?? null, window, parsed.kinds ?? null])).digest("hex");
      const cursor = decodeKeysetCursor<{ scope: string; at: string; id: string }>(parsed.cursor, (value) => value.scope === scope && typeof value.at === "string" && !Number.isNaN(Date.parse(value.at)) && typeof value.id === "string" && value.id.length <= 200);
      const all = eventsFor(state, current).filter((event) => (!parsed.departmentCode || event.departmentCode === parsed.departmentCode) && (!parsed.kinds || parsed.kinds.includes(event.kind)) && (!parsed.resourceId || event.kind === "RESERVATION" && event.schedule?.resourceIds?.includes(parsed.resourceId)) && intersectsWindow(state, event, window)).sort((a, b) => a.startsAt.localeCompare(b.startsAt) || a.id.localeCompare(b.id));
      const page = all.filter((event) => !cursor || event.startsAt > cursor.at || event.startsAt === cursor.at && event.id.localeCompare(cursor.id) > 0).slice(0, limit + 1); const items = page.slice(0, limit); const last = items.at(-1);
      return { items, total: all.length, ...(page.length > limit && last ? { nextCursor: Buffer.from(JSON.stringify({ scope, at: last.startsAt, id: last.id })).toString("base64url") } : {}) };
    }
  };
}
