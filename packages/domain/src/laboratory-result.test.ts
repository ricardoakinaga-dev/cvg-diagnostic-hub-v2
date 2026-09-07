import { describe, expect, it } from "vitest";
import type { LaboratoryPanelTemplate } from "@cvg/contracts";
import { validateStructuredLaboratoryResult } from "./laboratory-result";

const template: LaboratoryPanelTemplate = {
  kind: "LABORATORY_PANEL",
  code: "SYNTHETIC_HEMOGRAM",
  name: "Hemograma sintético de demonstração",
  version: 1,
  schemaVersion: "1.0",
  status: "ACTIVE",
  analytes: [
    { code: "HEMOGLOBIN", label: "Hemoglobina", valueType: "NUMERIC", unitCode: "g/dL", required: true, displayOrder: 1, referenceRange: { kind: "NUMERIC", unitCode: "g/dL", low: 10, high: 20, source: "SYNTHETIC_FIXTURE" } },
    { code: "COMMENT", label: "Observação", valueType: "TEXT", unitCode: "TEXT", required: false, displayOrder: 2, referenceRange: { kind: "PENDING_POLICY", unitCode: "TEXT", source: "PENDING_HUMAN_POLICY", note: "Faixa não aplicável até aprovação clínica." } }
  ]
};

describe("structured laboratory result", () => {
  it("normalizes observations and derives configured flags without a critical threshold", () => {
    const result = validateStructuredLaboratoryResult(template, {
      kind: "LABORATORY_STRUCTURED",
      panelCode: "SYNTHETIC_HEMOGRAM",
      panelVersion: 1,
      observations: [
        { analyteCode: "COMMENT", value: "Amostra adequada", unitCode: "TEXT" },
        { analyteCode: "HEMOGLOBIN", value: 8.5, unitCode: "g/dL" }
      ]
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.observations).toMatchObject([
      { analyteCode: "HEMOGLOBIN", value: 8.5, flag: "LOW", referenceRange: { source: "SYNTHETIC_FIXTURE" } },
      { analyteCode: "COMMENT", flag: "UNINTERPRETED" }
    ]);
  });

  it("rejects missing required, duplicate, unknown and wrong-unit observations", () => {
    const result = validateStructuredLaboratoryResult(template, {
      kind: "LABORATORY_STRUCTURED",
      panelCode: "SYNTHETIC_HEMOGRAM",
      panelVersion: 1,
      observations: [
        { analyteCode: "COMMENT", value: "x", unitCode: "wrong" },
        { analyteCode: "COMMENT", value: "y", unitCode: "TEXT" },
        { analyteCode: "UNKNOWN", value: "z", unitCode: "TEXT" }
      ]
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.map((issue) => issue.code)).toEqual(expect.arrayContaining(["INVALID_UNIT", "DUPLICATE_ANALYTE", "UNKNOWN_ANALYTE", "MISSING_REQUIRED_ANALYTE"]));
  });

  it("rejects a stale panel revision before interpreting values", () => {
    const result = validateStructuredLaboratoryResult(template, { kind: "LABORATORY_STRUCTURED", panelCode: "SYNTHETIC_HEMOGRAM", panelVersion: 2, observations: [] });
    expect(result).toMatchObject({ ok: false, issues: [{ code: "PANEL_MISMATCH" }] });
  });

  it("handles malformed content, normal/high flags and qualitative constraints", () => {
    expect(validateStructuredLaboratoryResult(template, null)).toMatchObject({ ok: false });
    expect(validateStructuredLaboratoryResult(template, null)).toMatchObject({ issues: expect.arrayContaining([expect.objectContaining({ code: "INVALID_CONTENT" })]) });
    const malformedObservation = validateStructuredLaboratoryResult(template, { kind: "LABORATORY_STRUCTURED", panelCode: template.code, panelVersion: 1, observations: [{ value: 1 }] });
    expect(malformedObservation).toMatchObject({ ok: false });
    expect(malformedObservation).toMatchObject({ issues: expect.arrayContaining([expect.objectContaining({ code: "INVALID_CONTENT" })]) });

    const normal = validateStructuredLaboratoryResult(template, { kind: "LABORATORY_STRUCTURED", panelCode: template.code, panelVersion: 1, observations: [{ analyteCode: "HEMOGLOBIN", value: 15, unitCode: "g/dL" }] });
    expect(normal).toMatchObject({ ok: true, value: { observations: [{ flag: "NORMAL" }] } });
    const high = validateStructuredLaboratoryResult(template, { kind: "LABORATORY_STRUCTURED", panelCode: template.code, panelVersion: 1, observations: [{ analyteCode: "HEMOGLOBIN", value: 25, unitCode: "g/dL" }] });
    expect(high).toMatchObject({ ok: true, value: { observations: [{ flag: "HIGH" }] } });

    const qualitativeTemplate = { ...template, analytes: [{ ...template.analytes[0], code: "STATUS", valueType: "TEXT" as const, unitCode: "TEXT", required: true, allowedValues: ["OK"] as string[], referenceRange: undefined }] };
    expect(validateStructuredLaboratoryResult(qualitativeTemplate, { kind: "LABORATORY_STRUCTURED", panelCode: template.code, panelVersion: 1, observations: [{ analyteCode: "STATUS", value: "UNKNOWN", unitCode: "TEXT" }] })).toMatchObject({ ok: false, issues: [{ code: "INVALID_VALUE" }] });
  });
});
