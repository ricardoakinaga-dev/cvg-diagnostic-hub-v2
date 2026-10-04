-- SESSION_ACTIVITY_V1
-- Session activity is per-session liveness bookkeeping, not clinical state.
-- Keeping it inside cvg_runtime_state forced every authenticated read to
-- become a global write: one UPDATE that locks the single snapshot row,
-- rewrites the whole JSONB document and re-validates the append-only audit
-- prefix (finding F-01 / review A-01). This table keeps the same information
-- with one indexed single-row UPSERT that never touches the snapshot, never
-- locks cvg_runtime_state and never competes with clinical writes.

CREATE TABLE IF NOT EXISTS session_activity (
  session_id text PRIMARY KEY,
  user_id text NOT NULL,
  last_seen_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS session_activity_last_seen_idx
  ON session_activity (last_seen_at);

COMMENT ON TABLE session_activity IS
  'Per-session liveness for the idle timeout. Holds no clinical payload, is not part of the snapshot authority and is pruned by runtime retention together with the session it describes.';

-- Sessions created before this migration have no activity row. Seeding them
-- with the migration timestamp grants one idle window at deploy instead of
-- expiring every open session of the previous release on the first request
-- (review A-05). A row that exists but is older than the idle window still
-- expires normally.
INSERT INTO session_activity (session_id, user_id, last_seen_at, updated_at)
SELECT snapshot_session.value->>'id',
       snapshot_session.value->>'userId',
       CURRENT_TIMESTAMP,
       CURRENT_TIMESTAMP
  FROM cvg_runtime_state
  CROSS JOIN LATERAL jsonb_array_elements(state->'sessions') AS snapshot_session(value)
 WHERE id = 1
   AND snapshot_session.value ? 'id'
   AND snapshot_session.value ? 'userId'
ON CONFLICT (session_id) DO NOTHING;

UPDATE relational_schema_markers
   SET schema_version = '012_session_activity'
 WHERE marker_key = 'RELATIONAL_CLINICAL_CORE_EXPAND_V1';