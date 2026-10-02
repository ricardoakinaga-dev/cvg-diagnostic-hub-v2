import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

export const LATEST_RUNTIME_SCHEMA_VERSION = "011_outbox_dead_letter";

/**
 * The runtime schema is intentionally advanced by one ordered migration at a
 * time. Keep this manifest next to the runner so a renamed, missing, or
 * accidentally added migration cannot silently become a new baseline.
 */
export const RUNTIME_MIGRATION_VERSIONS = [
  "001_initial",
  "002_outbox_processing",
  "003_runtime_integrity",
  "004_outbox_claim_ownership",
  "005_rate_limit_buckets",
  "006_transitional_snapshot_boundary",
  "007_relational_clinical_core",
  "008_outbox_routing",
  "009_relational_sample_lineage",
  "010_relational_backfill_control",
  "011_outbox_dead_letter"
] as const;

/**
 * Immutable source checksums for the shipped baseline. The database ledger
 * protects already-applied migrations; this manifest also catches an edited
 * migration before a fresh bootstrap can accept it as a new baseline.
 */
export const RUNTIME_MIGRATION_CHECKSUMS: Readonly<Record<(typeof RUNTIME_MIGRATION_VERSIONS)[number], string>> = {
  "001_initial": "b60bb12dcbbb4fbabdcdd0e1f93644baa9de2997f96174d1997576c2fbdfab76",
  "002_outbox_processing": "7f1d2cd32bcde518cc810a111d059b8da72ba468ea4ba8b73a94ffc07bce0e6b",
  "003_runtime_integrity": "da4e13aad775a23a583d9162752767ed3890d2cfe76300356caeca9b9ada396f",
  "004_outbox_claim_ownership": "664ddfd7abd2a68368e3bd41bfd5f8b7cf85470190dfaf1b9d5f2b374760428a",
  "005_rate_limit_buckets": "01bb59f2df6c27be7802061b7a81dea92aa50b65210e0eae4b895f59d54b6f57",
  "006_transitional_snapshot_boundary": "6ff5c971e30a7306673f692d2f53d16d0756a97055a18aa9f1e8c1efd7665057",
  "007_relational_clinical_core": "59799c7880140036e500160bae84bd21bceb83894b7a98c6568e6577c5d29767",
  "008_outbox_routing": "3bf712b2b2bcccb1a51a1a03fd22a4a349c9e4362b75a4e0e42f70eca1a08eff",
  "009_relational_sample_lineage": "06e13b2d4f40c7e7cad5f46a87dd529e695154a247ebf63bbf3432509a32644c",
  "010_relational_backfill_control": "ff9cac6a830291e189f2997cfb9d95415eef5141fd36aaa4c56ffc331ddb6d1f",
  "011_outbox_dead_letter": "893e8238af26721ae74f66c8e3ef2d1241931932fac7a9a533bfd349b44bd073"
};

const MIGRATION_LOCK_NAME = "cvg_schema_migrations";
const MIGRATION_FILENAME = /^\d{3}_[a-z0-9_-]+\.sql$/;

interface SqlResult {
  readonly rows: readonly unknown[];
  readonly rowCount?: number | null;
}

export interface SqlQueryable {
  query(text: string, values?: unknown[]): Promise<SqlResult>;
}

interface MigrationLogger {
  info(message: string): void;
}

export interface ApplyMigrationsOptions {
  readonly migrationDirectory: string;
  readonly logger?: MigrationLogger;
}

export interface MigrationRunResult {
  readonly applied: readonly string[];
  readonly alreadyApplied: readonly string[];
}

export interface MigrationDefinition {
  readonly filename: string;
  readonly version: string;
  readonly sql: string;
  readonly checksum: string;
}

interface AppliedMigration {
  readonly version: string;
  readonly checksum: string | null;
}

