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

import {
  assertLoginAttempt,
  assertRateLimit,
  assertRateLimitConfiguration,
  closeRateLimitBackend,
  loginAttemptKey,
  loginBackoffMultiplier,
  loginBackoffWindowMs,
  pruneRateLimitBuckets,
  rateLimitBucketRetentionMs,
  registerLoginFailure,
  registerLoginSuccess,
  resetRateLimits
} from "./rate-limit";
import { runtimePoolTimeouts } from "../domain/database-timeouts";

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

    expect(pool.options).toEqual([{ connectionString: "postgresql://rate-limit.test/cvg", max: 2, idleTimeoutMillis: 30_000, ...runtimePoolTimeouts() }]);
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

  it("scopes the login budget to the credential pair, not to the account", async () => {
    vi.stubEnv("RATE_LIMIT_MODE", "memory");

    expect(() => loginAttemptKey({ email: " Vet@CVG.local ", clientKey: " " })).toThrow(/controle de abuso/);
    expect(loginAttemptKey({ email: "vet@cvg.local", clientKey: "198.51.100.7" }))
      .toBe('login-account:["vet@cvg.local","198.51.100.7"]');

    // Exhausting the attacker pair leaves the owner pair untouched.
    for (let attempt = 0; attempt < 2; attempt += 1) {
      await assertLoginAttempt({ email: "vet@cvg.local", clientKey: "198.51.100.7" }, { limit: 2, windowMs: 1_000 }, 100);
    }
    await expect(assertLoginAttempt({ email: "vet@cvg.local", clientKey: "198.51.100.7" }, { limit: 2, windowMs: 1_000 }, 100))
      .rejects.toMatchObject({ code: "RATE_LIMITED", status: 429 });
    await expect(assertLoginAttempt({ email: "vet@cvg.local", clientKey: "203.0.113.9" }, { limit: 2, windowMs: 1_000 }, 100))
      .resolves.toBeUndefined();
  });

  it("grows the pair window with recent wrong passwords and clears it on success", async () => {
    vi.stubEnv("RATE_LIMIT_MODE", "memory");

    expect(loginBackoffMultiplier(0)).toBe(1);
    expect(loginBackoffMultiplier(5)).toBe(2);
    expect(loginBackoffMultiplier(10)).toBe(4);
    expect(loginBackoffMultiplier(50)).toBe(16);
    expect(loginBackoffMultiplier(-3)).toBe(1);
    expect(loginBackoffWindowMs(60_000, 0)).toBe(60_000);
    expect(loginBackoffWindowMs(60_000, 10)).toBe(240_000);
    // The window is capped so one account can never reserve a bucket forever.
    expect(loginBackoffWindowMs(60_000, 10_000)).toBe(60_000 * 16);

    for (let attempt = 0; attempt < 6; attempt += 1) {
      await registerLoginFailure({ email: "vet@cvg.local", clientKey: "198.51.100.7" }, 100 + attempt);
    }
    // Two attempts fit the base window, then the doubled window applies.
    await assertLoginAttempt({ email: "vet@cvg.local", clientKey: "198.51.100.7" }, { limit: 2, windowMs: 1_000 }, 200);
    await assertLoginAttempt({ email: "vet@cvg.local", clientKey: "198.51.100.7" }, { limit: 2, windowMs: 1_000 }, 300);
    await expect(assertLoginAttempt({ email: "vet@cvg.local", clientKey: "198.51.100.7" }, { limit: 2, windowMs: 1_000 }, 400))
      .rejects.toMatchObject({ code: "RATE_LIMITED" });
    // Another pair retains the base window.
    await expect(assertLoginAttempt({ email: "vet@cvg.local", clientKey: "203.0.113.9" }, { limit: 2, windowMs: 1_000 }, 500))
      .resolves.toBeUndefined();

    // A successful login clears only its pair backoff, so a pair starting now
    // gets the base window again. The already-open pair bucket still has to
    // expire on its own: success is not a licence to skip the per-pair window.
    await registerLoginSuccess({ email: "vet@cvg.local", clientKey: "198.51.100.7" });
    await assertLoginAttempt({ email: "vet@cvg.local", clientKey: "203.0.113.10" }, { limit: 2, windowMs: 1_000 }, 700);
    await assertLoginAttempt({ email: "vet@cvg.local", clientKey: "203.0.113.10" }, { limit: 2, windowMs: 1_000 }, 800);
    await expect(assertLoginAttempt({ email: "vet@cvg.local", clientKey: "203.0.113.10" }, { limit: 2, windowMs: 1_000 }, 900))
      .rejects.toMatchObject({ code: "RATE_LIMITED" });
    await expect(assertLoginAttempt({ email: "vet@cvg.local", clientKey: "198.51.100.7" }, { limit: 2, windowMs: 1_000 }, 5_000))
      .resolves.toBeUndefined();
  });

  it("keeps login backoff counters in the shared backend when distributed mode is selected", async () => {
    vi.stubEnv("RATE_LIMIT_MODE", "postgres");
    vi.stubEnv("DATABASE_URL", "postgresql://rate-limit.test/cvg");
    pool.query.mockResolvedValue({ rows: [{ request_count: 4, reset_at: 1_000, allowed: true }] });

    await registerLoginFailure({ email: "vet@cvg.local", clientKey: "198.51.100.7" }, 100);
    await registerLoginSuccess({ email: "vet@cvg.local", clientKey: "198.51.100.7" });

    expect(pool.query).toHaveBeenCalledTimes(2);
    expect(pool.query.mock.calls[0][0]).toMatch(/INSERT INTO rate_limit_buckets/);
    expect(pool.query.mock.calls[0][1]).toEqual(['login-failures:login-account:["vet@cvg.local","198.51.100.7"]', new Date(100), 900_000, expect.any(Number)]);
    expect(pool.query.mock.calls[1]).toEqual(["DELETE FROM rate_limit_buckets WHERE bucket_key = $1", ['login-failures:login-account:["vet@cvg.local","198.51.100.7"]']]);

    pool.query.mockRejectedValueOnce(new Error("connection refused"));
    await expect(registerLoginFailure({ email: "vet@cvg.local", clientKey: "198.51.100.7" }, 100)).rejects.toMatchObject({
      code: "DEPENDENCY_UNAVAILABLE",
      status: 503
    });
  });

  it("reads PostgreSQL failures without consuming them and doubles only after five failures", async () => {
    vi.stubEnv("RATE_LIMIT_MODE", "postgres");
    vi.stubEnv("DATABASE_URL", "postgresql://rate-limit.test/cvg");
    const identity = { email: "vet@cvg.local", clientKey: "client" };
    for (const failures of [0, 4, 5]) {
      pool.query.mockResolvedValueOnce({ rows: failures ? [{ request_count: failures }] : [] });
      pool.query.mockResolvedValueOnce({ rows: [{ request_count: 1, reset_at: 5_000, allowed: true }] });
      await assertLoginAttempt(identity, { limit: 10, windowMs: 1_000 }, 100);
      expect(pool.query.mock.calls.at(-2)?.[0]).toMatch(/^SELECT request_count/);
      expect(pool.query.mock.calls.at(-1)?.[1][2]).toBe(failures === 5 ? 2_000 : 1_000);
    }
  });

  it("does not let an attacker's failures extend the victim's window", async () => {
    vi.stubEnv("RATE_LIMIT_MODE", "memory");
    const attacker = { email: "vet@cvg.local", clientKey: "attacker" };
    const victim = { email: "vet@cvg.local", clientKey: "victim" };
    for (let index = 0; index < 20; index += 1) await registerLoginFailure(attacker, 100);
    await assertLoginAttempt(victim, { limit: 1, windowMs: 1_000 }, 100);
    await expect(assertLoginAttempt(victim, { limit: 1, windowMs: 1_000 }, 1_100)).resolves.toBeUndefined();
    await assertLoginAttempt(attacker, { limit: 1, windowMs: 1_000 }, 100);
    await registerLoginSuccess(victim);
    await expect(assertLoginAttempt(attacker, { limit: 1, windowMs: 1_000 }, 1_100)).rejects.toMatchObject({ code: "RATE_LIMITED" });
  });

  it("extends an already-open memory budget after exactly five failures", async () => {
    vi.stubEnv("RATE_LIMIT_MODE", "memory");
    const identity = { email: "vet@cvg.local", clientKey: "client" };
    const limits = { limit: 1, windowMs: 1_000 };
    await assertLoginAttempt(identity, limits, 100);
    for (let count = 0; count < 4; count += 1) await registerLoginFailure(identity, 100);
    await expect(assertLoginAttempt(identity, limits, 1_100)).resolves.toBeUndefined();
    await registerLoginFailure(identity, 1_100);
    await expect(assertLoginAttempt(identity, limits, 2_100)).rejects.toMatchObject({ code: "RATE_LIMITED" });
    await expect(assertLoginAttempt(identity, limits, 3_100)).resolves.toBeUndefined();
  });

  it("rejects ambiguous or missing client identity instead of sharing an anonymous bucket", () => {
    expect(() => loginAttemptKey({ email: "vet@cvg.local", clientKey: "" })).toThrow();
    expect(loginAttemptKey({ email: "a:b", clientKey: "c" })).not.toBe(loginAttemptKey({ email: "a", clientKey: "b:c" }));
    expect(loginAttemptKey({ email: " Vet@CVG.local ", clientKey: " client " })).toBe(loginAttemptKey({ email: "vet@cvg.local", clientKey: "client" }));
  });

  it("fails closed on PostgreSQL failure reads, malformed counters and failed resets", async () => {
    vi.stubEnv("RATE_LIMIT_MODE", "postgres");
    vi.stubEnv("DATABASE_URL", "postgresql://rate-limit.test/cvg");
    const identity = { email: "vet@cvg.local", clientKey: "client" };
    for (const response of [{ rows: [{ request_count: -1 }] }, { rows: [{ request_count: "NaN" }] }]) {
      pool.query.mockResolvedValueOnce(response);
      await expect(assertLoginAttempt(identity, { limit: 10, windowMs: 1_000 })).rejects.toMatchObject({ code: "DEPENDENCY_UNAVAILABLE" });
    }
    pool.query.mockRejectedValueOnce(new Error("unavailable"));
    await expect(assertLoginAttempt(identity, { limit: 10, windowMs: 1_000 })).rejects.toMatchObject({ code: "DEPENDENCY_UNAVAILABLE" });
    pool.query.mockRejectedValueOnce(new Error("unavailable"));
    await expect(registerLoginSuccess(identity)).rejects.toMatchObject({ code: "DEPENDENCY_UNAVAILABLE" });
  });
});

