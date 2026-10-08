/** @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ArchivedRequest, type ArchivedRequestData } from "./archived-request";
import * as apiClient from "./api-client";

vi.mock("next/link", () => ({
  default: ({ children, ...props }: { children: React.ReactNode; href: string; [key: string]: unknown }) => <a {...props}>{children}</a>
}));

const archived: ArchivedRequestData = {
  readOnly: true,
  archivedAt: "2026-10-08T12:00:00.000Z",
  request: { id: "request-old", requestCode: "EX-OLD-1", patientId: "patient-thor", aggregateStatus: "COMPLETED", priority: "URGENT", createdAt: "2024-06-01T12:00:00.000Z", updatedAt: "2024-06-02T12:00:00.000Z" },
  patient: { id: "patient-thor", displayName: "Thor", species: "Canino", externalId: "HIS-THOR-001" },
  items: [{
    id: "item-1", service: { code: "HEMOGRAM", name: "Hemograma" }, status: "COMPLETED", priority: "URGENT", completedAt: "2024-06-02T12:00:00.000Z", note: "Jejum",
    results: [{ id: "result-1", lifecycleStatus: "RELEASED", versions: [
      { id: "v1", sequence: 1, status: "SUPERSEDED", content: {}, narrative: "Primeira.", critical: false },
      { id: "v2", sequence: 2, status: "RELEASED", content: { kind: "NARRATIVE", extra: 3 }, narrative: "Versão final.", conclusion: "Sem alterações.", releasedAt: "2024-06-02T12:00:00.000Z", critical: true, amendmentReason: "Correção" }
    ] }]
  }, {
    id: "item-2", service: { code: "XRAY_THORAX", name: "RX de tórax" }, status: "REJECTED", priority: "URGENT", rejectionReason: "Inviável", cancellationReason: "Duplicado", results: []
  }],
  samples: [{ id: "sample-1", accessionCode: "ACC-1", sampleType: "EDTA", status: "RECEIVED" }],
  attachments: [{ id: "attachment-1", safeName: "laudo.pdf", detectedMime: "application/pdf", sizeBytes: 2048 }]
};

describe("ArchivedRequest", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("renders the archived request read-only with status as text", async () => {
    const fetch = vi.spyOn(apiClient, "apiFetch").mockResolvedValue(archived as never);
    render(<ArchivedRequest requestId="request-old" />);

    expect(await screen.findByTestId("archived-request")).toBeInTheDocument();
    expect(fetch).toHaveBeenCalledWith("/archive/requests/request-old");
    expect(screen.getByText("Somente leitura — registro arquivado")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "EX-OLD-1" })).toBeInTheDocument();
    expect(screen.getByText(/Thor · Canino · HIS-THOR-001 · Concluído/)).toBeInTheDocument();
    expect(screen.getByText("Concluído", { selector: ".status-badge" })).toBeInTheDocument();
    expect(screen.getByText("Rejeitado", { selector: ".status-badge" })).toBeInTheDocument();
    expect(screen.getByText("Versão final.")).toBeInTheDocument();
    expect(screen.getByText("Sem alterações.")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: /Versão 2 · Liberada · crítico/ })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: /Versão 1 · Substituída por emenda/ })).toBeInTheDocument();
    expect(screen.getByText(/Emenda: Correção/)).toBeInTheDocument();
    expect(screen.getByText("Sem data de liberação")).toBeInTheDocument();
    expect(screen.getByText("Motivo da rejeição: Inviável")).toBeInTheDocument();
    expect(screen.getByText("Motivo do cancelamento: Duplicado")).toBeInTheDocument();
    expect(screen.getByText("Observação: Jejum")).toBeInTheDocument();
    expect(screen.getByText("Nenhum resultado liberado.")).toBeInTheDocument();
    expect(screen.getByText("ACC-1 · EDTA")).toBeInTheDocument();
    expect(screen.getByText("laudo.pdf · application/pdf")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Voltar ao paciente" })).toHaveAttribute("href", "/patients/patient-thor/diagnostics");
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("renders without optional blocks", async () => {
    vi.spyOn(apiClient, "apiFetch").mockResolvedValue({
      ...archived, patient: null, samples: [], attachments: [],
      request: { ...archived.request, aggregateStatus: "UNKNOWN" },
      items: [{ id: "item-3", service: { code: "CRP", name: "PCR" }, status: "CANCELLED", priority: "ROUTINE", results: [] }]
    } as never);
    render(<ArchivedRequest requestId="request-old" />);
    expect(await screen.findByText(/Paciente não disponível · Estado não informado/)).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Voltar ao paciente" })).toBeNull();
    expect(screen.queryByLabelText("Amostras")).toBeNull();
    expect(screen.queryByLabelText("Anexos")).toBeNull();
  });

  it("shows a safe error with a way back and retries", async () => {
    const fetch = vi.spyOn(apiClient, "apiFetch").mockRejectedValueOnce(new Error("boom")).mockResolvedValueOnce(archived as never);
    render(<ArchivedRequest requestId="request-old" />);
    expect(await screen.findByRole("alert")).toHaveTextContent("Registro arquivado indisponível");
    expect(screen.getByRole("link", { name: "Voltar aos pacientes" })).toHaveAttribute("href", "/patients");
    fireEvent.click(screen.getByRole("button", { name: /tentar novamente/i }));
    await waitFor(() => expect(screen.getByTestId("archived-request")).toBeInTheDocument());
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});
