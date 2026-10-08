import { afterEach, describe, expect, it, vi } from "vitest";
import { assertLoginAttempt, closeRateLimitBackend, loginAttemptKey, registerLoginFailure, registerLoginSuccess } from "../../src/server/security/rate-limit";
import { pseudonymousAccountId, registerAccountLoginFailure } from "../../src/server/security/login-signal";
import { loginUser } from "../../src/server/security/session";
import { createDemoState } from "../../src/server/store/fixtures";
import { withDisposablePostgresDatabase } from "../support/postgres-test-harness";

const password = "postgres-login-regression-password";
const attacker = { email: "vet@cvg.local", clientKey: "198.51.100.7" };
const victim = { email: "vet@cvg.local", clientKey: "203.0.113.9" };
const failureKey = (identity: typeof attacker) => `login-failures:${loginAttemptKey(identity)}`;

afterEach(async () => {
  await closeRateLimitBackend();
  vi.unstubAllEnvs();
});

describe("PostgreSQL login failure backoff", () => {
  it("counts each wrong password once, reads without writes, and resets on a successful login", async () => {
    await withDisposablePostgresDatabase(async (database) => {
      vi.stubEnv("RATE_LIMIT_MODE", "postgres");
      vi.stubEnv("DATABASE_URL", database.connectionString());
      const store = await database.createStore(createDemoState(password));
      const limits = { limit: 20, windowMs: 1_000 };
      const timestamp = Date.now();
      try {
        await assertLoginAttempt(attacker, limits, timestamp);
        expect((await database.query("SELECT request_count FROM rate_limit_buckets WHERE bucket_key = $1", [failureKey(attacker)])).rows).toEqual([]);
        for (let count = 1; count <= 5; count += 1) {
          await assertLoginAttempt(attacker, limits, timestamp);
          await expect(loginUser(store, attacker.email, "wrong-password")).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
          expect(await registerLoginFailure(attacker, timestamp)).toBe(count);
          expect((await database.query("SELECT request_count FROM rate_limit_buckets WHERE bucket_key = $1", [failureKey(attacker)])).rows).toEqual([{ request_count: count }]);
        }
        // Six budget reads did not add any password failure.
        await assertLoginAttempt(attacker, limits, timestamp);
        expect((await database.query("SELECT request_count FROM rate_limit_buckets WHERE bucket_key = $1", [failureKey(attacker)])).rows).toEqual([{ request_count: 5 }]);
        const login = await loginUser(store, attacker.email, password, {
          beforeSessionCreate: () => registerLoginSuccess(attacker)
        });
        expect(login.sessionToken).toEqual(expect.any(String));
        expect((await database.query("SELECT request_count FROM rate_limit_buckets WHERE bucket_key = $1", [failureKey(attacker)])).rows).toEqual([]);
        // Success does not erase the independent attempt budget.
        expect((await database.query("SELECT request_count FROM rate_limit_buckets WHERE bucket_key = $1", [loginAttemptKey(attacker)])).rows).toEqual([{ request_count: 7 }]);
        expect(await registerLoginFailure(attacker, timestamp)).toBe(1);
      } finally {
        await closeRateLimitBackend();
        await database.closeStore(store);
      }
    });
  });

  it("does not create a session if PostgreSQL refuses the successful-login counter reset", async () => {
    await withDisposablePostgresDatabase(async (database) => {
      vi.stubEnv("RATE_LIMIT_MODE", "postgres");
      vi.stubEnv("DATABASE_URL", database.connectionString());
      const store = await database.createStore(createDemoState(password));
      try {
        await registerLoginFailure(attacker);
        const before = await store.readStateSnapshot();
        await database.query(`CREATE FUNCTION reject_failure_reset() RETURNS trigger LANGUAGE plpgsql AS $$
          BEGIN RAISE EXCEPTION 'INJECTED_RESET_FAILURE'; END; $$`);
        await database.query(`CREATE TRIGGER reject_failure_reset BEFORE DELETE ON rate_limit_buckets
          FOR EACH ROW EXECUTE FUNCTION reject_failure_reset()`);
        await expect(loginUser(store, attacker.email, password, {
          beforeSessionCreate: () => registerLoginSuccess(attacker)
        })).rejects.toMatchObject({ code: "DEPENDENCY_UNAVAILABLE", status: 503 });
        expect(await store.readStateSnapshot()).toEqual(before);
        expect((await database.query("SELECT count(*)::int AS count FROM session_activity")).rows).toEqual([{ count: 0 }]);
        expect((await database.query("SELECT request_count FROM rate_limit_buckets WHERE bucket_key = $1", [failureKey(attacker)])).rows).toEqual([{ request_count: 1 }]);
      } finally {
        await closeRateLimitBackend();
        await database.closeStore(store);
      }
    });
  });

  it("starts the doubled window after exactly five errors and leaves other clients at the base window", async () => {
    await withDisposablePostgresDatabase(async (database) => {
      vi.stubEnv("RATE_LIMIT_MODE", "postgres");
      vi.stubEnv("DATABASE_URL", database.connectionString());
      const timestamp = Date.now();
      const limits = { limit: 1, windowMs: 1_000 };
      try {
        for (let count = 0; count < 4; count += 1) await registerLoginFailure(attacker, timestamp);
        await assertLoginAttempt(attacker, limits, timestamp);
        // Four errors still permit the next base window.
        await assertLoginAttempt(attacker, limits, timestamp + 1_000);
        expect(await registerLoginFailure(attacker, timestamp + 1_000)).toBe(5);
        await expect(assertLoginAttempt(attacker, limits, timestamp + 2_000)).rejects.toMatchObject({ code: "RATE_LIMITED", details: { retryAfterMs: 1_000 } });
        await assertLoginAttempt(victim, limits, timestamp + 1_000);
        await expect(assertLoginAttempt(victim, limits, timestamp + 2_000)).resolves.toBeUndefined();
        await registerLoginSuccess(victim);
        expect((await database.query("SELECT request_count FROM rate_limit_buckets WHERE bucket_key = $1", [failureKey(attacker)])).rows).toEqual([{ request_count: 5 }]);
        await expect(assertLoginAttempt(attacker, limits, timestamp + 3_000)).resolves.toBeUndefined();
      } finally {
        await closeRateLimitBackend();
      }
    });
  });

  it("increments concurrent failures atomically and expires the failure window without rewriting it", async () => {
    await withDisposablePostgresDatabase(async (database) => {
      vi.stubEnv("RATE_LIMIT_MODE", "postgres");
      vi.stubEnv("DATABASE_URL", database.connectionString());
      const timestamp = Date.now();
      try {
        const counts = await Promise.all(Array.from({ length: 20 }, () => registerLoginFailure(attacker, timestamp)));
        expect(counts.sort((a, b) => a - b)).toEqual(Array.from({ length: 20 }, (_, index) => index + 1));
        const before = await database.query("SELECT * FROM rate_limit_buckets WHERE bucket_key = $1", [failureKey(attacker)]);
        await assertLoginAttempt(attacker, { limit: 1, windowMs: 1_000 }, timestamp + 900_000);
        expect(await database.query("SELECT * FROM rate_limit_buckets WHERE bucket_key = $1", [failureKey(attacker)])).toEqual(before);
        await expect(assertLoginAttempt(attacker, { limit: 1, windowMs: 1_000 }, timestamp + 901_000)).resolves.toBeUndefined();
        expect(await registerLoginFailure(attacker, timestamp + 901_000)).toBe(1);
      } finally {
        await closeRateLimitBackend();
      }
    });
  });

  it("raises the aggregated per-account signal once per window across clients, with pseudonymous keys and no blocking (PROD-203)", async () => {
    await withDisposablePostgresDatabase(async (database) => {
      vi.stubEnv("RATE_LIMIT_MODE", "postgres");
      vi.stubEnv("DATABASE_URL", database.connectionString());
      const environment = { SESSION_SECRET: "s".repeat(32), LOGIN_ACCOUNT_SIGNAL_THRESHOLD: "4", LOGIN_ACCOUNT_SIGNAL_WINDOW_MS: "60000" };
      const timestamp = Date.now();
      try {
        const results = [];
        for (const [index, clientKey] of ["198.51.100.1", "198.51.100.2", "198.51.100.1", "198.51.100.3", "198.51.100.4"].entries()) {
          results.push(await registerAccountLoginFailure({ email: "Vet@cvg.local", clientKey }, environment, timestamp + index));
        }
        expect(results.filter(Boolean)).toEqual([{ accountId: pseudonymousAccountId("vet@cvg.local", environment), attempts: 4, distinctClients: 3, windowMs: 60000, threshold: 4 }]);
        expect(results[3]).toBeDefined();
        const buckets = await database.query("SELECT bucket_key, request_count FROM rate_limit_buckets WHERE bucket_key LIKE 'login-signal%' ORDER BY bucket_key");
        expect(buckets.rows.length).toBeGreaterThanOrEqual(5);
        expect(JSON.stringify(buckets.rows)).not.toContain("vet@cvg.local");
        expect(JSON.stringify(buckets.rows)).not.toContain("198.51.100");
        // The per-pair backoff counters are untouched: no login-failures or login-account bucket exists.
        expect((await database.query("SELECT 1 FROM rate_limit_buckets WHERE bucket_key LIKE 'login-failures:%' OR bucket_key LIKE 'login-account:%'")).rowCount).toBe(0);
      } finally {
        await closeRateLimitBackend();
      }
    });
  });
});
