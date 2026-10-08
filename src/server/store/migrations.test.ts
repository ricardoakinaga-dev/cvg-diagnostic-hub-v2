import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  LATEST_RUNTIME_SCHEMA_VERSION,
  RUNTIME_MIGRATION_CHECKSUMS,
  RUNTIME_MIGRATION_VERSIONS,
  applyMigrations,
  assertRuntimeSchemaReady,
  isCoordinatedCutover,
  migrationChecksum,
  migrationVersion,
  readMigrationSet,
  validateMigrationSet,
  validateRuntimeMigrationSet
} from "./migrations";

interface RecordedQuery {
  readonly text: string;
  readonly values: readonly unknown[];
}

interface AppliedMigrationRow {
  readonly version: string;
  readonly checksum: string | null;
}

function fakeClient(applied: readonly AppliedMigrationRow[] = [], otherSessions = 0) {
  const queries: RecordedQuery[] = [];
  const query = vi.fn(async (text: string, values: readonly unknown[] = []) => {
    queries.push({ text, values });
    if (text.includes("SELECT version, checksum FROM schema_migrations")) {
      return { rows: [...applied], rowCount: applied.length };
    }
    if (text.includes("FROM pg_stat_activity")) return { rows: [{ other_sessions: otherSessions }], rowCount: 1 };
    return { rows: [], rowCount: 1 };
  });
  return { client: { query }, queries, query };
}

