/** @vitest-environment jsdom */
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { WorkActivityPreferenceView } from "@cvg/contracts";
import { WorkActivityControls } from "./work-activity-controls";
import { apiFetch, ApiClientError } from "./api-client";
import { hospitalUser } from "./hospital-ui.test-helpers";

vi.mock("./api-client", async original => ({ ...await original<typeof import("./api-client")>(), apiFetch: vi.fn() }));
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.clearAllMocks(); });

const user = { ...hospitalUser, permissions: [...hospitalUser.permissions!, "work_activity.preference.manage" as const] };
function fixture() {
  let current: WorkActivityPreferenceView = { preference: { id: "race-preference", userId: user.id, targetType: "HOSPITAL_TASK", targetId: "race-task", favorite: false, following: false, hiddenFromRecents: false, privateNote: "Nota já salva", favoriteGroup: "Grupo salvo", version: 4, createdAt: "2026-10-11T12:00:00Z", updatedAt: "2026-10-11T12:00:00Z" }, target: { targetType: "HOSPITAL_TASK", targetId: "race-task", label: "Alvo sintético autorizado", deepLink: "/planner/tasks/race-task" } };
  let defer = false, denied = false, delayWrites = false;
  const pending: Array<{ resolve: (data: { items: WorkActivityPreferenceView[] }) => void; reject: (error: Error) => void }> = [];
  const pendingWrites: Array<() => void> = [];
  const mock = vi.mocked(apiFetch).mockImplementation(async (_path, init) => {
    if (!init?.method) {
      if (denied) throw new ApiClientError(404, { error: { code: "SCOPE_DENIED" } });
      if (defer) return new Promise<{ items: WorkActivityPreferenceView[] }>((resolve, reject) => pending.push({ resolve, reject })) as never;
      return { items: [structuredClone(current)] } as never;
    }
    const { expectedVersion, targetType: _type, targetId: _id, opened, ...fields } = JSON.parse(String(init.body));
    if (expectedVersion !== current.preference.version) throw new ApiClientError(409, { error: { code: "STALE_VERSION" } });
    current = { ...current, preference: { ...current.preference, ...fields, ...(opened ? { lastOpenedAt: "2026-10-11T12:10:00Z" } : {}), version: current.preference.version + 1 } };
    const response = structuredClone(current);
    if (delayWrites) return new Promise<WorkActivityPreferenceView>(resolve => pendingWrites.push(() => resolve(response))) as never;
    return response as never;
  });
  const renderEditor = () => render(<WorkActivityControls user={user} targetType="HOSPITAL_TASK" targetId="race-task" />);
  const completeWrites = () => { delayWrites = false; for (const complete of pendingWrites.splice(0)) complete(); };
  return { mock, renderEditor, current: () => current, deferReads: () => { defer = true; }, deferWrites: () => { delayWrites = true; }, completeWrites, deny: () => { denied = true; }, pending, pendingWrites, remote: () => { current = { ...current, preference: { ...current.preference, privateNote: "Nota de outra aba", favoriteGroup: "Grupo de outra aba", version: current.preference.version + 1 } }; }, resolve: async () => { defer = false; await act(async () => { for (const complete of pending.splice(0)) complete.resolve({ items: [structuredClone(current)] }); }); }, rejectRead: async (status: number) => { defer = false; await act(async () => { for (const complete of pending.splice(0)) complete.reject(new ApiClientError(status, { error: { code: status === 503 ? "STORAGE_UNAVAILABLE" : "SCOPE_DENIED" } })); }); }, resolveWrites: async () => { await act(async () => completeWrites()); } };
}

