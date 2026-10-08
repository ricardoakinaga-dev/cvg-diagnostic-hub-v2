-- Coordinated cutover: old app and worker must be stopped. Every remaining
-- StoreState collection moves from the single JSONB document to one row per
-- entity, so a write persists only what changed and the 256 MB jsonb ceiling no
-- longer bounds the clinical history (2026-10-07 audit: a write took 26.6 s at
-- twelve months of data, and 160k exams failed with SQLSTATE 54000).
-- cvg_runtime_state keeps the version, the global write lock, the invalidation
-- trigger and the scalar header (protocolSequence). The copy is compared with
-- the source collection by collection before the header is emptied; a mismatch
-- rolls the whole migration back.

CREATE FUNCTION cvg_runtime_entity_collections() RETURNS text[]
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT ARRAY['users', 'sessions', 'patients', 'encounters', 'admissions', 'services', 'reasonCodes',
               'requests', 'items', 'samples', 'procedures', 'schedules', 'results', 'resultVersions',
               'notifications', 'idempotency', 'attachments']::text[]
$$;

-- Must stay byte-identical to entityKey() in postgres-entity-state.ts:
-- JSON.stringify([actorId, scope, key]) for idempotency records, the id otherwise.
CREATE FUNCTION cvg_runtime_entity_key(collection text, entity jsonb) RETURNS text
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT CASE
    WHEN collection = 'idempotency' THEN '[' || (entity->'actorId')::text || ',' || (entity->'scope')::text || ',' || (entity->'key')::text || ']'
    WHEN jsonb_typeof(entity->'id') = 'string' THEN entity->>'id'
  END
$$;

CREATE FUNCTION cvg_runtime_state_header(state jsonb) RETURNS jsonb
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT state || (SELECT jsonb_object_agg(collection, '[]'::jsonb) FROM unnest(cvg_runtime_entity_collections()) AS collection)
$$;

CREATE FUNCTION cvg_runtime_entity_rows(source jsonb, version bigint)
RETURNS TABLE (collection text, entity_key text, entity_position bigint, data jsonb, written_version bigint)
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT target.collection, cvg_runtime_entity_key(target.collection, entry.value), entry.ordinal, entry.value, version
    FROM unnest(cvg_runtime_entity_collections()) AS target(collection)
   CROSS JOIN LATERAL jsonb_array_elements(COALESCE(source->target.collection, '[]'::jsonb)) WITH ORDINALITY AS entry(value, ordinal)
$$;

CREATE TABLE cvg_runtime_entities (
  collection text NOT NULL,
  entity_key text NOT NULL,
  position bigint NOT NULL,
  data jsonb NOT NULL,
  written_version bigint NOT NULL,
  CONSTRAINT cvg_runtime_entities_pkey PRIMARY KEY (collection, entity_key),
  -- Deferred so a rare reorder can renumber a collection inside one transaction.
  CONSTRAINT cvg_runtime_entities_position_unique UNIQUE (collection, position) DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT cvg_runtime_entities_collection_check CHECK (collection = ANY (cvg_runtime_entity_collections())),
  CONSTRAINT cvg_runtime_entities_key_check CHECK (entity_key <> ''),
  CONSTRAINT cvg_runtime_entities_data_check CHECK (jsonb_typeof(data) = 'object'),
  CONSTRAINT cvg_runtime_entities_counters_check CHECK (position > 0 AND written_version > 0)
);
CREATE INDEX cvg_runtime_entities_written_version_idx ON cvg_runtime_entities (written_version);

-- Lets a cache older than the current version apply only what changed.
-- Rows older than entity_removal_floor are pruned; a cache below the floor reloads.
CREATE TABLE cvg_runtime_entity_removals (
  removed_version bigint NOT NULL,
  collection text NOT NULL,
  entity_key text NOT NULL,
  removed_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT cvg_runtime_entity_removals_pkey PRIMARY KEY (removed_version, collection, entity_key)
);
CREATE INDEX cvg_runtime_entity_removals_removed_at_idx ON cvg_runtime_entity_removals (removed_at);

ALTER TABLE cvg_runtime_state ADD COLUMN entity_removal_floor bigint NOT NULL DEFAULT 0;

DO $$
DECLARE
  snapshot jsonb;
  current_version bigint;
  invalid text;
