import { Pool } from "pg";
import { ApiError } from "../http/envelope";
import { isPostgresConnectionString } from "../domain/realtime-configuration";

interface Bucket { count: number; resetAt: number; windowStartedAt: number }
const buckets = new Map<string, Bucket>();
let databasePool: Pool | undefined;

/** Window growth applied to a credential pair after repeated wrong passwords. */
const LOGIN_BACKOFF_STEPS = [1, 2, 4, 8, 16] as const;
/** Failures younger than this still count towards the pair's backoff. */
const LOGIN_FAILURE_DECAY_MS = 15 * 60 * 1000;
const MAX_LOGIN_BACKOFF_MULTIPLIER = 16;
const LOGIN_BACKOFF_CEILING_MS = 60 * 60 * 1000;
const LOGIN_FAILURE_COUNTER_CEILING = 1_000_000;

const POSTGRES_CONSUME_SQL = `
  INSERT INTO rate_limit_buckets (bucket_key, window_started_at, request_count)
  VALUES ($1, $2, 1)
  ON CONFLICT (bucket_key) DO UPDATE
    SET window_started_at = CASE
          WHEN rate_limit_buckets.window_started_at + ($3 * interval '1 millisecond') <= $2
            THEN $2
          ELSE rate_limit_buckets.window_started_at
        END,
        request_count = CASE
          WHEN rate_limit_buckets.window_started_at + ($3 * interval '1 millisecond') <= $2
            THEN 1
          ELSE LEAST(rate_limit_buckets.request_count + 1, $4 + 1)
        END
  RETURNING request_count,
    (EXTRACT(EPOCH FROM (window_started_at + ($3 * interval '1 millisecond'))) * 1000)::bigint AS reset_at,
    request_count <= $4 AS allowed
`;

export async function assertRateLimit(key: string, limit: number, windowMs: number, timestamp = Date.now()): Promise<void> {
  const mode = assertRateLimitConfiguration();
  if (mode === "memory") {
    if (process.env.NODE_ENV === "production") throw new Error("RATE_LIMIT_MODE=memory não é permitido em produção.");
    assertMemoryRateLimit(key, limit, windowMs, timestamp);
    return;
  }
  if (mode !== "postgres") throw new Error("RATE_LIMIT_MODE deve ser memory ou postgres.");
  await assertPostgresRateLimit(key, limit, windowMs, timestamp);
}

export function assertRateLimitConfiguration(environment: Partial<NodeJS.ProcessEnv> = process.env): "memory" | "postgres" {
  const mode = environment.RATE_LIMIT_MODE ?? (environment.NODE_ENV === "production" ? "postgres" : "memory");
  if (mode !== "memory" && mode !== "postgres") throw new Error("RATE_LIMIT_MODE deve ser memory ou postgres.");
  if (mode === "memory" && environment.NODE_ENV === "production") throw new Error("RATE_LIMIT_MODE=memory não é permitido em produção.");
  if (mode === "postgres" && (!environment.DATABASE_URL?.trim() || !isPostgresConnectionString(environment.DATABASE_URL))) {
    throw new Error("DATABASE_URL deve ser uma URL PostgreSQL quando RATE_LIMIT_MODE=postgres.");
  }
  if (mode === "postgres") assertRateLimitPoolMax(environment.RATE_LIMIT_DB_POOL_MAX);
  return mode;
}

function assertRateLimitPoolMax(value: string | undefined): number {
  if (value === undefined) return 4;
  if (!/^[1-9][0-9]*$/.test(value)) throw new Error("RATE_LIMIT_DB_POOL_MAX deve ser um inteiro positivo.");
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed > 100) throw new Error("RATE_LIMIT_DB_POOL_MAX deve estar entre 1 e 100.");
  return parsed;
}

function assertMemoryRateLimit(key: string, limit: number, windowMs: number, timestamp: number): void {
  const current = buckets.get(key);
  const bucket = !current || current.windowStartedAt + windowMs <= timestamp
    ? { count: 0, resetAt: timestamp + windowMs, windowStartedAt: timestamp }
    : { ...current, resetAt: current.windowStartedAt + windowMs };
  if (bucket.count >= limit) {
    buckets.set(key, bucket);
    throw new ApiError("RATE_LIMITED", "Muitas tentativas. Aguarde antes de tentar novamente.", 429, { retryable: true });
  }
  buckets.set(key, { ...bucket, count: bucket.count + 1 });
  if (buckets.size > 10_000) {
    for (const [bucketKey, entry] of buckets) if (entry.resetAt <= timestamp) buckets.delete(bucketKey);
  }
}

