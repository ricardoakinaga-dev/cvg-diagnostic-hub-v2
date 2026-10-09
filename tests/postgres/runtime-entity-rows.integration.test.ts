import { randomUUID } from "node:crypto";
import { copyFile, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Pool } from "pg";
import { describe, expect, it } from "vitest";
import type { IdempotencyRecord, StoreState } from "../../src/server/domain/models";
import { createDemoState } from "../../src/server/store/fixtures";
import { applyMigrations, RUNTIME_MIGRATION_VERSIONS, type SqlQueryable } from "../../src/server/store/migrations";
import { entityKey, stateHeader } from "../../src/server/store/postgres-entity-state";
import { withDisposablePostgresDatabase, type DisposablePostgresDatabase } from "../support/postgres-test-harness";

const MIGRATION_DIRECTORY = path.resolve(process.cwd(), "db/migrations");
const CUTOVER_VERSION = "015_runtime_entity_rows";
const PASSWORD = "runtime-entity-rows-integration-password";
// Keys a client may send: quotes, separators, escapes, control and non-ASCII characters.
const AWKWARD_KEYS = ["plain", "with \"quotes\"", "back\\slash", "a\",\"b", "line\nbreak\ttab", "ctrl-\u0001-\u001f", "acentuação 🚀", "[\"nested\"]"];

interface MigrationProbe {
  readonly query: SqlQueryable["query"];
  upgrade(): ReturnType<typeof applyMigrations>;
}

// Relative to the clock: a fixed date ages past IDEMPOTENCY_RETENTION_MS (24 h) and the test's own compaction then
// prunes these records, leaving a fresh removal row behind.
const CREATED_AT = new Date().toISOString();

function idempotency(key: string, index: number): IdempotencyRecord {
  return { actorId: index % 2 ? "user-vet" : "user-\"lab\"", scope: "createRequest", key, payloadHash: `hash-${index}`, response: { id: `request-${index}` }, createdAt: CREATED_AT };
}

function populated(): StoreState {
  const base = createDemoState(PASSWORD);
  return { ...base, idempotency: AWKWARD_KEYS.map(idempotency) };
}

async function with014Probe(database: DisposablePostgresDatabase, operation: (probe: MigrationProbe) => Promise<void>): Promise<void> {
  const schema = `entity_upgrade_${process.pid}_${randomUUID().replaceAll("-", "")}`;
  if (!/^entity_upgrade_[0-9]+_[a-f0-9]{32}$/.test(schema)) throw new Error("Invalid entity upgrade schema.");
  const directory = await mkdtemp(path.join(os.tmpdir(), "cvg-entity-upgrade-"));
  const pool = new Pool({ connectionString: database.connectionString(), max: 1 });
  try {
    await Promise.all(RUNTIME_MIGRATION_VERSIONS.filter((version) => version < CUTOVER_VERSION).map((version) =>
      copyFile(path.join(MIGRATION_DIRECTORY, `${version}.sql`), path.join(directory, `${version}.sql`))));
    const client = await pool.connect();
    try {
      await client.query(`CREATE SCHEMA "${schema}"`);
      await client.query(`SET search_path TO "${schema}", public`);
      const sql: SqlQueryable = { query: (text, values) => client.query(text, values) };
      await applyMigrations(sql, { migrationDirectory: directory, logger: { info: () => undefined } });
      await copyFile(path.join(MIGRATION_DIRECTORY, `${CUTOVER_VERSION}.sql`), path.join(directory, `${CUTOVER_VERSION}.sql`));
      await operation({ query: sql.query, upgrade: () => applyMigrations(sql, { migrationDirectory: directory, logger: { info: () => undefined } }) });
    } finally {
      client.release();
    }
  } finally {
    await pool.end();
    await rm(directory, { recursive: true, force: true });
    await database.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
  }
}

async function evidence(probe: MigrationProbe) {
  return {
    ledger: (await probe.query("SELECT version FROM schema_migrations ORDER BY version")).rows,
    state: (await probe.query("SELECT state, version::text FROM cvg_runtime_state WHERE id = 1")).rows,
    entities: (await probe.query("SELECT to_regclass('cvg_runtime_entities') AS entities")).rows
  };
}

