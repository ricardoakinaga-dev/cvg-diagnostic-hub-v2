/** @vitest-environment jsdom */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HospitalService, Permission } from "@cvg/contracts";
import { HospitalServiceConsole } from "./hospital-service-console";
import { HospitalServiceForm } from "./hospital-service-forms";
import { HospitalServiceImport } from "./hospital-service-import";
import * as apiClient from "./api-client";

vi.mock("next/link", () => ({ default: ({ children, ...props }: { children: React.ReactNode; href: string }) => <a {...props}>{children}</a> }));
vi.mock("next/navigation", () => ({ useSearchParams: () => new URLSearchParams(window.location.search) }));
const department = { id: "department-nursing", code: "NURSING", name: "Enfermagem", active: true, type: "CLINICAL" as const, memberUserIds: ["nurse"] };
const service: HospitalService = { id: "capacity", code: "CARE", name: "Cuidado sintético", kind: "CARE", departmentCode: "NURSING", active: true, version: 2, createdAt: "2026-10-11T12:00:00Z", updatedAt: "2026-10-11T13:00:00Z", teamUserIds: [], resourceIds: [] };
const session = (permissions: Permission[], id = "admin") => ({ user: { id, role: "ADMIN", displayName: "Gestor", departmentCode: "IT", permissions } });
const row = { ...service, source: "HOSPITAL_SERVICE" as const };
const user = { id: "nurse", displayName: "Enfermeira sintética", departmentCode: "NURSING", active: true };
afterEach(() => { cleanup(); vi.restoreAllMocks(); window.history.replaceState({}, "", "/"); });
describe("hospital service administration", () => {
  it("refreshes actual catalog results after creating, revising and explicitly applying a validated import", async () => {
    let rows = [row]; let listReads = 0;
    const report = { applied: false, dryRun: true, rows: [{ line: 2, code: "IMPORTED", action: "CREATE" }], summary: { create: 1, update: 0, unchanged: 0, error: 0 } };
    const read = vi.spyOn(apiClient, "apiFetch").mockImplementation(async (path, init) => {
      if (path === "/session/me") return session(["service.catalog.view", "service.catalog.create", "service.catalog.update", "user.view"]) as never;
      if (path === "/users") return [user] as never;
      if (path.startsWith("/departments")) return [department] as never;
      if (path.startsWith("/hospital-services?")) { listReads++; return { items: rows, total: rows.length } as never; }
      if (path === "/hospital-services") { rows = [...rows, { ...row, id: "created", name: "Nova capacidade", code: "CREATED" }]; return rows[1] as never; }
      if (path === "/hospital-services/capacity") { rows = rows.map((entry) => entry.id === "capacity" ? { ...entry, name: "Cuidado revisado", version: 3 } : entry); return rows[0] as never; }
      if (path === "/hospital-services/import") { const body = JSON.parse(init!.body as string); if (body.dryRun) return report as never; rows = [...rows, { ...row, id: "imported", name: "Capacidade importada", code: "IMPORTED" }]; return { ...report, applied: true, dryRun: false } as never; }
      throw new Error("Unexpected synthetic request");
    });
    render(<HospitalServiceConsole />); const form = await screen.findByRole("form", { name: "Novo serviço hospitalar" }); await within(form).findByRole("option", { name: "Enfermagem" }); fireEvent.change(within(form).getByLabelText("Setor do serviço"), { target: { value: "NURSING" } }); fireEvent.change(within(form).getByLabelText("Código do serviço"), { target: { value: "CREATED" } }); fireEvent.change(within(form).getByLabelText("Nome do serviço"), { target: { value: "Nova capacidade" } }); fireEvent.click(within(form).getByRole("button", { name: "Cadastrar serviço" })); await screen.findByRole("heading", { name: "Nova capacidade · Ativo" });
    const editor = screen.getByRole("form", { name: "Editar Cuidado sintético" }); fireEvent.change(within(editor).getByLabelText("Nome do serviço"), { target: { value: "Cuidado revisado" } }); fireEvent.click(within(editor).getByRole("button", { name: "Salvar serviço" })); await screen.findByRole("heading", { name: "Cuidado revisado · Ativo" });
    fireEvent.change(screen.getByLabelText("Conteúdo CSV"), { target: { value: "validated-csv" } }); fireEvent.click(screen.getByRole("button", { name: "Validar importação" })); await waitFor(() => expect(screen.getByRole("button", { name: "Aplicar importação validada" })).toBeEnabled()); fireEvent.click(screen.getByRole("button", { name: "Aplicar importação validada" })); await screen.findByRole("heading", { name: "Capacidade importada · Ativo" }); expect(listReads).toBe(4); expect(read.mock.calls.filter(([, init]) => init?.method)).toHaveLength(4);
  });
  it("finds a deep-linked authorized catalog service through real pagination without exposing another scope", async () => {
    window.history.replaceState({}, "", "/admin/hospital-services?serviceId=second");
    vi.spyOn(apiClient, "apiFetch").mockImplementation(async (path) => path === "/session/me" ? session(["service.catalog.view"]) as never : path.startsWith("/departments") ? [] as never : { items: path.includes("cursor=") ? [{ ...row, id: "second", name: "Serviço alvo" }] : [row], total: 2, ...(path.includes("cursor=") ? {} : { nextCursor: "next" }) } as never);
    render(<HospitalServiceConsole />); await screen.findByRole("heading", { name: "Serviço alvo · Ativo" }); expect(document.getElementById("hospital-service-second")).toHaveFocus(); expect(screen.queryByRole("form")).not.toBeInTheDocument();
  });
  it("updates only service metadata and current revision while preserving registered resource links", async () => {
    const saved = vi.fn(); const read = vi.spyOn(apiClient, "apiFetch").mockResolvedValue(service as never);
    render(<HospitalServiceForm service={{ ...service, description: "Texto anterior", teamUserIds: ["historical"], resourceIds: ["resource"] }} departments={[department] as never} users={[user] as never} permissions={["service.catalog.update"]} refreshing={false} onSaved={saved} />);
    expect(screen.queryByLabelText("Código do serviço")).not.toBeInTheDocument(); fireEvent.change(screen.getByLabelText("Nome do serviço"), { target: { value: "Cuidado revisado" } }); fireEvent.change(screen.getByLabelText("Descrição"), { target: { value: "" } }); fireEvent.change(screen.getByLabelText("Tipo de capacidade"), { target: { value: "PROCEDURE" } });
    fireEvent.click(screen.getByRole("button", { name: "Retirar vínculo indisponível" })); fireEvent.click(screen.getByRole("checkbox", { name: user.displayName })); fireEvent.click(screen.getByRole("button", { name: "Salvar serviço" })); await waitFor(() => expect(saved).toHaveBeenCalledOnce());
    expect(JSON.parse(read.mock.calls[0][1]!.body as string)).toEqual({ name: "Cuidado revisado", description: null, kind: "PROCEDURE", departmentCode: "NURSING", teamUserIds: ["nurse"], resourceIds: ["resource"], expectedVersion: 2 }); expect(read.mock.calls[0][0]).toBe("/hospital-services/capacity");
  });
  it("clears descriptive team selection on a sector change and includes only active registered sector members", async () => {
    const read = vi.spyOn(apiClient, "apiFetch").mockResolvedValue(service as never);
    const surgery = { ...department, id: "surgery", code: "SURGERY", name: "Cirurgia", memberUserIds: ["surgeon"] };
    render(<HospitalServiceForm departments={[department, surgery, { ...department, id: "retired", code: "RETIRED", name: "Setor retirado", active: false }] as never} users={[user, { ...user, id: "other", displayName: "Não membro" }, { ...user, id: "inactive", active: false }, { ...user, id: "surgeon", displayName: "Cirurgião", departmentCode: "SURGERY" }] as never} permissions={["service.catalog.create"]} refreshing={false} onSaved={vi.fn()} />);
    expect(screen.queryByRole("checkbox", { name: "Não membro" })).not.toBeInTheDocument(); expect(screen.queryByRole("option", { name: "Setor retirado" })).not.toBeInTheDocument(); fireEvent.click(screen.getByRole("checkbox", { name: user.displayName })); fireEvent.change(screen.getByLabelText("Setor do serviço"), { target: { value: "SURGERY" } }); fireEvent.click(screen.getByRole("checkbox", { name: "Cirurgião" })); fireEvent.click(screen.getByRole("checkbox", { name: "Cirurgião" }));
    fireEvent.change(screen.getByLabelText("Código do serviço"), { target: { value: "op_one" } }); fireEvent.change(screen.getByLabelText("Nome do serviço"), { target: { value: "Rotina do setor" } }); fireEvent.change(screen.getByLabelText("Descrição"), { target: { value: "Capacidade operacional" } }); fireEvent.change(screen.getByLabelText("Tipo de capacidade"), { target: { value: "OPERATIONAL" } }); fireEvent.click(screen.getByRole("button", { name: "Cadastrar serviço" })); await waitFor(() => expect(read).toHaveBeenCalledOnce());
    expect(JSON.parse(read.mock.calls[0][1]!.body as string)).toMatchObject({ code: "OP_ONE", departmentCode: "SURGERY", teamUserIds: [], description: "Capacidade operacional", kind: "OPERATIONAL" }); expect(screen.getByLabelText("Nome do serviço")).toHaveValue("");
  });
  it("preserves a conflicted service edit and reuses its exact intent while blocking duplicate in-flight submissions", async () => {
    const saved = vi.fn(); let release!: (value: unknown) => void;
    const read = vi.spyOn(apiClient, "apiFetch").mockRejectedValueOnce(new apiClient.ApiClientError(409, { error: { code: "STALE_VERSION" } })).mockImplementation(async () => await new Promise<unknown>((resolve) => { release = resolve; }) as never);
    render(<HospitalServiceForm service={service} departments={[department] as never} users={[]} permissions={["service.catalog.update"]} refreshing={false} onSaved={saved} />); fireEvent.change(screen.getByLabelText("Nome do serviço"), { target: { value: "Intenção preservada" } }); fireEvent.click(screen.getByRole("button", { name: "Salvar serviço" })); await screen.findByRole("alert"); expect(saved).not.toHaveBeenCalled(); expect(screen.getByLabelText("Nome do serviço")).toHaveValue("Intenção preservada");
    act(() => { fireEvent.submit(screen.getByRole("form", { name: "Editar Cuidado sintético" })); fireEvent.submit(screen.getByRole("form", { name: "Editar Cuidado sintético" })); }); await waitFor(() => expect(read).toHaveBeenCalledTimes(2)); expect(read.mock.calls[0][1]).toEqual(read.mock.calls[1][1]); expect(screen.getByRole("button", { name: "Salvar serviço" })).toBeDisabled(); await act(async () => release(service)); expect(saved).toHaveBeenCalledOnce();
  });
  it("keeps historical service sectors readable but refuses reactivation without an active registered sector", async () => {
    const read = vi.spyOn(apiClient, "apiFetch").mockResolvedValue(service as never);
    const first = render(<HospitalServiceForm service={{ ...service, active: false }} departments={[{ ...department, active: false }] as never} users={[]} permissions={["service.catalog.update"]} refreshing={false} onSaved={vi.fn()} />); expect(screen.getByRole("option", { name: "Enfermagem (inativo)" })).toBeInTheDocument(); expect(screen.getByRole("button", { name: "Reativar serviço" })).toBeDisabled(); first.unmount();
    render(<HospitalServiceForm service={{ ...service, active: false }} departments={[department] as never} users={[]} permissions={["service.catalog.update"]} refreshing={false} onSaved={vi.fn()} />); fireEvent.click(screen.getByRole("button", { name: "Reativar serviço" })); await waitFor(() => expect(read).toHaveBeenCalledOnce()); expect(JSON.parse(read.mock.calls[0][1]!.body as string)).toEqual({ active: true, expectedVersion: 2 });
  });
  it("continues reading historical code when its directory is absent and disables all edits during refresh", () => {
    const read = vi.spyOn(apiClient, "apiFetch"); render(<HospitalServiceForm service={service} departments={[]} users={[]} permissions={["service.catalog.manage"]} refreshing onSaved={vi.fn()} />); expect(screen.getByRole("option", { name: "NURSING" })).toBeInTheDocument(); expect(screen.getByRole("button", { name: "Salvar serviço" })).toBeDisabled(); expect(screen.getByRole("button", { name: "Desativar serviço" })).toBeDisabled(); fireEvent.submit(screen.getByRole("form", { name: "Editar Cuidado sintético" })); expect(read).not.toHaveBeenCalled();
  });
  it("applies the same validated CSV snapshot explicitly and reports actual creates, updates and unchanged rows", async () => {
    const saved = vi.fn(); const report = { applied: false, dryRun: true, rows: [{ line: 2, code: "CARE", action: "CREATE" }, { line: 3, code: "UPDATED", action: "UPDATE" }, { line: 4, code: "UNCHANGED", action: "UNCHANGED" }], summary: { create: 1, update: 1, unchanged: 1, error: 0 } };
    const read = vi.spyOn(apiClient, "apiFetch").mockResolvedValueOnce(report as never).mockResolvedValueOnce({ ...report, applied: true, dryRun: false } as never); render(<HospitalServiceImport onSaved={saved} />);
    fireEvent.change(screen.getByLabelText("Conteúdo CSV"), { target: { value: "codigo;nome;tipo;setor\nCARE;Cuidado;CARE;NURSING" } }); fireEvent.click(screen.getByRole("button", { name: "Validar importação" })); await waitFor(() => expect(screen.getByRole("button", { name: "Aplicar importação validada" })).toBeEnabled()); expect(saved).not.toHaveBeenCalled(); expect(screen.getByRole("cell", { name: "Sem alteração" })).toBeInTheDocument(); fireEvent.click(screen.getByRole("button", { name: "Aplicar importação validada" })); await waitFor(() => expect(saved).toHaveBeenCalledOnce());
    expect(read.mock.calls.map(([, init]) => JSON.parse(init!.body as string).dryRun)).toEqual([true, false]); expect(read.mock.calls[0][1]!.headers).toEqual(read.mock.calls[1][1]!.headers); expect(screen.getByRole("status")).toHaveTextContent("Importação aplicada: 1 novos, 1 alterações, 1 iguais, 0 erros"); expect(screen.getByRole("button", { name: "Aplicar importação validada" })).toBeDisabled();
  });
  it("keeps an invalid import in preview and retains an ambiguous apply intent for retry", async () => {
    const saved = vi.fn(); const valid = { applied: false, dryRun: true, rows: [{ line: 2, code: "CARE", action: "CREATE" }], summary: { create: 1, update: 0, unchanged: 0, error: 0 } };
    const read = vi.spyOn(apiClient, "apiFetch").mockResolvedValueOnce({ ...valid, rows: [{ line: 2, code: "BAD", action: "ERROR", errors: ["Setor inativo", "Revisão desatualizada"] }], summary: { ...valid.summary, error: 1 } } as never).mockResolvedValueOnce(valid as never).mockRejectedValueOnce(new Error("Ambiguous transport")).mockResolvedValueOnce({ ...valid, applied: true } as never);
    render(<HospitalServiceImport onSaved={saved} />); fireEvent.change(screen.getByLabelText("Conteúdo CSV"), { target: { value: "invalid" } }); fireEvent.click(screen.getByRole("button", { name: "Validar importação" })); await screen.findByRole("cell", { name: "Erro: Setor inativo Revisão desatualizada" }); expect(screen.getByRole("button", { name: "Aplicar importação validada" })).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Conteúdo CSV"), { target: { value: "valid" } }); fireEvent.click(screen.getByRole("button", { name: "Validar importação" })); await waitFor(() => expect(screen.getByRole("button", { name: "Aplicar importação validada" })).toBeEnabled()); fireEvent.click(screen.getByRole("button", { name: "Aplicar importação validada" })); await screen.findByRole("alert"); expect(saved).not.toHaveBeenCalled(); fireEvent.click(screen.getByRole("button", { name: "Aplicar importação validada" })); await waitFor(() => expect(saved).toHaveBeenCalledOnce()); expect(read.mock.calls[2][1]).toEqual(read.mock.calls[3][1]); expect(read.mock.calls[0][1]!.headers).not.toEqual(read.mock.calls[1][1]!.headers);
  });
  it("loads CSV from a readable file and rejects oversized or unreadable files without attempting import", async () => {
    const read = vi.spyOn(apiClient, "apiFetch"); render(<HospitalServiceImport onSaved={vi.fn()} />); const input = screen.getByLabelText("Planilha de serviços"); fireEvent.change(input, { target: { files: [] } }); expect(read).not.toHaveBeenCalled();
    const large = new File(["x".repeat(2_000_001)], "too-large.csv", { type: "text/csv" }); fireEvent.change(input, { target: { files: [large] } }); expect(screen.getByRole("alert")).toHaveTextContent("até 2 MB");
    const broken = new File(["x"], "broken.csv"); Object.defineProperty(broken, "text", { value: async () => { throw new Error("File unavailable"); } }); fireEvent.change(input, { target: { files: [broken] } }); await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("ler a planilha"));
    const file = new File(["codigo;nome"], "services.csv"); Object.defineProperty(file, "text", { value: async () => "codigo;nome" }); fireEvent.change(input, { target: { files: [file] } }); await waitFor(() => expect(screen.getByLabelText("Conteúdo CSV")).toHaveValue("codigo;nome")); expect(screen.getByRole("button", { name: "Aplicar importação validada" })).toBeDisabled(); expect(read).not.toHaveBeenCalled();
  });
  it("uses authorized users for descriptive service teams and allows refresh after a temporary catalog failure", async () => {
    let failed = true; const read = vi.spyOn(apiClient, "apiFetch").mockImplementation(async (path) => { if (path === "/session/me") return session(["service.catalog.view", "service.catalog.update", "user.view"]) as never; if (path === "/users") return [user] as never; if (path.startsWith("/departments")) return [department] as never; if (failed) throw new Error("temporary"); return { items: [row], total: 1 } as never; });
    render(<HospitalServiceConsole />); await screen.findByRole("alert"); failed = false; fireEvent.click(screen.getByRole("button", { name: "Tentar novamente" })); const editor = await screen.findByRole("form", { name: "Editar Cuidado sintético" }); expect(await within(editor).findByRole("checkbox", { name: user.displayName })).toBeInTheDocument(); expect(read).toHaveBeenCalledWith("/users");
  });
  it("withdraws catalog rows and command controls after a denied continuation", async () => {
    vi.spyOn(apiClient, "apiFetch").mockImplementation(async (path) => path === "/session/me" ? session(["service.catalog.view", "service.catalog.create"]) as never : path.startsWith("/departments") ? [department] as never : path.includes("cursor=") ? Promise.reject(new apiClient.ApiClientError(404, { error: { code: "SCOPE_DENIED" } })) : { items: [row], total: 2, nextCursor: "next" } as never);
    render(<HospitalServiceConsole />); fireEvent.click(await screen.findByRole("button", { name: "Carregar mais serviços" })); await screen.findByRole("alert"); expect(screen.queryByRole("heading", { name: "Cuidado sintético · Ativo" })).not.toBeInTheDocument(); expect(screen.queryByRole("form")).not.toBeInTheDocument(); expect(screen.queryByRole("button", { name: "Validar importação" })).not.toBeInTheDocument();
  });
  it("keeps catalog viewers read-only and projects diagnostics with a link to their authority", async () => {
    vi.spyOn(apiClient, "apiFetch").mockImplementation((path) => Promise.resolve(path === "/session/me" ? session(["service.catalog.view"]) : path.startsWith("/departments") ? [department] : { items: [row, { source: "DIAGNOSTIC_SERVICE", id: "diagnostic", code: "DIAG", name: "Exame diagnóstico", kind: "DIAGNOSTIC", departmentCode: "NURSING", active: true, version: 4, teamUserIds: [], resourceIds: [] }], total: 2 }) as never);
    render(<HospitalServiceConsole />);
    expect(await screen.findByRole("heading", { name: "Cuidado sintético · Ativo" })).toBeInTheDocument();
    expect(screen.queryByRole("form")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Desativar serviço" })).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Abrir catálogo de exames" })).toHaveAttribute("href", "/admin/catalog");
  });
  it("creates a care capability using a registered sector and descriptive team", async () => {
    const saved = vi.fn(); const read = vi.spyOn(apiClient, "apiFetch").mockResolvedValue(service as never);
    render(<HospitalServiceForm departments={[department] as never} users={[{ id: "nurse", displayName: "Enfermeira sintética", departmentCode: "NURSING", active: true }] as never} permissions={["service.catalog.create"]} refreshing={false} onSaved={saved} />);
    fireEvent.change(screen.getByLabelText("Código do serviço"), { target: { value: "new_care" } });
    fireEvent.change(screen.getByLabelText("Nome do serviço"), { target: { value: "Cuidado novo" } });
    fireEvent.click(screen.getByLabelText("Enfermeira sintética"));
    fireEvent.submit(screen.getByRole("form", { name: "Novo serviço hospitalar" }));
    await waitFor(() => expect(saved).toHaveBeenCalledOnce());
    const command = read.mock.calls[0];
    expect(command[0]).toBe("/hospital-services");
    expect(command[1]?.headers).toHaveProperty("idempotency-key");
    expect(JSON.parse(command[1]!.body as string)).toMatchObject({ code: "NEW_CARE", departmentCode: "NURSING", teamUserIds: ["nurse"], resourceIds: [] });
    expect(screen.getByText(/mantém os acessos clínicos atuais/)).toBeInTheDocument();
  });
  it("allows only deactivation for a narrowed grant and submits the current revision", async () => {
    const read = vi.spyOn(apiClient, "apiFetch").mockResolvedValue(service as never);
    render(<HospitalServiceForm service={service} departments={[department] as never} users={[]} permissions={["service.catalog.deactivate"]} refreshing={false} onSaved={vi.fn()} />);
    expect(screen.queryByRole("form")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Desativar serviço" }));
    await waitFor(() => expect(read).toHaveBeenCalledOnce());
    expect(JSON.parse(read.mock.calls[0][1]!.body as string)).toEqual({ active: false, expectedVersion: 2 });
  });
  it("retries a failed continuation without discarding or duplicating confirmed services", async () => {
    let failed = false;
    vi.spyOn(apiClient, "apiFetch").mockImplementation((path) => { if (path === "/session/me") return Promise.resolve(session(["service.catalog.view"])) as never; if (path.startsWith("/departments")) return Promise.resolve([department]) as never; if (path.includes("cursor=")) { if (!failed) { failed = true; return Promise.reject(new Error("temporary")) as never; } return Promise.resolve({ items: [row, { ...row, id: "second", code: "SECOND", name: "Segundo serviço" }], total: 2 }) as never; } return Promise.resolve({ items: [row], total: 2, nextCursor: "continue" }) as never; });
    render(<HospitalServiceConsole />);
    fireEvent.click(await screen.findByRole("button", { name: "Carregar mais serviços" }));
    await screen.findByRole("alert");
    expect(screen.getByRole("heading", { name: "Cuidado sintético · Ativo" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Carregar mais serviços" }));
    await screen.findByRole("heading", { name: "Segundo serviço · Ativo" });
    expect(screen.getAllByRole("heading", { name: "Cuidado sintético · Ativo" })).toHaveLength(1);
    expect(screen.queryByRole("button", { name: "Carregar mais serviços" })).not.toBeInTheDocument();
  });
  it("clears catalog and management controls after an authorization refusal on refresh", async () => {
    let denied = false;
    vi.spyOn(apiClient, "apiFetch").mockImplementation((path) => { if (path === "/session/me") return denied ? Promise.reject(new apiClient.ApiClientError(401, { error: { code: "AUTH_REQUIRED", message: "Expired" } })) as never : Promise.resolve(session(["service.catalog.view", "service.catalog.create"])) as never; if (path.startsWith("/departments")) return Promise.resolve([department]) as never; return Promise.resolve({ items: [row], total: 1 }) as never; });
    render(<HospitalServiceConsole />);
    await screen.findByRole("heading", { name: "Cuidado sintético · Ativo" });
    denied = true; act(() => window.dispatchEvent(new Event("cvg:realtime-updated")));
    await screen.findByRole("alert");
    expect(screen.queryByRole("heading", { name: "Cuidado sintético · Ativo" })).not.toBeInTheDocument();
    expect(screen.queryByRole("form")).not.toBeInTheDocument();
  });
  it("requires an unchanged error-free preview before applying CSV", async () => {
    const read = vi.spyOn(apiClient, "apiFetch").mockResolvedValue({ applied: false, dryRun: true, rows: [{ line: 2, code: "CARE", action: "CREATE" }], summary: { create: 1, update: 0, unchanged: 0, error: 0 } } as never);
    render(<HospitalServiceImport onSaved={vi.fn()} />);
    const apply = screen.getByRole("button", { name: "Aplicar importação validada" });
    expect(apply).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Conteúdo CSV"), { target: { value: "first-csv" } });
    fireEvent.click(screen.getByRole("button", { name: "Validar importação" }));
    await waitFor(() => expect(apply).toBeEnabled());
    fireEvent.change(screen.getByLabelText("Conteúdo CSV"), { target: { value: "changed-csv" } });
    expect(apply).toBeDisabled(); expect(read).toHaveBeenCalledOnce();
  });
});
