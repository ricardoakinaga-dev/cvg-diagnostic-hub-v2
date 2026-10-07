import { afterEach, describe, expect, it, vi } from "vitest";
import type { StateStore } from "../domain/models";
import { verifyPassword } from "../security/password";
import { closeRuntimeStore, getRuntimeReadiness, getRuntimeStore } from "./runtime";

describe.sequential("runtime production bootstrap security", () => {
  afterEach(() => {
    delete globalThis.__cvgDiagnosticsStore;
    delete globalThis.__cvgDiagnosticsStorePromise;
    delete globalThis.__cvgDiagnosticsFileStore;
    vi.unstubAllEnvs();
  });

  it("fails closed without data-mode configuration instead of creating a known demo administrator", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("APP_DATA_MODE", undefined);
    vi.stubEnv("DEMO_PASSWORD", undefined);
    delete globalThis.__cvgDiagnosticsStore;
    delete globalThis.__cvgDiagnosticsStorePromise;
    let bootstrappedStore: StateStore | undefined;
    let bootstrapError: unknown;

    try {
      bootstrappedStore = getRuntimeStore();
    } catch (error) {
      bootstrapError = error;
    }

    const admin = bootstrappedStore?.getState().users.find((user) => user.role === "ADMIN");
    const acceptsKnownPassword = admin
      ? verifyPassword("local-demo-password", admin.passwordHash)
      : false;
    expect.soft(bootstrapError).toBeInstanceOf(Error);
    expect.soft(String((bootstrapError as Error | undefined)?.message ?? "")).toMatch(/APP_DATA_MODE|modo de dados|configuração/i);
    expect.soft(bootstrappedStore).toBeUndefined();
    expect.soft(globalThis.__cvgDiagnosticsStore).toBeUndefined();
    expect.soft(acceptsKnownPassword).toBe(false);
  });

  it("rejects the in-memory data mode in production even when explicitly requested", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("APP_DATA_MODE", "memory");
    vi.stubEnv("DEMO_PASSWORD", "explicit-production-password");

    expect(() => getRuntimeStore()).toThrow(/memory.*produção/i);
    expect(globalThis.__cvgDiagnosticsStore).toBeUndefined();
  });

  it.each([
    ["SESSION_SECRET is missing", { SESSION_SECRET: undefined }, /SESSION_SECRET/],
    ["SESSION_SECRET is short", { SESSION_SECRET: "short" }, /SESSION_SECRET/],
    ["the proxy is not trusted", { TRUST_PROXY: "false" }, /TRUST_PROXY/],
    ["the proxy secret is short", { TRUST_PROXY_SHARED_SECRET: "short" }, /TRUST_PROXY/]
  ])("fails production readiness before touching PostgreSQL when %s", async (_label, overrides, message) => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("APP_DATA_MODE", "postgres");
    vi.stubEnv("DATABASE_URL", "postgresql://db.example/cvg");
    vi.stubEnv("SESSION_SECRET", "s".repeat(32));
    vi.stubEnv("TRUST_PROXY", "true");
    vi.stubEnv("TRUST_PROXY_SHARED_SECRET", "p".repeat(32));
    for (const [key, value] of Object.entries(overrides)) vi.stubEnv(key, value);

    await expect(getRuntimeReadiness()).rejects.toThrow(message);
    expect(globalThis.__cvgDiagnosticsStorePromise).toBeUndefined();
  });

  it("fails production PostgreSQL readiness when realtime fan-out is process-local", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("APP_DATA_MODE", "postgres");
    vi.stubEnv("DATABASE_URL", "postgresql://db.example/cvg");
    vi.stubEnv("SESSION_SECRET", "s".repeat(32));
    vi.stubEnv("TRUST_PROXY", "true");
    vi.stubEnv("TRUST_PROXY_SHARED_SECRET", "p".repeat(32));
    vi.stubEnv("REALTIME_NOTIFICATION_ADAPTER", "process-local");

    await expect(getRuntimeReadiness()).rejects.toThrow(/process-local.*produção/i);
    expect(globalThis.__cvgDiagnosticsStore).toBeUndefined();
    expect(globalThis.__cvgDiagnosticsStorePromise).toBeUndefined();
  });

  it("generates isolated synthetic credentials in development without an explicit password", async () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("APP_DATA_MODE", "memory");
    vi.stubEnv("DEMO_PASSWORD", undefined);

    const store = getRuntimeStore();
    const hashes = store.getState().users.map((user) => user.passwordHash);

    expect(new Set(hashes).size).toBe(hashes.length);
    await closeRuntimeStore();
  });

  it("rejects a documented placeholder as the synthetic administrator password", () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("APP_DATA_MODE", "memory");
    vi.stubEnv("DEMO_PASSWORD", "<senha-sintética-única>");

    expect(() => getRuntimeStore()).toThrow(/senha sintética única|DEMO_PASSWORD/i);
    expect(globalThis.__cvgDiagnosticsStore).toBeUndefined();
  });

  it("allows an explicitly configured synthetic development runtime", async () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("APP_DATA_MODE", "memory");
    vi.stubEnv("DEMO_PASSWORD", "explicit-development-password");

    const store = getRuntimeStore();
    const admin = store.getState().users.find((user) => user.role === "ADMIN");

    expect(admin).toBeDefined();
    expect(verifyPassword("explicit-development-password", admin?.passwordHash ?? "")).toBe(true);
    expect(verifyPassword("local-demo-password", admin?.passwordHash ?? "")).toBe(false);
    await closeRuntimeStore();
    expect(globalThis.__cvgDiagnosticsStore).toBeUndefined();
  });
});
