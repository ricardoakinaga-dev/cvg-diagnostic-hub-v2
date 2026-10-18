/** @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AccessGroup, AccessGroupImpactPreview, EffectiveAccessPreview, ManagedUser, PatientGrant, Permission, SessionResponse } from "@cvg/contracts";
import { AdminAccessGroups } from "./admin-access-groups";
import * as api from "./api-client";
import { permissionLabels } from "./admin-permission-labels";

const permissions: Permission[] = ["access_group.view", "access_group.create", "access_group.update", "access_group.deactivate", "access_group.assign", "user.view", "patient_scope.manage"];
const session: SessionResponse = { user: { id: "actor", email: "admin@cvg.local", displayName: "Admin", role: "ADMIN", departmentCode: "IT", timezone: "America/Sao_Paulo", permissions } };
const group: AccessGroup = { id: "group", code: "CARE", description: "Equipe clínica", permissions: ["user_role.manage", "service.catalog.manage"], active: true, version: 4, createdAt: "2026-10-11T00:00:00Z", updatedAt: "2026-10-11T00:00:00Z" };
const user: ManagedUser = { id: "care", email: "care@cvg.local", displayName: "Profissional", role: "VETERINARIAN", departmentCode: "INPATIENT", accessGroupId: group.id, active: true, version: 2, timezone: "America/Sao_Paulo", createdAt: "2026-10-11T00:00:00Z" };
const preview: EffectiveAccessPreview = { userId: user.id, userVersion: 2, groupVersion: 4, role: "VETERINARIAN", accessGroupId: "group", groupActive: true, origin: "GROUP", permissions: ["patient.view"], deniedByProfile: ["user.create"], addedPermissions: [], removedPermissions: ["request.create"], scopes: { departmentCode: "INPATIENT", managedDepartmentCodes: [], serviceCodes: [], patientCount: 1, globalPatients: false }, restrictions: ["O grupo não amplia escopos."] };
const options: Permission[] = ["user.create", "user.update", "user.deactivate", "service.catalog.create", "service.catalog.update", "service.catalog.deactivate", "patient.view"];
const impactToken = "a".repeat(64);
function groupImpact(users: ManagedUser[], candidate: { active?: boolean; permissions?: Permission[]; expectedVersion: number }): AccessGroupImpactPreview {
  return { groupId: group.id, groupVersion: candidate.expectedVersion, proposedActive: candidate.active ?? group.active, permissions: candidate.permissions ?? group.permissions, impactToken, boundUserCount: users.length, affectedUserCount: users.filter((user) => user.active).length, activeAffectedUserCount: users.filter((user) => user.active).length, requiresReauthentication: users.some((user) => user.role === "ADMIN" || user.role === "SUPERADMIN"), users: users.map((user) => ({ userId: user.id, displayName: user.displayName, role: user.role, userVersion: user.version, active: user.active, departmentCode: user.departmentCode, managedDepartmentCodes: [], serviceCodes: ["SYNTHETIC"], patientCount: 1, beforePermissions: ["request.create"], permissions: candidate.active === false ? [] : ["patient.view"], addedPermissions: [], removedPermissions: ["request.create"], effectiveAccessChanges: user.active })) };
}
async function reviewGroupImpact() { fireEvent.click(screen.getByRole("button", { name: "Ver impacto do grupo" })); await screen.findByLabelText("Impacto previsto do grupo"); await waitFor(() => expect(screen.getByRole("button", { name: /^(Salvar grupo|Confirmar .* do grupo)$/ })).toBeEnabled()); }
function mockApi(identity = session, override?: (path: string, request?: RequestInit) => unknown, users = [user], groups = [group]) {
  return vi.spyOn(api, "apiFetch").mockImplementation(async <T,>(path: string, request?: RequestInit) => {
    const custom = override?.(path, request); if (custom !== undefined) return await custom as T;
    if (path === "/session/me") return identity as T;
    if (path === "/access-groups/permissions") return options as T;
    if (path === "/access-groups") return (request?.method === "POST" ? { ...group, ...JSON.parse(request.body as string) } : groups) as T;
    if (path === "/users") return users as T;
    if (path.endsWith("/preview")) return groupImpact(users, JSON.parse(request!.body as string)) as T;
    if (path.endsWith("/access-preview")) return preview as T;
    if (path.endsWith("/patient-grants")) return [] as T;
    return { ...user, version: 3 } as T;
  });
}
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe("access group editor and effective preview", () => {
  it("materializes legacy manage flags as independent actions and saving a create-only choice removes broad grants", async () => {
    const mock = mockApi(); render(<AdminAccessGroups />);
    fireEvent.click(await screen.findByRole("button", { name: "Editar CARE" }));
    expect(screen.getByLabelText(permissionLabels["user.create"])).toBeChecked();
    expect(screen.getByLabelText(permissionLabels["user.update"])).toBeChecked();
    expect(screen.queryByLabelText(permissionLabels["user_role.manage"])).not.toBeInTheDocument();
    for (const permission of ["user.update", "user.deactivate", "service.catalog.update", "service.catalog.deactivate"] as const) fireEvent.click(screen.getByLabelText(permissionLabels[permission]));
    await reviewGroupImpact();
    fireEvent.click(screen.getByRole("button", { name: "Salvar grupo" }));
    await waitFor(() => expect(mock.mock.calls.some(([path, options]) => path === "/access-groups/group" && options?.method === "PATCH")).toBe(true));
    const payload = JSON.parse(mock.mock.calls.find(([path]) => path === "/access-groups/group")![1]?.body as string);
    expect(payload.expectedVersion).toBe(4);
    expect(payload.permissions).toContain("user.create");
    for (const forbidden of ["user_role.manage", "user.update", "user.deactivate", "service.catalog.manage"]) expect(payload.permissions).not.toContain(forbidden);
  });
  it("uses the evaluated user and group revisions when saving the previewed assignment", async () => {
    const mock = mockApi(); render(<AdminAccessGroups />);
    await screen.findByRole("button", { name: "Editar CARE" });
    fireEvent.change(screen.getByLabelText("Colaborador"), { target: { value: "care" } });
    fireEvent.click(screen.getByRole("button", { name: "Ver prévia do acesso" }));
    expect(await screen.findByLabelText("Prévia do acesso efetivo")).toHaveTextContent("Negadas pelo perfil: Criar colaboradores");
    fireEvent.click(screen.getByRole("button", { name: "Salvar vínculo" }));
    await waitFor(() => expect(mock.mock.calls.some(([path]) => path.endsWith("/access-group"))).toBe(true));
    const payload = JSON.parse(mock.mock.calls.find(([path]) => path.endsWith("/access-group"))![1]?.body as string);
    expect(payload).toEqual({ accessGroupId: "group", expectedVersion: 2, expectedGroupVersion: 4 });
  });
  it("a read-only permission shows preview without offering mutation controls", async () => {
    mockApi({ user: { ...session.user, permissions: ["access_group.view", "user.view"] } }); render(<AdminAccessGroups />);
    await screen.findByText("Grupos cadastrados");
    expect(screen.queryByRole("button", { name: "Editar CARE" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Inativar CARE" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Criar grupo" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Salvar vínculo" })).not.toBeInTheDocument();
  });
  it("records contextual reason for patient scope and sends no clinical fields", async () => {
    const mock = mockApi(); render(<AdminAccessGroups />);
    await screen.findByText("Grupos cadastrados");
    fireEvent.change(screen.getByLabelText("Colaborador"), { target: { value: "care" } });
    fireEvent.change(screen.getByLabelText("Identificador do paciente"), { target: { value: "opaque-patient" } });
    fireEvent.change(screen.getByLabelText("Motivo contextual"), { target: { value: "Profissional assumiu o atendimento" } });
    fireEvent.click(screen.getByRole("button", { name: "Conceder paciente" }));
    await waitFor(() => expect(mock.mock.calls.some(([path, options]) => path.endsWith("/patient-grants") && options?.method === "PUT")).toBe(true));
    expect(JSON.parse(mock.mock.calls.find(([path, options]) => path.endsWith("/patient-grants") && options?.method === "PUT")![1]?.body as string)).toEqual({ patientId: "opaque-patient", active: true, reason: "Profissional assumiu o atendimento", expectedVersion: 2 });
  });

  it("creates a genuinely create-only group and cancelling an edit resets the draft matrix", async () => {
    const mock = mockApi(); render(<AdminAccessGroups />); await screen.findByText("Grupos cadastrados"); fireEvent.change(screen.getByLabelText("Código"), { target: { value: "CREATE_ONLY" } }); fireEvent.change(screen.getByLabelText("Descrição"), { target: { value: "Criar sem alterar ou desativar" } }); fireEvent.click(screen.getByLabelText(permissionLabels["user.create"])); fireEvent.click(screen.getByLabelText(permissionLabels["patient.view"])); fireEvent.click(screen.getByLabelText(permissionLabels["patient.view"])); fireEvent.submit(screen.getByRole("form", { name: "Matriz do grupo" }));
    await screen.findByText("Grupo salvo. Os vínculos afetados foram reavaliados."); expect(JSON.parse(mock.mock.calls.find(([path, init]) => path === "/access-groups" && init?.method === "POST")![1]!.body as string)).toEqual({ code: "CREATE_ONLY", description: "Criar sem alterar ou desativar", permissions: ["user.create"] });
    fireEvent.click(screen.getByRole("button", { name: "Editar CARE" })); expect(screen.getByLabelText("Código")).toBeDisabled(); fireEvent.click(screen.getByRole("button", { name: "Cancelar edição" })); expect(screen.getByLabelText("Código")).toHaveValue(""); expect(screen.getByLabelText(permissionLabels["user.create"])).not.toBeChecked(); expect(screen.getByLabelText("Código")).toBeEnabled();
  });

  it("deactivates and reactivates the group using each returned revision without changing the registered users", async () => {
    let current = group; const mock = mockApi(session, (path, init) => { if (path === "/access-groups" && !init?.method) return [current]; if (path === "/access-groups/group" && init?.method) { const body = JSON.parse(init.body as string); current = { ...current, active: body.active, version: current.version + 1 }; return current; } }); render(<AdminAccessGroups />);
    fireEvent.click(await screen.findByRole("button", { name: "Inativar CARE" })); await reviewGroupImpact(); fireEvent.click(screen.getByRole("button", { name: "Confirmar inativação do grupo" })); await screen.findByText(/As contas permanecem cadastradas/); fireEvent.click(await screen.findByRole("button", { name: "Reativar CARE" })); await reviewGroupImpact(); fireEvent.click(screen.getByRole("button", { name: "Confirmar reativação do grupo" })); await screen.findByText(/somente as permissões compatíveis/);
    const writes = mock.mock.calls.filter(([path, init]) => path === "/access-groups/group" && init?.method); expect(writes.map(([, init]) => JSON.parse(init!.body as string))).toEqual([{ active: false, expectedVersion: 4, expectedImpactToken: impactToken }, { active: true, expectedVersion: 5, expectedImpactToken: impactToken }]); expect(mock.mock.calls.some(([path, init]) => path === "/users" && init?.method)).toBe(false);
  });

  it("previews unsaved independent choices and invalidates the preview when the selected base changes", async () => {
    const inactive = { ...group, id: "inactive", code: "INACTIVE", active: false }; const mock = mockApi(session, undefined, [user], [group, inactive]); render(<AdminAccessGroups />); fireEvent.click(await screen.findByRole("button", { name: "Editar CARE" })); fireEvent.change(screen.getByLabelText("Colaborador"), { target: { value: user.id } }); fireEvent.click(screen.getByLabelText(permissionLabels["user.update"])); fireEvent.click(screen.getByRole("button", { name: "Ver prévia do acesso" }));
    await screen.findByLabelText("Prévia do acesso efetivo"); const body = JSON.parse(mock.mock.calls.find(([path]) => path.endsWith("/access-preview"))![1]!.body as string); expect(body.accessGroupId).toBe("group"); expect(body.permissions).toContain("user.create"); expect(body.permissions).not.toContain("user.update"); expect(screen.getByRole("option", { name: "INACTIVE (inativo)" })).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Grupo base"), { target: { value: "" } }); expect(screen.queryByLabelText("Prévia do acesso efetivo")).not.toBeInTheDocument(); expect(screen.getByRole("button", { name: "Salvar vínculo" })).toBeDisabled();
  });

  it("shows a legacy preview without invented group metadata and assigns without claiming a previewed group revision", async () => {
    const legacy = { ...user, accessGroupId: undefined }; const mock = mockApi(session, (path) => path.endsWith("/access-preview") ? { ...preview, origin: "LEGACY_PROFILE", accessGroupId: undefined, groupActive: false, groupVersion: undefined, deniedByProfile: [], addedPermissions: ["patient.view"] } : undefined, [legacy]); render(<AdminAccessGroups />); await screen.findByText("Grupos cadastrados"); fireEvent.change(screen.getByLabelText("Colaborador"), { target: { value: user.id } }); fireEvent.click(screen.getByRole("button", { name: "Ver prévia do acesso" })); const result = await screen.findByLabelText("Prévia do acesso efetivo"); expect(result).toHaveTextContent("perfil legado"); expect(result).not.toHaveTextContent("Negadas pelo perfil");
    fireEvent.change(screen.getByLabelText("Grupo base"), { target: { value: group.id } }); fireEvent.click(screen.getByRole("button", { name: "Salvar vínculo" })); await screen.findByText("Vínculo salvo e sessões anteriores revogadas."); expect(JSON.parse(mock.mock.calls.find(([path]) => path.endsWith("/access-group"))![1]!.body as string)).toEqual({ accessGroupId: group.id, expectedVersion: user.version });
  });

  it("loads and revokes explicit patient grants with a contextual reason and refreshes the visible grant ledger", async () => {
    const grant: PatientGrant = { id: "grant", userId: user.id, patientId: "opaque-patient", active: true, version: 3, source: "ADMIN", createdAt: group.createdAt, updatedAt: group.updatedAt }; let current = grant;
    const mock = mockApi(session, (path, init) => { if (path.endsWith("/patient-grants")) { if (init?.method === "PUT") { current = { ...current, active: false }; return current; } return [current]; } }); render(<AdminAccessGroups />); await screen.findByText("Grupos cadastrados"); fireEvent.change(screen.getByLabelText("Colaborador"), { target: { value: user.id } }); fireEvent.click(screen.getByRole("button", { name: "Carregar concessões" })); const revoke = await screen.findByRole("button", { name: "Retirar opaque-patient" }); expect(revoke).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Motivo contextual"), { target: { value: "Equipe deixou o atendimento" } }); fireEvent.click(revoke); await screen.findByText("Escopo retirado e sessões anteriores revogadas."); expect(screen.queryByRole("button", { name: "Retirar opaque-patient" })).not.toBeInTheDocument(); expect(screen.getByLabelText("Motivo contextual")).toHaveValue(""); expect(JSON.parse(mock.mock.calls.find(([, init]) => init?.method === "PUT")![1]!.body as string)).toEqual({ patientId: grant.patientId, active: false, reason: "Equipe deixou o atendimento", expectedVersion: user.version });
  });

  it("does not query user identities without user.view and does not allow assigning one's own administrative access", async () => {
    const self = { ...user, id: session.user.id, role: "ADMIN" as const }; const mock = mockApi({ user: { ...session.user, permissions: ["access_group.view"] } }); render(<AdminAccessGroups />); await screen.findByText("Grupos cadastrados"); expect(mock.mock.calls.some(([path]) => path === "/users")).toBe(false); expect(screen.getByRole("button", { name: "Ver prévia do acesso" })).toBeDisabled();
    cleanup(); mock.mockRestore(); mockApi(session, undefined, [self]); render(<AdminAccessGroups />); await screen.findByText("Grupos cadastrados"); fireEvent.change(screen.getByLabelText("Colaborador"), { target: { value: session.user.id } }); expect(screen.getByRole("button", { name: "Salvar vínculo" })).toBeDisabled(); expect(screen.queryByLabelText("Identificador do paciente")).not.toBeInTheDocument();
  });

  it("requires reauthentication before changing a privileged user's group and cancellation sends no binding command", async () => {
    const privileged = { ...user, role: "SUPERADMIN" as const }; const mock = mockApi(session, undefined, [privileged]); render(<AdminAccessGroups />); await screen.findByText("Grupos cadastrados"); fireEvent.change(screen.getByLabelText("Colaborador"), { target: { value: user.id } }); fireEvent.click(screen.getByRole("button", { name: "Salvar vínculo" })); let dialog = screen.getByRole("dialog", { name: "Confirmar alteração de SUPERADMIN" }); expect(mock.mock.calls.some(([path]) => path.endsWith("/access-group"))).toBe(false); fireEvent.click(within(dialog).getByRole("button", { name: "Cancelar" })); expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Salvar vínculo" })); dialog = screen.getByRole("dialog"); fireEvent.change(within(dialog).getByLabelText("Senha para reautenticar"), { target: { value: "synthetic-password-2026" } }); fireEvent.click(within(dialog).getByRole("button", { name: "Confirmar" })); await screen.findByText("Vínculo salvo e sessões anteriores revogadas."); await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    const reauthIndex = mock.mock.calls.findIndex(([path]) => path === "/session/reauth"); const writeIndex = mock.mock.calls.findIndex(([path]) => path.endsWith("/access-group")); expect(reauthIndex).toBeLessThan(writeIndex); expect(JSON.parse(mock.mock.calls[writeIndex][1]!.body as string)).not.toHaveProperty("password");
  });

  it("requires reauthentication for both editing and deactivating a group bound to an administrator", async () => {
    const privileged = { ...user, role: "ADMIN" as const }; const mock = mockApi(session, undefined, [privileged]); render(<AdminAccessGroups />); fireEvent.click(await screen.findByRole("button", { name: "Editar CARE" })); fireEvent.change(screen.getByLabelText("Descrição"), { target: { value: "Grupo administrativo revisado" } }); await reviewGroupImpact(); fireEvent.submit(screen.getByRole("form", { name: "Matriz do grupo" })); let dialog = screen.getByRole("dialog"); fireEvent.change(within(dialog).getByLabelText("Senha para reautenticar"), { target: { value: "synthetic-password-2026" } }); fireEvent.click(within(dialog).getByRole("button", { name: "Confirmar" })); await screen.findByText("Grupo salvo. Os vínculos afetados foram reavaliados."); await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "Inativar CARE" })); await reviewGroupImpact(); fireEvent.click(screen.getByRole("button", { name: "Confirmar inativação do grupo" })); dialog = screen.getByRole("dialog"); fireEvent.change(within(dialog).getByLabelText("Senha para reautenticar"), { target: { value: "synthetic-password-2026" } }); fireEvent.click(within(dialog).getByRole("button", { name: "Confirmar" })); await screen.findByText(/As contas permanecem cadastradas/); expect(mock.mock.calls.filter(([path]) => path === "/session/reauth")).toHaveLength(2); expect(mock.mock.calls.filter(([path]) => path === "/access-groups/group")).toHaveLength(2);
  });

  it("propagates a rejected privileged change into the confirmation dialog without claiming that the group was saved", async () => {
    const mock = mockApi(session, (path) => { if (path === "/access-groups/group") throw new api.ApiClientError(409, { error: { code: "STALE_VERSION" } }); }, [{ ...user, role: "ADMIN" }]); render(<AdminAccessGroups />); fireEvent.click(await screen.findByRole("button", { name: "Editar CARE" })); await reviewGroupImpact(); fireEvent.submit(screen.getByRole("form", { name: "Matriz do grupo" })); const dialog = screen.getByRole("dialog"); fireEvent.change(within(dialog).getByLabelText("Senha para reautenticar"), { target: { value: "synthetic-password-2026" } }); fireEvent.click(within(dialog).getByRole("button", { name: "Confirmar" })); await within(dialog).findByRole("alert"); expect(screen.queryByText("Grupo salvo. Os vínculos afetados foram reavaliados.")).not.toBeInTheDocument(); expect(screen.getByLabelText("Código")).toHaveValue("CARE"); expect(mock.mock.calls.filter(([path]) => path === "/access-groups/group")).toHaveLength(1);
  });

  it("retains a new group draft on failure and rechecks effective access after a successful change revokes the actor's grant", async () => {
    let fail = true; let revoked = false; const mock = mockApi(session, (path, init) => { if (path === "/session/me" && revoked) return { user: { ...session.user, permissions: [] } }; if (path === "/access-groups" && init?.method) { if (fail) throw new Error("internal database detail"); revoked = true; return group; } }); render(<AdminAccessGroups />); await screen.findByText("Grupos cadastrados"); fireEvent.change(screen.getByLabelText("Código"), { target: { value: "NEW" } }); fireEvent.change(screen.getByLabelText("Descrição"), { target: { value: "Draft retained" } }); const form = screen.getByRole("form", { name: "Matriz do grupo" }); fireEvent.submit(form); expect(await screen.findByRole("alert")).toHaveTextContent("Não foi possível salvar a alteração."); expect(screen.getByLabelText("Descrição")).toHaveValue("Draft retained"); expect(screen.queryByText(/internal database/)).not.toBeInTheDocument();
    fail = false; fireEvent.submit(form); await screen.findByText("Acesso indisponível"); expect(screen.queryByRole("form")).not.toBeInTheDocument(); expect(mock.mock.calls.filter(([path, init]) => path === "/access-groups" && init?.method)).toHaveLength(2);
  });

  it("offers recovery from an initial read failure without manufacturing users or groups", async () => {
    let failed = true; mockApi(session, (path) => { if (path === "/session/me" && failed) throw new Error("private internal detail"); if (path === "/access-groups") return []; }); render(<AdminAccessGroups />); expect(await screen.findByRole("alert")).toHaveTextContent("Não foi possível carregar os grupos."); failed = false; fireEvent.click(screen.getByRole("button", { name: "Tentar novamente" })); await screen.findByText("Nenhum grupo"); expect(screen.queryByRole("button", { name: "Editar CARE" })).not.toBeInTheDocument();
  });
  it("requires a complete current group preview, explains all affected scopes and invalidates it after editing or a realtime change", async () => {
    const second = { ...user, id: "second", displayName: "Segundo profissional", active: false };
    const mock = mockApi(session, undefined, [user, second]); render(<AdminAccessGroups />);
    fireEvent.click(await screen.findByRole("button", { name: "Editar CARE" }));
    expect(screen.getByRole("button", { name: "Salvar grupo" })).toBeDisabled();
    fireEvent.submit(screen.getByRole("form", { name: "Matriz do grupo" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Confira o impacto atual");
    expect(mock.mock.calls.some(([path]) => path === "/access-groups/group")).toBe(false);
    await reviewGroupImpact(); const impact = screen.getByLabelText("Impacto previsto do grupo");
    expect(impact).toHaveTextContent("2 colaborador(es) vinculado(s)"); expect(impact).toHaveTextContent("Segundo profissional"); expect(impact).toHaveTextContent("conta inativa"); expect(impact).toHaveTextContent("SYNTHETIC"); expect(impact).toHaveTextContent("Concessões restantes");
    fireEvent.change(screen.getByLabelText("Descrição"), { target: { value: "Nova proposta" } }); expect(screen.getByRole("button", { name: "Salvar grupo" })).toBeDisabled();
    await reviewGroupImpact(); fireEvent(window, new Event("cvg:realtime-updated"));
    await waitFor(() => expect(screen.getByRole("button", { name: "Salvar grupo" })).toBeDisabled());
    expect(mock.mock.calls.some(([path]) => path === "/access-groups/group")).toBe(false);
    await reviewGroupImpact(); fireEvent.click(screen.getByRole("button", { name: "Salvar grupo" })); await screen.findByText("Grupo salvo. Os vínculos afetados foram reavaliados.");
    const body = JSON.parse(mock.mock.calls.find(([path]) => path === "/access-groups/group")![1]!.body as string); expect(body).toMatchObject({ description: "Nova proposta", expectedVersion: 4, expectedImpactToken: impactToken });
  });
  it("clears a denied impact snapshot and preserves a newly authorized candidate on version conflict", async () => {
    let readDenied = true; const mock = mockApi(session, (path) => { if (path.endsWith("/preview") && readDenied) throw new api.ApiClientError(404, { error: { code: "SCOPE_DENIED" } }); if (path === "/access-groups/group") throw new api.ApiClientError(409, { error: { code: "STALE_VERSION" } }); }); render(<AdminAccessGroups />);
    fireEvent.click(await screen.findByRole("button", { name: "Editar CARE" })); fireEvent.change(screen.getByLabelText("Descrição"), { target: { value: "Proposta negada" } }); fireEvent.click(screen.getByRole("button", { name: "Ver impacto do grupo" })); await screen.findByRole("alert"); expect(screen.queryByRole("button", { name: "Salvar grupo" })).not.toBeInTheDocument(); expect(screen.queryByLabelText("Impacto previsto do grupo")).not.toBeInTheDocument(); expect(screen.queryByLabelText("Descrição")).not.toBeInTheDocument();
    readDenied = false; fireEvent(window, new Event("cvg:realtime-resync")); fireEvent.click(await screen.findByRole("button", { name: "Editar CARE" })); fireEvent.change(screen.getByLabelText("Descrição"), { target: { value: "Proposta mantida" } }); await reviewGroupImpact(); fireEvent.click(screen.getByRole("button", { name: "Salvar grupo" })); await screen.findByRole("alert"); expect(screen.getByLabelText("Descrição")).toHaveValue("Proposta mantida"); expect(screen.getByRole("button", { name: "Salvar grupo" })).toBeDisabled(); expect(screen.queryByText("Grupo salvo. Os vínculos afetados foram reavaliados.")).not.toBeInTheDocument(); expect(mock.mock.calls.filter(([path]) => path === "/access-groups/group")).toHaveLength(1);
  });

  it("updates a conflicted group revision explicitly while preserving the candidate and requiring a new preview", async () => {
    let current = group; const mock = mockApi(session, (path, init) => path === "/access-groups" && !init?.method ? [current] : undefined); render(<AdminAccessGroups />);
    fireEvent.click(await screen.findByRole("button", { name: "Editar CARE" })); fireEvent.change(screen.getByLabelText("Descrição"), { target: { value: "Minha proposta" } }); await reviewGroupImpact();
    current = { ...group, version: 5, description: "Outra edição" }; fireEvent.click(screen.getByRole("button", { name: "Atualizar revisão para comparar" })); await screen.findByText(/Revisão atualizada/);
    expect(screen.getByLabelText("Descrição")).toHaveValue("Minha proposta"); expect(screen.getByRole("button", { name: "Salvar grupo" })).toBeDisabled(); await reviewGroupImpact();
    const calls = mock.mock.calls.filter(([path]) => path.endsWith("/preview")); expect(JSON.parse(calls.at(-1)![1]!.body as string)).toMatchObject({ description: "Minha proposta", expectedVersion: 5 });
  });

});
