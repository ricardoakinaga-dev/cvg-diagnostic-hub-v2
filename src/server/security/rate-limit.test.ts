import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";

const pool = vi.hoisted(() => ({
  query: vi.fn(),
  on: vi.fn(),
  end: vi.fn(),
  options: [] as unknown[]
}));

vi.mock("pg", () => ({
  Pool: class MockPool {
    constructor(options: unknown) {
      pool.options.push(options);
    }

    query = pool.query;
    on = pool.on;
    end = pool.end;
  }
}));

import { assertRateLimit, assertRateLimitConfiguration, closeRateLimitBackend, resetRateLimits } from "./rate-limit";

describe("API rate limiter", () => {
  beforeEach(() => {
    resetRateLimits();
    pool.query.mockReset();
    pool.on.mockReset();
    pool.end.mockReset().mockResolvedValue(undefined);
    pool.options.length = 0;
  });
  afterEach(async () => {
    await closeRateLimitBackend();
    vi.unstubAllEnvs();
  });

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

  it("rejects malformed shared-backend configuration before opening a pool", () => {
    expect(() => assertRateLimitConfiguration({ RATE_LIMIT_MODE: "postgres", DATABASE_URL: "https://db.example/cvg" })).toThrow(/URL PostgreSQL/i);
    expect(() => assertRateLimitConfiguration({ RATE_LIMIT_MODE: "postgres", DATABASE_URL: "postgresql://db.example/cvg", RATE_LIMIT_DB_POOL_MAX: "0" })).toThrow(/inteiro positivo/i);
    expect(() => assertRateLimitConfiguration({ RATE_LIMIT_MODE: "postgres", DATABASE_URL: "postgresql://db.example/cvg", RATE_LIMIT_DB_POOL_MAX: "101" })).toThrow(/entre 1 e 100/i);
  });

  it("uses one atomic PostgreSQL bucket and reports the remaining window", async () => {
    vi.stubEnv("RATE_LIMIT_MODE", "postgres");
    vi.stubEnv("DATABASE_URL", "postgresql://rate-limit.test/cvg");
    vi.stubEnv("RATE_LIMIT_DB_POOL_MAX", "2");
    pool.query.mockResolvedValueOnce({ rows: [{ request_count: 3, reset_at: 1_100, allowed: false }] });

    await expect(assertRateLimit("client-a:login", 2, 1_000, 100)).rejects.toMatchObject({
      code: "RATE_LIMITED",
      status: 429,
      details: { retryAfterMs: 1_000 }
    });

    expect(pool.options).toEqual([{ connectionString: "postgresql://rate-limit.test/cvg", max: 2, idleTimeoutMillis: 30_000 }]);
    expect(pool.on).toHaveBeenCalledWith("error", expect.any(Function));
    expect(pool.query).toHaveBeenCalledWith(
      expect.stringMatching(/ON CONFLICT \(bucket_key\)[\s\S]*RETURNING request_count[\s\S]*window_started_at \+ \(\$3 \* interval '1 millisecond'\)/),
      ["client-a:login", new Date(100), 1_000, 2]
    );
  });

  it("fails closed when the shared PostgreSQL backend is unavailable", async () => {
    vi.stubEnv("RATE_LIMIT_MODE", "postgres");
    vi.stubEnv("DATABASE_URL", "postgresql://rate-limit.test/cvg");
    pool.query.mockRejectedValueOnce(new Error("connection refused"));

    await expect(assertRateLimit("client-a:login", 2, 1_000, 100)).rejects.toMatchObject({
      code: "DEPENDENCY_UNAVAILABLE",
      status: 503,
      details: { retryable: true }
    });
    await expect(assertRateLimit("client-a:login", 2, 1_000, 100)).rejects.toMatchObject({
      code: "DEPENDENCY_UNAVAILABLE",
      status: 503
    });
    expect(pool.query).toHaveBeenCalledTimes(2);
  });
});
