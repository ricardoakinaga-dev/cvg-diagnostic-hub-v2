import { describe, expect, it } from "vitest";
import { createDemoState } from "../store/fixtures";
import { MemoryStore } from "../store/memory-store";
import { systemGroupId } from "../security/access-group-policy";
import { createApplicationService } from "./service";

function setup() {
  const state = createDemoState(); const vet = state.users.find((user) => user.id === "user-vet")!;
  state.users.push({ ...vet, id: "super", role: "SUPERADMIN", accessGroupId: systemGroupId("SUPERADMIN") });
  const store = new MemoryStore(state); const service = createApplicationService(store);
  const actor = () => store.getState().users.find((user) => user.id === "user-vet")!;
  const superuser = () => store.getState().users.find((user) => user.id === "super")!;
  const create = (key: string, parentTaskId?: string) => service.createHospitalTask(actor(), { title: key, typeId: "hospital-task-type-routine", departmentCode: "INPATIENT", priority: "ROUTINE", responsibleUserId: actor().id, parentTaskId, idempotencyKey: key });
  return { store, service, actor, superuser, create };
}

describe("task composition and blocking dependencies", () => {
  it("denies hierarchy/dependency mixed cycles and does not auto-complete children", async () => {
    const { service, actor, create } = setup(); const parent = await create("parent"); const child = await create("child", parent.task.id);
    await expect(service.updateHospitalTask(actor(), parent.task.id, { parentTaskId: child.task.id, expectedVersion: 1, idempotencyKey: "parent-cycle" })).rejects.toMatchObject({ status: 409 });
    await expect(service.putHospitalTaskDependency(actor(), child.task.id, { targetType: "HOSPITAL_TASK", targetId: parent.task.id, blocks: "START", active: true, expectedVersion: 1, idempotencyKey: "mixed-cycle" })).rejects.toMatchObject({ status: 409 });
    const started = await service.commandHospitalTask(actor(), parent.task.id, { command: "START", expectedVersion: 1, idempotencyKey: "parent-start" });
    const completed = await service.commandHospitalTask(actor(), parent.task.id, { command: "COMPLETE", expectedVersion: started.task.version, idempotencyKey: "parent-complete" });
    expect(completed.children[0].phase).toBe("PENDING"); expect((await service.getHospitalTask(actor(), child.task.id)).task.version).toBe(1);
  });
  it("blocks only the declared command and resumes after the prerequisite completes", async () => {
    const { service, actor, create } = setup(); const prerequisite = await create("prerequisite"); const dependent = await create("dependent");
    const linked = await service.putHospitalTaskDependency(actor(), dependent.task.id, { targetType: "HOSPITAL_TASK", targetId: prerequisite.task.id, blocks: "COMPLETE", active: true, expectedVersion: 1, idempotencyKey: "link" });
    const started = await service.commandHospitalTask(actor(), dependent.task.id, { command: "START", expectedVersion: linked.task.version, idempotencyKey: "dependent-start" });
    await expect(service.commandHospitalTask(actor(), dependent.task.id, { command: "COMPLETE", expectedVersion: started.task.version, idempotencyKey: "blocked" })).rejects.toMatchObject({ code: "TASK_DEPENDENCY_PENDING", status: 409 });
    const sourceStarted = await service.commandHospitalTask(actor(), prerequisite.task.id, { command: "START", expectedVersion: 1, idempotencyKey: "source-start" });
    await service.commandHospitalTask(actor(), prerequisite.task.id, { command: "COMPLETE", expectedVersion: sourceStarted.task.version, idempotencyKey: "source-complete" });
    expect((await service.commandHospitalTask(actor(), dependent.task.id, { command: "COMPLETE", expectedVersion: started.task.version, idempotencyKey: "unblocked" })).task.phase).toBe("COMPLETED");
  });
  it("keeps diagnostic identity and FSM authoritative; general completion never releases or completes an exam", async () => {
    const { store, service, actor, create } = setup();
    const request = await service.createRequest(actor(), { patientId: "patient-thor", encounterId: "encounter-thor", priority: "ROUTINE", items: [{ serviceId: "service-hemogram" }] }, { idempotencyKey: "diagnostic" });
    const task = await create("check-results"); const item = request.items[0];
    const originalItem = structuredClone(store.getState().items[0]);
    const linked = await service.putHospitalTaskDependency(actor(), task.task.id, { targetType: "DIAGNOSTIC_ITEM", targetId: item.id, blocks: "COMPLETE", active: true, expectedVersion: 1, idempotencyKey: "exam-link" });
    await service.commandHospitalTask(actor(), task.task.id, { command: "START", expectedVersion: linked.task.version, idempotencyKey: "start" });
    await expect(service.commandHospitalTask(actor(), task.task.id, { command: "COMPLETE", expectedVersion: 3, idempotencyKey: "must-not-complete-exam" })).rejects.toMatchObject({ status: 409 });
    expect(store.getState().items[0]).toEqual(originalItem); expect(store.getState().results).toEqual([]);
    await expect(service.createHospitalTask(actor(), { title: "Exame substituto", typeId: "hospital-task-type-routine", departmentCode: "INPATIENT", serviceId: item.serviceId, priority: "ROUTINE", idempotencyKey: "fake-exam" })).rejects.toMatchObject({ status: 400 });
  });
  it("redacts an inaccessible prerequisite and never exposes its title, identifier or responsible", async () => {
    const { service, actor, superuser, create } = setup();
    const restricted = await service.createHospitalTask(superuser(), { title: "Título de outro setor confidencial", typeId: "hospital-task-type-routine", departmentCode: "LABORATORY", priority: "ROUTINE", idempotencyKey: "other-sector" });
    const task = await create("own-sector");
    const linked = await service.putHospitalTaskDependency(superuser(), task.task.id, { targetType: "HOSPITAL_TASK", targetId: restricted.task.id, blocks: "START", active: true, expectedVersion: 1, idempotencyKey: "super-link" });
    const visible = await service.getHospitalTask(actor(), task.task.id);
    expect(visible.dependencies).toEqual([{ id: linked.dependencies[0].id, restricted: true, blocks: "START", satisfied: false }]);
    expect(JSON.stringify(visible)).not.toContain(restricted.task.title); expect(JSON.stringify(visible)).not.toContain(restricted.task.id);
    expect(JSON.stringify(await service.getHospitalTaskHistory(actor(), task.task.id))).not.toContain(restricted.task.id);
    await expect(service.putHospitalTaskDependency(actor(), task.task.id, { targetType: "HOSPITAL_TASK", targetId: restricted.task.id, blocks: "COMPLETE", active: true, expectedVersion: 2, idempotencyKey: "hidden-link" })).rejects.toMatchObject({ status: 404 });
    await expect(service.commandHospitalTask(actor(), task.task.id, { command: "START", expectedVersion: 2, idempotencyKey: "restricted-block" })).rejects.toMatchObject({ status: 409, message: "Existe uma dependência pendente para este comando." });
  });
  it("version-checks reordering and keeps prior history, refusing context changes with existing links", async () => {
    const { store, service, actor, create } = setup(); const parent = await create("parent-order"); const child = await create("child-order", parent.task.id);
    await service.updateHospitalTask(actor(), child.task.id, { sortOrder: 10, expectedVersion: 1, idempotencyKey: "order" });
    expect(store.getState().auditEvents.at(-1)?.metadata).toMatchObject({ previousSortOrder: 0, sortOrder: 10 });
    await expect(service.updateHospitalTask(actor(), child.task.id, { sortOrder: 20, expectedVersion: 1, idempotencyKey: "stale-order" })).rejects.toMatchObject({ status: 409 });
    await expect(service.updateHospitalTaskContext(actor(), parent.task.id, { patientId: "patient-thor", encounterId: "encounter-thor", expectedVersion: 1, idempotencyKey: "linked-context" })).rejects.toMatchObject({ status: 409 });
  });
});
