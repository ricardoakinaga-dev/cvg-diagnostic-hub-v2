import path from "node:path";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";
import {
  buildRuntimeRoleGrants,
  rolesFromConnectionStrings,
  type DatabasePrivilegeRoles
} from "../src/server/store/postgres-privileges";
import { runMigrations } from "./migrate";

/**
 * Applies the least-privilege split (PROD-305).
 *
 * Run once per environment with an administrative connection, after the
 * migration role owns the schema:
 *
 *   MIGRATION_DATABASE_URL=... DATABASE_URL=... npm run db:roles
 *
 * Both URLs are required and must differ in user: that is the whole point of
 * the change. The script is idempotent, and it re-applies the migrations with
 * the migration role first so the grants land on the final schema.
 */
async function main(): Promise<void> {
  const migrationUrl = process.env.MIGRATION_DATABASE_URL?.trim();
  const runtimeUrl = process.env.DATABASE_URL?.trim();
  if (!migrationUrl || !runtimeUrl) {
    throw new Error("MIGRATION_DATABASE_URL e DATABASE_URL são obrigatórios para aplicar os privilégios.");
  }
  const roles: DatabasePrivilegeRoles = rolesFromConnectionStrings(migrationUrl, runtimeUrl);

  await runMigrations({ connectionString: migrationUrl });

  const pool = new Pool({ connectionString: migrationUrl });
  try {
    const client = await pool.connect();
    try {
      for (const statement of buildRuntimeRoleGrants(roles)) {
        await client.query(statement);
      }
    } finally {
      client.release();
    }
  } finally {
    await pool.end();
  }

  console.log(JSON.stringify({
    event: "database.roles_applied",
    migratorRole: roles.migrator,
    runtimeRole: roles.runtime,
    appendOnlyTables: ["audit_events"]
  }));
}

const entrypoint = process.argv[1] ? path.resolve(process.argv[1]) : undefined;
if (entrypoint === fileURLToPath(import.meta.url)) {
  void main().catch((error: unknown) => {
    console.error(JSON.stringify({
      event: "database.roles_failed",
      errorCode: error instanceof Error ? error.message : "DATABASE_ROLES_FAILED"
    }));
    process.exitCode = 1;
  });
}