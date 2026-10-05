import { randomUUID } from "node:crypto";
import { copyFile, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Pool } from "pg";
import { describe, expect, it } from "vitest";
import { applyMigrations, RUNTIME_MIGRATION_VERSIONS } from "../../src/server/store/migrations";
import { withDisposablePostgresDatabase } from "../support/postgres-test-harness";

const MIGRATION_DIRECTORY = path.resolve(process.cwd(), "db/migrations");
const FIRST_CUTOVER = "013_audit_read_authority";

async function copyMigrations(directory: string, versions: readonly string[]): Promise<void> {
  await Promise.all(versions.map((version) => copyFile(path.join(MIGRATION_DIRECTORY, `${version}.sql`), path.join(directory, `${version}.sql`))));
}

describe("coordinated cutover guard on a real database", () => {
  it("refuses 013 while the previous runtime is connected, then applies it once the runtime is stopped", async () => {
    await withDisposablePostgresDatabase(async (database) => {
      const directory = await mkdtemp(path.join(os.tmpdir(), "cvg-cutover-guard-"));
      const migrator = new Pool({ connectionString: database.connectionString(), max: 1 });
      const previousRuntime = new Pool({ connectionString: database.connectionString(), max: 1 });
      const logger = { info: () => undefined };
      try {
        await copyMigrations(directory, RUNTIME_MIGRATION_VERSIONS.filter((version) => version < FIRST_CUTOVER));
        // The disposable database is already fully migrated, so the upgrade runs in a fresh schema.
        const schema = `cutover_guard_${process.pid}_${randomUUID().replaceAll("-", "")}`;
        const client = await migrator.connect();
        await client.query(`CREATE SCHEMA "${schema}"`);
        await client.query(`SET search_path TO "${schema}", public`);
        const migrate = () => applyMigrations({ query: (text, values) => client.query(text, values) }, { migrationDirectory: directory, logger });
        await migrate();

        await copyMigrations(directory, RUNTIME_MIGRATION_VERSIONS.filter((version) => version >= FIRST_CUTOVER));
        await previousRuntime.query("SELECT 1"); // the old app/worker still holds a connection
        await expect(migrate()).rejects.toThrow(/MIGRATION_CUTOVER_REQUIRES_STOPPED_RUNTIME:013_audit_read_authority:\d+/);
        const afterRefusal = await client.query("SELECT version FROM schema_migrations WHERE version >= '013' ORDER BY version");
        expect(afterRefusal.rows).toEqual([]);

        await previousRuntime.end(); // runtime stopped
        const applied = await migrate();
        expect(applied.applied).toEqual(RUNTIME_MIGRATION_VERSIONS.filter((version) => version >= FIRST_CUTOVER));
        client.release();
      } finally {
        await previousRuntime.end().catch(() => undefined);
        await migrator.end();
        await rm(directory, { recursive: true, force: true });
      }
    });
  });
});
