import { describe, expect, it } from "vitest";
import { createDemoState, passwordFingerprint } from "./fixtures";



describe("synthetic fixture guards", () => {
  it("fingerprints a password without keeping the secret", () => {
    const fingerprint = passwordFingerprint("fixture-password");

    expect(fingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(fingerprint).not.toContain("fixture-password");
    expect(passwordFingerprint("fixture-password")).toBe(fingerprint);
  });

  it("generates a distinct random demo password per user when none is supplied", () => {
    const environment = process.env as Record<string, string | undefined>;
    const previous = environment.DEMO_PASSWORD;
    try {
      delete environment.DEMO_PASSWORD;
      const state = createDemoState(undefined);
      const fingerprints = state.users.map((user) => passwordFingerprint(user.passwordHash));
      expect(new Set(fingerprints).size).toBeGreaterThan(1);
    } finally {
      if (previous === undefined) delete environment.DEMO_PASSWORD;
      else environment.DEMO_PASSWORD = previous;
    }
  });

  it("refuses synthetic data in production and placeholder passwords elsewhere", () => {
    const environment = process.env as Record<string, string | undefined>;
    const previous = environment.DEMO_PASSWORD;
    const previousNodeEnv = environment.NODE_ENV;
    try {
      delete process.env.DEMO_PASSWORD;
      environment.NODE_ENV = "production";
      expect(() => createDemoState("production-demo-password")).toThrow(/proibidas em produção/);

      environment.NODE_ENV = "development";
      // A placeholder or short password is refused outside the test lane, so a
      // deployment cannot inherit a documented demo secret.
      expect(() => createDemoState("short")).toThrow(/DEMO_PASSWORD/);
      expect(() => createDemoState("local-demo-password-but-long-enough")).toThrow(/DEMO_PASSWORD/);
      expect(() => createDemoState("<configure-me>")).toThrow(/DEMO_PASSWORD/);
      environment.DEMO_PASSWORD = "a-long-enough-demo-password";
      expect(createDemoState(undefined).users.length).toBeGreaterThan(0);
    } finally {
      if (previous === undefined) delete environment.DEMO_PASSWORD;
      else environment.DEMO_PASSWORD = previous;
      if (previousNodeEnv === undefined) delete environment.NODE_ENV;
      else environment.NODE_ENV = previousNodeEnv;
    }
  });
});
