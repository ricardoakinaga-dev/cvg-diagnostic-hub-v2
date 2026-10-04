/** @vitest-environment jsdom */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { QueueItem, ResultView } from "@cvg/contracts";
import { QueueBoard } from "./queue-board";
import * as apiClient from "./api-client";

export const queueItem = (overrides: Partial<QueueItem> = {}): QueueItem => ({
  id: "item-1", requestId: "request-1", status: "RECEIVED", workflowType: "LABORATORY", priority: "ROUTINE", version: 7, currentSampleId: "sample-1", dueAt: "2026-10-03T12:00:00Z", createdAt: "2026-10-03T10:00:00Z", requestCode: "EX-1", nextAction: "Iniciar processamento", overdue: false,
  patient: { id: "patient-1", displayName: "Thor", species: "Canino", externalId: "P-1" }, service: { id: "service-1", code: "HEMOGRAM", name: "Hemograma" },
  operationalContext: { currentOwner: { code: "LABORATORY", label: "Laboratório" }, nextAction: { code: "START_PROCESSING", label: "Iniciar processamento" }, blockedBy: null, waitingSince: null, expectedBy: "2026-10-03T12:00:00Z", escalationLevel: "NONE" }, ...overrides
});

const resultView = (overrides: Partial<ResultView["version"]> = {}): ResultView => ({
  result: { id: "result-1", version: 11, lifecycleStatus: "DRAFT", needsReReview: false },
  version: { id: "version-1", version: 2, sequence: 1, status: "DRAFT", narrative: "Laudo preenchido.", authorId: "tech-1", createdAt: "2026-10-03T10:00:00Z", critical: false, needsReReview: false, content: {}, ...overrides },
  item: { id: "item-1", version: 7, status: "AWAITING_REPORT", serviceId: "service-1" }, request: { id: "request-1", requestCode: "EX-1" },
  patient: { displayName: "Thor", species: "Canino", sex: "M", externalId: "P-1" }, service: { name: "Radiografia", workflowType: "RADIOLOGY", resultSchema: "NARRATIVE" }
});

function renderBoard(item = queueItem(), role: Parameters<typeof QueueBoard>[0]["role"] = "LAB_TECH") {
  const onComplete = vi.fn();
  const view = render(<QueueBoard items={[item]} role={role} departments={["LABORATORY"]} refreshing={false} onComplete={onComplete} />);
  return { ...view, onComplete };
}

function dragTo(column: string) {
  fireEvent.dragStart(screen.getByRole("listitem"), { dataTransfer: { setData: vi.fn() } });
  fireEvent.drop(screen.getByRole("region", { name: column }));
}

