import { beforeEach, describe, expect, it, vi } from "vitest";
import type { StoreState } from "../domain/models";
import { FakeEntityDatabase } from "../../test/fake-entity-database";
import { ARCHIVE_NOW, withCompletedRequest } from "../../test/archive-fixtures";
import { createDemoState } from "./fixtures";
import { planClinicalArchive } from "../domain/clinical-archive";

const pool = vi.hoisted(() => ({ connect: vi.fn(), end: vi.fn(), query: vi.fn() }));
const listenerPool = vi.hoisted(() => ({
  connect: vi.fn(), end: vi.fn(), on: vi.fn(), query: vi.fn(),
  client: { query: vi.fn(), on: vi.fn(), off: vi.fn(), removeListener: vi.fn(), release: vi.fn() }
}));

vi.mock("pg", () => ({
  Pool: class MockPool {
    constructor(options: { application_name?: string }) {
      return options.application_name === "cvg-runtime-state-cache" ? listenerPool : pool;
    }
  }
}));

import { PostgresStore } from "./postgres-store";
import { insertClinicalArchive, purgeClinicalArchiveRows, readArchivedRequestRows, readClinicalArchiveRows } from "./postgres-clinical-archive";

const readyRuntimeSchema = {
  state_exists: true, latest_migration_applied: true, runtime_state_shape_ready: true, migration_ledger_shape_ready: true,
  runtime_state_payload_ready: true, audit_append_only_ready: true, audit_truncate_guard_ready: true, event_projection_ready: true,
  outbox_claim_ownership_ready: true, outbox_routing_ready: true, outbox_dead_letter_ready: true, session_activity_schema_ready: true,
  rate_limit_schema_ready: true, relational_clinical_core_ready: true, transitional_storage_boundary_ready: true, entity_storage_ready: true,
  invalidation_trigger_ready: true
};
const versionRow = (version: string | number = "1") => ({ rowCount: 1, rows: [{ version }] });

function populated(): StoreState {
  return withCompletedRequest(withCompletedRequest(createDemoState("pg-archive-unit-password"), "old"), "recent", { at: "2026-09-01T12:00:00.000Z" });
}

/** A pooled client over entity rows that also records and answers the archive statements. */
function archiveClient(database: FakeEntityDatabase, answers: Record<string, () => unknown> = {}) {
  const statements: string[] = [];
  const client = {
    statements,
    release: vi.fn(),
    query: vi.fn(async (text: string, values?: readonly unknown[]) => {
      const sql = text.replace(/\s+/g, " ").trim();
      if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") { statements.push(sql); return { rowCount: 0, rows: [] }; }
      const handled = database.handle(sql, values ?? []);
      if (handled) { statements.push(sql.slice(0, 40)); return handled; }
      const key = Object.keys(answers).find((prefix) => sql.startsWith(prefix));
      statements.push(sql.slice(0, 40));
      if (key) return answers[key]();
      if (sql.includes("FOR UPDATE")) return versionRow(String(database.version));
      if (sql.startsWith("INSERT INTO audit_events")) return { rowCount: 1, rows: [{ id: "audit" }] };
      if (sql.startsWith("INSERT INTO cvg_clinical_archive_batches")) return { rowCount: 1, rows: [] };
      if (sql.startsWith("INSERT INTO cvg_clinical_archive ")) return { rowCount: JSON.parse(String(values?.[0])).length, rows: [] };
      return { rowCount: 0, rows: [] };
    })
  };
  return client;
}

function plainClient(database: FakeEntityDatabase) {
  return { query: vi.fn(async (text: string, values?: readonly unknown[]) => (text.startsWith("BEGIN") || text === "COMMIT" || text === "ROLLBACK" ? { rowCount: 0, rows: [] } : database.handle(text, values ?? []))), release: vi.fn() };
}

async function openStore(state: StoreState) {
  pool.query.mockResolvedValueOnce(versionRow("1")).mockResolvedValueOnce({ rowCount: 1, rows: [readyRuntimeSchema] });
  const database = new FakeEntityDatabase(state, 1);
  pool.connect.mockResolvedValueOnce(plainClient(database));
  const store = await PostgresStore.create("postgres://test.invalid/cvg_test_archive");
  // The LISTEN connection announces itself once; absorb that one validation read.
  await new Promise((resolve) => setTimeout(resolve, 0));
  pool.query.mockResolvedValueOnce(versionRow("1"));
  pool.connect.mockResolvedValueOnce(plainClient(database));
  await store.readState();
  return { store, database };
}

