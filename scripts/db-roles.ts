import path from "node:path";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";
import {
  buildRuntimeRoleGrants,
  rolesFromConnectionStrings,
  type DatabasePrivilegeRoles
} from "../src/server/store/postgres-privileges";
import { runMigrations } from "./migrate";

export interface RoleProvisioningOptions {
  readonly adminUrl: string;
  readonly migrationUrl: string;
  readonly runtimeUrl: string;
}

function passwordFromUrl(url: string): string {
  const password = decodeURIComponent(new URL(url).password);
  if (!password) throw new Error("DATABASE_ROLE_PASSWORD_REQUIRED");
  return password;
}

/**
 * Creates (or re-keys) the two login roles and hands the schema to the migration role.
 *
 * Runs with the administrative connection only (the POSTGRES_USER of the container), before the
 * migrations, so a brand-new database and an installation that was first created with a single
 * superuser both end in the same state: the migrator owns the database, the schema and every table,
 * sequence, view and function; the runtime owns nothing. Idempotent, and safe to repeat on every
 * deploy; it also rotates the passwords to whatever the connection strings currently carry.
 */
export async function provisionDatabaseRoles(options: RoleProvisioningOptions): Promise<DatabasePrivilegeRoles> {
  const roles = rolesFromConnectionStrings(options.migrationUrl, options.runtimeUrl);
  const passwords = new Map([[roles.migrator, passwordFromUrl(options.migrationUrl)], [roles.runtime, passwordFromUrl(options.runtimeUrl)]]);
  const pool = new Pool({ connectionString: options.adminUrl, max: 1 });
  const client = await pool.connect();
  try {
    const identity = await client.query<{ database: string; administrator: string }>("SELECT current_database() AS database, current_user AS administrator");
    const { database, administrator } = identity.rows[0];
    if (administrator === roles.migrator || administrator === roles.runtime) throw new Error("DATABASE_ADMIN_MUST_DIFFER_FROM_APPLICATION_ROLES");
    const quote = (name: string) => client.escapeIdentifier(name);
    for (const role of [roles.migrator, roles.runtime]) {
      const exists = (await client.query("SELECT 1 FROM pg_roles WHERE rolname = $1", [role])).rowCount === 1;
      await client.query(`${exists ? "ALTER" : "CREATE"} ROLE ${quote(role)} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION PASSWORD ${client.escapeLiteral(passwords.get(role)!)}`);
    }
    await client.query(`ALTER DATABASE ${quote(database)} OWNER TO ${quote(roles.migrator)}`);
    await client.query(`GRANT CONNECT ON DATABASE ${quote(database)} TO ${quote(roles.migrator)}, ${quote(roles.runtime)}`);
    await client.query(`ALTER SCHEMA public OWNER TO ${quote(roles.migrator)}`);
    await client.query("REVOKE CREATE ON SCHEMA public FROM PUBLIC");
    await client.query(`GRANT USAGE ON SCHEMA public TO ${quote(roles.runtime)}`);
    // Installations first created with a single superuser own their objects; move them to the migrator.
    await client.query(`DO $cvg$
      DECLARE
        target record;
      BEGIN
        FOR target IN
          SELECT format('ALTER %s %s OWNER TO %I', CASE relation.relkind WHEN 'S' THEN 'SEQUENCE' WHEN 'v' THEN 'VIEW' WHEN 'm' THEN 'MATERIALIZED VIEW' ELSE 'TABLE' END,
                        relation.oid::regclass, ${client.escapeLiteral(roles.migrator)}) AS statement
            FROM pg_class relation
            JOIN pg_namespace relation_schema ON relation_schema.oid = relation.relnamespace
           WHERE relation_schema.nspname = 'public' AND relation.relkind IN ('r', 'p', 'S', 'v', 'm')
             AND pg_get_userbyid(relation.relowner) <> ${client.escapeLiteral(roles.migrator)}
             AND NOT EXISTS (SELECT 1 FROM pg_depend dependency WHERE dependency.objid = relation.oid AND dependency.deptype IN ('a', 'i'))
          UNION ALL
          SELECT format('ALTER FUNCTION %s OWNER TO %I', routine.oid::regprocedure, ${client.escapeLiteral(roles.migrator)})
            FROM pg_proc routine
            JOIN pg_namespace routine_schema ON routine_schema.oid = routine.pronamespace
           WHERE routine_schema.nspname = 'public' AND routine.prokind = 'f'
             AND pg_get_userbyid(routine.proowner) <> ${client.escapeLiteral(roles.migrator)}
             AND NOT EXISTS (SELECT 1 FROM pg_depend dependency WHERE dependency.objid = routine.oid AND dependency.deptype = 'e')
        LOOP
          EXECUTE target.statement;
        END LOOP;
      END
      $cvg$`);
  } finally {
    client.release();
    await pool.end();
  }
  return roles;
}

/**
 * Applies the least-privilege split (PROD-305).
 *
 *   DATABASE_ADMIN_URL=... MIGRATION_DATABASE_URL=... DATABASE_URL=... npm run db:roles
 *
 * With DATABASE_ADMIN_URL the script first creates the roles and moves ownership
 * (provisionDatabaseRoles). Without it the roles must already exist, which is the legacy path
 * for a managed database where an administrator created them. Either way it then applies the
 * migrations as the migration role and gives the runtime role DML only. DATABASE_URL (runtime) and
 * MIGRATION_DATABASE_URL must name different users: that is the whole point of the change.
 * The script is idempotent and meant to run on every deploy.
 */
async function main(): Promise<void> {
  const migrationUrl = process.env.MIGRATION_DATABASE_URL?.trim();
  const runtimeUrl = process.env.DATABASE_URL?.trim();
  if (!migrationUrl || !runtimeUrl) {
    throw new Error("MIGRATION_DATABASE_URL e DATABASE_URL são obrigatórios para aplicar os privilégios.");
  }
  const adminUrl = process.env.DATABASE_ADMIN_URL?.trim();
  const roles: DatabasePrivilegeRoles = adminUrl
    ? await provisionDatabaseRoles({ adminUrl, migrationUrl, runtimeUrl })
    : rolesFromConnectionStrings(migrationUrl, runtimeUrl);

  await runMigrations({ connectionString: migrationUrl, cutoverAcknowledged: process.env.MIGRATION_CUTOVER_ACKNOWLEDGED === "true" });

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