interface RuntimeSchemaRow {
  readonly state_exists: boolean;
  readonly latest_migration_applied: boolean;
  readonly runtime_state_shape_ready: boolean;
  readonly migration_ledger_shape_ready: boolean;
  readonly runtime_state_payload_ready: boolean;
  readonly audit_append_only_ready: boolean;
  readonly audit_truncate_guard_ready: boolean;
  readonly event_projection_ready: boolean;
  readonly outbox_claim_ownership_ready: boolean;
  readonly outbox_routing_ready: boolean;
  readonly outbox_dead_letter_ready: boolean;
  readonly rate_limit_schema_ready: boolean;
  readonly relational_clinical_core_ready: boolean;
  readonly transitional_storage_boundary_ready: boolean;
  readonly invalidation_trigger_ready: boolean;
}

const RUNTIME_SCHEMA_READINESS_SQL = `SELECT
  EXISTS (SELECT 1 FROM cvg_runtime_state WHERE id = 1) AS state_exists,
  COALESCE((SELECT max(version) = $1 FROM schema_migrations), false) AS latest_migration_applied,
  (SELECT count(*) = 2
     FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND table_name = 'cvg_runtime_state'
      AND ((column_name = 'state' AND data_type = 'jsonb' AND is_nullable = 'NO')
        OR (column_name = 'version' AND data_type = 'bigint' AND is_nullable = 'NO'))
  ) AS runtime_state_shape_ready,
  EXISTS (
    SELECT 1
      FROM information_schema.columns
     WHERE table_schema = current_schema()
       AND table_name = 'schema_migrations'
       AND column_name = 'checksum'
       AND data_type = 'text'
       AND is_nullable = 'NO'
  ) AND NOT EXISTS (SELECT 1 FROM schema_migrations WHERE checksum IS NULL) AS migration_ledger_shape_ready,
  COALESCE((
    SELECT jsonb_typeof(state) = 'object'
       AND jsonb_typeof(state->'auditEvents') = 'array'
       AND jsonb_typeof(state->'outbox') = 'array'
       AND jsonb_typeof(state->'users') = 'array'
       AND jsonb_typeof(state->'sessions') = 'array'
       AND jsonb_typeof(state->'protocolSequence') = 'number'
      FROM cvg_runtime_state
     WHERE id = 1
  ), false) AS runtime_state_payload_ready,
  EXISTS (
    SELECT 1
      FROM pg_trigger
     WHERE tgrelid = 'audit_events'::regclass
       AND tgname = 'audit_events_append_only_guard'
       AND tgenabled = 'O'
       AND NOT tgisinternal
       AND tgtype = 27
       AND tgfoid = 'reject_audit_event_mutation()'::regprocedure
       AND pg_get_functiondef(tgfoid) ILIKE '%AUDIT_EVENTS_ARE_APPEND_ONLY%'
  ) AS audit_append_only_ready,
  EXISTS (
    SELECT 1
      FROM pg_trigger
     WHERE tgrelid = 'audit_events'::regclass
       AND tgname = 'audit_events_truncate_guard'
       AND tgenabled = 'O'
       AND NOT tgisinternal
       AND tgtype = 34
       AND tgfoid = 'reject_audit_event_mutation()'::regprocedure
       AND pg_get_functiondef(tgfoid) ILIKE '%AUDIT_EVENTS_ARE_APPEND_ONLY%'
  ) AS audit_truncate_guard_ready,
  COALESCE((
    SELECT jsonb_array_length(state->'auditEvents') = (SELECT count(*) FROM audit_events)
       AND jsonb_array_length(state->'outbox') = (SELECT count(*) FROM outbox_messages)
       AND NOT EXISTS (
         SELECT 1
           FROM audit_events relational
          WHERE NOT EXISTS (
            SELECT 1
              FROM jsonb_array_elements(state->'auditEvents') snapshot
             WHERE snapshot->>'id' = relational.id
          )
       )
       AND NOT EXISTS (
         SELECT 1
           FROM outbox_messages relational
          WHERE NOT EXISTS (
            SELECT 1
              FROM jsonb_array_elements(state->'outbox') snapshot
             WHERE snapshot->>'id' = relational.id
          )
       )
      FROM cvg_runtime_state
     WHERE id = 1
  ), false) AS event_projection_ready,
  EXISTS (
    SELECT 1
      FROM information_schema.columns
     WHERE table_schema = current_schema()
       AND table_name = 'outbox_messages'
       AND column_name = 'claim_token'
  ) AND EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conrelid = 'outbox_messages'::regclass
       AND conname = 'outbox_messages_claim_token_unique'
  ) AS outbox_claim_ownership_ready,
  (
    (SELECT count(*) = 2
       FROM information_schema.columns
      WHERE table_schema = current_schema()
        AND table_name = 'outbox_messages'
        AND ((column_name = 'consumer_type' AND data_type = 'text' AND is_nullable = 'NO')
          OR (column_name = 'routing_key' AND data_type = 'text' AND is_nullable = 'NO')))
    AND EXISTS (
      SELECT 1
        FROM pg_constraint
       WHERE conrelid = 'outbox_messages'::regclass
         AND conname = 'outbox_messages_consumer_type_check'
    )
    AND EXISTS (
      SELECT 1
        FROM pg_constraint
       WHERE conrelid = 'outbox_messages'::regclass
         AND conname = 'outbox_messages_route_consistency_check'
    )
  ) AS outbox_routing_ready,
  (
    (SELECT count(*) = 4
       FROM information_schema.columns
      WHERE table_schema = current_schema()
        AND table_name = 'outbox_messages'
        AND column_name IN ('dead_lettered_at', 'discarded_at', 'discarded_by', 'discard_reason'))
    AND EXISTS (
      SELECT 1
        FROM pg_constraint
       WHERE conrelid = 'outbox_messages'::regclass
         AND conname = 'outbox_messages_status_check'
         AND pg_get_constraintdef(oid) ILIKE '%DISCARDED%'
    )
  ) AS outbox_dead_letter_ready,
  EXISTS (
    SELECT 1
      FROM information_schema.columns
     WHERE table_schema = current_schema()
       AND table_name = 'rate_limit_buckets'
       AND column_name IN ('bucket_key', 'window_started_at', 'request_count')
     GROUP BY table_name
    HAVING count(*) = 3
  ) AS rate_limit_schema_ready,
  (
    EXISTS (
      SELECT 1
        FROM relational_schema_markers
       WHERE marker_key = 'RELATIONAL_CLINICAL_CORE_EXPAND_V1'
         AND schema_version = $1
    )
    AND EXISTS (
      SELECT 1
        FROM pg_class marker_table
        JOIN pg_namespace marker_schema ON marker_schema.oid = marker_table.relnamespace
       WHERE marker_schema.nspname = current_schema()
         AND marker_table.relname = 'relational_schema_markers'
         AND marker_table.relkind = 'r'
         AND obj_description(marker_table.oid, 'pg_class') ILIKE '%RELATIONAL_CLINICAL_CORE_EXPAND_V1%'
    )
    AND NOT EXISTS (
      SELECT 1
        FROM unnest(ARRAY[
          'relational_schema_markers',
          'departments',
          'roles',
          'users',
          'user_roles',
          'sessions',
          'auth_identities',
          'owners',
          'patients',
          'patient_owners',
          'external_references',
          'encounters',
          'admissions',
          'diagnostic_services',
          'service_instructions',
          'sla_policies',
          'critical_result_policies',
          'reason_codes',
          'request_code_sequences',
          'diagnostic_requests',
          'diagnostic_request_items',
          'samples',
          'sample_item_links',
          'procedures',
          'procedure_schedules',
          'results',
          'result_versions',
          'result_components',
          'attachments',
          'notifications',
          'notification_deliveries',
          'acknowledgements',
          'idempotency_keys'
        ]::text[]) AS required(table_name)
       WHERE NOT EXISTS (
         SELECT 1
           FROM pg_class relation
           JOIN pg_namespace relation_schema ON relation_schema.oid = relation.relnamespace
          WHERE relation_schema.nspname = current_schema()
            AND relation.relname = required.table_name
            AND relation.relkind = 'r'
       )
    )
    AND NOT EXISTS (
      SELECT 1
        FROM (VALUES
          ('diagnostic_requests', 'id', 'text', 'NO'),
          ('diagnostic_requests', 'request_code', 'character varying', 'NO'),
          ('diagnostic_requests', 'patient_id', 'text', 'NO'),
          ('diagnostic_requests', 'encounter_id', 'text', 'NO'),
          ('diagnostic_request_items', 'request_id', 'text', 'NO'),
          ('diagnostic_request_items', 'service_id', 'text', 'NO'),
          ('diagnostic_request_items', 'due_at', 'timestamp with time zone', 'NO'),
          ('samples', 'accession_code', 'text', 'NO'),
          ('results', 'item_id', 'text', 'NO'),
          ('result_versions', 'result_id', 'text', 'NO'),
          ('result_versions', 'sequence', 'integer', 'NO'),
          ('notifications', 'recipient_user_id', 'text', 'NO'),
          ('idempotency_keys', 'payload_hash', 'text', 'NO')
        ) AS required(table_name, column_name, data_type, is_nullable)
       WHERE NOT EXISTS (
         SELECT 1
           FROM information_schema.columns column_info
          WHERE column_info.table_schema = current_schema()
            AND column_info.table_name = required.table_name
            AND column_info.column_name = required.column_name
            AND column_info.data_type = required.data_type
            AND column_info.is_nullable = required.is_nullable
       )
    )
    AND NOT EXISTS (
      SELECT 1
        FROM (VALUES
          ('diagnostic_requests', 'diagnostic_requests_request_code_key', 'u', NULL),
          ('diagnostic_requests', 'diagnostic_requests_encounter_patient_fk', 'f', NULL),
          ('diagnostic_request_items', 'diagnostic_request_items_request_fk', 'f', NULL),
          ('samples', 'samples_accession_code_key', 'u', NULL),
          ('samples', 'samples_replaces_same_request_fk', 'f', NULL),
          ('samples', 'samples_rejection_reason_required', 'c', '%status%REJECTED%rejection_reason_id%'),
          ('samples', 'samples_accession_format', 'c', '%accession_code%^[A-Z0-9][A-Z0-9-]{2,39}$%'),
          ('samples', 'samples_replacement_reason_required', 'c', '%status%REPLACED%rejection_reason_id%'),
          ('sample_item_links', 'sample_item_links_sample_request_fk', 'f', NULL),
          ('sample_item_links', 'sample_item_links_item_request_fk', 'f', NULL),
          ('sample_item_links', 'sample_item_links_sample_item_key', 'u', NULL),
          ('sample_item_links', 'sample_item_links_status_check', 'c', '%link_status%ACTIVE%REJECTED%REPLACED%'),
          ('results', 'results_item_key', 'u', NULL),
          ('result_versions', 'result_versions_result_sequence_key', 'u', NULL),
          ('notifications', 'notifications_recipient_dedupe_key', 'u', NULL),
          ('idempotency_keys', 'idempotency_keys_actor_scope_key_key', 'u', NULL)
        ) AS required(table_name, constraint_name, constraint_type, constraint_definition)
       WHERE NOT EXISTS (
         SELECT 1
           FROM pg_constraint constraint_info
          WHERE constraint_info.conrelid = to_regclass(format('%I.%I', current_schema(), required.table_name))
            AND constraint_info.conname = required.constraint_name
            AND constraint_info.contype = required.constraint_type
            AND (
              required.constraint_definition IS NULL
              OR (
                constraint_info.convalidated
                AND pg_get_constraintdef(constraint_info.oid) ILIKE required.constraint_definition
              )
            )
       )
    )
  ) AS relational_clinical_core_ready,
  EXISTS (
    SELECT 1
      FROM runtime_storage_boundaries
     WHERE boundary_key = 'runtime-jsonb-snapshot-v1'
       AND authoritative_store = 'cvg_runtime_state'
       AND read_mode = 'SNAPSHOT'
       AND write_mode = 'SNAPSHOT'
       AND status = 'TRANSITIONAL'
       AND reconciliation_mode = 'CONTINUOUS'
       AND contract_version = 'StoreState-v1'
  ) AS transitional_storage_boundary_ready,
  EXISTS (
    SELECT 1
      FROM pg_trigger
     WHERE tgrelid = 'cvg_runtime_state'::regclass
       AND tgname = 'cvg_runtime_state_invalidation'
       AND tgenabled = 'O'
       AND NOT tgisinternal
       AND tgtype = 17
       AND tgfoid = 'notify_runtime_state_changed()'::regprocedure
       AND pg_get_functiondef(tgfoid) ILIKE '%pg_notify%'
       AND pg_get_functiondef(tgfoid) ILIKE '%cvg_runtime_state_changed%'
       AND pg_get_functiondef(tgfoid) ILIKE '%NEW.version%'
  ) AS invalidation_trigger_ready`;

