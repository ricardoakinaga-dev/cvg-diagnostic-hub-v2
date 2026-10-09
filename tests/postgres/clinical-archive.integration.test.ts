import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { describe, expect, it } from "vitest";
import type { StoreState } from "../../src/server/domain/models";
import { createDemoState } from "../../src/server/store/fixtures";
import { LATEST_RUNTIME_SCHEMA_VERSION } from "../../src/server/store/migrations";
import { buildRuntimeRoleGrants } from "../../src/server/store/postgres-privileges";
import { ARCHIVE_NOW, RECENT, withCompletedRequest } from "../../src/test/archive-fixtures";
import { withDisposablePostgresDatabase, type DisposablePostgresDatabase } from "../support/postgres-test-harness";

const PASSWORD = "clinical-archive-integration-password";
const DISPOSABLE_DATABASE_PATTERN = /^cvg_test_[1-9][0-9]*_[a-f0-9]{32}$/;

function seeded(): StoreState {
  let state = createDemoState(PASSWORD);
  state = withCompletedRequest(state, "old");
  state = withCompletedRequest(state, "mel", { patientId: "patient-mel", at: "2023-03-01T12:00:00.000Z" });
  return withCompletedRequest(state, "recent", { at: RECENT });
}

async function count(database: DisposablePostgresDatabase, sql: string, values: unknown[] = []): Promise<number> {
  const row = (await database.query(sql, values)).rows[0] as Record<string, unknown>;
  return Number(Object.values(row)[0]);
}