async function assertPostgresRateLimit(key: string, limit: number, windowMs: number, timestamp: number): Promise<void> {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL é obrigatório quando RATE_LIMIT_MODE=postgres.");
  try {
    const result = await rateLimitPool().query<{ request_count: number | string; reset_at: number | string; allowed: boolean }>(POSTGRES_CONSUME_SQL, [key, new Date(timestamp), windowMs, limit]);
    const row = result.rows[0];
    if (!row) throw new Error("RATE_LIMIT_BUCKET_MISSING");
    const count = Number(row.request_count);
    const resetAt = Number(row.reset_at);
    if (!Number.isSafeInteger(count) || !Number.isSafeInteger(resetAt) || typeof row.allowed !== "boolean") throw new Error("RATE_LIMIT_BUCKET_INVALID");
    if (!row.allowed) {
      throw new ApiError("RATE_LIMITED", "Muitas tentativas. Aguarde antes de tentar novamente.", 429, { retryable: true, retryAfterMs: Math.max(1, resetAt - timestamp) });
    }
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError("DEPENDENCY_UNAVAILABLE", "O controle de abuso não está disponível.", 503, { retryable: true });
  }
}

/**
 * Per-pair login budget.
 *
 * F-04: a bucket keyed only by e-mail let anybody lock a known user out of
 * their own account by spending the account-wide budget from another origin.
 * The budget is therefore keyed by (e-mail, client), so an attacker can only
 * exhaust the pair they are actually using, and the progressive backoff grows
 * that pair's window without touching any other pair for the same account.
 */
export interface LoginAttemptIdentity {
  readonly email: string;
  readonly clientKey: string;
}

export function loginAttemptKey(identity: LoginAttemptIdentity): string {
  const email = identity.email.trim().toLowerCase();
  const client = identity.clientKey?.trim();
  if (!client) throw new ApiError("RATE_LIMIT_UNAVAILABLE", "O controle de abuso não está configurado para esta borda.", 503, { retryable: true });
  return `login-account:${JSON.stringify([email, client])}`;
}

function loginFailureKey(identity: LoginAttemptIdentity): string {
  return `login-failures:${loginAttemptKey(identity)}`;
}

/**
 * Doubling steps every five wrong passwords, so a single typo never delays a
 * legitimate user but a sustained guessing run is slowed by up to 16x.
 */
export function loginBackoffMultiplier(failures: number): number {
  if (!Number.isSafeInteger(failures) || failures <= 0) return 1;
  const stepIndex = Math.floor(failures / 5);
  const step = LOGIN_BACKOFF_STEPS[Math.min(stepIndex, LOGIN_BACKOFF_STEPS.length - 1)] ?? 1;
  return Math.min(step, MAX_LOGIN_BACKOFF_MULTIPLIER);
}

export function loginBackoffWindowMs(baseWindowMs: number, failures: number): number {
  return Math.min(Math.max(1, baseWindowMs) * loginBackoffMultiplier(failures), LOGIN_BACKOFF_CEILING_MS);
}

/**
 * Consumes the (e-mail, client) budget with the window the pair's recent
 * failures justify. Throws the same RATE_LIMITED error as any other budget so
 * the HTTP surface does not grow a new shape.
 */
export async function assertLoginAttempt(
  identity: LoginAttemptIdentity,
  limits: { limit: number; windowMs: number },
  timestamp = Date.now()
): Promise<void> {
  const failures = await readLoginFailureCount(identity, timestamp);
  await assertRateLimit(loginAttemptKey(identity), limits.limit, loginBackoffWindowMs(limits.windowMs, failures), timestamp);
}

/**
 * Counts one wrong password for the pair. The counter decays, so an old
 * incident does not keep a legitimate user under backoff forever. It never
 * denies access by itself: it changes only this pair's attempt window.
 */
