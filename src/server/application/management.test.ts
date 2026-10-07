import { afterEach, describe, expect, it, vi } from "vitest";
import { createApplicationService } from "./service";
import { createDemoState } from "../store/fixtures";
import { MemoryStore } from "../store/memory-store";
import { authenticateRequest, loginUser, reauthenticateUser, revokeSession } from "../security/session";
import { verifyPassword } from "../security/password";

function initialPassword(created: { initialPassword?: string }): string {
  if (!created.initialPassword) throw new Error("missing initial password on first creation");
  return created.initialPassword;
}

async function authenticatedActor(store: MemoryStore, email: string, stepUp = false) {
  const login = await loginUser(store, email, "management-test-password");
  const request = new Request("http://localhost/api/v1/session/reauth", {
    headers: { cookie: `cvg_session=${login.sessionToken}` }
  });
  return stepUp
    ? reauthenticateUser(store, request, "management-test-password")
    : authenticateRequest(store, request);
}

function setup() {
  const store = new MemoryStore(createDemoState("management-test-password"));
  const service = createApplicationService(store);
  const user = (email: string) => {
    const actor = store.getState().users.find((entry) => entry.email === email);
    if (!actor) throw new Error(`missing fixture actor: ${email}`);
    return actor;
  };
  return { store, service, admin: user("admin@cvg.local"), manager: user("manager@cvg.local"), vet: user("vet@cvg.local") };
}

