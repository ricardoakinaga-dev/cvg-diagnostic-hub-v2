/** @vitest-environment jsdom */
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { WorkActivityPreferenceView } from "@cvg/contracts";
import { apiFetch, ApiClientError } from "./api-client";
import { hospitalUser } from "./hospital-ui.test-helpers";
import { WorkActivityControls } from "./work-activity-controls";

vi.mock("./api-client", async original => ({ ...await original<typeof import("./api-client")>(), apiFetch: vi.fn() }));
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.clearAllMocks(); });

const user = { ...hospitalUser, permissions: [...hospitalUser.permissions!, "work_activity.preference.manage" as const] };
function openingFixture(version: number) {
  let current: WorkActivityPreferenceView = {
    preference: { id: "opening-preference", userId: user.id, targetType: "HOSPITAL_TASK", targetId: "opening-task", favorite: false, following: false, hiddenFromRecents: false, privateNote: "Nota pessoal salva", favoriteGroup: "Grupo pessoal", version, createdAt: "2026-10-11T12:00:00Z", updatedAt: "2026-10-11T12:00:00Z" },
    target: { targetType: "HOSPITAL_TASK", targetId: "opening-task", label: "Atividade sintética autorizada", deepLink: "/planner/tasks/opening-task" },
  };
  let delayRead = false;
  let delayCommand = false;
  let completeOpening: (() => void) | undefined;
  let completeCommand: (() => void) | undefined;
  let completeRead: ((data: { items: WorkActivityPreferenceView[] }) => void) | undefined;
  let rejectRead: ((cause: Error) => void) | undefined;
  const mock = vi.mocked(apiFetch).mockImplementation(async (_path, init) => {
    if (!init?.method) {
      if (delayRead) return new Promise<{ items: WorkActivityPreferenceView[] }>((resolve, reject) => { completeRead = resolve; rejectRead = reject; }) as never;
      return { items: current.preference.version ? [structuredClone(current)] : [] } as never;
    }
    const { expectedVersion, targetType: _type, targetId: _id, opened, ...fields } = JSON.parse(String(init.body));
    if (expectedVersion !== current.preference.version) throw new ApiClientError(409, { error: { code: "STALE_VERSION" } });
    current = { ...current, preference: { ...current.preference, ...fields, ...(opened ? { lastOpenedAt: "2026-10-11T12:10:00Z" } : {}), version: current.preference.version + 1 } };
    const response = structuredClone(current);
    if (opened) return new Promise<WorkActivityPreferenceView>(resolve => { completeOpening = () => resolve(response); }) as never;
    if (delayCommand) return new Promise<WorkActivityPreferenceView>(resolve => { completeCommand = () => resolve(response); }) as never;
    return response as never;
  });
  const ui = render(<WorkActivityControls user={user} targetType="HOSPITAL_TASK" targetId="opening-task" />);
  return {
    mock, ui, current: () => current,
    overlap: async (finishOpening = true) => {
      await waitFor(() => expect(completeOpening).toBeDefined());
      delayRead = true;
      act(() => window.dispatchEvent(new Event("cvg:realtime-resync")));
      await waitFor(() => expect(completeRead).toBeDefined());
      if (finishOpening) await act(async () => { completeOpening!(); });
    },
    finishOpening: async () => { await act(async () => { completeOpening!(); }); },
    delayCommands: () => { delayCommand = true; },
    finishCommand: async () => { delayCommand = false; await act(async () => { completeCommand!(); }); },
    finishRead: async (snapshot = structuredClone(current)) => { delayRead = false; await act(async () => { completeRead!({ items: [snapshot] }); }); },
    denyRead: async (status: number) => { delayRead = false; await act(async () => { rejectRead!(new ApiClientError(status, { error: { code: "SCOPE_DENIED" } })); }); },
    remote: () => { current = { ...current, preference: { ...current.preference, privateNote: "Nota de outra aba", version: current.preference.version + 1 } }; },
  };
}