describe("clinical archive on disposable PostgreSQL (PROD-501)", () => {
  it("creates the archive tables with the collection guard at the latest schema version", async () => {
    await withDisposablePostgresDatabase(async (database) => {
      await database.createStore(createDemoState(PASSWORD));
      expect(await database.query("SELECT schema_version FROM relational_schema_markers WHERE marker_key = 'RELATIONAL_CLINICAL_CORE_EXPAND_V1'"))
        .toMatchObject({ rows: [{ schema_version: LATEST_RUNTIME_SCHEMA_VERSION }] });
      expect(await database.query("SELECT to_regclass('cvg_clinical_archive')::text AS archive, to_regclass('cvg_clinical_archive_batches')::text AS batches"))
        .toMatchObject({ rows: [{ archive: "cvg_clinical_archive", batches: "cvg_clinical_archive_batches" }] });
      await database.query("INSERT INTO cvg_clinical_archive_batches (id, archived_at, cutoff, request_count, entity_count, attachment_count) VALUES ('batch-x', now(), now(), 0, 0, 0)");
      await expect(database.query("INSERT INTO cvg_clinical_archive (request_id, collection, entity_key, position, data, archived_at, archive_batch) VALUES ('r', 'unknown', 'k', 1, '{}', now(), 'batch-x')"))
        .rejects.toMatchObject({ code: "23514", constraint: "cvg_clinical_archive_collection_check" });
      await expect(database.query("INSERT INTO cvg_clinical_archive (request_id, collection, entity_key, position, data, archived_at, archive_batch) VALUES ('r', 'requests', 'k', 1, '{}', now(), 'missing-batch')"))
        .rejects.toMatchObject({ code: "23503" });
    });
  });

  it("moves old requests out of the entity rows atomically and lets another instance drop them incrementally", async () => {
    await withDisposablePostgresDatabase(async (database) => {
      const writer = await database.createStore(createDemoState(PASSWORD));
      await writer.transaction((state) => ({ state: seeded(), result: undefined }));
      const reader = await database.createStore();
      const before = await reader.readStateSnapshot();
      expect(before.state.requests).toHaveLength(3);
      const versionBefore = (await database.query("SELECT version::int AS version FROM cvg_runtime_state WHERE id = 1")).rows[0] as { version: number };

      // A dry run reports and writes nothing.
      const dry = await writer.archiveClinicalRecords({ now: ARCHIVE_NOW, dryRun: true });
      expect(dry).toMatchObject({ requestsArchived: 2, entitiesArchived: 22, attachmentsArchived: 2 });
      expect(await database.query("SELECT version::int AS version FROM cvg_runtime_state WHERE id = 1")).toMatchObject({ rows: [versionBefore] });
      expect(await count(database, "SELECT count(*)::int FROM cvg_clinical_archive")).toBe(0);

      const summary = await writer.archiveClinicalRecords({ now: ARCHIVE_NOW, actor: "system:integration" });
      expect(summary).toMatchObject({ requestsArchived: 2, entitiesArchived: 22, attachmentsArchived: 2 });
      const committed = (await database.query("SELECT version::int AS version FROM cvg_runtime_state WHERE id = 1")).rows[0] as { version: number };
      expect(committed.version).toBe(versionBefore.version + 1);

      // Active rows are gone; only the recent request remains, with its dependents.
      expect(await database.query("SELECT entity_key FROM cvg_runtime_entities WHERE collection = 'requests'")).toMatchObject({ rows: [{ entity_key: "request-recent" }] });
      expect(await count(database, "SELECT count(*)::int FROM cvg_runtime_entities WHERE collection IN ('items','samples','procedures','schedules','results','resultVersions','notifications','attachments') AND data::text LIKE '%-old%'")).toBe(0);
      expect(await count(database, "SELECT count(*)::int FROM cvg_runtime_entity_removals WHERE removed_version = $1", [committed.version])).toBe(22);
      // Patients and the other reference data never move.
      expect(await count(database, "SELECT count(*)::int FROM cvg_runtime_entities WHERE collection = 'patients'")).toBe(3);

      // The archive holds the same 22 entities, grouped by request, with their original order.
      expect(await count(database, "SELECT count(*)::int FROM cvg_clinical_archive")).toBe(22);
      expect(await database.query("SELECT request_id, count(*)::int AS entities FROM cvg_clinical_archive GROUP BY request_id ORDER BY request_id"))
        .toMatchObject({ rows: [{ request_id: "request-mel", entities: 11 }, { request_id: "request-old", entities: 11 }] });
      expect(await database.query("SELECT entity_key FROM cvg_clinical_archive WHERE request_id = 'request-old' AND collection = 'items' ORDER BY position"))
        .toMatchObject({ rows: [{ entity_key: "item-lab-old" }, { entity_key: "item-rx-old" }] });
      expect(await database.query("SELECT id, request_count, entity_count, attachment_count, actor FROM cvg_clinical_archive_batches"))
        .toMatchObject({ rows: [{ id: summary.batchId, request_count: 2, entity_count: 22, attachment_count: 2, actor: "system:integration" }] });

      // One audit event with counts only.
      const audit = await database.query("SELECT entity_id, actor_id, metadata FROM audit_events WHERE event_type = 'ClinicalRecordsArchived'");
      expect(audit.rows).toHaveLength(1);
      expect(audit.rows[0]).toMatchObject({ entity_id: summary.batchId, actor_id: "system:integration", metadata: { requestsArchived: 2, entitiesArchived: 22, attachmentsArchived: 2 } });
      expect(JSON.stringify(audit.rows[0])).not.toContain("request-old");

      // Another instance refreshes incrementally, without the archived requests, and agrees with the writer.
      const refreshed = await reader.readStateSnapshot();
      expect(refreshed.state.requests.map((request) => request.id)).toEqual(["request-recent"]);
      expect(refreshed.state.patients).toBe(before.state.patients);
      expect(refreshed.state.requests).toEqual(writer.getState().requests);
      expect(refreshed.state.items).toEqual(writer.getState().items);
      const fresh = await database.createStore();
      expect((await fresh.readState()).requests.map((request) => request.id)).toEqual(["request-recent"]);

      // Nothing left to do: no batch, no version bump.
      expect((await writer.archiveClinicalRecords({ now: ARCHIVE_NOW })).batchId).toBeUndefined();
      expect(await count(database, "SELECT count(*)::int FROM cvg_clinical_archive_batches")).toBe(1);
      expect(await database.query("SELECT version::int AS version FROM cvg_runtime_state WHERE id = 1")).toMatchObject({ rows: [committed] });
    });
  });

  it("rolls everything back when the archive insert fails", async () => {
    await withDisposablePostgresDatabase(async (database) => {
      const writer = await database.createStore(createDemoState(PASSWORD));
      await writer.transaction(() => ({ state: seeded(), result: undefined }));
      await database.query("INSERT INTO cvg_clinical_archive_batches (id, archived_at, cutoff, request_count, entity_count, attachment_count) VALUES ('batch-prior', now(), now(), 1, 1, 0)");
      await database.query("INSERT INTO cvg_clinical_archive (request_id, collection, entity_key, position, data, archived_at, archive_batch) VALUES ('request-old', 'items', 'item-lab-old', 1, '{}', now(), 'batch-prior')");
      await expect(writer.archiveClinicalRecords({ now: ARCHIVE_NOW })).rejects.toMatchObject({ code: "23505" });
      expect(writer.getState().requests).toHaveLength(3);
      expect(await count(database, "SELECT count(*)::int FROM cvg_runtime_entities WHERE collection = 'requests'")).toBe(3);
      expect(await count(database, "SELECT count(*)::int FROM cvg_clinical_archive_batches")).toBe(1);
      expect(await count(database, "SELECT count(*)::int FROM audit_events WHERE event_type = 'ClinicalRecordsArchived'")).toBe(0);
    });
  });

  it("serves the archive by patient and by request without loading it into the aggregate", async () => {
    await withDisposablePostgresDatabase(async (database) => {
      const store = await database.createStore(createDemoState(PASSWORD));
      await store.transaction(() => ({ state: seeded(), result: undefined }));
      await store.archiveClinicalRecords({ now: ARCHIVE_NOW });

      const thor = await store.readClinicalArchive({ patientId: "patient-thor", limit: 10 });
      expect(thor).toEqual([expect.objectContaining({
        requestId: "request-old", requestCode: "EX-old", patientId: "patient-thor", attachmentCount: 1, archivedAt: ARCHIVE_NOW.toISOString(),
        services: [{ code: "HEMOGRAM", name: "Hemograma", departmentCode: "LABORATORY", attachmentCount: 1 }, { code: "XRAY_THORAX", name: "RX de tórax", departmentCode: "RADIOLOGY", attachmentCount: 0 }]
      })]);
      expect((await store.readClinicalArchive({ limit: 10 })).map((entry) => entry.requestId)).toEqual(["request-old", "request-mel"]);
      expect((await store.readClinicalArchive({ limit: 1 })).map((entry) => entry.requestId)).toEqual(["request-old"]);
      expect((await store.readClinicalArchive({})).map((entry) => entry.requestId)).toEqual(["request-old", "request-mel"]);
      expect((await store.readClinicalArchive({ requestId: "request-mel", limit: 5 })).map((entry) => entry.patientId)).toEqual(["patient-mel"]);
      expect(await store.readClinicalArchive({ patientId: "patient-mel-2", limit: 5 })).toEqual([]);

      const rows = await store.readArchivedRequest("request-old");
      expect(rows).toHaveLength(11);
      expect(rows?.find((row) => row.collection === "resultVersions" && row.entityKey === "version-old-2")?.data).toMatchObject({ narrative: "Versão final." });
      expect(await store.readArchivedRequest("request-recent")).toBeUndefined();
      expect(await store.readArchivedRequest("request-missing")).toBeUndefined();
      expect(store.getState().requests.map((request) => request.id)).toEqual(["request-recent"]);
    });
  });

  it("purges only what is past the legal period and returns the attachment keys", async () => {
    await withDisposablePostgresDatabase(async (database) => {
      const store = await database.createStore(createDemoState(PASSWORD));
      await store.transaction(() => ({ state: seeded(), result: undefined }));
      await store.archiveClinicalRecords({ now: ARCHIVE_NOW });
      const dueAt = new Date("2036-10-08T12:00:00.000Z");

      expect(await store.purgeClinicalArchive({ now: dueAt })).toEqual({ requestsPurged: 0, entitiesPurged: 0, attachmentKeys: [] });
      expect(await store.purgeClinicalArchive({ now: new Date("2036-10-07T12:00:00.000Z"), purgeAfterMonths: 120 })).toEqual({ requestsPurged: 0, entitiesPurged: 0, attachmentKeys: [] });
      const dry = await store.purgeClinicalArchive({ now: dueAt, purgeAfterMonths: 120, dryRun: true });
      expect(dry).toMatchObject({ requestsPurged: 2, entitiesPurged: 22 });
      expect(await count(database, "SELECT count(*)::int FROM cvg_clinical_archive")).toBe(22);

      const purged = await store.purgeClinicalArchive({ now: dueAt, purgeAfterMonths: 120 });
      expect(purged.requestsPurged).toBe(2);
      expect(purged.entitiesPurged).toBe(22);
      expect(purged.attachmentKeys.sort()).toEqual(["attachments/result-mel/uuid-mel/laudo.pdf", "attachments/result-old/uuid-old/laudo.pdf"]);
      expect(await count(database, "SELECT count(*)::int FROM cvg_clinical_archive")).toBe(0);
      // The batch ledger and the audit trail survive the purge.
      expect(await count(database, "SELECT count(*)::int FROM cvg_clinical_archive_batches")).toBe(1);
      expect((await database.query("SELECT metadata FROM audit_events WHERE event_type = 'ClinicalArchivePurged'")).rows).toEqual([{ metadata: { requestsPurged: 2, entitiesPurged: 22, attachmentsPurged: 2 } }]);
      expect(await store.purgeClinicalArchive({ now: dueAt, purgeAfterMonths: 120 })).toEqual({ requestsPurged: 0, entitiesPurged: 0, attachmentKeys: [] });
      expect(await count(database, "SELECT count(*)::int FROM audit_events WHERE event_type = 'ClinicalArchivePurged'")).toBe(1);
    });
  });

  it("lets the runtime role read, add and remove archive rows but never change or drop them", async () => {
    await withDisposablePostgresDatabase(async (database) => {
      const migratorRole = `cvg_migrator_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
      const runtimeRole = `cvg_runtime_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
      const rolePassword = randomUUID();
      const admin = new Pool({ connectionString: database.connectionString(), max: 2 });
      try {
        await database.createStore(createDemoState(PASSWORD));
        await admin.query(`CREATE ROLE ${migratorRole} LOGIN PASSWORD '${rolePassword}'`);
        await admin.query(`CREATE ROLE ${runtimeRole} LOGIN PASSWORD '${rolePassword}'`);
        const databaseName = decodeURIComponent(new URL(database.connectionString()).pathname.replace(/^\//, ""));
        if (!DISPOSABLE_DATABASE_PATTERN.test(databaseName)) throw new Error("unexpected database name");
        await admin.query(`GRANT CONNECT ON DATABASE "${databaseName}" TO ${migratorRole}, ${runtimeRole}`);
        await admin.query(`GRANT USAGE, CREATE ON SCHEMA public TO ${migratorRole}`);
        await admin.query(`ALTER SCHEMA public OWNER TO ${migratorRole}`);
        for (const statement of buildRuntimeRoleGrants({ migrator: migratorRole, runtime: runtimeRole })) await admin.query(statement);

        const runtimeUrl = new URL(database.connectionString());
        runtimeUrl.username = runtimeRole;
        runtimeUrl.password = rolePassword;
        const runtime = new Pool({ connectionString: runtimeUrl.toString(), max: 1 });
        try {
          await runtime.query("INSERT INTO cvg_clinical_archive_batches (id, archived_at, cutoff, request_count, entity_count, attachment_count) VALUES ('batch-role', now(), now(), 1, 1, 0)");
          await runtime.query("INSERT INTO cvg_clinical_archive (request_id, collection, entity_key, position, data, archived_at, archive_batch) VALUES ('request-role', 'requests', 'request-role', 1, '{}', now(), 'batch-role')");
          expect((await runtime.query("SELECT count(*)::int AS rows FROM cvg_clinical_archive")).rows).toEqual([{ rows: 1 }]);
          for (const statement of [
            "DROP TABLE cvg_clinical_archive",
            "DROP TABLE cvg_clinical_archive_batches",
            "ALTER TABLE cvg_clinical_archive ADD COLUMN escape text",
            "ALTER TABLE cvg_clinical_archive DROP CONSTRAINT cvg_clinical_archive_collection_check",
            "UPDATE cvg_clinical_archive SET data = '{\"tampered\":true}'",
            "TRUNCATE cvg_clinical_archive"
          ]) {
            await expect(runtime.query(statement)).rejects.toMatchObject({ code: "42501" });
          }
          await runtime.query("DELETE FROM cvg_clinical_archive WHERE request_id = 'request-role'");
          expect((await runtime.query("SELECT count(*)::int AS rows FROM cvg_clinical_archive")).rows).toEqual([{ rows: 0 }]);
        } finally {
          await runtime.end();
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
});
