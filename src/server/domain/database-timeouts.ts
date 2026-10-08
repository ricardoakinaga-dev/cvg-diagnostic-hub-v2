/**
 * Connection and statement ceilings shared by every runtime PostgreSQL pool.
 *
 * Without them a frozen or partitioned database kept requests pending
 * indefinitely: the 2026-10-07 audit measured 45 s without a response while the
 * server was paused. `query_timeout` is enforced by the client, so it still
 * fires when the server cannot run its own `statement_timeout`.
 */
export interface RuntimePoolTimeouts {
  readonly connectionTimeoutMillis: number;
  readonly statement_timeout: number;
  readonly query_timeout: number;
  readonly idle_in_transaction_session_timeout: number;
}

const DEFAULT_CONNECT_TIMEOUT_MS = 5_000;
const DEFAULT_STATEMENT_TIMEOUT_MS = 30_000;
const DEFAULT_IDLE_IN_TRANSACTION_TIMEOUT_MS = 60_000;

export function runtimePoolTimeouts(environment: Partial<NodeJS.ProcessEnv> = process.env): RuntimePoolTimeouts {
  const statement = bounded(environment.DB_STATEMENT_TIMEOUT_MS, DEFAULT_STATEMENT_TIMEOUT_MS, 1_000, 600_000);
  return {
    connectionTimeoutMillis: bounded(environment.DB_CONNECT_TIMEOUT_MS, DEFAULT_CONNECT_TIMEOUT_MS, 500, 60_000),
    statement_timeout: statement,
    query_timeout: statement + 5_000,
    // Bounds how long a stuck process can hold the global write lock.
    idle_in_transaction_session_timeout: bounded(environment.DB_IDLE_IN_TRANSACTION_TIMEOUT_MS, DEFAULT_IDLE_IN_TRANSACTION_TIMEOUT_MS, 5_000, 3_600_000)
  };
}

function bounded(value: string | undefined, fallback: number, minimum: number, maximum: number): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) return fallback;
  return Math.min(Math.max(parsed, minimum), maximum);
}
