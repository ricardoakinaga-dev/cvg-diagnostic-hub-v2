import { describe, expect, it, vi } from "vitest";
import { createDemoState } from "../store/fixtures";
import { MemoryStore } from "../store/memory-store";
import { systemGroupId } from "../security/access-group-policy";
import { createApplicationService } from "./service";
import { eventVisible } from "./realtime-visibility";
import { auditScopeForActor } from "./audit-read";

function setup() {
  const state = createDemoState(); const vet = state.users.find((user) => user.id === "user-vet")!;
  state.users.push({ ...vet, id: "super", role: "SUPERADMIN", accessGroupId: systemGroupId("SUPERADMIN") }, { ...vet, id: "viewer", role: "VIEWER", accessGroupId: systemGroupId("VIEWER") });
  const store = new MemoryStore(state); const service = createApplicationService(store); const actor = (id = "user-vet") => store.getState().users.find((user) => user.id === id)!;
  const create = (key = "plan") => service.createHospitalPlan(actor("super"), { title: "Plano Thor", objective: "Preparar diagnóstico e cuidado", departmentCodes: ["INPATIENT", "LABORATORY"], patientId: "patient-thor", encounterId: "encounter-thor", steps: [{ id: "prepare", title: "Preparação", sortOrder: 0 }, { id: "diagnose", title: "Diagnóstico", sortOrder: 1 }], idempotencyKey: key });
  return { store, service, actor, create };
}
describe("hospital plans retain source authority and current visibility", () => {
  it("derives blocked stages from the live prerequisite and revalidates audit scope after an awaited read", async () => {
    const { store, service, actor, create } = setup(); const plan = await create();
    const createTask = (key: string) => service.createHospitalTask(actor(), { title: key, typeId: "hospital-task-type-routine", departmentCode: "INPATIENT", responsibleUserId: "user-vet", priority: "ROUTINE", idempotencyKey: key });
    const prerequisite = await createTask("preparation"); const dependent = await createTask("dependent");
    await service.putHospitalTaskDependency(actor(), dependent.task.id, { targetType: "HOSPITAL_TASK", targetId: prerequisite.task.id, blocks: "START", active: true, expectedVersion: 1, idempotencyKey: "dep" });
    const linked = await service.putHospitalPlanLink(actor(), plan.plan.id, { stepId: "prepare", targetType: "HOSPITAL_TASK", targetId: dependent.task.id, active: true, expectedVersion: 1, idempotencyKey: "link" }); expect(linked.steps[0]).toMatchObject({ state: "BLOCKED", blockedActivities: 1 });
    await service.commandHospitalTask(actor(), prerequisite.task.id, { command: "START", expectedVersion: 1, idempotencyKey: "start" }); await service.commandHospitalTask(actor(), prerequisite.task.id, { command: "COMPLETE", expectedVersion: 2, idempotencyKey: "complete" }); expect((await service.getHospitalPlan(actor(), plan.plan.id)).steps[0]).toMatchObject({ state: "PENDING", blockedActivities: 0 });
    const read = store.readAuditEvents.bind(store); vi.spyOn(store, "readAuditEvents").mockImplementationOnce(async (query) => { const page = await read(query); await store.transaction((state) => ({ state: { ...state, accessGroups: state.accessGroups.map((group) => group.id === systemGroupId("MANAGER") ? { ...group, permissions: group.permissions.filter((permission) => permission !== "plan.view") } : group) }, result: undefined })); return page; });
    await expect(service.listAuditEvents(actor("user-manager"))).rejects.toMatchObject({ status: 404 });
  });
  it("deduplicates a referenced exam across steps and archives without altering pending workflows", async () => {
    const { store, service, actor, create } = setup(); const plan = await create(); const task = await service.createHospitalTask(actor(), { title: "Preparar Thor", typeId: "hospital-task-type-care", departmentCode: "INPATIENT", patientId: "patient-thor", encounterId: "encounter-thor", priority: "ROUTINE", idempotencyKey: "task" });
    const request = await service.createRequest(actor(), { patientId: "patient-thor", encounterId: "encounter-thor", priority: "ROUTINE", items: [{ serviceId: "service-hemogram" }] }, { idempotencyKey: "exam" });
    let view = await service.putHospitalPlanLink(actor("super"), plan.plan.id, { stepId: "prepare", targetType: "HOSPITAL_TASK", targetId: task.task.id, active: true, expectedVersion: 1, idempotencyKey: "link-task" });
    view = await service.putHospitalPlanLink(actor("super"), plan.plan.id, { stepId: "prepare", targetType: "DIAGNOSTIC_ITEM", targetId: request.items[0].id, active: true, expectedVersion: view.plan.version, idempotencyKey: "link-exam" });
    view = await service.putHospitalPlanLink(actor("super"), plan.plan.id, { stepId: "diagnose", targetType: "DIAGNOSTIC_ITEM", targetId: request.items[0].id, active: true, expectedVersion: view.plan.version, idempotencyKey: "link-exam-again" });
    expect(view.activities).toHaveLength(3); expect(view.summary).toMatchObject({ visibleActivities: 2, pendingActivities: 2, denominator: "AUTHORIZED_UNIQUE_ACTIVITIES" });
    expect((await service.listHospitalTasks(actor(), { planId: plan.plan.id })).items.map((row) => row.task.id)).toEqual([task.task.id]);
    expect((await service.searchPlanner(actor(), "", { planId: plan.plan.id, types: ["DIAGNOSTIC_ITEM"] })).total).toBe(1);
    const originalItems = structuredClone(store.getState().items); const originalTasks = structuredClone(store.getState().hospitalTasks);
    const closed = await service.commandHospitalPlan(actor("super"), plan.plan.id, { command: "CLOSE", expectedVersion: view.plan.version, idempotencyKey: "close" });
    const archived = await service.commandHospitalPlan(actor("super"), plan.plan.id, { command: "ARCHIVE", expectedVersion: closed.plan.version, idempotencyKey: "archive" });
    expect(archived.plan.state).toBe("ARCHIVED"); expect(archived.summary.pendingActivities).toBe(2); expect(store.getState().items).toEqual(originalItems); expect(store.getState().hospitalTasks).toEqual(originalTasks);
    await expect(service.updateHospitalPlan(actor("super"), plan.plan.id, { title: "Changed", expectedVersion: archived.plan.version, idempotencyKey: "edit-archived" })).rejects.toMatchObject({ status: 409 });
  });
  it("redacts another sector and historical target references while retaining scoped plan context", async () => {
    const { store, service, actor, create } = setup(); const plan = await create(); const task = await service.createHospitalTask(actor("super"), { title: "Segredo setor laboratório", typeId: "hospital-task-type-routine", departmentCode: "LABORATORY", priority: "ROUTINE", idempotencyKey: "other" });
    await service.putHospitalPlanLink(actor("super"), plan.plan.id, { stepId: "prepare", targetType: "HOSPITAL_TASK", targetId: task.task.id, active: true, expectedVersion: 1, idempotencyKey: "link" });
    const visible = await service.getHospitalPlan(actor(), plan.plan.id); expect(visible.plan.links).toEqual([]); expect(visible.summary.visibleActivities).toBe(0); expect(JSON.stringify(visible)).not.toContain(task.task.id); expect(visible.steps[0].state).toBe("NO_VISIBLE_ACTIVITIES");
    await store.transaction((state) => ({ state: { ...state, users: state.users.map((user) => user.id === "user-manager" ? { ...user, managedDepartmentCodes: [] } : user) }, result: undefined }));
    const manager = actor("user-manager"); expect(JSON.stringify(await service.listAuditEvents(manager))).not.toContain(task.task.id);
    expect(eventVisible(store.getState(), actor("user-admin"), "HospitalPlan", plan.plan.id, {})).toBe(false); expect(auditScopeForActor(store.getState(), actor("user-admin")).unresolved?.resolvedEntities).toContainEqual({ entityType: "HospitalPlan", entityId: plan.plan.id });
    await service.createRequest(actor(), { patientId: "patient-thor", encounterId: "encounter-thor", priority: "ROUTINE", items: [{ serviceId: "service-hemogram" }] }, { idempotencyKey: "lab-context" });
    await expect(service.getHospitalPlan(actor("user-lab"), plan.plan.id)).resolves.toMatchObject({ plan: { id: plan.plan.id } });
  });
  it("requires old and new scope, correct encounters, versions and active identities on replay", async () => {
    const { store, service, actor, create } = setup(); const plan = await create(); expect((await create()).plan.id).toBe(plan.plan.id);
    await expect(service.createHospitalPlan(actor(), { title: "Wrong", objective: "Wrong", departmentCodes: ["INPATIENT"], patientId: "patient-thor", encounterId: "encounter-mel", idempotencyKey: "wrong" })).rejects.toMatchObject({ status: 404 });
    await expect(service.updateHospitalPlan(actor("super"), plan.plan.id, { title: "Stale", expectedVersion: 9, idempotencyKey: "stale" })).rejects.toMatchObject({ status: 409 });
    await expect(service.commandHospitalPlan(actor("viewer"), plan.plan.id, { command: "CLOSE", expectedVersion: 1, idempotencyKey: "viewer" })).rejects.toMatchObject({ status: 404 });
    await expect(service.createHospitalPlan(actor("user-admin"), { title: "Denied", objective: "Denied", departmentCodes: ["IT"], patientId: "patient-thor", encounterId: "encounter-thor", idempotencyKey: "admin" })).rejects.toMatchObject({ status: 404 });
    await store.transaction((state) => ({ state: { ...state, users: state.users.map((user) => user.id === "super" ? { ...user, active: false } : user) }, result: undefined })); await expect(create()).rejects.toMatchObject({ status: 401 });
  });
  it("validates clinical links and refuses patient context edits after a plan reference", async () => {
    const { service, actor, create } = setup(); const plan = await create(); const task = await service.createHospitalTask(actor(), { title: "Outro paciente", typeId: "hospital-task-type-care", departmentCode: "INPATIENT", patientId: "patient-mel", encounterId: "encounter-mel", priority: "ROUTINE", idempotencyKey: "other-patient" });
    await expect(service.putHospitalPlanLink(actor("super"), plan.plan.id, { stepId: "prepare", targetType: "HOSPITAL_TASK", targetId: task.task.id, active: true, expectedVersion: 1, idempotencyKey: "cross-patient" })).rejects.toMatchObject({ status: 400 });
    const own = await service.createHospitalTask(actor(), { title: "Paciente correto", typeId: "hospital-task-type-care", departmentCode: "INPATIENT", patientId: "patient-thor", encounterId: "encounter-thor", priority: "ROUTINE", idempotencyKey: "own" });
    await service.putHospitalPlanLink(actor("super"), plan.plan.id, { stepId: "prepare", targetType: "HOSPITAL_TASK", targetId: own.task.id, active: true, expectedVersion: 1, idempotencyKey: "bind" });
    await expect(service.updateHospitalTaskContext(actor(), own.task.id, { patientId: "patient-mel", encounterId: "encounter-mel", expectedVersion: 1, idempotencyKey: "move" })).rejects.toMatchObject({ status: 409 });
    expect((await service.searchPlanner(actor(), "Plano Thor", { types: ["HOSPITAL_PLAN"] })).total).toBe(1);
  });
});

