/** @vitest-environment jsdom */
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Patient, SearchResult } from "@cvg/contracts";
import { CommandPalette } from "./command-palette";
import { apiFetch } from "./api-client";

vi.mock("./api-client", () => ({ apiFetch: vi.fn() }));

const patient: Patient = { id: "patient-amora", displayName: "Amora", species: "Canino", breed: "Não informado", sex: "Não informado", ownerLabel: "Maria", externalId: "AMORA", active: true };
const exam: SearchResult = { type: "ITEM", id: "item-1", label: "HEM · CVG-1", patient: "Amora", status: "REQUESTED", priority: "ROUTINE", updatedAt: "2026-10-03T12:00:00Z", departmentCode: "LABORATORY", deepLink: "/requests/request-1#item-1" };

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((onResolve, onReject) => { resolve = onResolve; reject = onReject; });
  return { promise, resolve, reject };
}

function setup(overrides: Partial<React.ComponentProps<typeof CommandPalette>> = {}) {
  const props = { canCreatePatient: true, canCreateRequest: true, onClose: vi.fn(), onNewPatient: vi.fn(), onNewRequest: vi.fn(), onNavigate: vi.fn(), ...overrides };
  const view = render(<CommandPalette {...props} />);
  return { ...view, props, input: screen.getByRole("combobox", { name: "Buscar paciente ou exame" }) };
}

