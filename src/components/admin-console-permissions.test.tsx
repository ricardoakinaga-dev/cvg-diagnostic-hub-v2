/** @vitest-environment jsdom */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { Department, DiagnosticService, Permission, ReasonCode, SessionUser } from "@cvg/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AdminConsole } from "./admin-console";
import * as client from "./api-client";

vi.mock("next/link", () => ({ default: ({ children, ...props }: { children: React.ReactNode; href: string }) => <a {...props}>{children}</a> }));
const service: DiagnosticService = { id: "catalog-1", code: "NATIVE_PANEL", name: "Exame autorizado", category: "LABORATORY", departmentCode: "LABORATORY", workflowType: "LABORATORY", requiresSample: true, requiresSchedule: false, allowsAttachment: false, resultSchema: "NARRATIVE", active: true, version: 7, slaHours: { ROUTINE: 8, URGENT: 4, EMERGENCY: 2 } };
const reason: ReasonCode = { id: "reason-1", type: "RECOLLECTION", code: "SYNTHETIC_REASON", label: "Motivo autorizado", active: true, version: 3 };
const department: Department = { id: "dept-lab", code: "LABORATORY", name: "Laboratório cadastrado", type: "DIAGNOSTIC", active: true, memberUserIds: [], version: 1, createdAt: "2026-10-11T00:00:00Z", updatedAt: "2026-10-11T00:00:00Z" };
const identity: SessionUser = { id: "admin", role: "ADMIN", email: "admin@example.invalid", displayName: "Administração técnica", departmentCode: "IT", timezone: "America/Sao_Paulo" };
function deferred<T>() { let resolve!: (value: T) => void; let reject!: (cause: unknown) => void; const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; }); return { promise, resolve, reject }; }
function setup(permissions: Permission[] | undefined, catalog = [service]) {
  let user: SessionUser = { ...identity, permissions };
  const reads = { session: undefined as Promise<{ user: SessionUser }> | undefined, catalog: undefined as Promise<DiagnosticService[]> | undefined, departments: undefined as Promise<Department[]> | undefined };
  const mock = vi.spyOn(client, "apiFetch").mockImplementation(async <T,>(path: string, init?: RequestInit): Promise<T> => {
    if (path === "/session/me") return await (reads.session ?? { user }) as T;
    if (path === "/departments?includeInactive=true") {
      if (!user.permissions?.includes("department.view")) throw new client.ApiClientError(404, { error: { code: "SCOPE_DENIED" } });
      if (reads.departments) return await reads.departments as T;
      if (user.role === "MANAGER" && ![user.departmentCode, ...(user.managedDepartmentCodes ?? [])].includes(department.code)) return [] as T;
      return [department] as T;
    }
    if (["/diagnostic-services", "/diagnostic-services?includeInactive=true"].includes(path) && !init?.method) return await (reads.catalog ?? catalog) as T;
    if (path === "/reason-codes" && !init?.method) return [reason] as T;
    if (path === "/users" && !init?.method) return [] as T;
    if (path === `/diagnostic-services/${service.id}/definitions` && !init?.method) return [] as T;
    if (init?.method) return { ...service, ...JSON.parse(String(init.body)), version: 8 } as T;
    throw new Error(`Unexpected synthetic request ${path}`);
  });
  return { mock, reads, setIdentity: (next: SessionUser) => { user = next; } };
}
function writes(mock: ReturnType<typeof setup>["mock"]) { return mock.mock.calls.filter(([, init]) => init?.method); }
function serviceRow() { return screen.getByRole("form", { name: "Serviço Exame autorizado" }); }
async function open() { render(<AdminConsole section="catalog" />); await screen.findByRole("button", { name: "Atualizar" }); }
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe("Current granular catalog authority", () => {
  it("opens active services read-only with catalog.view and exposes no administrative mutation", async () => {
    const { mock } = setup(["service.catalog.view"]); await open();
    const row = await screen.findByRole("form", { name: "Serviço Exame autorizado" });
    expect(mock).toHaveBeenCalledWith("/diagnostic-services");
    expect(mock.mock.calls.some(([path]) => path === "/diagnostic-services?includeInactive=true" || path === "/reason-codes")).toBe(false);
    expect(within(row).getByLabelText("Nome")).toBeDisabled();
    expect(within(row).getByLabelText("Disponível no catálogo")).toBeDisabled();
    expect(within(row).queryByRole("button", { name: "Salvar Exame autorizado" })).not.toBeInTheDocument();
    expect(within(row).queryByRole("button", { name: "Duplicar Exame autorizado" })).not.toBeInTheDocument();
    expect(screen.queryByRole("form", { name: "Adicionar serviço" })).not.toBeInTheDocument();
    expect(screen.queryByText("Importar catálogo por planilha")).not.toBeInTheDocument();
    expect(screen.queryByText("Adicionar motivo")).not.toBeInTheDocument();
    fireEvent.submit(row); expect(writes(mock)).toHaveLength(0);
  });

  it.each([{ permissions: undefined }, { permissions: [] as Permission[] }])("fails closed when effective permissions are $permissions, even on the direct admin destination", async ({ permissions }) => {
    const { mock } = setup(permissions); await open();
    expect(screen.queryByRole("form", { name: "Adicionar serviço" })).not.toBeInTheDocument();
    expect(screen.queryByText("Adicionar motivo")).not.toBeInTheDocument();
    expect(screen.queryByText("Importar catálogo por planilha")).not.toBeInTheDocument();
    expect(mock.mock.calls.some(([path]) => path.startsWith("/diagnostic-services") || path === "/reason-codes")).toBe(false);
    expect(writes(mock)).toHaveLength(0);
  });

  it("allows creation and duplication independently while existing metadata and availability remain read-only", async () => {
    const { mock } = setup(["service.catalog.create", "department.view"]); await open();
    const form = await screen.findByRole("form", { name: "Adicionar serviço" });
    const row = serviceRow();
    expect(within(row).getByLabelText("Nome")).toBeDisabled();
    expect(within(row).getByLabelText("Disponível no catálogo")).toBeDisabled();
    fireEvent.submit(row); expect(writes(mock)).toHaveLength(0);
    fireEvent.change(within(form).getByLabelText("Nome"), { target: { value: "Novo exame" } });
    fireEvent.click(within(form).getByRole("button", { name: "Criar serviço" }));
    await waitFor(() => expect(writes(mock)).toHaveLength(1));
    expect(writes(mock)[0][0]).toBe("/diagnostic-services");
    expect(JSON.parse(String(writes(mock)[0][1]?.body))).toMatchObject({ code: "NOVO_EXAME", name: "Novo exame", departmentCode: "LABORATORY" });
    fireEvent.click(await screen.findByRole("button", { name: "Duplicar Exame autorizado" }));
    await waitFor(() => expect(writes(mock)).toHaveLength(2));
    expect(JSON.parse(String(writes(mock)[1][1]?.body))).toMatchObject({ duplicateOfServiceId: service.id, name: "Exame autorizado (cópia)" });
    expect(screen.queryByText("Adicionar motivo")).not.toBeInTheDocument();
  });

  it("allows update without creation or deactivation", async () => {
    const { mock } = setup(["service.catalog.update", "department.view"]); await open();
    const row = await screen.findByRole("form", { name: "Serviço Exame autorizado" });
    expect(within(row).getByLabelText("Nome")).toBeEnabled();
    expect(within(row).getByLabelText("Disponível no catálogo")).toBeDisabled();
    expect(within(row).queryByRole("button", { name: /Duplicar/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("form", { name: "Adicionar serviço" })).not.toBeInTheDocument();
    fireEvent.change(within(row).getByLabelText("Nome"), { target: { value: "Nome atualizado" } });
    fireEvent.click(within(row).getByRole("button", { name: "Salvar Exame autorizado" }));
    await waitFor(() => expect(writes(mock)).toHaveLength(1));
    expect(JSON.parse(String(writes(mock)[0][1]?.body))).toMatchObject({ name: "Nome atualizado", expectedVersion: 7 });
    expect(JSON.parse(String(writes(mock)[0][1]?.body))).not.toHaveProperty("active");
  });

  it("sends only active/version for a deactivate-only actor, never immutable or disabled metadata", async () => {
    const { mock } = setup(["service.catalog.deactivate", "department.view"]); await open();
    const row = await screen.findByRole("form", { name: "Serviço Exame autorizado" });
    expect(within(row).getByLabelText("Nome")).toBeDisabled();
    expect(within(row).getByLabelText("Disponível no catálogo")).toBeEnabled();
    fireEvent.submit(row); expect(writes(mock)).toHaveLength(0);
    fireEvent.click(within(row).getByLabelText("Disponível no catálogo"));
    fireEvent.click(within(row).getByRole("button", { name: "Salvar Exame autorizado" }));
    await waitFor(() => expect(writes(mock)).toHaveLength(1));
    expect(writes(mock)[0][0]).toBe(`/diagnostic-services/${service.id}`);
    expect(JSON.parse(String(writes(mock)[0][1]?.body))).toEqual({ active: false, expectedVersion: 7 });
    expect(screen.queryByRole("form", { name: "Adicionar serviço" })).not.toBeInTheDocument();
  });

  it("reactivates with update permission while a deactivate-only actor cannot reactivate", async () => {
    let state = setup(["service.catalog.deactivate", "department.view"], [{ ...service, active: false }]); await open();
    let row = await screen.findByRole("form", { name: "Serviço Exame autorizado" });
    expect(within(row).getByLabelText("Disponível no catálogo")).toBeDisabled();
    fireEvent.submit(row); expect(writes(state.mock)).toHaveLength(0);
    cleanup(); vi.restoreAllMocks();
    state = setup(["service.catalog.update", "department.view"], [{ ...service, active: false }]); await open();
    row = await screen.findByRole("form", { name: "Serviço Exame autorizado" });
    fireEvent.click(within(row).getByLabelText("Disponível no catálogo"));
    fireEvent.submit(row);
    await waitFor(() => expect(writes(state.mock)).toHaveLength(1));
    expect(JSON.parse(String(writes(state.mock)[0][1]?.body))).toMatchObject({ active: true, expectedVersion: 7 });
  });

  it("preserves legacy catalog.manage and requires the separate reason_code.manage grant", async () => {
    const { mock } = setup(["service.catalog.manage", "reason_code.manage", "department.view"]); await open();
    expect(await screen.findByRole("form", { name: "Adicionar serviço" })).toBeInTheDocument();
    expect(screen.getByText("Importar catálogo por planilha")).toBeInTheDocument();
    const row = screen.getByRole("form", { name: "Motivo Motivo autorizado" });
    fireEvent.change(within(row).getByLabelText("Descrição"), { target: { value: "Motivo revisado" } });
    fireEvent.click(within(row).getByRole("button", { name: "Salvar SYNTHETIC_REASON" }));
    await waitFor(() => expect(writes(mock)).toHaveLength(1));
    expect(JSON.parse(String(writes(mock)[0][1]?.body))).toEqual({ label: "Motivo revisado", active: true, expectedVersion: 3 });
  });

  it("blocks commands during current access revalidation, then removes them after revocation", async () => {
    const { mock, reads, setIdentity } = setup(["service.catalog.update", "department.view"]); await open();
    const row = await screen.findByRole("form", { name: "Serviço Exame autorizado" });
    const next = deferred<{ user: SessionUser }>(); reads.session = next.promise;
    act(() => window.dispatchEvent(new Event("cvg:realtime-resync")));
    await waitFor(() => expect(within(row).getByLabelText("Nome")).toBeDisabled());
    fireEvent.submit(row); expect(writes(mock)).toHaveLength(0);
    setIdentity({ ...identity, permissions: ["service.catalog.view"] });
    await act(async () => { next.resolve({ user: { ...identity, permissions: ["service.catalog.view"] } }); });
    expect(await screen.findByRole("form", { name: "Serviço Exame autorizado" })).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole("button", { name: "Salvar Exame autorizado" })).not.toBeInTheDocument());
    expect(writes(mock)).toHaveLength(0);
  });

  it("discards a former authority's delayed catalog after a newer denied snapshot", async () => {
    const { mock, reads, setIdentity } = setup(["service.catalog.update", "department.view"]); await open();
    await screen.findByRole("form", { name: "Serviço Exame autorizado" });
    const old = deferred<DiagnosticService[]>(); reads.catalog = old.promise;
    act(() => window.dispatchEvent(new Event("cvg:realtime-resync")));
    await waitFor(() => expect(mock.mock.calls.filter(([path]) => path === "/session/me")).toHaveLength(2));
    reads.catalog = undefined; setIdentity({ ...identity, id: "other-account", permissions: [] });
    act(() => window.dispatchEvent(new Event("cvg:realtime-resync")));
    await waitFor(() => expect(screen.queryByRole("form", { name: "Serviço Exame autorizado" })).not.toBeInTheDocument());
    await act(async () => { old.resolve([service]); });
    expect(screen.queryByRole("form", { name: "Serviço Exame autorizado" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Salvar Exame autorizado" })).not.toBeInTheDocument();
    expect(writes(mock)).toHaveLength(0);
  });
  it("keeps creation unavailable without its department directory grant, without fetching or fabricating a registered sector", async () => {
    const { mock } = setup(["service.catalog.create"]); await open();
    await screen.findByText("Nenhum setor ativo autorizado para criar serviços.");
    expect(mock.mock.calls.some(([path]) => path === "/departments?includeInactive=true")).toBe(false);
    expect(screen.queryByRole("form", { name: "Adicionar serviço" })).not.toBeInTheDocument();
    const row = await screen.findByRole("form", { name: "Serviço Exame autorizado" });
    expect(within(row).getByRole("button", { name: "Duplicar Exame autorizado" })).toBeDisabled();
    fireEvent.click(within(row).getByRole("button", { name: "Duplicar Exame autorizado" }));
    fireEvent.submit(row);
    expect(writes(mock)).toHaveLength(0);
  });
});

describe("Clinical catalog and privacy authority", () => {
  it.each([{ permissions: [] }, { permissions: ["audit.view"] }, { permissions: ["service.catalog.view"] }] satisfies { permissions: Permission[] }[])("does not show privacy export for ADMIN without its effective grant ($permissions)", async ({ permissions }) => {
    const { mock } = setup(permissions);
    render(<AdminConsole />);
    await screen.findByRole("button", { name: "Atualizar" });
    expect(screen.queryByRole("heading", { name: "Privacidade (LGPD)" })).not.toBeInTheDocument();
    expect(screen.queryByText("Exportar dados do titular (LGPD)")).not.toBeInTheDocument();
    expect(writes(mock)).toHaveLength(0);
  });

  it("shows privacy only for a technical actor with the current grant, and unmounts it while authority is revalidated", async () => {
    const { mock, reads } = setup(["patient.data_export"]);
    render(<AdminConsole />);
    await screen.findByRole("heading", { name: "Privacidade (LGPD)" });
    fireEvent.change(screen.getByLabelText("Número do prontuário"), { target: { value: "SYNTHETIC-RECORD" } });
    const next = deferred<{ user: SessionUser }>(); reads.session = next.promise;
    act(() => window.dispatchEvent(new Event("cvg:realtime-resync")));
    expect(screen.queryByRole("heading", { name: "Privacidade (LGPD)" })).not.toBeInTheDocument();
    await act(async () => { next.resolve({ user: { ...identity, permissions: [] } }); });
    expect(screen.queryByText("Exportar dados do titular (LGPD)")).not.toBeInTheDocument();
    expect(writes(mock)).toHaveLength(0);
    cleanup(); vi.restoreAllMocks();
    const manager = setup(["patient.data_export"]);
    manager.setIdentity({ ...identity, role: "MANAGER", permissions: ["patient.data_export"] });
    render(<AdminConsole />);
    await screen.findByRole("button", { name: "Atualizar" });
    expect(screen.queryByText("Exportar dados do titular (LGPD)")).not.toBeInTheDocument();
  });

  it("lets an authorized clinical reader open the catalog and publish its draft without preparing or editing services", async () => {
    const panel: DiagnosticService = { ...service, resultSchema: "NUMERIC_PANEL", resultTemplate: { kind: "LABORATORY_PANEL", version: 1, code: "SYNTHETIC_PANEL", name: "Painel sintético", schemaVersion: "1.0", status: "DRAFT", analytes: [{ code: "SYNTHETIC", label: "Analito sintético", valueType: "NUMERIC", unitCode: "unit/test", required: true, displayOrder: 1, referenceRange: { kind: "PENDING_POLICY", unitCode: "unit/test", source: "PENDING_HUMAN_POLICY" } }] } };
    const { mock, setIdentity } = setup(["service.catalog.view", "exam_definition.approve"], [panel]);
    setIdentity({ ...identity, role: "VETERINARIAN", permissions: ["service.catalog.view", "exam_definition.approve"] });
    await open();
    const row = await screen.findByRole("form", { name: "Serviço Exame autorizado" });
    expect(within(row).getByLabelText("Nome")).toBeDisabled();
    expect(screen.queryByRole("form", { name: "Adicionar serviço" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Duplicar/ })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Definição, faixas e histórico de Exame autorizado" }));
    await screen.findByText(/Nenhuma revisão anterior registrada/);
    expect(screen.queryByRole("form", { name: "Preparar definição de Exame autorizado" })).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Referência da política clínica"), { target: { value: "SYNTHETIC-APPROVAL-ONLY" } });
    fireEvent.change(screen.getByLabelText("Espécies atendidas"), { target: { value: "CANINE" } });
    fireEvent.click(screen.getByLabelText("Confirmo a configuração clínica e a população atendida"));
    fireEvent.click(screen.getByRole("button", { name: "Aprovar e publicar painel" }));
    await waitFor(() => expect(writes(mock)).toHaveLength(1));
    expect(writes(mock)[0]).toEqual([`/diagnostic-services/${service.id}/template/publish`, { method: "POST", body: JSON.stringify({ policyReference: "SYNTHETIC-APPROVAL-ONLY", population: { species: ["CANINE"] }, confirm: true, expectedVersion: 7 }) }]);
    expect(mock.mock.calls.some(([path]) => path === "/users" || path === "/reason-codes")).toBe(false);
    expect(screen.queryByText("Exportar dados do titular (LGPD)")).not.toBeInTheDocument();
  });

  it("lets a clinical catalog.view-only reader consult definitions without preparation, approval or service writes", async () => {
    const { mock, setIdentity } = setup(["service.catalog.view"]);
    setIdentity({ ...identity, role: "VETERINARIAN", permissions: ["service.catalog.view"] });
    await open();
    fireEvent.click(await screen.findByRole("button", { name: "Definição, faixas e histórico de Exame autorizado" }));
    await screen.findByText(/Nenhuma revisão anterior registrada/);
    expect(screen.queryByRole("form", { name: /Preparar definição|Aprovar definição|Adicionar serviço/ })).not.toBeInTheDocument();
    expect(writes(mock)).toHaveLength(0);
    expect(mock.mock.calls.some(([path]) => path === "/users" || path === "/reason-codes")).toBe(false);
  });

  it.each([{ permissions: undefined }, { permissions: [] }, { permissions: ["exam_definition.approve"] }] satisfies { permissions: Permission[] | undefined }[])("denies a clinical catalog destination without catalog visibility ($permissions)", async ({ permissions }) => {
    const { mock, setIdentity } = setup(permissions);
    setIdentity({ ...identity, role: "VETERINARIAN", permissions });
    await open();
    expect(await screen.findByText("Administração fora do seu escopo")).toBeInTheDocument();
    expect(mock.mock.calls.some(([path]) => path.startsWith("/diagnostic-services"))).toBe(false);
    expect(writes(mock)).toHaveLength(0);
  });

  it.each(["all", "users"] as const)("keeps the existing %s administration boundary for clinical catalog readers", async (section) => {
    const { mock, setIdentity } = setup(["service.catalog.view", "exam_definition.approve"]);
    setIdentity({ ...identity, role: "VETERINARIAN", permissions: ["service.catalog.view", "exam_definition.approve"] });
    render(<AdminConsole section={section} />);
    expect(await screen.findByText("Administração fora do seu escopo")).toBeInTheDocument();
    expect(mock.mock.calls.some(([path]) => path === "/users" || path.startsWith("/diagnostic-services") || path === "/reason-codes")).toBe(false);
    expect(writes(mock)).toHaveLength(0);
  });
});

describe("Current catalog snapshot authority", () => {
  it.each([401, 403, 404])("evicts all catalog commands when its current read returns %s after a valid session", async (status) => {
    const { mock, reads } = setup(["service.catalog.create", "department.view"]); await open();
    await screen.findByRole("form", { name: "Adicionar serviço" });
    const next = deferred<DiagnosticService[]>(); reads.catalog = next.promise;
    act(() => window.dispatchEvent(new Event("cvg:realtime-resync")));
    await waitFor(() => expect(mock.mock.calls.filter(([path]) => path.startsWith("/diagnostic-services") && !path.endsWith("/definitions"))).toHaveLength(2));
    await act(async () => { next.reject(new client.ApiClientError(status, { error: { code: "SCOPE_DENIED" } })); });
    expect(await screen.findByText("Administração fora do seu escopo")).toBeInTheDocument();
    expect(screen.queryByRole("form", { name: "Adicionar serviço" })).not.toBeInTheDocument();
    expect(screen.queryByRole("form", { name: "Serviço Exame autorizado" })).not.toBeInTheDocument();
    expect(screen.queryByText("Importar catálogo por planilha")).not.toBeInTheDocument();
    expect(writes(mock)).toHaveLength(0);
  });

  it.each([
    { boundary: "account", next: { ...identity, id: "another-admin", permissions: ["service.catalog.update", "department.view"] as Permission[] } },
    { boundary: "department scope", next: { ...identity, departmentCode: "RADIOLOGY", permissions: ["service.catalog.update", "department.view"] as Permission[] } },
    { boundary: "effective permissions", next: { ...identity, permissions: ["service.catalog.view", "department.view"] as Permission[] } }
  ])("removes the previous $boundary snapshot before publishing the next actor's pending catalog", async ({ next: nextIdentity }) => {
    const { mock, reads, setIdentity } = setup(["service.catalog.update", "department.view"]); await open();
    const row = await screen.findByRole("form", { name: "Serviço Exame autorizado" });
    fireEvent.change(within(row).getByLabelText("Nome"), { target: { value: "Rascunho da autoridade anterior" } });
    const next = deferred<DiagnosticService[]>(); reads.catalog = next.promise; setIdentity(nextIdentity);
    act(() => window.dispatchEvent(new Event("cvg:realtime-resync")));
    await waitFor(() => expect(mock.mock.calls.filter(([path]) => path === "/session/me")).toHaveLength(2));
    await waitFor(() => expect(screen.queryByRole("form", { name: "Serviço Exame autorizado" })).not.toBeInTheDocument());
    expect(screen.queryByDisplayValue("Rascunho da autoridade anterior")).not.toBeInTheDocument();
    await act(async () => { next.resolve([]); });
    expect(screen.queryByRole("form", { name: "Serviço Exame autorizado" })).not.toBeInTheDocument();
    expect(writes(mock)).toHaveLength(0);
  });

  it("keeps the same authority's draft during explicit revalidation and does not refresh it for unrelated realtime activity", async () => {
    const { mock, reads } = setup(["service.catalog.update", "department.view"]); await open();
    const row = await screen.findByRole("form", { name: "Serviço Exame autorizado" });
    fireEvent.change(within(row).getByLabelText("Nome"), { target: { value: "Rascunho preservado" } });
    act(() => window.dispatchEvent(new Event("cvg:realtime-updated")));
    expect(mock.mock.calls.filter(([path]) => path === "/session/me")).toHaveLength(1);
    const next = deferred<DiagnosticService[]>(); reads.catalog = next.promise;
    act(() => window.dispatchEvent(new Event("cvg:realtime-resync")));
    await waitFor(() => expect(within(row).getByLabelText("Nome")).toBeDisabled());
    expect(within(row).getByLabelText("Nome")).toHaveValue("Rascunho preservado");
    fireEvent.submit(row); expect(writes(mock)).toHaveLength(0);
    await act(async () => { next.resolve([service]); });
    await waitFor(() => expect(within(row).getByLabelText("Nome")).toBeEnabled());
    expect(within(row).getByLabelText("Nome")).toHaveValue("Rascunho preservado");
  });

  it("keeps independently granted creation available after a partial 503 with current identity, rather than treating an outage as revocation", async () => {
    const { mock, reads } = setup(["service.catalog.create", "department.view"]); await open();
    await screen.findByRole("form", { name: "Adicionar serviço" });
    const next = deferred<DiagnosticService[]>(); reads.catalog = next.promise;
    act(() => window.dispatchEvent(new Event("cvg:realtime-resync")));
    await waitFor(() => expect(mock.mock.calls.filter(([path]) => path === "/session/me")).toHaveLength(2));
    await act(async () => { next.reject(new client.ApiClientError(503, { error: { code: "SERVICE_UNAVAILABLE" } })); });
    expect(await screen.findByText("Configuração parcialmente indisponível")).toBeInTheDocument();
    expect(screen.queryByText("Administração fora do seu escopo")).not.toBeInTheDocument();
    const form = screen.getByRole("form", { name: "Adicionar serviço" });
    expect(within(form).getByLabelText("Nome")).toBeEnabled();
    expect(writes(mock)).toHaveLength(0);
  });
});

describe("Current department directory authority", () => {
  it("keeps registered-sector creation unavailable after a native directory404 despite the current department.view grant", async () => {
    const { mock, reads } = setup(["service.catalog.create", "department.view"]);
    const directory = deferred<Department[]>(); reads.departments = directory.promise;
    await open();
    await waitFor(() => expect(mock).toHaveBeenCalledWith("/departments?includeInactive=true"));
    await act(async () => { directory.reject(new client.ApiClientError(404, { error: { code: "SCOPE_DENIED" } })); });
    await screen.findByText("Nenhum setor ativo autorizado para criar serviços.");
    expect(screen.queryByRole("form", { name: "Adicionar serviço" })).not.toBeInTheDocument();
    expect(within(serviceRow()).getByRole("button", { name: "Duplicar Exame autorizado" })).toBeDisabled();
    expect(writes(mock)).toHaveLength(0);
  });

  it("removes cached registered-sector choices as soon as department.view is withdrawn, even with an older directory read pending", async () => {
    const { mock, reads, setIdentity } = setup(["service.catalog.create", "department.view"]); await open();
    await screen.findByRole("form", { name: "Adicionar serviço" });
    const oldDirectory = deferred<Department[]>(); reads.departments = oldDirectory.promise;
    const nextIdentity = deferred<{ user: SessionUser }>(); reads.session = nextIdentity.promise;
    act(() => window.dispatchEvent(new Event("cvg:realtime-resync")));
    await waitFor(() => expect(mock.mock.calls.filter(([path]) => path === "/departments?includeInactive=true")).toHaveLength(2));
    const withdrawn: SessionUser = { ...identity, permissions: ["service.catalog.create"] }; setIdentity(withdrawn);
    await act(async () => { nextIdentity.resolve({ user: withdrawn }); });
    await waitFor(() => expect(screen.getByRole("button", { name: "Atualizar" })).toBeEnabled());
    expect(screen.queryByRole("form", { name: "Adicionar serviço" })).not.toBeInTheDocument();
    expect(screen.queryByRole("option", { name: "Laboratório cadastrado" })).not.toBeInTheDocument();
    expect(within(serviceRow()).getByRole("button", { name: "Duplicar Exame autorizado" })).toBeDisabled();
    await act(async () => { oldDirectory.resolve([department]); });
    expect(screen.queryByRole("form", { name: "Adicionar serviço" })).not.toBeInTheDocument();
    expect(writes(mock)).toHaveLength(0);
  });

  it("removes the former manager's registered-sector choices when department scope changes while its directory read is pending", async () => {
    const { mock, reads, setIdentity } = setup(["service.catalog.create", "department.view"], []);
    setIdentity({ ...identity, role: "MANAGER", departmentCode: "LABORATORY", permissions: ["service.catalog.create", "department.view"] });
    await open();
    await screen.findByRole("form", { name: "Adicionar serviço" });
    const oldDirectory = deferred<Department[]>(); reads.departments = oldDirectory.promise;
    const nextIdentity = deferred<{ user: SessionUser }>(); reads.session = nextIdentity.promise;
    act(() => window.dispatchEvent(new Event("cvg:realtime-resync")));
    await waitFor(() => expect(mock.mock.calls.filter(([path]) => path === "/departments?includeInactive=true")).toHaveLength(2));
    const transferred: SessionUser = { ...identity, role: "MANAGER", departmentCode: "RADIOLOGY", permissions: ["service.catalog.create", "department.view"] }; setIdentity(transferred); reads.departments = undefined;
    await act(async () => { nextIdentity.resolve({ user: transferred }); });
    await waitFor(() => expect(screen.getByRole("button", { name: "Atualizar" })).toBeEnabled());
    expect(screen.queryByRole("form", { name: "Adicionar serviço" })).not.toBeInTheDocument();
    expect(screen.queryByRole("option", { name: "Laboratório cadastrado" })).not.toBeInTheDocument();
    await act(async () => { oldDirectory.resolve([department]); });
    expect(screen.queryByRole("form", { name: "Adicionar serviço" })).not.toBeInTheDocument();
    expect(writes(mock)).toHaveLength(0);
  });
});
