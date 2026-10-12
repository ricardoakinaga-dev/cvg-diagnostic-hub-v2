import { describe, expect, it, vi } from "vitest";
import { createDemoState } from "../store/fixtures";
import { MemoryStore } from "../store/memory-store";
import { createApplicationService } from "./service";
import { systemGroupId } from "../security/access-group-policy";

function setup() {
  const state = createDemoState(); const base = state.users.find((user) => user.id === "user-vet")!;
  state.users.push({ ...base, id: "restricted", email: "restricted@example.test", patientIds: ["patient-mel"] }, { ...base, id: "super", role: "SUPERADMIN", accessGroupId: systemGroupId("SUPERADMIN") });
  const store = new MemoryStore(state); const service = createApplicationService(store);
  const actor = (id = "user-vet") => store.getState().users.find((user) => user.id === id)!;
  const create = (key: string, patientId?: string, encounterId?: string) => service.createHospitalTask(actor(), { title: `Conferência ${key}`, typeId: patientId ? "hospital-task-type-care" : "hospital-task-type-routine", departmentCode: "INPATIENT", patientId, encounterId, priority: "ROUTINE", idempotencyKey: key });
  return { store, service, actor, create };
}

describe("authorized planner search and history", () => {
  it("searches real tasks, requests, exams, patients and encounters only when each source can be opened", async () => {
    const { service, actor, create } = setup(); await create("Thor cuidado", "patient-thor", "encounter-thor");
    await service.createRequest(actor(), { patientId: "patient-thor", encounterId: "encounter-thor", priority: "ROUTINE", items: [{ serviceId: "service-hemogram" }] }, { idempotencyKey: "request" });
    const visible = await service.searchPlanner(actor(), "Thor");
    expect(new Set(visible.items.map((result) => result.type))).toEqual(new Set(["HOSPITAL_TASK", "DIAGNOSTIC_REQUEST", "DIAGNOSTIC_ITEM", "PATIENT", "ENCOUNTER"]));
    expect((await service.searchPlanner(actor("restricted"), "Thor")).total).toBe(0);
    expect(JSON.stringify(await service.searchPlanner(actor("restricted"), "Thor"))).not.toMatch(/HIS-THOR|cuidado/);
    await expect(service.searchPlanner(actor("user-admin"), "Thor")).rejects.toMatchObject({ status: 404 });
    expect((await service.searchPlanner(actor(), "HIS-THOR-001", { types: ["PATIENT"] })).items[0].id).toBe("patient-thor");
  });
  it("paginates the complete authorized history and honors priority before taking a page", async () => {
    const { service, actor, create } = setup();
    for (let index = 0; index < 31; index++) await create(`item-${index}`);
    const emergency = await service.createHospitalTask(actor(), { title: "Prioridade da busca", typeId: "hospital-task-type-routine", departmentCode: "INPATIENT", priority: "EMERGENCY", idempotencyKey: "emergency-search" });
    const first = await service.searchPlanner(actor(), "", { types: ["HOSPITAL_TASK"], orderBy: "PRIORITY", direction: "DESC", limit: 10 });
    expect(first.total).toBe(32); expect(first.items[0].id).toBe(emergency.task.id);
    const ids = new Set(first.items.map((item) => item.id)); let cursor = first.nextCursor;
    while (cursor) { const page = await service.searchPlanner(actor(), "", { types: ["HOSPITAL_TASK"], orderBy: "PRIORITY", direction: "DESC", limit: 10, cursor }); expect(page.total).toBe(32); for (const item of page.items) { expect(ids.has(item.id)).toBe(false); ids.add(item.id); } cursor = page.nextCursor; }
    expect(ids.size).toBe(32);
  });
  it("withdraws a patient's search, reading and history on the next operation, even from its author", async () => {
    const { store, service, actor, create } = setup(); const task = await create("private-patient", "patient-thor", "encounter-thor");
    const snapshot = actor();
    await store.transaction((state) => ({ state: { ...state, users: state.users.map((user) => user.id === snapshot.id ? { ...user, patientIds: ["patient-mel"] } : user) }, result: undefined }));
    expect((await service.searchPlanner(snapshot, "private-patient")).total).toBe(0);
    await expect(service.getHospitalTask(snapshot, task.task.id)).rejects.toMatchObject({ status: 404 });
    await expect(service.getHospitalTaskHistory(snapshot, task.task.id)).rejects.toMatchObject({ status: 404 });
  });
  it("filters history to its task and revalidates revocation after the asynchronous read", async () => {
    const { store, service, actor, create } = setup(); const first = await create("first-history"); const second = await create("second-history");
    const history = await service.getHospitalTaskHistory(actor(), first.task.id, { limit: 1 }); expect(history.total).toBe(1); expect(history.items[0].entityId).toBe(first.task.id); expect(history.items.map((event) => event.entityId)).not.toContain(second.task.id);
    const read = store.readAuditEvents.bind(store);
    vi.spyOn(store, "readAuditEvents").mockImplementationOnce(async (query) => { const page = await read(query); await store.transaction((state) => ({ state: { ...state, users: state.users.map((user) => user.id === "user-vet" ? { ...user, active: false } : user) }, result: undefined })); return page; });
    await expect(service.getHospitalTaskHistory(actor(), first.task.id)).rejects.toMatchObject({ status: 401 });
  });
  it("restricts delegated departments and never interprets assigned responsibility as an access grant", async () => {
    const { store, service, actor } = setup();
    const lab = await service.createHospitalTask(actor("super"), { title: "Fila delegada", typeId: "hospital-task-type-routine", departmentCode: "LABORATORY", priority: "ROUTINE", idempotencyKey: "lab" });
    const rx = await service.createHospitalTask(actor("super"), { title: "Fila não delegada", typeId: "hospital-task-type-routine", departmentCode: "RADIOLOGY", priority: "ROUTINE", idempotencyKey: "rx" });
    await store.transaction((state) => ({ state: { ...state, users: state.users.map((user) => user.id === "user-manager" ? { ...user, managedDepartmentCodes: ["LABORATORY"] } : user) }, result: undefined }));
    const results = await service.searchPlanner(actor("user-manager"), "Fila", { types: ["HOSPITAL_TASK"] });
    expect(results.items.map((item) => item.id)).toEqual([lab.task.id]); expect(JSON.stringify(results)).not.toContain(rx.task.title);
    expect((await service.searchPlanner(actor(), "Fila", { types: ["HOSPITAL_TASK"] })).total).toBe(0);
  });
});
