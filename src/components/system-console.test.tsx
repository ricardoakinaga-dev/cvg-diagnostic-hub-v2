/** @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { AuditEvent, DeadLetterMessage, ManagedSession } from "@cvg/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SystemConsole } from "./system-console";
import SystemPage from "../app/system/page";
import * as apiClient from "./api-client";

vi.mock("next/link", () => ({ default: ({ children, ...props }: { children: React.ReactNode; href: string }) => <a {...props}>{children}</a> }));
vi.mock("./app-shell", () => ({ AppShell: ({ children }: { children: React.ReactNode }) => <main>{children}</main> }));

const session: ManagedSession = { id: "session-vet", userId: "user-vet", userDisplayName: "Dra. Marina Costa", userEmail: "vet@cvg.local", userRole: "VETERINARIAN", departmentCode: "INPATIENT", createdAt: "2026-10-03T00:00:00.000Z", expiresAt: "2026-10-03T08:00:00.000Z", status: "ACTIVE", current: false };
const message: DeadLetterMessage = { id: "outbox-1", eventType: "ResultReleased", aggregateType: "Result", aggregateId: "result-1", status: "FAILED", attempts: 5, availableAt: "2026-10-03T00:00:00.000Z", correlationId: "corr-1", lastError: "sink unavailable" };
const audit: AuditEvent = { id: "audit-1", eventType: "UserRoleUpdated", entityType: "USER", entityId: "user-vet", occurredAt: "2026-10-03T00:00:00Z", newState: "ACTIVE", metadata: {} };
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
    if (path === "/sessions/session-vet/revoke") { currentSession = { ...currentSession, status: "REVOKED" }; return currentSession as T; }
    if (path === "/outbox/dead-letters/outbox-1/reprocess") { currentMessage = { ...currentMessage, status: "PENDING" }; return { message: currentMessage, action: "REPROCESSED" } as T; }
    if (path === "/outbox/dead-letters/outbox-1/discard") { currentMessage = { ...currentMessage, status: "DISCARDED" }; return { message: currentMessage, action: "DISCARDED" } as T; }
    throw new Error(`Unexpected request: ${path}`);
  });
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
    const mock = mockApi(); const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    render(<SystemPage />);
    expect(await screen.findByRole("heading", { name: "Sistema" })).toBeInTheDocument();
    expect(mock.mock.calls[0][0]).toBe("/session/me");
    expect(screen.getByText("User Role Updated")).toBeInTheDocument();
    expect(screen.queryByLabelText(/Senha|Motivo/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Revogar sessão" }));
    await screen.findByText("Revogada");
    expect(confirm).toHaveBeenCalledOnce();
    expect(mock).toHaveBeenCalledWith("/sessions/session-vet/revoke", { method: "POST", body: "{}" });
    expect(mock.mock.calls.some(([path]) => path === "/session/reauth")).toBe(false);
  });

  it.each(["Reprocessar", "Descartar"])("performs %s without password or reason", async (label) => {
    const mock = mockApi(); vi.spyOn(window, "confirm").mockReturnValue(true);
    render(<SystemConsole />); await screen.findByText(session.userDisplayName);
    fireEvent.click(screen.getByRole("button", { name: label }));
    await screen.findByText(label === "Reprocessar" ? "Em processamento" : "Descartada");
    expect(mock).toHaveBeenCalledWith(`/outbox/dead-letters/outbox-1/${label === "Reprocessar" ? "reprocess" : "discard"}`, { method: "POST", body: "{}" });
    expect(mock.mock.calls.some(([path]) => path === "/session/reauth")).toBe(false);
  });

  it("does not mutate when a simple confirmation is canceled", async () => {
    const mock = mockApi(); vi.spyOn(window, "confirm").mockReturnValue(false);
    render(<SystemConsole />); await screen.findByText(session.userDisplayName);
    for (const label of ["Revogar sessão", "Reprocessar", "Descartar"]) fireEvent.click(screen.getByRole("button", { name: label }));
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
    vi.spyOn(window, "confirm").mockReturnValue(true);
    render(<SystemConsole />); await screen.findByText(session.userDisplayName);
    const revoke = screen.getByRole("button", { name: "Revogar sessão" });
    fireEvent.click(revoke); fireEvent.click(revoke);
    expect(mock.mock.calls.filter(([path]) => path === "/sessions/session-vet/revoke")).toHaveLength(1);
    rejectRequest!(new Error("Offline"));
    expect(await screen.findByRole("alert")).toHaveTextContent("Não foi possível revogar a sessão");
    expect(screen.getByRole("button", { name: "Revogar sessão" })).toBeEnabled();
  });
});
