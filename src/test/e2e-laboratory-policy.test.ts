import { afterEach, describe, expect, it, vi } from "vitest";
import { createApplicationService } from "../server/application/service";
import { createDemoState, syntheticHemogramTemplate } from "../server/store/fixtures";
import { MemoryStore } from "../server/store/memory-store";
import { assertE2eLaboratoryPreparationAllowed, E2E_LABORATORY_POLICY_REFERENCE, E2E_LABORATORY_REFERENCE_NOTE, prepareE2eLaboratoryPolicy } from "./e2e-laboratory-policy";

const target = "postgresql://synthetic:synthetic@127.0.0.1:5432/cvg_test_e2e_12345";
const environment = { NODE_ENV: "development", CI: "true", ALLOW_SYNTHETIC_SEED: "true", E2E_APPROVED_SYNTHETIC_LABORATORY: "true", E2E_DATABASE_NAME: "cvg_test_e2e_12345" };

function setup(state = createDemoState("synthetic-e2e-lab-test-password")) {
  const store = new MemoryStore(state);
  const service = createApplicationService(store);
  const user = (id: string) => store.getState().users.find((entry) => entry.id === id)!;
  return { store, service, user };
}

function reverseObjectKeyOrder(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(reverseObjectKeyOrder);
  if (value !== null && typeof value === "object") return Object.fromEntries(Object.entries(value).reverse().map(([key, entry]) => [key, reverseObjectKeyOrder(entry)]));
  return value;
}

async function draft(c: ReturnType<typeof setup>, patientId: "patient-thor" | "patient-mel") {
  const vet = c.user("user-vet"), lab = c.user("user-lab");
  const catalog = c.store.getState().services.find((entry) => entry.id === "service-hemogram")!;
  const requested = await c.service.createRequest(vet, { patientId, encounterId: patientId === "patient-thor" ? "encounter-thor" : "encounter-mel", priority: "ROUTINE", items: [{ serviceId: catalog.id }] }, { idempotencyKey: `request-${patientId}` });
  const receipt = await c.service.receiveSample(lab, [requested.items[0].id], { sampleType: "EDTA", expectedVersion: requested.items[0].version, idempotencyKey: `receive-${patientId}` });
  const started = await c.service.startProcessing(lab, requested.items[0].id, { expectedVersion: receipt.items[0].version, idempotencyKey: `start-${patientId}` });
  const result = await c.service.createResultDraft(lab, requested.items[0].id, { expectedVersion: started.item.version, narrative: "Ensaio sintético sem interpretação clínica.", content: { kind: "LABORATORY_STRUCTURED", panelCode: catalog.resultTemplate!.code, panelVersion: catalog.resultTemplate!.version, observations: [{ analyteCode: "HEMOGLOBIN", value: 12.4, unitCode: "g/dL" }, { analyteCode: "LEUKOCYTES", value: 8.1, unitCode: "10^9/L" }, { analyteCode: "PLATELETS", value: 240, unitCode: "10^9/L" }, { analyteCode: "COMMENT", value: "Somente E2E.", unitCode: "TEXT" }] }, idempotencyKey: `draft-${patientId}` });
  return { catalog, requested, result };
}

afterEach(() => vi.unstubAllEnvs());

