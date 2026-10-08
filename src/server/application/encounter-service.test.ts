import { describe, expect, it } from "vitest";
import type { User } from "../domain/models";
import { createDemoState } from "../store/fixtures";
import { MemoryStore } from "../store/memory-store";
import { createApplicationService } from "./service";

function setup() {
  const store = new MemoryStore(createDemoState("encounter-test-password-2026"));
  const service = createApplicationService(store);
  const actor = (email: string): User => {
    const user = store.getState().users.find((entry) => entry.email === email);
    if (!user) throw new Error(`fixture actor missing: ${email}`);
    return user;
  };
  return { store, service, vet: actor("vet@cvg.local"), lab: actor("lab@cvg.local"), manager: actor("manager@cvg.local"), admin: actor("admin@cvg.local") };
}

describe("open encounter", () => {
  it("opens a new outpatient encounter after the previous one is closed, with audit, outbox and idempotent replay", async () => {
    const { store, service, vet } = setup();
    await service.closeEncounter(vet, "encounter-mel", {}, { idempotencyKey: "close-mel" });
    const result = await service.openEncounter(vet, "patient-mel", { encounterType: "OUTPATIENT", reason: "retorno" }, { idempotencyKey: "open-mel" });
    expect(result.encounter).toMatchObject({ patientId: "patient-mel", type: "OUTPATIENT", status: "OPEN", externalId: expect.stringMatching(/^ATD-/) });
    expect(result.admission).toBeUndefined();
    const events = store.getState().auditEvents;
    expect(events.at(-1)).toMatchObject({ eventType: "EncounterCreated", entityId: result.encounter.id, newState: "OPEN" });
    expect(store.getState().outbox.at(-1)).toMatchObject({ eventType: "EncounterOpened", aggregateId: result.encounter.id });

    const replay = await service.openEncounter(vet, "patient-mel", { encounterType: "OUTPATIENT", reason: "retorno" }, { idempotencyKey: "open-mel" });
    expect(replay).toEqual(result);
    expect(store.getState().encounters.filter((entry) => entry.patientId === "patient-mel")).toHaveLength(2);
    await expect(service.openEncounter(vet, "patient-mel", { encounterType: "OUTPATIENT" }, { idempotencyKey: "open-mel" })).rejects.toMatchObject({ code: "IDEMPOTENCY_KEY_REUSED" });
  });

  it("refuses a second open encounter and keeps the scope boundary", async () => {
    const { service, vet, lab, store } = setup();
    await expect(service.openEncounter(vet, "patient-thor", { encounterType: "OUTPATIENT" }, { idempotencyKey: "open-dup" }))
      .rejects.toMatchObject({ code: "ENCOUNTER_ALREADY_OPEN", status: 409, message: "O paciente já tem um atendimento aberto; encerre-o antes de abrir outro." });
    await expect(service.openEncounter(vet, "patient-mel-2", { encounterType: "OUTPATIENT" }, { idempotencyKey: "open-scope" })).rejects.toMatchObject({ code: "SCOPE_DENIED", status: 404 });
    await expect(service.openEncounter(lab, "patient-thor", { encounterType: "OUTPATIENT" }, { idempotencyKey: "open-lab" })).rejects.toMatchObject({ status: 404 });
    await expect(service.openEncounter(vet, "patient-unknown", { encounterType: "OUTPATIENT" }, { idempotencyKey: "open-unknown" })).rejects.toMatchObject({ status: 404 });
    await expect(service.openEncounter(vet, "patient-mel", { encounterType: "OUTPATIENT" })).rejects.toMatchObject({ status: 400 });
    expect(store.getState().encounters).toHaveLength(2);
  });

  it("refuses inactive patients", async () => {
    const { store, service, vet } = setup();
    await service.closeEncounter(vet, "encounter-mel", {}, { idempotencyKey: "close-mel" });
    const state = store.getState();
    await store.transaction(async () => ({ state: { ...state, patients: state.patients.map((patient) => patient.id === "patient-mel" ? { ...patient, active: false } : patient) }, result: undefined }));
    await expect(service.openEncounter(vet, "patient-mel", { encounterType: "OUTPATIENT" }, { idempotencyKey: "open-inactive" })).rejects.toMatchObject({ code: "INVALID_STATE_TRANSITION", status: 409 });
  });

  it("applies the ward and bed rules and creates the admission in the actor department", async () => {
    const { store, service, vet } = setup();
    await service.closeEncounter(vet, "encounter-mel", {}, { idempotencyKey: "close-mel" });
    await expect(service.openEncounter(vet, "patient-mel", { encounterType: "INPATIENT" }, { idempotencyKey: "open-no-bed" })).rejects.toMatchObject({ code: "VALIDATION_ERROR", message: "Internação exige ala e leito." });
    await expect(service.openEncounter(vet, "patient-mel", { encounterType: "EMERGENCY", ward: "UTI" }, { idempotencyKey: "open-ward" })).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    await expect(service.openEncounter(vet, "patient-mel", { encounterType: "BOGUS" as never }, { idempotencyKey: "open-bad-type" })).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    const result = await service.openEncounter(vet, "patient-mel", { encounterType: "INPATIENT", ward: "UTI 2", bed: "Box 01" }, { idempotencyKey: "open-inpatient" });
    expect(result.admission).toMatchObject({ encounterId: result.encounter.id, departmentCode: "INPATIENT", ward: "UTI 2", bed: "Box 01", version: 1 });
    expect(store.getState().auditEvents.slice(-2).map((event) => event.eventType)).toEqual(["EncounterCreated", "AdmissionCreated"]);
  });

  it("lets a manager with delegated context open an encounter but not for a patient outside the delegation", async () => {
    const { service, vet, manager } = setup();
    await expect(service.openEncounter(manager, "patient-mel", { encounterType: "OUTPATIENT" }, { idempotencyKey: "open-manager-out" })).rejects.toMatchObject({ status: 404 });
    await service.createRequest(vet, { patientId: "patient-mel", encounterId: "encounter-mel", priority: "ROUTINE", items: [{ serviceId: "service-hemogram" }] }, { idempotencyKey: "mgr-request" });
    await service.closeEncounter(manager, "encounter-mel", {}, { idempotencyKey: "mgr-close" });
    const result = await service.openEncounter(manager, "patient-mel", { encounterType: "EMERGENCY" }, { idempotencyKey: "mgr-open" });
    expect(result.encounter.status).toBe("OPEN");
  });
});

