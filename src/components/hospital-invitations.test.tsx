/** @vitest-environment jsdom */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DiagnosticService, HospitalInvitationOptions, HospitalInvitationView, SessionUser } from "@cvg/contracts";
import { HospitalInvitations } from "./hospital-invitations";
import { HospitalInvitationAccept } from "./hospital-invitation-accept";
import * as api from "./api-client";

const manager: SessionUser = { id: "inviter", email: "inviter@example.invalid", displayName: "Gestor sintético", role: "MANAGER", departmentCode: "LAB", timezone: "America/Sao_Paulo", permissions: ["user_invite.manage", "user.create", "access_group.assign", "service.catalog.view"] };
const options: HospitalInvitationOptions = { roles: ["VETERINARIAN", "LAB_TECH", "RADIOLOGY_TEAM"], departments: [{ code: "LAB", name: "Laboratório" }, { code: "RADIOLOGY", name: "Radiologia" }], groups: [{ id: "limited", code: "LIMITED", description: "Acesso limitado", version: 7 }] };
const pending: HospitalInvitationView = { invitation: { id: "invitation-1", email: "new@example.invalid", displayName: "Colaborador convidado", role: "LAB_TECH", departmentCode: "LAB", accessGroupId: "limited", expectedGroupVersion: 7, issuedBy: manager.id, status: "PENDING", expiresAt: "2026-10-12T12:00:00Z", version: 3, createdAt: "2026-10-11T12:00:00Z", updatedAt: "2026-10-11T12:00:00Z" }, expired: false };
const token = "x".repeat(43);
function service(code: string, departmentCode: string, active = true): DiagnosticService { return { id: code, code, name: `Exame ${code}`, category: "LABORATORY", departmentCode, workflowType: "LABORATORY", requiresSample: true, requiresSchedule: false, allowsAttachment: false, active, version: 1, slaHours: { ROUTINE: 8, URGENT: 4, EMERGENCY: 2 }, resultSchema: "NARRATIVE" }; }
function mockApi(override?: (path: string, init?: RequestInit) => unknown, identity = manager, entries: HospitalInvitationView[] = []) {
  return vi.spyOn(api, "apiFetch").mockImplementation(async <T,>(path: string, init?: RequestInit) => {
    const custom = override?.(path, init); if (custom !== undefined) return await custom as T;
    if (path === "/session/me") return { user: identity } as T;
    if (path === "/hospital-user-invitations/options") return options as T;
    if (path === "/diagnostic-services") return [service("CBC", "LAB"), service("OLD", "LAB", false), service("XRAY", "RADIOLOGY")] as T;
    if (path === "/hospital-user-invitations") return (init?.method ? { invitation: pending.invitation, token, tokenReturnedOnce: true } : entries) as T;
    throw new Error(`Unexpected invitation API ${path}`);
  });
}
async function fillInvitation(role = "VETERINARIAN", department = "LAB") {
  const form = await screen.findByRole("form", { name: "Emitir convite operacional" });
  await waitFor(() => expect(within(form).getByLabelText("Nome de quem receberá")).toBeEnabled());
  fireEvent.change(within(form).getByLabelText("Nome de quem receberá"), { target: { value: "  Profissional sintético  " } });
  fireEvent.change(within(form).getByLabelText("Email do convite"), { target: { value: "new@example.invalid" } });
  fireEvent.change(within(form).getByLabelText("Perfil convidado"), { target: { value: role } });
  fireEvent.change(within(form).getByLabelText("Setor do convite"), { target: { value: department } });
  fireEvent.change(within(form).getByLabelText("Grupo do convite"), { target: { value: "limited" } });
  return form;
}
function writes(mock: ReturnType<typeof mockApi>) { return mock.mock.calls.filter(([, init]) => init?.method && init.method !== "GET"); }
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); window.history.replaceState(null, "", "/"); });

