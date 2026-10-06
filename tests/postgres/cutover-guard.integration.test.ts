import { randomUUID } from "node:crypto";
import { copyFile, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Pool } from "pg";
import { describe, expect, it } from "vitest";
import { applyMigrations, RUNTIME_MIGRATION_VERSIONS } from "../../src/server/store/migrations";
import { provisionDatabaseRoles } from "../../scripts/db-roles";
import { withDisposablePostgresDatabase } from "../support/postgres-test-harness";

const MIGRATION_DIRECTORY = path.resolve(process.cwd(), "db/migrations");
const FIRST_CUTOVER = "013_audit_read_authority";

function urlFor(connectionString: string, user: string, password: string): string {
  const url = new URL(connectionString);
  url.username = user;
  url.password = password;
  return url.toString();
}

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

  // Production shape: the migrator and the runtime are different, non-superuser roles.
  // PostgreSQL then hides the runtime session's backend_type from the migrator unless it
  // holds pg_read_all_stats; the guard must still see the runtime as connected.
  it.each([
    { label: "with pg_read_all_stats, as db:roles provisions it", keepStatsRole: true },
    { label: "without pg_read_all_stats (backend type hidden)", keepStatsRole: false }
  ])("refuses 013 while the runtime is connected under its own role, $label", async ({ keepStatsRole }) => {
    const suffix = randomUUID().replaceAll("-", "").slice(0, 10);
    const roles = { migrator: `cvg_guard_migrator_${suffix}`, runtime: `cvg_guard_runtime_${suffix}` };
    try {
      await withDisposablePostgresDatabase(async (database) => {
        const adminUrl = database.connectionString();
        const migrationUrl = urlFor(adminUrl, roles.migrator, "guard-migrator-pass");
        const runtimeUrl = urlFor(adminUrl, roles.runtime, "guard-runtime-pass");
        await provisionDatabaseRoles({ adminUrl, migrationUrl, runtimeUrl });
        if (!keepStatsRole) {
          // Roles are cluster-wide: revoke from the maintenance database so no extra
          // session stays in the database under test.
          const admin = new Pool({ connectionString: process.env.POSTGRES_TEST_ADMIN_URL, max: 1 });
          try { await admin.query(`REVOKE pg_read_all_stats FROM "${roles.migrator}"`); } finally { await admin.end(); }
        }
        const directory = await mkdtemp(path.join(os.tmpdir(), "cvg-cutover-roles-"));
        const migrator = new Pool({ connectionString: migrationUrl, max: 1 });
        const runtime = new Pool({ connectionString: runtimeUrl, max: 1 });
        for (const pool of [migrator, runtime]) pool.on("error", () => undefined);
        const logger = { info: () => undefined };
        try {
          const member = await migrator.query<{ member: boolean }>("SELECT pg_has_role(current_user, 'pg_read_all_stats', 'MEMBER') AS member");
          expect(member.rows[0]?.member).toBe(keepStatsRole);
          await copyMigrations(directory, RUNTIME_MIGRATION_VERSIONS.filter((version) => version < FIRST_CUTOVER));
          const schema = `cutover_roles_${process.pid}_${suffix}`;
          const client = await migrator.connect();
          try {
            await client.query(`CREATE SCHEMA "${schema}"`);
            await client.query(`SET search_path TO "${schema}", public`);
            const migrate = () => applyMigrations({ query: (text, values) => client.query(text, values) }, { migrationDirectory: directory, logger });
            await migrate();
            await copyMigrations(directory, RUNTIME_MIGRATION_VERSIONS.filter((version) => version >= FIRST_CUTOVER));

            await runtime.query("SELECT 1"); // the old app holds a connection as the runtime role
            const visible = await client.query<{ backend_type: string | null }>(
              "SELECT backend_type FROM pg_stat_activity WHERE datname = current_database() AND usename = $1", [roles.runtime]);
            expect(visible.rows).toEqual([{ backend_type: keepStatsRole ? "client backend" : null }]);
            await expect(migrate()).rejects.toThrow(/MIGRATION_CUTOVER_REQUIRES_STOPPED_RUNTIME:013_audit_read_authority:\d+/);
            expect((await client.query("SELECT version FROM schema_migrations WHERE version >= '013'")).rows).toEqual([]);

            await runtime.end();
            // pg-pool resolves end() before the server drops the backend.
            for (let attempt = 0; attempt < 80; attempt += 1) {
              const left = await client.query("SELECT 1 FROM pg_stat_activity WHERE datname = current_database() AND usename = $1", [roles.runtime]);
              if (left.rowCount === 0) break;
              await new Promise((resolve) => setTimeout(resolve, 25));
            }
            expect((await migrate()).applied).toEqual(RUNTIME_MIGRATION_VERSIONS.filter((version) => version >= FIRST_CUTOVER));
          } finally {
            client.release();
          }
        } finally {
          await runtime.end().catch(() => undefined);
          await migrator.end();
          await rm(directory, { recursive: true, force: true });
        }
      });
    } finally {
      const cleanup = new Pool({ connectionString: process.env.POSTGRES_TEST_ADMIN_URL, max: 1 });
      try {
        for (const role of [roles.runtime, roles.migrator]) await cleanup.query(`DROP ROLE IF EXISTS "${role}"`);
      } finally {
        await cleanup.end();
      }
    }
  });
});