describe("automatic private recent opening overlaps its own realtime read", () => {
  it.each([0, 4])("uses its committed opening version as the initial editor base instead of reporting an external conflict (initial version %s)", async version => {
    const f = openingFixture(version);
    await f.overlap();
    expect(screen.getByRole("button", { name: "Adicionar aos favoritos" })).toBeDisabled();
    expect(f.mock.mock.calls.filter(([, init]) => init?.method)).toHaveLength(1);
    await f.finishRead();
    expect(screen.queryByText(/Outra alteração mudou estas preferências/)).not.toBeInTheDocument();
    const favorite = screen.getByRole("button", { name: "Adicionar aos favoritos" });
    expect(favorite).toBeEnabled();
    fireEvent.click(favorite);
    await screen.findByRole("button", { name: "Remover dos favoritos" });
    expect(JSON.parse(String(f.mock.mock.calls.filter(([, init]) => init?.method).at(-1)![1]!.body))).toMatchObject({ expectedVersion: version + 1, favorite: true });
    expect(f.current().preference.version).toBe(version + 2);
  });

  it("does not accept an older concurrent read as the base of its next command or erase a later unsaved note", async () => {
    const f = openingFixture(4); const earlier = structuredClone(f.current());
    await f.overlap(); await f.finishRead(earlier);
    fireEvent.change(screen.getByLabelText("Sua nota privada"), { target: { value: "Meu texto depois da abertura" } });
    act(() => window.dispatchEvent(new Event("cvg:realtime-updated")));
    await waitFor(() => expect(screen.getByLabelText("Sua nota privada")).toBeEnabled());
    expect(screen.getByLabelText("Sua nota privada")).toHaveValue("Meu texto depois da abertura");
    fireEvent.submit(screen.getByRole("form", { name: "Nota privada" }));
    await waitFor(() => expect(f.current().preference.privateNote).toBe("Meu texto depois da abertura"));
    expect(JSON.parse(String(f.mock.mock.calls.filter(([, init]) => init?.method).at(-1)![1]!.body))).toMatchObject({ expectedVersion: 5 });
  });

  it.each([401, 403, 404])("keeps the pending authorization read authoritative after its opening response, including denial %s", async status => {
    const f = openingFixture(4); await f.overlap(); await f.denyRead(status);
    await screen.findByRole("alert");
    expect(screen.queryByLabelText("Sua nota privada")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Adicionar aos favoritos" })).not.toBeInTheDocument();
    expect(f.mock.mock.calls.filter(([, init]) => init?.method)).toHaveLength(1);
  });

  it("still requires explicit reconciliation for a genuinely external write after opening without losing local text", async () => {
    const f = openingFixture(4); await f.overlap(); await f.finishRead();
    expect(screen.getByLabelText("Sua nota privada")).toBeEnabled();
    fireEvent.change(screen.getByLabelText("Sua nota privada"), { target: { value: "Meu texto local" } });
    f.remote(); act(() => window.dispatchEvent(new Event("cvg:realtime-updated")));
    await screen.findByText(/Outra alteração mudou estas preferências/);
    expect(screen.getByLabelText("Sua nota privada")).toHaveValue("Meu texto local");
    expect(screen.getByRole("button", { name: "Salvar nota privada" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Recarregar preferências e descartar meu texto" }));
    expect(screen.getByLabelText("Sua nota privada")).toHaveValue("Nota de outra aba");
    expect(screen.getByLabelText("Sua nota privada")).toBeEnabled();
  });

  it("keeps an external version detected by a completed authorization read instead of overwriting it with a late opening response", async () => {
    const f = openingFixture(4); await f.overlap(false);
    f.remote(); await f.finishRead(); await f.finishOpening();
    await screen.findByText(/Outra alteração mudou estas preferências/);
    expect(screen.getByRole("button", { name: "Adicionar aos favoritos" })).toBeDisabled();
    expect(screen.getByLabelText("Sua nota privada")).toHaveValue("Nota pessoal salva");
    fireEvent.click(screen.getByRole("button", { name: "Recarregar preferências e descartar meu texto" }));
    expect(screen.getByLabelText("Sua nota privada")).toHaveValue("Nota de outra aba");
    fireEvent.submit(screen.getByRole("form", { name: "Nota privada" }));
    await waitFor(() => expect(f.current().preference.version).toBe(7));
    expect(JSON.parse(String(f.mock.mock.calls.filter(([, init]) => init?.method).at(-1)![1]!.body))).toMatchObject({ expectedVersion: 6 });
  });

  it("preserves a newer external read and local text when an older committed favorite response arrives later", async () => {
    const f = openingFixture(4); await f.overlap(); await f.finishRead();
    fireEvent.change(screen.getByLabelText("Sua nota privada"), { target: { value: "Texto local enquanto salvo favorito" } });
    f.delayCommands(); fireEvent.click(screen.getByRole("button", { name: "Adicionar aos favoritos" }));
    await waitFor(() => expect(f.current().preference.version).toBe(6));
    f.remote(); act(() => window.dispatchEvent(new Event("cvg:realtime-updated")));
    await screen.findByText(/Outra alteração mudou estas preferências/);
    await f.finishCommand();
    expect(screen.getByText(/Outra alteração mudou estas preferências/)).toBeInTheDocument();
    expect(screen.getByLabelText("Sua nota privada")).toHaveValue("Texto local enquanto salvo favorito");
    expect(screen.getByRole("button", { name: "Salvar nota privada" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Recarregar preferências e descartar meu texto" }));
    expect(screen.getByLabelText("Sua nota privada")).toHaveValue("Nota de outra aba");
    fireEvent.submit(screen.getByRole("form", { name: "Nota privada" }));
    await waitFor(() => expect(f.current().preference.version).toBe(8));
    expect(JSON.parse(String(f.mock.mock.calls.filter(([, init]) => init?.method).at(-1)![1]!.body))).toMatchObject({ expectedVersion: 7 });
  });
});