describe("operational invitations", () => {
  it("issues a bounded invitation with the selected group revision and keeps its one-time token out of URL queries and storage", async () => {
    const mock = mockApi(); const copy = vi.fn().mockResolvedValue(undefined); vi.stubGlobal("navigator", { clipboard: { writeText: copy } });
    const setItem = vi.spyOn(Storage.prototype, "setItem"); render(<HospitalInvitations />);
    const form = await fillInvitation(); fireEvent.change(screen.getByLabelText("Validade em horas"), { target: { value: "48" } }); fireEvent.submit(form);
    const link = await screen.findByLabelText("Link pessoal do convite");
    expect(link).toHaveValue(`${window.location.origin}/invite#${token}`);
    expect(JSON.parse(writes(mock)[0][1]!.body as string)).toEqual({ email: "new@example.invalid", displayName: "Profissional sintético", role: "VETERINARIAN", departmentCode: "LAB", accessGroupId: "limited", expectedGroupVersion: 7, expiresInHours: 48 });
    expect(window.location.href).not.toContain(token); expect(setItem).not.toHaveBeenCalled(); expect(mock.mock.calls.every(([path]) => !path.includes(token))).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Copiar link pessoal" })); await screen.findByText(/Link copiado/); expect(copy).toHaveBeenCalledWith(`${window.location.origin}/invite#${token}`);
    fireEvent.click(screen.getByRole("button", { name: "Ocultar link do convite" })); expect(screen.queryByLabelText("Link pessoal do convite")).not.toBeInTheDocument();
    cleanup(); render(<HospitalInvitations />); await fillInvitation(); expect(screen.queryByLabelText("Link pessoal do convite")).not.toBeInTheDocument();
  });

  it("offers only active examinations in the selected sector and clears selections after role or sector changes", async () => {
    const mock = mockApi(); render(<HospitalInvitations />); const form = await fillInvitation("LAB_TECH");
    const exam = await screen.findByLabelText("Exame CBC"); expect(screen.queryByLabelText("Exame OLD")).not.toBeInTheDocument(); expect(screen.queryByLabelText("Exame XRAY")).not.toBeInTheDocument();
    fireEvent.click(exam); fireEvent.click(exam); expect(exam).not.toBeChecked(); fireEvent.click(exam);
    fireEvent.change(screen.getByLabelText("Perfil convidado"), { target: { value: "VETERINARIAN" } }); expect(screen.queryByLabelText("Exame CBC")).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Perfil convidado"), { target: { value: "LAB_TECH" } }); expect(screen.getByLabelText("Exame CBC")).not.toBeChecked(); fireEvent.click(screen.getByLabelText("Exame CBC"));
    fireEvent.change(screen.getByLabelText("Setor do convite"), { target: { value: "RADIOLOGY" } }); fireEvent.change(screen.getByLabelText("Setor do convite"), { target: { value: "LAB" } }); expect(screen.getByLabelText("Exame CBC")).not.toBeChecked();
    fireEvent.submit(form); await screen.findByLabelText("Link pessoal do convite"); expect(JSON.parse(writes(mock)[0][1]!.body as string).serviceCodes).toEqual([]);
  });

  it("retains the issuance intent after an ambiguous failure and explains a replay that cannot return the token again", async () => {
    let attempts = 0; const mock = mockApi((path, init) => { if (path === "/hospital-user-invitations" && init?.method) { if (++attempts === 1) throw new api.ApiClientError(503, {}); return { invitation: pending.invitation, tokenReturnedOnce: false }; } });
    render(<HospitalInvitations />); const form = await fillInvitation(); fireEvent.submit(form); await screen.findByRole("alert"); expect(screen.getByLabelText("Nome de quem receberá")).toHaveValue("  Profissional sintético  ");
    fireEvent.submit(form); await screen.findByText(/O link desta emissão já foi consumido/); expect(writes(mock)[0][1]!.headers).toEqual(writes(mock)[1][1]!.headers); expect(screen.queryByLabelText("Link pessoal do convite")).not.toBeInTheDocument();
  });

  it("provides manual copying when clipboard access is denied", async () => {
    mockApi(); vi.stubGlobal("navigator", { clipboard: { writeText: vi.fn().mockRejectedValue(new Error("clipboard unavailable")) } }); render(<HospitalInvitations />); fireEvent.submit(await fillInvitation());
    await screen.findByLabelText("Link pessoal do convite"); fireEvent.click(screen.getByRole("button", { name: "Copiar link pessoal" })); await screen.findByText("Selecione o link para copiar manualmente."); expect(screen.getByLabelText("Link pessoal do convite")).toHaveValue(`${window.location.origin}/invite#${token}`);
  });

  it("revokes a pending invitation with its revision and reason, retaining input on conflict", async () => {
    let revoked = false; let attempts = 0;
    const mock = mockApi((path, init) => { if (path === "/hospital-user-invitations" && !init?.method) return [{ ...pending, expired: true, invitation: { ...pending.invitation, status: revoked ? "REVOKED" : "PENDING", version: revoked ? 4 : 3 } }, { ...pending, invitation: { ...pending.invitation, id: "accepted", displayName: "Já admitido", status: "ACCEPTED" } }]; if (path.endsWith("/revoke")) { if (++attempts === 1) throw new api.ApiClientError(409, { error: { code: "STALE_VERSION" } }); revoked = true; return { ...pending.invitation, status: "REVOKED" }; } });
    render(<HospitalInvitations />); const row = (await screen.findByRole("heading", { name: "Colaborador convidado" })).closest("li")!; expect(row).toHaveTextContent("Expirado");
    fireEvent.click(within(row).getByRole("button", { name: "Revogar convite" })); fireEvent.click(within(row).getByRole("button", { name: "Revogar convite" })); expect(within(row).queryByLabelText("Motivo da revogação")).not.toBeInTheDocument(); fireEvent.click(within(row).getByRole("button", { name: "Revogar convite" }));
    fireEvent.submit(within(row).getByLabelText("Motivo da revogação").closest("form")!); expect(writes(mock)).toHaveLength(0);
    fireEvent.change(within(row).getByLabelText("Motivo da revogação"), { target: { value: "  Mudança de equipe  " } }); fireEvent.click(within(row).getByRole("button", { name: "Confirmar revogação" })); await within(row).findByRole("alert"); expect(within(row).getByLabelText("Motivo da revogação")).toHaveValue("  Mudança de equipe  ");
    fireEvent.click(within(row).getByRole("button", { name: "Confirmar revogação" })); await waitFor(() => expect(screen.queryByRole("button", { name: "Revogar convite" })).not.toBeInTheDocument()); expect(JSON.parse(writes(mock)[0][1]!.body as string)).toEqual({ reason: "Mudança de equipe", expectedVersion: 3 });
    expect(screen.getByRole("heading", { name: "Já admitido" }).closest("li")).toHaveTextContent("Aceito");
  });

  it("prevents issuance without a selected group or while delegated options are unavailable, and can retry the read", async () => {
    let unavailable = true; const mock = mockApi((path) => { if (path.endsWith("/options") && unavailable) throw new api.ApiClientError(503, {}); }); render(<HospitalInvitations />);
    await screen.findByText("Leitura parcial"); fireEvent.submit(screen.getByRole("form", { name: "Emitir convite operacional" })); expect(writes(mock)).toHaveLength(0);
    unavailable = false; fireEvent.click(screen.getByRole("button", { name: "Tentar novamente" })); await waitFor(() => expect(screen.getByLabelText("Nome de quem receberá")).toBeEnabled());
    fireEvent.submit(screen.getByRole("form", { name: "Emitir convite operacional" })); expect(writes(mock)).toHaveLength(0);
    fireEvent.submit(await fillInvitation()); await screen.findByLabelText("Link pessoal do convite"); expect(writes(mock)).toHaveLength(1);
  });

  it("disables cached invitation actions after a failed refresh and removes the list after access revocation", async () => {
    let failure = 0; const mock = mockApi((path, init) => { if (path === "/hospital-user-invitations" && !init?.method && failure) throw new api.ApiClientError(failure, {}); }, manager, [pending]); render(<HospitalInvitations />); await screen.findByRole("button", { name: "Revogar convite" }); await fillInvitation();
    failure = 503; act(() => window.dispatchEvent(new Event("cvg:realtime-updated"))); await screen.findByText("Leitura parcial"); expect(screen.getByRole("button", { name: "Revogar convite" })).toBeDisabled(); expect(screen.getByRole("button", { name: "Emitir convite" })).toBeDisabled();
    fireEvent.submit(screen.getByRole("form", { name: "Emitir convite operacional" })); expect(writes(mock)).toHaveLength(0);
    failure = 0; fireEvent.click(screen.getByRole("button", { name: "Tentar novamente" })); await waitFor(() => expect(screen.getByRole("button", { name: "Revogar convite" })).toBeEnabled());
    failure = 403; act(() => window.dispatchEvent(new Event("cvg:realtime-updated"))); await waitFor(() => expect(screen.queryByRole("heading", { name: "Colaborador convidado" })).not.toBeInTheDocument());
  });

  it.each([{ permissions: ["user_invite.manage", "user.create"] as const }, { permissions: ["user_invite.manage", "access_group.assign"] as const }])("does not offer issuance when only $permissions is granted", async ({ permissions }) => {
    const mock = mockApi(undefined, { ...manager, permissions: [...permissions] }); render(<HospitalInvitations />); await screen.findByText("Nenhum convite no seu escopo."); expect(screen.queryByRole("form")).not.toBeInTheDocument(); expect(mock.mock.calls.some(([path]) => path.endsWith("/options") || path === "/diagnostic-services")).toBe(false);
  });

  it("supports legacy administrative grants without requesting a diagnostic catalog not granted to the inviter", async () => {
    const mock = mockApi(undefined, { ...manager, permissions: ["user_invite.manage", "user_role.manage"] }); render(<HospitalInvitations />); await fillInvitation(); expect(mock.mock.calls.some(([path]) => path === "/diagnostic-services")).toBe(false);
  });

  it("shows identity failures and never reads invitation records without management permission", async () => {
    const mock = mockApi((path) => { if (path === "/session/me") throw new api.ApiClientError(401, {}); }); render(<HospitalInvitations />); await screen.findByText("Convites indisponíveis"); expect(mock.mock.calls.some(([path]) => path === "/hospital-user-invitations")).toBe(false);
    cleanup(); mock.mockRestore(); const denied = mockApi(undefined, { ...manager, permissions: [] }); render(<HospitalInvitations />); await screen.findByText("Convites fora do seu acesso"); expect(denied.mock.calls.some(([path]) => path === "/hospital-user-invitations")).toBe(false);
  });
});

