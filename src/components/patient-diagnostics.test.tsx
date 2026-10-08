/** @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PatientDiagnostics } from "./patient-diagnostics";
import * as apiClient from "./api-client";

vi.mock("next/link", () => ({
  default: ({ children, ...props }: { children: React.ReactNode; href: string; [key: string]: unknown }) => <a {...props}>{children}</a>
}));

const workspace = {
  patient: { id: "patient-thor", displayName: "Thor", species: "Canino", breed: "Labrador", sex: "Macho", birthDate: "2019-04-12", externalId: "HIS-THOR-001", ownerLabel: "A. Oliveira", active: true },
  encounters: [{ id: "encounter-thor", externalId: "ATD-THOR-001", type: "INPATIENT", status: "OPEN", openedAt: "2026-08-19T12:00:00.000Z" }],
  admissions: [{ id: "admission-thor", encounterId: "encounter-thor", departmentCode: "INPATIENT", ward: "UTI 1", bed: "Box 03", admittedAt: "2026-08-19T12:00:00.000Z" }],
  items: [{
    id: "request-1", requestCode: "EX-260819-0001", priority: "URGENT" as const, aggregateStatus: "IN_PROGRESS", createdAt: "2026-08-19T12:00:00.000Z",
    encounter: { id: "encounter-thor", externalId: "ATD-THOR-001", type: "INPATIENT" },
    items: [{
      id: "item-1", requestId: "request-1", status: "RESULT_AVAILABLE" as const, workflowType: "LABORATORY" as const, currentResultId: "result-1", service: { name: "Hemograma" },
      workspaceContext: {
        operationalContext: { currentOwner: { label: "Laboratório" }, nextAction: { label: "Revisar resultado" }, blockedBy: null, waitingSince: null, expectedBy: "2026-08-20T12:00:00.000Z", escalationLevel: "WATCH" as const },
        sample: { id: "sample-1", requestId: "request-1", accessionCode: "ACC-1", sampleType: "EDTA", status: "RECEIVED" as const },
        result: { id: "result-1", versionId: "version-1", status: "RELEASED" as const, needsReReview: true },
        attachments: [{ id: "attachment-1", safeName: "laudo.pdf", detectedMime: "application/pdf", sizeBytes: 2048, createdAt: "2026-08-19T12:00:00.000Z" }]
      }
    }]
  }],
  events: [
    { id: "event-1", eventType: "ResultReleased", occurredAt: "2026-08-19T12:00:00.000Z", newState: "RESULT_AVAILABLE" },
    { id: "event-2", eventType: "ResultRead", occurredAt: "2026-08-19T12:01:00.000Z", newState: "RELEASED" }
  ],
  nextActions: [{ id: "item-1", requestId: "request-1", requestCode: "EX-260819-0001", itemId: "item-1", label: "Revisar resultado", deepLink: "/requests/request-1", status: "RESULT_AVAILABLE" as const, priority: "URGENT" as const, dueAt: "2026-08-20T12:00:00.000Z", departmentCode: "LABORATORY" }],
  workspace: {
    asOf: "2026-08-19T12:00:00.000Z",
    currentContext: { encounterId: "encounter-thor", admissionId: "admission-thor", departmentCode: "INPATIENT", ward: "UTI 1", bed: "Box 03", responsibleLabel: null },
    summary: { requestCount: 1, itemCount: 1, activeItemCount: 1, availableResultCount: 1, sampleCount: 1, attachmentCount: 1 }
  }
};

describe("PatientDiagnostics workspace", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("offers the clinical archive collapsed and loads it only on demand", async () => {
    const fetch = vi.spyOn(apiClient, "apiFetch").mockResolvedValue(workspace as never);
    render(<PatientDiagnostics patientId="patient-thor" />);

    expect(await screen.findByTestId("patient-archive")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Expandir arquivo" })).toHaveAttribute("aria-expanded", "false");
    expect(fetch.mock.calls.map(([path]) => path)).toEqual(["/patients/patient-thor/diagnostics?limit=50"]);
  });

  it("renders contextual identity, server-owned next action and linked resources", async () => {
    vi.spyOn(apiClient, "apiFetch").mockResolvedValue(workspace as never);
    render(<PatientDiagnostics patientId="patient-thor" />);

    expect(await screen.findByTestId("patient-workspace")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: /Thor em acompanhamento/ })).toBeInTheDocument();
    expect(screen.getByLabelText("Snapshot atual")).toBeInTheDocument();
    expect(screen.getByText("Snapshot atual", { exact: true })).toBeInTheDocument();
    expect(screen.getByText("UTI 1 · Box 03")).toBeInTheDocument();
    expect(screen.getByText("Internação")).toBeInTheDocument();
    expect(screen.getAllByText("Revisar resultado", { exact: true })).toHaveLength(2);
    expect(screen.getByText(/Amostra ACC-1 · Recebida/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Etiqueta da amostra ACC-1" })).toHaveAttribute("href", "/samples/sample-1/label");
    expect(screen.getByRole("link", { name: /Resultado liberado · revisar/ })).toHaveAttribute("href", "/results/result-1");
    expect(screen.getByText("laudo.pdf")).toBeInTheDocument();
    expect(screen.getByText("Resultado liberado", { exact: true })).toBeInTheDocument();
    expect(screen.getByText(/Estado: Resultado disponível/)).toBeInTheDocument();
    expect(screen.getByText("Resultado consultado", { exact: true })).toBeInTheDocument();
    expect(screen.getByText(/Estado: Liberado/)).toBeInTheDocument();
  });

  it("keeps the loading geometry named and structurally stable", () => {
    vi.spyOn(apiClient, "apiFetch").mockReturnValue(new Promise(() => {}) as never);
    render(<PatientDiagnostics patientId="patient-thor" />);

    expect(screen.getByRole("status", { name: "Carregando workspace do paciente" })).toBeInTheDocument();
    expect(document.querySelectorAll(".patient-workspace-skeleton-panel")).toHaveLength(2);
    expect(document.querySelectorAll(".patient-workspace-skeleton-main-panel")).toHaveLength(2);
  });

  it("loads the next authorized request page without losing the first page", async () => {
    const secondRequest = { ...workspace.items[0], id: "request-2", requestCode: "EX-260820-0002", items: [] };
    const firstPage = { ...workspace, total: 2, nextCursor: "cursor-2" };
    const secondPage = { ...workspace, items: [secondRequest], total: 2, nextCursor: undefined };
    const api = vi.spyOn(apiClient, "apiFetch").mockImplementation((path) => Promise.resolve(path.includes("cursor=") ? secondPage : firstPage) as never);
    render(<PatientDiagnostics patientId="patient-thor" />);

    const loadMoreButton = await screen.findByRole("button", { name: "Carregar mais protocolos" });
    expect(screen.getByText("mostrando 1 de 2 · mais recente primeiro")).toBeInTheDocument();
    fireEvent.click(loadMoreButton);

    await waitFor(() => expect(screen.getByText("EX-260820-0002")).toBeInTheDocument());
    expect(screen.getByText("EX-260819-0001")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Carregar mais protocolos" })).not.toBeInTheDocument();
    expect(api).toHaveBeenLastCalledWith("/patients/patient-thor/diagnostics?limit=50&cursor=cursor-2");
  });

  it("keeps the complete server action set visible and discloses a timeline preview", async () => {
    const nextActions = Array.from({ length: 5 }, (_, index) => ({
      ...workspace.nextActions[0],
      id: `item-${index}`,
      itemId: `item-${index}`,
      requestCode: `EX-${index}`
    }));
    const events = Array.from({ length: 21 }, (_, index) => ({
      id: `event-${index}`,
      eventType: "ResultReleased",
      occurredAt: "2026-08-19T12:00:00.000Z"
    }));
    vi.spyOn(apiClient, "apiFetch").mockResolvedValue({ ...workspace, nextActions, events } as never);
    render(<PatientDiagnostics patientId="patient-thor" />);

    expect(await screen.findByRole("heading", { name: "5 ações autorizadas" })).toBeInTheDocument();
    expect(screen.getAllByRole("link", { name: /Revisar resultado/ })).toHaveLength(5);
    expect(screen.getByText("últimos 20 de 21")).toBeInTheDocument();
  });

  it("does not expose unknown department codes in operator-facing copy", async () => {
    vi.spyOn(apiClient, "apiFetch").mockResolvedValue({
      ...workspace,
      workspace: { ...workspace.workspace, currentContext: { ...workspace.workspace.currentContext, departmentCode: "INTERNAL_DEPARTMENT_CODE" } }
    } as never);
    render(<PatientDiagnostics patientId="patient-thor" />);

    expect(await screen.findByText("Setor não informado", { exact: true })).toBeInTheDocument();
    expect(screen.queryByText("INTERNAL_DEPARTMENT_CODE", { exact: true })).not.toBeInTheDocument();
  });

  it("shows a real empty state and a safe retry path", async () => {
    const api = vi.spyOn(apiClient, "apiFetch").mockRejectedValueOnce(new Error("Paciente indisponível"));
    render(<PatientDiagnostics patientId="patient-missing" />);
    expect(await screen.findByRole("alert")).toHaveTextContent("Paciente indisponível");
    api.mockResolvedValue({ ...workspace, patient: { ...workspace.patient, id: "patient-missing", displayName: "Nina" }, items: [], nextActions: [], events: [], workspace: { ...workspace.workspace, summary: { requestCount: 0, itemCount: 0, activeItemCount: 0, availableResultCount: 0, sampleCount: 0, attachmentCount: 0 } } } as never);
    fireEvent.click(screen.getByRole("button", { name: "Tentar novamente" }));
    await waitFor(() => expect(screen.getByRole("heading", { name: /Nina em acompanhamento/ })).toBeInTheDocument());
    expect(screen.getByText("Nenhum exame neste contexto")).toBeInTheDocument();
  });

  it("keeps the last confirmed snapshot visible when refresh becomes stale", async () => {
    const api = vi.spyOn(apiClient, "apiFetch")
      .mockResolvedValueOnce(workspace as never)
      .mockRejectedValueOnce(new Error("dependency failure"))
      .mockResolvedValueOnce(workspace as never);
    render(<PatientDiagnostics patientId="patient-thor" />);

    expect(await screen.findByTestId("patient-workspace")).toHaveAttribute("data-workspace-state", "ready");
    fireEvent.click(screen.getByRole("button", { name: "Atualizar" }));
    await waitFor(() => expect(screen.getByTestId("patient-workspace")).toHaveAttribute("data-workspace-state", "stale"));
    expect(screen.getAllByText(/Snapshot anterior preservado/).length).toBeGreaterThanOrEqual(2);
    expect(screen.getByLabelText("Snapshot anterior preservado")).toBeInTheDocument();
    expect(screen.getByText("laudo.pdf")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Reconciliar visão" }));
    await waitFor(() => expect(screen.getByTestId("patient-workspace")).toHaveAttribute("data-workspace-state", "ready"));
    expect(api).toHaveBeenCalledTimes(3);
  });

  it("keeps the stale warning visible while reconciliation is still pending", async () => {
    let resolveRetry!: (value: typeof workspace) => void;
    const api = vi.spyOn(apiClient, "apiFetch")
      .mockResolvedValueOnce(workspace as never)
      .mockRejectedValueOnce(new Error("dependency failure"))
      .mockImplementationOnce(() => new Promise((resolve) => { resolveRetry = resolve as typeof resolveRetry; }) as never);
    render(<PatientDiagnostics patientId="patient-thor" />);

    await waitFor(() => expect(screen.getByTestId("patient-workspace")).toHaveAttribute("data-workspace-state", "ready"));
    fireEvent.click(screen.getByRole("button", { name: "Atualizar" }));
    await waitFor(() => expect(screen.getByTestId("patient-workspace")).toHaveAttribute("data-workspace-state", "stale"));
    fireEvent.click(screen.getByRole("button", { name: "Reconciliar visão" }));

    expect(screen.getByTestId("patient-workspace")).toHaveAttribute("data-workspace-state", "stale");
    expect(screen.getAllByText(/Snapshot anterior preservado/).length).toBeGreaterThanOrEqual(2);
    expect(screen.getByLabelText("Snapshot anterior preservado")).toBeInTheDocument();

    resolveRetry(workspace);
    await waitFor(() => expect(screen.getByTestId("patient-workspace")).toHaveAttribute("data-workspace-state", "ready"));
    expect(api).toHaveBeenCalledTimes(3);
  });

  it("labels a degraded auxiliary read without hiding the authorized workspace", async () => {
    vi.spyOn(apiClient, "apiFetch").mockResolvedValue({
      ...workspace,
      workspace: {
        ...workspace.workspace,
        dataQuality: {
          status: "DEGRADED" as const,
          asOf: workspace.workspace.asOf,
          note: "Resultados auxiliares indisponíveis."
        }
      }
    } as never);
    render(<PatientDiagnostics patientId="patient-thor" />);

    expect(await screen.findByTestId("patient-workspace")).toHaveAttribute("data-workspace-state", "degraded");
    expect(screen.getByText("Leitura parcial.", { exact: false })).toBeInTheDocument();
    expect(screen.getByText("Resultados auxiliares indisponíveis.", { exact: false })).toBeInTheDocument();
    expect(screen.getByLabelText("Leitura parcial")).toBeInTheDocument();
    expect(screen.queryByText("Snapshot atual", { exact: true })).not.toBeInTheDocument();
    expect(screen.getAllByText("—", { exact: true })).toHaveLength(2);
    expect(screen.getAllByText("Indisponível nesta leitura", { exact: true }).length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText("Resultado indisponível nesta leitura", { exact: true })).toBeInTheDocument();
    expect(screen.getByText("Amostra indisponível nesta leitura", { exact: true })).toBeInTheDocument();
    expect(screen.getByText("Anexos indisponíveis nesta leitura", { exact: true })).toBeInTheDocument();
    expect(screen.getByText("Resultado disponível", { exact: true })).toBeInTheDocument();
    expect(screen.getByText(/Laboratório · Resultado disponível/)).toBeInTheDocument();
    expect(screen.getByText("Hemograma")).toBeInTheDocument();
  });

  it("does not let an obsolete patient response replace the active patient context", async () => {
    let resolveThor!: (value: typeof workspace) => void;
    let resolveMel!: (value: typeof workspace) => void;
    const api = vi.spyOn(apiClient, "apiFetch").mockImplementation((path) => new Promise((resolve) => {
      if (path.includes("patient-thor")) resolveThor = resolve as typeof resolveThor;
      else resolveMel = resolve as typeof resolveMel;
    }) as never);
    const { rerender } = render(<PatientDiagnostics patientId="patient-thor" />);

    await waitFor(() => expect(api).toHaveBeenCalledTimes(1));
    rerender(<PatientDiagnostics patientId="patient-mel" />);
    await waitFor(() => expect(api).toHaveBeenCalledTimes(2));

    resolveThor(workspace);
    await waitFor(() => expect(screen.queryByRole("heading", { name: /Thor em acompanhamento/ })).not.toBeInTheDocument());

    resolveMel({ ...workspace, patient: { ...workspace.patient, id: "patient-mel", displayName: "Mel" } });
    expect(await screen.findByRole("heading", { name: /Mel em acompanhamento/ })).toBeInTheDocument();
  });

  it("shows a safe error when the active patient's load fails after a prior patient was rendered", async () => {
    let resolveThor!: (value: typeof workspace) => void;
    const api = vi.spyOn(apiClient, "apiFetch").mockImplementation((path) => {
      if (path.includes("patient-thor")) return new Promise((resolve) => { resolveThor = resolve as typeof resolveThor; }) as never;
      return Promise.reject(new Error("active patient unavailable")) as never;
    });
    const { rerender } = render(<PatientDiagnostics patientId="patient-thor" />);
    await waitFor(() => expect(api).toHaveBeenCalledTimes(1));
    resolveThor(workspace);
    expect(await screen.findByTestId("patient-workspace")).toBeInTheDocument();

    rerender(<PatientDiagnostics patientId="patient-mel" />);
    await waitFor(() => expect(api).toHaveBeenCalledTimes(2));
    expect(await screen.findByRole("alert")).toHaveTextContent("Paciente indisponível");
    expect(screen.queryByText(/Thor em acompanhamento/)).not.toBeInTheDocument();
  });

  it("labels an emergency encounter accurately when there is no admission", async () => {
    vi.spyOn(apiClient, "apiFetch").mockResolvedValue({
      ...workspace,
      encounters: [{ ...workspace.encounters[0], type: "EMERGENCY" }],
      admissions: [],
      workspace: { ...workspace.workspace, currentContext: { ...workspace.workspace.currentContext, admissionId: null, departmentCode: null, ward: null, bed: null } }
    } as never);
    render(<PatientDiagnostics patientId="patient-thor" />);

    expect(await screen.findByRole("heading", { name: "Atendimento de emergência" })).toBeInTheDocument();
  });

  it("labels an inpatient encounter accurately when there is no admission record", async () => {
    vi.spyOn(apiClient, "apiFetch").mockResolvedValue({
      ...workspace,
      encounters: [{ ...workspace.encounters[0], type: "INPATIENT" }],
      admissions: [],
      workspace: { ...workspace.workspace, currentContext: { ...workspace.workspace.currentContext, admissionId: null, ward: null, bed: null } }
    } as never);
    render(<PatientDiagnostics patientId="patient-thor" />);

    expect(await screen.findByRole("heading", { name: "Internação" })).toBeInTheDocument();
  });
});
