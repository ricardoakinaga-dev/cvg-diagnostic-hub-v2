-- AAA2-017/018 sample/accession lineage integrity boundary.
-- Keep 007 and 008 immutable: this migration adds only database-enforceable
-- invariants for canonical accessions, replacement reasons, link states and
-- the source item membership needed to prove complete sample linkage.

ALTER TABLE samples
  ADD COLUMN IF NOT EXISTS item_ids text[] DEFAULT ARRAY[]::text[];
ALTER TABLE samples
  ALTER COLUMN item_ids SET DEFAULT ARRAY[]::text[],
  ALTER COLUMN item_ids SET NOT NULL;

DO $relational_sample_lineage_constraints$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'samples'::regclass
       AND conname = 'samples_accession_format'
  ) THEN
    ALTER TABLE samples
      ADD CONSTRAINT samples_accession_format
      CHECK (accession_code ~ '^[A-Z0-9][A-Z0-9-]{2,39}$')
      NOT VALID;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'samples'::regclass
       AND conname = 'samples_replacement_reason_required'
  ) THEN
    ALTER TABLE samples
      ADD CONSTRAINT samples_replacement_reason_required
      CHECK (status <> 'REPLACED' OR rejection_reason_id IS NOT NULL)
      NOT VALID;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'sample_item_links'::regclass
       AND conname = 'sample_item_links_status_check'
  ) THEN
    ALTER TABLE sample_item_links
      ADD CONSTRAINT sample_item_links_status_check
      CHECK (link_status IN ('ACTIVE', 'REJECTED', 'REPLACED'))
      NOT VALID;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'samples'::regclass
       AND conname = 'samples_item_ids_nonempty'
  ) THEN
    ALTER TABLE samples
      ADD CONSTRAINT samples_item_ids_nonempty
      CHECK (cardinality(item_ids) > 0 AND array_position(item_ids, '') IS NULL)
      NOT VALID;
  END IF;
END;
$relational_sample_lineage_constraints$;

ALTER TABLE samples
  VALIDATE CONSTRAINT samples_accession_format,
  VALIDATE CONSTRAINT samples_replacement_reason_required;
ALTER TABLE sample_item_links
  VALIDATE CONSTRAINT sample_item_links_status_check;

-- Recover membership that is already durable before the explicit backfill:
-- prefer the JSONB authority, then existing relational links, then the current
-- item pointers. Rows that cannot be recovered remain empty and deliberately
-- keep readiness fail-closed; the explicit BACKFILL mode must repair them or
-- stop with a validation error instead of inventing clinical relationships.
UPDATE samples target
   SET item_ids = source.item_ids
  FROM (
    SELECT sample_row.sample->>'id' AS sample_id,
           ARRAY(
             SELECT item_value.value
               FROM jsonb_array_elements_text(
                 CASE
                   WHEN jsonb_typeof(sample_row.sample->'itemIds') = 'array' THEN sample_row.sample->'itemIds'
                   ELSE '[]'::jsonb
                 END
               ) AS item_value(value)
              WHERE btrim(item_value.value) <> ''
           ) AS item_ids
      FROM cvg_runtime_state runtime
      CROSS JOIN LATERAL jsonb_array_elements(
        CASE
          WHEN jsonb_typeof(runtime.state->'samples') = 'array' THEN runtime.state->'samples'
          ELSE '[]'::jsonb
        END
      ) AS sample_row(sample)
     WHERE runtime.id = 1
  ) source
 WHERE target.id = source.sample_id
   AND cardinality(target.item_ids) = 0
   AND cardinality(source.item_ids) > 0;

UPDATE samples target
   SET item_ids = source.item_ids
  FROM (
    SELECT sample_id,
           request_id,
           array_agg(item_id ORDER BY item_id) AS item_ids
      FROM sample_item_links
     WHERE btrim(item_id) <> ''
     GROUP BY sample_id, request_id
  ) source
 WHERE target.id = source.sample_id
   AND target.request_id = source.request_id
   AND cardinality(target.item_ids) = 0
   AND cardinality(source.item_ids) > 0;

UPDATE samples target
   SET item_ids = source.item_ids
  FROM (
    SELECT current_sample_id AS sample_id,
           request_id,
           array_agg(id ORDER BY id) AS item_ids
      FROM diagnostic_request_items
     WHERE current_sample_id IS NOT NULL
       AND btrim(id) <> ''
     GROUP BY current_sample_id, request_id
  ) source
 WHERE target.id = source.sample_id
   AND target.request_id = source.request_id
   AND cardinality(target.item_ids) = 0
   AND cardinality(source.item_ids) > 0;

-- Existing 001–008 rows without recoverable source membership remain NOT
-- VALID. Fresh/empty databases, and successfully backfilled upgrades, validate
-- the constraint below; a strict runtime open therefore never enters a
-- partially repaired relational clinical core.
DO $relational_sample_lineage_item_ids_validation$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM samples
     WHERE cardinality(item_ids) = 0
        OR array_position(item_ids, '') IS NOT NULL
  ) THEN
    ALTER TABLE samples VALIDATE CONSTRAINT samples_item_ids_nonempty;
  END IF;
END;
$relational_sample_lineage_item_ids_validation$;

UPDATE relational_schema_markers
   SET schema_version = '009_relational_sample_lineage'
 WHERE marker_key = 'RELATIONAL_CLINICAL_CORE_EXPAND_V1';

COMMENT ON CONSTRAINT samples_accession_format ON samples IS
  'Canonical accession namespace: uppercase letters/digits with optional hyphens, 3–40 characters.';
COMMENT ON CONSTRAINT samples_replacement_reason_required ON samples IS
  'A replaced sample must retain the rejection/recollection reason that caused the lineage transition.';
COMMENT ON CONSTRAINT sample_item_links_status_check ON sample_item_links IS
  'Link lifecycle is derived from sample status and cannot introduce an unrecognized state.';
COMMENT ON CONSTRAINT samples_item_ids_nonempty ON samples IS
  'Every projected sample carries at least one non-empty source item identifier; unrecoverable legacy rows remain NOT VALID until explicit backfill.';
