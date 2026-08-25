import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

export const LATEST_RUNTIME_SCHEMA_VERSION = "006_transitional_snapshot_boundary";

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

interface ApplyMigrationsOptions {
  readonly migrationDirectory: string;
  readonly logger?: MigrationLogger;
}

interface MigrationRunResult {
  readonly applied: readonly string[];
  readonly alreadyApplied: readonly string[];
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
  readonly rate_limit_schema_ready: boolean;
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
  EXISTS (
    SELECT 1
      FROM information_schema.columns
     WHERE table_schema = current_schema()
       AND table_name = 'rate_limit_buckets'
       AND column_name IN ('bucket_key', 'window_started_at', 'request_count')
     GROUP BY table_name
    HAVING count(*) = 3
  ) AS rate_limit_schema_ready,
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

function appliedMigration(value: unknown): AppliedMigration {
  if (!value || typeof value !== "object") throw new Error("MIGRATION_LEDGER_INVALID");
  const row = value as { version?: unknown; checksum?: unknown };
  if (typeof row.version !== "string" || (row.checksum !== null && typeof row.checksum !== "string")) {
    throw new Error("MIGRATION_LEDGER_INVALID");
  }
  return { version: row.version, checksum: row.checksum };
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
  const filenames = (await readdir(options.migrationDirectory))
    .filter((filename) => filename.endsWith(".sql"))
    .sort((left, right) => left.localeCompare(right));
  const migrations = await Promise.all(filenames.map(async (filename) => {
    const version = migrationVersion(filename);
    const sql = await readFile(path.join(options.migrationDirectory, filename), "utf8");
    return { version, sql, checksum: migrationChecksum(sql) };
  }));

  await client.query("SELECT pg_advisory_lock(hashtext($1))", [MIGRATION_LOCK_NAME]);
  try {
    await ensureMigrationLedger(client);
    const ledgerResult = await client.query("SELECT version, checksum FROM schema_migrations ORDER BY version");
    const ledger = new Map(ledgerResult.rows.map((row) => {
      const entry = appliedMigration(row);
      return [entry.version, entry] as const;
    }));
    const applied: string[] = [];
    const alreadyApplied: string[] = [];

    for (const migration of migrations) {
      const existing = ledger.get(migration.version);
      if (existing) {
        if (existing.checksum === null) {
          await recordLegacyChecksum(client, migration.version, migration.checksum);
        } else if (existing.checksum !== migration.checksum) {
          throw new Error(`MIGRATION_CHECKSUM_MISMATCH:${migration.version}`);
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
    || typeof row.rate_limit_schema_ready !== "boolean"
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
