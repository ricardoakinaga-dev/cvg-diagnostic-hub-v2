import { describe, expect, it } from "vitest";
import type { User } from "../domain/models";
import { authenticateRequest, loginUser, reauthenticateUser } from "../security/session";
import { verifyPassword } from "../security/password";
import { createDemoState } from "../store/fixtures";
import { MemoryStore } from "../store/memory-store";
import { createApplicationService } from "./service";

const PASSWORD = "management-superadmin-test-2026";

function setup() {
  const initial = createDemoState(PASSWORD);
  const admin = initial.users.find((user) => user.role === "ADMIN")!;
  const superadmin: User = { ...admin, id: "user-superadmin", email: "superadmin@test.local", role: "SUPERADMIN" };
  const peer: User = { ...superadmin, id: "user-superadmin-peer", email: "superadmin-peer@test.local" };
  const store = new MemoryStore({ ...initial, users: [...initial.users.filter((user) => user.role !== "SUPERADMIN"), superadmin, peer] });
  return { store, service: createApplicationService(store), admin, superadmin, peer,
    manager: initial.users.find((user) => user.role === "MANAGER")!,
    vet: initial.users.find((user) => user.role === "VETERINARIAN")! };
}

async function authenticatedActor(store: MemoryStore, user: User, stepUp = false): Promise<User> {
  const login = await loginUser(store, user.email, PASSWORD);
  const request = new Request("http://localhost/api/v1/session/reauth", { headers: { cookie: `cvg_session=${login.sessionToken}` } });
  return stepUp ? reauthenticateUser(store, request, PASSWORD) : authenticateRequest(store, request);
}

type Setup = ReturnType<typeof setup>;
const privilegedMutations = ["create", "grant", "demote", "department", "deactivate", "activeFlag", "onCall", "password", "resetLink", "session"] as const;
type PrivilegedMutation = typeof privilegedMutations[number];

function mutate(context: Setup, actor: User, operation: PrivilegedMutation, targetSessionId: string) {
  const { service, peer, vet } = context;
  const input = { expectedVersion: peer.version, idempotencyKey: `super-${operation}` };
  switch (operation) {
    case "create": return service.createManagedUser(actor, { email: "new-super@test.local", displayName: "Novo superadministrador", role: "SUPERADMIN", idempotencyKey: input.idempotencyKey });
    case "grant": return service.updateUserRole(actor, vet.id, { role: "SUPERADMIN", departmentCode: vet.departmentCode, ...input, expectedVersion: vet.version });
    case "demote": return service.updateUserRole(actor, peer.id, { role: "ADMIN", departmentCode: peer.departmentCode, ...input });
    case "department": return service.updateUserRole(actor, peer.id, { role: "SUPERADMIN", departmentCode: "OPERATIONS", ...input });
    case "deactivate": return service.deactivateManagedUser(actor, peer.id, input);
    case "activeFlag": return service.updateUserRole(actor, peer.id, { role: "SUPERADMIN", departmentCode: peer.departmentCode, active: false, ...input });
    case "onCall": return service.updateUserOnCall(actor, peer.id, { onCall: true, ...input });
    case "password": return service.regenerateManagedUserPassword(actor, peer.id, input);
    case "resetLink": return service.issuePasswordResetLink(actor, peer.id, input);
    case "session": return service.revokeManagedSession(actor, targetSessionId, input);
  }
}

