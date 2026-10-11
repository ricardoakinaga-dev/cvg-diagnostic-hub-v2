import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { describe, expect, it } from "vitest";
import { createDemoState } from "../../src/server/store/fixtures";
import {
  APPEND_ONLY_RUNTIME_TABLES,
  ARCHIVE_RUNTIME_TABLES,
  buildRuntimeRoleGrants,
  RUNTIME_PRIVILEGE_PROBES,
  rolesFromConnectionStrings,
  assertSeparatedRoles
} from "../../src/server/store/postgres-privileges";
import { withDisposablePostgresDatabase } from "../support/postgres-test-harness";

const TEST_PASSWORD = "postgres-privilege-password";
const DISPOSABLE_DATABASE_PATTERN = /^cvg_test_[1-9][0-9]*_[a-f0-9]{32}$/;

function randomRoleName(prefix: string): string {
  return `${prefix}_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
}

function databaseUrlFor(connectionString: string, role: string, password: string): string {
  const url = new URL(connectionString);
  url.username = role;
  url.password = password;
  return url.toString();
}

describe("database role separation", () => {
  it("denies the runtime role every privilege that would rewrite history or the schema", async () => {
    await withDisposablePostgresDatabase(async (database) => {
      const migratorRole = randomRoleName("cvg_migrator");
      const runtimeRole = randomRoleName("cvg_runtime");
      const rolePassword = randomUUID();
      const admin = new Pool({ connectionString: database.connectionString(), max: 2 });
      try {
        const store = await database.createStore(createDemoState(TEST_PASSWORD));
        try {
          // Hand the schema to the migration role and grant the runtime only DML.
          await admin.query(`CREATE ROLE ${migratorRole} LOGIN PASSWORD '${rolePassword}'`);
          await admin.query(`CREATE ROLE ${runtimeRole} LOGIN PASSWORD '${rolePassword}'`);
          const databaseName = disposableDatabaseName(database.connectionString());
          await admin.query(`GRANT CONNECT ON DATABASE "${databaseName}" TO ${migratorRole}, ${runtimeRole}`);
          await admin.query(`GRANT USAGE, CREATE ON SCHEMA public TO ${migratorRole}`);
          await admin.query(`ALTER SCHEMA public OWNER TO ${migratorRole}`);
          for (const statement of buildRuntimeRoleGrants({ migrator: migratorRole, runtime: runtimeRole })) {
            await admin.query(statement);
          }

          const runtimeUrl = databaseUrlFor(database.connectionString(), runtimeRole, rolePassword);
          const runtimePool = new Pool({ connectionString: runtimeUrl, max: 1 });
          try {
            // The runtime role still does its job: DML is allowed.
            const client = await runtimePool.connect();
            try {
              await client.query("SELECT count(*) FROM cvg_runtime_state");
              await client.query("SELECT count(*) FROM audit_events");
              await client.query(
                "INSERT INTO audit_events (id, event_type, entity_type, entity_id, correlation_id, occurred_at) VALUES ($1, $2, $3, $4, $5, now())",
                ["privilege-probe-event", "RuntimeProbe", "RuntimeState", "probe", "corr-privilege-probe"]
              );
              const inserted = await client.query<{ count: string }>(
                "SELECT count(*)::text AS count FROM audit_events WHERE id = $1",
                ["privilege-probe-event"]
              );
              expect(inserted.rows[0]?.count).toBe("1");
              await client.query("INSERT INTO cvg_archive_object_deletions (storage_key) VALUES ($1)", ["privilege-probe-object"]);
              expect((await client.query("SELECT storage_key FROM cvg_archive_object_deletions")).rows)
                .toEqual([{ storage_key: "privilege-probe-object" }]);
              await expect(client.query("UPDATE cvg_archive_object_deletions SET storage_key = 'rewritten'"))
                .rejects.toMatchObject({ code: "42501" });
              await expect(client.query("TRUNCATE cvg_archive_object_deletions"))
                .rejects.toMatchObject({ code: "42501" });
              await client.query("DELETE FROM cvg_archive_object_deletions WHERE storage_key = $1", ["privilege-probe-object"]);
              expect((await client.query("SELECT count(*)::text AS count FROM cvg_archive_object_deletions")).rows[0]?.count)
                .toBe("0");
            } finally {
              client.release();
            }

            for (const probe of RUNTIME_PRIVILEGE_PROBES) {
              await expect(runtimePool.query(probe.statement)).rejects.toMatchObject({ code: probe.expectedSqlState });
            }
          } finally {
            await runtimePool.end();
          }
        } finally {
          await database.closeStore(store);
        }
      } finally {
        await admin.query(`DROP OWNED BY ${runtimeRole} CASCADE`).catch(() => undefined);
        await admin.query(`DROP OWNED BY ${migratorRole} CASCADE`).catch(() => undefined);
        await admin.query(`REASSIGN OWNED BY ${migratorRole} TO CURRENT_USER`).catch(() => undefined);
        await admin.query(`DROP ROLE IF EXISTS ${migratorRole}`).catch(() => undefined);
        await admin.query(`DROP ROLE IF EXISTS ${runtimeRole}`).catch(() => undefined);
        await admin.end();
      }
    });
  });

  it("refuses a configuration that reuses one role for DDL and DML", () => {
    expect(() => assertSeparatedRoles({ migrator: "cvg_app", runtime: "cvg_app" })).toThrow("DATABASE_ROLES_MUST_BE_SEPARATE");
    expect(() => assertSeparatedRoles({ migrator: "cvg-migrator", runtime: "cvg_runtime" })).toThrow("DATABASE_ROLE_NAME_INVALID");
    expect(() => assertSeparatedRoles({ migrator: "cvg_migrator", runtime: "runtime; DROP TABLE audit_events" }))
      .toThrow("DATABASE_ROLE_NAME_INVALID");
    expect(() => rolesFromConnectionStrings("not-a-url", "postgresql://cvg_runtime:cvg@127.0.0.1/cvg"))
      .toThrow("DATABASE_PRIVILEGE_URL_INVALID");
    expect(() => rolesFromConnectionStrings("postgresql://cvg:cvg@127.0.0.1/cvg", "postgresql://cvg:cvg@127.0.0.1/cvg"))
      .toThrow("DATABASE_ROLES_MUST_BE_SEPARATE");
    expect(rolesFromConnectionStrings("postgresql://cvg_migrator:secret@db/cvg", "postgresql://cvg_runtime:secret@db/cvg"))
      .toEqual({ migrator: "cvg_migrator", runtime: "cvg_runtime" });
  });

  it("keeps the append-only and archive table lists as the only runtime restrictions", () => {
    expect(APPEND_ONLY_RUNTIME_TABLES).toEqual(["audit_events"]);
    const statements = buildRuntimeRoleGrants({ migrator: "cvg_migrator", runtime: "cvg_runtime" }).join("\n");
    expect(statements).toMatch(/REVOKE UPDATE, DELETE, TRUNCATE ON TABLE audit_events FROM cvg_runtime/);
    expect(statements).toMatch(/GRANT SELECT, INSERT ON TABLE audit_events TO cvg_runtime/);
    expect(statements).toMatch(/REVOKE CREATE ON SCHEMA public FROM cvg_runtime/);
    // Archive rows and deletion intents permit insertion/removal, never rewriting or truncation.
    expect(ARCHIVE_RUNTIME_TABLES).toEqual(["cvg_clinical_archive", "cvg_clinical_archive_batches", "cvg_archive_object_deletions"]);
    expect(statements).toMatch(/GRANT SELECT, INSERT, DELETE ON TABLE cvg_clinical_archive TO cvg_runtime/);
    expect(statements).toMatch(/REVOKE UPDATE, TRUNCATE ON TABLE cvg_clinical_archive_batches FROM cvg_runtime/);
    expect(statements).toMatch(/GRANT SELECT, INSERT, DELETE ON TABLE cvg_archive_object_deletions TO cvg_runtime/);
    expect(statements).toMatch(/REVOKE UPDATE, TRUNCATE ON TABLE cvg_archive_object_deletions FROM cvg_runtime/);
  });
});

function disposableDatabaseName(connectionString: string): string {
  const databaseName = decodeURIComponent(new URL(connectionString).pathname.replace(/^\//, ""));
  if (!DISPOSABLE_DATABASE_PATTERN.test(databaseName)) {
    throw new Error("DATABASE_PRIVILEGE_DATABASE_NAME_UNEXPECTED");
  }
  return databaseName;
}
