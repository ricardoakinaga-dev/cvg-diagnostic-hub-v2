-- Record object deletion before archive rows lose their storage keys. The
-- worker removes an intent only after the object store confirms deletion.
CREATE TABLE cvg_archive_object_deletions (
  storage_key text NOT NULL PRIMARY KEY,
  requested_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT cvg_archive_object_deletions_key_check CHECK (storage_key <> '')
);
CREATE INDEX cvg_archive_object_deletions_requested_idx
  ON cvg_archive_object_deletions (requested_at, storage_key);

UPDATE relational_schema_markers SET schema_version = '018_archive_object_deletions'
  WHERE marker_key = 'RELATIONAL_CLINICAL_CORE_EXPAND_V1';

COMMENT ON TABLE cvg_archive_object_deletions IS 'Durable deletion intents created atomically with clinical archive purge. Retained across worker crashes and storage failures; deleted only after confirmed object removal.';
