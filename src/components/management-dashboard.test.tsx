/** @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ManagementOverview, Permission } from "@cvg/contracts";
import { ApiClientError } from "./api-client";
import { ManagementDashboard } from "./management-dashboard";
import * as apiClient from "./api-client";

vi.mock("next/link", () => ({
  default: ({ children, ...props }: { children: React.ReactNode; href: string; [key: string]: unknown }) => <a {...props}>{children}</a>,
}));

const searchParams = new URLSearchParams();
vi.mock("next/navigation", () => ({
  useSearchParams: () => searchParams,
}));

function mockManagement(data: ManagementOverview, permissions: Permission[] = ["user_role.manage", "service.catalog.manage", "audit.view"]) {
  return vi.spyOn(apiClient, "apiFetch").mockImplementation((path) => Promise.resolve(path === "/session/me" ? { user: { role: "MANAGER", permissions } } : data) as never);
}

describe("ManagementDashboard", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    searchParams.delete("view");
  });

  it("renders one actionable management snapshot with scope and next actions", async () => {
    mockManagement({
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
    expect(screen.getByRole("link", { name: "Acessos" })).toHaveAttribute("href", "/admin/users");
    expect(screen.getByRole("link", { name: "Catálogos" })).toHaveAttribute("href", "/admin/catalog");
    expect(screen.getByRole("link", { name: "Auditoria" })).toHaveAttribute("href", "/system#audit");
    await waitFor(() => expect(apiClient.apiFetch).toHaveBeenCalledWith("/management/overview"));
  });

  it("keeps a safe retry state when the management snapshot is unavailable", async () => {
    let offline = true;
    const apiFetchMock = vi.spyOn(apiClient, "apiFetch").mockImplementation((path) => {
      if (path === "/session/me") return Promise.resolve({ user: { permissions: [] } }) as never;
      if (offline) return Promise.reject(new Error("offline")) as never;
      return Promise.resolve({
        asOf: "2026-08-20T12:00:00.000Z", scope: { departments: [], label: "Nenhum setor" },
        summary: { totalRequests: 0, activeItems: 0, overdue: 0, recollections: 0, newResults: 0, critical: 0, pendingRequests: 0, completedToday: 0 },
        departments: [], pending: [], recentRequests: []
      }) as never;
    });
    render(<ManagementDashboard />);
    expect(await screen.findByRole("alert")).toHaveTextContent("Controle operacional indisponível");
    offline = false;
    fireEvent.click(screen.getByRole("button", { name: "Tentar novamente" }));
    await waitFor(() => expect(screen.getByRole("heading", { name: "Controle operacional." })).toBeInTheDocument());
    expect(apiFetchMock.mock.calls.filter(([path]) => path === "/management/overview")).toHaveLength(2);
  });

  it("renders the server-derived statistics view and its sector definitions", async () => {
    searchParams.set("view", "stats");
    mockManagement({
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
    mockManagement({
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
  it("hides administrative destinations when the server does not grant those commands", async () => {
    mockManagement({ asOf: "2026-10-11T12:00:00Z", scope: { departments: [], label: "Nenhum" }, summary: { totalRequests: 0, activeItems: 0, overdue: 0, recollections: 0, newResults: 0, critical: 0, pendingRequests: 0, completedToday: 0 }, departments: [], pending: [], recentRequests: [] }, []);
    render(<ManagementDashboard />);
    await screen.findByRole("heading", { name: "Controle operacional." });
    for (const name of ["Acessos", "Catálogos", "Auditoria"]) expect(screen.queryByRole("link", { name })).not.toBeInTheDocument();
  });

  it.each([401, 403, 404])("withdraws the prior clinical snapshot and privileged links when refresh returns %i", async (status) => {
    let denied = false;
    vi.spyOn(apiClient, "apiFetch").mockImplementation((path) => {
      if (path === "/session/me") return Promise.resolve({ user: { permissions: ["user_role.manage", "service.catalog.manage", "audit.view"] } }) as never;
      if (denied) return Promise.reject(new ApiClientError(status, { error: { code: "SCOPE_DENIED" } })) as never;
      return Promise.resolve({
        asOf: "2026-10-11T12:00:00Z", scope: { departments: ["LABORATORY"], label: "Laboratório" },
        summary: { totalRequests: 1, activeItems: 1, overdue: 0, recollections: 0, newResults: 0, critical: 0, pendingRequests: 1, completedToday: 0 }, departments: [],
        pending: [{ id: "protected-item", requestId: "protected-request", requestCode: "PROTECTED-1", patient: "Paciente protegido", service: "Hemograma", departmentCode: "LABORATORY", status: "REQUESTED", priority: "ROUTINE", dueAt: "2026-10-11T15:00:00Z", overdue: false, nextAction: "Receber amostra", deepLink: "/requests/protected-request#protected-item" }], recentRequests: [],
      }) as never;
    });
    render(<ManagementDashboard />);
    await screen.findByText(/Paciente protegido/);
    expect(screen.getByRole("link", { name: "Acessos" })).toBeInTheDocument();
    denied = true;
    fireEvent.click(screen.getByRole("button", { name: /^Atualizar$/ }));
    await screen.findByRole("heading", { name: "Controle operacional indisponível" });
    expect(screen.queryByText(/Paciente protegido/)).not.toBeInTheDocument();
    for (const name of ["Acessos", "Catálogos", "Auditoria"]) expect(screen.queryByRole("link", { name })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Tentar novamente" })).not.toBeInTheDocument();
  });

  it("keeps a clearly stale authorized snapshot for a temporary outage and refreshes its current sector definitions", async () => {
    let offline = false;
    const snapshot = { asOf: "2026-10-11T12:00:00Z", scope: { departments: ["NEW_SECTOR"], label: "fallback" }, summary: { totalRequests: 1, activeItems: 1, overdue: 0, recollections: 0, newResults: 0, critical: 0, pendingRequests: 0, completedToday: 0 }, departments: [{ departmentCode: "NEW_SECTOR", serviceCount: 1, totalRequests: 1, activeItems: 1, overdue: 0, pending: 0 }], pending: [], recentRequests: [{ id: "visible", requestCode: "SECTOR-1", patient: "Nome autorizado", aggregateStatus: "RESULT_VOIDED", priority: "ROUTINE", updatedAt: "2026-10-11T12:00:00Z", itemCount: 1, deepLink: "/requests/visible" }] };
    vi.spyOn(apiClient, "apiFetch").mockImplementation(async (path) => {
      if (path === "/session/me") throw new Error("session read unavailable");
      if (offline) throw new ApiClientError(503, {});
      return snapshot as never;
    });
    render(<ManagementDashboard />);
    await screen.findByText("Nome autorizado", { exact: false });
    expect(screen.getAllByText("New sector")).toHaveLength(2);
    expect(screen.getByText("Result voided")).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Acessos" })).not.toBeInTheDocument();
    offline = true; fireEvent.click(screen.getByRole("button", { name: /^Atualizar$/ }));
    await screen.findByText("Controle operacional desatualizado");
    expect(screen.getByText(/Nome autorizado/)).toBeInTheDocument();
    offline = false; fireEvent.click(screen.getByRole("button", { name: "Tentar novamente" }));
    await waitFor(() => expect(screen.queryByText("Controle operacional desatualizado")).not.toBeInTheDocument());
    expect(screen.getByRole("link", { name: /SECTOR-1/ })).toHaveAttribute("href", "/requests/visible");
  });

});