it("derives completed and cancelled diagnostic stages from their own states without treating a rejected exam as completed care", async () => {
  const f = setup(); const plan = await f.create(); const request = await f.service.createRequest(f.actor(), { patientId: "patient-thor", encounterId: "encounter-thor", priority: "ROUTINE", items: [{ serviceId: "service-hemogram" }] }, { idempotencyKey: "diagnostic-stage" });
  await f.service.putHospitalPlanLink(f.actor("super"), plan.plan.id, { stepId: "prepare", targetType: "DIAGNOSTIC_ITEM", targetId: request.items[0].id, active: true, expectedVersion: 1, idempotencyKey: "link-stage" });
  for (const [status, phase, stepState, completedActivities] of [["RECEIVED", "PENDING", "PENDING", 0], ["SCHEDULED", "PENDING", "PENDING", 0], ["RECOLLECTION_REQUIRED", "PENDING", "PENDING", 0], ["RESULT_VOIDED", "PENDING", "PENDING", 0], ["IN_PROGRESS", "IN_PROGRESS", "IN_PROGRESS", 0], ["COMPLETED", "COMPLETED", "COMPLETED", 1], ["REJECTED", "CANCELLED", "PENDING", 0], ["CANCELLED", "CANCELLED", "PENDING", 0]] as const) {
    // Read-model fixtures represent existing authoritative FSM states; the plan never writes them.
    await f.store.transaction((state) => ({ state: { ...state, items: state.items.map((item) => ({ ...item, status })) }, result: undefined }));
    const before = structuredClone(f.store.getState().items); const view = await f.service.getHospitalPlan(f.actor("super"), plan.plan.id);
    expect(view.activities[0]).toMatchObject({ phase, status }); expect(view.steps[0].state).toBe(stepState); expect(view.summary.completedActivities).toBe(completedActivities); expect(f.store.getState().items).toEqual(before);
  }
});

