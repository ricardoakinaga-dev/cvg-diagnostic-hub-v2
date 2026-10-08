import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDemoState } from "../store/fixtures";
import { MemoryStore } from "../store/memory-store";
import { loginUser, authenticateRequest } from "./session";
import { verifyPassword } from "./password";
import { issueResetLinkByEmail, parseResetLinkArgs, completePasswordReset, createPasswordResetGrant, hashResetToken, passwordResetTtlMs, passwordResetUrl } from "./password-reset";

const OLD = "Old-secret-2026-lua";
const NEW = "Cavalo-azul-Lua-48-xk";
const INVALID_MESSAGE = "Link de redefinição inválido ou expirado.";

function setup(mutate?: (state: ReturnType<typeof createDemoState>) => void) {
  const state = createDemoState(OLD);
  mutate?.(state);
  const store = new MemoryStore(state);
  const patchUser = (userId: string, patch: Record<string, unknown>) => store.transaction((current) => ({
    state: { ...current, users: current.users.map((user) => user.id === userId ? { ...user, ...patch } : user) },
    result: undefined
  }));
  const issue = async (userId = "user-vet", environment: Record<string, string> = {}, nowMs = Date.now()) => {
    const { token, grant } = createPasswordResetGrant("user-admin", environment, nowMs);
    await patchUser(userId, { passwordReset: grant });
    return token;
  };
  return { store, issue, patchUser, user: () => store.getState().users.find((entry) => entry.id === "user-vet")! };
}

describe("password reset helpers", () => {
  it("clamps the TTL to 5 minutes..24 hours and defaults to 60 minutes", () => {
    expect(passwordResetTtlMs({})).toBe(60 * 60 * 1000);
    expect(passwordResetTtlMs({ PASSWORD_RESET_TTL_MS: "" })).toBe(60 * 60 * 1000);
    expect(passwordResetTtlMs({ PASSWORD_RESET_TTL_MS: "abc" })).toBe(60 * 60 * 1000);
    expect(passwordResetTtlMs({ PASSWORD_RESET_TTL_MS: "1000" })).toBe(5 * 60 * 1000);
    expect(passwordResetTtlMs({ PASSWORD_RESET_TTL_MS: String(99 * 60 * 60 * 1000) })).toBe(24 * 60 * 60 * 1000);
    expect(passwordResetTtlMs({ PASSWORD_RESET_TTL_MS: "900000.7" })).toBe(900000);
  });

  it("builds an unguessable single-use token whose hash is the only thing stored", () => {
    const a = createPasswordResetGrant("admin-1", {}, Date.parse("2026-10-08T10:00:00.000Z"));
    const b = createPasswordResetGrant("admin-1");
    expect(a.token).not.toBe(b.token);
    expect(a.grant).toEqual({ tokenHash: hashResetToken(a.token, {}), issuedAt: "2026-10-08T10:00:00.000Z", expiresAt: "2026-10-08T11:00:00.000Z", issuedBy: "admin-1" });
    expect(JSON.stringify(a.grant)).not.toContain(a.token);
    expect(passwordResetUrl("tok", { APP_ORIGIN: "https://hub.example///" })).toBe("https://hub.example/reset-password?token=tok");
    expect(passwordResetUrl("tok", {})).toBe("/reset-password?token=tok");
  });
});

