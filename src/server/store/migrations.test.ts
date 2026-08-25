import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  LATEST_RUNTIME_SCHEMA_VERSION,
  applyMigrations,
  assertRuntimeSchemaReady,
  migrationChecksum,
  migrationVersion
} from "./migrations";

interface RecordedQuery {
  readonly text: string;
  readonly values: readonly unknown[];
}

interface AppliedMigrationRow {
  readonly version: string;
  readonly checksum: string | null;
}

function fakeClient(applied: readonly AppliedMigrationRow[] = []) {
  const queries: RecordedQuery[] = [];
  const query = vi.fn(async (text: string, values: readonly unknown[] = []) => {
    queries.push({ text, values });
    if (text.includes("SELECT version, checksum FROM schema_migrations")) {
      return { rows: [...applied], rowCount: applied.length };
    }
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
    rate_limit_schema_ready: true,
    transitional_storage_boundary_ready: true,
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