describe("CommandPalette", () => {
  beforeEach(() => { vi.mocked(apiFetch).mockReset(); });
  afterEach(() => { cleanup(); vi.restoreAllMocks(); });

  it("focuses the search field and runs create commands with arrows and Enter", () => {
    const { input, props } = setup();
    expect(input).toHaveFocus();
    expect(screen.getByRole("dialog", { name: "Atalhos e busca" })).toHaveAttribute("aria-modal", "true");
    fireEvent.keyDown(input, { key: "Enter" });
    expect(props.onNewRequest).toHaveBeenCalledOnce();
    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(screen.getByRole("option", { name: /Novo paciente/ })).toHaveAttribute("aria-selected", "true");
    expect(input).toHaveAttribute("aria-activedescendant", screen.getByRole("option", { name: /Novo paciente/ }).id);
    fireEvent.keyDown(input, { key: "Enter" });
    expect(props.onNewPatient).toHaveBeenCalledOnce();
    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(screen.getByRole("option", { name: /Novo exame/ })).toHaveAttribute("aria-selected", "true");
    fireEvent.keyDown(input, { key: "End" });
    expect(screen.getByRole("option", { name: /Novo paciente/ })).toHaveAttribute("aria-selected", "true");
    fireEvent.keyDown(input, { key: "Home" });
    fireEvent.keyDown(input, { key: "ArrowUp" });
    expect(screen.getByRole("option", { name: /Novo paciente/ })).toHaveAttribute("aria-selected", "true");
    expect(apiFetch).not.toHaveBeenCalled();
  });

  it("debounces and uses the existing scoped patient and exam endpoints", async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce([patient]).mockResolvedValueOnce([exam]);
    const { input, props } = setup();
    fireEvent.change(input, { target: { value: "A" } });
    expect(apiFetch).not.toHaveBeenCalled();
    fireEvent.change(input, { target: { value: "  Amora &  " } });
    expect(screen.getByRole("status")).toHaveTextContent("Buscando pacientes e exames");
    expect(await screen.findByRole("option", { name: /Paciente · Canino · Maria/ })).toBeInTheDocument();
    expect(apiFetch).toHaveBeenNthCalledWith(1, "/patients?q=Amora%20%26", expect.objectContaining({ signal: expect.any(AbortSignal) }));
    expect(apiFetch).toHaveBeenNthCalledWith(2, "/search?q=Amora%20%26&types=ITEM&limit=10", expect.objectContaining({ signal: expect.any(AbortSignal) }));
    expect(screen.getByRole("status")).toHaveTextContent("2 resultados encontrados");
    fireEvent.change(input, { target: { value: "Amora & " } });
    expect(screen.getByRole("status")).toHaveTextContent("2 resultados encontrados");
    expect(apiFetch).toHaveBeenCalledTimes(2);
    fireEvent.keyDown(input, { key: "Enter" });
    expect(props.onNavigate).toHaveBeenCalledWith("/patients/patient-amora/diagnostics");
    fireEvent.click(screen.getByRole("option", { name: /HEM · CVG-1/ }));
    expect(props.onNavigate).toHaveBeenCalledWith("/requests/request-1#item-1");
  });

  it("aborts outdated searches and ignores late responses even when transport ignores abort", async () => {
    const oldPatients = deferred<Patient[]>();
    const oldExams = deferred<SearchResult[]>();
    vi.mocked(apiFetch).mockReturnValueOnce(oldPatients.promise).mockReturnValueOnce(oldExams.promise).mockResolvedValueOnce([{ ...patient, id: "patient-bento", displayName: "Bento" }]).mockResolvedValueOnce([]);
    const { input } = setup();
    fireEvent.change(input, { target: { value: "Amora" } });
    await waitFor(() => expect(apiFetch).toHaveBeenCalledTimes(2));
    const oldSignal = vi.mocked(apiFetch).mock.calls[0][1]?.signal;
    fireEvent.change(input, { target: { value: "Bento" } });
    expect(oldSignal?.aborted).toBe(true);
    expect(await screen.findByRole("option", { name: /Bento/ })).toBeInTheDocument();
    await act(async () => { oldPatients.resolve([patient]); oldExams.resolve([exam]); await oldExams.promise; });
    expect(screen.queryByRole("option", { name: /Amora/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("option", { name: /HEM/ })).not.toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("1 resultado encontrado");
  });

  it("clears old results immediately and cancels when query gets too short or dialog unmounts", async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce([patient]).mockResolvedValueOnce([]);
    const { input, unmount } = setup();
    fireEvent.change(input, { target: { value: "Amora" } });
    await screen.findByRole("option", { name: /Paciente · Canino/ });
    const signal = vi.mocked(apiFetch).mock.calls[0][1]?.signal;
    fireEvent.change(input, { target: { value: "A" } });
    expect(screen.queryByRole("option", { name: /Paciente · Canino/ })).not.toBeInTheDocument();
    expect(signal?.aborted).toBe(true);
    const pending = deferred<Patient[]>();
    vi.mocked(apiFetch).mockReturnValueOnce(pending.promise).mockResolvedValueOnce([]);
    fireEvent.change(input, { target: { value: "Bento" } });
    await waitFor(() => expect(apiFetch).toHaveBeenCalledTimes(4));
    const pendingSignal = vi.mocked(apiFetch).mock.calls[2][1]?.signal;
    unmount();
    expect(pendingSignal?.aborted).toBe(true);
    await act(async () => { pending.resolve([patient]); await pending.promise; });
  });

  it("keeps successful results when one endpoint fails and retries the search", async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce([patient]).mockRejectedValueOnce(new Error("private backend detail")).mockResolvedValueOnce([patient]).mockResolvedValueOnce([exam]);
    const { input } = setup();
    fireEvent.change(input, { target: { value: "Amora" } });
    expect(await screen.findByRole("alert")).toHaveTextContent("Não foi possível buscar exames.");
    expect(screen.getByRole("option", { name: /Paciente · Canino/ })).toBeInTheDocument();
    expect(screen.queryByText("private backend detail")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Tentar novamente" }));
    await screen.findByRole("option", { name: /HEM/ });
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("announces an empty search and excludes unsafe exam navigation targets", async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce([]).mockResolvedValueOnce([{ ...exam, deepLink: "javascript:alert(1)" }]);
    const { input, props } = setup({ canCreatePatient: false, canCreateRequest: false });
    fireEvent.change(input, { target: { value: "HEM" } });
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("0 resultados encontrados"));
    expect(screen.queryByRole("option")).not.toBeInTheDocument();
    fireEvent.keyDown(input, { key: "Enter" });
    expect(props.onNavigate).not.toHaveBeenCalled();
  });

  it("reports complete search failure without exposing errors or privileged actions", async () => {
    vi.mocked(apiFetch).mockRejectedValue(new Error("private detail"));
    const { input } = setup({ canCreatePatient: false, canCreateRequest: false });
    fireEvent.change(input, { target: { value: "Amora" } });
    expect(await screen.findByRole("alert")).toHaveTextContent("Não foi possível buscar pacientes e exames.");
    expect(screen.queryByText("private detail")).not.toBeInTheDocument();
    expect(screen.queryByRole("option", { name: /Novo/ })).not.toBeInTheDocument();
  });

  it("traps focus, dismisses via Escape or backdrop and restores its opener", async () => {
    const opener = document.createElement("button");
    document.body.appendChild(opener);
    opener.focus();
    const { input, props, unmount } = setup();
    const close = screen.getByRole("button", { name: "Fechar atalhos e busca" });
    fireEvent.keyDown(window, { key: "Tab" });
    expect(close).toHaveFocus();
    fireEvent.keyDown(window, { key: "Tab", shiftKey: true });
    expect(input).toHaveFocus();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(props.onClose).toHaveBeenCalledOnce();
    fireEvent.mouseDown(screen.getByRole("presentation"));
    expect(props.onClose).toHaveBeenCalledTimes(2);
    unmount();
    await waitFor(() => expect(opener).toHaveFocus());
    opener.remove();
  });

  it("keeps input focus while choosing a hovered option and only dismisses outside the dialog", () => {
    const { input, props } = setup();
    const option = screen.getByRole("option", { name: /Novo paciente/ });
    fireEvent.mouseEnter(option);
    expect(option).toHaveAttribute("aria-selected", "true");
    expect(input).toHaveAttribute("aria-activedescendant", option.id);
    expect(fireEvent.mouseDown(option)).toBe(false);
    expect(input).toHaveFocus();
    expect(props.onClose).not.toHaveBeenCalled();
    fireEvent.keyDown(input, { key: "Enter" });
    expect(props.onNewPatient).toHaveBeenCalledOnce();
    expect(props.onNewRequest).not.toHaveBeenCalled();
    fireEvent.mouseDown(screen.getByRole("heading", { name: "Atalhos e busca" }));
    expect(props.onClose).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Fechar atalhos e busca" }));
    expect(props.onClose).toHaveBeenCalledOnce();
  });

  it("does not execute or change selection during IME composition", () => {
    const { input, props } = setup();
    fireEvent.keyDown(input, { key: "ArrowDown", isComposing: true });
    fireEvent.keyDown(input, { key: "Enter", isComposing: true });
    expect(screen.getByRole("option", { name: /Novo exame/ })).toHaveAttribute("aria-selected", "true");
    expect(props.onNewRequest).not.toHaveBeenCalled();
    expect(props.onNewPatient).not.toHaveBeenCalled();
    fireEvent.keyDown(input, { key: "Enter" });
    expect(props.onNewRequest).toHaveBeenCalledOnce();
  });

  it("keeps exam navigation available when only the patient search fails", async () => {
    vi.mocked(apiFetch).mockRejectedValueOnce(new Error("private patient detail")).mockResolvedValueOnce([exam]);
    const { input, props } = setup({ canCreatePatient: false, canCreateRequest: false });
    fireEvent.change(input, { target: { value: "HEM" } });
    expect(await screen.findByRole("alert")).toHaveTextContent("Não foi possível buscar pacientes.");
    expect(screen.getByRole("status")).toHaveTextContent("1 resultado encontrado.");
    fireEvent.keyDown(input, { key: "Enter" });
    expect(props.onNavigate).toHaveBeenCalledWith(exam.deepLink);
    expect(screen.queryByText("private patient detail")).not.toBeInTheDocument();
  });

  it.each([
    { canCreatePatient: true, canCreateRequest: false, visible: "Novo paciente", hidden: "Novo exame" },
    { canCreatePatient: false, canCreateRequest: true, visible: "Novo exame", hidden: "Novo paciente" }
  ])("limits creation commands independently to the permission for $visible", ({ canCreatePatient, canCreateRequest, visible, hidden }) => {
    const { input, props } = setup({ canCreatePatient, canCreateRequest });
    expect(screen.getAllByRole("option")).toHaveLength(1);
    expect(screen.getByRole("option", { name: new RegExp(visible) })).toHaveAttribute("aria-selected", "true");
    expect(screen.queryByRole("option", { name: new RegExp(hidden) })).not.toBeInTheDocument();
    fireEvent.keyDown(input, { key: "Enter" });
    expect(canCreatePatient ? props.onNewPatient : props.onNewRequest).toHaveBeenCalledOnce();
    expect(canCreatePatient ? props.onNewRequest : props.onNewPatient).not.toHaveBeenCalled();
  });

  it("counts Unicode characters and cancels a debounced search before any request starts", async () => {
    vi.useFakeTimers();
    try {
      vi.mocked(apiFetch).mockResolvedValue([]);
      const { input, unmount } = setup();
      fireEvent.change(input, { target: { value: "🐾" } });
      await act(async () => { await vi.advanceTimersByTimeAsync(200); });
      expect(apiFetch).not.toHaveBeenCalled();
      fireEvent.change(input, { target: { value: "🐾A" } });
      expect(screen.getByRole("listbox")).toHaveAttribute("aria-busy", "true");
      unmount();
      await act(async () => { await vi.advanceTimersByTimeAsync(200); });
      expect(apiFetch).not.toHaveBeenCalled();
    } finally { vi.useRealTimers(); }
  });
});
