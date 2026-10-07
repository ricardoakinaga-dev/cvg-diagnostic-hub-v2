import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { Attachment } from "../domain/models";
import type { FileStore } from "../storage/file-store-contract";
import { createDemoState } from "../store/fixtures";
import { MemoryStore } from "../store/memory-store";
import { createAttachmentService } from "./attachment-service";
import { createApplicationService } from "./service";

async function setup() {
  const objects = new Map<string, Buffer>();
  const storage: FileStore = {
    put: vi.fn(async (key: string, content: Uint8Array) => { objects.set(key, Buffer.from(content)); }),
    get: vi.fn(async (key: string) => { const content = objects.get(key); if (!content) throw new Error("object missing"); return content; }),
    remove: vi.fn(async (key: string) => { objects.delete(key); }),
    exists: async (key) => objects.has(key)
  };
  const scanner = { scan: vi.fn(async (): Promise<"CLEAN" | "QUARANTINED"> => "CLEAN") };
  const store = new MemoryStore(createDemoState());
  const service = createApplicationService(store, { storage });
  const vet = store.getState().users.find((user) => user.id === "user-vet")!;
  const rx = store.getState().users.find((user) => user.id === "user-rx")!;
  const request = await service.createRequest(vet, { patientId: "patient-thor", encounterId: "encounter-thor", priority: "ROUTINE", items: [{ serviceId: "service-xray" }] }, { idempotencyKey: "attachment-boundary-request" });
  const started = await service.startProcedure(rx, request.items[0].id, { expectedVersion: 1, idempotencyKey: "attachment-boundary-start" });
  const performed = await service.markProcedurePerformed(rx, request.items[0].id, { expectedVersion: started.item.version, idempotencyKey: "attachment-boundary-perform" });
  const draft = await service.createResultDraft(rx, request.items[0].id, { narrative: "Laudo sintético", content: {}, expectedVersion: performed.item.version, idempotencyKey: "attachment-boundary-draft" });
  const attachments = createAttachmentService({ store, storage, scanner, patientDiagnosticsAuxiliaryReader: ({ state }) => state });
  const bytes = Buffer.from("%PDF-1.7\nsynthetic boundary content\n");
  const input = { filename: "report.pdf", mimeType: "application/pdf", sizeBytes: bytes.length, checksum: createHash("sha256").update(bytes).digest("hex"), expectedVersion: draft.version.version, idempotencyKey: "attachment-boundary-session" };
  const session = await attachments.createAttachmentUploadSession(rx, draft.version.id, input);
  const finalize = { expectedVersion: draft.version.version, idempotencyKey: "attachment-boundary-finalize" };
  const patch = (changes: Partial<Attachment>) => store.transaction((state) => ({ state: { ...state, attachments: state.attachments.map((entry) => entry.id === session.attachment.id ? { ...entry, ...changes } : entry) }, result: undefined }));
  return { store, storage, objects, scanner, service, attachments, vet, rx, draft, bytes, input, session, finalize, patch };
}