describe("SUPERADMIN administrative lifecycle", () => {
  it("lists users, sessions and catalogs globally while ADMIN cannot inspect SUPERADMIN sessions", async () => {
    const context = setup();
    const { service, store, superadmin, peer, admin } = context;
    const target = await authenticatedActor(store, peer);
    await authenticatedActor(store, context.vet);
    expect((await service.listManagedUsers(superadmin)).map((user) => user.id)).toEqual(expect.arrayContaining(store.getState().users.map((user) => user.id)));
    expect((await service.listManagedUsers(admin)).some((user) => user.role === "SUPERADMIN")).toBe(false);
    const sessions = await service.listManagedSessions(superadmin);
    expect(sessions.map((session) => session.id)).toContain(target.sessionId);
    expect((await service.listManagedSessions(admin)).map((session) => session.id)).not.toContain(target.sessionId);
    for (const session of sessions) {
      expect(session).not.toHaveProperty("tokenHash");
      expect(session).not.toHaveProperty("csrfTokenHash");
    }
    expect((await service.listServices(superadmin, { includeInactive: true })).map((service) => service.id)).toEqual(store.getState().services.map((service) => service.id));
    const created = await service.createDiagnosticService(superadmin, { code: "SUPER_GLOBAL_LAB", name: "Catálogo global", category: "LABORATORY", departmentCode: "LABORATORY", workflowType: "LABORATORY", requiresSample: true, requiresSchedule: false, allowsAttachment: false, resultSchema: "NARRATIVE", slaHours: { ROUTINE: 24, URGENT: 4, EMERGENCY: 1 }, idempotencyKey: "super-global-catalog" });
    expect(created).toMatchObject({ departmentCode: "LABORATORY" });
  });

  it.each(privilegedMutations)("denies ADMIN and MANAGER SUPERADMIN %s without changing state", async (operation) => {
    const context = setup();
    const target = await authenticatedActor(context.store, context.peer);
    const admin = await authenticatedActor(context.store, context.admin, true);
    const manager = await authenticatedActor(context.store, context.manager, true);
    const before = context.store.getState();
    for (const actor of [admin, manager]) {
      await expect(mutate(context, actor, operation, target.sessionId!)).rejects.toMatchObject({ code: "SCOPE_DENIED", status: 404 });
    }
    expect(context.store.getState()).toEqual(before);
  });

  it.each(privilegedMutations)("requires persisted recent step-up for SUPERADMIN %s", async (operation) => {
    const context = setup();
    const target = await authenticatedActor(context.store, context.peer);
    const actor = await authenticatedActor(context.store, context.superadmin);
    const before = context.store.getState();
    await expect(mutate(context, { ...actor, reauthenticatedAt: new Date().toISOString() }, operation, target.sessionId!)).rejects.toMatchObject({ code: "REAUTH_REQUIRED", status: 403 });
    expect(context.store.getState()).toEqual(before);
  });

  it("creates SUPERADMIN with one-time credentials and idempotent audit evidence", async () => {
    const { service, store, superadmin } = setup();
    const actor = await authenticatedActor(store, superadmin, true);
    const input = { email: "provisioned-super@test.local", displayName: "Superadministrador", role: "SUPERADMIN" as const, departmentCode: "OPERATIONS", idempotencyKey: "super-provision" };
    const created = await service.createManagedUser(actor, input);
    expect(created).toMatchObject({ role: "SUPERADMIN", active: true });
    expect(store.getState().users.find((user) => user.id === created.id)).toMatchObject({ mustChangePassword: true });
    expect(created.initialPassword).toBeTruthy();
    expect(verifyPassword(created.initialPassword!, store.getState().users.find((user) => user.id === created.id)!.passwordHash)).toBe(true);
    expect(JSON.stringify(store.getState())).not.toContain(created.initialPassword!);
    const replay = await service.createManagedUser(actor, input);
    expect(replay).toMatchObject({ id: created.id });
    expect(replay).not.toHaveProperty("initialPassword");
    expect(store.getState().auditEvents.filter((event) => event.entityId === created.id && event.eventType === "UserCreated")).toHaveLength(1);
  });

  it("allows promotion and demotion with step-up, revoking the target's sessions and pending reset", async () => {
    const { store, service, superadmin, peer, vet } = setup();
    const actor = await authenticatedActor(store, superadmin, true);
    const target = await authenticatedActor(store, peer);
    await service.issuePasswordResetLink(actor, peer.id, { expectedVersion: peer.version, idempotencyKey: "super-pending-reset" });
    const current = store.getState().users.find((user) => user.id === peer.id)!;
    const demoted = await service.updateUserRole(actor, peer.id, { role: "ADMIN", departmentCode: peer.departmentCode, expectedVersion: current.version, idempotencyKey: "super-demotion" });
    expect(demoted.role).toBe("ADMIN");
    expect(store.getState().users.find((user) => user.id === peer.id)).not.toHaveProperty("passwordReset");
    expect(store.getState().sessions.find((session) => session.id === target.sessionId)?.revokedAt).toBeTruthy();
    expect(await service.updateUserRole(actor, vet.id, { role: "SUPERADMIN", departmentCode: "OPERATIONS", expectedVersion: vet.version, idempotencyKey: "super-promotion" })).toMatchObject({ role: "SUPERADMIN" });
  });

  it.each(["password", "resetLink"] as const)("replaces SUPERADMIN %s only once and revokes sessions", async (operation) => {
    const context = setup();
    const actor = await authenticatedActor(context.store, context.superadmin, true);
    const target = await authenticatedActor(context.store, context.peer);
    const result = await mutate(context, actor, operation, target.sessionId!);
    const replay = await mutate(context, actor, operation, target.sessionId!);
    if (operation === "password") {
      expect(result).toHaveProperty("initialPassword");
      expect(replay).not.toHaveProperty("initialPassword");
    } else {
      expect(result).toHaveProperty("resetUrl");
      expect(replay).not.toHaveProperty("resetUrl");
    }
    expect(context.store.getState().sessions.find((session) => session.id === target.sessionId)?.revokedAt).toBeTruthy();
  });

  it("updates SUPERADMIN department and on-call only with step-up, then deactivates a peer safely", async () => {
    const { store, service, superadmin, peer } = setup();
    const actor = await authenticatedActor(store, superadmin, true);
    const moved = await service.updateUserRole(actor, peer.id, { role: "SUPERADMIN", departmentCode: "OPERATIONS", expectedVersion: peer.version, idempotencyKey: "super-move" });
    const onCall = await service.updateUserOnCall(actor, peer.id, { onCall: true, expectedVersion: moved.version, idempotencyKey: "super-oncall" });
    const disabled = await service.deactivateManagedUser(actor, peer.id, { expectedVersion: onCall.version, idempotencyKey: "super-disable" });
    expect(disabled).toMatchObject({ role: "SUPERADMIN", active: false, onCall: false });
    expect(store.getState().users.filter((user) => user.role === "SUPERADMIN" && user.active)).toHaveLength(1);
  });

  it("revokes a SUPERADMIN session with step-up and rejects revoking the current session", async () => {
    const context = setup();
    const actor = await authenticatedActor(context.store, context.superadmin, true);
    const target = await authenticatedActor(context.store, context.peer);
    const revoked = await mutate(context, actor, "session", target.sessionId!);
    expect(revoked).toMatchObject({ id: target.sessionId, revokedAt: expect.any(String) });
    await expect(context.service.revokeManagedSession(actor, actor.sessionId!, { idempotencyKey: "super-revoke-self" })).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
  });

  it("protects the last SUPERADMIN independently from ordinary administrators", async () => {
    const { store, service, superadmin, peer } = setup();
    const stale = await authenticatedActor(store, peer, true);
    const current = await authenticatedActor(store, superadmin, true);
    await service.updateUserRole(current, peer.id, { role: "ADMIN", departmentCode: peer.departmentCode, expectedVersion: peer.version, idempotencyKey: "peer-super-demotion" });
    await expect(service.updateUserRole(stale, superadmin.id, { role: "ADMIN", departmentCode: superadmin.departmentCode, expectedVersion: superadmin.version, idempotencyKey: "stale-super-demotion" })).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
    await expect(service.deactivateManagedUser(current, superadmin.id, { expectedVersion: superadmin.version, idempotencyKey: "last-super-self" })).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    await expect(service.updateUserRole(current, superadmin.id, { role: "ADMIN", departmentCode: superadmin.departmentCode, expectedVersion: superadmin.version, idempotencyKey: "last-super-self-demotion" })).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    expect(store.getState().users.filter((user) => user.role === "SUPERADMIN" && user.active)).toHaveLength(1);
  });

  it.each(["demote", "deactivate"] as const)("preserves one active SUPERADMIN during competing %s operations", async (operation) => {
    const context = setup();
    const left = await authenticatedActor(context.store, context.superadmin, true);
    const right = await authenticatedActor(context.store, context.peer, true);
    const remove = (actor: User, target: User) => operation === "demote"
      ? context.service.updateUserRole(actor, target.id, { role: "ADMIN", departmentCode: target.departmentCode, expectedVersion: target.version, idempotencyKey: `super-race-${target.id}` })
      : context.service.deactivateManagedUser(actor, target.id, { expectedVersion: target.version, idempotencyKey: `super-race-${target.id}` });
    const result = await Promise.allSettled([remove(left, context.peer), remove(right, context.superadmin)]);
    expect(result.filter((entry) => entry.status === "fulfilled")).toHaveLength(1);
    expect(result.find((entry) => entry.status === "rejected")).toMatchObject({ reason: { code: "UNAUTHENTICATED" } });
    expect(context.store.getState().users.filter((user) => user.role === "SUPERADMIN" && user.active)).toHaveLength(1);
  });

  it("counts SUPERADMIN as a remaining administrator without retaining a redundant ADMIN role", async () => {
    const { store, service, superadmin, admin } = setup();
    const actor = await authenticatedActor(store, superadmin, true);
    expect(await service.deactivateManagedUser(actor, admin.id, { expectedVersion: admin.version, idempotencyKey: "last-ordinary-admin" })).toMatchObject({ active: false });
    expect(store.getState().users.filter((user) => user.active && (user.role === "ADMIN" || user.role === "SUPERADMIN"))).toHaveLength(2);
  });
});
