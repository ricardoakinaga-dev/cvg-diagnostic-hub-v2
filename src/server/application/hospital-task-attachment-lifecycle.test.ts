import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { hospitalOperationFixture, OPERATION_NOW } from "../../test/hospital-operation-fixtures";
import { createHospitalTaskAttachmentService } from "./hospital-task-attachment-service";
import type { HospitalTaskAttachment } from "@cvg/contracts";

function setup() {
  const f = hospitalOperationFixture(); const files = new Map<string, Buffer>();
  const storage = { put: vi.fn(async (key: string, bytes: Uint8Array) => { files.set(key, Buffer.from(bytes)); }), get: vi.fn(async (key: string) => { const bytes = files.get(key); if (!bytes) throw new Error("missing"); return bytes; }), remove: vi.fn(async (key: string) => { files.delete(key); }), exists: async (key: string) => files.has(key) };
  const scanner = { scan: vi.fn(async () => "CLEAN" as "CLEAN" | "QUARANTINED" | "FAILED") };
  const service = { ...f.service, ...createHospitalTaskAttachmentService({ store: f.store, storage, scanner, patientDiagnosticsAuxiliaryReader: () => ({ samples: [], results: [], attachments: [] }) }) };
  const bytes = Buffer.from("%PDF-1.7\nSynthetic task file\n");
  const session = (taskId: string, key: string, mimeType = "application/pdf", content = bytes) => service.createHospitalTaskAttachmentSession(f.user("user-vet"), taskId, { filename: "synthetic.pdf", mimeType, sizeBytes: content.length, checksum: createHash("sha256").update(content).digest("hex"), expectedVersion: 1, idempotencyKey: key });
  const patch = (id: string, values: Partial<HospitalTaskAttachment>) => f.store.transaction((state) => ({ state: { ...state, hospitalTaskAttachments: state.hospitalTaskAttachments.map((entry) => entry.id === id ? { ...entry, ...values } : entry) }, result: undefined }));
  return { ...f, service, files, storage, scanner, bytes, session, patch };
}
beforeEach(() => { vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(OPERATION_NOW); });
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe("task file sessions, visibility and recovery", () => {
  it("replays upload and finalization once while paging only owner pending files and public clean finalized files", async () => {
    const f = setup(); const task = await f.task("task", "INPATIENT"); const other = await f.task("other", "INPATIENT");
    const first = await f.session(task.task.id, "first"); expect(await f.session(task.task.id, "first")).toEqual(first); await f.session(task.task.id, "pending"); await f.session(other.task.id, "other");
    expect(await f.service.authorizeHospitalTaskAttachmentUpload(f.user("user-vet"), first.attachment.id)).toEqual({ sizeBytes: f.bytes.length }); expect(f.storage.put).not.toHaveBeenCalled();
    await expect(f.service.finalizeHospitalTaskAttachment(f.user("user-vet"), first.attachment.id, { expectedVersion: 1, idempotencyKey: "too-soon" })).rejects.toMatchObject({ code: "INVALID_STATE_TRANSITION" });
    await f.service.uploadHospitalTaskAttachment(f.user("user-vet"), first.attachment.id, f.bytes);
    await expect(f.service.authorizeHospitalTaskAttachmentUpload(f.user("user-vet"), first.attachment.id)).rejects.toMatchObject({ code: "INVALID_STATE_TRANSITION" });
    await expect(f.service.uploadHospitalTaskAttachment(f.user("user-vet"), first.attachment.id, f.bytes)).rejects.toMatchObject({ code: "INVALID_STATE_TRANSITION" });
    const finalize = { expectedVersion: 2, idempotencyKey: "finalize", correlationId: "synthetic-finalization" };
    await f.service.finalizeHospitalTaskAttachment(f.user("user-vet"), first.attachment.id, finalize); expect((await f.service.finalizeHospitalTaskAttachment(f.user("user-vet"), first.attachment.id, finalize)).attachment.version).toBe(3);
    const own = await f.service.listHospitalTaskAttachments(f.user("user-vet"), task.task.id, { limit: 1 }); expect(own.total).toBe(2); expect(own.nextCursor).toBeDefined();
    const next = await f.service.listHospitalTaskAttachments(f.user("user-vet"), task.task.id, { limit: 1, cursor: own.nextCursor }); expect(next.items[0].id).not.toBe(own.items[0].id);
    const visible = await f.service.listHospitalTaskAttachments(f.user("viewer"), task.task.id); expect(visible.items.map((entry) => entry.id)).toEqual([first.attachment.id]); expect(JSON.stringify(visible)).not.toMatch(/storageKey|uploadClaim/);
    expect(f.store.getState().auditEvents.filter((event) => event.eventType === "HospitalTaskAttachmentFinalized")).toHaveLength(1);
    expect((await f.service.downloadHospitalTaskAttachment(f.user("viewer"), first.attachment.id)).content).toEqual(f.bytes);
  });

  it("denies another uploader and expired sessions without writing bytes, then permits recovery of an expired claim", async () => {
    const f = setup(); const task = await f.task("task", "INPATIENT"); const prepared = await f.session(task.task.id, "upload");
    await expect(f.service.authorizeHospitalTaskAttachmentUpload(f.user("viewer"), prepared.attachment.id)).rejects.toMatchObject({ status: 404 });
    // Another clinical executor has upload permission, but does not own this private session.
    await f.store.transaction((state) => ({ state: { ...state, users: [...state.users, { ...state.users.find((user) => user.id === "user-vet")!, id: "other-vet", email: "other@example.test" }] }, result: undefined }));
    await expect(f.service.authorizeHospitalTaskAttachmentUpload(f.user("other-vet"), prepared.attachment.id)).rejects.toMatchObject({ status: 404 });
    await f.patch(prepared.attachment.id, { expiresAt: OPERATION_NOW }); await expect(f.service.uploadHospitalTaskAttachment(f.user("user-vet"), prepared.attachment.id, f.bytes)).rejects.toMatchObject({ code: "UPLOAD_EXPIRED" }); expect(f.storage.put).not.toHaveBeenCalled();
    await f.patch(prepared.attachment.id, { expiresAt: "2026-10-11T10:15:00Z", uploadClaimToken: "abandoned", uploadClaimExpiresAt: "2026-10-11T09:59:00Z" });
    expect((await f.service.uploadHospitalTaskAttachment(f.user("user-vet"), prepared.attachment.id, f.bytes)).attachment.uploadStatus).toBe("UPLOADED"); expect(f.files.size).toBe(1);
  });

  it("quarantines a declared MIME mismatch and unknown bytes even when a scanner returns clean", async () => {
    const f = setup(); const task = await f.task("task", "INPATIENT");
    for (const [key, mime, content] of [["wrong-mime", "image/png", f.bytes], ["unknown", "application/pdf", Buffer.from("unknown synthetic bytes")]] as const) {
      const prepared = await f.session(task.task.id, key, mime, content); const uploaded = await f.service.uploadHospitalTaskAttachment(f.user("user-vet"), prepared.attachment.id, content); expect(uploaded.attachment.scanStatus).toBe("QUARANTINED");
      await expect(f.service.finalizeHospitalTaskAttachment(f.user("user-vet"), prepared.attachment.id, { expectedVersion: 2, idempotencyKey: `finalize-${key}` })).rejects.toMatchObject({ code: "ATTACHMENT_QUARANTINED" });
    }
    expect((await f.service.listHospitalTaskAttachments(f.user("viewer"), task.task.id)).items).toEqual([]);
  });

  it.each(["missing", "expired", "replaced"] as const)("cleans bytes and rejects a %s claim after scanning instead of finalizing unauthorized work", async (condition) => {
    const f = setup(); const task = await f.task("task", "INPATIENT"); const prepared = await f.session(task.task.id, "upload");
    f.scanner.scan.mockImplementationOnce(async () => { await f.patch(prepared.attachment.id, condition === "missing" ? { uploadClaimExpiresAt: undefined } : condition === "expired" ? { uploadClaimExpiresAt: OPERATION_NOW } : { uploadClaimToken: "new-claim" }); return "CLEAN"; });
    await expect(f.service.uploadHospitalTaskAttachment(f.user("user-vet"), prepared.attachment.id, f.bytes)).rejects.toMatchObject({ code: "UPLOAD_CLAIM_LOST" });
    expect(f.files.size).toBe(0); const row = f.store.getState().hospitalTaskAttachments[0]; expect(row.uploadStatus).toBe("INITIATED"); if (condition === "replaced") expect(row.uploadClaimToken).toBe("new-claim");
  });

  it.each(["storage", "authorization"] as const)("preserves the %s failure when object cleanup also fails, and recovers only after the claim lease expires", async (stage) => {
    const f = setup(); const task = await f.task("task", "INPATIENT"); const prepared = await f.session(task.task.id, "upload");
    f.storage.remove.mockRejectedValueOnce(new Error("synthetic cleanup outage"));
    if (stage === "storage") f.storage.put.mockRejectedValueOnce(new Error("synthetic storage outage"));
    else f.scanner.scan.mockImplementationOnce(async () => { await f.patch(prepared.attachment.id, { uploadClaimToken: "replacement" }); return "CLEAN"; });
    await expect(f.service.uploadHospitalTaskAttachment(f.user("user-vet"), prepared.attachment.id, f.bytes)).rejects.toMatchObject({ code: stage === "storage" ? "STORAGE_UNAVAILABLE" : "UPLOAD_CLAIM_LOST" });
    expect(f.store.getState().hospitalTaskAttachments[0].uploadStatus).toBe("INITIATED");
    await expect(f.service.downloadHospitalTaskAttachment(f.user("viewer"), prepared.attachment.id)).rejects.toMatchObject({ status: 404 });
    await expect(f.service.uploadHospitalTaskAttachment(f.user("user-vet"), prepared.attachment.id, f.bytes)).rejects.toMatchObject({ code: "UPLOAD_IN_PROGRESS" });
    vi.setSystemTime("2026-10-11T10:05:01Z"); const uploaded = await f.service.uploadHospitalTaskAttachment(f.user("user-vet"), prepared.attachment.id, f.bytes); expect(uploaded.attachment).toMatchObject({ uploadStatus: "UPLOADED", scanStatus: "CLEAN", version: 2 });
    await f.service.finalizeHospitalTaskAttachment(f.user("user-vet"), prepared.attachment.id, { expectedVersion: 2, idempotencyKey: "finish-after-recovery" }); expect((await f.service.downloadHospitalTaskAttachment(f.user("viewer"), prepared.attachment.id)).content).toEqual(f.bytes);
    expect((await f.service.listHospitalTaskAttachments(f.user("viewer"), task.task.id)).items).toHaveLength(1);
  });

  it("keeps a committed winner's object when a loser notices that its upload claim was replaced", async () => {
    const f = setup(); const task = await f.task("task", "INPATIENT"); const prepared = await f.session(task.task.id, "upload");
    f.scanner.scan.mockImplementationOnce(async () => { const key = [...f.files.keys()][0]; await f.patch(prepared.attachment.id, { storageKey: key, uploadStatus: "UPLOADED", uploadClaimToken: undefined, scanStatus: "CLEAN", version: 2 }); return "CLEAN"; });
    await expect(f.service.uploadHospitalTaskAttachment(f.user("user-vet"), prepared.attachment.id, f.bytes)).rejects.toMatchObject({ code: "UPLOAD_CLAIM_LOST" }); expect(f.files.size).toBe(1); expect(f.storage.remove).not.toHaveBeenCalled();
  });
});