export function migrationVersion(filename: string): string {
  if (!MIGRATION_FILENAME.test(filename)) throw new Error(`Nome de migration inválido: ${filename}`);
  return filename.slice(0, -4);
}

export function migrationChecksum(sql: string): string {
  return createHash("sha256").update(sql, "utf8").digest("hex");
}

function migrationNumber(version: string): number {
  return Number(version.slice(0, 3));
}

/**
 * Validates the filesystem migration set without connecting to PostgreSQL.
 * The default rule accepts a contiguous set beginning at 001 so small test
 * directories can exercise the runner; callers validating the production
 * bundle pass RUNTIME_MIGRATION_VERSIONS for the exact shipped contract.
 */
export function validateMigrationSet(
  migrations: readonly MigrationDefinition[],
  expectedVersions?: readonly string[]
): readonly MigrationDefinition[] {
  if (migrations.length === 0) throw new Error("MIGRATION_SET_EMPTY");

  const ordered = [...migrations].sort((left, right) => left.filename.localeCompare(right.filename));
  const versions = ordered.map((migration) => migration.version);
  const seen = new Set<string>();
  for (const version of versions) {
    if (seen.has(version)) throw new Error(`MIGRATION_VERSION_DUPLICATE:${version}`);
    seen.add(version);
  }

  if (expectedVersions) {
    if (versions.length !== expectedVersions.length || versions.some((version, index) => version !== expectedVersions[index])) {
      throw new Error(`MIGRATION_SET_MISMATCH:expected=${expectedVersions.join(",")};actual=${versions.join(",")}`);
    }
  } else {
    const firstNumber = migrationNumber(versions[0] ?? "");
    if (firstNumber !== 1) throw new Error(`MIGRATION_ORDER_INVALID:expected=001;actual=${versions[0] ?? ""}`);
    for (let index = 1; index < ordered.length; index += 1) {
      const previous = migrationNumber(versions[index - 1] ?? "");
      const current = migrationNumber(versions[index] ?? "");
      if (current !== previous + 1) {
        throw new Error(`MIGRATION_ORDER_INVALID:expected=${String(previous + 1).padStart(3, "0")};actual=${versions[index] ?? ""}`);
      }
    }
  }

  for (const migration of ordered) {
    if (migrationChecksum(migration.sql) !== migration.checksum) {
      throw new Error(`MIGRATION_CHECKSUM_INVALID:${migration.version}`);
    }
  }
  return ordered;
}