describe("completePasswordReset", () => {
  afterEach(() => vi.useRealTimers());

  it("sets the new password, clears the grant and mustChangePassword, revokes every session and creates none", async () => {
    const { store, issue } = setup((state) => { state.users.find((user) => user.id === "user-vet")!.mustChangePassword = true; });
    const token = await issue();
    const previous = await loginUser(store, "vet@cvg.local", OLD);
    const sessionsBefore = store.getState().sessions.length;

    const result = await completePasswordReset(store, token, NEW, "corr-1");

    expect(result).toEqual({ email: "vet@cvg.local" });
    const after = store.getState();
    const updated = after.users.find((user) => user.id === "user-vet")!;
    expect(updated).not.toHaveProperty("passwordReset");
    expect(updated.mustChangePassword).toBe(false);
    expect(verifyPassword(NEW, updated.passwordHash)).toBe(true);
    expect(after.sessions).toHaveLength(sessionsBefore);
    expect(after.sessions.filter((session) => session.userId === "user-vet").every((session) => session.revokedAt)).toBe(true);
    await expect(authenticateRequest(store, new Request("http://localhost", { headers: { cookie: `cvg_session=${previous.sessionToken}` } }))).rejects.toMatchObject({ code: "SESSION_EXPIRED" });
    await expect(loginUser(store, "vet@cvg.local", OLD)).rejects.toMatchObject({ status: 401 });
    expect((await loginUser(store, "vet@cvg.local", NEW)).user.id).toBe("user-vet");
    const audit = after.auditEvents.filter((event) => event.eventType === "PasswordResetCompleted");
    expect(audit).toEqual([expect.objectContaining({ actorId: "user-vet", entityId: "user-vet", correlationId: "corr-1", metadata: { sessionsRevoked: 1 } })]);
    expect(JSON.stringify(after.auditEvents)).not.toContain(token);
    expect(JSON.stringify(after.auditEvents)).not.toContain(NEW);
  });

  it("is single use: the same token answers like any invalid link and is audited as INVALID", async () => {
    const { store, issue } = setup();
    const token = await issue();
    await completePasswordReset(store, token, NEW, "corr-1");
    await expect(completePasswordReset(store, token, "Outra-senha-Boa-77-q", "corr-2")).rejects.toMatchObject({ code: "PASSWORD_RESET_INVALID", status: 400, message: INVALID_MESSAGE });
    expect(verifyPassword(NEW, store.getState().users.find((user) => user.id === "user-vet")!.passwordHash)).toBe(true);
    expect(store.getState().auditEvents.at(-1)).toMatchObject({ eventType: "PasswordResetRejected", entityType: "PasswordReset", entityId: "unknown", metadata: { reason: "INVALID" } });
  });

  it("answers a wrong token exactly like an expired one, and only the audit tells them apart", async () => {
    const { store, issue } = setup();
    const expired = await issue("user-vet", {}, Date.now() - 2 * 60 * 60 * 1000);
    const failures = await Promise.all([
      completePasswordReset(store, "not-a-real-token", NEW, "corr-wrong").catch((error: unknown) => error),
      completePasswordReset(store, expired, NEW, "corr-expired").catch((error: unknown) => error)
    ]);
    expect(failures[0]).toMatchObject({ code: "PASSWORD_RESET_INVALID", status: 400, message: INVALID_MESSAGE });
    expect(failures[1]).toMatchObject({ code: "PASSWORD_RESET_INVALID", status: 400, message: INVALID_MESSAGE });
    const reasons = store.getState().auditEvents.filter((event) => event.eventType === "PasswordResetRejected").map((event) => [event.correlationId, event.metadata.reason, event.entityId]);
    expect(reasons).toEqual(expect.arrayContaining([["corr-wrong", "INVALID", "unknown"], ["corr-expired", "EXPIRED", "user-vet"]]));
    expect(verifyPassword(OLD, store.getState().users.find((user) => user.id === "user-vet")!.passwordHash)).toBe(true);
  });

  it("rejects a token of a deactivated account as expired", async () => {
    const { store, issue, patchUser } = setup();
    const token = await issue();
    await patchUser("user-vet", { active: false });
    await expect(completePasswordReset(store, token, NEW, "corr")).rejects.toMatchObject({ code: "PASSWORD_RESET_INVALID" });
    expect(store.getState().auditEvents.at(-1)?.metadata).toEqual({ reason: "EXPIRED" });
  });

  it("rejects a weak, personal or breached password without consuming the token", async () => {
    const { store, issue, user } = setup();
    const token = await issue();
    const display = "Marina";
    await expect(completePasswordReset(store, token, "Password123456", "c")).rejects.toMatchObject({ code: "PASSWORD_POLICY" });
    await expect(completePasswordReset(store, token, `${display}-azul-Lua-48-xk`, "c")).rejects.toMatchObject({ code: "PASSWORD_POLICY" });
    const breached = "Breached-Lua-48-xkz";
    const digest = createHash("sha1").update(breached).digest("hex").toUpperCase();
    vi.stubGlobal("fetch", vi.fn(async () => new Response(`${digest.slice(5)}:9`)));
    await expect(completePasswordReset(store, token, breached, "c", { PASSWORD_BREACH_CHECK: "hibp" })).rejects.toMatchObject({ code: "PASSWORD_BREACHED" });
    vi.unstubAllGlobals();
    expect(user().passwordReset).toBeDefined();
    await expect(completePasswordReset(store, token, NEW, "c", { PASSWORD_BREACH_CHECK: "off" })).resolves.toEqual({ email: "vet@cvg.local" });
  });

  it("rejects when the grant is replaced or consumed between the read and the transaction", async () => {
    const { store, issue, patchUser } = setup();
    const token = await issue();
    const original = store.transaction.bind(store);
    vi.spyOn(store, "transaction").mockImplementationOnce(async (operation) => {
      // Another request consumed the grant after this one validated it.
      await patchUser("user-vet", { passwordReset: undefined });
      return original(operation);
    });
    await expect(completePasswordReset(store, token, NEW, "corr")).rejects.toMatchObject({ code: "PASSWORD_RESET_INVALID", message: INVALID_MESSAGE });
    expect(verifyPassword(OLD, store.getState().users.find((user) => user.id === "user-vet")!.passwordHash)).toBe(true);
  });

  it("recognizes the grant expiring inside the transaction", async () => {
    const { store, issue } = setup();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-08T10:00:00.000Z"));
    const token = await issue("user-vet", { PASSWORD_RESET_TTL_MS: String(5 * 60 * 1000) }, Date.now());
    const original = store.transaction.bind(store);
    vi.spyOn(store, "transaction").mockImplementationOnce(async (operation) => {
      vi.setSystemTime(new Date("2026-10-08T10:06:00.000Z"));
      return original(operation);
    });
    await expect(completePasswordReset(store, token, NEW, "corr")).rejects.toMatchObject({ code: "PASSWORD_RESET_INVALID" });
  });
});