export async function registerLoginFailure(identity: LoginAttemptIdentity, timestamp = Date.now()): Promise<number> {
  return consumeRateLimitCounter(loginFailureKey(identity), LOGIN_FAILURE_DECAY_MS, timestamp);
}

/** Clears only this pair's failure counter after a successful login. */
export async function registerLoginSuccess(identity: LoginAttemptIdentity): Promise<void> {
  const key = loginFailureKey(identity);
  const mode = assertRateLimitConfiguration();
  if (mode === "memory") {
    buckets.delete(key);
    return;
  }
  try {
    await rateLimitPool().query("DELETE FROM rate_limit_buckets WHERE bucket_key = $1", [key]);
  } catch {
    throw new ApiError("DEPENDENCY_UNAVAILABLE", "O controle de abuso não está disponível.", 503, { retryable: true });
  }
}

async function readLoginFailureCount(identity: LoginAttemptIdentity, timestamp: number): Promise<number> {
  const key = loginFailureKey(identity);
  if (assertRateLimitConfiguration() === "memory") {
    const current = buckets.get(key);
    if (!current || current.resetAt <= timestamp) return 0;
    return current.count;
  }
  try {
    const result = await rateLimitPool().query<{ request_count: number | string }>(
      `SELECT request_count FROM rate_limit_buckets
        WHERE bucket_key = $1 AND window_started_at + ($3 * interval '1 millisecond') > $2`,
      [key, new Date(timestamp), LOGIN_FAILURE_DECAY_MS]
    );
    if (result.rows.length === 0) return 0;
    const count = Number(result.rows[0].request_count);
    if (!Number.isSafeInteger(count) || count < 0) throw new Error("RATE_LIMIT_BUCKET_INVALID");
    return count;
  } catch {
    throw new ApiError("DEPENDENCY_UNAVAILABLE", "O controle de abuso não está disponível.", 503, { retryable: true });
  }
}

/**
 * Atomically increments one wrong-password counter. Dependency failures fail
 * closed; reads and successful logins never consume this counter.
 */
async function consumeRateLimitCounter(key: string, windowMs: number, timestamp: number): Promise<number> {
  if (assertRateLimitConfiguration() === "memory") {
    const current = buckets.get(key);
    const bucket = !current || current.resetAt <= timestamp ? { count: 0, resetAt: timestamp + windowMs, windowStartedAt: timestamp } : current;
    const next = { ...bucket, count: bucket.count + 1 };
    buckets.set(key, next);
    return next.count;
  }
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL é obrigatório quando RATE_LIMIT_MODE=postgres.");
  return assertPostgresRateLimitCounter(key, LOGIN_FAILURE_COUNTER_CEILING, windowMs, timestamp);
}

export function resetRateLimits(): void {
  buckets.clear();
}

async function assertPostgresRateLimitCounter(
  key: string,
  ceiling: number,
  windowMs: number,
  timestamp = Date.now()
): Promise<number> {
  try {
    const result = await rateLimitPool().query<{ request_count: number | string }>(
      POSTGRES_CONSUME_SQL.replace(/\n\s+RETURNING[\s\S]*$/, "\n  RETURNING request_count"),
      [key, new Date(timestamp), windowMs, ceiling]
    );
    const count = Number(result.rows[0]?.request_count);
    if (!Number.isSafeInteger(count)) throw new Error("RATE_LIMIT_BUCKET_INVALID");
    return count;
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError("DEPENDENCY_UNAVAILABLE", "O controle de abuso não está disponível.", 503, { retryable: true });
  }
}

function rateLimitPool(): Pool {
  if (!databasePool) {
    databasePool = new Pool({ connectionString: process.env.DATABASE_URL, max: assertRateLimitPoolMax(process.env.RATE_LIMIT_DB_POOL_MAX), idleTimeoutMillis: 30_000 });
    databasePool.on("error", () => {
      // The next query fails closed with DEPENDENCY_UNAVAILABLE.
    });
  }
  return databasePool;
}

export async function closeRateLimitBackend(): Promise<void> {
  const pool = databasePool;
  databasePool = undefined;
  if (pool) await pool.end();
  resetRateLimits();
}
