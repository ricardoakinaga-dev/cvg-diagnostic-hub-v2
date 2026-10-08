-- PROD-501 (decision D5): completed exams older than the active window leave the
-- StoreState aggregate and are kept here, queryable and backed up with the
-- database, until the legal retention period (configured later) allows a purge.
-- Additive: the archive lives outside cvg_runtime_entities and the aggregate
-- contract, so no cutover is needed. Self-contained: it does not depend on any
-- migration after 016_outbox_whatsapp_route (it only reads cvg_runtime_entity_collections from 015).

CREATE TABLE cvg_clinical_archive_batches (
  id text NOT NULL,
  archived_at timestamptz NOT NULL,
  cutoff timestamptz NOT NULL,
  request_count integer NOT NULL,
  entity_count integer NOT NULL,
  attachment_count integer NOT NULL,
  actor text,
  CONSTRAINT cvg_clinical_archive_batches_pkey PRIMARY KEY (id),
  CONSTRAINT cvg_clinical_archive_batches_id_check CHECK (id <> ''),
  CONSTRAINT cvg_clinical_archive_batches_counts_check CHECK (request_count >= 0 AND entity_count >= 0 AND attachment_count >= 0)
);

CREATE TABLE cvg_clinical_archive (
  request_id text NOT NULL,
  collection text NOT NULL,
  entity_key text NOT NULL,
  position bigint NOT NULL,
  data jsonb NOT NULL,
  archived_at timestamptz NOT NULL,
  archive_batch text NOT NULL,
  purge_after timestamptz,
  CONSTRAINT cvg_clinical_archive_pkey PRIMARY KEY (collection, entity_key),
  CONSTRAINT cvg_clinical_archive_collection_check CHECK (collection = ANY (cvg_runtime_entity_collections())),
  CONSTRAINT cvg_clinical_archive_key_check CHECK (entity_key <> '' AND request_id <> ''),
  CONSTRAINT cvg_clinical_archive_data_check CHECK (jsonb_typeof(data) = 'object'),
  CONSTRAINT cvg_clinical_archive_batch_fkey FOREIGN KEY (archive_batch) REFERENCES cvg_clinical_archive_batches (id)
);
CREATE INDEX cvg_clinical_archive_request_idx ON cvg_clinical_archive (request_id);
CREATE INDEX cvg_clinical_archive_archived_at_idx ON cvg_clinical_archive (archived_at);
-- Per-patient consultation reads the request rows only.
CREATE INDEX cvg_clinical_archive_patient_idx ON cvg_clinical_archive ((data->>'patientId'), (data->>'updatedAt') DESC) WHERE collection = 'requests';

UPDATE relational_schema_markers SET schema_version = '017_clinical_archive' WHERE marker_key = 'RELATIONAL_CLINICAL_CORE_EXPAND_V1';

COMMENT ON TABLE cvg_clinical_archive IS 'Clinical entities of requests archived after the active window (D5). One row per entity, grouped by request_id; position keeps the original collection order. Removed only by the purge job after the legal retention period.';
COMMENT ON TABLE cvg_clinical_archive_batches IS 'One row per archive run: cutoff, counts and actor. The audit trail records the batch id, never the request ids.';