describe("break-glass reset link CLI", () => {
  it("parses --email and rejects missing arguments", () => {
    expect(parseResetLinkArgs(["--email", " Admin@Hospital.example "])).toEqual({ email: "admin@hospital.example" });
    expect(() => parseResetLinkArgs([])).toThrow(/Uso/);
    expect(() => parseResetLinkArgs(["--email"])).toThrow(/Uso/);
    expect(() => parseResetLinkArgs(["--email", "--other"])).toThrow(/Uso/);
  });

  it("issues a link for an active user, replaces a previous grant, revokes sessions and audits as CLI", async () => {
    const { store, issue } = setup();
    await issue();
    await loginUser(store, "vet@cvg.local", OLD);
    const result = await issueResetLinkByEmail(store, " VET@cvg.local ", { APP_ORIGIN: "https://hub.example" });
    expect(result).toMatchObject({ userId: "user-vet", expiresAt: expect.any(String) });
    const token = new URL(result.resetUrl).searchParams.get("token")!;
    const after = store.getState();
    const user = after.users.find((entry) => entry.id === "user-vet")!;
    expect(user.passwordReset).toMatchObject({ tokenHash: hashResetToken(token), issuedBy: "cli" });
    expect(after.sessions.filter((s) => s.userId === "user-vet").every((s) => s.revokedAt)).toBe(true);
    expect(after.auditEvents.at(-1)).toMatchObject({ eventType: "PasswordResetLinkIssued", entityId: "user-vet", metadata: expect.objectContaining({ source: "CLI", replacedPrevious: true }) });
    expect(after.auditEvents.at(-1)?.actorId).toBeUndefined();
    expect(JSON.stringify(after)).not.toContain(token);
    await expect(completePasswordReset(store, token, NEW, "c")).resolves.toEqual({ email: "vet@cvg.local" });
  });

  it("fails for unknown or inactive users without changing state", async () => {
    const { store, patchUser } = setup();
    await patchUser("user-vet", { active: false });
    const before = store.getState();
    await expect(issueResetLinkByEmail(store, "vet@cvg.local")).rejects.toThrow(/PASSWORD_RESET_USER_NOT_FOUND/);
    await expect(issueResetLinkByEmail(store, "nobody@cvg.local")).rejects.toThrow(/PASSWORD_RESET_USER_NOT_FOUND/);
    expect(store.getState()).toEqual(before);
  });
});
