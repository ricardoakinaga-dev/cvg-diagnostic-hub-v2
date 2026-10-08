import { afterEach, describe, expect, it, vi } from "vitest";
import { verifyPassword } from "../security/password";
import { MemoryStore } from "./memory-store";
import { createProductionBootstrap, createProductionBootstrapState } from "./production-bootstrap";
import { completePasswordReset, hashResetToken } from "../security/password-reset";
import { loginUser } from "../security/session";

const VALID = {
  email: " Admin@Hospital.Example.org ",
  displayName: "Administração",
  password: "root-of-trust-2026-unique"
};

describe("createProductionBootstrapState", () => {
  it("creates a clinical-empty state with a single hashed ADMIN and a bootstrap audit event", () => {
    const state = createProductionBootstrapState(VALID, new Date("2026-10-01T00:00:00.000Z"));

    expect(state.users).toHaveLength(1);
    const [admin] = state.users;
    expect(admin).toMatchObject({ email: "admin@hospital.example.org", role: "ADMIN", departmentCode: "IT", active: true, version: 1 });
    expect(admin.passwordHash).not.toContain(VALID.password);
    expect(verifyPassword(VALID.password, admin.passwordHash)).toBe(true);
    for (const key of ["patients", "encounters", "services", "reasonCodes", "requests", "results", "sessions", "outbox"] as const) {
      expect(state[key]).toEqual([]);
    }
    expect(state.auditEvents).toEqual([
      expect.objectContaining({ eventType: "ProductionBootstrap", entityId: admin.id, occurredAt: "2026-10-01T00:00:00.000Z" })
    ]);
  });

  it("produces a state the runtime can authenticate against", async () => {
    const store = new MemoryStore(createProductionBootstrapState(VALID));
    const login = await loginUser(store, "admin@hospital.example.org", VALID.password);
    expect(login.sessionToken).toBeTruthy();
  });

  it("forces the first password change when the bootstrap password is used (PROD-202)", () => {
    const [admin] = createProductionBootstrapState(VALID).users;
    expect(admin.mustChangePassword).toBe(true);
    expect(admin.passwordReset).toBeUndefined();
  });

  it.each([
    ["short password", { ...VALID, password: "short1" }],
    ["password without digits", { ...VALID, password: "only-letters-password-here" }],
    ["placeholder password", { ...VALID, password: "replace-with-1234567890" }],
    ["common or sequential password", { ...VALID, password: "Password1234567890" }],
    ["password containing the e-mail local part", { ...VALID, password: "xx-admin-Lua-48-cavalo-azul" }],
    ["invalid email", { ...VALID, email: "not-an-email" }],
    ["empty name", { ...VALID, displayName: "  " }],
    ["invalid department", { ...VALID, departmentCode: "bad dept!" }],
    ["invalid timezone", { ...VALID, timezone: "Mars/Olympus" }]
  ])("rejects %s", (_label, input) => {
    expect(() => createProductionBootstrapState(input)).toThrow(/BOOTSTRAP_ADMIN_/);
  });
});

describe("createProductionBootstrap without BOOTSTRAP_ADMIN_PASSWORD (PROD-202)", () => {
  afterEach(() => vi.unstubAllEnvs());
  const NO_PASSWORD = { email: "admin@hospital.example.org", displayName: "Administração", password: "" };

  it("creates the ADMIN with an unusable random password and a one-time reset link", async () => {
    vi.stubEnv("APP_ORIGIN", "https://hub.hospital.example");
    const { state, reset } = createProductionBootstrap(NO_PASSWORD, new Date("2026-10-08T10:00:00.000Z"));
    const [admin] = state.users;

    expect(reset?.resetUrl).toMatch(/^https:\/\/hub\.hospital\.example\/reset-password\?token=[A-Za-z0-9_-]{43}$/);
    expect(reset?.expiresAt).toBe("2026-10-08T11:00:00.000Z");
    const token = new URL(reset!.resetUrl).searchParams.get("token")!;
    expect(admin).toMatchObject({ mustChangePassword: true, role: "ADMIN", passwordReset: { tokenHash: hashResetToken(token), expiresAt: reset!.expiresAt, issuedBy: "bootstrap" } });
    expect(JSON.stringify(state)).not.toContain(token);
    await expect(loginUser(new MemoryStore(state), NO_PASSWORD.email, "")).rejects.toMatchObject({ status: 401 });
    expect(state.auditEvents.map((event) => event.eventType)).toEqual(["ProductionBootstrap", "PasswordResetLinkIssued"]);
    expect(JSON.stringify(state.auditEvents)).not.toContain(token);
  });

  it("lets the first login happen through the link and clears the forced change", async () => {
    const { state, reset } = createProductionBootstrap(NO_PASSWORD);
    const store = new MemoryStore(state);
    const token = new URL(reset!.resetUrl, "http://x").searchParams.get("token")!;
    await completePasswordReset(store, token, "Cavalo-azul-Lua-48-xk", "corr-bootstrap");
    const login = await loginUser(store, NO_PASSWORD.email, "Cavalo-azul-Lua-48-xk");
    expect(login.user.mustChangePassword).toBe(false);
    expect(login.user).not.toHaveProperty("passwordReset");
  });

  it("does not issue a link when a password is provided", () => {
    expect(createProductionBootstrap(VALID).reset).toBeUndefined();
  });
});
