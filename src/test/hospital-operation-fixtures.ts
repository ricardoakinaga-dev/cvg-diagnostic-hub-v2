import type { HospitalResourceCreateInput } from "../server/http/hospital-resource-schemas";
import { createDemoState } from "../server/store/fixtures";
import { MemoryStore } from "../server/store/memory-store";
import { systemGroupId } from "../server/security/access-group-policy";
import { createApplicationService } from "../server/application/service";

export const OPERATION_NOW = "2026-10-11T10:00:00.000Z";
export const OPERATION_WINDOW = { startsAt: "2026-10-11T09:00:00.000Z", endsAt: "2026-10-11T17:00:00.000Z" };
export const BOOKING_WINDOW = { startsAt: OPERATION_NOW, endsAt: "2026-10-11T11:00:00.000Z" };
export function hospitalOperationFixture() {
  const state = createDemoState("hospital-operation-fixture-password"); const vet = state.users.find((user) => user.id === "user-vet")!;
  state.users.push({ ...vet, id: "viewer", email: "viewer@example.test", role: "VIEWER", accessGroupId: systemGroupId("VIEWER") });
  const store = new MemoryStore(state); const service = createApplicationService(store); let sequence = 0;
  const user = (userId: string) => store.getState().users.find((entry) => entry.id === userId)!;
  const resource = (input: Partial<HospitalResourceCreateInput> = {}) => service.createHospitalResource(user("user-admin"), { code: `RESOURCE_${++sequence}`, name: "Recurso sintético", kind: "EQUIPMENT", departmentCode: "ULTRASOUND", availabilityWindows: [OPERATION_WINDOW], ...input, idempotencyKey: `resource-${sequence}` });
  const task = (key: string, departmentCode = "ULTRASOUND") => {
    const actorId = departmentCode === "ULTRASOUND" ? "user-us" : "user-vet";
    return service.createHospitalTask(user(actorId), { title: "Atividade sintética", typeId: "hospital-task-type-routine", departmentCode, responsibleUserId: actorId, priority: "ROUTINE", idempotencyKey: key });
  };
  const ultrasound = async (key: string) => {
    const request = await service.createRequest(user("user-vet"), { patientId: "patient-thor", encounterId: "encounter-thor", admissionId: "admission-thor", priority: "ROUTINE", items: [{ serviceId: "service-ultrasound" }], overrideReason: "synthetic parallel tests" }, { idempotencyKey: key });
    return store.getState().items.find((item) => item.id === request.items[0].id)!;
  };
  return { store, service, user, resource, task, ultrasound };
}
