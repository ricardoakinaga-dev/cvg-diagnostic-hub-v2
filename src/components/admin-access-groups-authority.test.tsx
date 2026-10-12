/** @vitest-environment jsdom */
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AccessGroup, AccessGroupImpactPreview, EffectiveAccessPreview, ManagedUser, PatientGrant, Permission, SessionResponse } from "@cvg/contracts";
import { AdminAccessGroups } from "./admin-access-groups";
import * as api from "./api-client";

const permissions: Permission[] = ["access_group.view", "access_group.update", "access_group.assign", "user.view", "patient_scope.manage"];
const identity: SessionResponse = { user: { id: "authority-admin-a", email: "authority-a@example.test", displayName: "Administrador A", role: "ADMIN", departmentCode: "IT", timezone: "America/Sao_Paulo", permissions } };
const group: AccessGroup = { id: "authority-group", code: "AUTHORITY", description: "Matriz privada A", permissions: ["patient.view"], active: true, version: 4, createdAt: "2026-10-11T00:00:00Z", updatedAt: "2026-10-11T00:00:00Z" };
const user: ManagedUser = { id: "authority-user-a", email: "authority-user@example.test", displayName: "Colaborador privado A", role: "VETERINARIAN", departmentCode: "INPATIENT", accessGroupId: group.id, active: true, version: 2, timezone: "America/Sao_Paulo", createdAt: group.createdAt };
const preview: EffectiveAccessPreview = { userId: user.id, userVersion: 2, groupVersion: 4, role: user.role, accessGroupId: group.id, groupActive: true, origin: "GROUP", permissions: ["patient.view"], deniedByProfile: [], addedPermissions: [], removedPermissions: [], scopes: { departmentCode: user.departmentCode, managedDepartmentCodes: [], serviceCodes: [], patientCount: 1, globalPatients: false }, restrictions: ["Prévia privada A"] };
const impact: AccessGroupImpactPreview = { groupId: group.id, groupVersion: 4, proposedActive: true, permissions: ["patient.view"], impactToken: "a".repeat(64), boundUserCount: 1, affectedUserCount: 0, activeAffectedUserCount: 0, requiresReauthentication: false, users: [{ userId: user.id, displayName: user.displayName, role: user.role, userVersion: user.version, active: true, departmentCode: user.departmentCode, managedDepartmentCodes: [], serviceCodes: [], patientCount: 1, beforePermissions: ["patient.view"], permissions: ["patient.view"], addedPermissions: [], removedPermissions: [], effectiveAccessChanges: false }] };
const grant: PatientGrant = { id: "authority-grant", userId: user.id, patientId: "private-patient-a", active: true, source: "ADMIN", version: 1, createdAt: group.createdAt, updatedAt: group.updatedAt };
function deferred<T>() { let resolve!: (value: T) => void; let reject!: (error: Error) => void; const promise = new Promise<T>((complete, fail) => { resolve = complete; reject = fail; }); return { promise, resolve, reject }; }
function fixture(targetUser = user) {
  let current = identity; let readFailure: number | undefined; let delayedPath = ""; let pending: Promise<unknown> | undefined; let deniedPath = ""; let pathStatus = 404;
  const mock = vi.spyOn(api, "apiFetch").mockImplementation(async <T,>(path: string, init?: RequestInit) => {
    if (path === "/session/me") { if (readFailure) throw new api.ApiClientError(readFailure, { error: { code: readFailure === 503 ? "STORAGE_UNAVAILABLE" : "SCOPE_DENIED" } }); return current as T; }
    if (path === deniedPath) throw new api.ApiClientError(pathStatus, { error: { code: "SCOPE_DENIED" } });
    if (path === delayedPath && pending) return await pending as T;
    if (path === "/access-groups") return [group] as T;
    if (path === "/access-groups/permissions") return ["patient.view"] as T;
    if (path === "/users") return [{ ...targetUser, ...(current.user.id !== identity.user.id ? { id: "authority-user-b", displayName: "Colaborador B" } : {}) }] as T;
    if (path.endsWith("/access-preview")) return preview as T;
    if (path.endsWith("/preview")) return impact as T;
    if (path.endsWith("/patient-grants")) return [grant] as T;
    if (path.endsWith("/access-group")) return targetUser as T;
    if (init?.method === "PATCH") return { ...group, version: 5 } as T;
    throw new Error(`Unexpected synthetic path ${path}`);
  });
  const refresh = () => act(() => window.dispatchEvent(new Event("cvg:realtime-resync")));
  return { mock, refresh, fail: (status?: number) => { readFailure = status; }, denyPath: (path: string, status = 404) => { deniedPath = path; pathStatus = status; }, identify: (next: SessionResponse) => { current = next; }, delay: (path: string, promise: Promise<unknown>) => { delayedPath = path; pending = promise; } };
}
async function loaded() { render(<AdminAccessGroups />); await screen.findByRole("button", { name: "Editar AUTHORITY" }); }
async function selectUser(id = user.id) { fireEvent.change(screen.getByLabelText("Colaborador"), { target: { value: id } }); }
async function privateSnapshot() {
  await loaded(); await selectUser(); fireEvent.click(screen.getByRole("button", { name: "Ver prévia do acesso" })); await screen.findByLabelText("Prévia do acesso efetivo");
  await waitFor(() => expect(screen.getByRole("button", { name: "Editar AUTHORITY" })).toBeEnabled()); fireEvent.click(screen.getByRole("button", { name: "Editar AUTHORITY" }));
  fireEvent.click(screen.getByRole("button", { name: "Ver impacto do grupo" })); await screen.findByLabelText("Impacto previsto do grupo");
  await waitFor(() => expect(screen.getByRole("button", { name: "Carregar concessões" })).toBeEnabled()); fireEvent.click(screen.getByRole("button", { name: "Carregar concessões" })); await screen.findByText("private-patient-a");
  await waitFor(() => expect(screen.getByRole("button", { name: "Salvar vínculo" })).toBeEnabled());
}
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe("access-group UI current authority", () => {
  it.each([401, 403, 404])("clears the loaded directory, grants, drafts and previews after a current %s session denial", async status => {
    const f = fixture(); await privateSnapshot(); f.fail(status); f.refresh(); await screen.findByRole("alert");
    expect(screen.queryByRole("button", { name: "Editar AUTHORITY" })).not.toBeInTheDocument();
    expect(screen.queryByRole("option", { name: /Colaborador privado A/ })).not.toBeInTheDocument();
    expect(screen.queryByText("private-patient-a")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Prévia do acesso efetivo")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Impacto previsto do grupo")).not.toBeInTheDocument();
    expect(screen.queryByRole("form", { name: "Matriz do grupo" })).not.toBeInTheDocument();
  });

  it("retains the authorized snapshot on 503, blocks commands and resumes after a successful current read", async () => {
    const f = fixture(); await privateSnapshot(); f.fail(503); f.refresh(); await screen.findByRole("alert");
    expect(screen.getByRole("option", { name: /Colaborador privado A/ })).toBeInTheDocument(); expect(screen.getByText("private-patient-a")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Salvar vínculo" })).toBeDisabled();
    const writes = f.mock.mock.calls.filter(([, init]) => init?.method).length;
    fireEvent.submit(screen.getByRole("form", { name: "Matriz do grupo" })); expect(f.mock.mock.calls.filter(([, init]) => init?.method)).toHaveLength(writes);
    f.fail(); fireEvent.click(screen.getByRole("button", { name: "Recarregar grupos de acesso" })); await waitFor(() => expect(screen.getByRole("button", { name: "Salvar vínculo" })).toBeEnabled());
    expect(screen.getByText("private-patient-a")).toBeInTheDocument();
  });

  it("clears the private selection and draft when a valid session no longer has group view", async () => {
    const f = fixture(); await privateSnapshot(); f.identify({ user: { ...identity.user, permissions: [] } }); f.refresh(); await screen.findByText("Acesso indisponível");
    expect(screen.queryByText("private-patient-a")).not.toBeInTheDocument(); expect(screen.queryByLabelText("Colaborador")).not.toBeInTheDocument();
    f.identify(identity); f.refresh(); await screen.findByRole("button", { name: "Editar AUTHORITY" }); expect(screen.getByLabelText("Colaborador")).toHaveValue("");
    expect(screen.queryByRole("form", { name: "Matriz do grupo" })).not.toBeInTheDocument();
  });

  it.each([401, 403, 404])("evicts the snapshot when a currently submitted assignment returns %s", async status => {
    const f = fixture(); await privateSnapshot(); f.denyPath(`/users/${user.id}/access-group`, status); fireEvent.click(screen.getByRole("button", { name: "Salvar vínculo" })); await screen.findByText("Acesso indisponível");
    expect(screen.queryByRole("option", { name: /Colaborador privado A/ })).not.toBeInTheDocument(); expect(screen.queryByText("private-patient-a")).not.toBeInTheDocument(); expect(screen.queryByLabelText("Descrição")).not.toBeInTheDocument();
  });

  it("evicts an otherwise valid identity when the current directory read is denied", async () => {
    const f = fixture(); await privateSnapshot(); f.denyPath("/access-groups", 403); f.refresh(); await screen.findByText("Acesso indisponível");
    expect(screen.queryByRole("button", { name: "Editar AUTHORITY" })).not.toBeInTheDocument(); expect(screen.queryByText("private-patient-a")).not.toBeInTheDocument();
  });

  it("cannot restore a stale directory response after a newer session denial", async () => {
    const f = fixture(); await privateSnapshot(); const pending = deferred<AccessGroup[]>(); f.delay("/access-groups", pending.promise); f.refresh();
    await waitFor(() => expect(screen.getByRole("button", { name: "Salvar vínculo" })).toBeDisabled()); f.fail(401); f.refresh(); await screen.findByText("Acesso indisponível");
    await act(async () => pending.resolve([group])); expect(screen.queryByRole("button", { name: "Editar AUTHORITY" })).not.toBeInTheDocument(); expect(screen.queryByText("private-patient-a")).not.toBeInTheDocument();
  });

  it("discards an old account's rejected response without clearing the next account's authorized editor", async () => {
    const f = fixture(); await loaded(); await selectUser(); const pending = deferred<unknown>(); f.delay(`/users/${user.id}/access-preview`, pending.promise); fireEvent.click(screen.getByRole("button", { name: "Ver prévia do acesso" }));
    await waitFor(() => expect(f.mock.mock.calls.some(([path]) => path.endsWith("/access-preview"))).toBe(true)); f.identify({ user: { ...identity.user, id: "authority-admin-b" } }); f.refresh(); await screen.findByRole("option", { name: /Colaborador B/ });
    fireEvent.click(screen.getByRole("button", { name: "Editar AUTHORITY" })); fireEvent.change(screen.getByLabelText("Descrição"), { target: { value: "Proposta da conta B" } });
    await act(async () => pending.reject(new api.ApiClientError(404, { error: { code: "SCOPE_DENIED" } }))); expect(screen.getByLabelText("Descrição")).toHaveValue("Proposta da conta B"); expect(screen.queryByText("Acesso indisponível")).not.toBeInTheDocument();
  });

  it("discards a late committed group write instead of resetting the next identity's draft or claiming its success", async () => {
    const f = fixture(); await privateSnapshot(); const pending = deferred<AccessGroup>(); f.delay(`/access-groups/${group.id}`, pending.promise); fireEvent.click(screen.getByRole("button", { name: "Salvar grupo" }));
    await waitFor(() => expect(f.mock.mock.calls.some(([path]) => path === `/access-groups/${group.id}`)).toBe(true)); f.identify({ user: { ...identity.user, id: "authority-admin-b" } }); f.refresh(); await screen.findByRole("option", { name: /Colaborador B/ });
    fireEvent.click(screen.getByRole("button", { name: "Editar AUTHORITY" })); fireEvent.change(screen.getByLabelText("Descrição"), { target: { value: "Proposta nova B" } });
    await act(async () => pending.resolve({ ...group, version: 5 })); expect(screen.getByLabelText("Descrição")).toHaveValue("Proposta nova B"); expect(screen.queryByText("Grupo salvo. Os vínculos afetados foram reavaliados.")).not.toBeInTheDocument();
  });

  it("does not send an earlier identity's privileged assignment after its delayed reauthentication returns", async () => {
    const f = fixture({ ...user, role: "ADMIN" }); await loaded(); await selectUser(); const pending = deferred<unknown>(); f.delay("/session/reauth", pending.promise);
    fireEvent.click(screen.getByRole("button", { name: "Salvar vínculo" })); fireEvent.change(screen.getByLabelText("Senha para reautenticar"), { target: { value: "synthetic-password-only" } }); fireEvent.click(screen.getByRole("button", { name: "Confirmar" }));
    await waitFor(() => expect(f.mock.mock.calls.some(([path]) => path === "/session/reauth")).toBe(true)); f.identify({ user: { ...identity.user, id: "authority-admin-b" } }); f.refresh(); await screen.findByRole("option", { name: /Colaborador B/ });
    await selectUser("authority-user-b"); fireEvent.click(screen.getByRole("button", { name: "Salvar vínculo" })); expect(screen.getByRole("dialog")).toBeInTheDocument();
    await act(async () => pending.resolve({ verified: true }));
    expect(f.mock.mock.calls.some(([path]) => path.endsWith("/access-group"))).toBe(false);
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });

  it.each(["preview", "grants"] as const)("keeps the selected collaborator and group fixed while the %s command is in flight", async kind => {
    const f = fixture(); await loaded(); await selectUser(); const pending = deferred<unknown>(); f.delay(`/users/${user.id}/${kind === "preview" ? "access-preview" : "patient-grants"}`, pending.promise);
    fireEvent.click(screen.getByRole("button", { name: kind === "preview" ? "Ver prévia do acesso" : "Carregar concessões" }));
    expect(screen.getByLabelText("Colaborador")).toBeDisabled(); expect(screen.getByLabelText("Grupo base")).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Colaborador"), { target: { value: "" } }); fireEvent.change(screen.getByLabelText("Grupo base"), { target: { value: "" } });
    expect(screen.getByLabelText("Colaborador")).toHaveValue(user.id); expect(screen.getByLabelText("Grupo base")).toHaveValue(group.id);
    await act(async () => pending.resolve(kind === "preview" ? preview : [grant])); await waitFor(() => expect(screen.getByLabelText("Colaborador")).toBeEnabled());
    expect(screen.getByLabelText("Colaborador")).toHaveValue(user.id); expect(screen.getByLabelText("Grupo base")).toHaveValue(group.id);
  });

  it.each(["preview", "grants"] as const)("discards an earlier account's delayed %s after switching to another currently authorized account", async kind => {
    const f = fixture(); await loaded(); await selectUser(); const pending = deferred<unknown>();
    f.delay(`/users/${user.id}/${kind === "preview" ? "access-preview" : "patient-grants"}`, pending.promise);
    fireEvent.click(screen.getByRole("button", { name: kind === "preview" ? "Ver prévia do acesso" : "Carregar concessões" }));
    await waitFor(() => expect(f.mock.mock.calls.some(([path]) => path === `/users/${user.id}/${kind === "preview" ? "access-preview" : "patient-grants"}`)).toBe(true));
    f.identify({ user: { ...identity.user, id: "authority-admin-b" } }); f.refresh(); await screen.findByRole("option", { name: /Colaborador B/ }); await selectUser("authority-user-b");
    await act(async () => pending.resolve(kind === "preview" ? preview : [grant]));
    expect(screen.queryByText("Prévia privada A")).not.toBeInTheDocument(); expect(screen.queryByText("private-patient-a")).not.toBeInTheDocument();
    expect(screen.queryByRole("option", { name: /Colaborador privado A/ })).not.toBeInTheDocument();
  });

  it("does not resurrect a denied account's late preview when fresh access is restored", async () => {
    const f = fixture(); await loaded(); await selectUser(); const pending = deferred<unknown>(); f.delay(`/users/${user.id}/access-preview`, pending.promise);
    fireEvent.click(screen.getByRole("button", { name: "Ver prévia do acesso" })); await waitFor(() => expect(f.mock.mock.calls.some(([path]) => path.endsWith("/access-preview"))).toBe(true));
    f.fail(404); f.refresh(); await screen.findByRole("alert"); f.fail(); f.refresh(); await screen.findByRole("button", { name: "Editar AUTHORITY" });
    await act(async () => pending.resolve(preview)); expect(screen.queryByText("Prévia privada A")).not.toBeInTheDocument(); expect(screen.getByLabelText("Colaborador")).toHaveValue("");
  });
});
