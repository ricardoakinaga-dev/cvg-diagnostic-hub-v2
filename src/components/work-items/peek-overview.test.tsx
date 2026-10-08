/** @vitest-environment jsdom */
import { useState } from "react";
import { renderToString } from "react-dom/server";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { apiFetch } from "@/components/api-client";
import { PeekOverview } from "./peek-overview";
import type { WorkItem } from "./model";

vi.mock("next/link", () => ({ default: ({ children, ...props }: { children: React.ReactNode; href: string }) => <a {...props}>{children}</a> }));
vi.mock("@/components/api-client", async (original) => ({ ...await original<typeof import("@/components/api-client")>(), apiFetch: vi.fn() }));

const item: WorkItem = { id: "exam-1", requestId: "request-1", requestCode: "EX-261006-0001", status: "REQUESTED", priority: "ROUTINE", workflowType: "LABORATORY", departmentCode: "LABORATORY", version: 3, dueAt: "2026-10-07T12:00:00Z", createdAt: "2026-10-06T10:00:00Z", overdue: false, patient: { id: "patient-1", displayName: "Thor", species: "Canino", externalId: "HIS-1" }, service: { id: "service-1", code: "HEM", name: "Hemograma" } };
const callbacks = () => ({ onClose: vi.fn(), onChanged: vi.fn(), onRefresh: vi.fn(), onMove: vi.fn() });
function mockApi() {
  vi.mocked(apiFetch).mockImplementation(async (path) => {
    if (path === "/clinical-reasons") return ["CANCEL", "REJECT", "AMEND", "RECOLLECTION"].map((type) => ({ id: type, code: type, type, active: true, label: `Motivo ${type}` })) as never;
    if (path === "/results/result-1") return { result: { version: 7 }, version: { content: {}, conclusion: "Normal", critical: false } } as never;
    if (path.endsWith("/results")) return { result: { id: "draft-1", version: 1 } } as never;
    return [] as never;
  });
}

