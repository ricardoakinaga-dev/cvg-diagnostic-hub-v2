import { describe, expect, it } from "vitest";
import type { Permission } from "@cvg/contracts";
import { createDemoState } from "../store/fixtures";
import { MemoryStore } from "../store/memory-store";
import { createApplicationService } from "./service";
import { authenticateRequest, hashSessionToken, loginUser, getSessionCookieName } from "../security/session";
import { rolePermissions } from "../security/authorization";
import { hydrateUserPermissions, systemGroupId } from "../security/access-group-policy";
import { accessGroupPatchSchema, userGroupAssignmentSchema } from "../http/access-group-schemas";

function setup() {
  const state = createDemoState("access-group-test-password");
  const admin = state.users.find((user) => user.role === "ADMIN")!;
  state.users.push({ ...admin, id: "second-admin", email: "second-admin@cvg.local", accessGroupId: "independent-admin" });
  state.accessGroups.push({ ...state.accessGroups.find((group) => group.id === systemGroupId("ADMIN"))!, id: "independent-admin", code: "SECOND_ADMIN" });
  state.sessions.push({ id: "admin-session", userId: admin.id, tokenHash: hashSessionToken("admin-test"), csrfTokenHash: "test", createdAt: new Date().toISOString(), expiresAt: "2099-01-01T00:00:00Z", reauthenticatedAt: new Date().toISOString(), version: 1 });
  const store = new MemoryStore(state);
  const service = createApplicationService(store);
  const actor = () => ({ ...store.getState().users.find((user) => user.id === admin.id)!, sessionId: "admin-session", reauthenticatedAt: new Date().toISOString() });
  const vet = () => store.getState().users.find((user) => user.role === "VETERINARIAN")!;
  const manager = () => store.getState().users.find((user) => user.role === "MANAGER")!;
  return { store, service, actor, vet, manager };
}
const exam = { code: "ONLY_CREATE", name: "Criação permitida", category: "LABORATORY" as const, departmentCode: "LABORATORY", workflowType: "LABORATORY" as const, requiresSample: false, requiresSchedule: false, allowsAttachment: false, resultSchema: "NARRATIVE" as const, slaHours: { ROUTINE: 24, URGENT: 4, EMERGENCY: 1 } };