describe("QueueBoard", () => {
  afterEach(() => { cleanup(); vi.restoreAllMocks(); });

  it("moves by drag through the existing API with the item version and reloads only after confirmation", async () => {
    const api = vi.spyOn(apiClient, "apiFetch").mockResolvedValue({});
    const { onComplete } = renderBoard();
    dragTo("Em execução");
    await waitFor(() => expect(onComplete).toHaveBeenCalledOnce());
    expect(api).toHaveBeenCalledWith("/diagnostic-items/item-1/start-processing", { method: "POST", body: JSON.stringify({ expectedVersion: 7 }) });
  });

  it("supports the explicit keyboard/mobile state selector", async () => {
    const api = vi.spyOn(apiClient, "apiFetch").mockResolvedValue({});
    renderBoard();
    fireEvent.change(screen.getByLabelText("Mover Hemograma de Thor"), { target: { value: "IN_PROGRESS" } });
    await waitFor(() => expect(api).toHaveBeenCalledWith("/diagnostic-items/item-1/start-processing", expect.objectContaining({ method: "POST" })));
  });

  it("opens a focus-contained peek without navigating and restores its opener on Escape", async () => {
    renderBoard();
    const opener = screen.getByRole("button", { name: "Abrir contexto de Hemograma — Thor" });
    fireEvent.click(opener);
    const dialog = screen.getByRole("dialog", { name: "Hemograma" });
    expect(within(dialog).getByText("Laboratório")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Fechar contexto" })).toHaveFocus();
    const workspace = within(dialog).getByRole("link", { name: "Abrir workspace completo" });
    expect(workspace).toHaveAttribute("href", "/requests/request-1#item-1");
    expect(within(dialog).getByText("Escalonamento operacional")).toBeInTheDocument();
    expect(within(dialog).getByText("No prazo")).toBeInTheDocument();
    fireEvent.keyDown(window, { key: "Tab", shiftKey: true });
    expect(workspace).toHaveFocus();
    fireEvent.keyDown(window, { key: "Tab" });
    expect(screen.getByRole("button", { name: "Fechar contexto" })).toHaveFocus();
    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() => expect(opener).toHaveFocus());
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("opens the peek when the card background is clicked and preserves server operational details", () => {
    const entry = queueItem();
    entry.operationalContext = { ...entry.operationalContext, currentOwner: { code: "REQUESTING_TEAM", label: "Equipe solicitante · Internação" }, blockedBy: { code: "WAITING_REPLACEMENT_SAMPLE", label: "Aguardando nova amostra" }, waitingSince: "2026-10-03T10:00:00Z", escalationLevel: "URGENT" };
    renderBoard(entry);
    fireEvent.click(screen.getByRole("listitem"));
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByText("Equipe solicitante · Internação")).toBeInTheDocument();
    expect(within(dialog).getByText("Aguardando nova amostra")).toBeInTheDocument();
    expect(within(dialog).getByText("Urgente")).toHaveClass("escalation-urgent");
    expect(within(dialog).getByText("Aguardando desde")).toBeInTheDocument();
    expect(within(dialog).getByText("Prazo esperado")).toBeInTheDocument();
    expect(within(dialog).getByRole("link", { name: "Abrir workspace completo" })).toHaveAttribute("href", "/requests/request-1#item-1");
  });

  it("opens recollection with authorized reason labels and preserves mandatory clinical reason", async () => {
    const api = vi.spyOn(apiClient, "apiFetch").mockImplementation((path) => Promise.resolve(path === "/clinical-reasons" ? [
      { id: "reason-1", type: "RECOLLECTION", code: "HEMOLYZED", label: "Amostra hemolisada", active: true, version: 1 },
      { id: "reason-2", type: "CANCEL", code: "CANCEL", label: "Cancelar", active: true, version: 1 },
      { id: "reason-3", type: "RECOLLECTION", code: "OLD", label: "Inativo", active: false, version: 1 }
    ] : {}) as never);
    renderBoard();
    dragTo("Recoleta necessária");
    const dialog = screen.getByRole("dialog");
    await within(dialog).findByRole("option", { name: "Amostra hemolisada" });
    expect(within(dialog).queryByRole("option", { name: "Inativo" })).not.toBeInTheDocument();
    expect(within(dialog).queryByRole("option", { name: "Cancelar" })).not.toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Confirmar" })).toBeDisabled();
    expect(within(dialog).queryByRole("textbox", { name: /Código/ })).not.toBeInTheDocument();
    fireEvent.change(within(dialog).getByLabelText("Motivo"), { target: { value: "HEMOLYZED" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Confirmar" }));
    await waitFor(() => expect(api).toHaveBeenCalledWith("/diagnostic-items/item-1/request-recollection", { method: "POST", body: JSON.stringify({ reasonCode: "HEMOLYZED", expectedVersion: 7 }) }));
  });

  it("keeps the draft editor link after creating a result, refreshing the item and reopening the peek", async () => {
    const api = vi.spyOn(apiClient, "apiFetch").mockResolvedValue({ result: { id: "result-1", version: 2 } });
    const entry = queueItem({ status: "AWAITING_REPORT", workflowType: "RADIOLOGY" });
    const { rerender, onComplete } = renderBoard(entry, "RADIOLOGY_TEAM");
    fireEvent.click(screen.getByRole("button", { name: "Registrar resultado" }));
    fireEvent.change(screen.getByLabelText("Resultado"), { target: { value: "Narrativa clínica confirmada." } });
    fireEvent.click(screen.getByRole("button", { name: "Confirmar" }));
    expect(await screen.findByRole("link", { name: "Abrir draft" })).toHaveAttribute("href", "/results/result-1");
    expect(screen.getByRole("button", { name: "Confirmar" })).toBeDisabled();
    expect(onComplete).toHaveBeenCalledOnce();
    const persisted = { ...entry, currentResultId: "result-1", version: 8 };
    rerender(<QueueBoard items={[persisted]} role="RADIOLOGY_TEAM" departments={["RADIOLOGY"]} refreshing={false} onComplete={onComplete} />);
    expect(within(screen.getByRole("dialog")).getByRole("link", { name: "Abrir draft" })).toHaveAttribute("href", "/results/result-1");
    fireEvent.click(screen.getByRole("button", { name: "Fechar contexto" }));
    fireEvent.click(screen.getByRole("button", { name: "Abrir contexto de Hemograma — Thor" }));
    expect(within(screen.getByRole("dialog")).getByRole("link", { name: "Abrir draft" })).toHaveAttribute("href", "/results/result-1");
    expect(screen.queryByRole("button", { name: "Registrar resultado" })).not.toBeInTheDocument();
    expect(api.mock.calls.filter(([path]) => path.endsWith("/results"))).toHaveLength(1);
  });

  it("keeps draft creation errors visible in the peek without reporting completion", async () => {
    vi.spyOn(apiClient, "apiFetch").mockRejectedValue(new apiClient.ApiClientError(409, { error: { code: "STALE_VERSION" } }));
    const { onComplete } = renderBoard(queueItem({ status: "AWAITING_REPORT", workflowType: "RADIOLOGY" }), "RADIOLOGY_TEAM");
    fireEvent.click(screen.getByRole("button", { name: "Registrar resultado" }));
    fireEvent.change(screen.getByLabelText("Resultado"), { target: { value: "Narrativa clínica confirmada." } });
    fireEvent.click(screen.getByRole("button", { name: "Confirmar" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Os dados mudaram");
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(onComplete).not.toHaveBeenCalled();
  });

  it("preserves clinical input during realtime refresh and submits the latest item version", async () => {
    const api = vi.spyOn(apiClient, "apiFetch").mockResolvedValue({ result: { id: "result-1", version: 2 } });
    const entry = queueItem({ status: "AWAITING_REPORT", workflowType: "RADIOLOGY" });
    const { rerender, onComplete } = renderBoard(entry, "RADIOLOGY_TEAM");
    fireEvent.click(screen.getByRole("button", { name: "Registrar resultado" }));
    fireEvent.change(screen.getByLabelText("Resultado"), { target: { value: "Texto clínico em elaboração." } });
    rerender(<QueueBoard items={[{ ...entry, version: 8 }]} role="RADIOLOGY_TEAM" departments={["RADIOLOGY"]} refreshing={false} onComplete={onComplete} />);
    expect(screen.getByLabelText("Resultado")).toHaveValue("Texto clínico em elaboração.");
    fireEvent.click(screen.getByRole("button", { name: "Confirmar" }));
    await waitFor(() => expect(api).toHaveBeenCalledWith("/diagnostic-items/item-1/results", { method: "POST", body: JSON.stringify({ narrative: "Texto clínico em elaboração.", content: {}, expectedVersion: 8 }) }));
    expect(await screen.findByRole("link", { name: "Abrir draft" })).toHaveAttribute("href", "/results/result-1");
  });

  it.each(["click", "drag"])("releases a ready draft with one %s using its result version and preserving critical status", async (gesture) => {
    const api = vi.spyOn(apiClient, "apiFetch").mockImplementation((path) => Promise.resolve(path === "/results/result-1" ? resultView({ critical: true }) : {}) as never);
    const { onComplete } = renderBoard(queueItem({ workflowType: "RADIOLOGY", status: "AWAITING_REPORT", currentResultId: "result-1" }), "RADIOLOGY_TEAM");
    if (gesture === "click") fireEvent.click(screen.getByRole("button", { name: "Liberar resultado" }));
    else dragTo("Resultado disponível");
    await waitFor(() => expect(onComplete).toHaveBeenCalledOnce());
    expect(api).toHaveBeenCalledWith("/results/result-1/release", { method: "POST", body: JSON.stringify({ expectedVersion: 11, critical: true }) });
    expect(api.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("reports a missing draft without creating fabricated clinical content", async () => {
    const api = vi.spyOn(apiClient, "apiFetch").mockResolvedValue({});
    renderBoard(queueItem({ status: "IN_PROGRESS" }));
    fireEvent.click(screen.getByRole("button", { name: "Liberar resultado" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("rascunho válido");
    expect(api).not.toHaveBeenCalled();
  });

  it("reports missing structured clinical content without fabricating laboratory observations", async () => {
    const view = resultView();
    view.service = { name: "Hemograma", workflowType: "LABORATORY", resultSchema: "NUMERIC_PANEL" };
    const api = vi.spyOn(apiClient, "apiFetch").mockResolvedValue(view);
    renderBoard(queueItem({ status: "IN_PROGRESS", currentResultId: "result-1" }));
    fireEvent.click(screen.getByRole("button", { name: "Liberar resultado" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("conteúdo clínico obrigatório");
    expect(api).toHaveBeenCalledOnce();
    expect(api.mock.calls[0]?.[1]?.method).toBeUndefined();
  });

  it("shows an explicit clinical error when the authoritative server validation rejects release", async () => {
    vi.spyOn(apiClient, "apiFetch").mockImplementation((path) => path === "/results/result-1" ? Promise.resolve(resultView()) as never : Promise.reject(new apiClient.ApiClientError(422, { error: { code: "VALIDATION_ERROR" } })));
    const { onComplete } = renderBoard(queueItem({ status: "AWAITING_REPORT", workflowType: "RADIOLOGY", currentResultId: "result-1" }), "RADIOLOGY_TEAM");
    fireEvent.click(screen.getByRole("button", { name: "Liberar resultado" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("conteúdo clínico do resultado está incompleto ou inválido");
    expect(onComplete).not.toHaveBeenCalled();
  });

  it("retains the card in its current column on server failure", async () => {
    vi.spyOn(apiClient, "apiFetch").mockRejectedValue(new Error("conflict"));
    const { onComplete } = renderBoard();
    dragTo("Em execução");
    expect(await screen.findByRole("alert")).toHaveTextContent("Atualize a fila");
    expect(within(screen.getByRole("region", { name: "Amostra recebida" })).getByRole("listitem")).toBeInTheDocument();
    expect(onComplete).not.toHaveBeenCalled();
  });

  it("blocks duplicate submits while a versioned mutation is pending", async () => {
    let complete!: (value: unknown) => void;
    const api = vi.spyOn(apiClient, "apiFetch").mockImplementation(() => new Promise((resolve) => { complete = resolve; }) as never);
    renderBoard();
    const action = screen.getByRole("button", { name: "Iniciar processamento" });
    fireEvent.click(action);
    fireEvent.click(action);
    expect(api).toHaveBeenCalledOnce();
    expect(action).toBeDisabled();
    complete({});
    await waitFor(() => expect(action).not.toBeDisabled());
  });

  it("offers no executor controls or quick add for a viewer", () => {
    renderBoard(queueItem(), "VIEWER");
    expect(screen.queryByRole("button", { name: "Iniciar processamento" })).not.toBeInTheDocument();
    expect(screen.getByLabelText("Mover Hemograma de Thor")).toBeDisabled();
    expect(screen.getByRole("listitem")).toHaveAttribute("draggable", "false");
    expect(screen.queryByRole("form", { name: "Adicionar exame à fila" })).not.toBeInTheDocument();
  });

  it("accepts a live drag, clears a cancelled drag and ignores a drop without a card", () => {
    const api = vi.spyOn(apiClient, "apiFetch").mockResolvedValue({});
    renderBoard();
    const target = screen.getByRole("region", { name: "Em execução" });
    expect(fireEvent.dragOver(target)).toBe(true);
    const transfer = { setData: vi.fn(), effectAllowed: "none" };
    fireEvent.dragStart(screen.getByRole("listitem"), { dataTransfer: transfer });
    expect(transfer.setData).toHaveBeenCalledWith("text/plain", "item-1");
    expect(transfer.effectAllowed).toBe("move");
    expect(screen.getByRole("button", { name: "Abrir contexto de Hemograma — Thor" })).toHaveFocus();
    expect(fireEvent.dragOver(target)).toBe(false);
    fireEvent.dragEnd(screen.getByRole("listitem"));
    expect(fireEvent.dragOver(target)).toBe(true);
    fireEvent.drop(target);
    expect(api).not.toHaveBeenCalled();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("leaves same-state drops alone and explains invalid or unauthorized transitions", () => {
    const api = vi.spyOn(apiClient, "apiFetch").mockResolvedValue({});
    const { rerender, onComplete } = renderBoard();
    dragTo("Amostra recebida");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    dragTo("Solicitado");
    expect(screen.getByRole("alert")).toHaveTextContent("Esta mudança não é permitida no fluxo do exame");
    expect(api).not.toHaveBeenCalled();
    fireEvent.dragStart(screen.getByRole("listitem"), { dataTransfer: { setData: vi.fn() } });
    rerender(<QueueBoard items={[queueItem()]} role="VIEWER" departments={["LABORATORY"]} refreshing={false} onComplete={onComplete} />);
    // A stale drag can reach the drop handler after permissions have changed.
    fireEvent.drop(screen.getByRole("region", { name: "Em execução" }));
    expect(screen.getByRole("alert")).toHaveTextContent("Seu perfil não permite esta ação");
    expect(api).not.toHaveBeenCalled();
    expect(onComplete).not.toHaveBeenCalled();
  });

  it("prevents a stale drag from mutating while refreshing or another card is pending", async () => {
    let resolve!: (value: unknown) => void;
    const api = vi.spyOn(apiClient, "apiFetch").mockImplementation(() => new Promise((complete) => { resolve = complete; }) as never);
    const { rerender, onComplete } = renderBoard();
    fireEvent.dragStart(screen.getByRole("listitem"), { dataTransfer: { setData: vi.fn() } });
    rerender(<QueueBoard items={[queueItem()]} role="LAB_TECH" departments={["LABORATORY"]} refreshing onComplete={onComplete} />);
    const column = screen.getByRole("region", { name: "Em execução" });
    expect(fireEvent.dragOver(column)).toBe(true);
    fireEvent.drop(column);
    expect(api).not.toHaveBeenCalled();
    expect(screen.getByRole("listitem")).toHaveAttribute("draggable", "false");
    rerender(<QueueBoard items={[queueItem()]} role="LAB_TECH" departments={["LABORATORY"]} refreshing={false} onComplete={onComplete} />);
    fireEvent.click(screen.getByRole("button", { name: "Iniciar processamento" }));
    fireEvent.dragStart(screen.getByRole("listitem"), { dataTransfer: { setData: vi.fn() } });
    expect(fireEvent.dragOver(column)).toBe(true);
    fireEvent.drop(column);
    expect(api).toHaveBeenCalledOnce();
    expect(onComplete).not.toHaveBeenCalled();
    await act(async () => { resolve({}); });
    expect(onComplete).toHaveBeenCalledOnce();
    expect(screen.getByRole("status")).toHaveTextContent("Iniciar processamento: confirmado pelo servidor");
  });

  it("closes only on drawer backdrop interaction and shows missing dates without invalid formatting", () => {
    const entry = queueItem({ overdue: true, dueAt: "invalid-date", operationalContext: { ...queueItem().operationalContext, waitingSince: "invalid-date", expectedBy: null } });
    renderBoard(entry);
    expect(screen.getByText("Atrasado")).toHaveClass("text-danger");
    fireEvent.click(screen.getByRole("button", { name: "Abrir contexto de Hemograma — Thor" }));
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getAllByText("Não informado")).toHaveLength(2);
    expect(within(dialog).getByText("Sem bloqueio registrado")).toBeInTheDocument();
    fireEvent.mouseDown(within(dialog).getByRole("heading", { name: "Hemograma" }));
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    const backdrop = dialog.parentElement;
    expect(backdrop).not.toBeNull();
    fireEvent.mouseDown(backdrop!);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("opens an existing result for review and completes an authorized amendment inside the drawer", async () => {
    const api = vi.spyOn(apiClient, "apiFetch").mockImplementation((path) => Promise.resolve(path === "/clinical-reasons" ? [
      { id: "reason-1", type: "AMEND", code: "CORRECTION", label: "Correção clínica", active: true, version: 1 }
    ] : path === "/results/result-1" ? resultView() : {}) as never);
    const { onComplete } = renderBoard(queueItem({ status: "RESULT_AVAILABLE", currentResultId: "result-1" }));
    fireEvent.click(screen.getByRole("button", { name: "Abrir resultado" }));
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByRole("link", { name: "Abrir resultado" })).toHaveAttribute("href", "/results/result-1");
    fireEvent.click(within(dialog).getByRole("button", { name: "Emendar resultado" }));
    await within(dialog).findByRole("option", { name: "Correção clínica" });
    fireEvent.change(within(dialog).getByLabelText("Motivo"), { target: { value: "CORRECTION" } });
    fireEvent.change(within(dialog).getByLabelText("Resultado"), { target: { value: "Laudo clínico corrigido." } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Confirmar" }));
    await waitFor(() => expect(onComplete).toHaveBeenCalledOnce());
    expect(api).toHaveBeenCalledWith("/results/result-1/amend", { method: "POST", body: JSON.stringify({ narrative: "Laudo clínico corrigido.", content: {}, reason: "Correção clínica", critical: false, expectedVersion: 11 }) });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("shows an existing draft in the context without opening a second clinical form", () => {
    const api = vi.spyOn(apiClient, "apiFetch").mockResolvedValue({});
    renderBoard(queueItem({ status: "AWAITING_REPORT", workflowType: "RADIOLOGY", currentResultId: "result-1" }), "RADIOLOGY_TEAM");
    fireEvent.click(screen.getByRole("button", { name: "Abrir draft" }));
    expect(within(screen.getByRole("dialog")).getByRole("link", { name: "Abrir draft" })).toHaveAttribute("href", "/results/result-1");
    expect(screen.queryByLabelText("Resultado")).not.toBeInTheDocument();
    expect(api).not.toHaveBeenCalled();
  });
});
