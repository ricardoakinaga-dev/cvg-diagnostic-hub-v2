/** @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WorkflowAction } from "./workflow-action";
import * as apiClient from "./api-client";

vi.mock("next/link", () => ({
  default: ({ children, ...props }: { children: React.ReactNode; href: string; [key: string]: unknown }) => <a {...props}>{children}</a>
}));

const item = (overrides: Partial<Parameters<typeof WorkflowAction>[0]["item"]> = {}) => ({
  id: "item-1",
  status: "REQUESTED" as const,
  workflowType: "LABORATORY" as const,
  version: 3,
  ...overrides
});

describe("WorkflowAction", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("validates and receives a sample with normalized accession data", async () => {
    const onComplete = vi.fn();
    const apiFetchMock = vi.spyOn(apiClient, "apiFetch").mockResolvedValue({});
    render(<WorkflowAction item={item()} onComplete={onComplete} />);

    fireEvent.click(screen.getByRole("button", { name: "Receber amostra" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirmar" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Informe o accession da amostra.");
    fireEvent.change(screen.getByLabelText("Accession"), { target: { value: " acc-7 " } });
    fireEvent.change(screen.getByLabelText("Tipo de amostra"), { target: { value: "CITRATO" } });
    fireEvent.click(screen.getByRole("button", { name: "Confirmar" }));

    await waitFor(() => expect(apiFetchMock).toHaveBeenCalledWith("/diagnostic-items/item-1/receive-sample", expect.objectContaining({ method: "POST" })));
    expect(JSON.parse(apiFetchMock.mock.calls[0]?.[1]?.body as string)).toMatchObject({ accessionCode: "ACC-7", sampleType: "CITRATO", expectedVersion: 3 });
    expect(onComplete).toHaveBeenCalledOnce();
  });

  it("keeps the selected workflow action pending until the server confirms it", async () => {
    let resolveRequest!: (value: unknown) => void;
    const request = new Promise((resolve) => { resolveRequest = resolve; });
    const apiFetchMock = vi.spyOn(apiClient, "apiFetch").mockReturnValue(request as never);
    render(<WorkflowAction item={item()} />);

    fireEvent.click(screen.getByRole("button", { name: "Receber amostra" }));
    fireEvent.change(screen.getByLabelText("Accession"), { target: { value: "ACC-7" } });
    fireEvent.click(screen.getByRole("button", { name: "Confirmar" }));

    await waitFor(() => {
      const confirm = screen.getByRole("button", { name: "Confirmando…" });
      expect(confirm).toHaveAttribute("data-action-state", "pending");
      expect(confirm).toHaveAttribute("aria-busy", "true");
      expect(confirm).toBeDisabled();
      expect(apiFetchMock).toHaveBeenCalledOnce();
    });

    resolveRequest({});
    await waitFor(() => expect(screen.queryByRole("button", { name: "Confirmando…" })).not.toBeInTheDocument());
  });

  it("isolates release pending state from the form submit action", async () => {
    let resolveRelease!: (value: unknown) => void;
    const release = new Promise((resolve) => { resolveRelease = resolve; });
    const apiFetchMock = vi.spyOn(apiClient, "apiFetch").mockImplementation((path) => {
      if (path.endsWith("/results")) return Promise.resolve({ result: { id: "result-1", version: 2 } }) as never;
      if (path.endsWith("/release")) return release as never;
      return Promise.resolve({}) as never;
    });
    render(<WorkflowAction item={item({ status: "AWAITING_REPORT", workflowType: "RADIOLOGY" })} />);

    fireEvent.click(screen.getByRole("button", { name: "Registrar resultado" }));
    fireEvent.change(screen.getByLabelText("Resultado"), { target: { value: "Laudo confirmado." } });
    fireEvent.click(screen.getByRole("button", { name: "Confirmar" }));
    expect(await screen.findByRole("status")).toHaveTextContent("Draft salvo");

    fireEvent.click(screen.getByRole("button", { name: "Liberar resultado" }));
    await waitFor(() => {
      const releaseButton = screen.getByRole("button", { name: "Liberando…" });
      expect(releaseButton).toHaveAttribute("data-action-state", "pending");
      expect(releaseButton).toHaveAttribute("aria-busy", "true");
      expect(releaseButton).toBeDisabled();
      const confirm = screen.getByRole("button", { name: "Confirmar" });
      expect(confirm).toHaveAttribute("data-action-state", "idle");
      expect(confirm).not.toHaveAttribute("aria-busy");
      expect(confirm).toBeDisabled();
      expect(apiFetchMock).toHaveBeenCalledWith("/results/result-1/release", expect.objectContaining({ method: "POST" }));
    });

    resolveRelease({});
    await waitFor(() => expect(screen.queryByRole("button", { name: "Liberando…" })).not.toBeInTheDocument());
  });

  it("schedules and reschedules imaging procedures through the versioned action boundary", async () => {
    const apiFetchMock = vi.spyOn(apiClient, "apiFetch").mockResolvedValue({});
    const { unmount } = render(<WorkflowAction item={item({ status: "REQUESTED", workflowType: "ULTRASOUND" })} />);

    fireEvent.click(screen.getByRole("button", { name: "Agendar exame" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirmar" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Informe janela e recurso da agenda.");
    fireEvent.change(screen.getByLabelText("Início"), { target: { value: "2026-08-25T10:00" } });
    fireEvent.change(screen.getByLabelText("Fim"), { target: { value: "2026-08-25T11:00" } });
    fireEvent.change(screen.getByLabelText("Recurso"), { target: { value: "US-01" } });
    fireEvent.click(screen.getByRole("button", { name: "Confirmar" }));
    await waitFor(() => expect(apiFetchMock).toHaveBeenCalledWith("/diagnostic-items/item-1/schedule", expect.objectContaining({ method: "POST" })));

    unmount();
    render(<WorkflowAction item={item({ status: "SCHEDULED", workflowType: "ULTRASOUND", procedureId: "procedure-1", procedureVersion: 4 })} />);
    fireEvent.click(screen.getByRole("button", { name: "Remarcar procedimento" }));
    fireEvent.change(screen.getByLabelText("Início"), { target: { value: "2026-08-25T12:00" } });
    fireEvent.change(screen.getByLabelText("Fim"), { target: { value: "2026-08-25T13:00" } });
    fireEvent.change(screen.getByLabelText("Recurso"), { target: { value: "US-02" } });
    fireEvent.change(screen.getByLabelText("Motivo"), { target: { value: "Conflito de agenda" } });
    fireEvent.click(screen.getByRole("button", { name: "Confirmar" }));
    await waitFor(() => expect(apiFetchMock).toHaveBeenCalledWith("/procedures/procedure-1/reschedule", expect.objectContaining({ method: "POST" })));
  });

  it("supports recollection and a released imaging draft", async () => {
    const apiFetchMock = vi.spyOn(apiClient, "apiFetch").mockImplementation((path) => {
      if (path === "/clinical-reasons") return Promise.resolve([{ id: "reason-1", type: "RECOLLECTION", code: "INSUFFICIENT", label: "Volume insuficiente", active: true, version: 1 }]) as never;
      if (path.endsWith("/results")) return Promise.resolve({ result: { id: "result-1", version: 2 } }) as never;
      if (path.endsWith("/mark-performed")) return Promise.reject(new Error("dependency failure")) as never;
      return Promise.resolve({}) as never;
    });
    render(<WorkflowAction item={item({ status: "IN_PROGRESS", currentSampleId: "sample-1" })} />);

    fireEvent.click(screen.getByRole("button", { name: "Solicitar recoleta" }));
    await screen.findByRole("option", { name: "Volume insuficiente" });
    fireEvent.change(screen.getByLabelText("Motivo"), { target: { value: "INSUFFICIENT" } });
    fireEvent.change(screen.getByLabelText("Observação (opcional)"), { target: { value: "Volume insuficiente" } });
    fireEvent.click(screen.getByRole("button", { name: "Confirmar" }));
    await waitFor(() => expect(apiFetchMock).toHaveBeenCalledWith("/diagnostic-items/item-1/request-recollection", expect.objectContaining({ method: "POST" })));

    cleanup();
    render(<WorkflowAction item={item({ status: "IN_PROGRESS", workflowType: "RADIOLOGY" })} />);
    fireEvent.click(screen.getByRole("button", { name: "Marcar realizado" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirmar" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Não foi possível");
  });

  it("associates each trigger with the form and exposes only the selected action as expanded", () => {
    vi.spyOn(apiClient, "apiFetch").mockResolvedValue([]);
    render(<WorkflowAction item={item({ status: "IN_PROGRESS", currentSampleId: "sample-1" })} />);

    const primary = screen.getByRole("button", { name: "Registrar resultado" });
    const secondary = screen.getByRole("button", { name: "Solicitar recoleta" });
    expect(primary).toHaveAttribute("aria-expanded", "false");
    expect(secondary).toHaveAttribute("aria-expanded", "false");
    expect(primary).toHaveAttribute("aria-controls", secondary.getAttribute("aria-controls"));

    fireEvent.click(secondary);
    const form = document.getElementById(secondary.getAttribute("aria-controls")!);
    expect(form).toHaveClass("workflow-form");
    expect(primary).toHaveAttribute("aria-expanded", "false");
    expect(secondary).toHaveAttribute("aria-expanded", "true");

    fireEvent.click(primary);
    expect(primary).toHaveAttribute("aria-expanded", "true");
    expect(secondary).toHaveAttribute("aria-expanded", "false");
  });

  it("moves focus to the first field when an action form opens", () => {
    render(<WorkflowAction item={item()} />);

    fireEvent.click(screen.getByRole("button", { name: "Receber amostra" }));

    expect(screen.getByLabelText("Accession")).toHaveFocus();
  });

  it("creates and releases a non-laboratory draft, and exposes review links", async () => {
    const apiFetchMock = vi.spyOn(apiClient, "apiFetch").mockImplementation((path) => {
      if (path.endsWith("/results")) return Promise.resolve({ result: { id: "result-1", version: 2 } }) as never;
      return Promise.resolve({}) as never;
    });
    render(<WorkflowAction item={item({ status: "AWAITING_REPORT", workflowType: "RADIOLOGY" })} />);

    fireEvent.click(screen.getByRole("button", { name: "Registrar resultado" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirmar" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Informe o texto do resultado.");
    fireEvent.change(screen.getByLabelText("Resultado"), { target: { value: "Laudo confirmado." } });
    fireEvent.click(screen.getByRole("button", { name: "Confirmar" }));
    expect(await screen.findByRole("status")).toHaveTextContent("Draft salvo");
    fireEvent.click(screen.getByRole("button", { name: "Liberar resultado" }));
    await waitFor(() => expect(apiFetchMock).toHaveBeenCalledWith("/results/result-1/release", expect.objectContaining({ method: "POST" })));

    cleanup();
    render(<WorkflowAction item={item({ status: "RESULT_AVAILABLE", currentResultId: "result-2" })} />);
    expect(screen.getByRole("link", { name: /Abrir resultado/ })).toHaveAttribute("href", "/results/result-2");
  });

  it.each(["CANCEL", "REJECT"] as const)("submits %s using only a selected authorized reason and the item version", async (action) => {
    const onComplete = vi.fn();
    const api = vi.spyOn(apiClient, "apiFetch").mockImplementation((path) => Promise.resolve(path === "/clinical-reasons" ? [{ id: "r1", type: action, code: "POLICY_REASON", label: "Motivo clínico aprovado", active: true, version: 1 }] : {}) as never);
    render(<WorkflowAction item={item()} initialAction={action} onComplete={onComplete} />);
    await screen.findByRole("option", { name: "Motivo clínico aprovado" });
    expect(screen.getByRole("button", { name: "Confirmar" })).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Motivo"), { target: { value: "POLICY_REASON" } });
    fireEvent.click(screen.getByRole("button", { name: "Confirmar" }));
    await waitFor(() => expect(onComplete).toHaveBeenCalledOnce());
    expect(api).toHaveBeenCalledWith(`/diagnostic-items/item-1/${action.toLowerCase()}`, { method: "POST", body: JSON.stringify({ reasonCode: "POLICY_REASON", expectedVersion: 3 }) });
  });

  it("blocks clinical commands when the authorized reason catalog cannot be read", async () => {
    const api = vi.spyOn(apiClient, "apiFetch").mockRejectedValue(new apiClient.ApiClientError(403, { error: { code: "SCOPE_DENIED" } }));
    render(<WorkflowAction item={item()} initialAction="CANCEL" />);
    expect(await screen.findByRole("alert")).toHaveTextContent("Você não tem acesso");
    expect(screen.getByRole("button", { name: "Confirmar" })).toBeDisabled();
    expect(api).toHaveBeenCalledOnce();
    expect(api).toHaveBeenCalledWith("/clinical-reasons");
  });

  it("amends with a reason chosen from the catalog using the existing clinical contract", async () => {
    const api = vi.spyOn(apiClient, "apiFetch").mockImplementation((path) => Promise.resolve(path === "/clinical-reasons" ? [{ id: "r1", type: "AMEND", code: "CORRECTION", label: "Correção clínica", active: true, version: 1 }] : path === "/results/result-1" ? { result: { id: "result-1", version: 12 }, version: { content: { findings: "original" }, critical: true, conclusion: "Conclusão confirmada" } } : {}) as never);
    render(<WorkflowAction item={item({ status: "RESULT_AVAILABLE", currentResultId: "result-1" })} initialAction="AMEND" />);
    await screen.findByRole("option", { name: "Correção clínica" });
    fireEvent.change(screen.getByLabelText("Motivo"), { target: { value: "CORRECTION" } });
    fireEvent.change(screen.getByLabelText("Resultado"), { target: { value: "Narrativa corrigida." } });
    fireEvent.click(screen.getByRole("button", { name: "Confirmar" }));
    await waitFor(() => expect(api).toHaveBeenCalledWith("/results/result-1/amend", { method: "POST", body: JSON.stringify({ narrative: "Narrativa corrigida.", content: { findings: "original" }, conclusion: "Conclusão confirmada", reason: "Correção clínica", critical: true, expectedVersion: 12 }) }));
    expect(api.mock.calls.some(([path]) => path.endsWith("/release"))).toBe(false);
  });

  it.each(["VOIDED", "DRAFT"] as const)("delegates replacement of the %s lineage to the versioned command without reading a voided result", async (status) => {
    const api = vi.spyOn(apiClient, "apiFetch").mockImplementation((path) => path === "/results/result-1" ? Promise.reject(new apiClient.ApiClientError(404, { error: { code: "NOT_FOUND" } })) : status === "DRAFT" ? Promise.reject(new apiClient.ApiClientError(409, { error: { code: "INVALID_STATE_TRANSITION" } })) : Promise.resolve({ result: { id: "result-1", version: 4 } }) as never);
    render(<WorkflowAction item={item({ status: "RESULT_VOIDED", currentResultId: "result-1" })} />);
    expect(screen.getByRole("link", { name: "Abrir resultado atual" })).toHaveAttribute("href", "/results/result-1");
    fireEvent.click(screen.getByRole("button", { name: "Registrar resultado" }));
    fireEvent.change(screen.getByLabelText("Resultado"), { target: { value: "Resultado substituto confirmado." } });
    fireEvent.click(screen.getByRole("button", { name: "Confirmar" }));
    expect(api.mock.calls.some(([path]) => path === "/results/result-1")).toBe(false);
    if (status === "VOIDED") {
      expect(await screen.findByRole("link", { name: "Abrir draft" })).toHaveAttribute("href", "/results/result-1");
      expect(api).toHaveBeenCalledWith("/diagnostic-items/item-1/results", expect.objectContaining({ method: "POST" }));
    } else {
      expect(await screen.findByRole("alert")).toHaveTextContent("Não foi possível concluir a operação");
      expect(api.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
    }
  });
});
