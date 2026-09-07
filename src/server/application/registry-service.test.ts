import { describe, expect, it } from "vitest";
import { createApplicationService } from "./service";
import { createDemoState } from "../store/fixtures";
import { MemoryStore } from "../store/memory-store";

function setup() {
  const store = new MemoryStore(createDemoState("registry-test-password-2026"));
  const service = createApplicationService(store);
  const actor = (email: string) => {
    const user = store.getState().users.find((entry) => entry.email === email);
    if (!user) throw new Error(`fixture actor missing: ${email}`);
    return user;
  };
  return { store, service, vet: actor("vet@cvg.local"), lab: actor("lab@cvg.local") };
}

describe("patient registry commands", () => {
  it("registers a patient with an open encounter and assigns it to the veterinarian", async () => {
    const { store, service, vet } = setup();
    const result = await service.createPatient(vet, {
      displayName: "Amora",
      species: "Canino",
      breed: "Golden Retriever",
      sex: "Fêmea",
      birthDate: "2022-06-14",
      ownerLabel: "M. Ribeiro",
      encounterType: "OUTPATIENT"
    }, { idempotencyKey: "registry-amora-create" });

    expect(result.patient).toMatchObject({ displayName: "Amora", externalId: expect.stringMatching(/^CVG-/), active: true });
    expect(result.encounter).toMatchObject({ patientId: result.patient.id, type: "OUTPATIENT", status: "OPEN" });
    expect(result.admission).toBeUndefined();
    expect(store.getState().users.find((user) => user.id === vet.id)?.patientIds).toContain(result.patient.id);
    expect(store.getState().users.find((user) => user.id === vet.id)?.version).toBe(vet.version + 1);
    expect(store.getState().auditEvents.map((event) => event.eventType)).toEqual(["PatientCreated", "EncounterCreated"]);
    expect(store.getState().outbox.at(-1)).toMatchObject({ eventType: "PatientCreated", aggregateId: result.patient.id });

    const replay = await service.createPatient(store.getState().users.find((user) => user.id === vet.id)!, {
      displayName: "Amora",
      species: "Canino",
      breed: "Golden Retriever",
      sex: "Fêmea",
      birthDate: "2022-06-14",
      ownerLabel: "M. Ribeiro",
      encounterType: "OUTPATIENT"
    }, { idempotencyKey: "registry-amora-create" });
    expect(replay).toEqual(result);
    expect(store.getState().patients.filter((patient) => patient.id === result.patient.id)).toHaveLength(1);
  });

  it("creates the initial admission when the veterinarian registers an inpatient", async () => {
    const { store, service, vet } = setup();
    const result = await service.createPatient(vet, {
      displayName: "Bento",
      species: "Felino",
      breed: "SRD",
      sex: "Macho",
      ownerLabel: "R. Alves",
      encounterType: "INPATIENT",
      ward: "UTI 2",
      bed: "Box 07"
    }, { idempotencyKey: "registry-bento-create" });

    expect(result.admission).toMatchObject({ encounterId: result.encounter.id, ward: "UTI 2", bed: "Box 07", departmentCode: "INPATIENT" });
    expect(store.getState().admissions).toContainEqual(result.admission);
    expect(store.getState().auditEvents.map((event) => event.eventType)).toEqual(["PatientCreated", "EncounterCreated", "AdmissionCreated"]);
  });

  it("protects the registry with permission, validation and duplicate guards", async () => {
    const { store, service, vet, lab } = setup();
    const base = {
      displayName: "Luna",
      species: "Canino",
      breed: "Beagle",
      sex: "Fêmea",
      ownerLabel: "C. Souza",
      externalId: "HIS-LUNA-001",
      encounterType: "OUTPATIENT" as const
    };

    await expect(service.createPatient(lab, base, { idempotencyKey: "registry-lab-denied" })).rejects.toMatchObject({ code: "SCOPE_DENIED" });
    await expect(service.createPatient(vet, { ...base, encounterType: "INPATIENT", ward: "UTI 1" }, { idempotencyKey: "registry-missing-bed" })).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    await service.createPatient(vet, base, { idempotencyKey: "registry-luna-create" });
    const freshVet = store.getState().users.find((user) => user.id === vet.id);
    await expect(service.createPatient(freshVet!, base, { idempotencyKey: "registry-luna-duplicate" })).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(service.createPatient(freshVet!, { ...base, displayName: "Outra Luna" }, { idempotencyKey: "registry-luna-create" })).rejects.toMatchObject({ code: "IDEMPOTENCY_KEY_REUSED" });
  });
});