describe("PostgresStore clinical archive", () => {
  beforeEach(() => {
    pool.connect.mockReset();
    pool.end.mockReset().mockResolvedValue(undefined);
    pool.query.mockReset();
    listenerPool.client.query.mockReset().mockResolvedValue({ rowCount: 0, rows: [] });
    listenerPool.connect.mockReset().mockResolvedValue(listenerPool.client);
    listenerPool.end.mockReset().mockResolvedValue(undefined);
    listenerPool.on.mockReset();
    listenerPool.query.mockReset().mockResolvedValue({ rowCount: 0, rows: [] });
  });

  it("archives inside one transaction: archive rows, batch, entity removals and one audit event", async () => {
    const { store, database } = await openStore(populated());
    pool.query.mockResolvedValue(versionRow("1"));
    const client = archiveClient(database);
    pool.connect.mockResolvedValueOnce(client);

    const summary = await store.archiveClinicalRecords({ now: ARCHIVE_NOW, actor: "system:test" });

    expect(summary).toMatchObject({ requestsArchived: 1, entitiesArchived: 11, attachmentsArchived: 1 });
    expect(client.statements[0]).toBe("BEGIN");
    expect(client.statements.at(-1)).toBe("COMMIT");
    const insertBatch = client.query.mock.calls.find(([text]) => String(text).includes("INSERT INTO cvg_clinical_archive_batches"));
    expect(insertBatch?.[1]).toEqual([summary.batchId, ARCHIVE_NOW.toISOString(), "2024-10-08T12:00:00.000Z", 1, 11, 1, "system:test"]);
    const insertRows = client.query.mock.calls.filter(([text]) => String(text).includes("INSERT INTO cvg_clinical_archive (request_id"));
    expect(JSON.parse(String(insertRows[0][1]?.[0]))).toHaveLength(11);
    expect(client.query.mock.calls.some(([text]) => String(text).startsWith("INSERT INTO audit_events"))).toBe(true);
    // The normal entity diff removes exactly the archived entities from the active rows.
    expect(database.state().requests.map((request) => request.id)).toEqual(["request-recent"]);
    expect(database.removals).toHaveLength(11);
    expect(store.getState().requests.map((request) => request.id)).toEqual(["request-recent"]);
    await store.close();
  });

  it("does not open a transaction for a dry run or when nothing is due", async () => {
    const { store } = await openStore(populated());
    pool.query.mockResolvedValue(versionRow("1"));
    const connectsBefore = pool.connect.mock.calls.length;
    expect((await store.archiveClinicalRecords({ now: ARCHIVE_NOW, dryRun: true })).batchId).toBeUndefined();
    expect((await store.archiveClinicalRecords({ now: new Date("2025-01-01T00:00:00.000Z") })).requestsArchived).toBe(0);
    expect(pool.connect.mock.calls.length).toBe(connectsBefore);
    await store.close();
  });

  it("re-plans under the lock and writes nothing when the request stopped being archivable", async () => {
    const state = populated();
    const { store, database } = await openStore(state);
    pool.query.mockResolvedValue(versionRow("1"));
    // Another process reopened the request after the preview read the cache.
    const reopened = database.rows.get("requests\u0000request-old")!;
    reopened.data = { ...reopened.data, aggregateStatus: "IN_PROGRESS" };
    reopened.written_version = 2;
    database.version = 2;
    const client = archiveClient(database);
    pool.connect.mockResolvedValueOnce(client);

    const summary = await store.archiveClinicalRecords({ now: ARCHIVE_NOW });

    expect(summary.requestsArchived).toBe(0);
    expect(client.query.mock.calls.some(([text]) => String(text).includes("INSERT INTO cvg_clinical_archive"))).toBe(false);
    await store.close();
  });

  it("reads summaries without touching the transaction queue", async () => {
    const { store } = await openStore(populated());
    const archivedRow = (collection: string, key: string, position: number, data: object) => ({ request_id: "request-old", collection, entity_key: key, position: String(position), data, archived_at: new Date("2026-10-08T12:00:00.000Z"), archive_batch: "batch-1" });
    pool.query.mockImplementation(async (text: string) => {
      const sql = String(text);
      if (sql.includes("SELECT version FROM cvg_runtime_state")) return versionRow("1");
      if (sql.includes("SELECT request_id FROM cvg_clinical_archive")) return { rowCount: 1, rows: [{ request_id: "request-old" }] };
      if (sql.includes("FROM cvg_clinical_archive WHERE request_id = ANY")) {
        return { rowCount: 2, rows: [
          archivedRow("requests", "request-old", 1, { id: "request-old", requestCode: "EX-old", patientId: "patient-thor", encounterId: "encounter-thor", requestingDepartmentCode: "INPATIENT", updatedAt: "2024-06-01T12:00:00.000Z" }),
          archivedRow("items", "item-lab-old", 1, { id: "item-lab-old", serviceId: "service-hemogram", departmentCode: "LABORATORY" })
        ] };
      }
      return { rowCount: 0, rows: [] };
    });

    const entries = await store.readClinicalArchive({ patientId: "patient-thor", limit: 5 });
    expect(entries).toEqual([expect.objectContaining({ requestId: "request-old", archivedAt: "2026-10-08T12:00:00.000Z", services: [{ code: "HEMOGRAM", name: "Hemograma", departmentCode: "LABORATORY" }] })]);
    expect(pool.query).toHaveBeenCalledWith(expect.stringContaining("data->>'patientId' = $1"), ["patient-thor", null, 5]);
    const rows = await store.readArchivedRequest("request-old");
    expect(rows?.map((row) => row.collection)).toEqual(["requests", "items"]);
    await store.close();
  });

  it("purges through the pool for a dry run and inside a transaction when applied", async () => {
    const { store, database } = await openStore(populated());
    const due = { rowCount: 1, rows: [{ request_id: "request-old" }] };
    const found = { rowCount: 1, rows: [{ entities: 11, attachment_keys: ["attachments/result-old/x/laudo.pdf"] }] };
    pool.query.mockImplementation(async (text: string) => {
      const sql = String(text);
      if (sql.includes("SELECT version FROM cvg_runtime_state")) return versionRow("1");
      if (sql.includes("archived_at <=")) return due;
      if (sql.includes("count(*)::int AS entities")) return found;
      return { rowCount: 0, rows: [] };
    });
    const later = new Date("2036-10-08T12:00:00.000Z");
    expect(await store.purgeClinicalArchive({ now: later })).toEqual({ requestsPurged: 0, entitiesPurged: 0, attachmentKeys: [] });
    expect(await store.purgeClinicalArchive({ now: later, purgeAfterMonths: 120, dryRun: true })).toEqual({ requestsPurged: 1, entitiesPurged: 11, attachmentKeys: ["attachments/result-old/x/laudo.pdf"] });

    const client = archiveClient(database, {
      "SELECT request_id FROM cvg_clinical_archive WHERE collection = 'requests' AND archived_at": () => due,
      "SELECT count(*)::int AS entities": () => found,
      "DELETE FROM cvg_clinical_archive": () => ({ rowCount: 11, rows: [] })
    });
    pool.connect.mockResolvedValueOnce(client);
    const applied = await store.purgeClinicalArchive({ now: later, purgeAfterMonths: 120 });
    expect(applied.entitiesPurged).toBe(11);
    expect(client.query.mock.calls.some(([text]) => String(text).startsWith("INSERT INTO audit_events"))).toBe(true);

    // Nothing due: no audit event.
    const quiet = archiveClient(database, { "SELECT request_id FROM cvg_clinical_archive WHERE collection = 'requests' AND archived_at": () => ({ rowCount: 0, rows: [] }) });
    pool.connect.mockResolvedValueOnce(quiet);
    expect((await store.purgeClinicalArchive({ now: later, purgeAfterMonths: 120 })).entitiesPurged).toBe(0);
    expect(quiet.query.mock.calls.some(([text]) => String(text).startsWith("INSERT INTO audit_events"))).toBe(false);
    await store.close();
  });

  it("forbids archiving and purging on the relational shadow runtime", async () => {
    pool.query.mockResolvedValueOnce(versionRow("1"))
      .mockResolvedValueOnce({ rowCount: 1, rows: [readyRuntimeSchema] })
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ marker_ready: true, tables_ready: true, write_shape_ready: true, constraints_ready: true }] });
    pool.connect.mockResolvedValueOnce(archiveClient(new FakeEntityDatabase(populated(), 1)));
    const store = await PostgresStore.createWithRelationalClinicalCore("postgres://test.invalid/cvg_test_archive_relational");
    await expect(store.archiveClinicalRecords()).rejects.toThrow("POSTGRES_RELATIONAL_ARCHIVE_UNSUPPORTED");
    await expect(store.purgeClinicalArchive({ purgeAfterMonths: 1 })).rejects.toThrow("POSTGRES_RELATIONAL_ARCHIVE_UNSUPPORTED");
    await store.close();
  });
});

