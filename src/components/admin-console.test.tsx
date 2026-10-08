/** @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { DiagnosticService, ManagedUser, ReasonCode, SessionUser } from "@cvg/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AdminConsole } from "./admin-console";
import { UserRow } from "./admin-users";
import * as apiClient from "./api-client";

vi.mock("next/link", () => ({ default: ({ children, ...props }: { children: React.ReactNode; href: string }) => <a {...props}>{children}</a> }));

const service: DiagnosticService = { id: "service-1", code: "HEMOGRAM", name: "Hemograma", category: "LABORATORY", departmentCode: "LABORATORY", workflowType: "LABORATORY", requiresSample: true, requiresSchedule: false, allowsAttachment: false, resultSchema: "NARRATIVE", active: true, version: 1, slaHours: { ROUTINE: 8, URGENT: 4, EMERGENCY: 2 } };
const reason: ReasonCode = { id: "reason-1", type: "RECOLLECTION", code: "HEMOLYZED", label: "Amostra hemolisada", active: true, version: 1 };
const user: ManagedUser = { id: "user-vet", email: "vet@cvg.local", displayName: "Dra. Marina Costa", role: "VETERINARIAN", departmentCode: "INPATIENT", active: true, timezone: "America/Sao_Paulo", createdAt: "2026-10-03T00:00:00Z", version: 1 };
const identity: SessionUser = { id: "admin", email: "admin@cvg.local", displayName: "Admin", role: "ADMIN", departmentCode: "INPATIENT", timezone: "America/Sao_Paulo" };
const numericService: DiagnosticService = {
  ...service,
  resultSchema: "NUMERIC_PANEL",
  resultTemplate: {
    kind: "LABORATORY_PANEL", code: "HEMOGRAM_PANEL", name: "Painel do hemograma", version: 3, schemaVersion: "1.0", status: "ACTIVE",
    analytes: [{ code: "HEMOGLOBIN", label: "Hemoglobina", valueType: "NUMERIC", unitCode: "g/dL", required: true, displayOrder: 1 }]
  }
};

function mockHttpApi(session: SessionUser, services: DiagnosticService[] = [service], mutation?: (init: RequestInit) => Response | Promise<Response>) {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const path = String(input);
    if (path === "/api/v1/diagnostic-services" && init?.method === "POST" && mutation) return mutation(init);
    let data: unknown;
    if (path === "/api/v1/session/me") data = { user: session };
    else if (path === "/api/v1/users/user-vet/roles" && init?.method === "POST") data = { ...user, ...JSON.parse(init.body as string), version: user.version + 1 };
    else if (path === "/api/v1/diagnostic-services?includeInactive=true") data = services;
    else if (path === "/api/v1/reason-codes") data = [reason];
    else if (path === "/api/v1/users") data = [user];
    else if (path === "/api/v1/diagnostic-services" && init?.method === "POST") data = { ...services[0], id: "service-new" };
    else throw new Error(`Unexpected HTTP request: ${path}`);
    return Response.json({ data, meta: { correlationId: "catalog-test", requestId: "request-test" } });
  });
}

function httpCreation(mock: ReturnType<typeof mockHttpApi>) {
  const call = mock.mock.calls.find(([path, init]) => path === "/api/v1/diagnostic-services" && init?.method === "POST");
  expect(call).toBeDefined();
  return { payload: JSON.parse(call![1]!.body as string) as Record<string, unknown>, init: call![1]! };
}

type Responder = (path: string, init?: RequestInit) => unknown;
function mockApi(respond?: Responder, session: SessionUser = identity, initialUsers: ManagedUser[] = [user]) {
  let currentUsers = initialUsers;
  return vi.spyOn(apiClient, "apiFetch").mockImplementation(async <T,>(path: string, init?: RequestInit): Promise<T> => {
    const custom = respond?.(path, init);
    if (custom !== undefined) return await custom as T;
    if (path === "/session/me") return { user: session } as T;
    if (path === "/diagnostic-services?includeInactive=true") return [service] as T;
    if (path === "/reason-codes" && !init?.method) return [reason] as T;
    if (path === "/users" && !init?.method) return currentUsers as T;
    if (path === "/session/reauth") return { user: session } as T;
    if (path === "/users/user-vet/roles") {
      const payload = JSON.parse(init?.body as string) as Partial<ManagedUser>;
      const updated = { ...currentUsers[0], ...payload, version: currentUsers[0].version + 1 };
      currentUsers = [updated];
      return updated as T;
    }
    if (path === "/users/user-vet" && init?.method === "DELETE") {
      const updated = { ...currentUsers[0], active: false, version: 7 };
      currentUsers = [updated]; return updated as T;
    }
    if (init?.method === "PATCH") return { ...service, version: 2 } as T;
    if (path === "/diagnostic-services" && init?.method === "POST") return { ...service, id: "service-new" } as T;
    if (path === "/reason-codes" && init?.method === "POST") return { ...reason, id: "reason-new" } as T;
    if (path === "/users" && init?.method === "POST") return { ...user, id: "user-new", displayName: "Nova colaboradora", email: "nova@cvg.local", initialPassword: "GeneratedPassword123" } as T;
    throw new Error(`Unexpected request: ${path}`);
  });
}
function payloadFor(mock: ReturnType<typeof mockApi>, path: string, method: string) {
  const call = mock.mock.calls.find(([request, init]) => request === path && init?.method === method);
  expect(call).toBeDefined();
  return JSON.parse(call![1]!.body as string) as Record<string, unknown>;
}
async function openAdmin() {
  render(<AdminConsole />);
  await screen.findByText(user.displayName);
}
function row() { return screen.getByRole("form", { name: `Acesso de ${user.email}` }); }
function fillCreation(role = "LAB_TECH") {
  const form = screen.getByRole("form", { name: "Adicionar colaborador" });
  fireEvent.change(within(form).getByLabelText("Nome completo"), { target: { value: "Nova colaboradora" } });
  fireEvent.change(within(form).getByLabelText("E-mail institucional"), { target: { value: "nova@cvg.local" } });
  fireEvent.change(within(form).getByLabelText("Perfil"), { target: { value: role } });
  return form;
}

async function answerConfirm(name: string) {
  const dialog = await screen.findByRole("dialog");
  fireEvent.click(within(dialog).getByRole("button", { name }));
}

describe("AdminConsole", () => {
  afterEach(() => { cleanup(); vi.restoreAllMocks(); document.cookie = "cvg_csrf=; max-age=0; path=/"; });

  it("regenerates a credential with a simple confirmation, copies it once and preserves unsaved access edits", async () => {
    const clipboard = { writeText: vi.fn().mockResolvedValue(undefined) };
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: clipboard });
    const secret = "Cvg1-generated-recovery-password";
    const mock = mockApi((path) => path === "/users/user-vet/password" ? { ...user, version: 2, initialPassword: secret } : undefined);
    await openAdmin();
    fireEvent.change(within(row()).getByLabelText("Setor"), { target: { value: "LABORATORY" } });
    fireEvent.click(within(row()).getByRole("button", { name: "Gerar nova senha" }));
    await answerConfirm("Gerar nova senha");
    const dialog = await screen.findByRole("dialog", { name: "Nova senha temporária" });
    expect(payloadFor(mock, "/users/user-vet/password", "POST")).toEqual({ expectedVersion: 1 });
    expect(mock.mock.calls.some(([path]) => path === "/session/reauth")).toBe(false);
    expect(within(dialog).getByLabelText("Senha inicial gerada")).toHaveTextContent(secret);
    fireEvent.click(within(dialog).getByRole("button", { name: "Copiar senha" }));
    await waitFor(() => expect(clipboard.writeText).toHaveBeenCalledWith(secret));
    fireEvent.click(within(dialog).getByRole("button", { name: "Fechar" }));
    expect(screen.queryByText(secret)).not.toBeInTheDocument();
    expect(within(row()).getByLabelText("Setor")).toHaveValue("LABORATORY");
    fireEvent.click(within(row()).getByRole("button", { name: `Salvar ${user.email}` }));
    await waitFor(() => expect(payloadFor(mock, "/users/user-vet/roles", "POST")).toMatchObject({ expectedVersion: 2, departmentCode: "LABORATORY" }));
  });

  it("cancels regeneration before writing and retains an actionable retry after a failure", async () => {
    let attempts = 0;
    const mock = mockApi((path) => {
      if (path !== "/users/user-vet/password") return undefined;
      attempts += 1;
      return attempts === 1 ? Promise.reject(new Error("reset failure")) : { ...user, version: 2, initialPassword: "Cvg1-retry-recovery-password" };
    });
    await openAdmin();
    fireEvent.click(within(row()).getByRole("button", { name: "Gerar nova senha" }));
    await answerConfirm("Cancelar");
    expect(mock.mock.calls.some(([path]) => path.endsWith("/password"))).toBe(false);
    fireEvent.click(within(row()).getByRole("button", { name: "Gerar nova senha" }));
    await answerConfirm("Gerar nova senha");
    await screen.findByRole("alert");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    fireEvent.click(within(row()).getByRole("button", { name: "Gerar nova senha" }));
    await answerConfirm("Gerar nova senha");
    await screen.findByRole("dialog", { name: "Nova senha temporária" });
    expect(attempts).toBe(2);
  });

  it("issues a one-time reset link, shows it once with its expiry and copies it (PROD-202)", async () => {
    const clipboard = { writeText: vi.fn().mockResolvedValue(undefined) };
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: clipboard });
    const url = "https://hub.hospital.example/reset-password?token=abc123";
    const mock = mockApi((path) => path === "/users/user-vet/password-reset-link" ? { user: { ...user, version: 2 }, resetUrl: url, expiresAt: "2026-10-08T15:00:00.000Z" } : undefined);
    await openAdmin();
    fireEvent.click(within(row()).getByRole("button", { name: "Gerar link de redefinição" }));
    await answerConfirm("Gerar link");
    const dialog = await screen.findByRole("dialog", { name: "Link de redefinição" });
    expect(payloadFor(mock, "/users/user-vet/password-reset-link", "POST")).toEqual({ expectedVersion: 1 });
    expect(mock.mock.calls.some(([path]) => path === "/session/reauth")).toBe(false);
    expect(within(dialog).getByLabelText("Link de redefinição gerado")).toHaveTextContent(url);
    expect(dialog).toHaveTextContent("uma única vez");
    fireEvent.click(within(dialog).getByRole("button", { name: "Copiar link" }));
    await waitFor(() => expect(clipboard.writeText).toHaveBeenCalledWith(url));
    expect(await within(dialog).findByText("Link copiado.")).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("button", { name: "Fechar" }));
    expect(screen.queryByText(url)).not.toBeInTheDocument();
    await waitFor(() => expect(within(row()).getByRole("button", { name: "Gerar link de redefinição" })).toHaveFocus());
  });

  it("reports a clipboard failure, a replayed response without URL and a failed issuance", async () => {
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: vi.fn().mockRejectedValue(new Error("denied")) } });
    let attempt = 0;
    const mock = mockApi((path) => {
      if (path !== "/users/user-vet/password-reset-link") return undefined;
      attempt += 1;
      if (attempt === 1) return Promise.reject(new Error("link failure"));
      if (attempt === 2) return { user: { ...user, version: 2 }, expiresAt: "2026-10-08T15:00:00.000Z" };
      return { user: { ...user, version: 3 }, resetUrl: "/reset-password?token=relative", expiresAt: "2026-10-08T15:00:00.000Z" };
    });
    await openAdmin();
    const issue = async () => { fireEvent.click(within(row()).getByRole("button", { name: "Gerar link de redefinição" })); await answerConfirm("Gerar link"); };
    await issue();
    expect(await screen.findByRole("alert")).toBeInTheDocument();
    await issue();
    await waitFor(() => expect(within(row()).getByRole("alert")).toHaveTextContent("não pode ser exibido novamente"));
    await issue();
    const dialog = await screen.findByRole("dialog", { name: "Link de redefinição" });
    expect(within(dialog).getByLabelText("Link de redefinição gerado")).toHaveTextContent(`${window.location.origin}/reset-password?token=relative`);
    fireEvent.click(within(dialog).getByRole("button", { name: "Copiar link" }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("Não foi possível copiar");
    expect(mock.mock.calls.filter(([path]) => path.endsWith("/password-reset-link"))).toHaveLength(3);
  });

  it("cancels the link confirmation, requires reauthentication for ADMIN and hides the action for self or inactive access", async () => {
    const target = { ...user, role: "ADMIN" as const };
    const mock = mockApi((path, init) => path === "/users" && !init?.method ? [target] : path === "/users/user-vet/password-reset-link" ? { user: { ...target, version: 2 }, resetUrl: "https://hub.example/reset-password?token=admin", expiresAt: "2026-10-08T15:00:00.000Z" } : undefined);
    await openAdmin();
    fireEvent.click(within(row()).getByRole("button", { name: "Gerar link de redefinição" }));
    await answerConfirm("Cancelar");
    expect(mock.mock.calls.some(([path]) => path.endsWith("/password-reset-link"))).toBe(false);
    fireEvent.click(within(row()).getByRole("button", { name: "Gerar link de redefinição" }));
    await answerConfirm("Gerar link");
    const stepUp = await screen.findByRole("dialog", { name: "Confirmar recuperação de ADMIN" });
    fireEvent.change(within(stepUp).getByLabelText("Senha para reautenticar"), { target: { value: "admin-password-1234" } });
    fireEvent.click(within(stepUp).getByRole("button", { name: "Confirmar" }));
    await screen.findByRole("dialog", { name: "Link de redefinição" });
    expect(mock.mock.calls.findIndex(([path]) => path === "/session/reauth")).toBeLessThan(mock.mock.calls.findIndex(([path]) => path.endsWith("/password-reset-link")));
    cleanup();
    render(<UserRow user={{ ...user, id: identity.id }} technical viewerId={identity.id} onChanged={vi.fn()} />);
    expect(screen.queryByRole("button", { name: "Gerar link de redefinição" })).not.toBeInTheDocument();
    cleanup();
    render(<UserRow user={{ ...user, active: false }} technical viewerId={identity.id} onChanged={vi.fn()} />);
    expect(screen.queryByRole("button", { name: "Gerar link de redefinição" })).not.toBeInTheDocument();
  });

  it("requires reauthentication to recover ADMIN and does not offer recovery for self or inactive access", async () => {
    const target = { ...user, role: "ADMIN" as const };
    const mock = mockApi((path, init) => path === "/users" && !init?.method ? [target] : path === "/users/user-vet/password" ? { ...target, version: 2, initialPassword: "Cvg1-admin-recovery-password" } : undefined);
    await openAdmin();
    fireEvent.click(within(row()).getByRole("button", { name: "Gerar nova senha" }));
    await answerConfirm("Gerar nova senha");
    const stepUp = await screen.findByRole("dialog", { name: "Confirmar recuperação de ADMIN" });
    expect(mock.mock.calls.some(([path]) => path.endsWith("/password"))).toBe(false);
    fireEvent.change(within(stepUp).getByLabelText("Senha para reautenticar"), { target: { value: "admin-password-1234" } });
    fireEvent.click(within(stepUp).getByRole("button", { name: "Confirmar" }));
    const secretDialog = await screen.findByRole("dialog", { name: "Nova senha temporária" });
    await waitFor(() => expect(within(secretDialog).getByRole("button", { name: "Fechar" })).toHaveFocus());
    fireEvent.click(within(secretDialog).getByRole("button", { name: "Fechar" }));
    await waitFor(() => expect(within(row()).getByRole("button", { name: "Gerar nova senha" })).toHaveFocus());
    expect(mock.mock.calls.findIndex(([path]) => path === "/session/reauth")).toBeLessThan(mock.mock.calls.findIndex(([path]) => path.endsWith("/password")));
    cleanup();
    render(<UserRow user={{ ...user, id: identity.id }} technical viewerId={identity.id} onChanged={vi.fn()} />);
    expect(screen.queryByRole("button", { name: "Gerar nova senha" })).not.toBeInTheDocument();
    cleanup();
    render(<UserRow user={{ ...user, active: false }} technical viewerId={identity.id} onChanged={vi.fn()} />);
    expect(screen.queryByRole("button", { name: "Gerar nova senha" })).not.toBeInTheDocument();
  });

  it("does not redisplay a secret on idempotent replay or submit a second reset while pending", async () => {
    let finish!: (value: ManagedUser) => void;
    const mock = mockApi((path) => path === "/users/user-vet/password" ? new Promise<ManagedUser>((resolve) => { finish = resolve; }) : undefined);
    await openAdmin();
    const button = within(row()).getByRole("button", { name: "Gerar nova senha" });
    fireEvent.click(button); fireEvent.click(button);
    await answerConfirm("Gerar nova senha");
    expect(mock.mock.calls.filter(([path]) => path.endsWith("/password"))).toHaveLength(1);
    finish({ ...user, version: 2 });
    await screen.findByText(/A senha já foi gerada/);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(button).toBeEnabled();
  });

  it("edits catalog inline with expectedVersion and removes technical policy copy and fetches", async () => {
    const mock = mockApi(); await openAdmin();
    expect(screen.queryByText(/gate externo|código protegido|identificador protegido|versão|sem atalhos/i)).not.toBeInTheDocument();
    const form = screen.getByRole("form", { name: "Serviço Hemograma" });
    fireEvent.change(within(form).getByLabelText("Nome"), { target: { value: "Hemograma revisado" } });
    fireEvent.click(within(form).getByLabelText("Disponível no catálogo"));
    fireEvent.click(within(form).getByRole("button", { name: "Salvar Hemograma" }));
    await waitFor(() => expect(payloadFor(mock, "/diagnostic-services/service-1", "PATCH")).toMatchObject({ name: "Hemograma revisado", active: false, expectedVersion: 1 }));
    expect(payloadFor(mock, "/diagnostic-services/service-1", "PATCH")).not.toHaveProperty("code");
    expect(mock.mock.calls.some(([path]) => /sessions|dead-letters|audit-events/.test(path))).toBe(false);
  });

  it("saves profile and department without password, reason or confirmation", async () => {
    const mock = mockApi(); await openAdmin();
    fireEvent.change(within(row()).getByLabelText("Perfil"), { target: { value: "MANAGER" } });
    fireEvent.change(within(row()).getByLabelText("Setor"), { target: { value: "LABORATORY" } });
    fireEvent.change(within(row()).getByLabelText("Setores gerenciados"), { target: { value: "laboratory, ultrasound, laboratory" } });
    fireEvent.click(within(row()).getByRole("button", { name: `Salvar ${user.email}` }));
    await waitFor(() => expect(payloadFor(mock, "/users/user-vet/roles", "POST")).toEqual({ role: "MANAGER", departmentCode: "LABORATORY", active: true, expectedVersion: 1, managedDepartmentCodes: ["LABORATORY", "ULTRASOUND"] }));
    expect(mock.mock.calls.some(([path]) => path === "/session/reauth")).toBe(false);
    expect(screen.queryByLabelText(/Motivo da alteração|Senha para reautenticar|Confirmo/)).not.toBeInTheDocument();
    expect(within(row()).getByText("Opções avançadas").parentElement).not.toHaveAttribute("open");
  });

  it.each([
    ["Laboratório", "LABORATORY"], ["Internação", "INPATIENT"], ["Radiologia", "RADIOLOGY"], ["Ultrassom", "ULTRASOUND"], ["TI", "IT"]
  ])("selects %s and posts its backend code %s using select and save", async (label, code) => {
    document.cookie = "cvg_csrf=user-csrf; path=/";
    const mock = mockHttpApi(identity);
    await openAdmin();
    const select = within(row()).getByRole("combobox", { name: "Setor" });
    const option = within(select).getByRole("option", { name: label });
    expect(option).toHaveValue(code);
    fireEvent.change(select, { target: { value: option.getAttribute("value") } });
    expect(mock.mock.calls.some(([path, init]) => path === "/api/v1/users/user-vet/roles" && init?.method === "POST")).toBe(false);
    fireEvent.click(within(row()).getByRole("button", { name: `Salvar ${user.email}` }));
    await waitFor(() => expect(mock.mock.calls.filter(([path, init]) => path === "/api/v1/users/user-vet/roles" && init?.method === "POST")).toHaveLength(1));
    const call = mock.mock.calls.find(([path, init]) => path === "/api/v1/users/user-vet/roles" && init?.method === "POST")!;
    const init = call[1]!;
    expect(JSON.parse(init.body as string)).toEqual({ role: user.role, departmentCode: code, active: true, expectedVersion: user.version });
    expect(init.credentials).toBe("include");
    expect(new Headers(init.headers).get("x-csrf-token")).toBe("user-csrf");
    expect(new Headers(init.headers).get("idempotency-key")).toBeTruthy();
    await waitFor(() => expect(within(row()).getByRole("button", { name: `Salvar ${user.email}` })).toBeEnabled());
    expect(select).toHaveValue(code);
    expect(mock.mock.calls.some(([path]) => path === "/api/v1/session/reauth")).toBe(false);
  });

  it("includes distinct department codes from users, catalog and identity, including managed scope", async () => {
    const colleague = { ...user, id: "colleague", email: "colleague@cvg.local", displayName: "Colega", departmentCode: "CUSTOM_USER", managedDepartmentCodes: ["CUSTOM_USER_SCOPE"] };
    mockApi((path) => path === "/diagnostic-services?includeInactive=true" ? [service, { ...service, id: "custom-service", departmentCode: "CUSTOM_CATALOG" }] : undefined,
      { ...identity, departmentCode: "CUSTOM_IDENTITY", managedDepartmentCodes: ["CUSTOM_IDENTITY_SCOPE", "CUSTOM_USER"] }, [user, colleague]);
    await openAdmin();
    const select = within(row()).getByRole("combobox", { name: "Setor" });
    for (const code of ["CUSTOM_USER", "CUSTOM_USER_SCOPE", "CUSTOM_CATALOG", "CUSTOM_IDENTITY", "CUSTOM_IDENTITY_SCOPE"]) {
      expect(within(select).getAllByRole("option", { name: code })).toHaveLength(1);
      expect(within(select).getByRole("option", { name: code })).toHaveValue(code);
    }
    expect(select).toHaveValue(user.departmentCode);
  });

  it("preserves a current unknown department when editing a standalone row without optional props", async () => {
    const original = { ...user, departmentCode: "CUSTOM_LEGACY" };
    const mock = mockApi(undefined, identity, [original]);
    const onChanged = vi.fn();
    render(<UserRow user={original} technical viewerId={identity.id} onChanged={onChanged} />);
    const select = within(row()).getByRole("combobox", { name: "Setor" });
    expect(select).toHaveValue(original.departmentCode);
    expect(within(select).getByRole("option", { name: original.departmentCode })).toHaveValue(original.departmentCode);
    fireEvent.change(within(row()).getByLabelText("Perfil"), { target: { value: "VIEWER" } });
    fireEvent.click(within(row()).getByRole("button", { name: `Salvar ${user.email}` }));
    await waitFor(() => expect(onChanged).toHaveBeenCalledWith(expect.objectContaining({ role: "VIEWER", departmentCode: original.departmentCode })));
    expect(payloadFor(mock, "/users/user-vet/roles", "POST")).toEqual({ role: "VIEWER", departmentCode: original.departmentCode, active: true, expectedVersion: original.version });
    expect(select).toHaveValue(original.departmentCode);
  });

  it("shows concise row actions with the existing accessible names and grouped service buttons", async () => {
    mockApi(); await openAdmin();
    const actions = [
      [row(), `Salvar ${user.email}`, "Salvar"],
      [row(), "Desativar acesso", "Desativar"],
      [screen.getByRole("form", { name: "Serviço Hemograma" }), "Salvar Hemograma", "Salvar"],
      [screen.getByRole("form", { name: "Serviço Hemograma" }), "Duplicar Hemograma", "Duplicar"],
      [screen.getByRole("form", { name: "Motivo Amostra hemolisada" }), "Salvar HEMOLYZED", "Salvar"],
      [screen.getByRole("form", { name: "Motivo Amostra hemolisada" }), "Duplicar Amostra hemolisada", "Duplicar"]
    ] as const;
    for (const [form, name, text] of actions) expect(within(form).getByRole("button", { name })).toHaveTextContent(new RegExp(`^${text}$`));
    const serviceForm = screen.getByRole("form", { name: "Serviço Hemograma" });
    const save = within(serviceForm).getByRole("button", { name: "Salvar Hemograma" });
    const duplicate = within(serviceForm).getByRole("button", { name: "Duplicar Hemograma" });
    expect(save.parentElement).toHaveClass("admin-action-row");
    expect(duplicate.parentElement).toBe(save.parentElement);
  });

  it("shows permission denial and does not expose mutation forms", async () => {
    vi.spyOn(apiClient, "apiFetch").mockRejectedValue(new apiClient.ApiClientError(404, { error: { code: "SCOPE_DENIED" } }));
    render(<AdminConsole />);
    expect(await screen.findByRole("alert")).toHaveTextContent("Administração fora do seu escopo");
    expect(screen.queryByRole("button", { name: "Criar acesso" })).not.toBeInTheDocument();
  });

  it("creates an exam using only its name with generated code and default SLA", async () => {
    const mock = mockApi(); await openAdmin();
    const form = screen.getByRole("form", { name: "Adicionar serviço" });
    fireEvent.change(within(form).getByLabelText("Nome"), { target: { value: "Ácido úrico" } });
    fireEvent.click(within(form).getByRole("button", { name: "Criar serviço" }));
    await waitFor(() => expect(payloadFor(mock, "/diagnostic-services", "POST")).toEqual({ code: "ACIDO_URICO", name: "Ácido úrico", category: "LABORATORY", departmentCode: "LABORATORY", workflowType: "LABORATORY", requiresSample: true, requiresSchedule: false, allowsAttachment: false, resultSchema: "NARRATIVE", slaHours: { ROUTINE: 8, URGENT: 4, EMERGENCY: 2 } }));
    expect(within(form).queryByLabelText("Código")).not.toBeInTheDocument();
  });

  it.each([
    { primary: "RADIOLOGY", managed: ["ULTRASOUND"], department: "RADIOLOGY", workflow: "RADIOLOGY", category: "IMAGING", sample: false, schedule: false, attachment: true, sla: { ROUTINE: 24, URGENT: 8, EMERGENCY: 4 } },
    { primary: "ULTRASOUND", managed: ["RADIOLOGY"], department: "ULTRASOUND", workflow: "ULTRASOUND", category: "IMAGING", sample: false, schedule: true, attachment: true, sla: { ROUTINE: 48, URGENT: 12, EMERGENCY: 6 } },
    { primary: "INPATIENT", managed: ["ULTRASOUND"], department: "ULTRASOUND", workflow: "ULTRASOUND", category: "IMAGING", sample: false, schedule: true, attachment: true, sla: { ROUTINE: 48, URGENT: 12, EMERGENCY: 6 } },
    { primary: "INPATIENT", managed: ["RADIOLOGY", "LABORATORY"], department: "RADIOLOGY", workflow: "RADIOLOGY", category: "IMAGING", sample: false, schedule: false, attachment: true, sla: { ROUTINE: 24, URGENT: 8, EMERGENCY: 4 } },
    { primary: "LABORATORY", managed: ["RADIOLOGY"], department: "LABORATORY", workflow: "LABORATORY", category: "LABORATORY", sample: true, schedule: false, attachment: false, sla: { ROUTINE: 8, URGENT: 4, EMERGENCY: 2 } },
    { primary: "OPERATIONS", managed: [], department: "OPERATIONS", workflow: "LABORATORY", category: "LABORATORY", sample: true, schedule: false, attachment: false, sla: { ROUTINE: 8, URGENT: 4, EMERGENCY: 2 } }
  ])("creates by name within manager scope $primary / $managed", async ({ primary, managed, department, workflow, category, sample, schedule, attachment, sla }) => {
    const mock = mockHttpApi({ ...identity, role: "MANAGER", departmentCode: primary, managedDepartmentCodes: managed });
    await openAdmin();
    const form = screen.getByRole("form", { name: "Adicionar serviço" });
    expect(within(form).getByText("Opções avançadas do exame").closest("details")).not.toHaveAttribute("open");
    expect(within(form).getAllByRole("textbox").filter((input) => !input.closest("details"))).toEqual([within(form).getByLabelText("Nome")]);
    fireEvent.change(within(form).getByLabelText("Nome"), { target: { value: "Exame do setor" } });
    fireEvent.click(within(form).getByRole("button", { name: "Criar serviço" }));
    await waitFor(() => expect(httpCreation(mock).payload).toEqual({ code: "EXAME_DO_SETOR", name: "Exame do setor", departmentCode: department, workflowType: workflow, category, requiresSample: sample, requiresSchedule: schedule, allowsAttachment: attachment, resultSchema: "NARRATIVE", slaHours: sla }));
    expect([primary, ...managed]).toContain(department);
    await waitFor(() => expect(within(form).getByLabelText("Nome")).toHaveValue(""));
    expect(within(form).getByLabelText("Setor")).toHaveValue(department);
  });

  it("preserves advanced service configuration and reason creation and lifecycle", async () => {
    const mock = mockApi(); await openAdmin();
    const form = screen.getByRole("form", { name: "Serviço Hemograma" });
    fireEvent.click(within(form).getByText("Opções avançadas do exame"));
    fireEvent.change(within(form).getByLabelText("Categoria"), { target: { value: "IMAGING" } });
    fireEvent.change(within(form).getByLabelText("Workflow"), { target: { value: "ULTRASOUND" } });
    fireEvent.change(within(form).getByLabelText("Setor"), { target: { value: "ultrasound" } });
    for (const label of ["Exige amostra", "Exige agenda", "Aceita anexo"]) fireEvent.click(within(form).getByLabelText(label));
    fireEvent.change(within(form).getByLabelText("Modelo de resultado"), { target: { value: "NUMERIC_PANEL" } });
    for (const [label, value] of [["SLA rotina (h)", "12"], ["SLA urgente (h)", "6"], ["SLA emergência (h)", "4"]]) fireEvent.change(within(form).getByLabelText(label), { target: { value } });
    fireEvent.click(within(form).getByRole("button", { name: "Salvar Hemograma" }));
    await waitFor(() => expect(payloadFor(mock, "/diagnostic-services/service-1", "PATCH")).toMatchObject({ category: "IMAGING", workflowType: "ULTRASOUND", departmentCode: "ULTRASOUND", requiresSample: false, requiresSchedule: true, allowsAttachment: true, resultSchema: "NUMERIC_PANEL", slaHours: { ROUTINE: 12, URGENT: 6, EMERGENCY: 4 } }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Atualizar" })).toBeEnabled());
    fireEvent.click(screen.getByText("Adicionar motivo"));
    const reasonCreate = screen.getByText("Adicionar motivo").closest("details")!;
    fireEvent.change(within(reasonCreate).getByLabelText("Tipo"), { target: { value: "REJECT" } });
    fireEvent.change(within(reasonCreate).getByLabelText("Descrição"), { target: { value: "Amostra comprometida" } });
    fireEvent.click(within(reasonCreate).getByRole("button", { name: "Criar motivo" }));
    await waitFor(() => expect(payloadFor(mock, "/reason-codes", "POST")).toEqual({ type: "REJECT", code: "AMOSTRA_COMPROMETIDA", label: "Amostra comprometida" }));
    const reasonRow = screen.getByRole("form", { name: "Motivo Amostra hemolisada" });
    fireEvent.change(within(reasonRow).getByLabelText("Descrição"), { target: { value: "Motivo revisado" } });
    fireEvent.click(within(reasonRow).getByLabelText("Disponível para seleção"));
    fireEvent.click(within(reasonRow).getByRole("button", { name: "Salvar HEMOLYZED" }));
    await waitFor(() => expect(payloadFor(mock, "/reason-codes/reason-1", "PATCH")).toEqual({ label: "Motivo revisado", active: false, expectedVersion: 1 }));
  });

  it("shows server generated password once, copies and clears it without storage", async () => {
    const mock = mockApi();
    const copy = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: copy } });
    const localStore = vi.spyOn(Storage.prototype, "setItem");
    await openAdmin();
    const form = fillCreation();
    expect(within(form).getAllByRole("textbox")).toHaveLength(2);
    fireEvent.click(within(form).getByRole("button", { name: "Criar acesso" }));
    const dialog = await screen.findByRole("dialog", { name: "Senha inicial" });
    expect(payloadFor(mock, "/users", "POST")).toEqual({ displayName: "Nova colaboradora", email: "nova@cvg.local", role: "LAB_TECH", departmentCode: "INPATIENT" });
    expect(mock.mock.calls.some(([path]) => path === "/session/reauth")).toBe(false);
    fireEvent.click(within(dialog).getByRole("button", { name: "Copiar senha" }));
    await waitFor(() => expect(copy).toHaveBeenCalledWith("GeneratedPassword123"));
    fireEvent.click(within(dialog).getByRole("button", { name: "Fechar" }));
    expect(screen.queryByText("GeneratedPassword123")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Atualizar" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Atualizar" })).toBeEnabled());
    expect(screen.queryByText("GeneratedPassword123")).not.toBeInTheDocument();
    expect(localStore).not.toHaveBeenCalled();
  });

  it("passes the catalog into user creation for explicit department-scoped exam assignments", async () => {
    const imagingService: DiagnosticService = { ...service, id: "service-xray", code: "XRAY", name: "Radiografia", category: "IMAGING", departmentCode: "RADIOLOGY", workflowType: "RADIOLOGY", requiresSample: false };
    const mock = mockApi((path) => path === "/diagnostic-services?includeInactive=true" ? [service, imagingService] : undefined, { ...identity, departmentCode: "LABORATORY" });
    await openAdmin();
    const form = fillCreation();
    const details = within(form).getByText(/^Exames autorizados/).closest("details")!;
    expect(details).not.toHaveAttribute("open");
    fireEvent.click(within(form).getByText(/^Exames autorizados/));
    expect(within(details).getByLabelText("Hemograma")).not.toBeChecked();
    expect(within(details).queryByLabelText("Radiografia")).not.toBeInTheDocument();
    fireEvent.click(within(details).getByLabelText("Hemograma"));
    fireEvent.click(within(form).getByRole("button", { name: "Criar acesso" }));
    await screen.findByRole("dialog", { name: "Senha inicial" });
    expect(payloadFor(mock, "/users", "POST")).toEqual({ displayName: "Nova colaboradora", email: "nova@cvg.local", role: "LAB_TECH", departmentCode: "LABORATORY", serviceCodes: ["HEMOGRAM"] });
  });

  it("passes the catalog into user rows and preserves only explicitly selected executor exams", async () => {
    const secondService = { ...service, id: "service-crp", code: "CRP", name: "Proteína C reativa" };
    const executor = { ...user, role: "LAB_TECH" as const, departmentCode: "LABORATORY", serviceCodes: ["HEMOGRAM"] };
    const mock = mockApi((path) => path === "/diagnostic-services?includeInactive=true" ? [service, secondService] : undefined, identity, [executor]);
    await openAdmin();
    const form = row();
    fireEvent.click(within(form).getByText(/^Exames autorizados/));
    expect(within(form).getByLabelText("Hemograma")).toBeChecked();
    expect(within(form).getByLabelText("Proteína C reativa")).not.toBeChecked();
    fireEvent.click(within(form).getByLabelText("Hemograma"));
    fireEvent.click(within(form).getByLabelText("Proteína C reativa"));
    fireEvent.click(within(form).getByRole("button", { name: `Salvar ${user.email}` }));
    await waitFor(() => expect(payloadFor(mock, "/users/user-vet/roles", "POST")).toEqual({ role: "LAB_TECH", departmentCode: "LABORATORY", active: true, expectedVersion: 1, serviceCodes: ["CRP"] }));
  });

  it("creates a manager with collapsed managed departments and tolerates an absent initialPassword", async () => {
    const mock = mockApi((path, init) => path === "/users" && init?.method === "POST" ? { ...user, id: "manager-new", role: "MANAGER" } : undefined);
    await openAdmin();
    const form = fillCreation("MANAGER");
    const details = within(form).getByText("Opções avançadas").closest("details")!;
    expect(details).not.toHaveAttribute("open");
    fireEvent.click(within(form).getByText("Opções avançadas"));
    fireEvent.change(within(form).getByLabelText("Setores gerenciados"), { target: { value: "laboratory, radiology, laboratory" } });
    fireEvent.click(within(form).getByRole("button", { name: "Criar acesso" }));
    await waitFor(() => expect(payloadFor(mock, "/users", "POST")).toMatchObject({ role: "MANAGER", managedDepartmentCodes: ["LABORATORY", "RADIOLOGY"] }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("deactivates in one click and undoes using the server returned version", async () => {
    const mock = mockApi(); await openAdmin();
    fireEvent.click(within(row()).getByRole("button", { name: "Desativar acesso" }));
    await screen.findByRole("button", { name: "Desfazer" });
    expect(payloadFor(mock, "/users/user-vet", "DELETE")).toEqual({ expectedVersion: 1 });
    fireEvent.click(screen.getByRole("button", { name: "Desfazer" }));
    await waitFor(() => expect(payloadFor(mock, "/users/user-vet/roles", "POST")).toEqual({ role: "VETERINARIAN", departmentCode: "INPATIENT", active: true, expectedVersion: 7 }));
    await waitFor(() => expect(screen.queryByRole("button", { name: "Desfazer" })).not.toBeInTheDocument());
    expect(mock.mock.calls.some(([path]) => path === "/session/reauth")).toBe(false);
  });

  it.each(["ADMIN", "VETERINARIAN"] as const)("requires a password only for granting/removing ADMIN (target %s)", async (target) => {
    const original = { ...user, role: target === "ADMIN" ? "VETERINARIAN" as const : "ADMIN" as const };
    const mock = mockApi(undefined, identity, [original]); await openAdmin();
    fireEvent.change(within(row()).getByLabelText("Perfil"), { target: { value: target } });
    fireEvent.click(within(row()).getByRole("button", { name: `Salvar ${user.email}` }));
    const dialog = screen.getByRole("dialog", { name: "Confirmar alteração de ADMIN" });
    expect(mock.mock.calls.some(([path]) => path.endsWith("/roles"))).toBe(false);
    fireEvent.change(within(dialog).getByLabelText("Senha para reautenticar"), { target: { value: "AdminPassword1" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Confirmar" }));
    await waitFor(() => expect(payloadFor(mock, "/users/user-vet/roles", "POST")).toMatchObject({ role: target, expectedVersion: 1 }));
    const calls = mock.mock.calls.map(([path]) => path);
    expect(calls.indexOf("/session/reauth")).toBeLessThan(calls.indexOf("/users/user-vet/roles"));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });

  it("reauthenticates creation and deactivation of ADMIN, and cancels without mutation", async () => {
    const mock = mockApi(undefined, identity, [{ ...user, role: "ADMIN" }]); await openAdmin();
    const form = fillCreation("ADMIN");
    fireEvent.click(within(form).getByRole("button", { name: "Criar acesso" }));
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(mock.mock.calls.some(([path, init]) => path === "/users" && init?.method === "POST")).toBe(false);
    fireEvent.click(within(form).getByRole("button", { name: "Criar acesso" }));
    let dialog = screen.getByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText("Senha para reautenticar"), { target: { value: "AdminPassword1" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Confirmar" }));
    await screen.findByRole("dialog", { name: "Senha inicial" });
    fireEvent.click(screen.getByRole("button", { name: "Fechar" }));
    expect(payloadFor(mock, "/users", "POST")).toMatchObject({ role: "ADMIN" });
    fireEvent.click(within(row()).getByRole("button", { name: "Desativar acesso" }));
    dialog = screen.getByRole("dialog", { name: "Confirmar alteração de ADMIN" });
    expect(mock.mock.calls.some(([path, init]) => init?.method === "DELETE")).toBe(false);
    fireEvent.change(within(dialog).getByLabelText("Senha para reautenticar"), { target: { value: "AdminPassword1" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Confirmar" }));
    await screen.findByRole("button", { name: "Desfazer" });
    expect(payloadFor(mock, "/users/user-vet", "DELETE")).toEqual({ expectedVersion: 1 });
  });

  it("duplicates services and reasons with full defaults and distinct codes", async () => {
    const mock = mockApi(); await openAdmin();
    fireEvent.click(screen.getByRole("button", { name: "Duplicar Hemograma" }));
    await waitFor(() => expect(payloadFor(mock, "/diagnostic-services", "POST")).toEqual({ code: "HEMOGRAMA_COPIA", name: "Hemograma (cópia)", category: service.category, departmentCode: service.departmentCode, workflowType: service.workflowType, requiresSample: service.requiresSample, requiresSchedule: service.requiresSchedule, allowsAttachment: service.allowsAttachment, resultSchema: service.resultSchema, slaHours: service.slaHours, duplicateOfServiceId: service.id }));
    fireEvent.click(screen.getByRole("button", { name: "Duplicar Amostra hemolisada" }));
    await waitFor(() => expect(payloadFor(mock, "/reason-codes", "POST")).toEqual({ type: "RECOLLECTION", code: "AMOSTRA_HEMOLISADA_COPIA", label: "Amostra hemolisada (cópia)" }));
  });

  it.each([service, numericService])("duplicates $resultSchema through HTTP with source template identity and current draft", async (source) => {
    document.cookie = "cvg_csrf=catalog-csrf; path=/";
    const mock = mockHttpApi(identity, [source]);
    await openAdmin();
    const form = screen.getByRole("form", { name: "Serviço Hemograma" });
    fireEvent.change(within(form).getByLabelText("Nome"), { target: { value: "Hemograma ajustado" } });
    fireEvent.click(within(form).getByText("Opções avançadas do exame"));
    fireEvent.change(within(form).getByLabelText("Setor"), { target: { value: "RADIOLOGY" } });
    fireEvent.click(within(form).getByLabelText("Exige agenda"));
    fireEvent.click(within(form).getByLabelText("Aceita anexo"));
    fireEvent.change(within(form).getByLabelText("SLA rotina (h)"), { target: { value: "16" } });
    fireEvent.click(within(form).getByRole("button", { name: "Duplicar Hemograma" }));
    await waitFor(() => expect(httpCreation(mock).payload).toEqual({ code: "HEMOGRAMA_AJUSTADO_COPIA", name: "Hemograma ajustado (cópia)", category: "LABORATORY", departmentCode: "RADIOLOGY", workflowType: "LABORATORY", requiresSample: true, requiresSchedule: true, allowsAttachment: true, resultSchema: source.resultSchema, slaHours: { ROUTINE: 16, URGENT: 4, EMERGENCY: 2 }, duplicateOfServiceId: source.id }));
    const { init } = httpCreation(mock);
    expect(init.credentials).toBe("include");
    expect(new Headers(init.headers).get("x-csrf-token")).toBe("catalog-csrf");
    expect(new Headers(init.headers).get("idempotency-key")).toBeTruthy();
    await waitFor(() => expect(within(form).getByRole("button", { name: "Duplicar Hemograma" })).toBeEnabled());
    expect(within(form).getByLabelText("Nome")).toHaveValue("Hemograma ajustado");
    expect(within(form).getByLabelText("Modelo de resultado")).toHaveValue(source.resultSchema);
  });

  it("keeps a numeric duplicate draft on server error and retries without downgrading its panel", async () => {
    const mutation = vi.fn().mockResolvedValue(Response.json({ error: { code: "VALIDATION_ERROR" } }, { status: 422 }));
    const mock = mockHttpApi(identity, [numericService], mutation);
    await openAdmin();
    const form = screen.getByRole("form", { name: "Serviço Hemograma" });
    fireEvent.change(within(form).getByLabelText("Nome"), { target: { value: "Painel ajustado" } });
    fireEvent.click(within(form).getByText("Opções avançadas do exame"));
    fireEvent.change(within(form).getByLabelText("SLA urgente (h)"), { target: { value: "5" } });
    fireEvent.click(within(form).getByRole("button", { name: "Duplicar Hemograma" }));
    expect(await within(form).findByRole("alert")).toHaveTextContent("Revise os dados informados");
    const payload = httpCreation(mock).payload;
    expect(payload).toMatchObject({ duplicateOfServiceId: numericService.id, name: "Painel ajustado (cópia)", resultSchema: "NUMERIC_PANEL", slaHours: { ROUTINE: 8, URGENT: 5, EMERGENCY: 2 } });
    expect(within(form).getByLabelText("Nome")).toHaveValue("Painel ajustado");
    expect(within(form).getByLabelText("Modelo de resultado")).toHaveValue("NUMERIC_PANEL");
    expect(within(form).getByLabelText("SLA urgente (h)")).toHaveValue(5);
    expect(mock.mock.calls.filter(([path]) => path === "/api/v1/session/me")).toHaveLength(1);
    mutation.mockResolvedValue(Response.json({ data: { ...numericService, id: "service-copy" }, meta: { correlationId: "retry", requestId: "retry-request" } }));
    fireEvent.click(within(form).getByRole("button", { name: "Duplicar Hemograma" }));
    await waitFor(() => expect(mutation).toHaveBeenCalledTimes(2));
    const retryPayload = JSON.parse(mutation.mock.calls[1][0].body as string) as Record<string, unknown>;
    expect(retryPayload).toEqual(payload);
    await waitFor(() => expect(within(form).queryByRole("alert")).not.toBeInTheDocument());
  });

  it("avoids loaded code collisions and generates valid codes for names beginning with numbers", async () => {
    const mock = mockApi((path) => path === "/diagnostic-services?includeInactive=true" ? [{ ...service, code: "ITEM_123" }, { ...service, id: "service-2", code: "ITEM_123_2", name: "Outro" }] : undefined);
    await openAdmin();
    const form = screen.getByRole("form", { name: "Adicionar serviço" });
    fireEvent.change(within(form).getByLabelText("Nome"), { target: { value: "123" } });
    fireEvent.click(within(form).getByRole("button", { name: "Criar serviço" }));
    await waitFor(() => expect(payloadFor(mock, "/diagnostic-services", "POST")).toMatchObject({ code: "ITEM_123_3" }));
  });

  it("hides technical profiles from managers and denies non-management identities before fetching resources", async () => {
    mockApi(undefined, { ...identity, role: "MANAGER" }); await openAdmin();
    expect(screen.queryByRole("option", { name: "Administração técnica" })).not.toBeInTheDocument();
    expect(screen.queryByRole("option", { name: "Gestão operacional" })).not.toBeInTheDocument();
    cleanup(); vi.restoreAllMocks();
    const mock = mockApi(undefined, { ...identity, role: "VETERINARIAN" });
    render(<AdminConsole />);
    expect(await screen.findByRole("alert")).toHaveTextContent("Administração fora do seu escopo");
    expect(mock.mock.calls.map(([path]) => path)).toEqual(["/session/me"]);
  });

  it("keeps reauthentication failures in the dialog and never performs the protected mutation", async () => {
    const mock = mockApi((path) => path === "/session/reauth" ? Promise.reject(new Error("Bad password")) : undefined); await openAdmin();
    fireEvent.change(within(row()).getByLabelText("Perfil"), { target: { value: "ADMIN" } });
    fireEvent.click(within(row()).getByRole("button", { name: `Salvar ${user.email}` }));
    fireEvent.change(screen.getByLabelText("Senha para reautenticar"), { target: { value: "wrong" } });
    fireEvent.click(screen.getByRole("button", { name: "Confirmar" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Não foi possível confirmar sua senha");
    expect(mock.mock.calls.some(([path]) => path.endsWith("/roles"))).toBe(false);
  });

  it("retains failed drafts, reports conflicts and does not show a false undo", async () => {
    mockApi((path, init) => init?.method ? Promise.reject(new apiClient.ApiClientError(409, { error: { code: "VERSION_CONFLICT" } })) : undefined);
    await openAdmin();
    fireEvent.change(within(row()).getByLabelText("Setor"), { target: { value: "LABORATORY" } });
    fireEvent.click(within(row()).getByRole("button", { name: `Salvar ${user.email}` }));
    await screen.findByRole("alert");
    expect(within(row()).getByLabelText("Setor")).toHaveValue("LABORATORY");
    fireEvent.click(within(row()).getByRole("button", { name: "Desativar acesso" }));
    await waitFor(() => expect(within(row()).getByRole("button", { name: "Desativar acesso" })).toBeEnabled());
    expect(screen.queryByRole("button", { name: "Desfazer" })).not.toBeInTheDocument();
    fillCreation();
    fireEvent.click(screen.getByRole("button", { name: "Criar acesso" }));
    expect(await within(screen.getByRole("form", { name: "Adicionar colaborador" })).findByRole("alert")).toBeInTheDocument();
    expect(screen.queryByRole("dialog", { name: "Senha inicial" })).not.toBeInTheDocument();
  });

  it.each(["create", "update"])("keeps the reauth dialog and draft when a protected %s fails after authentication", async (operation) => {
    mockApi((path, init) => init?.method === "POST" && path !== "/session/reauth" ? Promise.reject(new Error("Offline")) : undefined);
    await openAdmin();
    if (operation === "create") {
      const form = fillCreation("ADMIN");
      fireEvent.click(within(form).getByRole("button", { name: "Criar acesso" }));
    } else {
      fireEvent.change(within(row()).getByLabelText("Perfil"), { target: { value: "ADMIN" } });
      fireEvent.click(within(row()).getByRole("button", { name: `Salvar ${user.email}` }));
    }
    const dialog = screen.getByRole("dialog", { name: "Confirmar alteração de ADMIN" });
    fireEvent.change(within(dialog).getByLabelText("Senha para reautenticar"), { target: { value: "AdminPassword1" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Confirmar" }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("Não foi possível salvar a alteração");
    expect(dialog).toBeInTheDocument();
    expect(within(dialog).getByLabelText("Senha para reautenticar")).toHaveValue("");
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancelar" }));
    if (operation === "create") expect(screen.getByLabelText("Nome completo")).toHaveValue("Nova colaboradora");
    else expect(within(row()).getByLabelText("Perfil")).toHaveValue("ADMIN");
    expect(screen.queryByRole("dialog", { name: "Senha inicial" })).not.toBeInTheDocument();
  });

  it("reports clipboard failure and allows Escape to clear the transient password", async () => {
    mockApi();
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: vi.fn().mockRejectedValue(new Error("Denied")) } });
    await openAdmin();
    fireEvent.click(within(fillCreation()).getByRole("button", { name: "Criar acesso" }));
    const dialog = await screen.findByRole("dialog", { name: "Senha inicial" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Copiar senha" }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("Selecione e copie a senha exibida");
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByText("GeneratedPassword123")).not.toBeInTheDocument();
  });

  it("prevents repeat user creation while pending and preserves the draft on failure", async () => {
    let rejectRequest: ((reason: Error) => void) | undefined;
    const pending = new Promise((_, reject) => { rejectRequest = reject; });
    const mock = mockApi((path, init) => path === "/users" && init?.method === "POST" ? pending : undefined);
    await openAdmin();
    const form = fillCreation();
    fireEvent.submit(form); fireEvent.submit(form);
    expect(mock.mock.calls.filter(([path, init]) => path === "/users" && init?.method === "POST")).toHaveLength(1);
    rejectRequest!(new Error("Offline"));
    expect(await within(form).findByRole("alert")).toHaveTextContent("Não foi possível adicionar o colaborador");
    expect(within(form).getByLabelText("Nome completo")).toHaveValue("Nova colaboradora");
  });
});