export function validateRuntimeMigrationSet(
  migrations: readonly MigrationDefinition[]
): readonly MigrationDefinition[] {
  const ordered = validateMigrationSet(migrations, RUNTIME_MIGRATION_VERSIONS);
  for (const migration of ordered) {
    const expectedChecksum = RUNTIME_MIGRATION_CHECKSUMS[migration.version as (typeof RUNTIME_MIGRATION_VERSIONS)[number]];
    if (expectedChecksum !== migration.checksum) {
      throw new Error(`MIGRATION_CHECKSUM_MISMATCH:${migration.version}`);
    }
  }
  return ordered;
}

export async function readMigrationSet(
  migrationDirectory: string,
  expectedVersions?: readonly string[]
): Promise<readonly MigrationDefinition[]> {
  const filenames = (await readdir(migrationDirectory))
    .filter((filename) => filename.endsWith(".sql"))
    .sort((left, right) => left.localeCompare(right));
  const migrations = await Promise.all(filenames.map(async (filename) => {
    const version = migrationVersion(filename);
    const sql = await readFile(path.join(migrationDirectory, filename), "utf8");
    return { filename, version, sql, checksum: migrationChecksum(sql) };
  }));
  return validateMigrationSet(migrations, expectedVersions);
}

function appliedMigration(value: unknown): AppliedMigration {
  if (!value || typeof value !== "object") throw new Error("MIGRATION_LEDGER_INVALID");
  const row = value as { version?: unknown; checksum?: unknown };
  if (
    typeof row.version !== "string"
    || (row.checksum !== null && typeof row.checksum !== "string")
    || (typeof row.checksum === "string" && !/^[a-f0-9]{64}$/i.test(row.checksum))
  ) {
    throw new Error("MIGRATION_LEDGER_INVALID");
  }
  return { version: row.version, checksum: row.checksum };
}

