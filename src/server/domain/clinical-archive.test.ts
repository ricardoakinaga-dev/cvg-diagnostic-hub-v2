import { describe, expect, it } from "vitest";
import type { ClinicalArchiveRow, StoreState } from "./models";
import { ARCHIVE_NOW, RECENT, withCompletedRequest } from "../../test/archive-fixtures";
import { archiveAuditEvent, archiveEntries, archivedEntitiesOf, archiveRows, archiveSummary, planClinicalArchive, purgeAuditEvent, purgeCutoff } from "./clinical-archive";
import { createDemoState } from "../store/fixtures";
import { MemoryStore } from "../store/memory-store";

function populated(): StoreState {
  let state = createDemoState("clinical-archive-password");
  state = withCompletedRequest(state, "old");
  state = withCompletedRequest(state, "older-mel", { at: "2023-01-10T12:00:00.000Z", patientId: "patient-mel" });
  state = withCompletedRequest(state, "recent", { at: RECENT });
  return state;
}

describe("memory store clinical archive", () => {
  it("moves old requests out of the aggregate, records one audit event and keeps the rest", async () => {
    const store = new MemoryStore(populated());
    const before = await store.readStateSnapshot();
    const summary = await store.archiveClinicalRecords({ now: ARCHIVE_NOW, actor: "system:test" });

    expect(summary).toMatchObject({ requestsArchived: 2, attachmentsArchived: 2, cutoff: "2024-10-08T12:00:00.000Z" });
    expect(summary.batchId).toMatch(/^archive-/);
    expect(summary.entitiesArchived).toBe(2 * 11);
    expect([...summary.requestIds].sort()).toEqual(["request-old", "request-older-mel"]);
    const state = store.getState();
    expect(state.requests.map((request) => request.id)).toEqual(["request-recent"]);
    expect(state.items.map((item) => item.requestId)).toEqual(["request-recent", "request-recent"]);
    expect(state.patients).toHaveLength(3);
    const audits = state.auditEvents.filter((event) => event.eventType === "ClinicalRecordsArchived");
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ entityType: "ClinicalArchive", entityId: summary.batchId, actorId: "system:test", metadata: { requestsArchived: 2, entitiesArchived: 22, attachmentsArchived: 2, cutoff: summary.cutoff } });
    expect(JSON.stringify(audits[0])).not.toContain("request-old");
    expect((await store.readStateSnapshot()).version).toBe(before.version + 1);
  });

  it("does nothing, and bumps no version, when there is nothing to archive", async () => {
    const store = new MemoryStore(createDemoState("clinical-archive-empty-password"));
    const before = await store.readStateSnapshot();
    const summary = await store.archiveClinicalRecords({ now: ARCHIVE_NOW });
    expect(summary).toMatchObject({ requestsArchived: 0, entitiesArchived: 0, attachmentsArchived: 0, requestIds: [] });
    expect(summary.batchId).toBeUndefined();
    expect(await store.readStateSnapshot()).toEqual(before);
  });

  it("reports a dry run without writing anything", async () => {
    const store = new MemoryStore(populated());
    const before = await store.readStateSnapshot();
    const summary = await store.archiveClinicalRecords({ now: ARCHIVE_NOW, dryRun: true });
    expect(summary.requestsArchived).toBe(2);
    expect(summary.batchId).toBeUndefined();
    expect(await store.readStateSnapshot()).toEqual(before);
    expect(await store.readClinicalArchive({ limit: 10 })).toEqual([]);
  });

  it("honours a shorter active window and defaults to 24 months", async () => {
    const store = new MemoryStore(populated());
    expect((await store.archiveClinicalRecords({ now: ARCHIVE_NOW, dryRun: true, activeMonths: 1 })).requestsArchived).toBe(3);
    expect((await store.archiveClinicalRecords({ now: ARCHIVE_NOW, dryRun: true })).requestsArchived).toBe(2);
    expect((await store.archiveClinicalRecords({ dryRun: true })).requestsArchived).toBeGreaterThanOrEqual(0);
  });

  it("serves summaries by patient and by request, newest first, with a limit", async () => {
    const store = new MemoryStore(populated());
    await store.archiveClinicalRecords({ now: ARCHIVE_NOW });
    const thor = await store.readClinicalArchive({ patientId: "patient-thor", limit: 10 });
    expect(thor).toEqual([{
      requestId: "request-old", requestCode: "EX-old", patientId: "patient-thor", encounterId: "encounter-thor", requestingDepartmentCode: "INPATIENT",
      archivedAt: ARCHIVE_NOW.toISOString(), completedAt: "2024-06-01T12:00:00.000Z",
      services: [{ code: "HEMOGRAM", name: "Hemograma", departmentCode: "LABORATORY" }, { code: "XRAY_THORAX", name: "RX de tórax", departmentCode: "RADIOLOGY" }],
      attachmentCount: 1
    }]);
    const all = await store.readClinicalArchive({ limit: 10 });
    expect(all.map((entry) => entry.requestId)).toEqual(["request-old", "request-older-mel"]);
    expect((await store.readClinicalArchive({ limit: 1 })).map((entry) => entry.requestId)).toEqual(["request-old"]);
    expect((await store.readClinicalArchive({ requestId: "request-older-mel", limit: 5 })).map((entry) => entry.patientId)).toEqual(["patient-mel"]);
    expect(await store.readClinicalArchive({ patientId: "patient-mel-2", limit: 5 })).toEqual([]);
  });

  it("returns every archived entity of one request in the original order", async () => {
    const store = new MemoryStore(populated());
    await store.archiveClinicalRecords({ now: ARCHIVE_NOW });
    const rows = await store.readArchivedRequest("request-old");
    expect(rows?.map((row) => `${row.collection}:${row.entityKey}`)).toContain("resultVersions:version-old-2");
    expect(rows?.every((row) => row.requestId === "request-old")).toBe(true);
    expect(await store.readArchivedRequest("request-recent")).toBeUndefined();
    expect(await store.readArchivedRequest("request-missing")).toBeUndefined();
  });

  it("purges nothing until a retention period is configured", async () => {
    const store = new MemoryStore(populated());
    await store.archiveClinicalRecords({ now: ARCHIVE_NOW });
    const later = new Date("2036-01-01T00:00:00.000Z");
    for (const purgeAfterMonths of [undefined, 0, -1, 1.5]) {
      expect(await store.purgeClinicalArchive({ now: later, purgeAfterMonths })).toEqual({ requestsPurged: 0, entitiesPurged: 0, attachmentKeys: [] });
    }
    expect(await store.purgeClinicalArchive({ now: later })).toEqual({ requestsPurged: 0, entitiesPurged: 0, attachmentKeys: [] });
    expect(await store.readClinicalArchive({ limit: 10 })).toHaveLength(2);
  });

  it("purges archive rows past the period, returns attachment keys and audits counts", async () => {
    const store = new MemoryStore(populated());
    await store.archiveClinicalRecords({ now: ARCHIVE_NOW });
    // 10 years after archiving, minus a day: nothing is due yet.
    expect((await store.purgeClinicalArchive({ now: new Date("2036-10-07T12:00:00.000Z"), purgeAfterMonths: 120 })).requestsPurged).toBe(0);
    const dueAt = new Date("2036-10-08T12:00:00.000Z");
    const dry = await store.purgeClinicalArchive({ now: dueAt, purgeAfterMonths: 120, dryRun: true });
    expect(dry).toMatchObject({ requestsPurged: 2, entitiesPurged: 22 });
    expect(await store.readClinicalArchive({ limit: 10 })).toHaveLength(2);

    const purged = await store.purgeClinicalArchive({ now: dueAt, purgeAfterMonths: 120 });
    expect(purged.requestsPurged).toBe(2);
    expect(purged.attachmentKeys.sort()).toEqual(["attachments/result-old/uuid-old/laudo.pdf", "attachments/result-older-mel/uuid-older-mel/laudo.pdf"]);
    expect(await store.readClinicalArchive({ limit: 10 })).toEqual([]);
    const audit = store.getState().auditEvents.filter((event) => event.eventType === "ClinicalArchivePurged");
    expect(audit).toHaveLength(1);
    expect(audit[0].metadata).toEqual({ requestsPurged: 2, entitiesPurged: 22, attachmentsPurged: 2 });
    // Idempotent: a second run finds nothing and adds no audit event.
    expect((await store.purgeClinicalArchive({ now: dueAt, purgeAfterMonths: 120 })).entitiesPurged).toBe(0);
    expect(store.getState().auditEvents.filter((event) => event.eventType === "ClinicalArchivePurged")).toHaveLength(1);
  });

  it("clears the archive on reset", async () => {
    const store = new MemoryStore(populated());
    await store.archiveClinicalRecords({ now: ARCHIVE_NOW });
    await store.reset(createDemoState("clinical-archive-reset-password"));
    expect(await store.readClinicalArchive({ limit: 10 })).toEqual([]);
  });
});