describe("close encounter", () => {
  it("closes an inpatient encounter, discharges the admission and leaves pending exams untouched", async () => {
    const { store, service, vet } = setup();
    const request = await service.createRequest(vet, { patientId: "patient-thor", encounterId: "encounter-thor", priority: "URGENT", items: [{ serviceId: "service-hemogram" }, { serviceId: "service-xray" }] }, { idempotencyKey: "close-request" });
    const itemsBefore = store.getState().items.filter((item) => item.requestId === request.id);
    const result = await service.closeEncounter(vet, "encounter-thor", { reason: "alta clínica" }, { idempotencyKey: "close-thor" });
    expect(result.encounter).toMatchObject({ id: "encounter-thor", status: "CLOSED", closedAt: expect.any(String) });
    expect(result.admission).toMatchObject({ id: "admission-thor", dischargedAt: result.encounter.closedAt, contextEffectiveAt: result.encounter.closedAt, version: 2 });
    expect(result.pendingItems).toBe(2);
    expect(store.getState().items.filter((item) => item.requestId === request.id)).toEqual(itemsBefore);
    const audits = store.getState().auditEvents.slice(-2);
    expect(audits.map((event) => event.eventType)).toEqual(["AdmissionDischarged", "EncounterClosed"]);
    expect(audits[1]).toMatchObject({ entityId: "encounter-thor", previousState: "OPEN", newState: "CLOSED", metadata: { pendingItems: 2, reason: "alta clínica" } });
    expect(store.getState().outbox.at(-1)).toMatchObject({ eventType: "EncounterClosed", aggregateId: "encounter-thor" });

    const replay = await service.closeEncounter(vet, "encounter-thor", { reason: "alta clínica" }, { idempotencyKey: "close-thor" });
    expect(replay).toEqual(result);
    await expect(service.closeEncounter(vet, "encounter-thor", {}, { idempotencyKey: "close-thor-again" })).rejects.toMatchObject({ code: "INVALID_STATE_TRANSITION", status: 409 });
    await expect(service.createRequest(vet, { patientId: "patient-thor", encounterId: "encounter-thor", priority: "ROUTINE", items: [{ serviceId: "service-hemogram" }] }, { idempotencyKey: "closed-request" }))
      .rejects.toMatchObject({ code: "ENCOUNTER_CLOSED", status: 409, message: "Atendimento encerrado: abra um novo atendimento para solicitar exames." });
  });

  it("closes a non-inpatient encounter without an admission and does not count finished items", async () => {
    const { store, service, vet } = setup();
    const request = await service.createRequest(vet, { patientId: "patient-mel", encounterId: "encounter-mel", priority: "ROUTINE", items: [{ serviceId: "service-hemogram" }] }, { idempotencyKey: "mel-request" });
    const state = store.getState();
    await store.transaction(async () => ({ state: { ...state, items: state.items.map((item) => item.requestId === request.id ? { ...item, status: "CANCELLED" as const } : item) }, result: undefined }));
    const result = await service.closeEncounter(vet, "encounter-mel", {}, { idempotencyKey: "close-mel" });
    expect(result.admission).toBeUndefined();
    expect(result.pendingItems).toBe(0);
    expect(store.getState().auditEvents.at(-1)?.metadata).not.toHaveProperty("reason");
  });

  it("enforces permission, scope and validation", async () => {
    const { service, vet, lab, admin } = setup();
    await expect(service.closeEncounter(lab, "encounter-thor", {}, { idempotencyKey: "c1" })).rejects.toMatchObject({ status: 404 });
    await expect(service.closeEncounter(admin, "encounter-thor", {}, { idempotencyKey: "c2" })).rejects.toMatchObject({ status: 404 });
    await expect(service.closeEncounter(vet, "encounter-missing", {}, { idempotencyKey: "c3" })).rejects.toMatchObject({ status: 404 });
    await expect(service.closeEncounter(vet, "encounter-thor", {})).rejects.toMatchObject({ status: 400 });
    await expect(service.closeEncounter(vet, "encounter-thor", { reason: "   " }, { idempotencyKey: "c4" })).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
  });
});

