/** @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { SessionUser, WorkNotificationView } from "@cvg/contracts";
import { WorkInbox } from "./work-inbox";
import { apiFetch, ApiClientError } from "./api-client";
import { hospitalUser } from "./hospital-ui.test-helpers";

vi.mock("next/link", () => ({ default: ({ children, ...props }: { children: React.ReactNode; href: string }) => <a {...props}>{children}</a> }));
vi.mock("./api-client", async (original) => ({ ...await original<typeof import("./api-client")>(), apiFetch: vi.fn() }));
const user: SessionUser = { ...hospitalUser, permissions: ["work_notification.view", "work_notification.read"] };
const notice = (id: string): WorkNotificationView => ({ notification: { id, sourceKey: id, userId: user.id, targetType: "HOSPITAL_TASK", targetId: id, eventType: "TASK_CHANGED", version: 1, createdAt: "2026-10-11T12:00:00Z" }, target: { targetType: "HOSPITAL_TASK", targetId: id, label: `Atividade ${id}`, deepLink: `/planner/tasks/${id}` }, permissions: ["work_notification.read"] });
beforeEach(() => { vi.clearAllMocks(); });
afterEach(() => { cleanup(); });

it("shows the server's authorized unread count rather than counting the loaded page and preserves it on continuation", async () => {
  vi.mocked(apiFetch).mockImplementation(async (path) => {
    if (path === "/session/me") return { user } as never;
    if (path.startsWith("/work-notifications?")) return path.includes("cursor=") ? { items: [notice("two")], total: 4, unread: 2, limit: 1 } as never : { items: [notice("one")], total: 4, unread: 3, limit: 1, nextCursor: "authorized-next" } as never;
    throw new Error(`Unexpected synthetic inbox path ${path}`);
  });
  render(<WorkInbox />);
  await screen.findByText("Carregados 1 de 4 avisos nesta seleção. 3 não lidos na caixa ativa.");
  fireEvent.click(screen.getByRole("button", { name: "Carregar mais avisos" }));
  await screen.findByText("Carregados 2 de 4 avisos nesta seleção. 2 não lidos na caixa ativa.");
  expect(screen.getByRole("link", { name: "Atividade one" })).toBeInTheDocument();
  expect(screen.getByRole("link", { name: "Atividade two" })).toBeInTheDocument();
});

it("uses the current filter's total and the active-box unread count, then refreshes both after read-all", async () => {
  let read = false;
  vi.mocked(apiFetch).mockImplementation(async (path) => {
    if (path === "/session/me") return { user } as never;
    if (path === "/work-notifications/read") { read = true; return { marked: 3 } as never; }
    if (path.startsWith("/work-notifications?")) {
      const query = new URLSearchParams(path.split("?")[1]);
      return { items: read && query.get("unreadOnly") === "true" ? [] : [notice("one")], total: query.get("unreadOnly") === "true" ? read ? 0 : 3 : query.get("includeArchived") === "true" ? 7 : 4, unread: read ? 0 : 3, limit: 50 } as never;
    }
    throw new Error(`Unexpected synthetic inbox path ${path}`);
  });
  render(<WorkInbox />);
  await screen.findByText("Carregados 1 de 4 avisos nesta seleção. 3 não lidos na caixa ativa.");
  fireEvent.click(screen.getByRole("checkbox", { name: "Incluir arquivadas" }));
  await screen.findByText("Carregados 1 de 7 avisos nesta seleção. 3 não lidos na caixa ativa.");
  fireEvent.click(screen.getByRole("checkbox", { name: "Somente não lidas" }));
  await screen.findByText("Carregados 1 de 3 avisos nesta seleção. 3 não lidos na caixa ativa.");
  fireEvent.click(screen.getByRole("button", { name: "Marcar todas as autorizadas como lidas" }));
  await screen.findByText("Carregados 0 de 0 avisos nesta seleção. 0 não lidos na caixa ativa.");
  expect(vi.mocked(apiFetch).mock.calls.find(([path]) => path === "/work-notifications/read")?.[1]?.body).toBe(JSON.stringify({ all: true, read: true }));
  fireEvent.click(screen.getByRole("checkbox", { name: "Somente não lidas" }));
  await screen.findByText("Carregados 1 de 7 avisos nesta seleção. 0 não lidos na caixa ativa.");
});

it("removes old counts and targets when current authorization is denied while loading a continuation", async () => {
  vi.mocked(apiFetch).mockImplementation(async (path) => {
    if (path === "/session/me") return { user } as never;
    if (path.startsWith("/work-notifications?")) {
      if (path.includes("cursor=")) throw new ApiClientError(403, { error: { code: "SCOPE_DENIED" } });
      return { items: [notice("restricted")], total: 4, unread: 3, limit: 1, nextCursor: "revoked-next" } as never;
    }
    throw new Error(`Unexpected synthetic inbox path ${path}`);
  });
  render(<WorkInbox />);
  await screen.findByText("Carregados 1 de 4 avisos nesta seleção. 3 não lidos na caixa ativa.");
  fireEvent.click(screen.getByRole("button", { name: "Carregar mais avisos" }));
  await waitFor(() => expect(screen.queryByRole("link", { name: "Atividade restricted" })).not.toBeInTheDocument());
  expect(screen.queryByText(/Carregados.*avisos nesta seleção/)).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Carregar mais avisos" })).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Marcar todas as autorizadas como lidas" })).toBeDisabled();
});
