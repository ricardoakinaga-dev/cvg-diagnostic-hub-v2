import type { Pool, PoolClient } from "pg";
import type { SessionActivity, Timestamp } from "../domain/models";

export interface SessionActivityQuery {
  readonly sessionId: string;
  readonly userId: string;
}

interface SessionActivityRow {
  readonly session_id: string;
  readonly user_id: string;
  readonly last_seen_at: Date | string;
}

const READ_SESSION_ACTIVITY_SQL = `
  SELECT session_id, user_id, last_seen_at
    FROM session_activity
   WHERE session_id = $1
`;

const TOUCH_SESSION_ACTIVITY_SQL = `
  INSERT INTO session_activity (session_id, user_id, last_seen_at, updated_at)
  VALUES ($1, $2, $3, now())
  ON CONFLICT (session_id) DO UPDATE
    SET user_id = EXCLUDED.user_id,
        last_seen_at = GREATEST(session_activity.last_seen_at, EXCLUDED.last_seen_at),
        updated_at = now()
  RETURNING session_id, user_id, last_seen_at
`;

/**
 * Reads the liveness of one session with a single indexed row read. It never
 * touches cvg_runtime_state, so it neither queues behind clinical writes nor
 * forces PostgreSQL to expand the whole JSONB aggregate.
 */
export async function readPostgresSessionActivity(
  pool: Pool,
  sessionId: string
): Promise<SessionActivity | undefined> {
  const result = await pool.query<SessionActivityRow>(READ_SESSION_ACTIVITY_SQL, [sessionId]);
  if (result.rowCount === 0) return undefined;
  return sessionActivityFromRow(result.rows[0]);
}

/**
 * Records liveness with a single-row UPSERT. The statement is monotonic: a
 * replayed or out-of-order observation can only move last_seen_at forward.
 */
export async function touchPostgresSessionActivity(
  pool: Pool | PoolClient,
  query: SessionActivityQuery,
  lastSeenAt: Timestamp
): Promise<SessionActivity> {
  const result = await pool.query<SessionActivityRow>(TOUCH_SESSION_ACTIVITY_SQL, [
    query.sessionId,
    query.userId,
    lastSeenAt
  ]);
  if (result.rowCount !== 1) throw new Error("POSTGRES_SESSION_ACTIVITY_TOUCH_FAILED");
  return sessionActivityFromRow(result.rows[0]);
}

/**
 * Removes activity rows that no longer have a session in the snapshot. Called
 * inside the retention transaction so liveness bookkeeping cannot outlive the
 * session it describes.
 */
export async function prunePostgresSessionActivity(
  client: PoolClient,
  retainedSessionIds: readonly string[]
): Promise<number> {
  const result = await client.query<{ removed: string | number }>(
    `WITH removed AS (
       DELETE FROM session_activity
        WHERE NOT (session_id = ANY ($1::text[]))
        RETURNING 1
     )
     SELECT count(*)::text AS removed FROM removed`,
    [[...retainedSessionIds]]
  );
  const removed = Number(result.rows[0]?.removed ?? 0);
  return Number.isSafeInteger(removed) && removed >= 0 ? removed : 0;
}

/**
 * Removes projected outbox rows that runtime retention dropped from the
 * snapshot. Runtime readiness asserts that jsonb_array_length(state->'outbox')
 * equals count(*) of outbox_messages, so the two representations must be
 * pruned together or the runtime would fail its own readiness gate.
 */
export async function deletePostgresProcessedOutbox(
  client: PoolClient,
  messageIds: readonly string[]
): Promise<number> {
  if (messageIds.length === 0) return 0;
  const result = await client.query(
    "DELETE FROM outbox_messages WHERE id = ANY($1::text[]) AND status = 'PROCESSED'",
    [[...messageIds]]
  );
  return result.rowCount ?? 0;
}

function sessionActivityFromRow(row: SessionActivityRow | undefined): SessionActivity {
  if (!row) throw new Error("POSTGRES_SESSION_ACTIVITY_ROW_MISSING");
  // Parse before formatting: an unrepresentable value must fail closed with a
  // stable code instead of an opaque RangeError from toISOString().
  const lastSeenAtMs = row.last_seen_at instanceof Date ? row.last_seen_at.getTime() : Date.parse(String(row.last_seen_at));
  if (!Number.isFinite(lastSeenAtMs)) throw new Error("POSTGRES_SESSION_ACTIVITY_TIMESTAMP_INVALID");
  return { sessionId: row.session_id, userId: row.user_id, lastSeenAt: new Date(lastSeenAtMs).toISOString() };
}
