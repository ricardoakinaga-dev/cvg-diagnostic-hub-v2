import { afterEach, describe, expect, it, vi } from "vitest";
import { verifyPassword } from "../security/password";
import { createDemoState } from "./fixtures";

describe("synthetic demo fixtures", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("generates a distinct password for every user without an explicit demo password in development", () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("DEMO_PASSWORD", undefined);

    const state = createDemoState();
    const hashes = state.users.map((user) => user.passwordHash);

    expect(new Set(hashes).size).toBe(state.users.length);
  });

  it("keeps an explicit demo password available for end-to-end fixtures", () => {
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("DEMO_PASSWORD", "e2e-explicit-demo-password");

    const state = createDemoState();

    expect(state.users.every((user) => verifyPassword("e2e-explicit-demo-password", user.passwordHash))).toBe(true);
  });

  it("rejects synthetic fixtures in production even when a password is supplied", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("DEMO_PASSWORD", "production-synthetic-password-123");

    expect(() => createDemoState()).toThrow(/proibidas em produção/i);
    expect(() => createDemoState("production-synthetic-password-123")).toThrow(/proibidas em produção/i);
  });
});