describe("access group administration and revocation", () => {
  it("creates, version-updates and deactivates groups without deactivating accounts, auditing affected users", async () => {
    const { store, service, actor, vet } = setup();
    const group = await service.createAccessGroup(actor(), { code: "CARE_READ", description: "Leitura assistencial", permissions: ["patient.view", "request.list"], idempotencyKey: "create" });
    const assigned = await service.assignUserAccessGroup(actor(), vet().id, { accessGroupId: group.id, expectedVersion: vet().version, idempotencyKey: "assign" });
    expect(assigned.accessGroupId).toBe(group.id);
    const updated = await service.updateAccessGroup(actor(), group.id, { description: "Leitura contextual", expectedVersion: group.version, idempotencyKey: "description" });
    expect(updated.version).toBe(2);
    await expect(service.updateAccessGroup(actor(), group.id, { description: "stale", expectedVersion: 1, idempotencyKey: "stale" })).rejects.toMatchObject({ status: 409 });
    const disabled = await service.updateAccessGroup(actor(), group.id, { active: false, expectedVersion: updated.version, idempotencyKey: "disable" });
    expect(disabled.active).toBe(false);
    expect(vet().active).toBe(true);
    expect(hydrateUserPermissions(store.getState(), vet()).permissions).toEqual([]);
    expect(store.getState().auditEvents.find((event) => event.eventType === "AccessGroupUpdated" && event.metadata.active === false)?.metadata.affectedUserIds).toBe(JSON.stringify([vet().id]));
    await expect(service.createAccessGroup(actor(), { code: "care_read", description: "Duplicado", permissions: [], idempotencyKey: "duplicate" })).rejects.toMatchObject({ status: 409 });
  });
  it("a group granting only catalog creation cannot PATCH, deactivate or import an existing service", async () => {
    const { store, service, actor } = setup();
    const group = await service.createAccessGroup(actor(), { code: "CREATE_ONLY", description: "Somente criação", permissions: ["service.catalog.create"], idempotencyKey: "create-only" });
    await service.assignUserAccessGroup(actor(), "user-manager", { accessGroupId: group.id, expectedVersion: 1, idempotencyKey: "limited-manager" });
    const manager = store.getState().users.find((user) => user.id === "user-manager")!;
    const created = await service.createDiagnosticService(manager, { ...exam, idempotencyKey: "exam" });
    await expect(service.updateDiagnosticService(manager, created.id, { name: "Outra descrição", expectedVersion: 1, idempotencyKey: "edit" })).rejects.toMatchObject({ status: 404 });
    await expect(service.updateDiagnosticService(manager, created.id, { active: false, expectedVersion: 1, idempotencyKey: "deactivate" })).rejects.toMatchObject({ status: 404 });
    const services = "codigo;nome;categoria;setor;fluxo;exige_amostra;tipo_amostra;exige_agenda;permite_anexo;esquema_resultado;sla_rotina_h;sla_urgente_h;sla_emergencia_h;ativo\nONLY_CREATE;Alterado;LABORATORY;LABORATORY;LABORATORY;não;;não;não;NARRATIVE;24;4;1;sim";
    await expect(service.importCatalog(manager, { services, idempotencyKey: "import", dryRun: true })).rejects.toMatchObject({ status: 404 });
  });
  it("user.update cannot bypass a separately revoked user.deactivate through role-update active=false", async () => {
    const { store, service, actor } = setup();
    const group = await service.createAccessGroup(actor(), { code: "UPDATE_ONLY", description: "Só edição", permissions: ["user.update"], idempotencyKey: "create-update" });
    await service.assignUserAccessGroup(actor(), "user-manager", { accessGroupId: group.id, expectedVersion: 1, idempotencyKey: "manager-update" });
    const manager = store.getState().users.find((user) => user.id === "user-manager")!;
    await expect(service.updateUserRole(manager, "user-lab", { role: "LAB_TECH", departmentCode: "LABORATORY", active: false, expectedVersion: 1, idempotencyKey: "bypass" })).rejects.toMatchObject({ status: 404 });
    expect(store.getState().users.find((user) => user.id === "user-lab")?.active).toBe(true);
  });
  it("denies manager delegation of global administration, self-assignment and targets outside managed departments", async () => {
    const { store, service, actor, manager } = setup();
    await store.transaction((state) => ({ state: { ...state, users: state.users.map((user) => user.id === "user-vet" ? { ...user, departmentCode: "UNMANAGED" } : user) }, result: undefined }));
    await expect(service.createAccessGroup(manager(), { code: "ESCALATE", description: "Elevação", permissions: ["user.create"], idempotencyKey: "escalate" })).rejects.toMatchObject({ status: 403 });
    await expect(service.assignUserAccessGroup(actor(), actor().id, { accessGroupId: systemGroupId("SUPERADMIN"), expectedVersion: 1, idempotencyKey: "self" })).rejects.toMatchObject({ status: 403 });
    await expect(service.assignUserAccessGroup(manager(), "user-vet", { accessGroupId: systemGroupId("VIEWER"), expectedVersion: 1, idempotencyKey: "outside" })).rejects.toMatchObject({ status: 404 });
  });
  it("ADMIN cannot assign a SUPERADMIN target and a permissive group cannot turn ADMIN into clinical staff", async () => {
    const { store, service, actor } = setup();
    await store.transaction((state) => ({ state: { ...state, users: [...state.users, { ...state.users[0], id: "super", role: "SUPERADMIN", departmentCode: "IT", accessGroupId: systemGroupId("SUPERADMIN") }] }, result: undefined }));
    await expect(service.assignUserAccessGroup(actor(), "super", { accessGroupId: systemGroupId("ADMIN"), expectedVersion: 1, idempotencyKey: "super" })).rejects.toMatchObject({ status: 404 });
    const preview = await service.previewUserAccess(actor(), "second-admin", { accessGroupId: systemGroupId("SUPERADMIN") });
    expect(preview.permissions).not.toContain("result.release");
    expect(preview.deniedByProfile).toContain("result.release");
  });
  it("protects the last effective administrator even when another active ADMIN role has an empty group", async () => {
    const { store, service, actor } = setup();
    await store.transaction((state) => ({ state: { ...state, accessGroups: state.accessGroups.map((group) => group.id === systemGroupId("ADMIN") ? { ...group, permissions: ["access_group.update"] as Permission[] } : group) }, result: undefined }));
    await expect(service.updateAccessGroup(actor(), "independent-admin", { permissions: [], expectedVersion: 1, idempotencyKey: "last" })).rejects.toMatchObject({ status: 409 });
  });
  it("permission withdrawal revokes an open session and denies the following service operation", async () => {
    const { store, service, actor, vet } = setup();
    const group = await service.createAccessGroup(actor(), { code: "VET_SESSION", description: "Sessão clínica", permissions: [...rolePermissions.VETERINARIAN], idempotencyKey: "group-session" });
    await service.assignUserAccessGroup(actor(), vet().id, { accessGroupId: group.id, expectedVersion: vet().version, idempotencyKey: "assign-session" });
    const login = await loginUser(store, vet().email, "access-group-test-password");
    const request = new Request("http://localhost/api/v1/diagnostic-requests", { headers: { cookie: `${getSessionCookieName()}=${login.sessionToken}` } });
    const sessionActor = await authenticateRequest(store, request);
    expect(sessionActor.permissions).toContain("request.list");
    await service.updateAccessGroup(actor(), group.id, { permissions: [], expectedVersion: 1, idempotencyKey: "withdraw" });
    await expect(authenticateRequest(store, request)).rejects.toMatchObject({ status: 401 });
    await expect(service.listRequests(sessionActor)).rejects.toMatchObject({ status: 401 });
  });
  it("preview and the saved decision share one engine and expose no patient identifiers or clinical data", async () => {
    const { store, service, actor, vet } = setup();
    const group = await service.createAccessGroup(actor(), { code: "PREVIEW", description: "Prévia", permissions: ["request.list", "result.release"], idempotencyKey: "preview" });
    const preview = await service.previewUserAccess(actor(), vet().id, { accessGroupId: group.id });
    expect(preview.permissions).toEqual(["request.list"]);
    expect(preview.scopes.patientCount).toBe(2);
    expect(JSON.stringify(preview)).not.toContain("patient-thor");
    await service.assignUserAccessGroup(actor(), vet().id, { accessGroupId: group.id, expectedVersion: vet().version, idempotencyKey: "save-preview" });
    expect(hydrateUserPermissions(store.getState(), vet()).permissions).toEqual(preview.permissions);
  });
  it("grants a second professional the existing author's work, then withdraws every following clinical read", async () => {
    const { store, service, actor, vet } = setup();
    const author = vet();
    await store.transaction((state) => ({ state: { ...state, users: [...state.users, { ...author, id: "new-care", email: "new-care@cvg.local", patientIds: [] }] }, result: undefined }));
    const request = await service.createRequest(author, { patientId: "patient-thor", encounterId: "encounter-thor", priority: "ROUTINE", items: [{ serviceId: "service-crp" }] }, { idempotencyKey: "grant-work" });
    const reader = () => store.getState().users.find((user) => user.id === "new-care")!;
    expect((await service.listRequests(reader())).items).toEqual([]);
    await expect(service.getRequest(reader(), request.id)).rejects.toMatchObject({ status: 404 });
    const grant = await service.changePatientGrant(actor(), reader().id, { patientId: "patient-thor", active: true, reason: "Equipe assistencial assumiu o atendimento", expectedVersion: reader().version, idempotencyKey: "grant" });
    expect(grant).toMatchObject({ source: "ADMIN", grantedBy: actor().id, active: true });
    expect((await service.listRequests(reader())).items.map((entry) => entry.id)).toEqual([request.id]);
    expect((await service.getRequest(reader(), request.id)).requesterId).toBe(author.id);
    const login = await loginUser(store, reader().email, "access-group-test-password");
    const authenticated = await authenticateRequest(store, new Request("http://localhost/api/v1/session", { headers: { cookie: `${getSessionCookieName()}=${login.sessionToken}` } }));
    await service.changePatientGrant(actor(), reader().id, { patientId: "patient-thor", active: false, reason: "Encerrado vínculo assistencial", expectedVersion: reader().version, idempotencyKey: "withdraw-patient" });
    expect((await service.listRequests(reader())).items).toEqual([]);
    expect((await service.listPatients(reader())).map((patient) => patient.id)).not.toContain("patient-thor");
    await expect(service.getItem(reader(), request.items[0].id)).rejects.toMatchObject({ status: 404 });
    await expect(service.getRequest(authenticated, request.id)).rejects.toMatchObject({ status: 401 });
    expect(store.getState().patientGrants.find((entry) => entry.id === grant.id)).toMatchObject({ active: false, version: 2 });
    expect(store.getState().auditEvents.filter((event) => event.eventType === "PatientScopeChanged")).toHaveLength(2);
  });
  it("a manager cannot grant a patient outside its operational context or use a stale user revision", async () => {
    const { store, service, actor, manager, vet } = setup();
    await store.transaction((state) => ({ state: { ...state, users: state.users.map((user) => user.id === manager().id ? { ...user, departmentCode: "IT", managedDepartmentCodes: ["RADIOLOGY"] } : user.id === "user-vet" ? { ...user, departmentCode: "RADIOLOGY" } : user), patients: [...state.patients, { ...state.patients[0], id: "outside-patient" }] }, result: undefined }));
    const currentManager = store.getState().users.find((user) => user.id === "user-manager")!;
    await expect(service.changePatientGrant(currentManager, "user-vet", { patientId: "outside-patient", active: true, reason: "Tentativa externa", expectedVersion: 1, idempotencyKey: "outside-patient" })).rejects.toMatchObject({ status: 404 });
    await expect(service.changePatientGrant(actor(), vet().id, { patientId: "patient-thor", active: false, reason: "Versão antiga", expectedVersion: 9, idempotencyKey: "stale-patient" })).rejects.toMatchObject({ status: 409 });
  });
  it("rejects a group changed after the preview even when the user's effective intersection stayed the same", async () => {
    const { service, actor, vet } = setup();
    const group = await service.createAccessGroup(actor(), { code: "PREVIEW_RACE", description: "Original", permissions: ["request.list"], idempotencyKey: "preview-race" });
    const preview = await service.previewUserAccess(actor(), vet().id, { accessGroupId: group.id });
    await service.updateAccessGroup(actor(), group.id, { description: "Alterado por outro editor", expectedVersion: 1, idempotencyKey: "preview-edit" });
    await expect(service.assignUserAccessGroup(actor(), vet().id, { accessGroupId: group.id, expectedVersion: preview.userVersion, expectedGroupVersion: preview.groupVersion, idempotencyKey: "preview-save" })).rejects.toMatchObject({ status: 409 });
  });
  it("does not bind new accounts to an inactive base group and preserves historical assignments", async () => {
    const { store, service, actor } = setup();
    const group = store.getState().accessGroups.find((entry) => entry.id === systemGroupId("LAB_TECH"))!;
    await service.updateAccessGroup(actor(), group.id, { active: false, expectedVersion: 1, idempotencyKey: "base-off" });
    await expect(service.createManagedUser(actor(), { displayName: "Novo técnico", email: "new-tech@cvg.local", role: "LAB_TECH", departmentCode: "LABORATORY", idempotencyKey: "inactive-base-create" })).rejects.toMatchObject({ status: 400 });
    expect(store.getState().users.find((user) => user.id === "user-lab")).toMatchObject({ active: true, accessGroupId: group.id });
    expect(store.getState().users.some((user) => user.email === "new-tech@cvg.local")).toBe(false);
  });
  it("keeps ordinary identity edits automatic and audited, rejects collisions and reconciles a department transfer", async () => {
    const { store, service, actor, vet } = setup();
    const target = vet();
    const updated = await service.updateUserRole(actor(), target.id, { displayName: "Nome atualizado", email: "new-care-identity@cvg.local", role: target.role, departmentCode: "RADIOLOGY", expectedVersion: target.version, idempotencyKey: "identity-update" });
    expect(updated).toMatchObject({ displayName: "Nome atualizado", email: "new-care-identity@cvg.local", departmentCode: "RADIOLOGY", version: 2 });
    expect(store.getState().departments.find((department) => department.code === "INPATIENT")?.memberUserIds).not.toContain(target.id);
    expect(store.getState().departments.find((department) => department.code === "RADIOLOGY")?.memberUserIds).toContain(target.id);
    expect(store.getState().auditEvents.at(-1)?.metadata).toMatchObject({ identityChanged: true, affectedDepartmentIds: expect.any(String) });
    await expect(service.updateUserRole(actor(), target.id, { email: actor().email, role: target.role, departmentCode: updated.departmentCode, expectedVersion: updated.version, idempotencyKey: "identity-collision" })).rejects.toMatchObject({ status: 409 });
    expect(vet().email).toBe("new-care-identity@cvg.local");
  });
  it("inactive sectors cannot receive a new user, exam or reactivation, while historical metadata remains editable", async () => {
    const { store, service, actor } = setup();
    await store.transaction((state) => ({ state: { ...state, departments: state.departments.map((department) => department.code === "LABORATORY" ? { ...department, active: false } : department), services: state.services.map((entry) => entry.id === "service-crp" ? { ...entry, active: false } : entry) }, result: undefined }));
    await expect(service.createDiagnosticService(actor(), { ...exam, idempotencyKey: "inactive-department-exam" })).rejects.toMatchObject({ status: 400 });
    await expect(service.createManagedUser(actor(), { displayName: "Novo técnico", email: "new-sector@cvg.local", role: "LAB_TECH", departmentCode: "LABORATORY", idempotencyKey: "inactive-department-user" })).rejects.toMatchObject({ status: 400 });
    await expect(service.updateDiagnosticService(actor(), "service-crp", { active: true, expectedVersion: 1, idempotencyKey: "inactive-department-reactivate" })).rejects.toMatchObject({ status: 400 });
    expect(await service.updateDiagnosticService(actor(), "service-crp", { name: "Nome histórico", expectedVersion: 1, idempotencyKey: "historic-name" })).toMatchObject({ name: "Nome histórico", active: false });
  });
  it("identity-only changes preserve a manual team exclusion, while reactivation restores a new active binding", async () => {
    const { store, service, actor, vet } = setup();
    const target = vet();
    await store.transaction((state) => ({ state: { ...state, departments: state.departments.map((department) => department.code === target.departmentCode ? { ...department, memberUserIds: department.memberUserIds.filter((id) => id !== target.id), version: department.version + 1 } : department) }, result: undefined }));
    const before = store.getState().departments;
    const updated = await service.updateUserRole(actor(), target.id, { displayName: "Só identidade", role: target.role, departmentCode: target.departmentCode, expectedVersion: target.version, idempotencyKey: "identity-preserve-team" });
    expect(store.getState().departments).toEqual(before);
    const inactive = await service.deactivateManagedUser(actor(), target.id, { expectedVersion: updated.version, idempotencyKey: "disable-team" });
    await service.updateUserRole(actor(), target.id, { role: target.role, departmentCode: target.departmentCode, active: true, expectedVersion: inactive.version, idempotencyKey: "reactivate-team" });
    expect(store.getState().departments.find((department) => department.code === target.departmentCode)?.memberUserIds).toContain(target.id);
  });
  it("requires revisions and rejects unknown permission or request fields", () => {
    expect(accessGroupPatchSchema.safeParse({ permissions: [], expectedVersion: 1 }).success).toBe(true);
    expect(accessGroupPatchSchema.safeParse({ permissions: [] }).success).toBe(false);
    expect(accessGroupPatchSchema.safeParse({ permissions: ["clinical.all"], expectedVersion: 1 }).success).toBe(false);
    expect(userGroupAssignmentSchema.safeParse({ accessGroupId: "id", expectedVersion: 1, role: "SUPERADMIN" }).success).toBe(false);
  });
});