async function withMigrationDirectory(
  files: Readonly<Record<string, string>>,
  operation: (directory: string) => Promise<void>
): Promise<void> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "cvg-migrations-"));
  try {
    await Promise.all(Object.entries(files).map(([filename, sql]) => writeFile(path.join(directory, filename), sql, "utf8")));
    await operation(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

describe("database migration runner", () => {
  it("accepts only canonical migration filenames", () => {
    expect(migrationVersion("003_runtime_integrity.sql")).toBe("003_runtime_integrity");
    expect(() => migrationVersion("03_runtime_integrity.sql")).toThrow("Nome de migration inválido");
    expect(() => migrationVersion("../003_runtime_integrity.sql")).toThrow("Nome de migration inválido");
    expect(() => migrationVersion("003_Runtime.sql")).toThrow("Nome de migration inválido");
  });

  it("produces a deterministic SHA-256 checksum over the exact migration bytes", () => {
    expect(migrationChecksum("SELECT 1;\n")).toMatch(/^[a-f0-9]{64}$/);
    expect(migrationChecksum("SELECT 1;\n")).toBe(migrationChecksum("SELECT 1;\n"));
    expect(migrationChecksum("SELECT 1;\n")).not.toBe(migrationChecksum("SELECT 1;"));
  });

  it("validates the production migration set, order, and exact file checksums without PostgreSQL", async () => {
    const migrations = validateRuntimeMigrationSet(
      await readMigrationSet(path.resolve(process.cwd(), "db/migrations"), RUNTIME_MIGRATION_VERSIONS)
    );

    expect(migrations.map((migration) => migration.version)).toEqual([...RUNTIME_MIGRATION_VERSIONS]);
    expect(migrations).toHaveLength(RUNTIME_MIGRATION_VERSIONS.length);
    expect(Object.fromEntries(migrations.map((migration) => [migration.version, migration.checksum]))).toEqual(RUNTIME_MIGRATION_CHECKSUMS);
  });

  it("rejects a source migration edited after the shipped checksum manifest", async () => {
    const migrations = await readMigrationSet(path.resolve(process.cwd(), "db/migrations"), RUNTIME_MIGRATION_VERSIONS);
    const editedSql = `${migrations[0]?.sql}\n-- edited after release\n`;
    const edited = migrations.map((migration, index) => index === 0
      ? { ...migration, sql: editedSql, checksum: migrationChecksum(editedSql) }
      : migration);

    expect(() => validateRuntimeMigrationSet(edited)).toThrow("MIGRATION_CHECKSUM_MISMATCH:001_initial");
  });

  it("rejects a missing migration number or duplicate version before database access", () => {
    const definition = (filename: string) => {
      const version = migrationVersion(filename);
      const sql = `SELECT '${version}';`;
      return { filename, version, sql, checksum: migrationChecksum(sql) };
    };

    expect(() => validateMigrationSet([
      definition("001_first.sql"),
      definition("003_third.sql")
    ])).toThrow("MIGRATION_ORDER_INVALID:expected=002;actual=003_third");

    expect(() => validateMigrationSet([
      definition("001_first.sql"),
      definition("001_first.sql")
    ])).toThrow("MIGRATION_VERSION_DUPLICATE:001_first");
  });

  it("registers the relational clinical core as the canonical 007 migration", async () => {
    const filename = "007_relational_clinical_core.sql";
    const sql = await readFile(path.resolve(process.cwd(), "db/migrations", filename), "utf8");

    expect(migrationVersion(filename)).toBe("007_relational_clinical_core");
    expect(LATEST_RUNTIME_SCHEMA_VERSION).toBe("016_outbox_whatsapp_route");
    expect(migrationChecksum(sql)).toMatch(/^[a-f0-9]{64}$/);
    expect(sql).toMatch(/RELATIONAL_CLINICAL_CORE_EXPAND_V1/);
  });

  it("registers the additive sample/accession lineage constraints as migration 009", async () => {
    const filename = "009_relational_sample_lineage.sql";
    const sql = await readFile(path.resolve(process.cwd(), "db/migrations", filename), "utf8");

    expect(migrationVersion(filename)).toBe("009_relational_sample_lineage");
    expect(sql).toMatch(/samples_accession_format[\s\S]*CHECK \(accession_code ~ '\^\[A-Z0-9\]\[A-Z0-9-\]\{2,39\}\$'/i);
    expect(sql).toMatch(/samples_replacement_reason_required[\s\S]*CHECK \(status <> 'REPLACED' OR rejection_reason_id IS NOT NULL\)/i);
    expect(sql).toMatch(/sample_item_links_status_check[\s\S]*CHECK \(link_status IN \('ACTIVE', 'REJECTED', 'REPLACED'\)\)/i);
    expect(sql).toMatch(/ADD COLUMN IF NOT EXISTS item_ids text\[\]/i);
    expect(sql).toMatch(/samples_item_ids_nonempty[\s\S]*cardinality\(item_ids\) > 0/i);
    expect(sql).toMatch(/CHECK \([\s\S]*\)\s+NOT VALID/i);
    expect(sql).toMatch(/VALIDATE CONSTRAINT samples_accession_format/i);
    expect(sql).toMatch(/VALIDATE CONSTRAINT sample_item_links_status_check/i);
    expect(sql).toMatch(/VALIDATE CONSTRAINT samples_item_ids_nonempty/i);
    expect(sql).toMatch(/schema_version = '009_relational_sample_lineage'/i);
    expect(sql).not.toMatch(/\b(?:DROP TABLE|DROP COLUMN|TRUNCATE TABLE|DELETE FROM)\b/i);
  });

  it("holds one session advisory lock across discovery and all migration transactions", async () => {
    await withMigrationDirectory({ "001_first.sql": "SELECT 'first';", "002_second.sql": "SELECT 'second';" }, async (directory) => {
      const { client, queries } = fakeClient();

      const result = await applyMigrations(client, { migrationDirectory: directory, logger: { info: vi.fn() } });

      expect(result).toEqual({ applied: ["001_first", "002_second"], alreadyApplied: [] });
      expect(queries[0]).toEqual({ text: "SELECT pg_advisory_lock(hashtext($1))", values: ["cvg_schema_migrations"] });
      expect(queries.at(-1)).toEqual({ text: "SELECT pg_advisory_unlock(hashtext($1))", values: ["cvg_schema_migrations"] });
      const unlockIndex = queries.findIndex(({ text }) => text.includes("pg_advisory_unlock"));
      const finalCommitIndex = queries.map(({ text }) => text).lastIndexOf("COMMIT");
      expect(unlockIndex).toBeGreaterThan(finalCommitIndex);
      expect(queries.filter(({ text }) => text === "BEGIN")).toHaveLength(2);
    });
  });

  it("bootstraps an empty ledger through all production migrations in order", async () => {
    const migrationDirectory = path.resolve(process.cwd(), "db/migrations");
    const migrations = await readMigrationSet(migrationDirectory, RUNTIME_MIGRATION_VERSIONS);
    const { client, queries } = fakeClient();

    const result = await applyMigrations(client, { migrationDirectory, logger: { info: vi.fn() } });

    expect(result).toEqual({ applied: [...RUNTIME_MIGRATION_VERSIONS], alreadyApplied: [] });
    expect(queries.filter(({ text }) => text === "BEGIN")).toHaveLength(RUNTIME_MIGRATION_VERSIONS.length);
    expect(queries.filter(({ text }) => text.startsWith("INSERT INTO schema_migrations")).map(({ values }) => values)).toEqual(
      migrations.map((migration) => [migration.version, migration.checksum])
    );
  });

  it("upgrades a populated baseline by applying only the newest migration", async () => {
    const migrationDirectory = path.resolve(process.cwd(), "db/migrations");
    const migrations = await readMigrationSet(migrationDirectory, RUNTIME_MIGRATION_VERSIONS);
    const baseline = migrations.slice(0, -1).map(({ version, checksum }) => ({ version, checksum }));
    const { client, queries } = fakeClient(baseline);

    const result = await applyMigrations(client, { migrationDirectory, logger: { info: vi.fn() } });

    expect(result).toEqual({
      applied: ["016_outbox_whatsapp_route"],
      alreadyApplied: baseline.map(({ version }) => version)
    });
    expect(queries.filter(({ text }) => text === "BEGIN")).toHaveLength(1);
    expect(queries).toContainEqual({
      text: migrations.at(-1)?.sql,
      values: []
    });
  });

  it("advances the relational readiness marker with the dead-letter migration", async () => {
    const sql = await readFile(path.resolve(process.cwd(), "db/migrations", "011_outbox_dead_letter.sql"), "utf8");

    expect(sql).toMatch(/UPDATE relational_schema_markers[\s\S]*011_outbox_dead_letter/i);
  });

  it("keeps session liveness in its own indexed table outside the snapshot", async () => {
    const filename = "012_session_activity.sql";
    const sql = await readFile(path.resolve(process.cwd(), "db/migrations", filename), "utf8");

    expect(migrationVersion(filename)).toBe("012_session_activity");
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS session_activity\s*\(/i);
    expect(sql).toMatch(/session_id text PRIMARY KEY/i);
    expect(sql).toMatch(/last_seen_at timestamptz NOT NULL/i);
    expect(sql).toMatch(/UPDATE relational_schema_markers[\s\S]*012_session_activity/i);
    // Sessions created before the migration get one idle window at deploy
    // instead of expiring on their first request (review A-05).
    expect(sql).toMatch(/INSERT INTO session_activity[\s\S]*jsonb_array_elements\(state->'sessions'\)/i);
    expect(sql).not.toMatch(/\b(?:DROP TABLE|DROP COLUMN|TRUNCATE TABLE|DELETE FROM)\b/i);
  });

  it("registers durable, shadow-only relational backfill control metadata as migration 010", async () => {
    const filename = "010_relational_backfill_control.sql";
    const sql = await readFile(path.resolve(process.cwd(), "db/migrations", filename), "utf8");

    expect(migrationVersion(filename)).toBe("010_relational_backfill_control");
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS relational_backfill_runs\s*\(/i);
    expect(sql).toMatch(/source_snapshot_version bigint NOT NULL/i);
    expect(sql).toMatch(/source_snapshot_hash text NOT NULL/i);
    expect(sql).toMatch(/status IN \('RUNNING', 'COMPLETED', 'FAILED'\)/i);
    expect(sql).toMatch(/target_authority = 'RELATIONAL_SHADOW'/i);
    expect(sql).toMatch(/UPDATE relational_schema_markers[\s\S]*010_relational_backfill_control/i);
    expect(sql).not.toMatch(/\b(?:DROP TABLE|DROP COLUMN|TRUNCATE TABLE|DELETE FROM)\b/i);
  });

  it("upgrades a populated 001–006 baseline through the 007 AAA2-012 boundary", async () => {
    const migrationDirectory = path.resolve(process.cwd(), "db/migrations");
    const migrations = await readMigrationSet(migrationDirectory, RUNTIME_MIGRATION_VERSIONS);
    const prefix = migrations.slice(0, 7);
    const baseline = prefix.slice(0, -1).map(({ version, checksum }) => ({ version, checksum }));

    await withMigrationDirectory(Object.fromEntries(prefix.map(({ filename, sql }) => [filename, sql])), async (prefixDirectory) => {
      const { client, queries } = fakeClient(baseline);
      const result = await applyMigrations(client, { migrationDirectory: prefixDirectory, logger: { info: vi.fn() } });

      expect(result).toEqual({
        applied: ["007_relational_clinical_core"],
        alreadyApplied: baseline.map(({ version }) => version)
      });
      expect(queries.filter(({ text }) => text === "BEGIN")).toHaveLength(1);
      expect(queries).toContainEqual({
        text: prefix.at(-1)?.sql,
        values: []
      });
    });
  });

  it("rejects immutable migration checksum drift before executing SQL", async () => {
    await withMigrationDirectory({ "001_first.sql": "SELECT 'changed';" }, async (directory) => {
      const { client, queries } = fakeClient([{ version: "001_first", checksum: migrationChecksum("SELECT 'original';") }]);

      await expect(applyMigrations(client, { migrationDirectory: directory, logger: { info: vi.fn() } })).rejects.toThrow(
        "MIGRATION_CHECKSUM_MISMATCH:001_first"
      );

      expect(queries.some(({ text }) => text === "SELECT 'changed';")).toBe(false);
      expect(queries.at(-1)?.text).toBe("SELECT pg_advisory_unlock(hashtext($1))");
    });
  });

  it("preflights checksum drift across the baseline before applying an earlier pending migration", async () => {
    const migrationDirectory = path.resolve(process.cwd(), "db/migrations");
    const migrations = await readMigrationSet(migrationDirectory, RUNTIME_MIGRATION_VERSIONS);
    const { client, queries } = fakeClient([
      { version: migrations[0].version, checksum: migrations[0].checksum },
      { version: migrations[1].version, checksum: "a".repeat(64) }
    ]);

    await expect(applyMigrations(client, { migrationDirectory, logger: { info: vi.fn() } })).rejects.toThrow(
      "MIGRATION_CHECKSUM_MISMATCH:002_outbox_processing"
    );
    expect(queries.filter(({ text }) => text === "BEGIN")).toHaveLength(0);
    expect(queries.some(({ text }) => text === migrations[0].sql)).toBe(false);
  });

  it.each([
    { ledger: [{ version: "010_future", checksum: "a".repeat(64) }], error: "MIGRATION_VERSION_UNKNOWN:010_future" },
    {
      ledger: [
        { version: "001_initial", checksum: migrationChecksum("not-the-real-001") },
        { version: "003_runtime_integrity", checksum: migrationChecksum("not-the-real-003") }
      ],
      error: "MIGRATION_ORDER_GAP:002_outbox_processing"
    }
  ])("rejects an incompatible or gapped upgrade ledger before applying SQL", async ({ ledger, error }) => {
    const migrationDirectory = path.resolve(process.cwd(), "db/migrations");
    const { client, queries } = fakeClient(ledger);

    await expect(applyMigrations(client, { migrationDirectory, logger: { info: vi.fn() } })).rejects.toThrow(error);
    expect(queries.filter(({ text }) => text === "BEGIN")).toHaveLength(0);
  });

  it("backfills a legacy null checksum once and skips an already-applied migration", async () => {
    const sql = "SELECT 'legacy';";
    await withMigrationDirectory({ "001_first.sql": sql }, async (directory) => {
      const { client, queries } = fakeClient([{ version: "001_first", checksum: null }]);

      const result = await applyMigrations(client, { migrationDirectory: directory, logger: { info: vi.fn() } });

      expect(result).toEqual({ applied: [], alreadyApplied: ["001_first"] });
      expect(queries).toContainEqual({
        text: "UPDATE schema_migrations SET checksum = $2 WHERE version = $1 AND checksum IS NULL",
        values: ["001_first", migrationChecksum(sql)]
      });
      expect(queries.some(({ text }) => text === sql)).toBe(false);
    });
  });

  it("rolls back a failed migration and always releases the advisory lock", async () => {
    await withMigrationDirectory({ "001_first.sql": "INVALID MIGRATION;" }, async (directory) => {
      const { client, queries, query } = fakeClient();
      query.mockImplementation(async (text: string, values: readonly unknown[] = []) => {
        queries.push({ text, values });
        if (text.includes("SELECT version, checksum FROM schema_migrations")) return { rows: [], rowCount: 0 };
        if (text === "INVALID MIGRATION;") throw new Error("syntax error");
        return { rows: [], rowCount: 1 };
      });

      await expect(applyMigrations(client, { migrationDirectory: directory, logger: { info: vi.fn() } })).rejects.toThrow("syntax error");

      expect(queries.some(({ text }) => text === "ROLLBACK")).toBe(true);
      expect(queries.at(-1)?.text).toBe("SELECT pg_advisory_unlock(hashtext($1))");
    });
  });

  describe("coordinated cutover guard", () => {
    const cutoverSql = "-- Coordinated cutover: stop old app/worker.\nSELECT 1;";

    it("refuses a cutover migration while another session is connected, before running any SQL", async () => {
      await withMigrationDirectory({ "001_first.sql": "SELECT 0;", "002_cutover.sql": cutoverSql }, async (directory) => {
        const { client, queries } = fakeClient([], 2);

        await expect(applyMigrations(client, { migrationDirectory: directory, logger: { info: vi.fn() } }))
          .rejects.toThrow("MIGRATION_CUTOVER_REQUIRES_STOPPED_RUNTIME:002_cutover:2");

        expect(queries.some(({ text }) => text === "SELECT 0;" || text === cutoverSql)).toBe(false);
        expect(queries.at(-1)?.text).toBe("SELECT pg_advisory_unlock(hashtext($1))");
        // Only an identified autovacuum worker is ignored; a hidden (NULL) type still blocks.
        const guard = queries.find(({ text }) => text.includes("FROM pg_stat_activity"))?.text;
        expect(guard).toContain("backend_type IS DISTINCT FROM 'autovacuum worker'");
        expect(guard).not.toContain("backend_type = 'client backend'");
      });
    });

    it("runs the cutover when no other session is connected or the operator acknowledged it", async () => {
      await withMigrationDirectory({ "001_cutover.sql": cutoverSql }, async (directory) => {
        const quiet = fakeClient([], 0);
        await expect(applyMigrations(quiet.client, { migrationDirectory: directory, logger: { info: vi.fn() } })).resolves.toMatchObject({ applied: ["001_cutover"] });

        const busy = fakeClient([], 3);
        await expect(applyMigrations(busy.client, { migrationDirectory: directory, logger: { info: vi.fn() }, cutoverAcknowledged: true })).resolves.toMatchObject({ applied: ["001_cutover"] });
        expect(busy.queries.some(({ text }) => text.includes("pg_stat_activity"))).toBe(false);
      });
    });

    it("does not look at sessions for ordinary migrations or for cutovers that were already applied", async () => {
      await withMigrationDirectory({ "001_plain.sql": "SELECT 1;", "002_cutover.sql": cutoverSql }, async (directory) => {
        const plain = fakeClient([{ version: "002_cutover", checksum: migrationChecksum(cutoverSql) }, { version: "001_plain", checksum: migrationChecksum("SELECT 1;") }], 5);
        await expect(applyMigrations(plain.client, { migrationDirectory: directory, logger: { info: vi.fn() } })).resolves.toMatchObject({ applied: [] });
        expect(plain.queries.some(({ text }) => text.includes("pg_stat_activity"))).toBe(false);
      });
    });

    it("fails closed when the session count cannot be read", async () => {
      await withMigrationDirectory({ "001_cutover.sql": cutoverSql }, async (directory) => {
        const { client, query } = fakeClient();
        query.mockImplementation(async (text: string) => {
          if (text.includes("SELECT version, checksum FROM schema_migrations")) return { rows: [], rowCount: 0 };
          if (text.includes("FROM pg_stat_activity")) return { rows: [], rowCount: 0 };
          return { rows: [], rowCount: 1 };
        });
        await expect(applyMigrations(client, { migrationDirectory: directory, logger: { info: vi.fn() } })).rejects.toThrow("MIGRATION_CUTOVER_CHECK_FAILED:001_cutover");
      });
    });
  });
});

describe("runtime schema readiness", () => {
  const readyRow = {
    state_exists: true,
    latest_migration_applied: true,
    runtime_state_shape_ready: true,
    migration_ledger_shape_ready: true,
    runtime_state_payload_ready: true,
    audit_append_only_ready: true,
    audit_truncate_guard_ready: true,
    event_projection_ready: true,
    outbox_claim_ownership_ready: true,
    outbox_routing_ready: true,
    outbox_dead_letter_ready: true,
    rate_limit_schema_ready: true,
    session_activity_schema_ready: true,
    relational_clinical_core_ready: true,
    transitional_storage_boundary_ready: true,
    entity_storage_ready: true,
    invalidation_trigger_ready: true
  };

  it("accepts only the latest version with the complete runtime integrity shape", async () => {
    const query = vi.fn(async (_text: string, _values: readonly unknown[] = []) => ({
      rows: [readyRow],
      rowCount: 1
    }));

    await expect(assertRuntimeSchemaReady({ query })).resolves.toBeUndefined();

    expect(query).toHaveBeenCalledOnce();
    expect(query.mock.calls[0]?.[1]).toEqual([LATEST_RUNTIME_SCHEMA_VERSION]);
    const readinessSql = query.mock.calls[0]?.[0];
    expect(readinessSql).toMatch(/relational_clinical_core_ready/);
    expect(readinessSql).toMatch(/outbox_routing_ready/);
    expect(readinessSql).toMatch(/FROM relational_schema_markers/);
    expect(readinessSql).toMatch(/RELATIONAL_CLINICAL_CORE_EXPAND_V1/);
    expect(readinessSql).toMatch(/samples_accession_format/);
    expect(readinessSql).toMatch(/samples_replacement_reason_required/);
    expect(readinessSql).toMatch(/sample_item_links_status_check/);
    expect(readinessSql).toMatch(/pg_get_constraintdef/);
    expect(readinessSql).toMatch(/runtime_storage_boundaries/);
    expect(readinessSql).toMatch(/authoritative_store = 'cvg_runtime_entities'/);
    expect(readinessSql).toMatch(/runtime_entities_are_external/);
    expect(readinessSql).toMatch(/entity_removal_floor/);
    expect(readinessSql).toMatch(/status = 'TRANSITIONAL'/);
    expect(readinessSql).toMatch(/session_activity_schema_ready/);
    expect(readinessSql).toMatch(/table_name = 'session_activity'/);
  });

  it.each(Object.keys(readyRow) as Array<keyof typeof readyRow>)("fails closed when %s is absent", async (missingFlag) => {
    const query = vi.fn(async () => ({ rows: [{ ...readyRow, [missingFlag]: false }], rowCount: 1 }));

    await expect(assertRuntimeSchemaReady({ query })).rejects.toThrow("POSTGRES_RUNTIME_SCHEMA_NOT_READY");
  });

  it("fails closed when the catalog query returns no row", async () => {
    const query = vi.fn(async () => ({ rows: [], rowCount: 0 }));
    await expect(assertRuntimeSchemaReady({ query })).rejects.toThrow("POSTGRES_RUNTIME_SCHEMA_NOT_READY");
  });
});

describe("003 runtime integrity expand migration", () => {
  it("is idempotent, expand-only, append-only for audit and data-free for invalidation", async () => {
    const sql = await readFile(path.resolve(process.cwd(), "db/migrations/003_runtime_integrity.sql"), "utf8");

    expect(sql).toMatch(/ADD COLUMN IF NOT EXISTS checksum text/i);
    expect(sql).toMatch(/ALTER COLUMN checksum SET NOT NULL/i);
    expect(sql).toMatch(/CREATE OR REPLACE FUNCTION reject_audit_event_mutation/i);
    expect(sql).toMatch(/BEFORE UPDATE OR DELETE ON audit_events/i);
    expect(sql).toMatch(/BEFORE TRUNCATE ON audit_events[\s\S]*FOR EACH STATEMENT/i);
    expect(sql).toMatch(/RAISE EXCEPTION 'AUDIT_EVENTS_ARE_APPEND_ONLY'/i);
    expect(sql).toMatch(/CREATE OR REPLACE FUNCTION notify_runtime_state_changed/i);
    expect(sql).toMatch(/AFTER UPDATE ON cvg_runtime_state/i);
    expect(sql).toMatch(/pg_notify\('cvg_runtime_state_changed', NEW\.version::text\)/i);
    expect(sql).not.toMatch(/pg_notify\([^;]*NEW\.state/is);
    expect(sql).not.toMatch(/\b(?:DROP TABLE|DROP COLUMN|TRUNCATE TABLE|DELETE FROM)\b/i);
  });
});

describe("007 relational clinical core expand migration", () => {
  const requiredTables = [
    "relational_schema_markers",
    "departments",
    "roles",
    "users",
    "user_roles",
    "sessions",
    "auth_identities",
    "owners",
    "patients",
    "patient_owners",
    "external_references",
    "encounters",
    "admissions",
    "diagnostic_services",
    "service_instructions",
    "sla_policies",
    "critical_result_policies",
    "reason_codes",
    "request_code_sequences",
    "diagnostic_requests",
    "diagnostic_request_items",
    "samples",
    "sample_item_links",
    "procedures",
    "procedure_schedules",
    "results",
    "result_versions",
    "result_components",
    "attachments",
    "notifications",
    "notification_deliveries",
    "acknowledgements",
    "idempotency_keys"
  ];

  async function relationalMigrationSql(): Promise<string> {
    return readFile(path.resolve(process.cwd(), "db/migrations/007_relational_clinical_core.sql"), "utf8");
  }

  it("declares every core table, marker, and text-compatible identifier contract", async () => {
    const sql = await relationalMigrationSql();

    for (const table of requiredTables) {
      expect(sql).toMatch(new RegExp(`CREATE TABLE IF NOT EXISTS ${table}\\s*\\(`, "i"));
    }
    expect(sql).toMatch(/RELATIONAL_CLINICAL_CORE_EXPAND_V1/);
    expect(sql).toMatch(/All identifiers in this expand schema are text/i);
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS diagnostic_requests[\s\S]*?id text PRIMARY KEY/i);
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS result_versions[\s\S]*?id text PRIMARY KEY/i);
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS idempotency_keys[\s\S]*?id text PRIMARY KEY/i);
  });

  it("is expand-only, does not duplicate existing projections, and does not mutate the snapshot", async () => {
    const sql = await relationalMigrationSql();

    expect(sql).not.toMatch(/\b(?:DROP|TRUNCATE|DELETE FROM)\b/i);
    expect(sql).not.toMatch(/CREATE TABLE IF NOT EXISTS (?:audit_events|outbox_messages|rate_limit_buckets)\b/i);
    expect(sql).not.toMatch(/\b(?:ALTER|UPDATE|INSERT INTO)\s+cvg_runtime_state\b/i);
    expect(sql).toMatch(/runtime boundary therefore stays[\s\S]*?TRANSITIONAL/i);
    expect(sql).toMatch(/cvg_runtime_state/);
  });

  it("keeps clinical interpretation policy data unseeded and configuration-driven", async () => {
    const sql = await relationalMigrationSql();
    const policyStart = sql.indexOf("CREATE TABLE IF NOT EXISTS critical_result_policies");
    const policyEnd = sql.indexOf("CREATE TABLE IF NOT EXISTS reason_codes", policyStart);
    const policyDefinition = sql.slice(policyStart, policyEnd);

    expect(policyStart).toBeGreaterThanOrEqual(0);
    expect(policyEnd).toBeGreaterThan(policyStart);
    expect(policyDefinition).toMatch(/configuration jsonb NOT NULL/i);
    expect(policyDefinition).toMatch(/recipient_rule jsonb NOT NULL/i);
    expect(policyDefinition).toMatch(/escalation_policy jsonb NOT NULL/i);
    expect(policyDefinition).not.toMatch(/\b(?:threshold|critical_(?:low|high)|critical_value)\b/i);
    expect(sql).not.toMatch(/INSERT INTO\s+(?:diagnostic_services|sla_policies|critical_result_policies|reason_codes)\b/i);
  });

  it("declares database-enforceable lineage, ownership, and idempotency controls", async () => {
    const sql = await relationalMigrationSql();

    expect(sql).toMatch(/diagnostic_requests_encounter_patient_fk[\s\S]*REFERENCES encounters \(id, patient_id\)/i);
    expect(sql).toMatch(/sample_item_links_sample_request_fk[\s\S]*REFERENCES samples \(id, request_id\)/i);
    expect(sql).toMatch(/sample_item_links_item_request_fk[\s\S]*REFERENCES diagnostic_request_items \(id, request_id\)/i);
    expect(sql).toMatch(/results_item_key UNIQUE \(item_id\)/i);
    expect(sql).toMatch(/result_versions_result_sequence_key UNIQUE \(result_id, sequence\)/i);
    expect(sql).toMatch(/idempotency_keys_actor_scope_key_key UNIQUE \(actor_id, scope, key\)/i);
    expect(sql).toMatch(/diagnostic_request_items_current_result_fk/);
    expect(sql).toMatch(/DEFERRABLE INITIALLY DEFERRED/);
  });
});

describe("008 durable outbox routing migration", () => {
  it("adds a durable consumer envelope, backfills legacy rows, and constrains routes", async () => {
    const sql = await readFile(path.resolve(process.cwd(), "db/migrations/008_outbox_routing.sql"), "utf8");

    expect(sql).toMatch(/ADD COLUMN IF NOT EXISTS consumer_type text/i);
    expect(sql).toMatch(/ADD COLUMN IF NOT EXISTS routing_key text/i);
    expect(sql).toMatch(/NULLIF\(btrim\(payload ->> 'notificationId'\), ''\)/i);
    expect(sql).toMatch(/event_type IN \('ResultReleased', 'ResultVoided', 'RecollectionRequested'\)/i);
    expect(sql).toMatch(/ALTER COLUMN consumer_type SET NOT NULL/i);
    expect(sql).toMatch(/outbox_messages_consumer_type_check/i);
    expect(sql).toMatch(/outbox_messages_route_consistency_check/i);
    expect(sql).toMatch(/notification\.in_app/i);
    expect(sql).toMatch(/UPDATE relational_schema_markers/i);
    expect(sql).not.toMatch(/\b(?:DROP TABLE|DROP COLUMN|TRUNCATE TABLE|DELETE FROM)\b/i);
  });
});

describe("015 runtime entity rows migration", () => {
  it("is a coordinated cutover that reconciles every collection before emptying the snapshot", async () => {
    const sql = await readFile(path.resolve(process.cwd(), "db/migrations/015_runtime_entity_rows.sql"), "utf8");

    expect(isCoordinatedCutover(sql)).toBe(true);
    expect(sql).toMatch(/CREATE TABLE cvg_runtime_entities[\s\S]*PRIMARY KEY \(collection, entity_key\)/i);
    expect(sql).toMatch(/UNIQUE \(collection, position\) DEFERRABLE INITIALLY DEFERRED/i);
    expect(sql).toMatch(/CREATE TABLE cvg_runtime_entity_removals/i);
    expect(sql).toMatch(/ADD COLUMN entity_removal_floor bigint NOT NULL DEFAULT 0/i);
    // Every rejection happens before the header is emptied, inside the runner's transaction.
    const reconciliation = sql.indexOf("ENTITY_CUTOVER_RECONCILIATION_FAILED");
    const emptied = sql.indexOf("SET state = cvg_runtime_state_header(snapshot)");
    expect(sql.indexOf("ENTITY_CUTOVER_DUPLICATE_KEY")).toBeLessThan(reconciliation);
    expect(reconciliation).toBeGreaterThan(0);
    expect(emptied).toBeGreaterThan(reconciliation);
    expect(sql).toMatch(/ADD CONSTRAINT runtime_entities_are_external CHECK/i);
    expect(sql).toMatch(/authoritative_store = 'cvg_runtime_entities', contract_version = 'StoreState-entities-v1'/);
    expect(sql).toMatch(/UPDATE relational_schema_markers SET schema_version = '015_runtime_entity_rows'/i);
    expect(sql).not.toMatch(/\b(?:DROP TABLE|DROP COLUMN|TRUNCATE TABLE)\b/i);
  });

  it("keys idempotency records exactly as the runtime does", async () => {
    const sql = await readFile(path.resolve(process.cwd(), "db/migrations/015_runtime_entity_rows.sql"), "utf8");

    // jsonb::text of a string is its JSON encoding, so the concatenation equals JSON.stringify([actorId, scope, key]).
    expect(sql).toContain("'[' || (entity->'actorId')::text || ',' || (entity->'scope')::text || ',' || (entity->'key')::text || ']'");
    expect(sql).toMatch(/WHEN jsonb_typeof\(entity->'id'\) = 'string' THEN entity->>'id'/);
  });
});

describe("016 outbox WhatsApp route migration", () => {
  it("widens only the notification route check and keeps the previous app's rows valid", async () => {
    const sql = await readFile(path.resolve(process.cwd(), "db/migrations/016_outbox_whatsapp_route.sql"), "utf8");

    expect(isCoordinatedCutover(sql)).toBe(false);
    expect(sql).toMatch(/DROP CONSTRAINT outbox_messages_route_consistency_check;/);
    expect(sql).toMatch(/consumer_type = 'NOTIFICATION_DELIVERY' AND routing_key IN \('notification\.in_app', 'notification\.whatsapp'\)/);
    expect(sql).toMatch(/consumer_type = 'DOMAIN_EVENT' AND routing_key LIKE 'domain\.%'/);
    expect(sql).toMatch(/UPDATE relational_schema_markers SET schema_version = '016_outbox_whatsapp_route'/i);
    expect(sql).not.toMatch(/\b(?:DROP TABLE|DROP COLUMN|TRUNCATE TABLE|DELETE FROM|UPDATE outbox_messages)\b/i);
  });
});