describe("clinical archive helpers", () => {
  it("builds rows, summaries and audit events from a plan", () => {
    const plan = planClinicalArchive(populated(), { now: ARCHIVE_NOW });
    const rows = archiveRows(plan, "batch-1", ARCHIVE_NOW);
    expect(rows).toHaveLength(22);
    expect(rows[0]).toMatchObject({ archiveBatch: "batch-1", archivedAt: ARCHIVE_NOW.toISOString() });
    expect(archiveSummary(plan).batchId).toBeUndefined();
    const summary = { ...archiveSummary(plan, "batch-1"), batchId: "batch-1" };
    expect(archiveAuditEvent(summary, ARCHIVE_NOW).actorId).toBeUndefined();
    expect(archiveAuditEvent(summary, ARCHIVE_NOW, "someone").actorId).toBe("someone");
    expect(purgeAuditEvent({ requestsPurged: 1, entitiesPurged: 2, attachmentKeys: ["a"] }, ARCHIVE_NOW).metadata.attachmentsPurged).toBe(1);
  });

  it("computes the purge cutoff only for positive whole months", () => {
    expect(purgeCutoff(ARCHIVE_NOW, undefined)).toBeUndefined();
    expect(purgeCutoff(ARCHIVE_NOW, 0)).toBeUndefined();
    expect(purgeCutoff(ARCHIVE_NOW, 2.5)).toBeUndefined();
    expect(purgeCutoff(ARCHIVE_NOW, 12)?.toISOString()).toBe("2025-10-08T12:00:00.000Z");
  });

  it("summarises tolerant of missing services, missing request rows and later item dates", () => {
    const plan = planClinicalArchive(populated(), { now: ARCHIVE_NOW });
    const rows: ClinicalArchiveRow[] = archiveRows(plan, "batch-1", ARCHIVE_NOW).filter((row) => row.requestId === "request-old");
    const withLater = rows.map((row) => (row.collection === "items" && row.entityKey === "item-rx-old" ? { ...row, data: { ...row.data, completedAt: "2024-07-01T12:00:00.000Z" } } : row));
    const [entry] = archiveEntries(withLater, []);
    expect(entry.services).toEqual([{ code: "service-hemogram", name: "service-hemogram", departmentCode: "LABORATORY" }, { code: "service-xray", name: "service-xray", departmentCode: "RADIOLOGY" }]);
    expect(entry.completedAt).toBe("2024-07-01T12:00:00.000Z");
    // Two items of the same service are listed once.
    const duplicated = withLater.map((row) => (row.collection === "items" ? { ...row, data: { ...row.data, serviceId: "service-hemogram" } } : row));
    expect(archiveEntries(duplicated, createDemoState("x").services)[0].services).toHaveLength(1);
    // Rows without their request row produce no entry.
    expect(archiveEntries(rows.filter((row) => row.collection !== "requests"), [])).toEqual([]);
    expect(archivedEntitiesOf(rows, "samples")).toHaveLength(1);
  });

  it("orders entries by request update time and breaks ties by id", () => {
    const state = withCompletedRequest(withCompletedRequest(createDemoState("clinical-archive-order-password"), "b"), "a");
    const rows = archiveRows(planClinicalArchive(state, { now: ARCHIVE_NOW }), "batch-1", ARCHIVE_NOW);
    expect(archiveEntries(rows, state.services).map((entry) => entry.requestId)).toEqual(["request-a", "request-b"]);
    const newer = rows.map((row) => (row.collection === "requests" && row.entityKey === "request-b" ? { ...row, data: { ...row.data, updatedAt: "2024-07-01T12:00:00.000Z" } } : row));
    expect(archiveEntries(newer, state.services).map((entry) => entry.requestId)).toEqual(["request-b", "request-a"]);
  });
});
