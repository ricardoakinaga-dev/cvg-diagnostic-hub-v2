import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApplicationService } from "./service";
import { createDemoState } from "../store/fixtures";
import { MemoryStore } from "../store/memory-store";

describe("admission context changes preserve clinical and responsibility invariants", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-04T12:00:00.000Z"));
    vi.stubEnv("ADMISSION_CONTEXT_POLICY_ENABLED", "true");
    vi.stubEnv("ADMISSION_CONTEXT_POLICY_VERSION", "D-01-test");
    vi.stubEnv("ADMISSION_CONTEXT_POLICY_APPROVAL_REF", "synthetic-approval");
    vi.stubEnv("ADMISSION_CONTEXT_POLICY_APPROVED_AT", "2026-09-01T00:00:00.000Z");
    vi.stubEnv("ADMISSION_CONTEXT_ALLOWED_RESPONSIBLE_ROLES", "VETERINARIAN,INPATIENT_TEAM");
  });
  afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); });

  function setup() {
    const state = createDemoState();
    const vet = state.users.find((user) => user.id === "user-vet")!;
    state.admissions.push({ ...state.admissions[0], id: "other-admission", encounterId: "encounter-mel" });
    state.users.push({ ...vet, id: "replacement-vet", email: "replacement@cvg.local" });
    const store = new MemoryStore(state);
    return { store, service: createApplicationService(store), manager: state.users.find((user) => user.id === "user-manager")! };
  }

  const meta = { effectiveAt: "2026-10-04T11:59:00.000Z", reason: "Escala aprovada", expectedVersion: 1, idempotencyKey: "admission-invariant" };

  it("assigns a pre-scoped responsible, then refuses a no-op assignment", async () => {
    const { store, service, manager } = setup();
    const otherAdmission = store.getState().admissions[1];
    const assigned = await service.updateAdmissionContext(manager, "admission-thor", { ...meta, action: "RESPONSIBILITY_CHANGE", responsibleUserId: "replacement-vet" });
    expect(assigned.admission).toMatchObject({ responsibleUserId: "replacement-vet", version: 2, contextEffectiveAt: meta.effectiveAt });
    expect(store.getState().admissions[1]).toEqual(otherAdmission);
    expect(store.getState().auditEvents.at(-1)).toMatchObject({ eventType: "AdmissionResponsibilityChanged", previousState: "INPATIENT/UTI 1/Box 03/UNASSIGNED", newState: "INPATIENT/UTI 1/Box 03/replacement-vet", metadata: { previousResponsibleUserId: null, responsibleUserId: "replacement-vet" } });
    const before = store.getState();
    await expect(service.updateAdmissionContext(manager, "admission-thor", { ...meta, effectiveAt: "2026-10-04T11:59:30.000Z", expectedVersion: 2, idempotencyKey: "same-responsible", action: "RESPONSIBILITY_CHANGE", responsibleUserId: "replacement-vet" })).rejects.toMatchObject({ code: "CONFLICT", status: 409 });
    expect(store.getState()).toEqual(before);
  });

  it("rejects a transfer that changes nothing and an invalid destination code", async () => {
    const { store, service, manager } = setup();
    await store.transaction((state) => ({ state: { ...state, admissions: state.admissions.map((admission) => admission.id === "admission-thor" ? { ...admission, responsibleUserId: "user-vet" } : admission) }, result: undefined }));
    const before = store.getState();
    const transfer = { ...meta, action: "TRANSFER" as const, departmentCode: "INPATIENT", ward: "UTI 1", bed: "Box 03", responsibleUserId: "user-vet" };
    await expect(service.updateAdmissionContext(manager, "admission-thor", transfer)).rejects.toMatchObject({ code: "CONFLICT", status: 409 });
    await expect(service.updateAdmissionContext(manager, "admission-thor", { ...transfer, departmentCode: "bad/department" })).rejects.toMatchObject({ code: "VALIDATION_ERROR", status: 400 });
    expect(store.getState()).toEqual(before);
  });

  it("refuses a no-op bed change but accepts changing only the bed", async () => {
    const { store, service, manager } = setup();
    const before = store.getState();
    const command = { ...meta, action: "BED_CHANGE" as const, ward: "UTI 1", bed: "Box 03" };
    await expect(service.updateAdmissionContext(manager, "admission-thor", command)).rejects.toMatchObject({ code: "CONFLICT", status: 409 });
    expect(store.getState()).toEqual(before);
    await expect(service.updateAdmissionContext(manager, "admission-thor", { ...command, bed: "Box 04" })).resolves.toMatchObject({ admission: { ward: "UTI 1", bed: "Box 04", version: 2 } });
  });

  it("refuses further commands after discharge while allowing the original replay", async () => {
    const { store, service, manager } = setup();
    const command = { ...meta, action: "DISCHARGE" as const };
    const discharged = await service.updateAdmissionContext(manager, "admission-thor", command);
    const before = store.getState();
    await expect(service.updateAdmissionContext(manager, "admission-thor", command)).resolves.toEqual(discharged);
    await expect(service.updateAdmissionContext(manager, "admission-thor", { ...meta, expectedVersion: 2, idempotencyKey: "post-discharge", action: "BED_CHANGE", ward: "UTI 2", bed: "Box 04" })).rejects.toMatchObject({ code: "INVALID_STATE_TRANSITION", status: 409 });
    expect(store.getState()).toEqual(before);
  });
});