describe("private preference editor command/reload races", () => {
  it("applies its successful command DTO immediately and preserves unsaved note/group through a delayed post-command read", async () => {
    const f = fixture(); f.renderEditor(); await screen.findByLabelText("Sua nota privada");
    expect(f.current().preference.version).toBe(5); // automatic explicit-open command
    fireEvent.change(screen.getByLabelText("Sua nota privada"), { target: { value: "Minha nota recém-digitada" } });
    fireEvent.change(screen.getByLabelText("Grupo pessoal do favorito"), { target: { value: "Meu grupo ainda não salvo" } });
    f.deferReads(); fireEvent.click(screen.getByRole("button", { name: "Registrar nos meus recentes" }));
    await screen.findByText("Preferência privada salva.");
    act(() => window.dispatchEvent(new Event("cvg:realtime-updated")));
    await waitFor(() => expect(f.pending.length).toBeGreaterThan(0));
    await f.resolve();
    expect(screen.getByLabelText("Sua nota privada")).toHaveValue("Minha nota recém-digitada");
    expect(screen.getByLabelText("Grupo pessoal do favorito")).toHaveValue("Meu grupo ainda não salvo");
    fireEvent.submit(screen.getByRole("form", { name: "Nota privada" }));
    await waitFor(() => expect(f.current().preference.privateNote).toBe("Minha nota recém-digitada"));
    const writes = f.mock.mock.calls.filter(([, init]) => init?.method);
    expect(JSON.parse(String(writes.at(-1)![1]!.body))).toMatchObject({ privateNote: "Minha nota recém-digitada", expectedVersion: 6 });
    expect(f.current().preference.version).toBe(7);
  });

  it("blocks editing during a current read without unmounting private buffers or letting a stale base command escape", async () => {
    const f = fixture(); f.renderEditor(); await screen.findByLabelText("Sua nota privada");
    fireEvent.change(screen.getByLabelText("Sua nota privada"), { target: { value: "Buffer privado em leitura" } });
    const writes = f.mock.mock.calls.filter(([, init]) => init?.method).length;
    f.deferReads(); act(() => window.dispatchEvent(new Event("cvg:realtime-resync")));
    await waitFor(() => expect(f.pending.length).toBe(1));
    expect(screen.getByLabelText("Sua nota privada")).toBeDisabled();
    expect(screen.getByLabelText("Sua nota privada")).toHaveValue("Buffer privado em leitura");
    expect(screen.getByRole("button", { name: "Salvar nota privada" })).toBeDisabled();
    fireEvent.submit(screen.getByRole("form", { name: "Nota privada" }));
    expect(f.mock.mock.calls.filter(([, init]) => init?.method)).toHaveLength(writes);
    await f.resolve();
    expect(screen.getByLabelText("Sua nota privada")).toBeEnabled();
    expect(screen.getByLabelText("Sua nota privada")).toHaveValue("Buffer privado em leitura");
  });

  it("preserves the original base and dirty content after an external version until explicit reconciliation", async () => {
    const f = fixture(); f.renderEditor(); await screen.findByLabelText("Sua nota privada");
    fireEvent.change(screen.getByLabelText("Sua nota privada"), { target: { value: "Meu texto local preservado" } });
    fireEvent.change(screen.getByLabelText("Grupo pessoal do favorito"), { target: { value: "Meu grupo local preservado" } });
    f.remote(); act(() => window.dispatchEvent(new Event("cvg:realtime-updated")));
    const reconcile = await screen.findByRole("button", { name: "Recarregar preferências e descartar meu texto" });
    expect(screen.getByLabelText("Sua nota privada")).toHaveValue("Meu texto local preservado");
    expect(screen.getByLabelText("Grupo pessoal do favorito")).toHaveValue("Meu grupo local preservado");
    expect(screen.getByRole("button", { name: "Salvar nota privada" })).toBeDisabled();
    const writes = f.mock.mock.calls.filter(([, init]) => init?.method).length;
    fireEvent.submit(screen.getByRole("form", { name: "Nota privada" }));
    expect(f.mock.mock.calls.filter(([, init]) => init?.method)).toHaveLength(writes);
    fireEvent.click(reconcile);
    expect(screen.getByLabelText("Sua nota privada")).toHaveValue("Nota de outra aba");
    expect(screen.getByLabelText("Grupo pessoal do favorito")).toHaveValue("Grupo de outra aba");
    fireEvent.change(screen.getByLabelText("Sua nota privada"), { target: { value: "Texto reconciliado" } });
    fireEvent.submit(screen.getByRole("form", { name: "Nota privada" }));
    await waitFor(() => expect(f.current().preference.privateNote).toBe("Texto reconciliado"));
    expect(f.current().preference.version).toBe(7);
  });

  it("removes buffered private content and controls on a current target denial", async () => {
    const f = fixture(); f.renderEditor(); await screen.findByLabelText("Sua nota privada");
    fireEvent.change(screen.getByLabelText("Sua nota privada"), { target: { value: "Buffer retirado do acesso" } });
    f.deny(); act(() => window.dispatchEvent(new Event("cvg:realtime-updated")));
    await screen.findByRole("alert");
    expect(screen.queryByLabelText("Sua nota privada")).not.toBeInTheDocument();
    expect(screen.queryByText("Buffer retirado do acesso")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Salvar nota privada" })).not.toBeInTheDocument();
    expect(f.current().preference.privateNote).toBe("Nota já salva");
  });

  it.each(["denied-first", "command-first"] as const)("never resurrects private content or cancels current authorization when a late committed command overlaps the read (%s)", async order => {
    const f = fixture(); f.renderEditor(); await screen.findByLabelText("Sua nota privada");
    fireEvent.change(screen.getByLabelText("Sua nota privada"), { target: { value: "Resposta privada atrasada" } });
    f.deferWrites(); fireEvent.submit(screen.getByRole("form", { name: "Nota privada" }));
    await waitFor(() => expect(f.pendingWrites.length).toBe(1));
    f.deferReads(); act(() => window.dispatchEvent(new Event("cvg:realtime-resync")));
    await waitFor(() => expect(f.pending.length).toBe(1));
    if (order === "command-first") {
      await f.resolveWrites();
      expect(screen.getByLabelText("Sua nota privada")).toBeDisabled();
      await f.rejectRead(404);
    } else {
      await f.rejectRead(404);
      await screen.findByRole("alert");
      await f.resolveWrites();
    }
    await screen.findByRole("alert");
    expect(screen.queryByLabelText("Sua nota privada")).not.toBeInTheDocument();
    expect(screen.queryByText("Resposta privada atrasada")).not.toBeInTheDocument();
    expect(screen.queryByText("Preferência privada salva.")).not.toBeInTheDocument();
    // The authorized command committed before revocation; its delayed reply
    // cannot reopen the now-forbidden editor or replace the later read result.
    expect(f.current().preference.privateNote).toBe("Resposta privada atrasada");
  });

  it("retains the native stale-version error and its private buffer until the current version is explicitly reconciled", async () => {
    const f = fixture(); f.renderEditor(); await screen.findByLabelText("Sua nota privada");
    fireEvent.change(screen.getByLabelText("Sua nota privada"), { target: { value: "Texto que não pode sobrescrever outra aba" } });
    f.remote(); fireEvent.submit(screen.getByRole("form", { name: "Nota privada" }));
    await screen.findByRole("alert");
    expect(screen.getByLabelText("Sua nota privada")).toHaveValue("Texto que não pode sobrescrever outra aba");
    expect(f.current().preference.privateNote).toBe("Nota de outra aba");
    expect(JSON.parse(String(f.mock.mock.calls.filter(([, init]) => init?.method).at(-1)![1]!.body))).toMatchObject({ expectedVersion: 5, privateNote: "Texto que não pode sobrescrever outra aba" });
    act(() => window.dispatchEvent(new Event("cvg:realtime-updated")));
    fireEvent.click(await screen.findByRole("button", { name: "Recarregar preferências e descartar meu texto" }));
    fireEvent.change(screen.getByLabelText("Sua nota privada"), { target: { value: "Revisão após reconciliação" } });
    fireEvent.submit(screen.getByRole("form", { name: "Nota privada" }));
    await waitFor(() => expect(f.current().preference.privateNote).toBe("Revisão após reconciliação"));
    expect(f.current().preference.version).toBe(7);
  });

  it("keeps a transient read failure visible without erasing unsaved buffers and retries the same current preference", async () => {
    const f = fixture(); f.renderEditor(); await screen.findByLabelText("Sua nota privada");
    fireEvent.change(screen.getByLabelText("Sua nota privada"), { target: { value: "Nota local após falha transitória" } });
    f.deferReads(); act(() => window.dispatchEvent(new Event("cvg:realtime-resync")));
    await waitFor(() => expect(f.pending.length).toBe(1)); await f.rejectRead(503);
    await screen.findByRole("alert");
    expect(screen.getByLabelText("Sua nota privada")).toBeDisabled();
    expect(screen.getByLabelText("Sua nota privada")).toHaveValue("Nota local após falha transitória");
    fireEvent.click(screen.getByRole("button", { name: "Recarregar preferências privadas" }));
    await waitFor(() => expect(screen.getByLabelText("Sua nota privada")).toBeEnabled());
    expect(screen.getByLabelText("Sua nota privada")).toHaveValue("Nota local após falha transitória");
  });

  it("discards an earlier identity's deferred command response rather than putting its private note into the next editor", async () => {
    const f = fixture(); const ui = f.renderEditor(); await screen.findByLabelText("Sua nota privada");
    fireEvent.change(screen.getByLabelText("Sua nota privada"), { target: { value: "Nota de identidade anterior" } });
    f.deferWrites(); fireEvent.submit(screen.getByRole("form", { name: "Nota privada" }));
    await waitFor(() => expect(f.pendingWrites.length).toBe(1));
    ui.rerender(<WorkActivityControls user={{ ...user, id: "other-account", permissions: [] }} targetType="HOSPITAL_TASK" targetId="another-task" />);
    await f.resolveWrites();
    expect(screen.queryByLabelText("Sua nota privada")).not.toBeInTheDocument();
    expect(screen.queryByText("Nota de identidade anterior")).not.toBeInTheDocument();
    expect(screen.queryByText("Preferência privada salva.")).not.toBeInTheDocument();
  });

  it("keeps a read-only preference visible without registering an opening or emitting a mutation", async () => {
    const f = fixture(); render(<WorkActivityControls user={user} targetType="HOSPITAL_TASK" targetId="race-task" readOnly />);
    await screen.findByLabelText("Sua nota privada");
    expect(screen.getByLabelText("Sua nota privada")).toBeDisabled();
    fireEvent.submit(screen.getByRole("form", { name: "Nota privada" }));
    expect(f.mock.mock.calls.every(([, init]) => !init?.method)).toBe(true);
    expect(f.current().preference.version).toBe(4);
  });

  it.each(["opening", "editor"] as const)("preserves the authorization read when a %s command resolves in the same tick before React effects commit", async stage => {
    const f = fixture();
    if (stage === "opening") f.deferWrites();
    f.renderEditor();
    if (stage === "editor") {
      await screen.findByLabelText("Sua nota privada");
      fireEvent.change(screen.getByLabelText("Sua nota privada"), { target: { value: "Texto privado da mesma rodada" } });
      f.deferWrites(); fireEvent.submit(screen.getByRole("form", { name: "Nota privada" }));
    }
    await waitFor(() => expect(f.pendingWrites.length).toBe(1));
    f.deferReads();
    await act(async () => {
      window.dispatchEvent(new Event("cvg:realtime-resync"));
      f.completeWrites();
    });
    expect(f.pending).toHaveLength(1);
    await f.rejectRead(404);
    await screen.findByRole("alert");
    expect(screen.queryByLabelText("Sua nota privada")).not.toBeInTheDocument();
    expect(screen.queryByText("Texto privado da mesma rodada")).not.toBeInTheDocument();
    expect(screen.queryByText("Preferência privada salva.")).not.toBeInTheDocument();
  });
});
