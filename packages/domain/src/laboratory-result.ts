import type {
  LaboratoryAnalyteDefinition,
  LaboratoryFlag,
  LaboratoryObservation,
  LaboratoryPanelTemplate,
  LaboratoryReferenceRange,
  LaboratoryValueType,
  StructuredLaboratoryResultContent
} from "@cvg/contracts";

export interface LaboratoryValidationIssue {
  code: "INVALID_CONTENT" | "PANEL_MISMATCH" | "UNKNOWN_ANALYTE" | "DUPLICATE_ANALYTE" | "MISSING_REQUIRED_ANALYTE" | "INVALID_VALUE" | "INVALID_UNIT";
  path: string;
  message: string;
}

export type LaboratoryValidationResult =
  | { ok: true; value: StructuredLaboratoryResultContent }
  | { ok: false; issues: LaboratoryValidationIssue[] };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function valueMatchesType(value: unknown, valueType: LaboratoryValueType): boolean {
  if (valueType === "NUMERIC") return typeof value === "number" && Number.isFinite(value);
  return typeof value === "string" && value.trim().length > 0 && Array.from(value).length <= 2000;
}

function flagFor(referenceRange: LaboratoryReferenceRange | undefined, value: number | string): LaboratoryFlag {
  if (!referenceRange || referenceRange.kind !== "NUMERIC" || typeof value !== "number") return "UNINTERPRETED";
  if (referenceRange.low !== undefined && value < referenceRange.low) return "LOW";
  if (referenceRange.high !== undefined && value > referenceRange.high) return "HIGH";
  return "NORMAL";
}

function normalizedRange(definition: LaboratoryAnalyteDefinition): LaboratoryReferenceRange | null {
  return definition.referenceRange ? { ...definition.referenceRange } : null;
}

/**
 * Validates and normalizes a structured laboratory draft against one immutable
 * panel revision. It derives flags from configured ranges and never invents a
 * critical-result threshold.
 */
export function validateStructuredLaboratoryResult(template: LaboratoryPanelTemplate, content: unknown): LaboratoryValidationResult {
  const issues: LaboratoryValidationIssue[] = [];
  if (!isRecord(content) || content.kind !== "LABORATORY_STRUCTURED" || !Array.isArray(content.observations)) {
    return { ok: false, issues: [{ code: "INVALID_CONTENT", path: "content", message: "O conteúdo estruturado do laboratório é inválido." }] };
  }
  if (content.panelCode !== template.code || content.panelVersion !== template.version) {
    issues.push({ code: "PANEL_MISMATCH", path: "content.panelCode", message: "O painel informado não corresponde à revisão ativa do serviço." });
    return { ok: false, issues };
  }

  const definitions = new Map(template.analytes.map((analyte) => [analyte.code, analyte]));
  const seen = new Set<string>();
  const observations: LaboratoryObservation[] = [];
  for (const [index, rawObservation] of content.observations.entries()) {
    const path = `content.observations[${index}]`;
    if (!isRecord(rawObservation) || typeof rawObservation.analyteCode !== "string") {
      issues.push({ code: "INVALID_CONTENT", path, message: "A observação do analito é inválida." });
      continue;
    }
    const analyteCode = rawObservation.analyteCode;
    const definition = definitions.get(analyteCode);
    if (!definition) {
      issues.push({ code: "UNKNOWN_ANALYTE", path: `${path}.analyteCode`, message: "O analito não pertence à revisão do painel." });
      continue;
    }
    if (seen.has(analyteCode)) {
      issues.push({ code: "DUPLICATE_ANALYTE", path: `${path}.analyteCode`, message: "O analito não pode aparecer mais de uma vez." });
      continue;
    }
    seen.add(analyteCode);
    const value = rawObservation.value;
    if (!valueMatchesType(value, definition.valueType)) {
      issues.push({ code: "INVALID_VALUE", path: `${path}.value`, message: `O valor deve seguir o tipo ${definition.valueType}.` });
      continue;
    }
    if (typeof value === "string" && definition.allowedValues && !definition.allowedValues.includes(value)) {
      issues.push({ code: "INVALID_VALUE", path: `${path}.value`, message: "O valor qualitativo não pertence às opções do analito." });
      continue;
    }
    if (rawObservation.unitCode !== definition.unitCode) {
      issues.push({ code: "INVALID_UNIT", path: `${path}.unitCode`, message: "A unidade não corresponde à definição do analito." });
      continue;
    }
    const normalizedValue: string | number = typeof value === "string" ? value.trim() : value as number;
    observations.push({
      analyteCode,
      value: normalizedValue,
      unitCode: definition.unitCode,
      flag: flagFor(definition.referenceRange, normalizedValue),
      referenceRange: normalizedRange(definition)
    });
  }

  for (const definition of template.analytes) {
    if (definition.required && !seen.has(definition.code)) {
      issues.push({ code: "MISSING_REQUIRED_ANALYTE", path: `content.observations.${definition.code}`, message: `O analito obrigatório ${definition.label} não foi informado.` });
    }
  }
  if (issues.length > 0) return { ok: false, issues };
  return {
    ok: true,
    value: {
      kind: "LABORATORY_STRUCTURED",
      panelCode: template.code,
      panelVersion: template.version,
      observations: observations.sort((left, right) => (template.analytes.find((entry) => entry.code === left.analyteCode)?.displayOrder ?? 0) - (template.analytes.find((entry) => entry.code === right.analyteCode)?.displayOrder ?? 0))
    }
  };
}
