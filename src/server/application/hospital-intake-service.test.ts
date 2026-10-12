import { describe, expect, it } from "vitest";
import { createDemoState } from "../store/fixtures";
import { MemoryStore } from "../store/memory-store";
import { createApplicationService } from "./service";
import { eventVisible } from "./realtime-visibility";

function setup() {
  const store = new MemoryStore(createDemoState()); const service = createApplicationService(store);
  const actor = () => store.getState().users.find((user) => user.id === "user-vet")!;
  const manager = () => store.getState().users.find((user) => user.id === "user-manager")!;
  const intake = (key: string) => service.createHospitalIntake(actor(), { title: "Repor materiais", departmentCode: "INPATIENT", priority: "ROUTINE", source: "MANUAL", idempotencyKey: key });
  return { store, service, actor, manager, intake };
}

describe("operational intake and diagnostic routing", () => {
  it("accepts concurrent repeated intake once, creating exactly one authoritative task", async () => {
    const { store, service, actor, intake } = setup(); const received = await intake("receive");
    const input = { decision: "ACCEPT" as const, expectedVersion: 1, idempotencyKey: "accept" };
    const [first, replay] = await Promise.all([service.triageHospitalIntake(actor(), received.id, input), service.triageHospitalIntake(actor(), received.id, input)]);
    expect(first.destinationTaskId).toBe(replay.destinationTaskId); expect(first.state).toBe("ACCEPTED"); expect(store.getState().hospitalTasks).toHaveLength(1);
    expect(store.getState().hospitalTasks[0]).toMatchObject({ title: "Repor materiais", authorId: actor().id, phase: "PENDING" });
    expect(store.getState().auditEvents.filter((event) => event.eventType === "HospitalIntakeTriaged")).toHaveLength(1);
    await expect(service.triageHospitalIntake(actor(), received.id, { decision: "ACCEPT", expectedVersion: 1, idempotencyKey: "second-accept" })).rejects.toMatchObject({ status: 409 });
  });
  it("links an existing task without duplication and routes only between authorized sectors", async () => {
    const { store, service, actor, manager, intake } = setup(); const received = await intake("route");
    await expect(service.triageHospitalIntake(actor(), received.id, { decision: "ACCEPT", destinationDepartmentCode: "LABORATORY", expectedVersion: 1, idempotencyKey: "denied-route" })).rejects.toMatchObject({ status: 404 });
    const accepted = await service.triageHospitalIntake(manager(), received.id, { decision: "ACCEPT", destinationDepartmentCode: "LABORATORY", expectedVersion: 1, idempotencyKey: "route-allowed" });
    expect(store.getState().hospitalTasks[0].departmentCode).toBe("LABORATORY"); expect(accepted.destinationTaskId).toBe(store.getState().hospitalTasks[0].id);
    const other = await service.createHospitalIntake(manager(), { title: "Demanda correlata", departmentCode: "LABORATORY", source: "MANUAL", priority: "ROUTINE", idempotencyKey: "link-intake" });
    await service.triageHospitalIntake(manager(), other.id, { decision: "ACCEPT", destinationTaskId: accepted.destinationTaskId, expectedVersion: 1, idempotencyKey: "link" });
    expect(store.getState().hospitalTasks).toHaveLength(1);
  });
  it("keeps defer/reject reasons and authorship in versioned history", async () => {
    const { store, service, actor, intake } = setup(); const received = await intake("defer");
    await expect(service.triageHospitalIntake(actor(), received.id, { decision: "REJECT", expectedVersion: 1, idempotencyKey: "empty-reason" })).rejects.toMatchObject({ status: 400 });
    const deferred = await service.triageHospitalIntake(actor(), received.id, { decision: "DEFER", reason: "Aguardar reposição", expectedVersion: 1, idempotencyKey: "deferred" });
    const rejected = await service.triageHospitalIntake(actor(), received.id, { decision: "REJECT", reason: "Coberto por outra demanda", expectedVersion: deferred.version, idempotencyKey: "rejected" });
    expect(rejected).toMatchObject({ state: "REJECTED", submittedBy: actor().id, decisionBy: actor().id, reason: "Coberto por outra demanda" });
    expect(store.getState().auditEvents.filter((event) => event.eventType === "HospitalIntakeTriaged").map((event) => event.metadata.reason)).toEqual(["Aguardar reposição", "Coberto por outra demanda"]);
    expect(store.getState().hospitalTasks).toHaveLength(0);
  });
  it("records duplicate decision without creating a task, refusing self and unauthorized reference", async () => {
    const { store, service, actor, intake } = setup(); const first = await intake("first"); const second = await intake("second");
    await expect(service.triageHospitalIntake(actor(), second.id, { decision: "DUPLICATE", duplicateOfIntakeId: second.id, reason: "Repetida", expectedVersion: 1, idempotencyKey: "self" })).rejects.toMatchObject({ status: 400 });
    const duplicate = await service.triageHospitalIntake(actor(), second.id, { decision: "DUPLICATE", duplicateOfIntakeId: first.id, reason: "Mesmo pedido de reposição", expectedVersion: 1, idempotencyKey: "duplicate" });
    expect(duplicate).toMatchObject({ state: "DUPLICATE", duplicateOfIntakeId: first.id }); expect(store.getState().hospitalTasks).toHaveLength(0);
    await expect(service.triageHospitalIntake(actor(), first.id, { decision: "DUPLICATE", duplicateOfIntakeId: second.id, reason: "Ciclo", expectedVersion: 1, idempotencyKey: "cycle" })).rejects.toMatchObject({ status: 409 });
  });
  it("links a diagnostic demand to its real request without completing, rejecting or hiding the examination", async () => {
    const { store, service, actor } = setup();
    const request = await service.createRequest(actor(), { patientId: "patient-thor", encounterId: "encounter-thor", priority: "URGENT", items: [{ serviceId: "service-hemogram" }] }, { idempotencyKey: "clinical-request" });
    const initial = structuredClone(store.getState().items);
    const received = await service.createHospitalIntake(actor(), { title: "Encaminhar diagnóstico", departmentCode: "INPATIENT", priority: "URGENT", source: "DIAGNOSTIC_REQUEST", sourceRequestId: request.id, idempotencyKey: "diagnostic-intake" });
    const accepted = await service.triageHospitalIntake(actor(), received.id, { decision: "ACCEPT", expectedVersion: 1, idempotencyKey: "diagnostic-accept" });
    expect(accepted.destinationRequestId).toBe(request.id); expect(accepted.destinationTaskId).toBeUndefined(); expect(store.getState().hospitalTasks).toHaveLength(0); expect(store.getState().items).toEqual(initial);
    expect((await service.listRequests(actor())).items[0].id).toBe(request.id);
    await expect(service.createHospitalIntake(actor(), { title: "Segundo encaminhamento", departmentCode: "INPATIENT", priority: "URGENT", source: "DIAGNOSTIC_REQUEST", sourceRequestId: request.id, idempotencyKey: "duplicate-source" })).rejects.toMatchObject({ status: 409 });
  });
  it("hides private intake from reading, counts and SSE, and rejects replay after withdrawal", async () => {
    const { store, service, actor, intake } = setup(); const received = await intake("read-policy");
    const admin = store.getState().users.find((user) => user.id === "user-admin")!;
    await expect(service.listHospitalIntakes(admin)).rejects.toMatchObject({ status: 404 }); expect(eventVisible(store.getState(), admin, "HospitalIntake", received.id, {})).toBe(false);
    await service.triageHospitalIntake(actor(), received.id, { decision: "DEFER", reason: "Espera", expectedVersion: 1, idempotencyKey: "defer-policy" });
    await store.transaction((state) => ({ state: { ...state, accessGroups: state.accessGroups.map((group) => group.id === actor().accessGroupId ? { ...group, permissions: group.permissions.filter((permission) => permission !== "hospital_intake.triage") } : group) }, result: undefined }));
    await expect(service.triageHospitalIntake(actor(), received.id, { decision: "DEFER", reason: "Espera", expectedVersion: 1, idempotencyKey: "defer-policy" })).rejects.toMatchObject({ status: 404 });
  });
});
