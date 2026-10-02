import { describe, expect, it } from "vitest";
import { verifyPassword } from "../security/password";
import { MemoryStore } from "./memory-store";
import { createProductionBootstrapState } from "./production-bootstrap";
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

  it.each([
    ["short password", { ...VALID, password: "short1" }],
    ["password without digits", { ...VALID, password: "only-letters-password-here" }],
    ["placeholder password", { ...VALID, password: "replace-with-1234567890" }],
    ["invalid email", { ...VALID, email: "not-an-email" }],
    ["empty name", { ...VALID, displayName: "  " }],
    ["invalid department", { ...VALID, departmentCode: "bad dept!" }],
    ["invalid timezone", { ...VALID, timezone: "Mars/Olympus" }]
  ])("rejects %s", (_label, input) => {
    expect(() => createProductionBootstrapState(input)).toThrow(/BOOTSTRAP_ADMIN_/);
  });
});
