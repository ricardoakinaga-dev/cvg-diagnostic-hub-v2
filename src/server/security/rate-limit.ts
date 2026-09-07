import { Pool } from "pg";
import { ApiError } from "../http/envelope";
import { isPostgresConnectionString } from "../domain/realtime-configuration";

interface Bucket { count: number; resetAt: number }
const buckets = new Map<string, Bucket>();
let databasePool: Pool | undefined;

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
  const bucket = !current || current.resetAt <= timestamp ? { count: 0, resetAt: timestamp + windowMs } : current;
  if (bucket.count >= limit) {
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
    if (!databasePool) {
      databasePool = new Pool({ connectionString: process.env.DATABASE_URL, max: assertRateLimitPoolMax(process.env.RATE_LIMIT_DB_POOL_MAX), idleTimeoutMillis: 30_000 });
      if (typeof databasePool.on === "function") {
        databasePool.on("error", () => {
          // The next bucket query will fail closed with DEPENDENCY_UNAVAILABLE.
        });
      }
    }
    const result = await databasePool.query<{ request_count: number | string; reset_at: number | string; allowed: boolean }>(POSTGRES_CONSUME_SQL, [key, new Date(timestamp), windowMs, limit]);
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

export function resetRateLimits(): void {
  buckets.clear();
}

export async function closeRateLimitBackend(): Promise<void> {
  const pool = databasePool;
  databasePool = undefined;
  if (pool) await pool.end();
  resetRateLimits();
}