BEGIN
  SELECT state, version INTO snapshot, current_version FROM cvg_runtime_state WHERE id = 1 FOR UPDATE;
  IF snapshot IS NOT NULL THEN
    SELECT string_agg(target.name, ',') INTO invalid
      FROM unnest(cvg_runtime_entity_collections()) AS target(name)
     WHERE jsonb_typeof(snapshot->target.name) IS DISTINCT FROM 'array';
    IF invalid IS NOT NULL THEN
      RAISE EXCEPTION 'ENTITY_CUTOVER_INVALID_SNAPSHOT:%', invalid;
    END IF;
    SELECT string_agg(DISTINCT rows.collection, ',') INTO invalid
      FROM cvg_runtime_entity_rows(snapshot, current_version + 1) AS rows
     WHERE rows.entity_key IS NULL OR rows.entity_key = '' OR jsonb_typeof(rows.data) IS DISTINCT FROM 'object';
    IF invalid IS NOT NULL THEN
      RAISE EXCEPTION 'ENTITY_CUTOVER_INVALID_ENTITY:%', invalid;
    END IF;
    SELECT string_agg(DISTINCT duplicated.collection, ',') INTO invalid
      FROM (
        SELECT rows.collection FROM cvg_runtime_entity_rows(snapshot, current_version + 1) AS rows
         GROUP BY rows.collection, rows.entity_key HAVING count(*) > 1
      ) AS duplicated;
    IF invalid IS NOT NULL THEN
      RAISE EXCEPTION 'ENTITY_CUTOVER_DUPLICATE_KEY:%', invalid;
    END IF;

    INSERT INTO cvg_runtime_entities (collection, entity_key, position, data, written_version)
    SELECT rows.collection, rows.entity_key, rows.entity_position, rows.data, rows.written_version
      FROM cvg_runtime_entity_rows(snapshot, current_version + 1) AS rows;

    SELECT string_agg(target.name, ',') INTO invalid
      FROM unnest(cvg_runtime_entity_collections()) AS target(name)
     WHERE snapshot->target.name IS DISTINCT FROM (
       SELECT COALESCE(jsonb_agg(entity.data ORDER BY entity.position), '[]'::jsonb)
         FROM cvg_runtime_entities entity
        WHERE entity.collection = target.name
     );
    IF invalid IS NOT NULL THEN
      RAISE EXCEPTION 'ENTITY_CUTOVER_RECONCILIATION_FAILED:%', invalid;
    END IF;

    UPDATE cvg_runtime_state
       SET state = cvg_runtime_state_header(snapshot), version = current_version + 1, updated_at = now()
     WHERE id = 1;
  END IF;
END $$;

ALTER TABLE cvg_runtime_state ADD CONSTRAINT runtime_entities_are_external CHECK (COALESCE(
  state->'users' = '[]'::jsonb AND state->'sessions' = '[]'::jsonb AND state->'patients' = '[]'::jsonb
  AND state->'encounters' = '[]'::jsonb AND state->'admissions' = '[]'::jsonb AND state->'services' = '[]'::jsonb
  AND state->'reasonCodes' = '[]'::jsonb AND state->'requests' = '[]'::jsonb AND state->'items' = '[]'::jsonb
  AND state->'samples' = '[]'::jsonb AND state->'procedures' = '[]'::jsonb AND state->'schedules' = '[]'::jsonb
  AND state->'results' = '[]'::jsonb AND state->'resultVersions' = '[]'::jsonb AND state->'notifications' = '[]'::jsonb
  AND state->'idempotency' = '[]'::jsonb AND state->'attachments' = '[]'::jsonb, false));

UPDATE runtime_storage_boundaries
   SET authoritative_store = 'cvg_runtime_entities', contract_version = 'StoreState-entities-v1'
 WHERE boundary_key = 'runtime-jsonb-snapshot-v1';
UPDATE relational_schema_markers SET schema_version = '015_runtime_entity_rows' WHERE marker_key = 'RELATIONAL_CLINICAL_CORE_EXPAND_V1';

COMMENT ON TABLE cvg_runtime_entities IS 'One row per StoreState entity, in collection order. Written as a diff under the cvg_runtime_state row lock; written_version drives incremental cache refresh.';
COMMENT ON TABLE cvg_runtime_entity_removals IS 'Entity removals by runtime version, so a cache can apply deletes incrementally. Pruned by runtime retention; entity_removal_floor records the newest pruned version.';
COMMENT ON COLUMN cvg_runtime_state.entity_removal_floor IS 'Newest pruned removal version; a cache older than this must reload every entity.';
