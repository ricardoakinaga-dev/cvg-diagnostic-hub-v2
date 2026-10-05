import { afterEach, describe, expect, it, vi } from "vitest";
import {
  administrativeResetAuditEvent,
  assertAdministrativeResetAuthorized,
  assertInitializationAuthorized,
  stateForAdministrativeReset,
  type DatabaseOperationAuthorization
} from "./postgres-administration";
import { createDemoState } from "./fixtures";

const base = createDemoState("postgres-administration-focused-password");
const smokeUrl = "postgres://test:test@127.0.0.1/cvg_smoke_local";

afterEach(() => vi.unstubAllEnvs());

describe("PostgreSQL administrative policy", () => {
  it.each([
    ["ALLOW_SYNTHETIC_SEED", "postgresql://test@localhost/cvg_diagnostics"],
    ["ALLOW_DB_SMOKE_RESET", "postgres://test@127.0.0.1/cvg_test_reset"],
    ["ALLOW_POSTGRES_INTEGRATION_TESTS", `postgres://test@[::1]/cvg_test_17_${"a".repeat(32)}`]
  ] as const)("permits initialization only with matching opt-in: %s", (authorization, url) => {
    vi.stubEnv(authorization, "true");
    expect(() => assertInitializationAuthorized(url, authorization)).not.toThrow();
  });

  it("requires both an allowed authorization and its environment opt-in", () => {
    expect(() => assertInitializationAuthorized(smokeUrl, undefined)).toThrow("POSTGRES_INITIALIZATION_REQUIRES_AUTHORIZATION");
    expect(() => assertAdministrativeResetAuthorized(smokeUrl, undefined)).toThrow("POSTGRES_ADMIN_RESET_REQUIRES_AUTHORIZATION");
    expect(() => assertInitializationAuthorized(smokeUrl, "UNSUPPORTED" as DatabaseOperationAuthorization)).toThrow("POSTGRES_INITIALIZATION_REQUIRES_AUTHORIZATION");
    expect(() => assertAdministrativeResetAuthorized(smokeUrl, "ALLOW_DB_SMOKE_RESET")).toThrow("POSTGRES_ADMIN_RESET_REQUIRES_AUTHORIZATION");
    vi.stubEnv("ALLOW_POSTGRES_INTEGRATION_TESTS", "true");
    expect(() => assertAdministrativeResetAuthorized(smokeUrl, "ALLOW_POSTGRES_INTEGRATION_TESTS" as "ALLOW_DB_SMOKE_RESET")).toThrow("POSTGRES_ADMIN_RESET_REQUIRES_AUTHORIZATION");
  });

  it("forbids initialization and reset in production even with explicit opt-in", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("ALLOW_DB_SMOKE_RESET", "true");
    expect(() => assertInitializationAuthorized(smokeUrl, "ALLOW_DB_SMOKE_RESET")).toThrow("POSTGRES_INITIALIZATION_FORBIDDEN_IN_PRODUCTION");
    expect(() => assertAdministrativeResetAuthorized(smokeUrl, "ALLOW_DB_SMOKE_RESET")).toThrow("POSTGRES_ADMIN_RESET_FORBIDDEN_IN_PRODUCTION");
  });

  it.each([
    "invalid connection string",
    "https://localhost/cvg_smoke_local",
    "postgres://remote.invalid/cvg_smoke_local",
    "postgres://localhost/production",
    "postgres://localhost/cvg_diagnostics"
  ])("rejects a reset target outside the smoke boundary: %s", (url) => {
    vi.stubEnv("ALLOW_DB_SMOKE_RESET", "true");
    expect(() => assertAdministrativeResetAuthorized(url, "ALLOW_DB_SMOKE_RESET")).toThrow("POSTGRES_ADMIN_RESET_TARGET_NOT_ALLOWED");
  });

  it("requires the integration database's disposable name pattern", () => {
    vi.stubEnv("ALLOW_POSTGRES_INTEGRATION_TESTS", "true");
    expect(() => assertInitializationAuthorized("postgres://localhost/cvg_test_shared", "ALLOW_POSTGRES_INTEGRATION_TESTS")).toThrow("POSTGRES_INITIALIZATION_TARGET_NOT_ALLOWED");
  });

  it("preserves malformed URI decoding errors", () => {
    vi.stubEnv("ALLOW_DB_SMOKE_RESET", "true");
    expect(() => assertAdministrativeResetAuthorized("postgres://localhost/%xx", "ALLOW_DB_SMOKE_RESET")).toThrow(URIError);
  });

  it("records only the authorized target metadata with distinct audit identifiers", () => {
    vi.stubEnv("ALLOW_SYNTHETIC_SEED", "true");
    const target = assertAdministrativeResetAuthorized("postgresql://secret:password@LOCALHOST/cvg_%73eed", "ALLOW_SYNTHETIC_SEED");
    const first = administrativeResetAuditEvent(target);
    const second = administrativeResetAuditEvent(target);
    expect(first).toMatchObject({
      eventType: "PostgresAdministrativeReset", entityType: "RuntimeState",
      previousState: "ACTIVE", newState: "RESET",
      metadata: { authorization: "ALLOW_SYNTHETIC_SEED", databaseHost: "localhost", databaseName: "cvg_seed" }
    });
    expect(first.id).not.toBe(second.id);
    expect(first.correlationId).not.toBe(second.correlationId);
    expect(first.actorId).toBeUndefined();
    expect(Number.isFinite(Date.parse(first.occurredAt))).toBe(true);
    expect(JSON.stringify(first)).not.toMatch(/secret|password/);
  });

  it("keeps prior audit history and appends only new target events and the reset record", () => {
    const event = administrativeResetAuditEvent({ authorization: "ALLOW_DB_SMOKE_RESET", databaseHost: "localhost", databaseName: "cvg_test_reset" });
    const prior = { ...event, id: "audit-before" };
    const added = { ...event, id: "audit-target" };
    const before = { ...base, auditEvents: [prior] };
    const target = { ...base, auditEvents: [structuredClone(prior), added] };
    expect(stateForAdministrativeReset(before, target, event).auditEvents).toEqual([prior, added, event]);
    expect(stateForAdministrativeReset(before, { ...target, auditEvents: [] }, event).auditEvents).toEqual([prior, event]);
    expect(before.auditEvents).toEqual([prior]);
    expect(target.auditEvents).toEqual([prior, added]);
    expect(() => stateForAdministrativeReset(before, { ...target, auditEvents: [added, added] }, event)).toThrow("POSTGRES_AUDIT_LOG_MUTATION");
    expect(() => stateForAdministrativeReset(before, { ...target, auditEvents: [{ ...prior, newState: "ALTERED" }] }, event)).toThrow("POSTGRES_AUDIT_LOG_MUTATION");
  });
});
