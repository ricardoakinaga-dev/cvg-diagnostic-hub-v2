import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { describe, expect, it } from "vitest";
import { buildRuntimeRoleGrants, RUNTIME_PRIVILEGE_PROBES } from "../../src/server/store/postgres-privileges";
import { runMigrations } from "../../scripts/migrate";
import { provisionDatabaseRoles } from "../../scripts/db-roles";
import { withDisposablePostgresDatabase } from "../support/postgres-test-harness";

function urlFor(connectionString: string, user: string, password: string): string {
  const url = new URL(connectionString);
  url.username = user;
  url.password = password;
  return url.toString();
}

describe("production role provisioning from a single-superuser installation", () => {
  it("moves ownership to the migrator, keeps the runtime to DML and survives repeated runs and password rotation", async () => {
    const suffix = randomUUID().replaceAll("-", "").slice(0, 10);
    const migrator = `cvg_migrator_${suffix}`;
    const runtime = `cvg_runtime_${suffix}`;
    await withDisposablePostgresDatabase(async (database) => {
      // The disposable database is already fully migrated by the superuser: the legacy shape of a first deploy.
      const adminUrl = database.connectionString();
      const provision = (migratorPassword: string, runtimePassword: string) => provisionDatabaseRoles({
        adminUrl, migrationUrl: urlFor(adminUrl, migrator, migratorPassword), runtimeUrl: urlFor(adminUrl, runtime, runtimePassword)
      });
      const roles = await provision("migrator-pass-1", "runtime-pass-1");
      expect(roles).toEqual({ migrator, runtime });

      // PROD-304: the optional backup role holds REPLICATION (pg_basebackup) and reads all data, and nothing else.
      const backup = `cvg_backup_${suffix}`;
      const withBackup = (password: string) => provisionDatabaseRoles({
        adminUrl, migrationUrl: urlFor(adminUrl, migrator, "migrator-pass-1"), runtimeUrl: urlFor(adminUrl, runtime, "runtime-pass-1"), backup: { role: backup, password }
      });
      await withBackup("backup-pass-1");
      await withBackup("backup-pass-2");
      const adminPool = new Pool({ connectionString: adminUrl, max: 1 });
      try {
        await expect(adminPool.query("SELECT rolreplication, rolsuper, rolcreatedb, rolcreaterole, pg_has_role(oid, 'pg_read_all_data', 'MEMBER') AS reads FROM pg_roles WHERE rolname = $1", [backup]))
          .resolves.toMatchObject({ rows: [{ rolreplication: true, rolsuper: false, rolcreatedb: false, rolcreaterole: false, reads: true }] });
        await expect(adminPool.query("SELECT rolreplication FROM pg_roles WHERE rolname = $1", [runtime])).resolves.toMatchObject({ rows: [{ rolreplication: false }] });
      } finally {
        await adminPool.end();
      }
      await expect(provisionDatabaseRoles({ adminUrl, migrationUrl: urlFor(adminUrl, migrator, "migrator-pass-1"), runtimeUrl: urlFor(adminUrl, runtime, "runtime-pass-1"), backup: { role: runtime, password: "x" } }))
        .rejects.toThrow("DATABASE_BACKUP_ROLE_INVALID");

      const migratorUrl = urlFor(adminUrl, migrator, "migrator-pass-1");
      await runMigrations({ connectionString: migratorUrl, logger: { info: () => undefined } });
      const migratorPool = new Pool({ connectionString: migratorUrl, max: 1 });
      try {
        for (const statement of buildRuntimeRoleGrants(roles)) await migratorPool.query(statement);

        const foreign = await migratorPool.query<{ name: string; owner: string }>(
          `SELECT relation.relname AS name, pg_get_userbyid(relation.relowner) AS owner
             FROM pg_class relation JOIN pg_namespace ns ON ns.oid = relation.relnamespace
            WHERE ns.nspname = 'public' AND relation.relkind IN ('r', 'S', 'v', 'm', 'p') AND pg_get_userbyid(relation.relowner) <> $1
              AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.objid = relation.oid AND d.deptype IN ('a', 'i'))`, [migrator]);
        expect(foreign.rows).toEqual([]);
        const functions = await migratorPool.query<{ name: string }>(
          `SELECT p.proname AS name FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
            WHERE ns.nspname = 'public' AND p.prokind = 'f' AND pg_get_userbyid(p.proowner) <> $1
              AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.objid = p.oid AND d.deptype = 'e')`, [migrator]);
        expect(functions.rows).toEqual([]);
        // The cutover guard needs pg_read_all_stats to see the runtime's backend type.
        await expect(migratorPool.query("SELECT pg_has_role(current_user, 'pg_read_all_stats', 'MEMBER') AS member")).resolves.toMatchObject({ rows: [{ member: true }] });
        // DDL belongs to the migrator.
        await migratorPool.query("CREATE TABLE migrator_can_create (id integer)");
        await migratorPool.query("DROP TABLE migrator_can_create");
      } finally {
        await migratorPool.end();
      }

      const runtimePool = new Pool({ connectionString: urlFor(adminUrl, runtime, "runtime-pass-1"), max: 1 });
      try {
        await runtimePool.query("SELECT count(*) FROM cvg_runtime_state");
        for (const probe of RUNTIME_PRIVILEGE_PROBES) {
          await expect(runtimePool.query(probe.statement)).rejects.toMatchObject({ code: probe.expectedSqlState });
        }
        const superuser = await runtimePool.query<{ rolsuper: boolean; rolcreaterole: boolean; rolcreatedb: boolean }>(
          "SELECT rolsuper, rolcreaterole, rolcreatedb FROM pg_roles WHERE rolname = current_user");
        expect(superuser.rows[0]).toEqual({ rolsuper: false, rolcreaterole: false, rolcreatedb: false });
        await expect(runtimePool.query("SELECT pg_has_role(current_user, 'pg_read_all_stats', 'MEMBER') AS member")).resolves.toMatchObject({ rows: [{ member: false }] });
      } finally {
        await runtimePool.end();
      }

      // Idempotent re-run with rotated passwords: the stored verifier changes, the old password stops working
      // and the new one works.
      const verifier = async () => (await database.query("SELECT rolpassword FROM pg_authid WHERE rolname = $1", [runtime])).rows[0];
      const connects = async (password: string) => {
        const pool = new Pool({ connectionString: urlFor(adminUrl, runtime, password), max: 1 });
        // The disposable database is dropped with this idle connection still open.
        pool.on("error", () => undefined);
        try {
          await pool.query("SELECT 1");
          return true;
        } catch (error) {
          if ((error as { code?: string }).code === "28P01") return false;
          throw error;
        } finally {
          await pool.end().catch(() => undefined);
        }
      };
      const previous = await verifier();
      await provision("migrator-pass-2", "runtime-pass-2");
      expect(await verifier()).not.toEqual(previous);
      // Only a server that checks passwords on this connection can refuse the old one: the official image
      // trusts 127.0.0.1 when it runs on the host network (audit of 2026-10-10).
      if (!(await connects("not-the-runtime-password"))) expect(await connects("runtime-pass-1")).toBe(false);
      expect(await connects("runtime-pass-2")).toBe(true);

      await expect(provisionDatabaseRoles({ adminUrl, migrationUrl: urlFor(adminUrl, migrator, "x"), runtimeUrl: urlFor(adminUrl, migrator, "y") }))
        .rejects.toThrow("DATABASE_ROLES_MUST_BE_SEPARATE");
      await expect(provisionDatabaseRoles({ adminUrl, migrationUrl: urlFor(adminUrl, "someone_else_" + suffix, ""), runtimeUrl: urlFor(adminUrl, runtime, "y") }))
        .rejects.toThrow("DATABASE_ROLE_PASSWORD_REQUIRED");
    });
    const cleanup = new Pool({ connectionString: process.env.POSTGRES_TEST_ADMIN_URL, max: 1 });
    try {
      for (const role of [runtime, migrator]) await cleanup.query(`DROP ROLE IF EXISTS "${role}"`);
    } finally {
      await cleanup.end();
    }
  });
});
