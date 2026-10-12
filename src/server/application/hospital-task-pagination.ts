import type { HospitalTask, HospitalTaskFilters, Priority } from "@cvg/contracts";
import { ApiError } from "../http/envelope";

/** Keyset order is applied to the complete authorized result, before taking a page. */
export function pagePlannerActivities<T>(rows: T[], filters: HospitalTaskFilters, attributes: (row: T) => { id: string; updatedAt: string; priority?: Priority; plannedStartAt?: string }) {
  const orderBy = filters.orderBy ?? "UPDATED"; const direction = filters.direction ?? "DESC";
  const limit = filters.limit ?? 25; const sign = direction === "ASC" ? 1 : -1;
  const value = (row: T): string | number => { const task = attributes(row); return orderBy === "PRIORITY" ? { ROUTINE: 0, URGENT: 1, EMERGENCY: 2 }[task.priority ?? "ROUTINE"] : orderBy === "PLANNED_START" ? task.plannedStartAt ?? (direction === "ASC" ? "9999-12-31T23:59:59.999Z" : "0001-01-01T00:00:00.000Z") : task.updatedAt; };
  const compare = (left: string | number, right: string | number) => typeof left === "number" && typeof right === "number" ? left - right : String(left).localeCompare(String(right));
  let cursor: { orderBy: string; direction: string; value: string | number; id: string } | undefined;
  if (filters.cursor) {
    try {
      const decoded = JSON.parse(Buffer.from(filters.cursor, "base64url").toString("utf8"));
      if (decoded.orderBy !== orderBy || decoded.direction !== direction || typeof decoded.id !== "string" || !decoded.id || decoded.id.length > 200 || (orderBy === "PRIORITY" ? ![0, 1, 2].includes(decoded.value) : typeof decoded.value !== "string" || Number.isNaN(Date.parse(decoded.value)))) throw new Error("invalid");
      cursor = decoded;
    } catch { throw new ApiError("VALIDATION_ERROR", "Cursor inválido para a ordenação selecionada.", 400); }
  }
  const sorted = [...rows].sort((a, b) => compare(value(a), value(b)) * sign || attributes(a).id.localeCompare(attributes(b).id));
  const after = cursor ? sorted.filter((task) => compare(value(task), cursor!.value) * sign > 0 || compare(value(task), cursor!.value) === 0 && attributes(task).id > cursor!.id) : sorted;
  const items = after.slice(0, limit); const last = items.at(-1);
  return { items, total: rows.length, limit, ...(last && after.length > items.length ? { nextCursor: Buffer.from(JSON.stringify({ orderBy, direction, value: value(last), id: attributes(last).id })).toString("base64url") } : {}) };
}

export const pageHospitalTasks = (rows: HospitalTask[], filters: HospitalTaskFilters) => pagePlannerActivities(rows, filters, (task) => task);
