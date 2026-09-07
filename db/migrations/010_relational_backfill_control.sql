-- AAA-W1-BACKFILL / RELATIONAL_BACKFILL_CONTROL_V1
-- This migration is executed inside BEGIN/COMMIT by src/server/store/migrations.ts.
-- It adds only durable control metadata for the request-scoped shadow backfill;
-- it does not copy runtime data, change read/write authority, or enable cutover.

CREATE TABLE IF NOT EXISTS relational_backfill_runs (
  run_id text PRIMARY KEY,
  scope text NOT NULL,
  source_authority text NOT NULL,
  target_authority text NOT NULL,
  transform_version text NOT NULL,
  source_snapshot_version bigint NOT NULL,
  source_snapshot_hash text NOT NULL,
  status text NOT NULL,
  last_request_id text,
  requests_processed bigint NOT NULL DEFAULT 0,
  rows_projected bigint NOT NULL DEFAULT 0,
  requests_reconciled bigint NOT NULL DEFAULT 0,
  failure_code text,
  started_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  CONSTRAINT relational_backfill_runs_id_nonempty CHECK (btrim(run_id) <> ''),
  CONSTRAINT relational_backfill_runs_scope_check CHECK (scope = 'CLINICAL_CORE_REQUESTS'),
  CONSTRAINT relational_backfill_runs_source_authority_check CHECK (source_authority = 'SNAPSHOT'),
  CONSTRAINT relational_backfill_runs_target_authority_check CHECK (target_authority = 'RELATIONAL_SHADOW'),
  CONSTRAINT relational_backfill_runs_transform_nonempty CHECK (btrim(transform_version) <> ''),
  CONSTRAINT relational_backfill_runs_source_version_positive CHECK (source_snapshot_version > 0),
  CONSTRAINT relational_backfill_runs_source_hash_format CHECK (source_snapshot_hash ~ '^[a-f0-9]{64}$'),
  CONSTRAINT relational_backfill_runs_status_check CHECK (status IN ('RUNNING', 'COMPLETED', 'FAILED')),
  CONSTRAINT relational_backfill_runs_counts_nonnegative CHECK (requests_processed >= 0 AND rows_projected >= 0 AND requests_reconciled >= 0),
  CONSTRAINT relational_backfill_runs_completed_pair CHECK ((status = 'COMPLETED') = (completed_at IS NOT NULL)),
  CONSTRAINT relational_backfill_runs_failure_pair CHECK ((status = 'FAILED') = (failure_code IS NOT NULL AND btrim(failure_code) <> ''))
);

CREATE INDEX IF NOT EXISTS relational_backfill_runs_status_updated_idx
  ON relational_backfill_runs (status, updated_at DESC);

UPDATE relational_schema_markers
   SET schema_version = '010_relational_backfill_control'
 WHERE marker_key = 'RELATIONAL_CLINICAL_CORE_EXPAND_V1';

COMMENT ON TABLE relational_backfill_runs IS
  'Durable, resumable control metadata for a request-scoped SNAPSHOT to RELATIONAL_SHADOW backfill; it never grants relational authority.';