describe("private invitation acceptance", () => {
  it("rejects an incomplete fragment locally and removes it from browser history", async () => {
    const mock = vi.spyOn(api, "apiFetch"); window.history.replaceState(null, "", "/invite#incomplete"); render(<HospitalInvitationAccept />); await screen.findByRole("alert"); expect(window.location.hash).toBe(""); expect(mock).not.toHaveBeenCalled();
  });
  it("does not offer password entry when the preview is expired or revoked", async () => {
    const mock = vi.spyOn(api, "apiFetch").mockRejectedValue(new api.ApiClientError(404, {})); window.history.replaceState(null, "", `/invite#${token}`); render(<HospitalInvitationAccept />); await screen.findByRole("alert"); expect(screen.queryByLabelText("Crie sua senha")).not.toBeInTheDocument(); expect(JSON.parse(mock.mock.calls[0][1]!.body as string)).toEqual({ token }); expect(mock.mock.calls[0][0]).not.toContain(token);
  });
  it("requires matching passwords and handles revocation after preview without claiming successful admission", async () => {
    const mock = vi.spyOn(api, "apiFetch").mockImplementation(async <T,>(path: string) => { if (path.endsWith("/preview")) return { institutionName: "Hospital sintético", displayName: "Convidado", maskedEmail: "n***@example.invalid", expiresAt: pending.invitation.expiresAt } as T; throw new api.ApiClientError(404, {}); });
    window.history.replaceState(null, "", `/invite#${token}`); render(<HospitalInvitationAccept />); fireEvent.change(await screen.findByLabelText("Crie sua senha"), { target: { value: "synthetic-password-2026" } }); fireEvent.change(screen.getByLabelText("Confirme sua senha"), { target: { value: "different-password-2026" } });
    fireEvent.submit(screen.getByRole("form", { name: "Aceitar convite operacional" })); await screen.findByText("As senhas devem ser iguais."); expect(mock.mock.calls).toHaveLength(1);
    fireEvent.change(screen.getByLabelText("Confirme sua senha"), { target: { value: "synthetic-password-2026" } }); fireEvent.submit(screen.getByRole("form", { name: "Aceitar convite operacional" })); await screen.findByRole("alert"); expect(screen.queryByRole("heading", { name: "Convite aceito" })).not.toBeInTheDocument(); expect(JSON.parse(mock.mock.calls[1][1]!.body as string)).toEqual({ token, password: "synthetic-password-2026" }); expect(window.location.hash).toBe("");
  });
});
