import { describe, expect, it } from "vitest";
import { createApplicationService } from "./service";
import { hasManagerPatientContext } from "./service-common";
import { createDemoState } from "../store/fixtures";
import { MemoryStore } from "../store/memory-store";

function setup() {
  const state = createDemoState();
  state.users.find((user) => user.id === "user-manager")!.managedDepartmentCodes = [];
  const store = new MemoryStore(state);
  const service = createApplicationService(store);
  const manager = () => store.getState().users.find((user) => user.id === "user-manager")!;
  return { store, service, manager };
}

describe("manager clinical context from authoritative admission", () => {
  it("opens an admitted patient and care activity without a fictitious diagnostic request", async () => {
    const { store, service, manager } = setup();
    expect(store.getState().requests).toEqual([]);
    expect((await service.getPatient(manager(), "patient-thor")).id).toBe("patient-thor");
    const vet = store.getState().users.find((user) => user.id === "user-vet")!;
    const task = await service.createHospitalTask(vet, { title: "Cuidado sintético", typeId: "hospital-task-type-care", departmentCode: "INPATIENT", patientId: "patient-thor", encounterId: "encounter-thor", priority: "ROUTINE", idempotencyKey: "admission-task" });
    expect((await service.getHospitalTask(manager(), task.task.id)).task.id).toBe(task.task.id);
    expect(store.getState().requests).toEqual([]);
    expect(store.getState().items).toEqual([]);
  });

  it("requires the actual admission sector, patient encounter and effective admission permission", async () => {
    const { store, service, manager } = setup();
    await store.transaction((state) => ({ state: { ...state, users: state.users.map((user) => user.id === "user-manager" ? { ...user, departmentCode: "IT", managedDepartmentCodes: ["LABORATORY"] } : user) }, result: undefined }));
    await expect(service.getPatient(manager(), "patient-thor")).rejects.toMatchObject({ status: 404 });
    await store.transaction((state) => ({ state: { ...state, users: state.users.map((user) => user.id === "user-manager" ? { ...user, managedDepartmentCodes: ["INPATIENT"] } : user) }, result: undefined }));
    expect((await service.getPatient(manager(), "patient-thor")).id).toBe("patient-thor");
    await store.transaction((state) => ({ state: { ...state, accessGroups: state.accessGroups.map((group) => group.id === manager().accessGroupId ? { ...group, permissions: group.permissions.filter((permission) => permission !== "admission.view") } : group) }, result: undefined }));
    await expect(service.getPatient(manager(), "patient-thor")).rejects.toMatchObject({ status: 404 });
    expect(hasManagerPatientContext({ ...store.getState(), admissions: [{ ...store.getState().admissions[0], encounterId: "missing-encounter" }] }, manager(), "patient-thor")).toBe(false);
  });

  it("does not infer outpatient ownership or patient grants from planner configuration", async () => {
    const { store, service, manager } = setup();
    await expect(service.getPatient(manager(), "patient-mel")).rejects.toMatchObject({ status: 404 });
    expect(hasManagerPatientContext({ ...store.getState(), admissions: [] }, manager(), "patient-thor")).toBe(false);
    expect(manager().patientIds).toEqual([]);
  });

  it("withdraws the admission-derived context after transfer outside delegated departments", async () => {
    const { store, service, manager } = setup();
    expect((await service.getPatient(manager(), "patient-thor")).id).toBe("patient-thor");
    await store.transaction((state) => ({ state: { ...state, admissions: state.admissions.map((admission) => ({ ...admission, departmentCode: "RADIOLOGY", version: admission.version + 1 })) }, result: undefined }));
    await expect(service.getPatient(manager(), "patient-thor")).rejects.toMatchObject({ status: 404 });
    await store.transaction((state) => ({ state: { ...state, users: state.users.map((user) => user.id === "user-manager" ? { ...user, managedDepartmentCodes: ["RADIOLOGY"] } : user) }, result: undefined }));
    expect((await service.getPatient(manager(), "patient-thor")).id).toBe("patient-thor");
  });
});
