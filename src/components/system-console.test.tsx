/** @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { AuditEvent, CriticalReadiness, DeadLetterMessage, ManagedSession } from "@cvg/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SystemConsole } from "./system-console";
import SystemPage from "../app/system/page";
import * as apiClient from "./api-client";

vi.mock("next/link", () => ({ default: ({ children, ...props }: { children: React.ReactNode; href: string }) => <a {...props}>{children}</a> }));
vi.mock("./app-shell", () => ({ AppShell: ({ children }: { children: React.ReactNode }) => <main>{children}</main> }));

const session: ManagedSession = { id: "session-vet", userId: "user-vet", userDisplayName: "Dra. Marina Costa", userEmail: "vet@cvg.local", userRole: "VETERINARIAN", departmentCode: "INPATIENT", createdAt: "2026-10-03T00:00:00.000Z", expiresAt: "2026-10-03T08:00:00.000Z", status: "ACTIVE", current: false };
const message: DeadLetterMessage = { id: "outbox-1", eventType: "ResultReleased", aggregateType: "Result", aggregateId: "result-1", status: "FAILED", attempts: 5, availableAt: "2026-10-03T00:00:00.000Z", correlationId: "corr-1", lastError: "sink unavailable" };
const audit: AuditEvent = { id: "audit-1", eventType: "UserRoleUpdated", entityType: "USER", entityId: "user-vet", occurredAt: "2026-10-03T00:00:00Z", newState: "ACTIVE", metadata: {} };
const readiness: CriticalReadiness = { asOf: "2026-10-10T00:00:00.000Z", policy: { status: "ACTIVE", version: "v1", approvalRef: "ATA-3" }, redundantChannel: { status: "IN_APP_ONLY_ACCEPTED", approvalRef: "ATA-3" }, onCall: { departments: [{ departmentCode: "INPATIENT", requesters: 2, onCall: 1 }], departmentsWithoutOnCall: [], total: 1 }, administrators: 1, ready: true };
type Responder = (path: string, init?: RequestInit) => unknown;
function mockApi(role = "ADMIN", respond?: Responder) {
  let currentSession = session;
  let currentMessage = message;
  return vi.spyOn(apiClient, "apiFetch").mockImplementation(async <T,>(path: string, init?: RequestInit): Promise<T> => {
    const custom = respond?.(path, init);
    if (custom !== undefined) return await custom as T;
    if (path === "/session/me") return { user: { role } } as T;
    if (path === "/sessions") return [currentSession] as T;
    if (path === "/outbox/dead-letters") return [currentMessage] as T;
    if (path === "/audit-events?limit=20") return [audit] as T;
    if (path === "/critical-results/readiness") return readiness as T;
    if (path === "/sessions/session-vet/revoke") { currentSession = { ...currentSession, status: "REVOKED" }; return currentSession as T; }
    if (path === "/outbox/dead-letters/outbox-1/reprocess") { currentMessage = { ...currentMessage, status: "PENDING" }; return { message: currentMessage, action: "REPROCESSED" } as T; }
    if (path === "/outbox/dead-letters/outbox-1/discard") { currentMessage = { ...currentMessage, status: "DISCARDED" }; return { message: currentMessage, action: "DISCARDED" } as T; }
    throw new Error(`Unexpected request: ${path}`);
  });
}

async function answerConfirm(name: string) {
  const dialog = await screen.findByRole("dialog");
  fireEvent.click(within(dialog).getByRole("button", { name }));
}

describe("SystemConsole", () => {
  afterEach(() => { cleanup(); vi.restoreAllMocks(); });

  it.each(["MANAGER", "VETERINARIAN", "VET", "VIEWER"])("denies %s before fetching technical data", async (role) => {
    const mock = mockApi(role); render(<SystemConsole />);
    expect(await screen.findByRole("alert")).toHaveTextContent("Somente o perfil ADMIN");
    expect(mock.mock.calls.map(([path]) => path)).toEqual(["/session/me"]);
    expect(screen.queryByRole("button", { name: "Revogar sessão" })).not.toBeInTheDocument();
  });

  it("opens the dedicated route and revokes a session with a simple confirmation and empty body", async () => {
    const mock = mockApi();
    render(<SystemPage />);
    expect(await screen.findByRole("heading", { name: "Sistema" })).toBeInTheDocument();
    expect(mock.mock.calls[0][0]).toBe("/session/me");
    expect(screen.getByText("User Role Updated")).toBeInTheDocument();
    expect(screen.queryByLabelText(/Senha|Motivo/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Revogar sessão" }));
    await answerConfirm("Revogar");
    await screen.findByText("Revogada");
    expect(mock).toHaveBeenCalledWith("/sessions/session-vet/revoke", { method: "POST", body: "{}" });
    expect(mock.mock.calls.some(([path]) => path === "/session/reauth")).toBe(false);
  });

  it.each(["Reprocessar", "Descartar"])("performs %s without password or reason", async (label) => {
    const mock = mockApi();
    render(<SystemConsole />); await screen.findByText(session.userDisplayName);
    fireEvent.click(screen.getByRole("button", { name: label }));
    await answerConfirm(label);
    await screen.findByText(label === "Reprocessar" ? "Em processamento" : "Descartada");
    expect(mock).toHaveBeenCalledWith(`/outbox/dead-letters/outbox-1/${label === "Reprocessar" ? "reprocess" : "discard"}`, { method: "POST", body: "{}" });
    expect(mock.mock.calls.some(([path]) => path === "/session/reauth")).toBe(false);
  });

  it("does not mutate when a simple confirmation is canceled", async () => {
    const mock = mockApi();
    render(<SystemConsole />); await screen.findByText(session.userDisplayName);
    for (const label of ["Revogar sessão", "Reprocessar", "Descartar"]) {
      fireEvent.click(screen.getByRole("button", { name: label }));
      await answerConfirm("Cancelar");
      await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    }
    expect(mock.mock.calls.some(([, init]) => init?.method === "POST")).toBe(false);
  });

  it("keeps current, revoked and expired sessions non-actionable", async () => {
    mockApi("ADMIN", (path) => path === "/sessions" ? [{ ...session, current: true }, { ...session, id: "revoked", status: "REVOKED" }, { ...session, id: "expired", status: "EXPIRED" }] : undefined);
    render(<SystemConsole />); await screen.findByText("Sessão atual: use sair para encerrá-la.");
    expect(screen.getByText("Revogada")).toBeInTheDocument();
    expect(screen.getByText("Expirada")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Revogar sessão" })).not.toBeInTheDocument();
  });

  it("shows empty states and can recover from partial resource failures", async () => {
    let fail = true;
    mockApi("ADMIN", (path) => {
      if (path === "/sessions") return fail ? Promise.reject(new Error("Offline")) : [];
      if (path === "/outbox/dead-letters" || path === "/audit-events?limit=20") return [];
    });
    render(<SystemConsole />);
    expect(await screen.findByRole("alert")).toHaveTextContent("Parte dos dados do sistema está indisponível");
    expect(screen.getByText("Nenhuma mensagem retida")).toBeInTheDocument();
    expect(screen.getByText("Nenhum evento recente")).toBeInTheDocument();
    fail = false; fireEvent.click(screen.getByRole("button", { name: "Atualizar" }));
    await screen.findByText("Nenhuma sessão no escopo");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("clears technical data if the identity loses ADMIN on refresh", async () => {
    let role = "ADMIN";
    const mock = mockApi("ADMIN", (path) => path === "/session/me" ? { user: { role } } : undefined);
    render(<SystemConsole />); await screen.findByText(session.userDisplayName);
    const callsBefore = mock.mock.calls.length;
    role = "MANAGER"; fireEvent.click(screen.getByRole("button", { name: "Atualizar" }));
    await screen.findByRole("alert");
    expect(screen.queryByText(session.userDisplayName)).not.toBeInTheDocument();
    expect(mock.mock.calls.slice(callsBefore).map(([path]) => path)).toEqual(["/session/me"]);
  });

  it("handles identity and server permission failures without exposing actions", async () => {
    const mock = mockApi("ADMIN", (path) => path === "/session/me" ? Promise.reject(new apiClient.ApiClientError(403, { error: { code: "SCOPE_DENIED" } })) : undefined);
    render(<SystemConsole />); await screen.findByRole("alert");
    expect(mock.mock.calls.map(([path]) => path)).toEqual(["/session/me"]);
    cleanup(); vi.restoreAllMocks();
    mockApi("ADMIN", (path) => path === "/sessions" ? Promise.reject(new apiClient.ApiClientError(403, { error: { code: "SCOPE_DENIED" } })) : undefined);
    render(<SystemConsole />);
    expect(await screen.findByRole("alert")).toHaveTextContent("Somente o perfil ADMIN");
    expect(screen.queryByText(message.eventType)).not.toBeInTheDocument();
  });

  it("reports failed mutations and suppresses repeat submissions while pending", async () => {
    let rejectRequest: ((reason: Error) => void) | undefined;
    const pending = new Promise((_, reject) => { rejectRequest = reject; });
    const mock = mockApi("ADMIN", (path, init) => init?.method === "POST" && path.startsWith("/sessions/") ? pending : undefined);
    render(<SystemConsole />); await screen.findByText(session.userDisplayName);
    const revoke = screen.getByRole("button", { name: "Revogar sessão" });
    fireEvent.click(revoke); fireEvent.click(revoke);
    await answerConfirm("Revogar");
    expect(mock.mock.calls.filter(([path]) => path === "/sessions/session-vet/revoke")).toHaveLength(1);
    rejectRequest!(new Error("Offline"));
    expect(await screen.findByRole("alert")).toHaveTextContent("Não foi possível revogar a sessão");
    expect(screen.getByRole("button", { name: "Revogar sessão" })).toBeEnabled();
  });

  it("labels in-flight and discarded dead letters and offers no action on them", async () => {
    mockApi("ADMIN", (path) => path === "/outbox/dead-letters" ? [
      { ...message, id: "outbox-pending", status: "PENDING" },
      { ...message, id: "outbox-discarded", status: "DISCARDED", lastError: "SINK_DOWN" }
    ] : undefined);
    render(<SystemConsole />); await screen.findByText("Em processamento");
    expect(screen.getByText("Descartada")).toBeInTheDocument();
    expect(screen.getByText("Falha: SINK_DOWN")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Reprocessar" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Descartar" })).not.toBeInTheDocument();
  });

  it("shows an empty audit trail and an empty dead-letter list without actions", async () => {
    mockApi("ADMIN", (path) => path === "/audit-events?limit=20" || path === "/outbox/dead-letters" ? [] : undefined);
    render(<SystemConsole />);
    expect(await screen.findByText("Nenhum evento recente")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Reprocessar" })).not.toBeInTheDocument();
  });

  function deferred<T>() {
    let resolve!: (value: T) => void; let reject!: (reason: unknown) => void;
    const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
    return { promise, resolve, reject };
  }

  it("ignores a load that finishes after the console was closed", async () => {
    const identity = deferred<unknown>();
    mockApi("ADMIN", (path) => path === "/session/me" ? identity.promise : undefined);
    const { unmount } = render(<SystemConsole />);
    await waitFor(() => expect(apiClient.apiFetch).toHaveBeenCalledWith("/session/me"));
    unmount();
    identity.resolve({ user: { role: "ADMIN" } });
    await Promise.resolve();
    expect(apiClient.apiFetch).not.toHaveBeenCalledWith("/sessions");
  });

  it("ignores identity failures and list results that arrive after the console was closed", async () => {
    const failing = deferred<unknown>();
    mockApi("ADMIN", (path) => path === "/session/me" ? failing.promise : undefined);
    const first = render(<SystemConsole />);
    await waitFor(() => expect(apiClient.apiFetch).toHaveBeenCalledWith("/session/me"));
    first.unmount();
    failing.reject(new Error("late failure"));
    await Promise.resolve();
    cleanup(); vi.restoreAllMocks();

    const sessions = deferred<unknown>();
    const mock = mockApi("ADMIN", (path) => path === "/sessions" ? sessions.promise : undefined);
    const second = render(<SystemConsole />);
    await waitFor(() => expect(mock).toHaveBeenCalledWith("/sessions"));
    second.unmount();
    sessions.resolve([session]);
    await Promise.resolve();
    expect(screen.queryByText(session.userDisplayName)).not.toBeInTheDocument();
  });

  it("keeps the readable sections when the dead-letter and audit lists fail", async () => {
    mockApi("ADMIN", (path) => path === "/outbox/dead-letters" || path === "/audit-events?limit=20" ? Promise.reject(new Error("unavailable")) : undefined);
    render(<SystemConsole />);
    expect(await screen.findByText(session.userDisplayName)).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent("Parte dos dados do sistema está indisponível");
  });

  it("shows the busy state while a dead-letter action is in flight and the error when it fails", async () => {
    const action = deferred<unknown>();
    mockApi("ADMIN", (path, init) => path === "/outbox/dead-letters/outbox-1/reprocess" && init?.method === "POST" ? action.promise : undefined);
    render(<SystemConsole />); await screen.findByText(session.userDisplayName);
    fireEvent.click(screen.getByRole("button", { name: "Reprocessar" }));
    await answerConfirm("Reprocessar");
    await waitFor(() => expect(screen.getByRole("button", { name: "Reprocessar" })).toHaveAttribute("aria-busy", "true"));
    expect(screen.getByRole("button", { name: "Descartar" })).toBeDisabled();
    action.reject(new Error("sink down"));
    expect(await screen.findByRole("alert")).toHaveTextContent("Não foi possível operar a dead-letter");
  });

  it("shows the busy state while a session revocation is in flight", async () => {
    const revoke = deferred<unknown>();
    mockApi("ADMIN", (path, init) => path === "/sessions/session-vet/revoke" && init?.method === "POST" ? revoke.promise : undefined);
    render(<SystemConsole />); await screen.findByText(session.userDisplayName);
    fireEvent.click(screen.getByRole("button", { name: "Revogar sessão" }));
    await answerConfirm("Revogar");
    await waitFor(() => expect(screen.getByRole("button", { name: "Revogar sessão" })).toHaveAttribute("aria-busy", "true"));
    revoke.reject(new Error("offline"));
    await screen.findByRole("alert");
  });

  it("falls back to a neutral label for an audit event without a new state", async () => {
    mockApi("ADMIN", (path) => path === "/audit-events?limit=20" ? [{ ...audit, newState: undefined }] : undefined);
    render(<SystemConsole />);
    expect(await screen.findByText("registrado")).toBeInTheDocument();
  });

  it("shows the critical-result readiness and names the departments without anyone on call", async () => {
    mockApi("ADMIN", (path) => path === "/critical-results/readiness"
      ? { ...readiness, ready: false, policy: { status: "OFF" }, redundantChannel: { status: "MISSING" }, onCall: { departments: [{ departmentCode: "INPATIENT", requesters: 2, onCall: 0 }], departmentsWithoutOnCall: ["INPATIENT"], total: 0 }, administrators: 0 }
      : undefined);
    render(<SystemConsole />);
    const panel = (await screen.findByRole("heading", { name: "Resultado crítico" })).closest("section")!;
    expect(panel).toHaveTextContent("Pendente");
    expect(panel).toHaveTextContent("Política desligada");
    expect(panel).toHaveTextContent("Sem canal redundante nem aceite registrado");
    expect(panel).toHaveTextContent("Ninguém de plantão");
    expect(panel).toHaveTextContent("Sem plantonista próprio (a escada cai na reserva de todo o hospital): INPATIENT");
    expect(panel).toHaveTextContent("Nenhum administrador ativo");
  });

  it("shows a ready critical-result flow and an empty state when readiness cannot be read", async () => {
    mockApi();
    render(<SystemConsole />);
    const panel = (await screen.findByRole("heading", { name: "Resultado crítico" })).closest("section")!;
    expect(panel).toHaveTextContent("Pronto");
    expect(panel).toHaveTextContent("versão v1 · aprovação ATA-3");
    expect(panel).toHaveTextContent("Só no Hub, aceito pelo hospital");
    expect(panel).toHaveTextContent("1 de plantão");
    cleanup(); vi.restoreAllMocks();
    mockApi("ADMIN", (path) => path === "/critical-results/readiness" ? Promise.reject(new Error("down")) : undefined);
    render(<SystemConsole />);
    expect(await screen.findByText("Prontidão indisponível")).toBeInTheDocument();
  });
});
