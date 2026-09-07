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
      if (path.endsWith("/results")) return Promise.resolve({ result: { id: "result-1", version: 2 } }) as never;
      if (path.endsWith("/mark-performed")) return Promise.reject(new Error("dependency failure")) as never;
      return Promise.resolve({}) as never;
    });
    render(<WorkflowAction item={item({ status: "IN_PROGRESS", currentSampleId: "sample-1" })} />);

    fireEvent.click(screen.getByRole("button", { name: "Solicitar recoleta" }));
    fireEvent.change(screen.getByLabelText("Código do motivo"), { target: { value: "insufficient" } });
    fireEvent.change(screen.getByLabelText("Observação"), { target: { value: "Volume insuficiente" } });
    fireEvent.click(screen.getByRole("button", { name: "Confirmar" }));
    await waitFor(() => expect(apiFetchMock).toHaveBeenCalledWith("/diagnostic-items/item-1/request-recollection", expect.objectContaining({ method: "POST" })));

    cleanup();
    render(<WorkflowAction item={item({ status: "IN_PROGRESS", workflowType: "RADIOLOGY" })} />);
    fireEvent.click(screen.getByRole("button", { name: "Marcar realizado" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirmar" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Não foi possível");
  });

  it("associates each trigger with the form and exposes only the selected action as expanded", () => {
    vi.spyOn(apiClient, "apiFetch").mockResolvedValue({});
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
});
