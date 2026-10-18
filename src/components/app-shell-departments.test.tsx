/** @vitest-environment jsdom */
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Department, DiagnosticService, SessionRole, SessionUser } from "@cvg/contracts";
import { AppShell } from "./app-shell";
import { apiFetch } from "./api-client";

vi.mock("next/link", () => ({ default: ({ children, ...props }: { children: React.ReactNode; href: string }) => <a {...props}>{children}</a> }));
const navigation = vi.hoisted(() => ({ pathname: "/queues", params: new URLSearchParams(), router: { replace: vi.fn(), push: vi.fn(), refresh: vi.fn() } }));
vi.mock("next/navigation", () => ({ usePathname: () => navigation.pathname, useSearchParams: () => navigation.params, useRouter: () => navigation.router }));
vi.mock("./api-client", async (original) => ({ ...await original<typeof import("./api-client")>(), apiFetch: vi.fn() }));
const department: Department = { id: "department-oncology", code: "ONCOLOGY", name: "Oncologia veterinária", type: "DIAGNOSTIC", memberUserIds: [], active: true, version: 1, createdAt: "2026-10-11T00:00:00Z", updatedAt: "2026-10-11T00:00:00Z" };
const service: DiagnosticService = { id: "service-oncology", code: "ONCO_HEMOGRAM", name: "Hemograma oncológico", departmentCode: "ONCOLOGY", category: "LABORATORY", workflowType: "LABORATORY", requiresSample: true, requiresSchedule: false, allowsAttachment: false, resultSchema: "NARRATIVE", active: true, version: 1, slaHours: { ROUTINE: 8, URGENT: 4, EMERGENCY: 2 } };
function setup(role: SessionRole, departments: Department[] = [department]) {
  const user: SessionUser = { id: "user-1", role, departmentCode: "INPATIENT", displayName: "Operador", email: "operator@cvg.local", timezone: "UTC", permissions: role === "SUPERADMIN" || role === "MANAGER" || role === "ADMIN" ? ["department.view", "access_group.view"] : ["department.view"] };
  vi.mocked(apiFetch).mockImplementation(async (path) => {
    if (path === "/session/me") return { user } as never;
    if (path === "/departments") return departments as never;
    if (path === "/diagnostic-services") return [service] as never;
    if (path.startsWith("/notifications")) return [] as never;
    throw new Error(`Unexpected request ${path}`);
  });
}
beforeEach(() => { vi.stubGlobal("EventSource", class { onopen = null; onmessage = null; onerror = null; addEventListener() {} close() {} }); });
afterEach(() => { cleanup(); vi.resetAllMocks(); vi.unstubAllGlobals(); window.localStorage.clear(); navigation.pathname = "/queues"; });
describe("AppShell persisted departments", () => {
  it.each(["SUPERADMIN", "MANAGER"] as const)("shows a new diagnostic sector without a hardcoded array for %s", async (role) => {
    setup(role); render(<AppShell><h1>Workspace</h1></AppShell>);
    const sector = await screen.findByRole("button", { name: department.name });
    expect(sector).toHaveAttribute("aria-expanded", "true");
    const nav = screen.getByRole("navigation", { name: "Navegação principal" });
    expect(within(nav).getByRole("link", { name: "Exames" })).toHaveAttribute("href", "/queues?dept=ONCOLOGY");
    expect(within(nav).getByRole("link", { name: "Setores" })).toHaveAttribute("href", "/admin/departments");
    expect(within(nav).getByRole("link", { name: "Grupos de acesso" })).toHaveAttribute("href", "/admin/access-groups");
    expect(screen.queryByRole("button", { name: "Laboratório" })).not.toBeInTheDocument();
  });
  it("keeps an authorized service sector reachable for a clinician without exposing the department team directory", async () => {
    setup("VETERINARIAN", []); render(<AppShell><h1>Workspace</h1></AppShell>);
    await screen.findByRole("button", { name: "ONCOLOGY" });
    const nav = screen.getByRole("navigation", { name: "Navegação principal" });
    expect(within(nav).getByRole("link", { name: "Exames" })).toHaveAttribute("href", "/queues?dept=ONCOLOGY");
    expect(within(nav).queryByRole("link", { name: "Setores" })).not.toBeInTheDocument();
    expect(within(nav).queryByRole("link", { name: "Grupos de acesso" })).not.toBeInTheDocument();
    expect(apiFetch).not.toHaveBeenCalledWith("/users", expect.anything());
  });
  it("updates the persisted sector name after a directory event", async () => {
    let current = department;
    setup("SUPERADMIN");
    const previous = vi.mocked(apiFetch).getMockImplementation()!;
    vi.mocked(apiFetch).mockImplementation((path, init) => path === "/departments" ? Promise.resolve([current]) as never : previous(path, init));
    render(<AppShell><h1>Workspace</h1></AppShell>);
    await screen.findByRole("button", { name: department.name });
    current = { ...department, name: "Oncologia e cuidados", version: 2 };
    act(() => window.dispatchEvent(new Event("cvg:departments-updated")));
    await screen.findByRole("button", { name: current.name });
    expect(screen.queryByRole("button", { name: department.name })).not.toBeInTheDocument();
  });
  it("keeps ADMIN technical navigation separate and uses the new department breadcrumb", async () => {
    navigation.pathname = "/admin/departments";
    setup("ADMIN"); render(<AppShell><h1>Workspace</h1></AppShell>);
    const crumb = await screen.findByRole("navigation", { name: "Você está em" });
    expect(crumb).toHaveTextContent("AdministraçãoSetores");
    await waitFor(() => expect(apiFetch).toHaveBeenCalledWith("/departments"));
    expect(apiFetch).not.toHaveBeenCalledWith("/diagnostic-services");
    expect(screen.queryByRole("button", { name: department.name })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Meu trabalho" })).not.toBeInTheDocument();
  });
});