describe("rate limit bucket retention", () => {
  beforeEach(() => { resetRateLimits(); pool.query.mockReset(); });
  afterEach(() => { vi.unstubAllEnvs(); });

  it("never retains less than the longest window a bucket can have", () => {
    expect(rateLimitBucketRetentionMs({})).toBe(2 * 60 * 60 * 1000);
    expect(rateLimitBucketRetentionMs({ RATE_LIMIT_BUCKET_RETENTION_MS: "600000" })).toBe(60 * 60 * 1000 + 60_000);
    expect(rateLimitBucketRetentionMs({ RATE_LIMIT_BUCKET_RETENTION_MS: "-5" })).toBe(2 * 60 * 60 * 1000);
    expect(rateLimitBucketRetentionMs({ RATE_LIMIT_BUCKET_RETENTION_MS: "86400000" })).toBe(86_400_000);
  });

  it("removes only buckets whose window ended before the cutoff (memory mode)", async () => {
    vi.stubEnv("RATE_LIMIT_MODE", "memory");
    const now = 10_000_000_000;
    await assertRateLimit("old", 5, 60_000, now - 3 * 60 * 60 * 1000);
    await assertRateLimit("recent", 5, 60_000, now - 30 * 60 * 1000);
    expect(await pruneRateLimitBuckets(now)).toBe(1);
    expect(await pruneRateLimitBuckets(now)).toBe(0);
    // The recent bucket survives and still counts.
    await expect(assertRateLimit("recent", 1, 60_000, now - 30 * 60 * 1000 + 1)).rejects.toMatchObject({ code: "RATE_LIMITED" });
  });

  it("deletes by window start in PostgreSQL mode and reports the count, failing closed when the database is down", async () => {
    vi.stubEnv("RATE_LIMIT_MODE", "postgres");
    vi.stubEnv("DATABASE_URL", "postgresql://runtime:secret@127.0.0.1:5432/cvg");
    pool.query.mockResolvedValueOnce({ rowCount: 7, rows: [] });
    expect(await pruneRateLimitBuckets(1_000_000_000_000, 7_200_000)).toBe(7);
    const [sql, values] = pool.query.mock.calls[0]!;
    expect(sql).toContain("DELETE FROM rate_limit_buckets WHERE window_started_at < $1");
    expect((values[0] as Date).getTime()).toBe(1_000_000_000_000 - 7_200_000);
    pool.query.mockRejectedValueOnce(new Error("connection refused"));
    await expect(pruneRateLimitBuckets(1_000_000_000_000)).rejects.toMatchObject({ code: "DEPENDENCY_UNAVAILABLE" });
    await closeRateLimitBackend();
  });
});