describe("encounter read model", () => {
  it("orders encounters with the open one first and exposes the active context only while open", async () => {
    const { service, vet } = setup();
    const before = await service.getPatientDiagnostics(vet, "patient-thor", { limit: 10 });
    expect(before.workspace.currentContext).toMatchObject({ hasOpenEncounter: true, encounterId: "encounter-thor", admissionId: "admission-thor" });

    await service.closeEncounter(vet, "encounter-thor", {}, { idempotencyKey: "read-close" });
    const closed = await service.getPatientDiagnostics(vet, "patient-thor", { limit: 10 });
    expect(closed.workspace.currentContext).toMatchObject({ hasOpenEncounter: false, encounterId: null, admissionId: null, ward: null, bed: null });
    expect(closed.encounters.map((encounter) => encounter.status)).toEqual(["CLOSED"]);

    const opened = await service.openEncounter(vet, "patient-thor", { encounterType: "EMERGENCY" }, { idempotencyKey: "read-open" });
    const after = await service.getPatientDiagnostics(vet, "patient-thor", { limit: 10 });
    expect(after.encounters.map((encounter) => [encounter.id, encounter.status])).toEqual([[opened.encounter.id, "OPEN"], ["encounter-thor", "CLOSED"]]);
    expect(after.workspace.currentContext).toMatchObject({ hasOpenEncounter: true, encounterId: opened.encounter.id });

    const listed = await service.listEncounters(vet, "patient-thor");
    expect(listed.map((encounter) => encounter.status)).toEqual(["OPEN", "CLOSED"]);
    await service.closeEncounter(vet, opened.encounter.id, {}, { idempotencyKey: "read-close-2" });
    const later = await service.listEncounters(vet, "patient-thor");
    expect(later.map((encounter) => encounter.id)).toEqual([opened.encounter.id, "encounter-thor"]);
  });
});
