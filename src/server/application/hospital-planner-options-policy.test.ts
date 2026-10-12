import { describe, expect, it } from "vitest";
import { createDemoState } from "../store/fixtures";
import { MemoryStore } from "../store/memory-store";
import { systemGroupId } from "../security/access-group-policy";
import { createApplicationService } from "./service";

function setup() {
  const state = createDemoState();
  state.users.find((user) => user.id === "user-manager")!.managedDepartmentCodes = ["LABORATORY"];
  const store = new MemoryStore(state);
  return { store, service: createApplicationService(store), actor: (id = "user-vet") => store.getState().users.find((user) => user.id === id)! };
}

describe("planner options match the entity's binding authority", () => {
  it.each(["plan.create", "plan.update"] as const)("offers the normal clinician sectors accepted by %s without widening task creation", async (action) => {
    const c = setup();
    const options = await c.service.listHospitalPlannerOptions(c.actor(), action);
    expect(options.departments.map((entry) => entry.code)).toEqual(["INPATIENT", "LABORATORY", "RADIOLOGY", "ULTRASOUND", "IT"]);
    const plan = await c.service.createHospitalPlan(c.actor(), { title: "Continuidade do atendimento", objective: "Conectar rotina e exame existentes", patientId: "patient-thor", encounterId: "encounter-thor", departmentCodes: ["INPATIENT", "LABORATORY"], idempotencyKey: "clinical-plan" });
    const request = await c.service.createRequest(c.actor(), { patientId: "patient-thor", encounterId: "encounter-thor", priority: "ROUTINE", items: [{ serviceId: "service-hemogram" }] }, { idempotencyKey: "exam" });
    const linked = await c.service.putHospitalPlanLink(c.actor(), plan.plan.id, { stepId: plan.plan.steps[0].id, targetType: "DIAGNOSTIC_ITEM", targetId: request.items[0].id, active: true, expectedVersion: plan.plan.version, idempotencyKey: "link-existing-exam" });
    expect(linked.activities).toMatchObject([{ targetId: request.items[0].id, departmentCode: "LABORATORY", status: "REQUESTED" }]);
    expect((await c.service.listHospitalTaskOptions(c.actor())).departments.map((entry) => entry.code)).toEqual(["INPATIENT"]);
    await expect(c.service.createHospitalTask(c.actor(), { title: "Rotina fora da lotação", typeId: "hospital-task-type-routine", departmentCode: "LABORATORY", priority: "ROUTINE", idempotencyKey: "outside-task" })).rejects.toMatchObject({ code: "SCOPE_DENIED", status: 404 });
    expect(c.store.getState().items.some((item) => item.departmentCode === "IT")).toBe(false);
    const administrativeLink = await c.service.createHospitalPlan(c.actor(), { title: "Plano com setor administrativo cadastrado", objective: "Vínculo de setor conserva autoridades próprias", patientId: "patient-thor", encounterId: "encounter-thor", departmentCodes: ["INPATIENT", "IT"], idempotencyKey: "plan-administrative-sector" });
    expect(administrativeLink.plan.departmentCodes).toEqual(["INPATIENT", "IT"]);
    expect(administrativeLink.activities).toEqual([]);
    await expect(c.service.createHospitalPlan(c.actor(), { title: "Somente setor fora do escopo", objective: "Negativa", patientId: "patient-thor", encounterId: "encounter-thor", departmentCodes: ["IT"], idempotencyKey: "plan-no-authorized-sector" })).rejects.toMatchObject({ status: 404 });
    await expect(c.service.createHospitalTask(c.actor(), { title: "Não ampliar tarefa em TI", typeId: "hospital-task-type-routine", departmentCode: "IT", priority: "ROUTINE", idempotencyKey: "outside-task-it" })).rejects.toMatchObject({ status: 404 });
  });

  it("keeps delegated management, inactive sectors and unauthorized patients inside their existing boundaries", async () => {
    const c = setup();
    expect((await c.service.listHospitalPlannerOptions(c.actor("user-manager"), "plan.create")).departments.map((entry) => entry.code)).toEqual(["INPATIENT", "LABORATORY"]);
    await expect(c.service.createHospitalPlan(c.actor("user-manager"), { title: "Setor não delegado", objective: "Negativa", patientId: "patient-thor", encounterId: "encounter-thor", departmentCodes: ["INPATIENT", "RADIOLOGY"], idempotencyKey: "not-delegated" })).rejects.toMatchObject({ status: 404 });
    await expect(c.service.createHospitalPlan(c.actor(), { title: "Paciente negado", objective: "Negativa", patientId: "patient-mel-2", encounterId: "encounter-thor", departmentCodes: ["INPATIENT"], idempotencyKey: "not-patient" })).rejects.toMatchObject({ status: 404 });
    await c.store.transaction((state) => ({ state: { ...state, departments: state.departments.map((department) => department.code === "LABORATORY" ? { ...department, active: false } : department) }, result: undefined }));
    expect((await c.service.listHospitalPlannerOptions(c.actor(), "plan.create")).departments.map((entry) => entry.code)).not.toContain("LABORATORY");
    await expect(c.service.listHospitalPlannerOptions(c.actor("user-admin"), "plan.create")).rejects.toMatchObject({ status: 404 });
  });

  it("returns only command metadata to a reduced group and withdraws it immediately after revocation", async () => {
    const c = setup();
    await c.store.transaction((state) => ({ state: { ...state, accessGroups: state.accessGroups.map((group) => group.id === systemGroupId("VETERINARIAN") ? { ...group, permissions: ["plan.create"] } : group) }, result: undefined }));
    const options = await c.service.listHospitalPlannerOptions(c.actor(), "plan.create");
    expect(options.departments.map((entry) => entry.code)).toContain("LABORATORY");
    expect(JSON.stringify(options)).not.toMatch(/passwordHash|patientIds|whatsappPhone|patient-thor/);
    await expect(c.service.listHospitalTasks(c.actor())).rejects.toMatchObject({ status: 404 });
    await c.store.transaction((state) => ({ state: { ...state, accessGroups: state.accessGroups.map((group) => group.id === systemGroupId("VETERINARIAN") ? { ...group, active: false } : group) }, result: undefined }));
    await expect(c.service.listHospitalPlannerOptions(c.actor(), "plan.create")).rejects.toMatchObject({ status: 404 });
  });
});
