CREATE TABLE IF NOT EXISTS runtime_storage_boundaries (
  boundary_key text PRIMARY KEY,
  authoritative_store text NOT NULL,
  read_mode text NOT NULL,
  write_mode text NOT NULL,
  projected_relations text[] NOT NULL,
  status text NOT NULL,
  reconciliation_mode text NOT NULL,
  contract_version text NOT NULL,
  CHECK (status IN ('TRANSITIONAL', 'RELATIONAL_READY', 'RETIRED')),
  CHECK (read_mode IN ('SNAPSHOT', 'RELATIONAL')),
  CHECK (write_mode IN ('SNAPSHOT', 'RELATIONAL')),
  CHECK (reconciliation_mode IN ('CONTINUOUS', 'BACKFILL_REQUIRED', 'COMPLETE'))
);

INSERT INTO runtime_storage_boundaries (boundary_key, authoritative_store, read_mode, write_mode, projected_relations, status, reconciliation_mode, contract_version)
VALUES ('runtime-jsonb-snapshot-v1', 'cvg_runtime_state', 'SNAPSHOT', 'SNAPSHOT', ARRAY['audit_events', 'outbox_messages'], 'TRANSITIONAL', 'CONTINUOUS', 'StoreState-v1')
ON CONFLICT (boundary_key) DO UPDATE
SET authoritative_store = EXCLUDED.authoritative_store,
    read_mode = EXCLUDED.read_mode,
    write_mode = EXCLUDED.write_mode,
    projected_relations = EXCLUDED.projected_relations,
    status = EXCLUDED.status,
    reconciliation_mode = EXCLUDED.reconciliation_mode,
    contract_version = EXCLUDED.contract_version;

COMMENT ON TABLE runtime_storage_boundaries IS 'Executable boundary record for the transitional JSONB adapter. It prevents a snapshot from being mistaken for a completed relational clinical schema.';