describe("group and patient-grant boundary commands", () => {
  it("rejects malformed delegation matrices and group identifiers before changing any state", async () => {
    const c = setup(); const before = c.store.getState();
    for (const [key, fields] of [["unknown", { permissions: ["clinical.all"] }], ["duplicate", { permissions: ["patient.view", "patient.view"] }], ["code", { code: "1_INVALID" }]] as const) {
      await expect(c.service.createAccessGroup(c.actor(), { code: "BOUNDARY", description: "Limites", ...fields, permissions: "permissions" in fields ? fields.permissions : [], idempotencyKey: key } as never)).rejects.toMatchObject({ status: 400 });
    }
    expect(c.store.getState()).toEqual(before);
    const group = await c.service.createAccessGroup(c.actor(), { code: "EMPTY_VALID", description: "Sem acesso", permissions: [], idempotencyKey: "valid" });
    const input = { code: "EMPTY_VALID", description: "Sem acesso", permissions: [] as Permission[], idempotencyKey: "valid" };
    expect(await c.service.createAccessGroup(c.actor(), input)).toEqual(group);
    await expect(c.service.updateAccessGroup(c.actor(), group.id, { description: "Novo", idempotencyKey: "no-version" })).rejects.toMatchObject({ status: 400 });
    await expect(c.service.updateAccessGroup(c.actor(), group.id, { expectedVersion: 1, idempotencyKey: "no-change" })).rejects.toMatchObject({ status: 400 });
    const update = { permissions: ["patient.view"] as Permission[], expectedVersion: 1, idempotencyKey: "new-right" };
    const changed = await c.service.updateAccessGroup(c.actor(), group.id, update);
    expect(await c.service.updateAccessGroup(c.actor(), group.id, update)).toEqual(changed);
  });
  it("previews a legacy profile conservatively and refuses absent or invented group simulations", async () => {
    const c = setup();
    await c.store.transaction((state) => ({ state: { ...state, users: state.users.map((user) => user.id === c.vet().id ? { ...user, accessGroupId: undefined, managedDepartmentCodes: undefined, serviceCodes: undefined, patientIds: undefined } : user) }, result: undefined }));
    const preview = await c.service.previewUserAccess(c.actor(), c.vet().id);
    expect(preview).toMatchObject({ origin: "LEGACY_PROFILE", groupActive: true, scopes: { serviceCodes: [], managedDepartmentCodes: [], patientCount: 0 } });
    await expect(c.service.previewUserAccess(c.actor(), c.vet().id, { accessGroupId: "missing" })).rejects.toMatchObject({ status: 404 });
    await expect(c.service.previewUserAccess(c.actor(), c.vet().id, { permissions: ["patient.view"] })).rejects.toMatchObject({ status: 400 });
    const matrix = await c.service.previewUserAccess(c.actor(), "second-admin", { permissions: ["user.create"] });
    expect(matrix.permissions).toEqual(["user.create"]);
    expect(matrix.removedPermissions.length).toBeGreaterThan(0);
  });
  it("requires independent update authority when combining deactivation and editing", async () => {
    const c = setup(); const group = await c.service.createAccessGroup(c.actor(), { code: "OFF_ONLY", description: "Não vinculada", permissions: [], idempotencyKey: "off-target" });
    await c.store.transaction((state) => ({ state: { ...state, accessGroups: state.accessGroups.map((entry) => entry.id === "independent-admin" ? { ...entry, permissions: ["access_group.deactivate"] } : entry) }, result: undefined }));
    const other = c.store.getState().users.find((user) => user.id === "second-admin")!;
    await expect(c.service.updateAccessGroup(other, group.id, { active: false, description: "Também edição", expectedVersion: 1, idempotencyKey: "combined" })).rejects.toMatchObject({ status: 404 });
    expect(await c.service.updateAccessGroup(other, group.id, { active: false, expectedVersion: 1, idempotencyKey: "only-off" })).toMatchObject({ active: false });
  });
  it("prevents self-impact and requires privileged session reauthentication for changing an administrator's group", async () => {
    const c = setup();
    await expect(c.service.updateAccessGroup(c.actor(), systemGroupId("ADMIN"), { permissions: ["access_group.update"], expectedVersion: 1, idempotencyKey: "self-impact" })).rejects.toMatchObject({ status: 403 });
    await c.store.transaction((state) => ({ state: { ...state, sessions: state.sessions.map((session) => ({ ...session, reauthenticatedAt: undefined })) }, result: undefined }));
    await expect(c.service.updateAccessGroup({ ...c.actor(), reauthenticatedAt: undefined }, "independent-admin", { permissions: ["user.create"], expectedVersion: 1, idempotencyKey: "admin-impact" })).rejects.toMatchObject({ code: "REAUTH_REQUIRED" });
    await expect(c.service.assignUserAccessGroup({ ...c.actor(), reauthenticatedAt: undefined }, "second-admin", { accessGroupId: systemGroupId("ADMIN"), expectedVersion: 1, idempotencyKey: "admin-bind" })).rejects.toMatchObject({ code: "REAUTH_REQUIRED" });
  });
  it("validates group assignment, accepts a bound replay and refuses inactive groups", async () => {
    const c = setup(); const group = await c.service.createAccessGroup(c.actor(), { code: "BIND_ONLY", description: "Leitura", permissions: ["patient.view"], idempotencyKey: "binding" });
    await expect(c.service.assignUserAccessGroup(c.actor(), c.vet().id, { accessGroupId: group.id, idempotencyKey: "binding-no-version" })).rejects.toMatchObject({ status: 400 });
    const input = { accessGroupId: group.id, expectedVersion: 1, expectedGroupVersion: 1, idempotencyKey: "assign-retry" };
    const saved = await c.service.assignUserAccessGroup(c.actor(), c.vet().id, input);
    expect(await c.service.assignUserAccessGroup(c.actor(), c.vet().id, input)).toEqual(saved);
    await c.service.updateAccessGroup(c.actor(), group.id, { active: false, expectedVersion: 1, idempotencyKey: "disable-binding" });
    await expect(c.service.assignUserAccessGroup(c.actor(), c.vet().id, input)).rejects.toMatchObject({ status: 400 });
  });
  it("returns only delegable atomic permissions for each administrative ceiling", async () => {
    const c = setup();
    const admin = await c.service.listDelegablePermissions(c.actor()); const manager = await c.service.listDelegablePermissions(c.manager());
    expect(admin).toContain("user.create"); expect(manager).not.toContain("user.create");
    expect(admin).not.toContain("user_role.manage"); expect(admin).not.toContain("service.catalog.manage");
    await c.store.transaction((state) => ({ state: { ...state, users: [...state.users, { ...state.users[0], id: "super", role: "SUPERADMIN", accessGroupId: systemGroupId("SUPERADMIN") }] }, result: undefined }));
    const superuser = c.store.getState().users.find((user) => user.id === "super")!;
    expect(await c.service.listDelegablePermissions(superuser)).toContain("integration.exchange");
    expect((await c.service.listAccessGroups(c.actor())).map((group) => group.code)).toEqual([...c.store.getState().accessGroups].sort((a, b) => a.code.localeCompare(b.code)).map((group) => group.code));
  });
  it("validates patient grants, retries only once, and lists grants under manager context", async () => {
    const c = setup();
    await expect(c.service.changePatientGrant(c.actor(), "user-lab", { patientId: "patient-thor", active: true, reason: "Inválido para o perfil", expectedVersion: 1, idempotencyKey: "lab-grant" })).rejects.toMatchObject({ status: 400 });
    await expect(c.service.changePatientGrant(c.actor(), c.vet().id, { patientId: "patient-thor", active: true, reason: "Contexto", idempotencyKey: "grant-no-version" })).rejects.toMatchObject({ status: 400 });
    const input = { patientId: "patient-thor", active: true, reason: "Equipe atual", expectedVersion: 1, idempotencyKey: "grant-retry" };
    const grant = await c.service.changePatientGrant(c.actor(), c.vet().id, input);
    expect(await c.service.changePatientGrant(c.actor(), c.vet().id, input)).toEqual(grant);
    expect((await c.service.listPatientGrants(c.actor(), c.vet().id)).some((entry) => entry.id === grant.id)).toBe(true);
    await c.store.transaction((state) => ({ state: { ...state, users: state.users.map((user) => user.id === "user-vet" ? { ...user, departmentCode: "LABORATORY" } : user) }, result: undefined }));
    expect((await c.service.listPatientGrants(c.manager(), c.vet().id)).some((entry) => entry.id === grant.id)).toBe(true);
  });
});
