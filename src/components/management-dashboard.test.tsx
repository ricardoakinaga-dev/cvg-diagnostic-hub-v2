/** @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ManagementDashboard } from "./management-dashboard";
import * as apiClient from "./api-client";

vi.mock("next/link", () => ({
  default: ({ children, ...props }: { children: React.ReactNode; href: string; [key: string]: unknown }) => <a {...props}>{children}</a>,
}));

const searchParams = new URLSearchParams();
vi.mock("next/navigation", () => ({
  useSearchParams: () => searchParams,
}));

describe("ManagementDashboard", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    searchParams.delete("view");
  });

  it("renders one actionable management snapshot with scope and next actions", async () => {
    vi.spyOn(apiClient, "apiFetch").mockResolvedValue({
      asOf: "2026-08-20T12:00:00.000Z",
      scope: { departments: ["LABORATORY", "RADIOLOGY"], label: "INPATIENT · LABORATORY · RADIOLOGY" },
      summary: { totalRequests: 1, activeItems: 2, overdue: 1, recollections: 0, newResults: 1, critical: 0, pendingRequests: 1, completedToday: 0 },
      departments: [{ departmentCode: "LABORATORY", serviceCount: 2, totalRequests: 1, activeItems: 2, overdue: 1, pending: 2 }],
      pending: [{ id: "item-1", requestId: "request-1", requestCode: "EX-1", patient: "Thor", service: "Hemograma", departmentCode: "LABORATORY", status: "REQUESTED", priority: "URGENT", dueAt: "2026-08-20T11:00:00.000Z", overdue: true, nextAction: "Receber amostra", deepLink: "/requests/request-1#item-1" }],
      recentRequests: [{ id: "request-1", requestCode: "EX-1", patient: "Thor", aggregateStatus: "REQUESTED", priority: "URGENT", updatedAt: "2026-08-20T12:00:00.000Z", itemCount: 1, deepLink: "/requests/request-1" }],
    } as never);

    render(<ManagementDashboard />);

    expect(await screen.findByRole("heading", { name: "Controle operacional." })).toBeInTheDocument();
    expect(screen.getByText("Laboratório · Radiologia")).toBeInTheDocument();
    expect(screen.getByText("Receber amostra")).toBeInTheDocument();
    expect(screen.getByText("Onde está a pressão")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Acessos" })).toHaveAttribute("href", "/admin#users");
    await waitFor(() => expect(apiClient.apiFetch).toHaveBeenCalledWith("/management/overview"));
  });

  it("keeps a safe retry state when the management snapshot is unavailable", async () => {
    const apiFetchMock = vi.spyOn(apiClient, "apiFetch")
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce({
        asOf: "2026-08-20T12:00:00.000Z",
        scope: { departments: [], label: "Nenhum setor" },
        summary: { totalRequests: 0, activeItems: 0, overdue: 0, recollections: 0, newResults: 0, critical: 0, pendingRequests: 0, completedToday: 0 },
        departments: [], pending: [], recentRequests: []
      } as never);
    render(<ManagementDashboard />);
    expect(await screen.findByRole("alert")).toHaveTextContent("Controle operacional indisponível");
    fireEvent.click(screen.getByRole("button", { name: "Tentar novamente" }));
    await waitFor(() => expect(screen.getByRole("heading", { name: "Controle operacional." })).toBeInTheDocument());
    expect(apiFetchMock).toHaveBeenCalledTimes(2);
  });

  it("renders the server-derived statistics view and its sector definitions", async () => {
    searchParams.set("view", "stats");
    vi.spyOn(apiClient, "apiFetch").mockResolvedValue({
      asOf: "2026-08-20T12:00:00.000Z",
      scope: { departments: ["LABORATORY"], label: "LABORATORY" },
      summary: { totalRequests: 4, activeItems: 3, overdue: 1, recollections: 0, newResults: 2, critical: 0, pendingRequests: 1, completedToday: 1 },
      departments: [{ departmentCode: "LABORATORY", serviceCount: 2, totalRequests: 4, activeItems: 3, overdue: 1, pending: 1 }],
      pending: [],
      recentRequests: []
    } as never);

    render(<ManagementDashboard />);

    expect(await screen.findByRole("heading", { name: "Estatísticas." })).toBeInTheDocument();
    expect(screen.getByRole("table", { name: "Resumo por setor" })).toBeInTheDocument();
    expect(screen.getByText("3 itens em estados não terminais.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Atualizar/ }));
    await waitFor(() => expect(apiClient.apiFetch).toHaveBeenCalledWith("/management/overview"));
  });

  it("renders the full pending and recent-request views with honest empty sectors", async () => {
    searchParams.set("view", "pending");
    vi.spyOn(apiClient, "apiFetch").mockResolvedValue({
      asOf: "2026-08-20T12:00:00.000Z",
      scope: { departments: ["LABORATORY"], label: "LABORATORY" },
      summary: { totalRequests: 1, activeItems: 1, overdue: 0, recollections: 0, newResults: 0, critical: 0, pendingRequests: 1, completedToday: 0 },
      departments: [],
      pending: [{ id: "item-1", requestId: "request-1", requestCode: "EX-1", patient: "Thor", service: "Hemograma", departmentCode: "LABORATORY", status: "REQUESTED", priority: "ROUTINE", dueAt: "2026-08-20T13:00:00.000Z", overdue: false, nextAction: "Receber amostra", deepLink: "/requests/request-1#item-1" }],
      recentRequests: [{ id: "request-1", requestCode: "EX-1", patient: "Thor", aggregateStatus: "IN_PROGRESS", priority: "ROUTINE", updatedAt: "2026-08-20T12:00:00.000Z", itemCount: 1, deepLink: "/requests/request-1" }]
    } as never);

    const { unmount } = render(<ManagementDashboard />);
    expect(await screen.findByRole("heading", { name: "Pendências." })).toBeInTheDocument();
    expect(screen.getByText("Receber amostra")).toBeInTheDocument();
    unmount();

    searchParams.set("view", "requests");
    render(<ManagementDashboard />);
    expect(await screen.findByRole("heading", { name: "Solicitações." })).toBeInTheDocument();
    expect(screen.getByText("EX-1")).toBeInTheDocument();
  });
});
