import { describe, expect, it } from "vitest";
import { createDemoState } from "../store/fixtures";
import { MemoryStore } from "../store/memory-store";
import { createApplicationService } from "./service";
import { systemGroupId } from "../security/access-group-policy";
import { authenticateRequest, getSessionCookieName, loginUser, reauthenticateUser } from "../security/session";

async function setup() {
  const store = new MemoryStore(createDemoState("impact-synthetic-password"));
  const service = createApplicationService(store);
  const actor = () => store.getState().users.find((user) => user.role === "ADMIN")!;
  const group = await service.createAccessGroup(actor(), { code: "TEAM_IMPACT", description: "Equipe", permissions: ["request.list"], idempotencyKey: "create-impact-group" });
  await store.transaction((state) => ({ state: { ...state, users: state.users.map((user) => user.role === "VETERINARIAN" || user.role === "LAB_TECH" ? { ...user, accessGroupId: group.id } : user).concat([{ ...state.users.find((user) => user.role === "VETERINARIAN")!, id: "inactive-care", email: "inactive@example.test", active: false, accessGroupId: group.id }]) }, result: undefined }));
  return { store, service, actor, group };
}

describe("shared access group impact before writing", () => {
  it("previews every bound professional and effective changes without changing state or disclosing patient identifiers", async () => {
    const c = await setup(); const before = c.store.getState();
    const preview = await c.service.previewAccessGroupImpact(c.actor(), c.group.id, { permissions: ["result.release"], expectedVersion: 1 });
    expect(preview).toMatchObject({ groupVersion: 1, boundUserCount: 3, affectedUserCount: 2, activeAffectedUserCount: 2, requiresReauthentication: false });
    expect(preview.users.find((user) => user.role === "LAB_TECH")).toMatchObject({ addedPermissions: ["result.release"], removedPermissions: ["request.list"], active: true });
    expect(preview.users.find((user) => user.userId === "inactive-care")).toMatchObject({ active: false, effectiveAccessChanges: false, permissions: [] });
    expect(JSON.stringify(preview)).not.toMatch(/patient-thor|patient-mel|passwordHash|impact-synthetic-password/);
    expect(c.store.getState()).toEqual(before);
    const saved = await c.service.updateAccessGroup(c.actor(), c.group.id, { permissions: ["result.release"], expectedVersion: 1, expectedImpactToken: preview.impactToken, idempotencyKey: "save-preview" });
    expect(saved.permissions).toEqual(["result.release"]);
    expect(c.store.getState().users.find((user) => user.id === "inactive-care")?.active).toBe(false);
  });
  it("rejects changed people and changed draft under the same group revision, requiring another preview", async () => {
    const c = await setup(); const input = { description: "Equipe nova", expectedVersion: 1 };
    const preview = await c.service.previewAccessGroupImpact(c.actor(), c.group.id, input);
    await c.store.transaction((state) => ({ state: { ...state, users: state.users.map((user) => user.id === "user-vet" ? { ...user, version: user.version + 1, patientIds: [] } : user) }, result: undefined }));
    await expect(c.service.updateAccessGroup(c.actor(), c.group.id, { ...input, expectedImpactToken: preview.impactToken, idempotencyKey: "stale-people" })).rejects.toMatchObject({ code: "STALE_VERSION", status: 409 });
    const fresh = await c.service.previewAccessGroupImpact(c.actor(), c.group.id, input);
    await expect(c.service.updateAccessGroup(c.actor(), c.group.id, { ...input, description: "Candidata diferente", expectedImpactToken: fresh.impactToken, idempotencyKey: "stale-draft" })).rejects.toMatchObject({ code: "STALE_VERSION", status: 409 });
    expect(c.store.getState().accessGroups.find((group) => group.id === c.group.id)?.version).toBe(1);
  });
  it("denies a complete preview outside manager scope, self-impact and delegation beyond the current ceiling", async () => {
    const c = await setup();
    await c.store.transaction((state) => ({ state: { ...state, users: state.users.map((user) => user.role === "MANAGER" ? { ...user, departmentCode: "LABORATORY", managedDepartmentCodes: ["LABORATORY"] } : user) }, result: undefined }));
    const manager = c.store.getState().users.find((user) => user.role === "MANAGER")!;
    await expect(c.service.previewAccessGroupImpact(manager, c.group.id, { description: "Fora de vínculo", expectedVersion: 1 })).rejects.toMatchObject({ status: 404 });
    await expect(c.service.previewAccessGroupImpact(manager, c.group.id, { permissions: ["institution.manage"], expectedVersion: 1 })).rejects.toMatchObject({ status: 403 });
    const own = c.store.getState().accessGroups.find((group) => group.id === c.actor().accessGroupId)!;
    await expect(c.service.previewAccessGroupImpact(c.actor(), own.id, { permissions: [], expectedVersion: own.version })).rejects.toMatchObject({ status: 403 });
  });
  it("protects the last effective administrator during preview and requires step-up only before the protected write", async () => {
    const c = await setup(); const admin = c.actor();
    await c.store.transaction((state) => ({ state: { ...state, users: [...state.users, { ...admin, id: "second-admin", email: "second@example.test", accessGroupId: c.group.id } ] }, result: undefined }));
    const preview = await c.service.previewAccessGroupImpact(admin, c.group.id, { permissions: ["user.create"], expectedVersion: 1 });
    expect(preview.requiresReauthentication).toBe(true);
    await expect(c.service.updateAccessGroup(admin, c.group.id, { permissions: ["user.create"], expectedVersion: 1, expectedImpactToken: preview.impactToken, idempotencyKey: "protected" })).rejects.toMatchObject({ code: "REAUTH_REQUIRED" });
    const other = c.store.getState().users.find((user) => user.id === "second-admin")!;
    await c.store.transaction((state) => ({ state: { ...state, users: state.users.map((user) => user.id === admin.id ? { ...user, accessGroupId: c.group.id } : user.id === other.id ? { ...user, accessGroupId: systemGroupId("ADMIN") } : user), accessGroups: state.accessGroups.map((group) => group.id === c.group.id ? { ...group, permissions: ["access_group.update", "access_group.deactivate"] } : group) }, result: undefined }));
    await expect(c.service.previewAccessGroupImpact(c.actor(), systemGroupId("ADMIN"), { active: false, expectedVersion: 1 })).rejects.toMatchObject({ code: "CONFLICT", status: 409 });
  });
  it("rechecks current rights on preview and save, and a valid replay remains one mutation", async () => {
    const c = await setup(); const input = { active: false, expectedVersion: 1 };
    const preview = await c.service.previewAccessGroupImpact(c.actor(), c.group.id, input);
    const body = { ...input, expectedImpactToken: preview.impactToken, idempotencyKey: "disable-once" };
    const saved = await c.service.updateAccessGroup(c.actor(), c.group.id, body);
    expect(await c.service.updateAccessGroup(c.actor(), c.group.id, body)).toEqual(saved);
    const actor = c.actor();
    await c.store.transaction((state) => ({ state: { ...state, accessGroups: state.accessGroups.map((group) => group.id === actor.accessGroupId ? { ...group, permissions: [] } : group) }, result: undefined }));
    await expect(c.service.previewAccessGroupImpact(actor, c.group.id, { active: true, expectedVersion: 2 })).rejects.toMatchObject({ status: 404 });
    await expect(c.service.updateAccessGroup(actor, c.group.id, body)).rejects.toMatchObject({ status: 404 });
  });
  it("retains a reduced profile ceiling and refuses even a saved replay after delegation is withdrawn", async () => {
    const c = await setup();
    const vet = c.store.getState().users.find((user) => user.role === "VETERINARIAN")!;
    const preview = await c.service.previewAccessGroupImpact(c.actor(), c.group.id, { permissions: ["result.release"], expectedVersion: 1 });
    expect(preview.users.find((user) => user.userId === vet.id)?.permissions).toEqual([]);
    await c.store.transaction((state) => ({ state: { ...state, users: state.users.map((user) => user.role === "MANAGER" ? { ...user, departmentCode: "IT", managedDepartmentCodes: ["INPATIENT", "LABORATORY"] } : user) }, result: undefined }));
    const manager = () => c.store.getState().users.find((user) => user.role === "MANAGER")!;
    const input = { description: "Edição delegada", expectedVersion: 1, idempotencyKey: "manager-impact-replay" };
    await c.service.updateAccessGroup(manager(), c.group.id, input);
    await c.store.transaction((state) => ({ state: { ...state, users: state.users.map((user) => user.role === "MANAGER" ? { ...user, managedDepartmentCodes: ["LABORATORY"] } : user) }, result: undefined }));
    await expect(c.service.updateAccessGroup(manager(), c.group.id, input)).rejects.toMatchObject({ status: 404 });
    await expect(c.service.previewAccessGroupImpact(manager(), c.group.id, { description: "Nova edição", expectedVersion: 2 })).rejects.toMatchObject({ status: 404 });
  });
  it("confirms identity after the read-only preview, saves its exact decision and revokes the protected target session", async () => {
    const c = await setup(); const admin = c.actor();
    await c.store.transaction((state) => ({ state: { ...state, users: [...state.users, { ...admin, id: "protected-admin", email: "protected-admin@example.test", accessGroupId: c.group.id }] }, result: undefined }));
    const actorLogin = await loginUser(c.store, admin.email, "impact-synthetic-password");
    const targetLogin = await loginUser(c.store, "protected-admin@example.test", "impact-synthetic-password");
    const actorRequest = new Request("http://localhost/api/v1/session/me", { headers: { cookie: `${getSessionCookieName()}=${actorLogin.sessionToken}` } });
    const targetRequest = new Request("http://localhost/api/v1/session/me", { headers: { cookie: `${getSessionCookieName()}=${targetLogin.sessionToken}` } });
    const signedIn = await authenticateRequest(c.store, actorRequest);
    const input = { permissions: ["user.create" as const], expectedVersion: 1 };
    const preview = await c.service.previewAccessGroupImpact(signedIn, c.group.id, input);
    expect(preview.requiresReauthentication).toBe(true);
    expect(await authenticateRequest(c.store, targetRequest)).toMatchObject({ id: "protected-admin" });
    const confirmed = await reauthenticateUser(c.store, actorRequest, "impact-synthetic-password");
    await c.service.updateAccessGroup(confirmed, c.group.id, { ...input, expectedImpactToken: preview.impactToken, idempotencyKey: "confirmed-preview" });
    await expect(authenticateRequest(c.store, targetRequest)).rejects.toMatchObject({ status: 401 });
    expect((await authenticateRequest(c.store, actorRequest)).id).toBe(admin.id);
    expect(c.store.getState().auditEvents.at(-1)).toMatchObject({ eventType: "AccessGroupUpdated", metadata: { sessionsRevoked: 1 } });
  });
});
