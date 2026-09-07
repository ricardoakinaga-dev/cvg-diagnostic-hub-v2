import { afterEach, describe, expect, it, vi } from "vitest";
import { createApplicationService } from "./service";
import { createDemoState } from "../store/fixtures";
import { MemoryStore } from "../store/memory-store";

function policyReady(): void {
  vi.stubEnv("ADMISSION_CONTEXT_POLICY_ENABLED", "true");
  vi.stubEnv("ADMISSION_CONTEXT_POLICY_VERSION", "D-01-TEST-ONLY-v1");
  vi.stubEnv("ADMISSION_CONTEXT_POLICY_APPROVAL_REF", "synthetic-test-approval");
  vi.stubEnv("ADMISSION_CONTEXT_POLICY_APPROVED_AT", "2026-09-01T00:00:00.000Z");
  vi.stubEnv("ADMISSION_CONTEXT_ALLOWED_RESPONSIBLE_ROLES", "VETERINARIAN,INPATIENT_TEAM");
}

function setup() {
  const state = createDemoState("admission-context-test-password");
  state.users.push({
    ...state.users.find((user) => user.id === "user-vet")!,
    id: "user-vet-radiology",
    email: "vet-radiology@cvg.local",
    displayName: "Veterinária destino",
    departmentCode: "RADIOLOGY",
    patientIds: ["patient-thor"],
    version: 1
  });
  const store = new MemoryStore(state);
  const service = createApplicationService(store);
  const actor = store.getState().users.find((user) => user.id === "user-vet")!;
  const manager = store.getState().users.find((user) => user.id === "user-manager")!;
  return { store, service, actor, manager };
}

function effectiveAt(offsetMs = -1_000): string {
  return new Date(Date.now() + offsetMs).toISOString();
}

