/** @vitest-environment jsdom */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Department, DiagnosticService } from "@cvg/contracts";
import { apiFetch } from "./api-client";
import { AdminConsole } from "./admin-console";

vi.mock("next/link", () => ({ default: ({ children, ...props }: { children: React.ReactNode; href: string }) => <a {...props}>{children}</a> }));
vi.mock("./api-client", async (original) => ({ ...await original<typeof import("./api-client")>(), apiFetch: vi.fn() }));
const department: Department = { id: "department-oncology", code: "ONCOLOGY", name: "Oncologia veterinária", type: "DIAGNOSTIC", memberUserIds: [], active: true, version: 1, createdAt: "2026-10-11T00:00:00Z", updatedAt: "2026-10-11T00:00:00Z" };
const legacy: DiagnosticService = { id: "legacy", code: "HISTORICAL", name: "Exame histórico", departmentCode: "OLD_SECTOR", category: "LABORATORY", workflowType: "LABORATORY", requiresSample: true, requiresSchedule: false, allowsAttachment: false, resultSchema: "NARRATIVE", active: true, version: 3, slaHours: { ROUTINE: 8, URGENT: 4, EMERGENCY: 2 } };
function setup() {
  let current = department;
  vi.mocked(apiFetch).mockImplementation(async (path, init) => {
    if (path === "/session/me") return { user: { id: "super", displayName: "Superadmin", departmentCode: "IT", role: "SUPERADMIN", permissions: ["service.catalog.manage"] } } as never;
    if (path === "/departments?includeInactive=true") return [current, { ...department, id: "old-dept", code: "OLD_SECTOR", name: "Setor anterior", active: false }] as never;
    if (path === "/diagnostic-services?includeInactive=true") return [legacy] as never;
    if (path === "/reason-codes" || path === "/users") return [] as never;
    if (path === "/diagnostic-services" && init?.method === "POST") return { ...legacy, ...JSON.parse(String(init.body)), id: "created" } as never;
    throw new Error(`Unexpected request ${path}`);
  });
  return (next: Department) => { current = next; };
}
afterEach(() => { cleanup(); vi.resetAllMocks(); });
describe("Persisted catalog department bindings", () => {
  it("creates a service in a newly registered sector without a recognized hardcoded clinical code", async () => {
    setup(); render(<AdminConsole section="catalog" />);
    const form = await screen.findByRole("form", { name: "Adicionar serviço" });
    const sector = within(form).getByRole("combobox", { name: "Setor", hidden: true });
    expect(sector).toHaveValue("ONCOLOGY");
    expect(within(sector).getByRole("option", { name: department.name, hidden: true })).toHaveValue("ONCOLOGY");
    expect(within(sector).queryByRole("option", { name: /Laboratório/ })).not.toBeInTheDocument();
    fireEvent.change(within(form).getByRole("textbox", { name: "Nome" }), { target: { value: "Painel oncológico" } });
    fireEvent.click(within(form).getByRole("button", { name: "Criar serviço" }));
    await waitFor(() => expect(apiFetch).toHaveBeenCalledWith("/diagnostic-services", expect.objectContaining({ method: "POST" })));
    const call = vi.mocked(apiFetch).mock.calls.find(([path, init]) => path === "/diagnostic-services" && init?.method === "POST");
    expect(JSON.parse(String(call?.[1]?.body))).toMatchObject({ departmentCode: "ONCOLOGY", workflowType: "LABORATORY", name: "Painel oncológico" });
  });
  it("does not offer inactive or unregistered sectors for a new binding while preserving a historical current binding", async () => {
    setup(); render(<AdminConsole section="catalog" />);
    const form = await screen.findByRole("form", { name: "Adicionar serviço" });
    const sector = within(form).getByRole("combobox", { name: "Setor", hidden: true });
    expect(within(sector).getByRole("option", { name: /Setor anterior/, hidden: true })).toBeDisabled();
    expect(within(sector).queryByRole("option", { name: /IT/ })).not.toBeInTheDocument();
    const old = screen.getByRole("form", { name: "Serviço Exame histórico" });
    expect(within(old).getByRole("combobox", { name: "Setor", hidden: true })).toHaveValue("OLD_SECTOR");
    expect(within(old).getByRole("option", { name: /Setor anterior/, hidden: true })).toBeDisabled();
  });
  it("updates labels from the persisted directory without replacing an unsaved service name", async () => {
    const change = setup(); render(<AdminConsole section="catalog" />);
    const form = await screen.findByRole("form", { name: "Adicionar serviço" });
    fireEvent.change(within(form).getByRole("textbox", { name: "Nome" }), { target: { value: "Ainda editando" } });
    change({ ...department, name: "Oncologia atualizada", version: 2 });
    act(() => window.dispatchEvent(new Event("cvg:departments-updated")));
    await screen.findAllByRole("option", { name: "Oncologia atualizada", hidden: true });
    expect(within(form).getByRole("textbox", { name: "Nome" })).toHaveValue("Ainda editando");
  });
});
