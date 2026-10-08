import { afterEach, describe, expect, it, vi } from "vitest";
import { createApplicationService } from "./service";
import { createDemoState } from "../store/fixtures";
import { MemoryStore } from "../store/memory-store";
import { authenticateRequest, loginUser, reauthenticateUser } from "../security/session";
import { validatedPassword } from "./service-common";
import { hashResetToken } from "../security/password-reset";

const PASSWORD = "management-test-password";

function setup() {
  const store = new MemoryStore(createDemoState(PASSWORD));
  const service = createApplicationService(store);
  const user = (email: string) => store.getState().users.find((entry) => entry.email === email)!;
  return { store, service, admin: user("admin@cvg.local"), manager: user("manager@cvg.local"), vet: user("vet@cvg.local"), user };
}

async function actorFor(store: MemoryStore, email: string, stepUp = false) {
  const login = await loginUser(store, email, PASSWORD);
  const request = new Request("http://localhost/api/v1/session/reauth", { headers: { cookie: `cvg_session=${login.sessionToken}` } });
  return stepUp ? reauthenticateUser(store, request, PASSWORD) : authenticateRequest(store, request);
}

describe("issuePasswordResetLink (PROD-202)", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("stores only the token hash, returns the URL once, revokes sessions, bumps the version and audits without the token", async () => {
    vi.stubEnv("APP_ORIGIN", "https://hub.hospital.example/");
    vi.stubEnv("PASSWORD_RESET_TTL_MS", String(30 * 60 * 1000));
    const { store, service, admin, vet } = setup();
    const target = await loginUser(store, "vet@cvg.local", PASSWORD);
    const actor = await actorFor(store, "admin@cvg.local");
    const before = Date.now();

    const issued = await service.issuePasswordResetLink(actor, vet.id, { expectedVersion: vet.version, idempotencyKey: "link-1" });

    const token = new URL(issued.resetUrl!).searchParams.get("token")!;
    expect(issued.resetUrl).toBe(`https://hub.hospital.example/reset-password?token=${token}`);
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(issued.user).toMatchObject({ id: vet.id, version: vet.version + 1 });
    expect(Date.parse(issued.expiresAt) - before).toBeGreaterThan(29 * 60 * 1000);
    expect(Date.parse(issued.expiresAt) - before).toBeLessThanOrEqual(30 * 60 * 1000 + 1000);

    const state = store.getState();
    const stored = state.users.find((entry) => entry.id === vet.id)!;
    expect(stored.passwordReset).toEqual({ tokenHash: hashResetToken(token), expiresAt: issued.expiresAt, issuedAt: expect.any(String), issuedBy: admin.id });
    // The current password keeps working until the link is used; the link is the only new credential.
    expect(stored.passwordHash).toBe(vet.passwordHash);
    expect(state.sessions.filter((session) => session.userId === vet.id).every((session) => session.revokedAt)).toBe(true);
    expect(target.sessionToken).toBeTruthy();
    expect(JSON.stringify(state)).not.toContain(token);
    expect(JSON.stringify(issued.user)).not.toContain("tokenHash");
    expect(issued.user).not.toHaveProperty("passwordReset");
    const audit = state.auditEvents.filter((event) => event.eventType === "PasswordResetLinkIssued");
    expect(audit).toEqual([expect.objectContaining({ actorId: admin.id, entityId: vet.id, newState: "PASSWORD_RESET_PENDING", metadata: expect.objectContaining({ expiresAt: issued.expiresAt, replacedPrevious: false }) })]);
    expect(JSON.stringify(audit)).not.toContain(token);
    expect((await service.listManagedUsers(actor)).find((entry) => entry.id === vet.id)).not.toHaveProperty("passwordReset");
  });

  it("replays idempotently without a second token or the URL, and rejects a changed payload", async () => {
    const { store, service, vet } = setup();
    const actor = await actorFor(store, "admin@cvg.local");
    const first = await service.issuePasswordResetLink(actor, vet.id, { expectedVersion: vet.version, idempotencyKey: "link-replay" });
    const hashAfterFirst = store.getState().users.find((entry) => entry.id === vet.id)!.passwordReset!.tokenHash;

    const replay = await service.issuePasswordResetLink(actor, vet.id, { expectedVersion: vet.version, idempotencyKey: "link-replay", correlationId: "again" });

    expect(replay.user).toEqual(first.user);
    expect(replay.expiresAt).toBe(first.expiresAt);
    expect(replay).not.toHaveProperty("resetUrl");
    expect(JSON.stringify(store.getState().idempotency)).not.toContain("reset-password?token");
    expect(store.getState().users.find((entry) => entry.id === vet.id)!.passwordReset!.tokenHash).toBe(hashAfterFirst);
    expect(store.getState().auditEvents.filter((event) => event.eventType === "PasswordResetLinkIssued")).toHaveLength(1);
    await expect(service.issuePasswordResetLink(actor, vet.id, { expectedVersion: 99, idempotencyKey: "link-replay" })).rejects.toMatchObject({ code: "IDEMPOTENCY_KEY_REUSED" });
  });

  it("replaces a previous link so only the latest one can work", async () => {
    const { store, service, vet } = setup();
    const actor = await actorFor(store, "admin@cvg.local");
    const first = await service.issuePasswordResetLink(actor, vet.id, { expectedVersion: vet.version, idempotencyKey: "link-a" });
    const second = await service.issuePasswordResetLink(actor, vet.id, { expectedVersion: vet.version + 1, idempotencyKey: "link-b" });
    const stored = store.getState().users.find((entry) => entry.id === vet.id)!.passwordReset!;
    expect(stored.tokenHash).toBe(hashResetToken(new URL(second.resetUrl!, "http://x").searchParams.get("token")!));
    expect(stored.tokenHash).not.toBe(hashResetToken(new URL(first.resetUrl!, "http://x").searchParams.get("token")!));
    expect(store.getState().auditEvents.at(-1)?.metadata).toMatchObject({ replacedPrevious: true });
  });

  it("falls back to a relative URL when APP_ORIGIN is not configured", async () => {
    vi.stubEnv("APP_ORIGIN", "");
    const { store, service, vet } = setup();
    const actor = await actorFor(store, "admin@cvg.local");
    const issued = await service.issuePasswordResetLink(actor, vet.id, { expectedVersion: vet.version, idempotencyKey: "link-relative" });
    expect(issued.resetUrl).toMatch(/^\/reset-password\?token=/);
  });

  it("enforces authorization, scope, self-reset, version, activity and idempotency-key rules", async () => {
    const { store, service, admin, vet, manager } = setup();
    const adminActor = await actorFor(store, "admin@cvg.local");
    const vetActor = await actorFor(store, "vet@cvg.local");
    const managerActor = await actorFor(store, "manager@cvg.local");
    const meta = (key: string, expectedVersion?: number) => ({ expectedVersion, idempotencyKey: key });

    await expect(service.issuePasswordResetLink(vetActor, manager.id, meta("deny-role", manager.version))).rejects.toMatchObject({ code: "SCOPE_DENIED" });
    await expect(service.issuePasswordResetLink(adminActor, admin.id, meta("self", admin.version))).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    await expect(service.issuePasswordResetLink(adminActor, "missing-user", meta("missing", 1))).rejects.toMatchObject({ status: 404 });
    await expect(service.issuePasswordResetLink(adminActor, vet.id, { expectedVersion: vet.version } as never)).rejects.toMatchObject({ code: "IDEMPOTENCY_KEY_REQUIRED" });
    await expect(service.issuePasswordResetLink(adminActor, vet.id, meta("no-version"))).rejects.toMatchObject({ code: "VALIDATION_ERROR", message: expect.stringContaining("expectedVersion") });
    await expect(service.issuePasswordResetLink(adminActor, vet.id, meta("stale", vet.version + 5))).rejects.toMatchObject({ status: 409 });
    // A delegated manager cannot reach a technical role.
    await expect(service.issuePasswordResetLink(managerActor, admin.id, meta("manager-admin", admin.version))).rejects.toMatchObject({ code: "SCOPE_DENIED" });
    expect(store.getState().users.every((entry) => !entry.passwordReset)).toBe(true);

    await service.deactivateManagedUser(adminActor, vet.id, { expectedVersion: vet.version, idempotencyKey: "deactivate-vet" });
    await expect(service.issuePasswordResetLink(adminActor, vet.id, meta("inactive", vet.version + 1))).rejects.toMatchObject({ status: 409 });
  });

  it("requires recent reauthentication to issue a link for an ADMIN account", async () => {
    const { store, service, admin } = setup();
    const created = await service.createManagedUser(await actorFor(store, "admin@cvg.local", true), { email: "second.admin@cvg.local", displayName: "Segundo admin", role: "ADMIN", departmentCode: "IT", idempotencyKey: "second-admin" });
    const plain = await actorFor(store, "admin@cvg.local");
    await expect(service.issuePasswordResetLink(plain, created.id, { expectedVersion: created.version, idempotencyKey: "admin-link-no-stepup" })).rejects.toMatchObject({ status: 403 });
    const stepUp = await actorFor(store, "admin@cvg.local", true);
    const issued = await service.issuePasswordResetLink(stepUp, created.id, { expectedVersion: created.version, idempotencyKey: "admin-link-stepup" });
    expect(issued.resetUrl).toContain("/reset-password?token=");
    expect(admin.id).not.toBe(created.id);
  });

  it("applies the password policy to an explicit createUser password and to validatedPassword (PROD-203)", async () => {
    const { store, service } = setup();
    const actor = await actorFor(store, "admin@cvg.local");
    const base = { email: "policy.user@cvg.local", displayName: "Colaboradora Nova", role: "VIEWER" as const };
    await expect(service.createManagedUser(actor, { ...base, password: "Password123456", idempotencyKey: "policy-weak" })).rejects.toMatchObject({ code: "PASSWORD_POLICY" });
    await expect(service.createManagedUser(actor, { ...base, password: "Colaboradora-Lua-48-q", idempotencyKey: "policy-name" })).rejects.toMatchObject({ code: "PASSWORD_POLICY" });
    expect(store.getState().users.some((user) => user.email === base.email)).toBe(false);
    await expect(service.createManagedUser(actor, { ...base, password: "Cavalo-azul-Lua-48-xk", idempotencyKey: "policy-ok" })).resolves.toMatchObject({ email: base.email });
    expect(validatedPassword("Cavalo-azul-Lua-48-xk")).toBe("Cavalo-azul-Lua-48-xk");
    expect(() => validatedPassword("short1")).toThrowError(expect.objectContaining({ code: "VALIDATION_ERROR" }));
    expect(() => validatedPassword("Password123456")).toThrowError(expect.objectContaining({ code: "PASSWORD_POLICY" }));
  });
});