it("keeps a stage completed for a completed hospital task and sorts equal-order stages deterministically", async () => {
  const f = setup(); const plan = await f.service.createHospitalPlan(f.actor(), { title: "Plano ordenado", objective: "Continuidade", departmentCodes: ["INPATIENT"], patientId: "patient-thor", encounterId: "encounter-thor", steps: [{ id: "z-stage", title: "Final", sortOrder: 0 }, { id: "a-stage", title: "Inicial", sortOrder: 0 }], idempotencyKey: "plan-order" });
  const task = await f.service.createHospitalTask(f.actor(), { title: "Conferência terminada", typeId: "hospital-task-type-routine", departmentCode: "INPATIENT", responsibleUserId: "user-vet", priority: "ROUTINE", idempotencyKey: "task-stage" });
  await f.service.putHospitalPlanLink(f.actor(), plan.plan.id, { stepId: "z-stage", targetType: "HOSPITAL_TASK", targetId: task.task.id, active: true, expectedVersion: 1, idempotencyKey: "link-task-stage" });
  await f.service.commandHospitalTask(f.actor(), task.task.id, { command: "START", expectedVersion: 1, idempotencyKey: "start-task-stage" }); await f.service.commandHospitalTask(f.actor(), task.task.id, { command: "COMPLETE", expectedVersion: 2, idempotencyKey: "complete-task-stage" });
  const view = await f.service.getHospitalPlan(f.actor(), plan.plan.id); expect(view.steps.map((step) => [step.id, step.state])).toEqual([["a-stage", "NO_VISIBLE_ACTIVITIES"], ["z-stage", "COMPLETED"]]); expect(view.summary).toMatchObject({ visibleActivities: 1, completedActivities: 1, pendingActivities: 0 });
});

