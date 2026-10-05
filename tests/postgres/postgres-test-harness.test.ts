import { describe, expect, it } from "vitest";
import { validatePostgresIntegrationEnvironment } from "../support/postgres-test-harness";

describe("disposable PostgreSQL harness guardrails", () => {
  it("fails closed unless the explicit integration-test authorization is true", () => {
    expect(() => validatePostgresIntegrationEnvironment({
      ALLOW_POSTGRES_INTEGRATION_TESTS: "false",
      POSTGRES_TEST_ADMIN_URL: "postgresql://test:test@127.0.0.1:5432/postgres"
    })).toThrow("ALLOW_POSTGRES_INTEGRATION_TESTS=true");
  });

  it("fails closed when the dedicated admin URL is absent", () => {
    expect(() => validatePostgresIntegrationEnvironment({
      ALLOW_POSTGRES_INTEGRATION_TESTS: "true"
    })).toThrow("POSTGRES_TEST_ADMIN_URL");
  });

  it("rejects non-loopback PostgreSQL hosts", () => {
    expect(() => validatePostgresIntegrationEnvironment({
      ALLOW_POSTGRES_INTEGRATION_TESTS: "true",
      POSTGRES_TEST_ADMIN_URL: "postgresql://test:test@db.example.test:5432/postgres"
    })).toThrow("loopback");
  });

  it.each([
    "host=db.example.test",
    "%68ost=db.example.test",
    "host=%2Ftmp%2Fpostgres",
    "port=6543",
    "sslcert=%2Fprivate%2Fcertificate",
    "application_name=unexpected"
  ])("rejects driver query overrides before opening any connection: %s", (query) => {
    expect(() => validatePostgresIntegrationEnvironment({
      ALLOW_POSTGRES_INTEGRATION_TESTS: "true",
      POSTGRES_TEST_ADMIN_URL: `postgresql://test:test@127.0.0.1:5432/postgres?${query}`
    })).toThrow("must not contain query parameters");
  });

  it.each([
    "postgresql://test:test@127.0.0.1:5432/postgres",
    "postgres://test:test@localhost:5432/postgres",
    "postgresql://test:test@[::1]:5432/postgres"
  ])("accepts a dedicated loopback PostgreSQL URL", (adminUrl) => {
    const validated = validatePostgresIntegrationEnvironment({
      ALLOW_POSTGRES_INTEGRATION_TESTS: "true",
      POSTGRES_TEST_ADMIN_URL: adminUrl
    });

    expect(validated.hostname).toBeTruthy();
  });
});
