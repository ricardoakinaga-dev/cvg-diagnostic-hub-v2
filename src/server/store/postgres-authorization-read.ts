import type { Pool } from "pg";
import type { Session, User } from "../domain/models";

export async function readPostgresAuthorizationSnapshot(
  pool: Pool,
  query: { userId: string; sessionId?: string }
): Promise<{ user?: User; session?: Session }> {
  const result = await pool.query<{ user: User | null; session: Session | null }>(
    `SELECT
       (SELECT data FROM cvg_runtime_entities WHERE collection = 'users' AND entity_key = $1) AS user,
       (SELECT data FROM cvg_runtime_entities
         WHERE collection = 'sessions' AND entity_key = $2 AND data->>'userId' = $1) AS session
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
