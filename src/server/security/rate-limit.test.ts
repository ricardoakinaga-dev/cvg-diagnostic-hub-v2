import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { assertRateLimit, assertRateLimitConfiguration, resetRateLimits } from "./rate-limit";

describe("API rate limiter", () => {
  beforeEach(() => resetRateLimits());
  afterEach(() => vi.unstubAllEnvs());

  it("blocks a burst and opens a new fixed window", async () => {
    await assertRateLimit("test-client", 2, 1_000, 100);
    await assertRateLimit("test-client", 2, 1_000, 100);
    await expect(assertRateLimit("test-client", 2, 1_000, 100)).rejects.toMatchObject({ code: "RATE_LIMITED", status: 429 });
    await expect(assertRateLimit("test-client", 2, 1_000, 1_101)).resolves.toBeUndefined();
  });

  it("fails closed instead of using process-local buckets in production", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("RATE_LIMIT_MODE", "memory");
    await expect(assertRateLimit("production-client", 1, 1_000)).rejects.toThrow(/memory.*produção/i);
  });

  it("requires the shared PostgreSQL backend when distributed mode is selected", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("RATE_LIMIT_MODE", "postgres");
    vi.stubEnv("DATABASE_URL", undefined);
    await expect(assertRateLimit("production-client", 1, 1_000)).rejects.toThrow(/DATABASE_URL/);
  });

  it("validates the readiness configuration without consuming a bucket", () => {
    expect(assertRateLimitConfiguration({ NODE_ENV: "development", RATE_LIMIT_MODE: "memory" })).toBe("memory");
    expect(assertRateLimitConfiguration({ NODE_ENV: "production", RATE_LIMIT_MODE: "postgres", DATABASE_URL: "postgresql://localhost/cvg" })).toBe("postgres");
    expect(() => assertRateLimitConfiguration({ NODE_ENV: "production", RATE_LIMIT_MODE: "memory" })).toThrow(/memory.*produção/i);
  });
});
