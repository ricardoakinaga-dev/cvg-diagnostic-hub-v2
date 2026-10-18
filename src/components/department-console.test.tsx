/** @vitest-environment jsdom */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Department, ManagedUser, Permission } from "@cvg/contracts";
import { ApiClientError, apiFetch } from "./api-client";
import { DepartmentConsole } from "./department-console";

vi.mock("./api-client", async (original) => ({ ...await original<typeof import("./api-client")>(), apiFetch: vi.fn() }));
const sector: Department = { id: "department-oncology", code: "ONCOLOGY", name: "Oncologia veterinária", type: "DIAGNOSTIC", memberUserIds: ["user-oncology"], responsibleUserId: "user-oncology", active: true, version: 7, createdAt: "2026-10-11T00:00:00Z", updatedAt: "2026-10-11T00:00:00Z" };
const member: ManagedUser = { id: "user-oncology", displayName: "Dra. Ana", email: "ana@cvg.local", role: "VETERINARIAN", departmentCode: "ONCOLOGY", active: true, timezone: "UTC", createdAt: sector.createdAt, version: 1 };
const all: Permission[] = ["department.view", "department.create", "department.update", "department.deactivate", "department.members.manage"];
function mockApi(permissions = all, departments = [sector], command?: (path: string, init: RequestInit) => Promise<Department>) {
  return vi.mocked(apiFetch).mockImplementation(async (path, init) => {
    if (path === "/session/me") return { user: { id: "super", role: "SUPERADMIN", permissions } } as never;
    if (path === "/departments?includeInactive=true") return departments as never;
    if (path === `/departments/${sector.id}` && !init?.method) return { ...sector, pendingWork: { asOf: sector.updatedAt, scope: "AUTHORIZED_ONLY", diagnosticItems: 3, hospitalTasks: 2, intakes: 1 } } as never;
    if (path === "/users") return [member, { ...member, id: "foreign", displayName: "Outro setor", departmentCode: "LABORATORY" }, { ...member, id: "inactive", displayName: "Desativado", active: false }] as never;
    if (init?.method && command) return await command(path, init) as never;
    throw new Error(`Unexpected request ${path}`);
  });
}
afterEach(() => { cleanup(); vi.resetAllMocks(); });
describe("DepartmentConsole", () => {
  it("adds only eligible current members, removes an unavailable historical member and names a responsible without changing patient grants", async () => {
    mockApi(all, [{ ...sector, memberUserIds: ["historical"], responsibleUserId: "historical" }], async (_path, init) => ({ ...sector, ...JSON.parse(String(init.body)), version: 8 })); render(<DepartmentConsole />);
    const form = await screen.findByRole("form", { name: "Equipe do setor ONCOLOGY" }); await within(form).findByRole("checkbox", { name: "Dra. Ana" }); expect(within(form).getByRole("option", { name: "Responsável indisponível" })).toBeDisabled();
    fireEvent.click(within(form).getByRole("checkbox", { name: "Membro indisponível (historical)" })); fireEvent.click(within(form).getByRole("checkbox", { name: "Dra. Ana" })); fireEvent.change(within(form).getByLabelText("Responsável"), { target: { value: member.id } }); fireEvent.click(within(form).getByRole("button", { name: "Salvar equipe" }));
    await waitFor(() => expect(apiFetch).toHaveBeenCalledWith(`/departments/${sector.id}/members`, expect.objectContaining({ body: JSON.stringify({ memberUserIds: [member.id], responsibleUserId: member.id, expectedVersion: 7 }) })));
    const writes = vi.mocked(apiFetch).mock.calls.filter(([, init]) => init?.method); expect(writes).toHaveLength(1); expect(writes[0][0]).not.toContain("patient");
  });
  it("disables team mutation when its current users are unavailable and recovers through the real refresh event", async () => {
    const original = mockApi().getMockImplementation()!; let denied = true;
    let releaseDirectory!: (departments: Department[]) => void;
    const directory = new Promise<Department[]>((resolve) => { releaseDirectory = resolve; });
    vi.mocked(apiFetch).mockImplementation(async (path, init) => {
      if (path === "/departments?includeInactive=true") return await directory as never;
      if (path === "/users" && denied) throw new ApiClientError(503, { error: { code: "UNAVAILABLE" } });
      return original(path, init);
    }); render(<DepartmentConsole />);
    await screen.findByRole("alert");
    // The people request may fail before the independently loaded directory arrives.
    expect(screen.getByText("Carregando cadastro")).toBeInTheDocument();
    expect(screen.queryByRole("form", { name: "Equipe do setor ONCOLOGY" })).not.toBeInTheDocument();
    await act(async () => { releaseDirectory([sector]); await directory; });
    const form = await screen.findByRole("form", { name: "Equipe do setor ONCOLOGY" });
    expect(within(form).getByRole("button", { name: "Salvar equipe" })).toBeDisabled();
    expect(within(form).getByRole("checkbox", { name: "Membro indisponível (user-oncology)" })).toBeDisabled();
    denied = false; act(() => window.dispatchEvent(new Event("cvg:realtime-updated")));
    await within(form).findByRole("checkbox", { name: "Dra. Ana" });
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(within(form).getByRole("button", { name: "Salvar equipe" })).toBeEnabled();
    expect(vi.mocked(apiFetch).mock.calls.filter(([, init]) => init?.method)).toHaveLength(0);
  });
  it("cancels deactivation, edits the registered sector type with its revision and refreshes after a temporary directory error", async () => {
    const original = mockApi(all, [sector], async (_path, init) => ({ ...sector, ...JSON.parse(String(init.body)), version: 8 })).getMockImplementation()!; let denied = true;
    vi.mocked(apiFetch).mockImplementation(async (path, init) => { if (path === "/departments?includeInactive=true" && denied) throw new ApiClientError(503, { error: { code: "UNAVAILABLE" } }); return original(path, init); }); render(<DepartmentConsole />); await screen.findByRole("alert"); denied = false; fireEvent.click(screen.getByRole("button", { name: "Tentar novamente" }));
    fireEvent.click(await screen.findByRole("button", { name: "Desativar setor" })); fireEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Cancelar" })); await waitFor(() => expect(screen.getByRole("button", { name: "Salvar setor" })).toBeEnabled()); expect(vi.mocked(apiFetch).mock.calls.filter(([, init]) => init?.method)).toHaveLength(0);
    const form = screen.getByRole("form", { name: "Editar setor ONCOLOGY" }); fireEvent.change(within(form).getByLabelText("Tipo de setor"), { target: { value: "CLINICAL" } }); fireEvent.click(within(form).getByRole("button", { name: "Salvar setor" })); await screen.findByText(`Setor ${sector.name} salvo.`); expect(apiFetch).toHaveBeenCalledWith(`/departments/${sector.id}`, expect.objectContaining({ body: JSON.stringify({ name: sector.name, type: "CLINICAL", expectedVersion: 7 }) }));
    fireEvent.click(screen.getByRole("button", { name: "Atualizar setores" })); await waitFor(() => expect(screen.getByRole("button", { name: "Atualizar setores" })).toBeEnabled());
  });
  it("reports session denial without fetching sector or people metadata, and preserves an empty authorized directory without fabricating sectors", async () => {
    vi.mocked(apiFetch).mockRejectedValue(new ApiClientError(401, { error: { code: "AUTH_REQUIRED" } })); const first = render(<DepartmentConsole />); await screen.findByRole("heading", { name: "Setores indisponíveis" }); expect(apiFetch).not.toHaveBeenCalledWith("/users", expect.anything()); first.unmount();
    mockApi(["department.view"], []); render(<DepartmentConsole />); await screen.findByRole("heading", { name: "Nenhum setor autorizado" }); expect(screen.queryByRole("form")).not.toBeInTheDocument();
  });
  it("lists authorized persisted sectors, immutable code and the eligible team without granting patient scope", async () => {
    mockApi(); render(<DepartmentConsole />);
    const row = await screen.findByRole("article", { name: `Setor ${sector.name}` });
    expect(within(row).getByText("ONCOLOGY")).toBeInTheDocument();
    expect(within(row).queryByRole("textbox", { name: "Código do setor" })).not.toBeInTheDocument();
    expect(await within(row).findByRole("checkbox", { name: "Dra. Ana" })).toBeChecked();
    expect(within(row).queryByRole("checkbox", { name: "Outro setor" })).not.toBeInTheDocument();
    expect(within(row).queryByRole("checkbox", { name: "Desativado" })).not.toBeInTheDocument();
    expect(within(row).getByText("Participação e responsabilidade não concedem acesso a pacientes.")).toBeInTheDocument();
  });
  it("reuses the same command intent after an ambiguous creation failure and sends no immutable identifier patch", async () => {
    let attempts = 0;
    mockApi(all, [], async (_path, init) => { attempts += 1; if (attempts === 1) throw new Error("transport lost"); return { ...sector, ...JSON.parse(String(init.body)) }; });
    render(<DepartmentConsole />);
    const form = await screen.findByRole("form", { name: "Criar setor" });
    fireEvent.change(within(form).getByLabelText("Código do setor"), { target: { value: "ONCOLOGY" } });
    fireEvent.change(within(form).getByLabelText("Nome do setor"), { target: { value: sector.name } });
    fireEvent.change(within(form).getByLabelText("Tipo de setor"), { target: { value: "DIAGNOSTIC" } });
    fireEvent.click(within(form).getByRole("button", { name: "Criar setor" }));
    await screen.findByText("Não foi possível salvar o setor.");
    fireEvent.click(within(form).getByRole("button", { name: "Criar setor" }));
    await screen.findByText(`Setor ${sector.name} salvo.`);
    const posts = vi.mocked(apiFetch).mock.calls.filter(([path, init]) => path === "/departments" && init?.method === "POST");
    expect(posts).toHaveLength(2);
    expect(posts[1][1]).toEqual(posts[0][1]);
    expect(JSON.parse(String(posts[0][1]?.body))).toEqual({ code: "ONCOLOGY", name: sector.name, type: "DIAGNOSTIC" });
    expect(new Headers(posts[0][1]?.headers).get("idempotency-key")).toBeTruthy();
  });
  it("sends member removal and null responsibility with the department version", async () => {
    mockApi(all, [sector], async (_path, init) => ({ ...sector, ...JSON.parse(String(init.body)), responsibleUserId: undefined, version: 8 }));
    render(<DepartmentConsole />);
    const checkbox = await screen.findByRole("checkbox", { name: "Dra. Ana" });
    fireEvent.click(checkbox);
    expect(screen.getByRole("combobox", { name: "Responsável" })).toHaveValue("");
    fireEvent.click(screen.getByRole("button", { name: "Salvar equipe" }));
    await waitFor(() => expect(apiFetch).toHaveBeenCalledWith(`/departments/${sector.id}/members`, expect.objectContaining({ method: "PUT", body: JSON.stringify({ memberUserIds: [], responsibleUserId: null, expectedVersion: 7 }) })));
  });
  it("reports a stale version without claiming success or overwriting the entered name", async () => {
    mockApi(all, [sector], async () => { throw new ApiClientError(409, { error: { code: "STALE_VERSION" } }); });
    render(<DepartmentConsole />);
    const form = await screen.findByRole("form", { name: "Editar setor ONCOLOGY" });
    fireEvent.change(within(form).getByLabelText("Nome do setor"), { target: { value: "Oncologia corrigida" } });
    fireEvent.click(within(form).getByRole("button", { name: "Salvar setor" }));
    await screen.findByText("Os dados mudaram enquanto você trabalhava. Atualize a tela antes de continuar.");
    expect(within(form).getByLabelText("Nome do setor")).toHaveValue("Oncologia corrigida");
    expect(screen.queryByText(/salvo\./)).not.toBeInTheDocument();
    const patch = vi.mocked(apiFetch).mock.calls.find(([, init]) => init?.method === "PATCH");
    expect(JSON.parse(String(patch?.[1]?.body))).toEqual({ name: "Oncologia corrigida", type: "DIAGNOSTIC", expectedVersion: 7 });
  });
  it("requires confirmation to deactivate and uses a dedicated versioned command", async () => {
    mockApi(all, [sector], async () => ({ ...sector, active: false, version: 8 })); render(<DepartmentConsole />);
    fireEvent.click(await screen.findByRole("button", { name: "Desativar setor" }));
    const dialog = await screen.findByRole("dialog", { name: `Desativar ${sector.name}?` });
    expect(within(dialog).getByText(/exames: 3; tarefas: 2; demandas: 1/)).toBeInTheDocument();
    expect(within(dialog).getByText(/Somente pendências dentro do seu acesso/)).toBeInTheDocument();
    expect(apiFetch).not.toHaveBeenCalledWith(expect.stringContaining("/deactivate"), expect.anything());
    fireEvent.click(within(dialog).getByRole("button", { name: "Desativar setor" }));
    await waitFor(() => expect(apiFetch).toHaveBeenCalledWith(`/departments/${sector.id}/deactivate`, expect.objectContaining({ method: "POST", body: JSON.stringify({ expectedVersion: 7 }) })));
  });
  it("does not offer deactivation when the fresh pending-work consultation fails, and recovers on retry", async () => {
    const original = mockApi(all, [sector], async () => ({ ...sector, active: false, version: 8 })).getMockImplementation()!;
    let failed = true;
    vi.mocked(apiFetch).mockImplementation(async (path, init) => {
      if (path === `/departments/${sector.id}` && !init?.method && failed) throw new ApiClientError(503, { error: { code: "UNAVAILABLE" } });
      return original(path, init);
    });
    render(<DepartmentConsole />);
    fireEvent.click(await screen.findByRole("button", { name: "Desativar setor" }));
    await screen.findByText("Não foi possível concluir a operação. Informe o código de correlação ao suporte.");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(vi.mocked(apiFetch).mock.calls.filter(([, init]) => init?.method)).toHaveLength(0);
    failed = false;
    fireEvent.click(screen.getByRole("button", { name: "Desativar setor" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancelar" }));
    expect(vi.mocked(apiFetch).mock.calls.filter(([, init]) => init?.method)).toHaveLength(0);
  });
  it("distinguishes unavailable clinical counts from zero and rejects a stale or revoked preview", async () => {
    const original = mockApi().getMockImplementation()!;
    let result: Department = { ...sector, pendingWork: { asOf: sector.updatedAt, scope: "AUTHORIZED_ONLY", diagnosticItems: null, hospitalTasks: 0, intakes: null } };
    vi.mocked(apiFetch).mockImplementation(async (path, init) => path === `/departments/${sector.id}` && !init?.method ? result as never : original(path, init));
    render(<DepartmentConsole />);
    fireEvent.click(await screen.findByRole("button", { name: "Desativar setor" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText(/exames: sem acesso; tarefas: 0; demandas: sem acesso/)).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancelar" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Desativar setor" })).toBeEnabled());
    result = { ...result, version: 8 };
    fireEvent.click(screen.getByRole("button", { name: "Desativar setor" }));
    await screen.findByText("O setor mudou. Atualize os setores antes de desativar.");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    result = { ...sector };
    fireEvent.click(screen.getByRole("button", { name: "Desativar setor" }));
    await screen.findByText("Não foi possível consultar as pendências do setor.");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(vi.mocked(apiFetch).mock.calls.filter(([, init]) => init?.method)).toHaveLength(0);
  });
  it("keeps one pending consultation and cancels it when the sector row leaves the screen", async () => {
    const original = mockApi().getMockImplementation()!;
    let release!: (result: Department) => void;
    const pending = new Promise<Department>((resolve) => { release = resolve; });
    vi.mocked(apiFetch).mockImplementation(async (path, init) => path === `/departments/${sector.id}` && !init?.method ? await pending as never : original(path, init));
    const view = render(<DepartmentConsole />);
    const button = await screen.findByRole("button", { name: "Desativar setor" });
    fireEvent.click(button); fireEvent.click(button);
    expect(button).toBeDisabled();
    expect(vi.mocked(apiFetch).mock.calls.filter(([path, init]) => path === `/departments/${sector.id}` && !init?.method)).toHaveLength(1);
    const request = vi.mocked(apiFetch).mock.calls.find(([path]) => path === `/departments/${sector.id}`)!;
    view.unmount();
    expect(request[1]?.signal?.aborted).toBe(true);
    await act(async () => { release({ ...sector, pendingWork: { asOf: sector.updatedAt, scope: "AUTHORIZED_ONLY", diagnosticItems: 0, hospitalTasks: 0, intakes: 0 } }); await pending; });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(vi.mocked(apiFetch).mock.calls.filter(([, init]) => init?.method)).toHaveLength(0);
  });
  it("keeps a deactivated sector readable and allows only explicit reactivation", async () => {
    mockApi(all, [{ ...sector, active: false }], async () => sector); render(<DepartmentConsole />);
    const button = await screen.findByRole("button", { name: "Reativar setor" });
    expect(screen.queryByRole("button", { name: "Salvar equipe" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Desativar setor" })).not.toBeInTheDocument();
    fireEvent.click(button);
    await waitFor(() => expect(apiFetch).toHaveBeenCalledWith(`/departments/${sector.id}`, expect.objectContaining({ method: "PATCH", body: JSON.stringify({ active: true, expectedVersion: 7 }) })));
  });
  it("fails closed for absent grants and keeps a view-only department free of mutation controls", async () => {
    mockApi(["department.view"]); render(<DepartmentConsole />);
    await screen.findByRole("article", { name: `Setor ${sector.name}` });
    for (const name of ["Criar setor", "Salvar setor", "Salvar equipe", "Desativar setor"]) expect(screen.queryByRole("button", { name })).not.toBeInTheDocument();
    expect(apiFetch).not.toHaveBeenCalledWith("/users", expect.anything());
  });
});
