/** @vitest-environment jsdom */
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import type { LaboratoryPanelTemplate, LaboratoryReferenceRange, StructuredLaboratoryResultContent } from "@cvg/contracts";
import { DepartmentLabelsProvider, useDepartmentName } from "./department-labels";
import { LaboratoryResultPanel, RecordedLaboratoryResultPanel, referenceRangeLabel } from "./laboratory-result-panels";

afterEach(cleanup);
it("uses only authorized directory names and displays unknown historical sector codes without inventing membership", () => {
  function Label({ code }: { code: string }) { const name = useDepartmentName(); return <span>{name(code)}</span>; }
  const { unmount } = render(<DepartmentLabelsProvider names={{ LABORATORY: "Laboratório registrado" }}><Label code="LABORATORY" /><Label code="OLD_SECTOR" /></DepartmentLabelsProvider>);
  expect(screen.getByText("Laboratório registrado")).toBeInTheDocument(); expect(screen.getByText("OLD_SECTOR")).toBeInTheDocument(); unmount();
  render(<Label code="LABORATORY" />); expect(screen.getByText("Laboratório")).toBeInTheDocument();
});

it("renders human-configured one-sided boundaries including zero while preserving pending and unbounded policies", () => {
  const range: LaboratoryReferenceRange = { kind: "NUMERIC", unitCode: "mg/dL", source: "HUMAN_APPROVED" };
  expect(referenceRangeLabel({ ...range, low: 0, high: 5 })).toBe("0 – 5 mg/dL");
  expect(referenceRangeLabel({ ...range, low: 0 })).toBe("≥ 0 mg/dL"); expect(referenceRangeLabel({ ...range, high: 0 })).toBe("≤ 0 mg/dL"); expect(referenceRangeLabel(range)).toBe("Faixa configurada sem limites");
  for (const pending of [null, undefined, { ...range, kind: "PENDING_POLICY" as const }]) expect(referenceRangeLabel(pending)).toBe("Faixa pendente de aprovação");
});

it("distinguishes absent observations from recorded zero and renders the recorded version independently from the current panel", () => {
  const template: LaboratoryPanelTemplate = { kind: "LABORATORY_PANEL", code: "PANEL", name: "Painel autorizado", version: 2, schemaVersion: "1", status: "ACTIVE", analytes: [{ code: "ZERO", label: "Glicose", unitCode: "mg/dL", valueType: "NUMERIC", required: true, displayOrder: 0, referenceRange: { kind: "NUMERIC", unitCode: "mg/dL", low: 0, high: 5, source: "HUMAN_APPROVED" } }, { code: "MISSING", label: "Analito pendente", unitCode: "mg/dL", valueType: "NUMERIC", required: false, displayOrder: 1 }] };
  const content: StructuredLaboratoryResultContent = { kind: "LABORATORY_STRUCTURED", panelCode: "HISTORICAL", panelVersion: 1, observations: [{ analyteCode: "ZERO", value: 0, unitCode: "mg/dL", flag: "UNINTERPRETED", referenceRange: null }, { analyteCode: "OLD", value: "presente", unitCode: "qual", flag: "NORMAL", referenceRange: null }] };
  const { unmount } = render(<LaboratoryResultPanel template={template} content={content} />);
  expect(within(screen.getByRole("row", { name: /Glicose/ })).getByText("0")).toBeInTheDocument();
  expect(screen.getByRole("row", { name: /Analito pendente/ })).toHaveTextContent("Analito pendente—mg/dLFaixa pendente de aprovaçãoPendente");
  expect(screen.getByText("Não interpretado")).toBeInTheDocument(); expect(screen.queryByText("OLD")).not.toBeInTheDocument(); unmount();
  render(<RecordedLaboratoryResultPanel content={content} />); expect(screen.getByRole("heading", { name: "HISTORICAL · revisão 1" })).toBeInTheDocument(); expect(screen.getByRole("row", { name: /OLD/ })).toHaveTextContent("OLDpresentequalFaixa pendente de aprovaçãoNormal");
});