it("drops a formerly linked exam when its authorized context changes and rejects adding an exam from another encounter", async () => {
  const f = setup(); const plan = await f.create(); const request = await f.service.createRequest(f.actor(), { patientId: "patient-mel", encounterId: "encounter-mel", priority: "ROUTINE", items: [{ serviceId: "service-hemogram" }] }, { idempotencyKey: "wrong-exam" });
  await expect(f.service.putHospitalPlanLink(f.actor("super"), plan.plan.id, { stepId: "prepare", targetType: "DIAGNOSTIC_ITEM", targetId: request.items[0].id, active: true, expectedVersion: 1, idempotencyKey: "wrong-link" })).rejects.toMatchObject({ status: 400 });
  const current = await f.service.createRequest(f.actor(), { patientId: "patient-thor", encounterId: "encounter-thor", priority: "ROUTINE", items: [{ serviceId: "service-hemogram" }] }, { idempotencyKey: "own-exam" });
  await f.service.putHospitalPlanLink(f.actor("super"), plan.plan.id, { stepId: "prepare", targetType: "DIAGNOSTIC_ITEM", targetId: current.items[0].id, active: true, expectedVersion: 1, idempotencyKey: "own-link" });
  await f.service.createRequest(f.actor(), { patientId: "patient-thor", encounterId: "encounter-thor", priority: "ROUTINE", items: [{ serviceId: "service-crp" }] }, { idempotencyKey: "remaining-authorized-patient-context" });
  await f.store.transaction((state) => ({ state: { ...state, users: state.users.map((user) => user.id === "user-lab" ? { ...user, serviceCodes: ["CRP"] } : user) }, result: undefined }));
  const view = await f.service.getHospitalPlan(f.actor("user-lab"), plan.plan.id); expect(view.activities).toEqual([]); expect(view.plan.links).toEqual([]); expect(JSON.stringify(view)).not.toContain(current.items[0].id);
});