function assertMigrationLedgerCompatible(
  migrations: readonly MigrationDefinition[],
  ledgerRows: readonly AppliedMigration[]
): Map<string, AppliedMigration> {
  const ledger = new Map<string, AppliedMigration>();
  for (const entry of ledgerRows) {
    if (ledger.has(entry.version)) throw new Error(`MIGRATION_LEDGER_DUPLICATE:${entry.version}`);
    ledger.set(entry.version, entry);
  }

  const migrationIndexes = new Map(migrations.map((migration, index) => [migration.version, index] as const));
  for (const entry of ledgerRows) {
    if (!migrationIndexes.has(entry.version)) throw new Error(`MIGRATION_VERSION_UNKNOWN:${entry.version}`);
  }

  let highestAppliedIndex = -1;
  for (const entry of ledgerRows) {
    highestAppliedIndex = Math.max(highestAppliedIndex, migrationIndexes.get(entry.version) ?? -1);
  }
  for (let index = 0; index <= highestAppliedIndex; index += 1) {
    const migration = migrations[index];
    if (migration && !ledger.has(migration.version)) {
      throw new Error(`MIGRATION_ORDER_GAP:${migration.version}`);
    }
  }
  return ledger;
}

async function ensureMigrationLedger(client: SqlQueryable): Promise<void> {
  await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version text PRIMARY KEY,
    checksum text,
    applied_at timestamptz NOT NULL DEFAULT now()
  )`);
  await client.query("ALTER TABLE schema_migrations ADD COLUMN IF NOT EXISTS checksum text");
}

async function recordLegacyChecksum(client: SqlQueryable, version: string, checksum: string): Promise<void> {
  const result = await client.query(
    "UPDATE schema_migrations SET checksum = $2 WHERE version = $1 AND checksum IS NULL",
    [version, checksum]
  );
  if (result.rowCount !== 1) throw new Error(`MIGRATION_CHECKSUM_BACKFILL_FAILED:${version}`);
}

async function applyMigration(client: SqlQueryable, version: string, checksum: string, sql: string): Promise<void> {
  await client.query("BEGIN");
  try {
    await client.query(sql);
    await client.query("INSERT INTO schema_migrations (version, checksum) VALUES ($1, $2)", [version, checksum]);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  }
}

export async function applyMigrations(client: SqlQueryable, options: ApplyMigrationsOptions): Promise<MigrationRunResult> {
  const logger = options.logger ?? console;
  const migrations = await readMigrationSet(options.migrationDirectory);

  await client.query("SELECT pg_advisory_lock(hashtext($1))", [MIGRATION_LOCK_NAME]);
  try {
    await ensureMigrationLedger(client);
    const ledgerResult = await client.query("SELECT version, checksum FROM schema_migrations ORDER BY version");
    const parsedLedger = ledgerResult.rows.map((row) => appliedMigration(row));
    const ledger = assertMigrationLedgerCompatible(migrations, parsedLedger);

    // Preflight every immutable checksum before executing any pending SQL. A
    // mismatch in a later migration must not leave earlier migrations applied
    // during the same invocation.
    for (const migration of migrations) {
      const existing = ledger.get(migration.version);
      if (existing && existing.checksum !== null && existing.checksum !== migration.checksum) {
        throw new Error(`MIGRATION_CHECKSUM_MISMATCH:${migration.version}`);
      }
    }

    const applied: string[] = [];
    const alreadyApplied: string[] = [];

    for (const migration of migrations) {
      const existing = ledger.get(migration.version);
      if (existing) {
        if (existing.checksum === null) {
          await recordLegacyChecksum(client, migration.version, migration.checksum);
        }
        alreadyApplied.push(migration.version);
        logger.info(`Migration ${migration.version} já aplicada.`);
        continue;
      }

      await applyMigration(client, migration.version, migration.checksum, migration.sql);
      applied.push(migration.version);
      logger.info(`Migration ${migration.version} aplicada.`);
    }

    return { applied, alreadyApplied };
  } finally {
    await client.query("SELECT pg_advisory_unlock(hashtext($1))", [MIGRATION_LOCK_NAME]);
  }
}

function runtimeSchemaRow(value: unknown): RuntimeSchemaRow | undefined {
  if (!value || typeof value !== "object") return undefined;
  const row = value as Partial<RuntimeSchemaRow>;
  if (
    typeof row.state_exists !== "boolean"
    || typeof row.latest_migration_applied !== "boolean"
    || typeof row.runtime_state_shape_ready !== "boolean"
    || typeof row.migration_ledger_shape_ready !== "boolean"
    || typeof row.runtime_state_payload_ready !== "boolean"
    || typeof row.audit_append_only_ready !== "boolean"
    || typeof row.audit_truncate_guard_ready !== "boolean"
    || typeof row.event_projection_ready !== "boolean"
    || typeof row.outbox_claim_ownership_ready !== "boolean"
    || typeof row.outbox_routing_ready !== "boolean"
    || typeof row.outbox_dead_letter_ready !== "boolean"
    || typeof row.rate_limit_schema_ready !== "boolean"
    || typeof row.relational_clinical_core_ready !== "boolean"
    || typeof row.transitional_storage_boundary_ready !== "boolean"
    || typeof row.invalidation_trigger_ready !== "boolean"
  ) return undefined;
  return row as RuntimeSchemaRow;
}

export async function assertRuntimeSchemaReady(client: SqlQueryable): Promise<void> {
  try {
    const result = await client.query(RUNTIME_SCHEMA_READINESS_SQL, [LATEST_RUNTIME_SCHEMA_VERSION]);
    const row = runtimeSchemaRow(result.rows[0]);
    if (!row) throw new Error("POSTGRES_RUNTIME_SCHEMA_NOT_READY:invalid_readiness_row");
    const missing = Object.entries(row).filter(([, ready]) => !ready).map(([key]) => key);
    if (missing.length > 0) throw new Error(`POSTGRES_RUNTIME_SCHEMA_NOT_READY:${missing.join(",")}`);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("POSTGRES_RUNTIME_SCHEMA_NOT_READY")) throw error;
    throw new Error("POSTGRES_RUNTIME_SCHEMA_NOT_READY", { cause: error });
  }
}