describe("015 runtime entity rows on disposable PostgreSQL", () => {
  it("moves a populated snapshot into ordered entity rows, keys idempotency like the runtime and refuses old writers", async () => {
    await withDisposablePostgresDatabase(async (database) => {
      await with014Probe(database, async (probe) => {
        const state = populated();
        const duplicated = { ...state, users: [...state.users, state.users[0]] };
        await probe.query("INSERT INTO cvg_runtime_state (id, state, version) VALUES (1, $1::jsonb, 7)", [JSON.stringify(duplicated)]);
        const before = await evidence(probe);
        await expect(probe.upgrade()).rejects.toThrow("ENTITY_CUTOVER_DUPLICATE_KEY:users");
        expect(await evidence(probe)).toEqual(before);

        await probe.query("UPDATE cvg_runtime_state SET state = $1::jsonb WHERE id = 1", [JSON.stringify(state)]);
        expect((await probe.upgrade()).applied).toEqual([CUTOVER_VERSION]);
        expect(await probe.query("SELECT state, version::text, entity_removal_floor::text FROM cvg_runtime_state WHERE id = 1"))
          .toMatchObject({ rows: [{ state: stateHeader(state), version: "8", entity_removal_floor: "0" }] });

        const rows = await probe.query("SELECT collection, entity_key, position::int, data, written_version::int FROM cvg_runtime_entities ORDER BY collection, position");
        const expected = (["users", "patients", "encounters", "admissions", "services", "reasonCodes", "idempotency"] as const)
          .flatMap((collection) => (state[collection] as unknown[]).map((entry, index) => ({
            collection, entity_key: entityKey(collection, entry), position: index + 1, data: entry, written_version: 8
          })));
        expect([...rows.rows].sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right))))
          .toEqual(expected.sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right))));
        // The SQL key function and the runtime agree byte for byte, including awkward client keys.
        expect(await probe.query("SELECT count(*)::int AS mismatched FROM cvg_runtime_entities WHERE entity_key IS DISTINCT FROM cvg_runtime_entity_key(collection, data)"))
          .toMatchObject({ rows: [{ mismatched: 0 }] });

        await expect(probe.upgrade()).resolves.toEqual({ applied: [], alreadyApplied: RUNTIME_MIGRATION_VERSIONS.filter((version) => version <= CUTOVER_VERSION) });
        await expect(probe.query("UPDATE cvg_runtime_state SET state = $1::jsonb, version = version + 1 WHERE id = 1", [JSON.stringify(state)]))
          .rejects.toMatchObject({ code: "23514", constraint: "runtime_entities_are_external" });
        await expect(probe.query("INSERT INTO cvg_runtime_entities (collection, entity_key, position, data, written_version) VALUES ('unknown', 'x', 1, '{}', 1)"))
          .rejects.toMatchObject({ code: "23514", constraint: "cvg_runtime_entities_collection_check" });
      });
    });
  });

  it("writes diffs, refreshes another instance incrementally and reloads it below the removal floor", async () => {
    await withDisposablePostgresDatabase(async (database) => {
      const writer = await database.createStore(createDemoState(PASSWORD));
      const reader = await database.createStore();
      try {
        const baseline = await reader.readStateSnapshot();
        const removedPatient = baseline.state.patients[0];
        const awkward = idempotency("refresh \"key\" 🚀", 99);
        await writer.transaction((state) => ({
          state: {
            ...state,
            users: state.users.map((user, index) => index === 0 ? { ...user, displayName: "Renomeado", version: user.version + 1 } : user),
            patients: state.patients.slice(1),
            idempotency: [...state.idempotency, awkward]
          },
          result: undefined
        }));
        const written = await database.query("SELECT collection, entity_key FROM cvg_runtime_entities WHERE written_version = (SELECT version FROM cvg_runtime_state WHERE id = 1) ORDER BY collection");
        expect(written.rows).toEqual([
          { collection: "idempotency", entity_key: entityKey("idempotency", awkward) },
          { collection: "users", entity_key: baseline.state.users[0].id }
        ]);
        expect(await database.query("SELECT collection, entity_key FROM cvg_runtime_entity_removals")).toMatchObject({ rows: [{ collection: "patients", entity_key: removedPatient.id }] });

        const refreshed = await reader.readStateSnapshot();
        expect(refreshed.state).toEqual(writer.getState());
        expect(refreshed.state.services).toBe(baseline.state.services);

        // A cache older than pruned removals cannot catch up incrementally: it reloads.
        await writer.transaction((state) => ({ state: { ...state, patients: state.patients.slice(1) }, result: undefined }));
        await database.query("UPDATE cvg_runtime_entity_removals SET removed_at = now() - interval '2 days'");
        await writer.compactRuntimeState();
        const floor = await database.query("SELECT entity_removal_floor::int AS floor, version::int AS version FROM cvg_runtime_state WHERE id = 1");
        expect((floor.rows[0] as { floor: number }).floor).toBeGreaterThan(refreshed.version);
        expect(await database.query("SELECT count(*)::int AS removals FROM cvg_runtime_entity_removals")).toMatchObject({ rows: [{ removals: 0 }] });
        const reloaded = await reader.readStateSnapshot();
        expect(reloaded.version).toBe((floor.rows[0] as { version: number }).version);
        expect(reloaded.state).toEqual(writer.getState());
        expect(reloaded.state.patients).toHaveLength(baseline.state.patients.length - 2);
      } finally {
        await database.closeStore(reader);
        await database.closeStore(writer);
      }
    });
  });
});