describe("approved admission context command boundary", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("fails closed before mutation while D-01 policy is absent", async () => {
    const { store, service, manager } = setup();
    const before = store.getState();

    await expect(service.updateAdmissionContext(manager, "admission-thor", {
      action: "BED_CHANGE",
      effectiveAt: effectiveAt(),
      reason: "Mudança operacional",
      ward: "UTI 2",
      bed: "Box 04",
      expectedVersion: 1,
      idempotencyKey: "policy-missing"
    })).rejects.toMatchObject({ code: "ADMISSION_CONTEXT_POLICY_UNAVAILABLE", status: 503 });

    expect(store.getState().admissions).toEqual(before.admissions);
    expect(store.getState().auditEvents).toEqual(before.auditEvents);
    expect(store.getState().outbox).toEqual(before.outbox);
  });

  it("rejects non-canonical or future vigência at the application boundary", async () => {
    policyReady();
    const { store, service, manager } = setup();
    const command = {
      action: "BED_CHANGE" as const,
      reason: "Mudança operacional",
      ward: "UTI 2",
      bed: "Box 04",
      expectedVersion: 1
    };

    await expect(service.updateAdmissionContext(manager, "admission-thor", {
      ...command,
      effectiveAt: "tomorrow",
      idempotencyKey: "invalid-time"
    })).rejects.toMatchObject({ code: "VALIDATION_ERROR", status: 400 });
    await expect(service.updateAdmissionContext(manager, "admission-thor", {
      ...command,
      effectiveAt: new Date(Date.now() + 60_000).toISOString(),
      idempotencyKey: "future-time"
    })).rejects.toMatchObject({ code: "VALIDATION_ERROR", status: 400 });
    expect(store.getState().admissions.find((entry) => entry.id === "admission-thor")?.version).toBe(1);
  });

  it("changes a bed idempotently, records policy provenance, and preserves every open item", async () => {
    policyReady();
    const { store, service, actor, manager } = setup();
    const request = await service.createRequest(actor, {
      patientId: "patient-thor",
      encounterId: "encounter-thor",
      admissionId: "admission-thor",
      priority: "URGENT",
      items: [{ serviceId: "service-hemogram" }, { serviceId: "service-xray" }]
    }, { idempotencyKey: "context-request" });
    const itemSnapshot = store.getState().items;
    const input = {
      action: "BED_CHANGE" as const,
      effectiveAt: effectiveAt(),
      reason: "Leito preparado pela operação",
      ward: "UTI 2",
      bed: "Box 04",
      expectedVersion: 1,
      idempotencyKey: "bed-change",
      correlationId: "corr-bed-change"
    };

    const changed = await service.updateAdmissionContext(manager, "admission-thor", input);
    const replay = await service.updateAdmissionContext(manager, "admission-thor", input);

    expect(replay).toEqual(changed);
    expect(changed).toMatchObject({
      admission: { ward: "UTI 2", bed: "Box 04", version: 2 },
      affectedRequestCount: 1,
      openItemCount: 2,
      openItemsPreserved: true,
      policyVersion: "D-01-TEST-ONLY-v1"
    });
    expect(store.getState().items).toEqual(itemSnapshot);
    expect(store.getState().requests.find((entry) => entry.id === request.id)?.aggregateStatus).toBe("REQUESTED");
    expect(store.getState().auditEvents.filter((event) => event.eventType === "AdmissionBedChanged")).toEqual([
      expect.objectContaining({
        correlationId: "corr-bed-change",
        metadata: expect.objectContaining({
          policyVersion: "D-01-TEST-ONLY-v1",
          policyApprovalRef: "synthetic-test-approval",
          previousBed: "Box 03",
          bed: "Box 04"
        })
      })
    ]);
    expect(store.getState().outbox.filter((message) => message.eventType === "AdmissionBedChanged")).toHaveLength(1);
  });

  it("transfers atomically only to a delegated department and a pre-scoped eligible responsible", async () => {
    policyReady();
    const { store, service, manager } = setup();

    const transferred = await service.updateAdmissionContext(manager, "admission-thor", {
      action: "TRANSFER",
      effectiveAt: effectiveAt(),
      reason: "Destino confirmou capacidade",
      departmentCode: "radiology",
      ward: "Imagem",
      bed: "Box 01",
      responsibleUserId: "user-vet-radiology",
      expectedVersion: 1,
      idempotencyKey: "transfer-radiology"
    });

    expect(transferred.admission).toMatchObject({
      departmentCode: "RADIOLOGY",
      ward: "Imagem",
      bed: "Box 01",
      responsibleUserId: "user-vet-radiology",
      version: 2
    });
    expect(store.getState().users.find((user) => user.id === "user-vet-radiology")?.patientIds).toEqual(["patient-thor"]);

    await expect(service.updateAdmissionContext(manager, "admission-thor", {
      action: "TRANSFER",
      effectiveAt: effectiveAt(1_000),
      reason: "Destino fora da delegação",
      departmentCode: "UNMANAGED",
      ward: "Ala",
      bed: "01",
      responsibleUserId: "user-vet-radiology",
      expectedVersion: 2,
      idempotencyKey: "transfer-denied"
    })).rejects.toMatchObject({ code: "SCOPE_DENIED", status: 404 });
  });

  it("does not turn responsibility assignment into a patient-scope grant", async () => {
    policyReady();
    const { store, service, manager } = setup();
    const unscoped = store.getState().users.find((user) => user.id === "user-vet-radiology")!;
    await store.transaction((state) => ({
      state: { ...state, users: state.users.map((user) => user.id === unscoped.id ? { ...user, departmentCode: "INPATIENT", patientIds: [] } : user) },
      result: undefined
    }));

    await expect(service.updateAdmissionContext(manager, "admission-thor", {
      action: "RESPONSIBILITY_CHANGE",
      effectiveAt: effectiveAt(),
      reason: "Escala atualizada",
      responsibleUserId: unscoped.id,
      expectedVersion: 1,
      idempotencyKey: "responsible-unscoped"
    })).rejects.toMatchObject({ code: "ADMISSION_RESPONSIBLE_NOT_ELIGIBLE", status: 422 });

    expect(store.getState().admissions.find((entry) => entry.id === "admission-thor")?.responsibleUserId).toBeUndefined();
    expect(store.getState().users.find((user) => user.id === unscoped.id)?.patientIds).toEqual([]);
  });

  it("closes the encounter on discharge without cancelling pending diagnostic work", async () => {
    policyReady();
    const { store, service, actor, manager } = setup();
    const request = await service.createRequest(actor, {
      patientId: "patient-thor",
      encounterId: "encounter-thor",
      admissionId: "admission-thor",
      priority: "ROUTINE",
      items: [{ serviceId: "service-hemogram" }]
    }, { idempotencyKey: "discharge-request" });
    const itemBefore = store.getState().items.find((item) => item.id === request.items[0].id)!;

    const discharged = await service.updateAdmissionContext(manager, "admission-thor", {
      action: "DISCHARGE",
      effectiveAt: effectiveAt(),
      reason: "Alta registrada após decisão externa",
      expectedVersion: 1,
      idempotencyKey: "discharge"
    });

    expect(discharged.admission.dischargedAt).toBeTruthy();
    expect(discharged.encounter).toMatchObject({ status: "CLOSED", closedAt: discharged.admission.dischargedAt });
    expect(store.getState().items.find((item) => item.id === itemBefore.id)).toEqual(itemBefore);
    expect(store.getState().requests.find((entry) => entry.id === request.id)).toMatchObject({ aggregateStatus: "REQUESTED", version: request.version });
  });

  it("allows only one concurrent write for an admission version and denies clinical actors", async () => {
    policyReady();
    const { service, actor, manager } = setup();
    const base = {
      effectiveAt: effectiveAt(),
      reason: "Mudança concorrente",
      expectedVersion: 1
    };

    await expect(service.updateAdmissionContext(actor, "admission-thor", {
      ...base,
      action: "BED_CHANGE",
      ward: "UTI 2",
      bed: "Box 05",
      idempotencyKey: "clinical-actor-denied"
    })).rejects.toMatchObject({ code: "SCOPE_DENIED", status: 404 });

    const outcomes = await Promise.allSettled([
      service.updateAdmissionContext(manager, "admission-thor", { ...base, action: "BED_CHANGE", ward: "UTI 2", bed: "Box 05", idempotencyKey: "race-a" }),
      service.updateAdmissionContext(manager, "admission-thor", { ...base, action: "BED_CHANGE", ward: "UTI 3", bed: "Box 06", idempotencyKey: "race-b" })
    ]);
    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome.status === "rejected")).toEqual([
      expect.objectContaining({ reason: expect.objectContaining({ code: "STALE_VERSION", status: 409 }) })
    ]);
  });
});
