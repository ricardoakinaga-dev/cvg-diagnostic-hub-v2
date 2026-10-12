import { describe, expect, it } from "vitest";
import { hospitalOperationFixture } from "@/test/hospital-operation-fixtures";

describe("global keyset order for the current authorized work", () => {
  it.each(["ASC", "DESC"] as const)("puts unplanned work last in planned-start %s order and traverses equal date ties once", async (direction) => {
    const c = hospitalOperationFixture(); const actor = c.user("user-vet");
    const create = (title: string, plannedStartAt?: string) => c.service.createHospitalTask(actor, { title, typeId: "hospital-task-type-routine", departmentCode: "INPATIENT", priority: "ROUTINE", plannedStartAt, idempotencyKey: title });
    const first = await create("Primeira", "2026-10-12T10:00:00Z"); const second = await create("Segunda", "2026-10-12T10:00:00Z"); const late = await create("Tarde", "2026-10-12T12:00:00Z"); const unplanned = await create("Sem horário");
    const ids: string[] = []; let cursor: string | undefined;
    do { const page = await c.service.listHospitalTasks(actor, { orderBy: "PLANNED_START", direction, limit: 1, cursor }); ids.push(...page.items.map((view) => view.task.id)); expect(page.total).toBe(4); cursor = page.nextCursor; } while (cursor);
    expect(ids.at(-1)).toBe(unplanned.task.id); expect(new Set(ids).size).toBe(4);
    const ties = [first.task.id, second.task.id].sort((a, b) => a.localeCompare(b));
    expect(ids.slice(direction === "ASC" ? 0 : 1, direction === "ASC" ? 2 : 3)).toEqual(ties);
    expect(ids[direction === "ASC" ? 2 : 0]).toBe(late.task.id);
  });
  it("orders priorities ascending, treating nonactivity search references as ordinary priority, and rejects forged cursor domains", async () => {
    const c = hospitalOperationFixture(); const actor = c.user("user-vet");
    for (const priority of ["EMERGENCY", "ROUTINE", "URGENT"] as const) await c.service.createHospitalTask(actor, { title: priority, typeId: "hospital-task-type-routine", departmentCode: "INPATIENT", priority, idempotencyKey: priority });
    const first = await c.service.listHospitalTasks(actor, { orderBy: "PRIORITY", direction: "ASC", limit: 1 });
    expect(first.items[0].task.priority).toBe("ROUTINE");
    const next = await c.service.listHospitalTasks(actor, { orderBy: "PRIORITY", direction: "ASC", limit: 1, cursor: first.nextCursor });
    expect(next.items[0].task.priority).toBe("URGENT");
    expect((await c.service.searchPlanner(actor, "", { types: ["PATIENT"], orderBy: "PRIORITY", direction: "ASC", limit: 1 })).total).toBe(2);
    const encoded = (payload: unknown) => Buffer.from(JSON.stringify(payload)).toString("base64url");
    for (const payload of [{ orderBy: "PRIORITY", direction: "ASC", value: 3, id: "id" }, { orderBy: "PRIORITY", direction: "ASC", value: 1, id: "" }, { orderBy: "PRIORITY", direction: "ASC", value: 1, id: "x".repeat(201) }, { orderBy: "PRIORITY", direction: "ASC", value: 1, id: 7 }]) await expect(c.service.listHospitalTasks(actor, { orderBy: "PRIORITY", direction: "ASC", cursor: encoded(payload) })).rejects.toMatchObject({ status: 400 });
    for (const value of ["not-a-date", 12]) await expect(c.service.listHospitalTasks(actor, { orderBy: "UPDATED", cursor: encoded({ orderBy: "UPDATED", direction: "DESC", value, id: "id" }) })).rejects.toMatchObject({ status: 400 });
  });
});