describe("attachment command state and dependency boundaries", () => {
  it("replays session creation and finalization without duplicating effects or altering another attachment", async () => {
    const c = await setup();
    const replay = await c.attachments.createAttachmentUploadSession(c.rx, c.draft.version.id, c.input);
    expect(replay).toEqual(c.session);
    expect(c.store.getState().attachments).toHaveLength(1);
    const second = await c.attachments.createAttachmentUploadSession(c.rx, c.draft.version.id, { ...c.input, filename: "other.pdf", idempotencyKey: "attachment-other" });
    const other = c.store.getState().attachments.find((entry) => entry.id === second.attachment.id)!;
    await expect(c.attachments.authorizeAttachmentUpload(c.rx, c.session.attachment.id)).resolves.toEqual({ sizeBytes: c.bytes.length });
    await c.attachments.uploadAttachment(c.rx, c.session.attachment.id, c.bytes);
    const finalized = await c.attachments.finalizeAttachment(c.rx, c.session.attachment.id, c.finalize);
    const before = c.store.getState();
    await expect(c.attachments.finalizeAttachment(c.rx, c.session.attachment.id, c.finalize)).resolves.toEqual(finalized);
    expect(c.store.getState()).toEqual(before);
    expect(c.store.getState().attachments.find((entry) => entry.id === other.id)).toEqual(other);
    expect(c.store.getState().auditEvents.filter((event) => event.eventType === "AttachmentFinalized")).toHaveLength(1);
    expect(c.store.getState().outbox.filter((event) => event.eventType === "AttachmentFinalized")).toHaveLength(1);
    await expect(c.attachments.authorizeAttachmentUpload(c.rx, c.session.attachment.id)).rejects.toMatchObject({ code: "INVALID_STATE_TRANSITION", status: 409 });
    await expect(c.attachments.uploadAttachment(c.rx, c.session.attachment.id, c.bytes)).rejects.toMatchObject({ code: "INVALID_STATE_TRANSITION", status: 409 });
  });

  it("refuses new sessions after release or when the catalog disallows attachments", async () => {
    const c = await setup();
    await c.attachments.uploadAttachment(c.rx, c.session.attachment.id, c.bytes);
    await c.attachments.finalizeAttachment(c.rx, c.session.attachment.id, c.finalize);
    await c.service.releaseResult(c.rx, c.draft.result.id, { expectedVersion: c.draft.result.version, idempotencyKey: "release-without-upload" });
    const before = c.store.getState();
    await expect(c.attachments.createAttachmentUploadSession(c.rx, c.draft.version.id, { ...c.input, idempotencyKey: "released-session", expectedVersion: before.resultVersions[0].version })).rejects.toMatchObject({ code: "INVALID_STATE_TRANSITION", status: 409 });
    expect(c.store.getState()).toEqual(before);
    await c.store.transaction((state) => ({ state: { ...state, services: state.services.map((entry) => entry.id === "service-xray" ? { ...entry, allowsAttachment: false } : entry) }, result: undefined }));
    const disallowed = c.store.getState();
    await expect(c.attachments.createAttachmentUploadSession(c.rx, c.draft.version.id, { ...c.input, idempotencyKey: "disallowed-session", expectedVersion: disallowed.resultVersions[0].version })).rejects.toMatchObject({ code: "VALIDATION_ERROR", status: 400 });
    expect(c.store.getState()).toEqual(disallowed);
  });

  it("rejects expired sessions and incorrect byte counts before writing storage", async () => {
    const c = await setup();
    await expect(c.attachments.uploadAttachment(c.rx, c.session.attachment.id, c.bytes.subarray(1))).rejects.toMatchObject({ code: "ATTACHMENT_SIZE_MISMATCH", status: 400 });
    await c.patch({ expiresAt: "2020-01-01T00:00:00.000Z" });
    const before = c.store.getState();
    await expect(c.attachments.authorizeAttachmentUpload(c.rx, c.session.attachment.id)).rejects.toMatchObject({ code: "UPLOAD_EXPIRED", status: 409 });
    await expect(c.attachments.uploadAttachment(c.rx, c.session.attachment.id, c.bytes)).rejects.toMatchObject({ code: "UPLOAD_EXPIRED", status: 409 });
    expect(c.storage.put).not.toHaveBeenCalled();
    expect(c.store.getState()).toEqual(before);
  });

  it.each([
    { uploadStatus: "INITIATED" as const, scanStatus: "PENDING" as const, code: "INVALID_STATE_TRANSITION", status: 409 },
    { uploadStatus: "UPLOADED" as const, scanStatus: "PENDING" as const, code: "SCAN_UNAVAILABLE", status: 422 },
    { uploadStatus: "UPLOADED" as const, scanStatus: "QUARANTINED" as const, code: "ATTACHMENT_QUARANTINED", status: 422 },
    { uploadStatus: "UPLOADED" as const, scanStatus: "CLEAN" as const, expiresAt: "2020-01-01T00:00:00.000Z", code: "UPLOAD_EXPIRED", status: 409 }
  ])("refuses finalization with $code and leaves the transaction unchanged", async ({ code, status, ...changes }) => {
    const c = await setup();
    await c.patch(changes);
    const before = c.store.getState();
    await expect(c.attachments.finalizeAttachment(c.rx, c.session.attachment.id, c.finalize)).rejects.toMatchObject({ code, status });
    expect(c.store.getState()).toEqual(before);
  });

  it("preserves a retryable outage even if object cleanup and claim release also fail", async () => {
    const c = await setup();
    c.scanner.scan.mockRejectedValueOnce(new Error("scanner outage"));
    vi.spyOn(c.storage, "remove").mockRejectedValueOnce(new Error("cleanup outage"));
    const transaction = c.store.transaction.bind(c.store);
    vi.spyOn(c.store, "transaction").mockImplementationOnce(transaction).mockRejectedValueOnce(new Error("claim release outage"));
    await expect(c.attachments.uploadAttachment(c.rx, c.session.attachment.id, c.bytes)).rejects.toMatchObject({ code: "STORAGE_UNAVAILABLE", status: 503, details: { retryable: true } });
    expect(c.objects.size).toBe(1);
    expect(c.store.getState().attachments[0]).toMatchObject({ uploadStatus: "INITIATED", scanStatus: "PENDING" });
    await expect(c.attachments.finalizeAttachment(c.rx, c.session.attachment.id, c.finalize)).rejects.toMatchObject({ code: "INVALID_STATE_TRANSITION" });
    await c.patch({ uploadClaimExpiresAt: "2020-01-01T00:00:00.000Z" });
    await expect(c.attachments.uploadAttachment(c.rx, c.session.attachment.id, c.bytes)).resolves.toMatchObject({ attachment: { uploadStatus: "UPLOADED", scanStatus: "CLEAN" } });
  });

  it("retains the original commit failure when authoritative reconciliation is unavailable", async () => {
    const c = await setup();
    const transaction = c.store.transaction.bind(c.store);
    vi.spyOn(c.store, "transaction").mockImplementationOnce(transaction).mockRejectedValueOnce(new Error("commit unavailable"));
    vi.spyOn(c.store, "readState").mockRejectedValueOnce(new Error("read unavailable"));
    await expect(c.attachments.uploadAttachment(c.rx, c.session.attachment.id, c.bytes)).rejects.toThrow("commit unavailable");
    expect(c.objects.size).toBe(1);
    expect(c.storage.remove).not.toHaveBeenCalled();
    expect(c.store.getState().attachments[0].uploadStatus).toBe("INITIATED");
  });

  it("cleans an uncommitted upload even if releasing the claim fails", async () => {
    const c = await setup();
    const transaction = c.store.transaction.bind(c.store);
    vi.spyOn(c.store, "transaction").mockImplementationOnce(transaction).mockRejectedValueOnce(new Error("commit failed")).mockRejectedValueOnce(new Error("release failed"));
    await expect(c.attachments.uploadAttachment(c.rx, c.session.attachment.id, c.bytes)).rejects.toThrow("commit failed");
    expect(c.objects.size).toBe(0);
    expect(c.store.getState().attachments[0].uploadStatus).toBe("INITIATED");
  });

  async function released() {
    const c = await setup();
    await c.attachments.uploadAttachment(c.rx, c.session.attachment.id, c.bytes);
    await c.attachments.finalizeAttachment(c.rx, c.session.attachment.id, c.finalize);
    await c.service.releaseResult(c.rx, c.draft.result.id, { expectedVersion: c.draft.result.version, idempotencyKey: "attachment-boundary-release" });
    return c;
  }

  it("returns a storage outage only for a visible released attachment", async () => {
    const c = await released();
    await expect(c.attachments.downloadAttachment(c.vet, c.session.attachment.id)).resolves.toMatchObject({ content: c.bytes });
    vi.spyOn(c.storage, "get").mockRejectedValueOnce(new Error("storage unavailable"));
    const before = c.store.getState();
    await expect(c.attachments.downloadAttachment(c.vet, c.session.attachment.id)).rejects.toMatchObject({ code: "STORAGE_UNAVAILABLE", status: 503, details: { retryable: true } });
    expect(c.store.getState()).toEqual(before);
    await c.patch({ scanStatus: "QUARANTINED" });
    await expect(c.attachments.downloadAttachment(c.vet, c.session.attachment.id)).rejects.toMatchObject({ code: "NOT_FOUND", status: 404 });
  });

  it.each(["release-revoked", "scan-quarantined", "size-changed", "checksum-changed"])("rechecks %s after fetching bytes and writes no download audit", async (change) => {
    const c = await released();
    const get = c.storage.get.bind(c.storage);
    vi.spyOn(c.storage, "get").mockImplementationOnce(async (key) => {
      const bytes = await get(key);
      if (change === "release-revoked") {
        await c.store.transaction((state) => ({ state: { ...state, resultVersions: state.resultVersions.map((entry) => entry.id === c.draft.version.id ? { ...entry, status: "DRAFT" } : entry) }, result: undefined }));
      } else {
        await c.patch(change === "scan-quarantined" ? { scanStatus: "QUARANTINED" } : change === "size-changed" ? { sizeBytes: c.bytes.length + 1 } : { checksum: "0".repeat(64) });
      }
      return bytes;
    });
    const audits = c.store.getState().auditEvents;
    await expect(c.attachments.downloadAttachment(c.vet, c.session.attachment.id)).rejects.toMatchObject({ code: change === "size-changed" || change === "checksum-changed" ? "ATTACHMENT_INTEGRITY_FAILED" : "NOT_FOUND", status: change === "size-changed" || change === "checksum-changed" ? 503 : 404 });
    expect(c.store.getState().auditEvents).toEqual(audits);
  });
});
