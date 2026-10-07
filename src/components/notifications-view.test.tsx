/** @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NotificationsView } from "./notifications-view";
import * as apiClient from "./api-client";

vi.mock("next/link", () => ({
  default: ({ children, ...props }: { children: React.ReactNode; href: string; [key: string]: unknown }) => <a {...props}>{children}</a>
}));

const items = [
  { id: "ack", category: "ACTIONABLE", priority: "HIGH", title: "Confirmada", body: "Ação já confirmada.", createdAt: "2026-08-20T13:00:00.000Z", state: "ACKNOWLEDGED" as const, deepLink: "/requests/request-1", version: 1 },
  { id: "pending", category: "INFORMATIVE", priority: "ROUTINE", title: "Pendente", body: "Aguardando entrega.", createdAt: "2026-08-20T13:01:00.000Z", state: "PENDING" as const, deepLink: "/requests/request-2", version: 1 },
  { id: "failed", category: "CRITICAL", priority: "EMERGENCY", title: "Falhou", body: "Canal indisponível.", createdAt: "2026-08-20T13:02:00.000Z", state: "FAILED" as const, deepLink: "/requests/request-3", version: 1 },
  { id: "superseded", category: "ACTIONABLE", priority: "URGENT", title: "Substituída", body: "Abra a versão atual.", createdAt: "2026-08-20T13:03:00.000Z", state: "SUPERSEDED" as const, deepLink: "/requests/request-4", version: 1 },
  { id: "delivered", category: "ACTIONABLE", priority: "URGENT", title: "Para confirmar", body: "Confirme quando concluir.", createdAt: "2026-08-20T13:04:00.000Z", state: "DELIVERED" as const, deepLink: "/requests/request-5", version: 2 }
];

describe("NotificationsView", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("renders delivery states and acknowledges an actionable notification", async () => {
    let resolveAcknowledgement: () => void = () => undefined;
    const acknowledgement = new Promise<void>((resolve) => {
      resolveAcknowledgement = resolve;
    });
    const apiFetchMock = vi.spyOn(apiClient, "apiFetch").mockImplementation((path, init) => {
      if (path === "/notifications/delivered/acknowledge") return acknowledgement as never;
      return Promise.resolve(path.includes("filter=UNREAD") ? [] : items) as never;
    });

    render(<NotificationsView />);

    // Plane-style inbox: the first notification opens beside the list.
    expect(await screen.findByRole("heading", { name: "Confirmada" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /^Pendente/ }));
    expect(screen.getByText(/Entrega pendente/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /^Falhou/ }));
    expect(screen.getByText(/Entrega não confirmada/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /^Substituída/ }));
    expect(screen.getByText(/Resultado substituído/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /^Para confirmar/ }));
    expect(screen.getByRole("heading", { name: "Para confirmar" })).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Motivo da confirmação"), { target: { value: "Conferência operacional" } });
    fireEvent.click(screen.getByLabelText("Confirmo a ação"));
    fireEvent.click(screen.getByRole("button", { name: "Confirmar" }));

    expect(screen.getByRole("button", { name: "Confirmando…" })).toHaveAttribute("data-action-state", "pending");
    expect(screen.getByRole("button", { name: "Confirmando…" })).toBeDisabled();

    await waitFor(() => expect(apiFetchMock).toHaveBeenCalledWith("/notifications/delivered/acknowledge", expect.objectContaining({ method: "POST" })));
    expect(JSON.parse(apiFetchMock.mock.calls.find(([path]) => path === "/notifications/delivered/acknowledge")?.[1]?.body as string)).toEqual({ expectedVersion: 2, reason: "Conferência operacional", confirm: true });
    resolveAcknowledgement();

    fireEvent.click(screen.getByRole("tab", { name: "Não lidas" }));
    await waitFor(() => expect(screen.getByText("Nenhuma notificação nesta visão")).toBeInTheDocument());
  });

  it("reconciles after a realtime update event", async () => {
    const apiFetchMock = vi.spyOn(apiClient, "apiFetch").mockResolvedValue(items as never);
    render(<NotificationsView />);
    await screen.findByRole("heading", { name: "Confirmada" });

    fireEvent(window, new Event("cvg:realtime-updated"));
    await waitFor(() => expect(apiFetchMock).toHaveBeenCalledTimes(2));
  });

  it("ignores a slower response from the previous filter", async () => {
    let resolveAll!: (value: typeof items) => void;
    let resolveUnread!: (value: typeof items) => void;
    const allResponse = new Promise<typeof items>((resolve) => { resolveAll = resolve; });
    const unreadItems = [{ ...items[4], id: "unread", title: "Somente não lida" }];
    const unreadResponse = new Promise<typeof items>((resolve) => { resolveUnread = resolve; });
    const apiFetchMock = vi.spyOn(apiClient, "apiFetch").mockImplementation((path) => {
      if (path === "/notifications?filter=ALL") return allResponse as never;
      if (path === "/notifications?filter=UNREAD") return unreadResponse as never;
      return Promise.resolve([]) as never;
    });

    render(<NotificationsView />);
    await waitFor(() => expect(apiFetchMock).toHaveBeenCalledWith("/notifications?filter=ALL"));
    fireEvent.click(screen.getByRole("tab", { name: "Não lidas" }));
    await waitFor(() => expect(apiFetchMock).toHaveBeenCalledWith("/notifications?filter=UNREAD"));

    resolveUnread(unreadItems);
    expect(await screen.findByRole("heading", { name: "Somente não lida" })).toBeInTheDocument();
    resolveAll(items);
    await waitFor(() => expect(screen.queryByRole("heading", { name: "Confirmada" })).not.toBeInTheDocument());
    expect(screen.getByRole("heading", { name: "Somente não lida" })).toBeInTheDocument();
  });

  it("sanitizes a load failure and exposes a retry path", async () => {
    let attempts = 0;
    vi.spyOn(apiClient, "apiFetch").mockImplementation(() => {
      attempts += 1;
      return attempts === 1 ? Promise.reject(new Error("postgres://secret")) as never : Promise.resolve([]) as never;
    });

    render(<NotificationsView />);

    expect(await screen.findByRole("alert")).toHaveTextContent("Não foi possível carregar as notificações.");
    expect(screen.getByRole("alert")).not.toHaveTextContent("postgres://");
    fireEvent.click(screen.getByRole("button", { name: "Tentar novamente" }));
    await waitFor(() => expect(screen.getByText("Nenhuma notificação nesta visão")).toBeInTheDocument());
    expect(attempts).toBe(2);
  });
});
