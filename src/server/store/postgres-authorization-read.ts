import type { Pool } from "pg";
import type { Session, User } from "../domain/models";

export async function readPostgresAuthorizationSnapshot(
  pool: Pool,
  query: { userId: string; sessionId?: string }
): Promise<{ user?: User; session?: Session }> {
  const result = await pool.query<{ user: User | null; session: Session | null }>(
    `SELECT
       (SELECT value FROM jsonb_array_elements(state->'users') AS user_entry(value)
        WHERE value->>'id' = $1 LIMIT 1) AS user,
       (SELECT value FROM jsonb_array_elements(state->'sessions') AS session_entry(value)
        WHERE value->>'id' = $2 AND value->>'userId' = $1 LIMIT 1) AS session
     FROM cvg_runtime_state
     WHERE id = 1`,
    [query.userId, query.sessionId ?? null]
  );
  if (result.rowCount !== 1) throw new Error("PostgreSQL runtime state row is missing.");
  const row = result.rows[0];
  return {
    user: row.user ? structuredClone(row.user) : undefined,
    session: row.session ? structuredClone(row.session) : undefined
  };
}