describe("clinical archive SQL helpers", () => {
  const archiveClientStub = (rowCount: (values: readonly unknown[] | undefined, text: string) => number | null) => ({
    query: vi.fn(async (text: string, values?: unknown[]) => ({ rows: [], rowCount: rowCount(values, text) }))
  });

  it("inserts large archives in bounded chunks and detects a diverging insert", async () => {
    const plan = planClinicalArchive(populated(), { now: ARCHIVE_NOW });
    const many = { ...plan, partition: { ...plan.partition, entities: Array.from({ length: 4_500 }, (_, index) => ({ ...plan.partition.entities[0], entityKey: `k${index}` })) } };
    const client = archiveClientStub((values, text) => (text.includes("jsonb_to_recordset") ? JSON.parse(String(values?.[0])).length : 1));
    await insertClinicalArchive(client, many, { id: "batch-1", archivedAt: ARCHIVE_NOW });
    const chunks = client.query.mock.calls.filter(([text]) => text.includes("jsonb_to_recordset")).map(([, values]) => JSON.parse(String(values?.[0])).length);
    expect(chunks).toEqual([2_000, 2_000, 500]);
    expect(client.query.mock.calls[0][1]).toEqual(["batch-1", ARCHIVE_NOW.toISOString(), plan.cutoff.toISOString(), 1, 4_500, 1, null]);

    const diverging = archiveClientStub((_values, text) => (text.includes("jsonb_to_recordset") ? 0 : 1));
    await expect(insertClinicalArchive(diverging, plan, { id: "batch-2", archivedAt: ARCHIVE_NOW })).rejects.toThrow("POSTGRES_CLINICAL_ARCHIVE_DIVERGED:insert");
  });

  it("returns nothing when no archived request matches and converts string dates", async () => {
    const none = { query: vi.fn(async () => ({ rows: [], rowCount: 0 })) };
    expect(await readClinicalArchiveRows(none, { limit: 5 })).toEqual([]);
    expect(none.query).toHaveBeenCalledWith(expect.any(String), [null, null, 5]);
    const withRow = { query: vi.fn(async (text: string) => (text.includes("SELECT request_id FROM cvg_clinical_archive WHERE collection") ? { rows: [{ request_id: "r1" }], rowCount: 1 } : { rows: [{ request_id: "r1", collection: "requests", entity_key: "r1", position: 3, data: {}, archived_at: "2026-10-08T12:00:00.000Z", archive_batch: "b" }], rowCount: 1 })) };
    expect(await readClinicalArchiveRows(withRow, { limit: 5, requestId: "r1" })).toEqual([{ requestId: "r1", collection: "requests", entityKey: "r1", position: 3, data: {}, archivedAt: "2026-10-08T12:00:00.000Z", archiveBatch: "b" }]);
    expect(await readArchivedRequestRows({ query: vi.fn(async () => ({ rows: [], rowCount: 0 })) }, "r1")).toBeUndefined();
  });

  it("detects a purge that deleted a different number of rows than it counted", async () => {
    const client = { query: vi.fn(async (text: string) => {
      if (text.includes("archived_at <=")) return { rows: [{ request_id: "r1" }], rowCount: 1 };
      if (text.includes("count(*)")) return { rows: [{ entities: 3, attachment_keys: [] }], rowCount: 1 };
      return { rows: [], rowCount: 2 };
    }) };
    await expect(purgeClinicalArchiveRows(client, ARCHIVE_NOW, true)).rejects.toThrow("POSTGRES_CLINICAL_ARCHIVE_DIVERGED:purge");
    await expect(purgeClinicalArchiveRows(client, ARCHIVE_NOW, false)).resolves.toEqual({ requestsPurged: 1, entitiesPurged: 3, attachmentKeys: [] });
  });
});
