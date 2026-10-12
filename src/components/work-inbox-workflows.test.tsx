/** @vitest-environment jsdom */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { SessionUser, WorkNotificationPreference, WorkNotificationView } from "@cvg/contracts";
import { WorkInbox } from "./work-inbox";
import { apiFetch, ApiClientError } from "./api-client";
import { hospitalUser, uiPage } from "./hospital-ui.test-helpers";
vi.mock("next/link", () => ({ default: ({ children, ...props }: { children: React.ReactNode; href: string }) => <a {...props}>{children}</a> }));
vi.mock("./api-client", async (original) => ({ ...await original<typeof import("./api-client")>(), apiFetch: vi.fn() }));
let user: SessionUser;
let preference: WorkNotificationPreference;
let entry: WorkNotificationView;
const writes = () => vi.mocked(apiFetch).mock.calls.filter(([, init]) => init?.method);
beforeEach(() => {
  vi.mocked(apiFetch).mockReset();
  user = { ...hospitalUser, permissions: ["work_notification.view", "work_notification.read", "work_notification.archive", "work_notification.preferences.manage"] };
  preference = { id: "notice-preference", userId: user.id, mutedEvents: ["TASK_COMMENTED"], version: 4, createdAt: "2026-10-11T12:00:00Z", updatedAt: "2026-10-11T12:00:00Z" };
  entry = { notification: { id: "notice-one", sourceKey: "synthetic-one", userId: user.id, targetType: "HOSPITAL_TASK", targetId: "task-one", eventType: "TASK_ASSIGNED", readAt: "2026-10-11T12:00:00Z", archivedAt: "2026-10-11T12:00:00Z", version: 7, createdAt: "2026-10-11T11:00:00Z" }, target: { targetType: "HOSPITAL_TASK", targetId: "task-one", label: "Verificar materiais", deepLink: "/planner/tasks/task-one" }, permissions: ["work_notification.read", "work_notification.archive"] };
  vi.mocked(apiFetch).mockImplementation(async (path, init) => {
    if (path === "/session/me") return { user } as never;
    if (path === "/work-notifications/preferences" && !init?.method) return preference as never;
    if (path === "/work-notifications/preferences" && init?.method === "PUT") { preference = { ...preference, ...JSON.parse(init.body as string), version: preference.version + 1 }; return preference as never; }
    if (path.startsWith("/work-notifications?")) return uiPage([entry]) as never;
    if (path === "/work-notifications/read") return { marked: 1 } as never;
    if (path.endsWith("/archive")) { entry = { ...entry, notification: { ...entry.notification, archivedAt: undefined, version: entry.notification.version + 1 } }; return entry as never; }
    throw new Error(`Unexpected inbox workflow ${path}`);
  });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

it("updates personal event preferences with their captured version and uses the returned version on the next save", async () => {
  render(<WorkInbox />);
  const form = await screen.findByRole("form", { name: "Preferências de avisos" });
  fireEvent.click(within(form).getByLabelText("Novo comentário"));
  fireEvent.click(within(form).getByLabelText("Prazo da atividade"));
  fireEvent.submit(form);
  await waitFor(() => expect(writes()).toHaveLength(1));
  expect(JSON.parse(writes()[0][1]!.body as string)).toEqual({ mutedEvents: ["TASK_DUE"], expectedVersion: 4 });
  await waitFor(() => expect(within(screen.getByRole("form")).getByLabelText("Prazo da atividade")).toBeChecked());
  fireEvent.click(within(screen.getByRole("form")).getByLabelText("Atividade alterada"));
  fireEvent.submit(screen.getByRole("form"));
  await waitFor(() => expect(writes()).toHaveLength(2));
  expect(JSON.parse(writes()[1][1]!.body as string)).toEqual({ mutedEvents: ["TASK_DUE", "TASK_CHANGED"], expectedVersion: 5 });
  expect(writes().every(([path]) => path === "/work-notifications/preferences")).toBe(true);
});

it("changes selection, marks all authorized notices, marks one unread and restores its archived version", async () => {
  render(<WorkInbox />);
  await screen.findByRole("link", { name: entry.target.label });
  fireEvent.click(screen.getByLabelText("Somente não lidas"));
  fireEvent.click(screen.getByLabelText("Incluir arquivadas"));
  await waitFor(() => expect(vi.mocked(apiFetch).mock.calls.some(([path]) => path.includes("unreadOnly=true&includeArchived=true"))).toBe(true));
  fireEvent.click(screen.getByRole("button", { name: "Marcar todas as autorizadas como lidas" }));
  await waitFor(() => expect(writes()).toHaveLength(1));
  expect(JSON.parse(writes()[0][1]!.body as string)).toEqual({ all: true, read: true });
  await waitFor(() => expect(screen.getByRole("button", { name: "Marcar como não lida" })).toBeEnabled());
  fireEvent.click(screen.getByRole("button", { name: "Marcar como não lida" }));
  await waitFor(() => expect(writes()).toHaveLength(2));
  expect(JSON.parse(writes()[1][1]!.body as string)).toEqual({ notificationIds: ["notice-one"], read: false });
  await waitFor(() => expect(screen.getByRole("button", { name: "Restaurar na caixa" })).toBeEnabled());
  fireEvent.click(screen.getByRole("button", { name: "Restaurar na caixa" }));
  await screen.findByRole("button", { name: "Arquivar na minha caixa" });
  expect(JSON.parse(writes()[2][1]!.body as string)).toEqual({ archived: false, expectedVersion: 7 });
  expect(writes().every(([path]) => path.startsWith("/work-notifications"))).toBe(true);
});

it("preserves a preference selection after a version conflict and removes it when its permission is revoked", async () => {
  const read = vi.mocked(apiFetch).getMockImplementation()!;
  vi.mocked(apiFetch).mockImplementation(async (path, init) => { if (init?.method) throw new ApiClientError(409, { error: { code: "STALE_VERSION" } }); return read(path, init); });
  render(<WorkInbox />);
  const form = await screen.findByRole("form", { name: "Preferências de avisos" });
  fireEvent.click(within(form).getByLabelText("Menção em comentário"));
  fireEvent.submit(form);
  expect(await screen.findByRole("alert")).toHaveTextContent("Os dados mudaram");
  expect(within(form).getByLabelText("Menção em comentário")).toBeChecked();
  user = { ...user, permissions: ["work_notification.view"] };
  act(() => window.dispatchEvent(new Event("cvg:realtime-resync")));
  await waitFor(() => expect(screen.queryByRole("form")).not.toBeInTheDocument());
  expect(screen.queryByRole("button", { name: "Marcar como não lida" })).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Restaurar na caixa" })).not.toBeInTheDocument();
});

it("does not submit preferences before an authorized read and permits recovering the failed read", async () => {
  let unavailable = true; const read = vi.mocked(apiFetch).getMockImplementation()!;
  vi.mocked(apiFetch).mockImplementation(async (path, init) => { if (path.endsWith("/preferences") && unavailable) throw new ApiClientError(503, { error: { code: "SOURCE_UNAVAILABLE" } }); return read(path, init); });
  render(<WorkInbox />);
  const retry = await screen.findByRole("button", { name: "Tentar novamente" });
  expect(screen.queryByRole("form")).not.toBeInTheDocument();
  expect(writes()).toHaveLength(0);
  unavailable = false;
  fireEvent.click(retry);
  await screen.findByRole("form", { name: "Preferências de avisos" });
  expect(writes()).toHaveLength(0);
});
