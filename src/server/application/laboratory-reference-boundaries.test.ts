import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExamDefinitionSnapshot, LaboratoryPanelTemplate, LaboratoryReferencePopulation, LaboratoryReferenceRange } from "@cvg/contracts";
import { createDemoState } from "../store/fixtures";
import { assertApprovedLaboratoryReferences } from "./laboratory-reference-policy";

function fixture(population: LaboratoryReferencePopulation = { species: ["Canino"] }) {
  const service = createDemoState("synthetic-reference-boundaries-password").services.find(entry => entry.id === "service-hemogram")!;
  const template: LaboratoryPanelTemplate = { kind: "LABORATORY_PANEL", code: "SYNTHETIC_BOUNDARY", name: "Painel sintético, não é uma aprovação hospitalar", version: 1, schemaVersion: "1", status: "ACTIVE", analytes: [{ code: "VALUE", label: "Valor de teste", valueType: "NUMERIC", unitCode: "test/unit", required: true, displayOrder: 1 }, { code: "TEXT", label: "Texto de teste", valueType: "QUALITATIVE", unitCode: "text", required: false, displayOrder: 2 }], approval: { approvedBy: "synthetic-approver", approvedAt: "2026-10-01T12:00:00Z", policyReference: "SYNTHETIC_TEST_ONLY", population } };
  const snapshot: ExamDefinitionSnapshot = { schemaVersion: 1, capturedAt: "2026-10-11T02:00:00Z", provenance: "REQUEST_CAPTURE", definitionId: "synthetic-definition", serviceId: service.id, serviceVersion: service.version, definition: { ...service, resultTemplate: template }, patientContext: { species: "CANINO", sex: "Macho", birthDate: "2026-10-01" } };
  const range: LaboratoryReferenceRange = { kind: "NUMERIC", unitCode: "test/unit", low: 0, high: 10, source: "HUMAN_APPROVED" };
  const content = { kind: "LABORATORY_STRUCTURED", panelCode: template.code, panelVersion: 1, observations: [{ analyteCode: "VALUE", value: 5, unitCode: "test/unit", flag: "NORMAL", referenceRange: range }] };
  return { template, snapshot, content };
}

describe("declared laboratory reference applicability", () => {
  beforeEach(() => vi.stubEnv("APP_TIMEZONE", "America/Sao_Paulo"));
  afterEach(() => vi.unstubAllEnvs());

  it("uses the captured hospital day and accepts both inclusive age boundaries", () => {
    const f = fixture({ species: [" Canino "], sex: ["MACHO"], minAgeDays: 9, maxAgeDays: 9 });
    expect(() => assertApprovedLaboratoryReferences(f.template, f.snapshot, f.content, true)).not.toThrow();
    vi.stubEnv("APP_TIMEZONE", undefined); vi.stubEnv("NEXT_PUBLIC_HOSPITAL_TIMEZONE", "America/Sao_Paulo");
    expect(() => assertApprovedLaboratoryReferences(f.template, f.snapshot, f.content, true)).not.toThrow();
    vi.stubEnv("APP_TIMEZONE", "UTC");
    expect(() => assertApprovedLaboratoryReferences(f.template, f.snapshot, f.content, true)).toThrow(expect.objectContaining({ code: "REFERENCE_POLICY_MISSING" }));
  });

  it.each([undefined, "Fêmea"])("requires the approved sex when a population restricts it: %s", (sex) => {
    const f = fixture({ species: ["Canino"], sex: ["Macho"] });
    expect(() => assertApprovedLaboratoryReferences(f.template, { ...f.snapshot, patientContext: { ...f.snapshot.patientContext, sex } }, f.content, true)).toThrow(expect.objectContaining({ code: "REFERENCE_POLICY_MISSING" }));
  });

  it.each([undefined, "01/10/2026", "2026-02-30", "2026-99-99", "2026-10-11"])("refuses missing, invalid or future birth dates: %s", (birthDate) => {
    const f = fixture({ species: ["Canino"], minAgeDays: 0 });
    expect(() => assertApprovedLaboratoryReferences(f.template, { ...f.snapshot, patientContext: { ...f.snapshot.patientContext, birthDate } }, f.content, true)).toThrow(expect.objectContaining({ code: "REFERENCE_POLICY_MISSING" }));
  });

  it.each([{ species: ["Canino"], minAgeDays: 10 }, { species: ["Canino"], maxAgeDays: 8 }])("refuses a patient outside the declared age population %j", (population) => {
    const f = fixture(population);
    expect(() => assertApprovedLaboratoryReferences(f.template, f.snapshot, f.content, true)).toThrow(expect.objectContaining({ status: 422 }));
  });

  it.each([
    undefined,
    { kind: "PENDING_POLICY", unitCode: "test/unit", source: "PENDING_HUMAN_POLICY" },
    { kind: "NUMERIC", unitCode: "test/unit", low: 0, high: 10, source: "SYNTHETIC_FIXTURE" },
    { kind: "NUMERIC", unitCode: "wrong/unit", low: 0, high: 10, source: "HUMAN_APPROVED" },
    { kind: "NUMERIC", unitCode: "test/unit", source: "HUMAN_APPROVED" },
    { kind: "NUMERIC", unitCode: "test/unit", low: NaN, source: "HUMAN_APPROVED" },
    { kind: "NUMERIC", unitCode: "test/unit", high: Infinity, source: "HUMAN_APPROVED" },
    { kind: "NUMERIC", unitCode: "test/unit", low: 10, high: 0, source: "HUMAN_APPROVED" }
  ])("refuses a numeric observation without a usable human-approved range %j", (referenceRange) => {
    const f = fixture(); const content = { ...f.content, observations: [{ ...f.content.observations[0], referenceRange }] };
    expect(() => assertApprovedLaboratoryReferences(f.template, f.snapshot, content, true)).toThrow(expect.objectContaining({ code: "REFERENCE_POLICY_MISSING" }));
  });

  it("accepts approved one-sided limits and does not impose numeric limits on qualitative values", () => {
    const f = fixture();
    for (const bounds of [{ low: 0 }, { high: 0 }]) {
      const content = { ...f.content, observations: [{ ...f.content.observations[0], referenceRange: { kind: "NUMERIC", unitCode: "test/unit", source: "HUMAN_APPROVED", ...bounds } }, { analyteCode: "TEXT", value: "synthetic", unitCode: "text", referenceRange: null }] };
      expect(() => assertApprovedLaboratoryReferences(f.template, f.snapshot, content, true)).not.toThrow();
    }
  });

  it("requires an actual approval record in production and keeps nonclinical bypasses bounded", () => {
    const f = fixture();
    for (const approval of [undefined, { ...f.template.approval!, approvedBy: "" }, { ...f.template.approval!, approvedAt: "invalid" }, { ...f.template.approval!, policyReference: " " }, { ...f.template.approval!, population: { species: [] } }]) {
      const pending = { ...f.template, approval };
      expect(() => assertApprovedLaboratoryReferences(pending, f.snapshot, f.content, true)).toThrow(expect.objectContaining({ status: 422 }));
      expect(() => assertApprovedLaboratoryReferences(pending, f.snapshot, f.content, false)).not.toThrow();
    }
    expect(() => assertApprovedLaboratoryReferences(undefined, f.snapshot, f.content, true)).not.toThrow();
    expect(() => assertApprovedLaboratoryReferences(f.template, f.snapshot, { kind: "NARRATIVE" }, true)).not.toThrow();
  });
});