describe("management control center", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("creates from name, email and role, exposing the generated password only once", async () => {
    const { store, service, admin } = setup();
    vi.stubEnv("APP_TIMEZONE", "Europe/Lisbon");
    const command = { email: "minimal.user@cvg.local", displayName: "Novo colaborador", role: "VIEWER" as const, idempotencyKey: "minimal-create" };
    const created = await service.createManagedUser(admin, command);
    const password = initialPassword(created);
    expect(password.length).toBeGreaterThanOrEqual(12);
    expect(password).toMatch(/[A-Za-z]/);
    expect(password).toMatch(/[0-9]/);
    expect(created).toMatchObject({ departmentCode: admin.departmentCode, timezone: "Europe/Lisbon", active: true, version: 1 });
    expect(created).not.toHaveProperty("passwordHash");
    const persisted = store.getState().users.find((user) => user.id === created.id);
    if (!persisted) throw new Error("created user missing");
    expect(persisted).toMatchObject({ mustChangePassword: true });
    expect(verifyPassword(password, persisted.passwordHash)).toBe(true);
    await expect(service.listManagedUsers({ ...persisted, mustChangePassword: false })).rejects.toMatchObject({ code: "PASSWORD_CHANGE_REQUIRED", status: 403 });
    expect(JSON.stringify(store.getState())).not.toContain(password);
    expect(store.getState().idempotency.at(-1)?.response).not.toHaveProperty("initialPassword");
    const replay = await service.createManagedUser(admin, { ...command, correlationId: "retry-correlation" });
    expect(replay).toEqual(expect.objectContaining({ id: created.id }));
    expect(replay).not.toHaveProperty("initialPassword");
    expect((await service.listManagedUsers(admin)).find((user) => user.id === created.id)).not.toHaveProperty("initialPassword");
    expect(store.getState().users.filter((user) => user.email === command.email)).toHaveLength(1);
    expect(store.getState().auditEvents.filter((event) => event.eventType === "UserCreated")).toHaveLength(1);
    expect(store.getState().auditEvents.at(-1)).toMatchObject({ actorId: admin.id, entityId: created.id, newState: "ACTIVE", metadata: { action: "CREATE_USER", departmentCode: admin.departmentCode, role: "VIEWER" } });
    await expect(service.createManagedUser(admin, { ...command, displayName: "Outro nome" })).rejects.toMatchObject({ code: "IDEMPOTENCY_KEY_REUSED", status: 409 });
    await expect(service.createManagedUser(admin, { ...command, idempotencyKey: "duplicate-email" })).rejects.toMatchObject({ code: "CONFLICT", status: 409 });
    await expect(service.createManagedUser(admin, { ...command, email: "missing.key@cvg.local", idempotencyKey: undefined })).rejects.toMatchObject({ code: "IDEMPOTENCY_KEY_REQUIRED", status: 400 });
  });

  it("validates explicit and configured timezones before provisioning", async () => {
    const { store, service, admin } = setup();
    const command = { email: "timezone.user@cvg.local", displayName: "Fuso", role: "VIEWER" as const, idempotencyKey: "timezone-create" };
    vi.stubEnv("APP_TIMEZONE", undefined);
    expect(await service.createManagedUser(admin, command)).toMatchObject({ timezone: "America/Sao_Paulo" });
    vi.stubEnv("APP_TIMEZONE", "Invalid/Timezone");
    const before = store.getState();
    await expect(service.createManagedUser(admin, { ...command, email: "invalid.timezone@cvg.local", idempotencyKey: "invalid-timezone" })).rejects.toMatchObject({ code: "VALIDATION_ERROR", status: 400 });
    expect(store.getState()).toEqual(before);
    expect(await service.createManagedUser(admin, { ...command, email: "explicit.timezone@cvg.local", timezone: "UTC", idempotencyKey: "explicit-timezone" })).toMatchObject({ timezone: "UTC" });
  });

  it("serializes simultaneous creates and returns the secret to exactly one caller", async () => {
    const { store, service, admin } = setup();
    const command = { email: "concurrent.user@cvg.local", displayName: "Concorrente", role: "VIEWER" as const, idempotencyKey: "concurrent-create" };
    const results = await Promise.all([service.createManagedUser(admin, command), service.createManagedUser(admin, command)]);
    expect(results[0].id).toBe(results[1].id);
    expect(results.filter((result) => result.initialPassword !== undefined)).toHaveLength(1);
    expect(store.getState().auditEvents.filter((event) => event.eventType === "UserCreated")).toHaveLength(1);
    expect(JSON.stringify(store.getState())).not.toContain(initialPassword(results[0]));
  });

  it("updates ordinary access without step-up and retains scope, version, replay and audit controls", async () => {
    const { store, service, manager, admin } = setup();
    const lab = store.getState().users.find((user) => user.email === "lab@cvg.local");
    if (!lab) throw new Error("lab actor missing");
    await loginUser(store, lab.email, "management-test-password");
    const command = { role: lab.role, departmentCode: "RADIOLOGY", active: false, expectedVersion: lab.version, idempotencyKey: "ordinary-update" };
    const updated = await service.updateUserRole(manager, lab.id, command);
    expect(updated).toMatchObject({ role: lab.role, departmentCode: "RADIOLOGY", active: false, version: 2 });
    expect(await service.updateUserRole(manager, lab.id, command)).toEqual(updated);
    expect(store.getState().sessions.find((session) => session.userId === lab.id)?.revokedAt).toBeTruthy();
    expect(store.getState().auditEvents.at(-1)).toMatchObject({ actorId: manager.id, previousState: "LAB_TECH:LABORATORY:true", newState: "LAB_TECH:RADIOLOGY:false", metadata: { action: "UPDATE_USER_ACCESS", departmentCode: "RADIOLOGY" } });
    await expect(service.updateUserRole(manager, lab.id, { ...command, departmentCode: "ULTRASOUND" })).rejects.toMatchObject({ code: "IDEMPOTENCY_KEY_REUSED", status: 409 });
    await expect(service.updateUserRole(manager, lab.id, { ...command, idempotencyKey: "stale-update" })).rejects.toMatchObject({ code: "STALE_VERSION" });
    await expect(service.updateUserRole(manager, lab.id, { ...command, expectedVersion: 2, departmentCode: "IT", idempotencyKey: "foreign-update" })).rejects.toMatchObject({ code: "SCOPE_DENIED" });
    await expect(service.updateUserRole(manager, admin.id, { ...command, expectedVersion: admin.version, idempotencyKey: "technical-target" })).rejects.toMatchObject({ code: "SCOPE_DENIED" });
    expect(await service.updateUserRole(manager, lab.id, { ...command, active: true, expectedVersion: 2, idempotencyKey: "ordinary-reactivation" })).toMatchObject({ active: true, version: 3 });
  });

  it("requires recent step-up for creating or granting ADMIN", async () => {
    const { store, service, admin, vet } = setup();
    const create = { email: "new.admin@cvg.local", displayName: "Admin", role: "ADMIN" as const, idempotencyKey: "admin-create" };
    const update = { role: "ADMIN" as const, departmentCode: vet.departmentCode, expectedVersion: vet.version, idempotencyKey: "admin-grant" };
    const before = store.getState();
    for (const actor of [admin, { ...admin, reauthenticatedAt: new Date().toISOString() }]) {
      await expect(service.createManagedUser(actor, create)).rejects.toMatchObject({ code: "REAUTH_REQUIRED", status: 403 });
      await expect(service.updateUserRole(actor, vet.id, update)).rejects.toMatchObject({ code: "REAUTH_REQUIRED", status: 403 });
    }
    expect(store.getState()).toEqual(before);
    for (const timestamp of [new Date(Date.now() - 11 * 60 * 1000).toISOString(), new Date(Date.now() + 60_000).toISOString()]) {
      const expiredActor = await authenticatedActor(store, admin.email, true);
      await store.transaction((state) => ({ state: { ...state, sessions: state.sessions.map((session) => session.id === expiredActor.sessionId ? { ...session, reauthenticatedAt: timestamp } : session) }, result: undefined }));
      const snapshot = store.getState();
      await expect(service.createManagedUser(expiredActor, create)).rejects.toMatchObject({ code: "REAUTH_REQUIRED", status: 403 });
      await expect(service.updateUserRole(expiredActor, vet.id, update)).rejects.toMatchObject({ code: "REAUTH_REQUIRED", status: 403 });
      expect(store.getState()).toEqual(snapshot);
    }
    const actor = await authenticatedActor(store, admin.email, true);
    expect(await service.createManagedUser(actor, create)).toMatchObject({ role: "ADMIN" });
    expect(await service.updateUserRole(actor, vet.id, update)).toMatchObject({ role: "ADMIN", version: 2 });
  });

  it("rejects forged step-up timestamps on a valid session that was never reauthenticated", async () => {
    const { store, service, admin, vet } = setup();
    const actor = await authenticatedActor(store, admin.email);
    expect(actor.sessionId).toBeTruthy();
    expect(store.getState().sessions.find((session) => session.id === actor.sessionId)?.reauthenticatedAt).toBeUndefined();
    const forgedActor = { ...actor, reauthenticatedAt: new Date().toISOString() };
    const before = store.getState();
    await expect(service.createManagedUser(forgedActor, { email: "forged.admin@cvg.local", displayName: "Forjado", role: "ADMIN", idempotencyKey: "forged-create" })).rejects.toMatchObject({ code: "REAUTH_REQUIRED", status: 403 });
    await expect(service.updateUserRole(forgedActor, vet.id, { role: "ADMIN", departmentCode: vet.departmentCode, expectedVersion: vet.version, idempotencyKey: "forged-grant" })).rejects.toMatchObject({ code: "REAUTH_REQUIRED", status: 403 });
    expect(store.getState()).toEqual(before);
  });

  it.each([
    { label: "demotion", role: "VIEWER" as const, targetActive: true, active: true },
    { label: "deactivation", role: "ADMIN" as const, targetActive: true, active: false },
    { label: "reactivation", role: "ADMIN" as const, targetActive: false, active: true }
  ])("requires step-up for ADMIN $label", async ({ role, targetActive, active }) => {
    const { store, service, admin } = setup();
    const target = { ...admin, id: "target-admin", email: "target.admin@cvg.local", active: targetActive };
    await store.transaction((state) => ({ state: { ...state, users: [...state.users, target] }, result: undefined }));
    const command = { role, departmentCode: target.departmentCode, active, expectedVersion: target.version, idempotencyKey: "admin-access-update" };
    const before = store.getState();
    await expect(service.updateUserRole(admin, target.id, command)).rejects.toMatchObject({ code: "REAUTH_REQUIRED" });
    if (targetActive) await expect(service.deactivateManagedUser(admin, target.id, { expectedVersion: target.version, idempotencyKey: "admin-deactivate" })).rejects.toMatchObject({ code: "REAUTH_REQUIRED" });
    expect(store.getState()).toEqual(before);
    const actor = await authenticatedActor(store, admin.email, true);
    const updated = role === "ADMIN" && !active
      ? await service.deactivateManagedUser(actor, target.id, { expectedVersion: target.version, idempotencyKey: "admin-deactivate" })
      : await service.updateUserRole(actor, target.id, command);
    expect(updated).toMatchObject({ role, active });
  });

  it("changes only an ADMIN department without requiring step-up", async () => {
    const { store, service, admin } = setup();
    const target = { ...admin, id: "department-admin", email: "department.admin@cvg.local" };
    await store.transaction((state) => ({ state: { ...state, users: [...state.users, target] }, result: undefined }));
    expect(await service.updateUserRole(admin, target.id, { role: "ADMIN", departmentCode: "OPERATIONS", expectedVersion: target.version, idempotencyKey: "admin-department" })).toMatchObject({ role: "ADMIN", departmentCode: "OPERATIONS", active: true });
  });

  it("protects the last ADMIN through self-denial and transactional authorization during competing demotions", async () => {
    const { store, service, admin } = setup();
    const actor = await authenticatedActor(store, admin.email, true);
    const before = store.getState();
    await expect(service.updateUserRole(actor, admin.id, { role: "VIEWER", departmentCode: admin.departmentCode, expectedVersion: admin.version, idempotencyKey: "last-admin-demotion" })).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    await expect(service.deactivateManagedUser(actor, admin.id, { expectedVersion: admin.version, idempotencyKey: "last-admin-deactivate" })).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    expect(store.getState()).toEqual(before);
    const peer = { ...admin, id: "peer-admin", email: "peer.admin@cvg.local" };
    await store.transaction((state) => ({ state: { ...state, users: [...state.users, peer] }, result: undefined }));
    const peerActor = await authenticatedActor(store, peer.email, true);
    const results = await Promise.allSettled([
      service.updateUserRole(actor, peer.id, { role: "VIEWER", departmentCode: peer.departmentCode, expectedVersion: peer.version, idempotencyKey: "demote-peer" }),
      service.updateUserRole(peerActor, admin.id, { role: "VIEWER", departmentCode: admin.departmentCode, expectedVersion: admin.version, idempotencyKey: "demote-admin" })
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.find((result) => result.status === "rejected")).toMatchObject({ reason: { code: "UNAUTHENTICATED" } });
    expect(store.getState().users.filter((user) => user.role === "ADMIN" && user.active)).toHaveLength(1);
  });

  it("rejects unauthorized provisioning and sessions, including current-session revocation", async () => {
    const { store, service, admin, manager, vet } = setup();
    const create = { email: "denied.user@cvg.local", displayName: "Negado", role: "VIEWER" as const, idempotencyKey: "denied-create" };
    const before = store.getState();
    await expect(service.createManagedUser(vet, create)).rejects.toMatchObject({ code: "SCOPE_DENIED" });
    await expect(service.createManagedUser(manager, { ...create, departmentCode: "IT" })).rejects.toMatchObject({ code: "SCOPE_DENIED" });
    await expect(service.deactivateManagedUser(manager, admin.id, { expectedVersion: admin.version, idempotencyKey: "denied-deactivate" })).rejects.toMatchObject({ code: "SCOPE_DENIED" });
    expect(store.getState()).toEqual(before);
    const login = await loginUser(store, admin.email, "management-test-password");
    const actor = await authenticateRequest(store, new Request("http://localhost", { headers: { cookie: `cvg_session=${login.sessionToken}` } }));
    if (!actor.sessionId) throw new Error("current session missing");
    await expect(service.revokeManagedSession(actor, actor.sessionId, { idempotencyKey: "revoke-self" })).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    await expect(service.revokeManagedSession(manager, actor.sessionId, { idempotencyKey: "revoke-foreign" })).rejects.toMatchObject({ code: "SCOPE_DENIED" });
    await expect(service.revokeManagedSession(vet, actor.sessionId, { idempotencyKey: "revoke-unprivileged" })).rejects.toMatchObject({ code: "SCOPE_DENIED" });
    expect(store.getState().sessions.find((session) => session.id === actor.sessionId)?.revokedAt).toBeUndefined();
  });
  it("fingerprints provisioned passwords confidentially and rejects a changed password on retry", async () => {
    const first = setup();
    const second = setup();
    const baseInput = {
      email: "fingerprint.password@cvg.local",
      displayName: "Senha fora do fingerprint",
      role: "LAB_TECH" as const,
      departmentCode: "LABORATORY",
      timezone: "America/Sao_Paulo",
      reason: "Validar proteção do segredo",
      confirm: true as const,
      idempotencyKey: "password-fingerprint"
    };

    await first.service.createManagedUser(first.admin, {
      ...baseInput,
      password: "first-secure-password-123"
    });
    await second.service.createManagedUser(second.admin, {
      ...baseInput,
      password: "second-secure-password-456"
    });

    const firstFingerprint = first.store.getState().idempotency.find((record) => record.key === baseInput.idempotencyKey)?.payloadHash;
    const secondFingerprint = second.store.getState().idempotency.find((record) => record.key === baseInput.idempotencyKey)?.payloadHash;
    expect(firstFingerprint).toEqual(expect.any(String));
    expect(secondFingerprint).toEqual(expect.any(String));
    expect(secondFingerprint).not.toBe(firstFingerprint);
    await expect(first.service.createManagedUser(first.admin, {
      ...baseInput,
      password: "second-secure-password-456"
    })).rejects.toMatchObject({ code: "IDEMPOTENCY_KEY_REUSED", status: 409 });
  });

  it("rejects privileged changes when the authenticated step-up session was revoked", async () => {
    const { store, service } = setup();
    const login = await loginUser(store, "admin@cvg.local", "management-test-password");
    const request = new Request("http://localhost/api/v1/session/reauth", {
      headers: { cookie: `cvg_session=${login.sessionToken}` }
    });
    const actor = await reauthenticateUser(store, request, "management-test-password");
    await revokeSession(store, login.sessionToken);

    await expect(service.createManagedUser(actor, {
      email: "revoked.stepup@cvg.local",
      displayName: "Sessão revogada",
      password: "revoked-session-password-123",
      role: "LAB_TECH",
      departmentCode: "LABORATORY",
      timezone: "America/Sao_Paulo",
      reason: "Validar revogação transacional",
      confirm: true,
      idempotencyKey: "revoked-stepup-create"
    })).rejects.toMatchObject({ code: "UNAUTHENTICATED", status: 401 });
  });

  it("generates new credentials even when legacy callers supply an opaque password", async () => {
    const { service, store, admin } = setup();
    const password = " secure-password-123 ";
    const created = await service.createManagedUser(admin, {
      email: "opaque.password@cvg.local",
      displayName: "Senha opaca",
      password,
      role: "LAB_TECH",
      departmentCode: "LABORATORY",
      timezone: "America/Sao_Paulo",
      reason: "Validar credencial literal",
      confirm: true,
      idempotencyKey: "opaque-password-user"
    });

    const persisted = store.getState().users.find((user) => user.id === created.id);
    if (!persisted) throw new Error("created user missing");
    expect(verifyPassword(initialPassword(created), persisted.passwordHash)).toBe(true);
    expect(verifyPassword(password, persisted.passwordHash)).toBe(false);
    expect(verifyPassword(password.trim(), persisted.passwordHash)).toBe(false);
    expect(JSON.stringify(store.getState())).not.toContain(password);
  });

  it("lets a delegated manager create and deactivate an operational collaborator", async () => {
    const { store, service, manager } = setup();
    const created = await service.createManagedUser(manager, {
      email: "new.lab.tech@cvg.local",
      displayName: "Nova técnica de laboratório",
      role: "LAB_TECH",
      departmentCode: "LABORATORY",
      timezone: "America/Sao_Paulo",
      idempotencyKey: "management-create-user"
    });

    expect(created).toMatchObject({ email: "new.lab.tech@cvg.local", role: "LAB_TECH", active: true, version: 1 });
    expect(created).not.toHaveProperty("passwordHash");
    expect(store.getState().users.find((user) => user.id === created.id)?.passwordHash).not.toBe("secure-lab-password-123");

    await loginUser(store, created.email, initialPassword(created));
    const deactivateCommand = {
      expectedVersion: created.version,
      idempotencyKey: "management-deactivate-user"
    };
    const deactivated = await service.deactivateManagedUser(manager, created.id, deactivateCommand);
    expect(await service.deactivateManagedUser(manager, created.id, deactivateCommand)).toEqual(deactivated);

    expect(deactivated).toMatchObject({ id: created.id, active: false, version: 2 });
    expect(store.getState().sessions.find((session) => session.tokenHash === store.getState().sessions.find((entry) => entry.userId === created.id)?.tokenHash)?.revokedAt).toBeTruthy();
    await expect(loginUser(store, created.email, initialPassword(created))).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
    expect(store.getState().auditEvents.map((event) => event.eventType)).toEqual(expect.arrayContaining(["UserCreated", "UserDeactivated"]));
    expect(store.getState().auditEvents.filter((event) => event.eventType === "UserDeactivated")).toHaveLength(1);
    expect(store.getState().auditEvents.at(-1)).toMatchObject({ actorId: manager.id, previousState: "ACTIVE", newState: "INACTIVE", metadata: { action: "DEACTIVATE_USER", departmentCode: "LABORATORY" } });
  });

  it("denies a manager system sessions in their own department while preserving ordinary user administration", async () => {
    const { store, service, manager, vet } = setup();
    expect(manager.departmentCode).toBe(vet.departmentCode);
    const actor = await authenticatedActor(store, manager.email);
    const target = await authenticatedActor(store, vet.email);
    if (!target.sessionId) throw new Error("target session missing");
    const before = store.getState();
    await expect(service.listManagedSessions(actor)).rejects.toMatchObject({ code: "SCOPE_DENIED", status: 404 });
    await expect(service.revokeManagedSession(actor, target.sessionId, { idempotencyKey: "manager-same-department-revoke" })).rejects.toMatchObject({ code: "SCOPE_DENIED", status: 404 });
    expect(store.getState()).toEqual(before);
    expect(await service.listManagedUsers(actor)).toContainEqual(expect.objectContaining({ id: vet.id }));
    expect(await service.updateUserRole(actor, vet.id, { role: "VIEWER", departmentCode: vet.departmentCode, expectedVersion: vet.version, idempotencyKey: "manager-ordinary-update" })).toMatchObject({ id: vet.id, role: "VIEWER", version: 2 });
  });

  it("lists sessions without secret material and revokes a target session idempotently", async () => {
    const { store, service, admin, vet } = setup();
    const targetLogin = await loginUser(store, vet.email, "management-test-password");
    const actor = admin;
    const targetSessionId = store.getState().sessions.find((session) => session.userId === vet.id)?.id;
    if (!targetSessionId) throw new Error("target session missing");

    const sessions = await service.listManagedSessions(actor);
    expect(sessions.find((session) => session.id === targetSessionId)).toMatchObject({
      userEmail: vet.email,
      status: "ACTIVE",
      current: false
    });
    expect(sessions[0]).not.toHaveProperty("tokenHash");

    const command = { idempotencyKey: "revoke-target-session", correlationId: "corr-session-revoke" };
    const revoked = await service.revokeManagedSession(actor, targetSessionId, command);
    const replay = await service.revokeManagedSession(actor, revoked.id, command);
    await expect(service.revokeManagedSession(actor, revoked.id, { ...command, idempotencyKey: "second-revocation" })).rejects.toMatchObject({ code: "SESSION_ALREADY_REVOKED", status: 409 });

    expect(revoked).toMatchObject({ userEmail: vet.email, status: "REVOKED", revokedAt: expect.any(String) });
    expect(replay).toEqual(revoked);
    await expect(authenticateRequest(store, new Request("http://localhost", { headers: { cookie: `cvg_session=${targetLogin.sessionToken}` } }))).rejects.toMatchObject({ code: "SESSION_EXPIRED" });
    expect(store.getState().auditEvents).toContainEqual(expect.objectContaining({ eventType: "SessionRevoked", entityId: revoked.id, actorId: admin.id }));
    expect(store.getState().auditEvents.filter((event) => event.eventType === "SessionRevoked")).toHaveLength(1);
  });

  it("keeps delegated managers away from technical roles and outside departments", async () => {
    const { service, manager, admin } = setup();

    await expect(service.createManagedUser(manager, {
      email: "forbidden.admin@cvg.local",
      displayName: "Tentativa técnica",
      password: "secure-admin-password-123",
      role: "ADMIN",
      departmentCode: "IT",
      timezone: "America/Sao_Paulo",
      reason: "Tentativa indevida",
      confirm: true,
      idempotencyKey: "management-forbidden-admin"
    })).rejects.toMatchObject({ code: "SCOPE_DENIED" });

    await expect(service.updateUserRole(manager, admin.id, {
      role: "VIEWER",
      departmentCode: "IT",
      active: true,
      expectedVersion: admin.version,
      reason: "Tentativa indevida",
      confirm: true,
      idempotencyKey: "management-forbidden-admin-update"
    })).rejects.toMatchObject({ code: "SCOPE_DENIED" });
  });

  it("lets an administrator configure and revise a manager's delegated departments", async () => {
    const { service, admin } = setup();
    const created = await service.createManagedUser(admin, {
      email: "delegated.manager@cvg.local",
      displayName: "Gestora delegada",
      password: "secure-manager-password-123",
      role: "MANAGER",
      departmentCode: "OPERATIONS",
      managedDepartmentCodes: ["laboratory", "RADIOLOGY", "laboratory"],
      timezone: "America/Sao_Paulo",
      reason: "Delegação da operação diagnóstica",
      confirm: true,
      idempotencyKey: "management-create-delegated-manager"
    });

    expect(created).toMatchObject({ role: "MANAGER", departmentCode: "OPERATIONS", managedDepartmentCodes: ["LABORATORY", "RADIOLOGY"] });

    const updated = await service.updateUserRole(admin, created.id, {
      role: "MANAGER",
      departmentCode: "OPERATIONS",
      managedDepartmentCodes: ["ULTRASOUND"],
      active: true,
      expectedVersion: created.version,
      reason: "Revisão do escopo delegado",
      confirm: true,
      idempotencyKey: "management-update-delegated-manager"
    });

    expect(updated).toMatchObject({ id: created.id, managedDepartmentCodes: ["ULTRASOUND"], version: 2 });
  });

  it("returns one scoped operational snapshot with departments and pending work", async () => {
    const { service, manager, vet } = setup();
    const request = await service.createRequest(vet, {
      patientId: "patient-thor",
      encounterId: "encounter-thor",
      priority: "EMERGENCY",
      items: [{ serviceId: "service-hemogram" }, { serviceId: "service-xray" }]
    }, { idempotencyKey: "management-overview-request" });

    const overview = await service.managementOverview(manager);

    expect(overview.asOf).toEqual(expect.any(String));
    expect(overview.summary.activeItems).toBe(2);
    expect(overview.summary.pendingRequests).toBe(1);
    expect(overview.departments.map((department) => department.departmentCode)).toEqual(expect.arrayContaining(["LABORATORY", "RADIOLOGY", "ULTRASOUND"]));
    expect(overview.pending.map((item) => item.requestId)).toEqual(expect.arrayContaining([request.id]));
    expect(overview.pending[0]).toMatchObject({ nextAction: expect.any(String), deepLink: expect.stringContaining(`/requests/${request.id}`) });
  });
});
