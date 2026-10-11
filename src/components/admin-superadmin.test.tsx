/** @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ManagedUser, SessionUser } from "@cvg/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AdminConsole } from "./admin-console";
import * as apiClient from "./api-client";

vi.mock("next/link", () => ({ default: ({ children, ...props }: { children: React.ReactNode; href: string }) => <a {...props}>{children}</a> }));
const creator: SessionUser = { id: "super", email: "super@cvg.local", displayName: "Superadmin", role: "SUPERADMIN", departmentCode: "IT", timezone: "UTC" };
const target: ManagedUser = { id: "target", email: "target@cvg.local", displayName: "Colaborador", role: "VETERINARIAN", departmentCode: "INPATIENT", timezone: "UTC", active: true, version: 7, createdAt: "2026-10-11T00:00:00Z" };

function mockApi(identity = creator, original = target) {
  return vi.spyOn(apiClient, "apiFetch").mockImplementation(async <T,>(path: string, init?: RequestInit): Promise<T> => {
    if (path === "/session/me" || path === "/session/reauth") return { user: identity } as T;
    if (path === "/users" && !init?.method) return [original] as T;
    if (path === "/diagnostic-services?includeInactive=true" || path === "/reason-codes") return [] as T;
    if (path === "/users" && init?.method === "POST") return { ...original, ...JSON.parse(init.body as string), initialPassword: "SyntheticInitial123" } as T;
    if (path === "/users/target/roles") return { ...original, ...JSON.parse(init?.body as string), version: 8 } as T;
    if (path === "/users/target/on-call") return { ...original, onCall: true, version: 8 } as T;
    if (path === "/users/target/password") return { ...original, initialPassword: "SyntheticRecovery123", version: 8 } as T;
    if (path === "/users/target/password-reset-link") return { user: { ...original, version: 8 }, resetUrl: "https://example.invalid/reset-password?token=synthetic", expiresAt: "2026-10-11T01:00:00Z" } as T;
    throw new Error(`Unexpected request: ${path}`);
  });
}
async function open(section: "all" | "users" | "catalog" = "all") {
  render(<AdminConsole section={section} />);
  await screen.findByRole("heading", { name: section === "users" ? "Acessos" : section === "catalog" ? "Catálogos" : "Administração", level: 1 });
  await screen.findByRole("button", { name: "Atualizar" });
  if (section !== "catalog") await screen.findByText(target.displayName);
}
function callsTo(mock: ReturnType<typeof mockApi>, path: string, method: string) {
  return mock.mock.calls.filter(([request, init]) => request === path && init?.method === method);
}
async function reauthenticate() {
  const dialog = await screen.findByRole("dialog", { name: /Confirmar (alteração|recuperação) de SUPERADMIN/ });
  fireEvent.change(within(dialog).getByLabelText("Senha para reautenticar"), { target: { value: "SyntheticCurrent123" } });
  fireEvent.click(within(dialog).getByRole("button", { name: "Confirmar" }));
}
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe("Superadmin administration", () => {
  it.each(["users", "catalog"] as const)("renders only the CRUD panels assigned to section %s", async (section) => {
    mockApi(); await open(section);
    if (section === "users") {
      expect(screen.getByRole("form", { name: "Adicionar colaborador" })).toBeInTheDocument();
      expect(screen.queryByRole("form", { name: "Adicionar serviço" })).not.toBeInTheDocument();
      expect(screen.queryByRole("heading", { name: "Motivos" })).not.toBeInTheDocument();
    } else {
      expect(screen.getByRole("form", { name: "Adicionar serviço" })).toBeInTheDocument();
      expect(screen.getByRole("heading", { name: "Motivos" })).toBeInTheDocument();
      expect(screen.queryByRole("form", { name: "Adicionar colaborador" })).not.toBeInTheDocument();
      expect(screen.queryByRole("form", { name: `Acesso de ${target.email}` })).not.toBeInTheDocument();
    }
    expect(screen.queryByRole("heading", { name: "Privacidade (LGPD)" })).not.toBeInTheDocument();
  });

  it.each(["SUPERADMIN", "ADMIN", "MANAGER"] as const)("exposes the Superadmin role only to a Superadmin creator (%s)", async (role) => {
    mockApi({ ...creator, role }); await open("users");
    const form = screen.getByRole("form", { name: "Adicionar colaborador" });
    expect(within(form).queryByRole("option", { name: "Superadmin" }) !== null).toBe(role === "SUPERADMIN");
    expect(within(form).queryByRole("option", { name: "Administração técnica" }) !== null).toBe(role !== "MANAGER");
  });

  it("requires reauthentication before creating another Superadmin", async () => {
    const mock = mockApi(); await open("users");
    const form = screen.getByRole("form", { name: "Adicionar colaborador" });
    fireEvent.change(within(form).getByLabelText("Nome completo"), { target: { value: "Novo Superadmin" } });
    fireEvent.change(within(form).getByLabelText("E-mail institucional"), { target: { value: "new-super@cvg.local" } });
    fireEvent.change(within(form).getByLabelText("Perfil"), { target: { value: "SUPERADMIN" } });
    fireEvent.click(within(form).getByRole("button", { name: "Criar acesso" }));
    expect(callsTo(mock, "/users", "POST")).toHaveLength(0);
    await reauthenticate();
    await waitFor(() => expect(callsTo(mock, "/users", "POST")).toHaveLength(1));
    expect(JSON.parse(callsTo(mock, "/users", "POST")[0][1]!.body as string)).toMatchObject({ role: "SUPERADMIN", departmentCode: "IT" });
    const mutationPaths = mock.mock.calls.filter(([, init]) => init?.method === "POST").map(([path]) => path);
    expect(mutationPaths).toEqual(["/session/reauth", "/users"]);
  });

  it.each(["promote", "demote", "department"] as const)("requires step-up before a privileged access change: %s", async (change) => {
    const original = { ...target, role: change === "promote" ? "VETERINARIAN" as const : "SUPERADMIN" as const };
    const mock = mockApi(creator, original); await open("users");
    const form = screen.getByRole("form", { name: `Acesso de ${target.email}` });
    if (change === "department") fireEvent.change(within(form).getByLabelText("Setor"), { target: { value: "LABORATORY" } });
    else fireEvent.change(within(form).getByLabelText("Perfil"), { target: { value: change === "promote" ? "SUPERADMIN" : "VETERINARIAN" } });
    fireEvent.click(within(form).getByRole("button", { name: `Salvar ${target.email}` }));
    expect(callsTo(mock, "/users/target/roles", "POST")).toHaveLength(0);
    await reauthenticate();
    await waitFor(() => expect(callsTo(mock, "/users/target/roles", "POST")).toHaveLength(1));
    expect(JSON.parse(callsTo(mock, "/users/target/roles", "POST")[0][1]!.body as string)).toMatchObject({ expectedVersion: 7 });
  });

  it("keeps a Superadmin target read-only for technical ADMIN", async () => {
    const mock = mockApi({ ...creator, role: "ADMIN" }, { ...target, role: "SUPERADMIN" }); await open("users");
    expect(screen.getByText("Este acesso só pode ser gerenciado por outro Superadmin.")).toBeInTheDocument();
    expect(screen.queryByRole("form", { name: `Acesso de ${target.email}` })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Gerar nova senha" })).not.toBeInTheDocument();
    expect(mock.mock.calls.every(([, init]) => !init?.method)).toBe(true);
  });

  it.each([["Gerar nova senha", "/users/target/password"], ["Gerar link de redefinição", "/users/target/password-reset-link"]])("reauthenticates before recovering a Superadmin credential: %s", async (label, endpoint) => {
    const mock = mockApi(creator, { ...target, role: "SUPERADMIN" }); await open("users");
    fireEvent.click(screen.getByRole("button", { name: label }));
    const confirmation = await screen.findByRole("dialog");
    fireEvent.click(within(confirmation).getByRole("button", { name: endpoint.endsWith("password") ? "Gerar nova senha" : "Gerar link" }));
    expect(callsTo(mock, endpoint, "POST")).toHaveLength(0);
    await reauthenticate();
    await waitFor(() => expect(callsTo(mock, endpoint, "POST")).toHaveLength(1));
  });

  it("reauthenticates before changing a Superadmin on-call assignment", async () => {
    const mock = mockApi(creator, { ...target, role: "SUPERADMIN" }); await open("users");
    fireEvent.click(screen.getByRole("button", { name: "Colocar no plantão" }));
    expect(callsTo(mock, "/users/target/on-call", "PUT")).toHaveLength(0);
    await reauthenticate();
    await waitFor(() => expect(callsTo(mock, "/users/target/on-call", "PUT")).toHaveLength(1));
  });
});
