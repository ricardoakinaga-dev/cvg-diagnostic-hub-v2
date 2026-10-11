/**
 * Least-privilege PostgreSQL roles (PROD-305 / P1.6).
 *
 * The runtime previously connected with the same credentials the migrations
 * used, so a compromised application could drop the schema or rewrite
 * `audit_events` - the table the whole clinical history rests on. The split
 * gives DDL to one role and DML to another, and this module is the single
 * definition of that split so the grant script and its test cannot drift.
 */
export interface DatabasePrivilegeRoles {
  readonly migrator: string;
  readonly runtime: string;
}

const IDENTIFIER_PATTERN = /^[a-z_][a-z0-9_]{0,62}$/;

/** Append-only by contract: the runtime may add and read events, never change one. */
export const APPEND_ONLY_RUNTIME_TABLES = ["audit_events"] as const;

/**
 * The clinical archive (PROD-501) is written once and removed only by the
 * purge: the runtime may read, add and delete rows but never rewrite one.
 */
export const ARCHIVE_RUNTIME_TABLES = ["cvg_clinical_archive", "cvg_clinical_archive_batches", "cvg_archive_object_deletions"] as const;

/**
 * Grants the runtime data access over whatever the schema actually contains,
 * and nothing else. The statements are idempotent so the script can run on
 * every deploy: grants are cumulative and the revocations are repeated.
 */
export function buildRuntimeRoleGrants(roles: DatabasePrivilegeRoles): readonly string[] {
  assertSeparatedRoles(roles);
  const runtime = roles.runtime;
  return [
    // No DDL from the application: CREATE on the schema is the difference
    // between a compromised runtime and a compromised database.
    `REVOKE CREATE ON SCHEMA public FROM ${runtime}`,
    "REVOKE CREATE ON SCHEMA public FROM PUBLIC",
    `GRANT USAGE ON SCHEMA public TO ${runtime}`,
    `DO $cvg$
    DECLARE
      target text;
    BEGIN
      FOR target IN
        SELECT relation.relname
          FROM pg_class relation
          JOIN pg_namespace relation_schema ON relation_schema.oid = relation.relnamespace
         WHERE relation_schema.nspname = current_schema()
           AND relation.relkind = 'r'
      LOOP
        EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE %I TO %I', target, '${runtime}');
      END LOOP;
      FOR target IN
        SELECT sequence.relname
          FROM pg_class sequence
          JOIN pg_namespace sequence_schema ON sequence_schema.oid = sequence.relnamespace
         WHERE sequence_schema.nspname = current_schema()
           AND sequence.relkind = 'S'
      LOOP
        EXECUTE format('GRANT USAGE, SELECT ON SEQUENCE %I TO %I', target, '${runtime}');
      END LOOP;
    END
    $cvg$`,
    ...APPEND_ONLY_RUNTIME_TABLES.map((table) => `GRANT SELECT, INSERT ON TABLE ${table} TO ${runtime}`),
    ...APPEND_ONLY_RUNTIME_TABLES.map((table) => `REVOKE UPDATE, DELETE, TRUNCATE ON TABLE ${table} FROM ${runtime}`),
    ...ARCHIVE_RUNTIME_TABLES.map((table) => `GRANT SELECT, INSERT, DELETE ON TABLE ${table} TO ${runtime}`),
    ...ARCHIVE_RUNTIME_TABLES.map((table) => `REVOKE UPDATE, TRUNCATE ON TABLE ${table} FROM ${runtime}`)
  ];
}

export function assertSeparatedRoles(roles: DatabasePrivilegeRoles): void {
  if (!IDENTIFIER_PATTERN.test(roles.migrator) || !IDENTIFIER_PATTERN.test(roles.runtime)) {
    throw new Error("DATABASE_ROLE_NAME_INVALID");
  }
  if (roles.migrator === roles.runtime) {
    throw new Error("DATABASE_ROLES_MUST_BE_SEPARATE");
  }
}

/**
 * Derives both role names from the two connection strings, so the split cannot
 * be declared in prose and then applied with the same user on both sides.
 */
export function rolesFromConnectionStrings(migrationUrl: string, runtimeUrl: string): DatabasePrivilegeRoles {
  let migrationUser: string;
  let runtimeUser: string;
  try {
    migrationUser = decodeURIComponent(new URL(migrationUrl).username);
    runtimeUser = decodeURIComponent(new URL(runtimeUrl).username);
  } catch {
    throw new Error("DATABASE_PRIVILEGE_URL_INVALID");
  }
  if (!migrationUser || !runtimeUser) throw new Error("DATABASE_PRIVILEGE_URL_INVALID");
  const roles: DatabasePrivilegeRoles = { migrator: migrationUser, runtime: runtimeUser };
  assertSeparatedRoles(roles);
  return roles;
}

export interface RuntimePrivilegeProbe {
  readonly statement: string;
  readonly expectedSqlState: string;
}

/**
 * The negative privilege contract, executed against real PostgreSQL by the
 * integration suite: the runtime role must fail every one of these.
 */
export const RUNTIME_PRIVILEGE_PROBES: readonly RuntimePrivilegeProbe[] = [
  { statement: "DELETE FROM audit_events", expectedSqlState: "42501" },
  { statement: "UPDATE audit_events SET event_type = 'probe'", expectedSqlState: "42501" },
  { statement: "TRUNCATE audit_events", expectedSqlState: "42501" },
  { statement: "ALTER TABLE audit_events DISABLE TRIGGER audit_events_append_only_guard", expectedSqlState: "42501" },
  { statement: "DROP TABLE cvg_runtime_state", expectedSqlState: "42501" },
  { statement: "DROP TABLE cvg_clinical_archive", expectedSqlState: "42501" },
  { statement: "ALTER TABLE cvg_clinical_archive ADD COLUMN runtime_escape text", expectedSqlState: "42501" },
  { statement: "UPDATE cvg_clinical_archive SET data = '{}'::jsonb", expectedSqlState: "42501" },
  { statement: "TRUNCATE cvg_clinical_archive_batches", expectedSqlState: "42501" },
  { statement: "CREATE TABLE runtime_privilege_escape (id integer)", expectedSqlState: "42501" }
];
