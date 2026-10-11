import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { StoreState } from "../domain/models";
import { createDemoState } from "../store/fixtures";
import { MemoryStore } from "../store/memory-store";
import type { FileStore } from "../storage/file-store";
import { ARCHIVE_NOW, withCompletedRequest } from "../../test/archive-fixtures";
import { createApplicationService } from "./service";

async function context(mutate: (state: StoreState) => StoreState = (state) => state) {
  const content = Buffer.from("%PDF-1.4\nsynthetic-archived-report\n");
  let state = withCompletedRequest(createDemoState("archive-access-test-password"), "old");
  state = { ...state, attachments: state.attachments.map((entry) => ({ ...entry, sizeBytes: content.length, checksum: createHash("sha256").update(content).digest("hex") })) };
  const store = new MemoryStore(mutate(state));
  await store.archiveClinicalRecords({ now: ARCHIVE_NOW });
  const storage: FileStore = { put: vi.fn(), get: vi.fn(async () => content), remove: vi.fn(), exists: vi.fn(async () => true) };
  const actor = store.getState().users.find((user) => user.email === "vet@cvg.local")!;
  const service = createApplicationService(store, { storage });
  return { store, storage, service, actor, content };
}

describe("audited clinical archive access", () => {
  it.each(["deactivation", "scope"])("rechecks archive list access after concurrent %s", async (change) => {
    const c = await context();
    const read = c.store.readClinicalArchive.bind(c.store);
    vi.spyOn(c.store, "readClinicalArchive").mockImplementationOnce(async (query) => {
      const entries = await read(query);
      await c.store.transaction((state) => ({ state: { ...state, users: state.users.map((user) => user.id === c.actor.id ? { ...user, ...(change === "deactivation" ? { active: false } : { patientIds: [] }) } : user) }, result: undefined }));
      return entries;
    });
    await expect(c.service.listPatientArchive(c.actor, "patient-thor")).rejects.toMatchObject({ status: change === "deactivation" ? 401 : 404 });
  });

  it("durably records the actor, request, versions and correlation before returning narratives", async () => {
    const c = await context();
    const view = await c.service.getArchivedRequest(c.actor, "request-old", "corr-archive-test");
    expect(view.items[0].results[0].versions).toHaveLength(2);
    const event = c.store.getState().auditEvents.find((entry) => entry.eventType === "ArchivedRequestRead")!;
    expect(event).toMatchObject({ actorId: c.actor.id, entityId: "request-old", correlationId: "corr-archive-test", metadata: { archived: true, versionCount: 2 } });
    expect(JSON.parse(String(event.metadata.resultVersionIds))).toEqual(["version-old-1", "version-old-2"]);
    expect(JSON.stringify(event)).not.toContain("Versão final.");
  });

  it("does not return clinical data when its access audit cannot be persisted", async () => {
    const c = await context();
    vi.spyOn(c.store, "appendReadAudit").mockRejectedValueOnce(new Error("audit unavailable"));
    await expect(c.service.getArchivedRequest(c.actor, "request-old")).rejects.toThrow("audit unavailable");
  });

  it("rechecks scope after archive I/O and before the audit", async () => {
    const c = await context();
    const original = c.store.readArchivedRequest.bind(c.store);
    vi.spyOn(c.store, "readArchivedRequest").mockImplementationOnce(async (requestId) => {
      const rows = await original(requestId);
      await c.store.transaction((state) => ({ state: { ...state, users: state.users.map((user) => user.id === c.actor.id ? { ...user, patientIds: [] } : user) }, result: undefined }));
      return rows;
    });
    await expect(c.service.getArchivedRequest(c.actor, "request-old")).rejects.toMatchObject({ status: 404 });
    expect(c.store.getState().auditEvents.filter((event) => event.eventType === "ArchivedRequestRead")).toEqual([]);
  });

  it("rechecks authorization after audit persistence", async () => {
    const c = await context();
    const append = c.store.appendReadAudit.bind(c.store);
    vi.spyOn(c.store, "appendReadAudit").mockImplementationOnce(async (event) => {
      await append(event);
      await c.store.transaction((state) => ({ state: { ...state, users: state.users.map((user) => user.id === c.actor.id ? { ...user, active: false } : user) }, result: undefined }));
    });
    await expect(c.service.getArchivedRequest(c.actor, "request-old")).rejects.toMatchObject({ status: 401 });
  });

  it("does not return narratives purged while the read audit was persisted", async () => {
    const c = await context();
    const append = c.store.appendReadAudit.bind(c.store);
    vi.spyOn(c.store, "appendReadAudit").mockImplementationOnce(async (event) => {
      await append(event);
      await c.store.purgeClinicalArchive({ now: new Date("2036-10-09T00:00:00.000Z"), purgeAfterMonths: 120 });
    });
    await expect(c.service.getArchivedRequest(c.actor, "request-old")).rejects.toMatchObject({ status: 404 });
  });

  it("downloads a clean finalized archived attachment through the existing endpoint service", async () => {
    const c = await context();
    expect(c.store.getState().attachments).toEqual([]);
    const download = await c.service.downloadAttachment(c.actor, "attachment-old");
    expect(download.content).toEqual(c.content);
    expect(c.storage.get).toHaveBeenCalledWith("attachments/result-old/uuid-old/laudo.pdf");
    expect(c.store.getState().auditEvents.at(-1)).toMatchObject({ eventType: "AttachmentDownloaded", actorId: c.actor.id, entityId: "attachment-old", metadata: { archived: true, requestId: "request-old", resultVersionId: "version-old-2" } });
  });

  it("denies an out-of-scope archived attachment before reading storage", async () => {
    const c = await context();
    await expect(c.service.downloadAttachment({ ...c.actor, patientIds: [] }, "attachment-old")).rejects.toMatchObject({ status: 404 });
    expect(c.storage.get).not.toHaveBeenCalled();
  });

  it.each(["QUARANTINED", "FAILED"] as const)("does not expose an archived attachment with scan status %s", async (scanStatus) => {
    const c = await context((state) => ({ ...state, attachments: state.attachments.map((entry) => ({ ...entry, scanStatus })) }));
    await expect(c.service.downloadAttachment(c.actor, "attachment-old")).rejects.toMatchObject({ code: "NOT_FOUND", status: 404 });
    expect((await c.service.getArchivedRequest(c.actor, "request-old")).attachments).toEqual([]);
    expect(c.storage.get).not.toHaveBeenCalled();
  });

  it("denies archived attachments belonging to a voided version", async () => {
    const c = await context((state) => ({ ...state, resultVersions: state.resultVersions.map((entry) => entry.id === "version-old-2" ? { ...entry, status: "VOIDED" } : entry) }));
    await expect(c.service.downloadAttachment(c.actor, "attachment-old")).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect((await c.service.getArchivedRequest(c.actor, "request-old")).attachments).toEqual([]);
  });

  it("maps storage unavailability to a retryable error", async () => {
    const c = await context();
    vi.mocked(c.storage.get).mockRejectedValueOnce(new Error("storage unavailable"));
    await expect(c.service.downloadAttachment(c.actor, "attachment-old")).rejects.toMatchObject({ code: "STORAGE_UNAVAILABLE", status: 503 });
  });

  it("verifies archived bytes before recording a successful download", async () => {
    const c = await context();
    vi.mocked(c.storage.get).mockResolvedValueOnce(Buffer.from("corrupt"));
    await expect(c.service.downloadAttachment(c.actor, "attachment-old")).rejects.toMatchObject({ code: "ATTACHMENT_INTEGRITY_FAILED", status: 503 });
    expect(c.store.getState().auditEvents.filter((event) => event.eventType === "AttachmentDownloaded")).toEqual([]);
  });

  it("does not return bytes when access is revoked while storage is being read", async () => {
    const c = await context();
    vi.mocked(c.storage.get).mockImplementationOnce(async () => {
      await c.store.transaction((state) => ({ state: { ...state, users: state.users.map((user) => user.id === c.actor.id ? { ...user, patientIds: [] } : user) }, result: undefined }));
      return c.content;
    });
    await expect(c.service.downloadAttachment(c.actor, "attachment-old")).rejects.toMatchObject({ status: 404 });
    expect(c.store.getState().auditEvents.filter((event) => event.eventType === "AttachmentDownloaded")).toEqual([]);
  });

  it("does not return bytes of a record purged during storage I/O", async () => {
    const c = await context();
    vi.mocked(c.storage.get).mockImplementationOnce(async () => {
      await c.store.purgeClinicalArchive({ now: new Date("2036-10-09T00:00:00.000Z"), purgeAfterMonths: 120 });
      return c.content;
    });
    await expect(c.service.downloadAttachment(c.actor, "attachment-old")).rejects.toMatchObject({ code: "NOT_FOUND", status: 404 });
  });
});
