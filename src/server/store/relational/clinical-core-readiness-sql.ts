import { LATEST_RUNTIME_SCHEMA_VERSION } from "../migrations";
import {
  RELATIONAL_CORE_CONSTRAINT_NAMES,
  RELATIONAL_CORE_CONSTRAINT_ROWS_SQL,
  RELATIONAL_CORE_TABLES
} from "./clinical-core-readiness";

export const RELATIONAL_CORE_MARKER = "RELATIONAL_CLINICAL_CORE_EXPAND_V1";

/**
 * Adapter-local readiness is kept beside the global runtime check so a
 * partially applied relational schema cannot enter the shadow seam.
 */
const RELATIONAL_CORE_READINESS_SQL_BASE = `SELECT
  EXISTS (
    SELECT 1
      FROM relational_schema_markers
     WHERE marker_key = $1
       AND schema_version = $2
  ) AS marker_ready,
  (
    SELECT count(*) = cardinality($3::text[])
      FROM unnest($3::text[]) AS required(table_name)
     WHERE EXISTS (
       SELECT 1
         FROM pg_class relation
         JOIN pg_namespace relation_schema ON relation_schema.oid = relation.relnamespace
        WHERE relation_schema.nspname = current_schema()
          AND relation.relname = required.table_name
          AND relation.relkind = 'r'
     )
  ) AS tables_ready,
  (
    EXISTS (
      SELECT 1
        FROM information_schema.columns
       WHERE table_schema = current_schema()
         AND table_name = 'diagnostic_requests'
         AND column_name = 'id'
         AND data_type = 'text'
         AND is_nullable = 'NO'
    )
    AND EXISTS (
      SELECT 1
        FROM information_schema.columns
       WHERE table_schema = current_schema()
         AND table_name = 'diagnostic_request_items'
         AND column_name = 'version'
         AND data_type = 'integer'
         AND is_nullable = 'NO'
    )
    AND EXISTS (
      SELECT 1
        FROM information_schema.columns
       WHERE table_schema = current_schema()
         AND table_name = 'result_versions'
         AND column_name = 'id'
         AND data_type = 'text'
         AND is_nullable = 'NO'
    )
  ) AS write_shape_ready`;

export const RELATIONAL_CORE_READINESS_SQL = `${RELATIONAL_CORE_READINESS_SQL_BASE}
  ,(
    SELECT count(*) = cardinality($4::text[])
      FROM (VALUES
        ${RELATIONAL_CORE_CONSTRAINT_ROWS_SQL}
      ) AS required(table_name, constraint_name)
     WHERE EXISTS (
       SELECT 1
        FROM pg_constraint constraint_info
        JOIN pg_class relation ON relation.oid = constraint_info.conrelid
        JOIN pg_namespace relation_schema ON relation_schema.oid = relation.relnamespace
        WHERE relation_schema.nspname = current_schema()
          AND relation.relname = required.table_name
          AND relation.relkind = 'r'
          AND constraint_info.conname = required.constraint_name
          AND (
            constraint_info.convalidated
            OR ($5::boolean AND required.constraint_name = 'samples_item_ids_nonempty')
          )
     )
  ) AS constraints_ready`;

export const RELATIONAL_SAMPLE_MEMBERSHIP_VALIDATION_SQL =
  "ALTER TABLE samples VALIDATE CONSTRAINT samples_item_ids_nonempty";
export const RELATIONAL_SAMPLE_MEMBERSHIP_REPAIR_SQL =
  "UPDATE samples SET item_ids = $2 WHERE id = $1 AND request_id = $3 AND version = $4 AND cardinality(item_ids) = 0";

export function relationalCoreReadinessValues(allowUnvalidatedSampleMembership: boolean): unknown[] {
  return [
    RELATIONAL_CORE_MARKER,
    LATEST_RUNTIME_SCHEMA_VERSION,
    [...RELATIONAL_CORE_TABLES],
    [...RELATIONAL_CORE_CONSTRAINT_NAMES],
    allowUnvalidatedSampleMembership
  ];
}