describe("disposable PostgreSQL browser laboratory preparation", () => {
  it("keeps the normal seed pending and production rejects its structured release without changing state", async () => {
    const c = setup();
    const d = await draft(c, "patient-thor");
    const before = await c.store.readStateSnapshot();
    vi.stubEnv("NODE_ENV", "production");
    await expect(c.service.releaseResult(c.user("user-lab"), d.result.result.id, { expectedVersion: d.result.result.version, idempotencyKey: "unapproved-release" })).rejects.toMatchObject({ code: "REFERENCE_POLICY_MISSING", status: 422 });
    expect(await c.store.readStateSnapshot()).toEqual(before);
    expect(d.catalog.resultTemplate).toEqual(syntheticHemogramTemplate);
  });

  it.each(["patient-thor", "patient-mel"] as const)("publishes through native actors before capturing %s and production accepts that exact synthetic policy", async (patientId) => {
    const c = setup();
    await prepareE2eLaboratoryPolicy(c.store, target, environment);
    const d = await draft(c, patientId);
    vi.stubEnv("NODE_ENV", "production");
    const released = await c.service.releaseResult(c.user("user-lab"), d.result.result.id, { expectedVersion: d.result.result.version, idempotencyKey: `approved-release-${patientId}` });
    expect(released.version.status).toBe("RELEASED");
    expect(released.version.definitionSnapshot?.definition.resultTemplate?.approval).toMatchObject({ approvedBy: "user-vet", policyReference: E2E_LABORATORY_POLICY_REFERENCE, population: { species: ["Canino", "Felino"] } });
    const content = released.version.content as { observations: Array<{ analyteCode: string; flag: string; referenceRange?: unknown }> };
    const numeric = content.observations.filter((entry) => entry.analyteCode !== "COMMENT");
    expect(numeric.map((entry) => entry.analyteCode)).toEqual(["HEMOGLOBIN", "LEUKOCYTES", "PLATELETS"]);
    for (const entry of numeric) expect(entry).toMatchObject({ flag: "NORMAL", referenceRange: { kind: "NUMERIC", low: 0, high: 1_000_000, source: "HUMAN_APPROVED", note: E2E_LABORATORY_REFERENCE_NOTE } });
    const events = c.store.getState().auditEvents.filter((entry) => ["ExamDefinitionDraftPrepared", "ExamDefinitionApproved"].includes(entry.eventType));
    expect(events.map((entry) => [entry.eventType, entry.actorId])).toEqual([["ExamDefinitionDraftPrepared", "user-admin"], ["ExamDefinitionApproved", "user-vet"]]);
  });

  it("accepts unchanged JSONB-style object key order and still publishes and releases through native commands", async () => {
    const template = reverseObjectKeyOrder(syntheticHemogramTemplate) as typeof syntheticHemogramTemplate;
    expect(template).toStrictEqual(syntheticHemogramTemplate);
    expect(JSON.stringify(template)).not.toBe(JSON.stringify(syntheticHemogramTemplate));
    const state = createDemoState("synthetic-e2e-lab-test-password");
    const c = setup({ ...state, services: state.services.map((entry) => entry.id === "service-hemogram" ? { ...entry, resultTemplate: template } : entry) });
    await prepareE2eLaboratoryPolicy(c.store, target, environment);
    const d = await draft(c, "patient-thor");
    vi.stubEnv("NODE_ENV", "production");
    const released = await c.service.releaseResult(c.user("user-lab"), d.result.result.id, { expectedVersion: d.result.result.version, idempotencyKey: "jsonb-order-approved-release" });
    expect(released.version.status).toBe("RELEASED");
    expect(released.version.definitionSnapshot?.definition.resultTemplate?.approval).toMatchObject({ approvedBy: "user-vet", policyReference: E2E_LABORATORY_POLICY_REFERENCE });
    expect(c.store.getState().auditEvents.filter((entry) => ["ExamDefinitionDraftPrepared", "ExamDefinitionApproved"].includes(entry.eventType)).map((entry) => [entry.eventType, entry.actorId])).toEqual([["ExamDefinitionDraftPrepared", "user-admin"], ["ExamDefinitionApproved", "user-vet"]]);
  });

  it.each(["changed value", "changed type", "changed array order"])("refuses a template with %s without any publication or store mutation", async (difference) => {
    const template = structuredClone(syntheticHemogramTemplate);
    if (difference === "changed value") template.analytes[0].label = "Outro analito sintético";
    if (difference === "changed type") Reflect.set(template, "version", String(template.version));
    if (difference === "changed array order") template.analytes.reverse();
    const state = createDemoState("synthetic-e2e-lab-test-password");
    const c = setup({ ...state, services: state.services.map((entry) => entry.id === "service-hemogram" ? { ...entry, resultTemplate: template } : entry) });
    const before = await c.store.readStateSnapshot();
    await expect(prepareE2eLaboratoryPolicy(c.store, target, environment)).rejects.toThrow(/recém-criado/);
    expect(await c.store.readStateSnapshot()).toEqual(before);
  });

  it("enables preparation only for the explicit disposable lane and leaves ordinary seed mode off", () => {
    expect(assertE2eLaboratoryPreparationAllowed(target, environment)).toBe(true);
    expect(assertE2eLaboratoryPreparationAllowed(target, { ...environment, E2E_APPROVED_SYNTHETIC_LABORATORY: undefined })).toBe(false);
    expect(assertE2eLaboratoryPreparationAllowed(target, { ...environment, E2E_APPROVED_SYNTHETIC_LABORATORY: "false" })).toBe(false);
  });

  it("refuses native preparation without the opt-in before reading or writing the store", async () => {
    const c = setup();
    const read = vi.spyOn(c.store, "readState");
    const before = c.store.getState();
    await expect(prepareE2eLaboratoryPolicy(c.store, target, { ...environment, E2E_APPROVED_SYNTHETIC_LABORATORY: undefined })).rejects.toThrow(/opt-in/);
    expect(read).not.toHaveBeenCalled();
    expect(c.store.getState()).toEqual(before);
  });

  it("refuses to change references after a request captured the pending policy", async () => {
    const c = setup();
    await draft(c, "patient-thor");
    const before = await c.store.readStateSnapshot();
    await expect(prepareE2eLaboratoryPolicy(c.store, target, environment)).rejects.toThrow(/recém-criado/);
    expect(await c.store.readStateSnapshot()).toEqual(before);
  });

  it("preserves the catalog and records no approval when the seeded clinician is inactive", async () => {
    const state = createDemoState("synthetic-e2e-lab-test-password");
    const store = new MemoryStore({ ...state, users: state.users.map((entry) => entry.id === "user-vet" ? { ...entry, active: false } : entry) });
    const before = await store.readStateSnapshot();
    await expect(prepareE2eLaboratoryPolicy(store, target, environment)).rejects.toThrow(/recém-criado/);
    expect(await store.readStateSnapshot()).toEqual(before);
  });

  it.each([
    { ...environment, NODE_ENV: "production" }, { ...environment, NODE_ENV: undefined }, { ...environment, CI: "false" }, { ...environment, ALLOW_SYNTHETIC_SEED: undefined }, { ...environment, E2E_APPROVED_SYNTHETIC_LABORATORY: "yes" }, { ...environment, E2E_DATABASE_NAME: "cvg_diagnostics" }, { ...environment, E2E_DATABASE_NAME: "cvg_test_e2e_999" }
  ])("refuses an unauthorized preparation environment before any database operation: %j", (invalid) => {
    expect(() => assertE2eLaboratoryPreparationAllowed(target, invalid)).toThrow(/sintética/);
  });

  it.each(["postgresql://192.0.2.1/cvg_test_e2e_12345", "postgresql://synthetic:synthetic@127.0.0.1/cvg_diagnostics", "postgresql://synthetic:synthetic@127.0.0.1/cvg_test_e2e_12345?options=unsafe", "postgresql://synthetic:synthetic@127.0.0.1/cvg_test_e2e_12345#fragment", "https://127.0.0.1/cvg_test_e2e_12345", "not-a-database-url"])("refuses an unrelated or ambiguous target without exposing its connection string", (invalid) => {
    expect(() => assertE2eLaboratoryPreparationAllowed(invalid, environment)).toThrow("A preparação laboratorial sintética exige um banco E2E descartável em loopback.");
  });
});