describe("PeekOverview", () => {
  beforeEach(mockApi);
  afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.clearAllMocks(); });

  it("renders patient/result context, activity in newest-first order and a disabled viewer state", async () => {
    vi.mocked(apiFetch).mockResolvedValue([{ id: "first", eventType: "SampleReceived", newState: "RECEIVED", occurredAt: "2026-10-06T10:00:00Z" }, { id: "last", eventType: "ResultReleased", newState: "RESULT_AVAILABLE", occurredAt: "2026-10-06T11:00:00Z" }] as never);
    render(<PeekOverview item={{ ...item, status: "RESULT_AVAILABLE", currentResultId: "result-1", nextAction: "Revisar", patient: { ...item.patient, breed: "Poodle", ownerLabel: "Ana" } }} role="VIEWER" {...callbacks()} />);
    expect(screen.getByRole("dialog", { name: "Hemograma" })).toHaveAttribute("aria-modal", "false");
    expect(screen.getByRole("heading", { name: "Hemograma" })).toHaveFocus();
    expect(screen.getByText(/Poodle.*tutor Ana/)).toBeInTheDocument();
    for (const link of screen.getAllByRole("link", { name: "Abrir resultado" })) expect(link).toHaveAttribute("href", "/results/result-1");
    expect(screen.getByRole("button", { name: "Estado: Resultado disponível" })).toBeDisabled();
    await waitFor(() => expect(screen.getAllByRole("listitem")).toHaveLength(2));
    expect(screen.getAllByRole("listitem")[0].querySelector("time")).toHaveAttribute("datetime", "2026-10-06T11:00:00Z");
  });

  it("recovers failed activity on realtime refresh and reloads after a version change", async () => {
    const props = callbacks();
    vi.mocked(apiFetch).mockRejectedValueOnce(new Error("offline"));
    const view = render(<PeekOverview item={item} role="VIEWER" {...props} />);
    expect(await screen.findByText("Atividade indisponível no momento.")).toBeInTheDocument();
    act(() => window.dispatchEvent(new Event("cvg:realtime-updated")));
    expect(await screen.findByText("Nenhum evento registrado ainda.")).toBeInTheDocument();
    expect(screen.queryByText("Atividade indisponível no momento.")).not.toBeInTheDocument();
    vi.mocked(apiFetch).mockClear();
    view.rerender(<PeekOverview item={{ ...item, version: 4 }} role="VIEWER" {...props} />);
    await waitFor(() => expect(apiFetch).toHaveBeenCalledWith("/timeline?requestId=request-1"));
    view.unmount();
    vi.mocked(apiFetch).mockClear();
    act(() => window.dispatchEvent(new Event("cvg:realtime-updated")));
    expect(apiFetch).not.toHaveBeenCalled();
  });

  it.each(["resolve", "reject"] as const)("ignores activity %s after unmount", async (outcome) => {
    let resolve!: (value: never) => void;
    let reject!: (cause: Error) => void;
    vi.mocked(apiFetch).mockImplementation(() => new Promise((yes, no) => { resolve = yes; reject = no; }));
    const view = render(<PeekOverview item={item} role="VIEWER" {...callbacks()} />);
    expect(screen.getByText("Carregando atividade…")).toBeInTheDocument();
    view.unmount();
    await act(async () => { if (outcome === "resolve") resolve([] as never); else reject(new Error("offline")); });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("copies the item deep link, resets feedback and tolerates unavailable clipboard", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    const clipboard = Object.getOwnPropertyDescriptor(navigator, "clipboard");
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    try {
      render(<PeekOverview item={item} role="VIEWER" {...callbacks()} />);
      await screen.findByText("Nenhum evento registrado ainda.");
      vi.useFakeTimers();
      await act(async () => fireEvent.click(screen.getByRole("button", { name: "Copiar link" })));
      expect(writeText).toHaveBeenCalledWith(`${window.location.origin}/requests/request-1#exam-1`);
      expect(screen.getByRole("button", { name: "Link copiado" })).toBeInTheDocument();
      act(() => vi.advanceTimersByTime(1600));
      writeText.mockRejectedValueOnce(new Error("denied"));
      await act(async () => fireEvent.click(screen.getByRole("button", { name: "Copiar link" })));
      expect(screen.getByRole("button", { name: "Copiar link" })).toBeInTheDocument();
    } finally { if (clipboard) Object.defineProperty(navigator, "clipboard", clipboard); else Reflect.deleteProperty(navigator, "clipboard"); }
  });

  it("respects nested form/menu/dialog Escape handling and returns focus to its original opener", async () => {
    function Harness() {
      const [open, setOpen] = useState(false);
      return <><button onClick={() => setOpen(true)}>Open exam</button>{open && <PeekOverview item={item} role="VETERINARIAN" {...callbacks()} onClose={() => setOpen(false)} />}</>;
    }
    const events: boolean[] = [];
    const listener = (event: Event) => events.push((event as CustomEvent<boolean>).detail);
    window.addEventListener("cvg:peek", listener);
    render(<Harness />);
    const opener = screen.getByRole("button", { name: "Open exam" });
    opener.focus(); fireEvent.click(opener);
    await screen.findByText("Nenhum evento registrado ainda.");
    fireEvent.keyDown(window, { key: "Enter" });
    fireEvent.click(screen.getByRole("button", { name: "Cancelar exame" }));
    const form = screen.getByRole("form", { name: "Cancelar exame" });
    await within(form).findByRole("option", { name: "Motivo CANCEL" });
    fireEvent.keyDown(within(form).getByRole("combobox"), { key: "Escape" });
    expect(screen.getByRole("dialog", { name: "Hemograma" })).toBeInTheDocument();
    const layer = document.createElement("div"); layer.dataset.dialogLayer = "true"; document.body.append(layer);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.getByRole("dialog")).toBeInTheDocument(); layer.remove();
    const menu = document.createElement("button"); menu.setAttribute("role", "menu"); document.body.append(menu);
    fireEvent.keyDown(menu, { key: "Escape" }); expect(screen.getByRole("dialog")).toBeInTheDocument(); menu.remove();
    const prevented = new KeyboardEvent("keydown", { key: "Escape", cancelable: true }); prevented.preventDefault();
    act(() => window.dispatchEvent(prevented)); expect(screen.getByRole("dialog")).toBeInTheDocument();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(opener).toHaveFocus(); expect(events).toEqual([true, false]);
    window.removeEventListener("cvg:peek", listener);
  });

  it("submits cancellation through the clinical form and reports completion", async () => {
    const props = callbacks();
    render(<PeekOverview item={item} role="VETERINARIAN" {...props} />);
    fireEvent.click(screen.getByRole("button", { name: "Cancelar exame" }));
    const form = screen.getByRole("form", { name: "Cancelar exame" });
    await within(form).findByRole("option", { name: "Motivo CANCEL" });
    fireEvent.change(within(form).getByRole("combobox"), { target: { value: "CANCEL" } });
    fireEvent.click(within(form).getByRole("button", { name: "Confirmar" }));
    await waitFor(() => expect(props.onChanged).toHaveBeenCalledOnce());
    expect(apiFetch).toHaveBeenCalledWith("/diagnostic-items/exam-1/cancel", expect.objectContaining({ body: JSON.stringify({ reasonCode: "CANCEL", expectedVersion: 3 }) }));
  });

  it("links the item's sample to its printable label", () => {
    const props = callbacks();
    const view = render(<PeekOverview item={{ ...item, status: "REQUESTED", currentSampleId: "sample-7" }} role="LAB_TECH" {...props} />);
    expect(screen.getByRole("link", { name: "Etiqueta da amostra" })).toHaveAttribute("href", "/samples/sample-7/label");
    view.unmount();
    render(<PeekOverview item={{ ...item, currentSampleId: undefined }} role="LAB_TECH" {...props} />);
    expect(screen.queryByRole("link", { name: "Etiqueta da amostra" })).not.toBeInTheDocument();
  });

  it("opens rejection and amendment with authorized clinical reasons", async () => {
    const props = callbacks();
    const view = render(<PeekOverview item={{ ...item, status: "RECEIVED", currentSampleId: "sample-1" }} role="LAB_TECH" {...props} />);
    fireEvent.click(screen.getByRole("button", { name: "Rejeitar" }));
    expect(screen.getByRole("form", { name: "Rejeitar exame" })).toBeInTheDocument();
    view.unmount();
    render(<PeekOverview item={{ ...item, status: "RESULT_AVAILABLE", currentResultId: "result-1" }} role="LAB_TECH" {...props} />);
    fireEvent.click(screen.getByRole("button", { name: "Emendar resultado" }));
    const form = screen.getByRole("form", { name: "Emendar resultado" });
    await within(form).findByRole("option", { name: "Motivo AMEND" });
    fireEvent.change(within(form).getByRole("combobox"), { target: { value: "AMEND" } });
    fireEvent.change(within(form).getByRole("textbox", { name: "Resultado" }), { target: { value: "Emenda clínica" } });
    fireEvent.click(within(form).getByRole("button", { name: "Confirmar" }));
    await waitFor(() => expect(props.onChanged).toHaveBeenCalledOnce());
    expect(apiFetch).toHaveBeenCalledWith("/results/result-1/amend", expect.objectContaining({ method: "POST" }));
  });

  it("notifies the parent when a result draft is created", async () => {
    const props = callbacks();
    render(<PeekOverview item={{ ...item, status: "IN_PROGRESS" }} initialAction="CREATE_RESULT" role="LAB_TECH" {...props} />);
    const form = screen.getByRole("form", { name: "Registrar resultado" });
    fireEvent.change(within(form).getByRole("textbox", { name: "Resultado" }), { target: { value: "Sem alterações" } });
    fireEvent.click(within(form).getByRole("button", { name: "Confirmar" }));
    await waitFor(() => expect(props.onRefresh).toHaveBeenCalledOnce());
    expect(props.onChanged).not.toHaveBeenCalled();
  });

  it("traps mobile focus, reacts to media changes and removes its listener", async () => {
    let matches = true;
    const listeners = new Set<() => void>();
    const removeEventListener = vi.fn((_: string, listener: () => void) => listeners.delete(listener));
    vi.stubGlobal("matchMedia", vi.fn(() => ({ get matches() { return matches; }, addEventListener: (_: string, listener: () => void) => listeners.add(listener), removeEventListener })));
    const props = callbacks();
    const view = render(<><button>Outside</button><PeekOverview item={item} role="VETERINARIAN" {...props} /></>);
    await screen.findByText("Nenhum evento registrado ainda.");
    const dialog = screen.getByRole("dialog"); expect(dialog).toHaveAttribute("aria-modal", "true");
    const close = screen.getByRole("button", { name: "Fechar contexto" });
    close.focus(); fireEvent.keyDown(close, { key: "Tab", shiftKey: true });
    expect(dialog).toContainElement(document.activeElement as HTMLElement);
    fireEvent.click(screen.getByRole("button", { name: "Cancelar exame" }));
    const select = await screen.findByRole("combobox");
    await screen.findByRole("option", { name: "Motivo CANCEL" });
    select.focus(); fireEvent.keyDown(select, { key: "Escape" });
    expect(props.onClose).not.toHaveBeenCalled();
    close.focus(); fireEvent.keyDown(close, { key: "Escape" });
    expect(props.onClose).toHaveBeenCalled();
    act(() => { matches = false; listeners.forEach((listener) => listener()); });
    expect(dialog).toHaveAttribute("aria-modal", "false");
    view.unmount(); expect(removeEventListener).toHaveBeenCalled();
  });

  it("renders a nonmodal server snapshot without browser effects", () => {
    const markup = renderToString(<PeekOverview item={item} role="VIEWER" {...callbacks()} />);
    expect(markup).toContain('aria-modal="false"');
    expect(markup).toContain("Sem ação pendente");
    expect(apiFetch).not.toHaveBeenCalled();
  });
});
