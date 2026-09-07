import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createApplicationService } from "./service";
import type { StateStore } from "../domain/models";
import { createDemoState } from "../store/fixtures";
import { MemoryStore } from "../store/memory-store";
import { LocalFileStore } from "../storage/file-store";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function setup() {
  const root = await mkdtemp(path.join(os.tmpdir(), "cvg-attachments-"));
  const store = new MemoryStore(createDemoState());
  const service = createApplicationService(store, { storage: new LocalFileStore(root) });
  const actor = store.getState().users.find((user) => user.email === "vet@cvg.local");
  const imaging = store.getState().users.find((user) => user.email === "rx@cvg.local");
  if (!actor || !imaging) throw new Error("fixture actors missing");
  const request = await service.createRequest(actor, { patientId: "patient-thor", encounterId: "encounter-thor", priority: "ROUTINE", items: [{ serviceId: "service-xray" }] }, { idempotencyKey: `attachment-request-${Date.now()}` });
  const started = await service.startProcedure(imaging, request.items[0].id, { expectedVersion: request.items[0].version, idempotencyKey: `attachment-start-${Date.now()}` });
  await service.markProcedurePerformed(imaging, request.items[0].id, { expectedVersion: started.item.version, idempotencyKey: `attachment-performed-${Date.now()}` });
  const draft = await service.createResultDraft(imaging, request.items[0].id, { narrative: "Laudo com imagem.", content: { impression: "Sem alterações" }, expectedVersion: started.item.version + 1, idempotencyKey: `attachment-draft-${Date.now()}` });
  return { root, store, service, actor, imaging, requestId: request.id, versionId: draft.version.id, versionGuard: draft.version.version, resultId: draft.result.id, resultGuard: draft.result.version };
}

describe("secure attachment lifecycle", () => {
  it("rejects an unsupported declared MIME before creating an upload session", async () => {
    const context = await setup();
    try {
      await expect(context.service.createAttachmentUploadSession(context.imaging, context.versionId, {
        filename: "laudo.txt",
        mimeType: "text/plain",
        sizeBytes: 4,
        checksum: "a".repeat(64),
        expectedVersion: context.versionGuard,
        idempotencyKey: "attachment-invalid-mime"
      })).rejects.toMatchObject({ code: "VALIDATION_ERROR", status: 400 });
      expect(context.store.getState().attachments).toHaveLength(0);
    } finally {
      await rm(context.root, { recursive: true, force: true });
    }
  });

  it("binds every draft attachment operation to the draft author", async () => {
    const context = await setup();
    try {
      const content = Buffer.from("%PDF-1.7\nauthor-bound attachment\n");
      const checksum = createHash("sha256").update(content).digest("hex");
      const intruder = { ...context.imaging, id: "user-rx-intruder", email: "rx.intruder@cvg.local", displayName: "Outra radiologista", version: 1 };
      await context.store.transaction((state) => ({ state: { ...state, users: [...state.users, intruder] }, result: undefined }));

      await expect(context.service.createAttachmentUploadSession(intruder, context.versionId, {
        filename: "intruder.pdf",
        mimeType: "application/pdf",
        sizeBytes: content.length,
        checksum,
        expectedVersion: context.versionGuard,
        idempotencyKey: "attachment-intruder-session"
      })).rejects.toMatchObject({ code: "SCOPE_DENIED", status: 404 });

      const session = await context.service.createAttachmentUploadSession(context.imaging, context.versionId, {
        filename: "owned.pdf",
        mimeType: "application/pdf",
        sizeBytes: content.length,
        checksum,
        expectedVersion: context.versionGuard,
        idempotencyKey: "attachment-owned-session"
      });
      await expect(context.service.authorizeAttachmentUpload(intruder, session.attachment.id)).rejects.toMatchObject({ code: "SCOPE_DENIED", status: 404 });
      await expect(context.service.uploadAttachment(intruder, session.attachment.id, content)).rejects.toMatchObject({ code: "SCOPE_DENIED", status: 404 });
      await context.service.uploadAttachment(context.imaging, session.attachment.id, content);
      await expect(context.service.finalizeAttachment(intruder, session.attachment.id, {
        expectedVersion: context.versionGuard,
        idempotencyKey: "attachment-intruder-finalize"
      })).rejects.toMatchObject({ code: "SCOPE_DENIED", status: 404 });
    } finally {
      await rm(context.root, { recursive: true, force: true });
    }
  });

  it("deletes stored bytes when releasing a result with an expired uploaded attachment", async () => {
    const context = await setup();
    try {
      const content = Buffer.from("%PDF-1.7\nexpired abandoned attachment\n");
      const checksum = createHash("sha256").update(content).digest("hex");
      const session = await context.service.createAttachmentUploadSession(context.imaging, context.versionId, {
        filename: "abandoned.pdf",
        mimeType: "application/pdf",
        sizeBytes: content.length,
        checksum,
        expectedVersion: context.versionGuard,
        idempotencyKey: "attachment-abandoned-session"
      });
      await context.service.uploadAttachment(context.imaging, session.attachment.id, content);
      const uploadedAttachment = context.store.getState().attachments.find((attachment) => attachment.id === session.attachment.id);
      if (!uploadedAttachment) throw new Error("uploaded attachment missing");
      const localStorage = new LocalFileStore(context.root);
      expect(await localStorage.exists(uploadedAttachment.storageKey)).toBe(true);
      await context.store.transaction((state) => ({
        state: {
          ...state,
          attachments: state.attachments.map((attachment) => attachment.id === session.attachment.id
            ? { ...attachment, expiresAt: new Date(Date.now() - 1_000).toISOString() }
            : attachment)
        },
        result: undefined
      }));

      await expect(context.service.releaseResult(context.imaging, context.resultId, {
        expectedVersion: context.resultGuard,
        idempotencyKey: "release-with-expired-abandoned-session"
      })).resolves.toMatchObject({ version: { status: "RELEASED" } });
      expect(context.store.getState().attachments.some((attachment) => attachment.id === session.attachment.id)).toBe(false);
      expect(await localStorage.exists(uploadedAttachment.storageKey)).toBe(false);
      expect(context.store.getState().auditEvents).toEqual(expect.arrayContaining([
        expect.objectContaining({ eventType: "AttachmentUploadSessionExpired", entityId: session.attachment.id })
      ]));
    } finally {
      await rm(context.root, { recursive: true, force: true });
    }
  });

  it("waits for an active upload claim and cleans its object after the claim expires", async () => {
    const context = await setup();
    try {
      const content = Buffer.from("%PDF-1.7\ninterrupted claimed upload\n");
      const checksum = createHash("sha256").update(content).digest("hex");
      const session = await context.service.createAttachmentUploadSession(context.imaging, context.versionId, {
        filename: "claimed-crash.pdf",
        mimeType: "application/pdf",
        sizeBytes: content.length,
        checksum,
        expectedVersion: context.versionGuard,
        idempotencyKey: "attachment-claimed-crash-session"
      });
      const attachment = context.store.getState().attachments.find((entry) => entry.id === session.attachment.id);
      if (!attachment) throw new Error("claimed attachment missing");
      const claimToken = "interrupted-upload-claim";
      const claimedStorageKey = `${attachment.storageKey}.claim-${claimToken}`;
      const localStorage = new LocalFileStore(context.root);
      await localStorage.put(claimedStorageKey, content);
      await context.store.transaction((state) => ({
        state: {
          ...state,
          attachments: state.attachments.map((entry) => entry.id === attachment.id
            ? {
                ...entry,
                expiresAt: new Date(Date.now() - 1_000).toISOString(),
                uploadClaimToken: claimToken,
                uploadClaimExpiresAt: new Date(Date.now() + 60_000).toISOString()
              }
            : entry)
        },
        result: undefined
      }));

      await expect(context.service.releaseResult(context.imaging, context.resultId, {
        expectedVersion: context.resultGuard,
        idempotencyKey: "release-with-active-expired-claim"
      })).rejects.toMatchObject({ code: "RESULT_RELEASE_BLOCKED", status: 422 });
      expect(await localStorage.exists(claimedStorageKey)).toBe(true);
      expect(context.store.getState().attachments.some((entry) => entry.id === attachment.id)).toBe(true);

      await context.store.transaction((state) => ({
        state: {
          ...state,
          attachments: state.attachments.map((entry) => entry.id === attachment.id
            ? { ...entry, uploadClaimExpiresAt: new Date(Date.now() - 1_000).toISOString() }
            : entry)
        },
        result: undefined
      }));
      await expect(context.service.releaseResult(context.imaging, context.resultId, {
        expectedVersion: context.resultGuard,
        idempotencyKey: "release-with-stale-expired-claim"
      })).resolves.toMatchObject({ version: { status: "RELEASED" } });
      expect(await localStorage.exists(claimedStorageKey)).toBe(false);
      expect(context.store.getState().attachments.some((entry) => entry.id === attachment.id)).toBe(false);
    } finally {
      await rm(context.root, { recursive: true, force: true });
    }
  });

  it("keeps expired attachment metadata and draft state when storage cleanup fails", async () => {
    const context = await setup();
    try {
      const content = Buffer.from("%PDF-1.7\ncleanup failure\n");
      const checksum = createHash("sha256").update(content).digest("hex");
      const session = await context.service.createAttachmentUploadSession(context.imaging, context.versionId, {
        filename: "cleanup-failure.pdf",
        mimeType: "application/pdf",
        sizeBytes: content.length,
        checksum,
        expectedVersion: context.versionGuard,
        idempotencyKey: "attachment-cleanup-failure-session"
      });
      await context.service.uploadAttachment(context.imaging, session.attachment.id, content);
      const attachment = context.store.getState().attachments.find((entry) => entry.id === session.attachment.id);
      if (!attachment) throw new Error("uploaded attachment missing");
      await context.store.transaction((state) => ({
        state: {
          ...state,
          attachments: state.attachments.map((entry) => entry.id === attachment.id
            ? { ...entry, expiresAt: new Date(Date.now() - 1_000).toISOString() }
            : entry)
        },
        result: undefined
      }));
      const localStorage = new LocalFileStore(context.root);
      const failingService = createApplicationService(context.store, {
        storage: {
          put: localStorage.put.bind(localStorage),
          get: localStorage.get.bind(localStorage),
          delete: async () => { throw new Error("synthetic cleanup outage"); },
          remove: localStorage.remove.bind(localStorage),
          exists: localStorage.exists.bind(localStorage),
          healthcheck: localStorage.healthcheck.bind(localStorage)
        }
      });

      await expect(failingService.releaseResult(context.imaging, context.resultId, {
        expectedVersion: context.resultGuard,
        idempotencyKey: "release-with-cleanup-failure"
      })).rejects.toMatchObject({
        code: "STORAGE_UNAVAILABLE",
        status: 503,
        details: { retryable: true }
      });
      expect(await localStorage.exists(attachment.storageKey)).toBe(true);
      expect(context.store.getState().attachments.some((entry) => entry.id === attachment.id)).toBe(true);
      expect(context.store.getState().resultVersions.find((entry) => entry.id === context.versionId)?.status).toBe("DRAFT");
    } finally {
      await rm(context.root, { recursive: true, force: true });
    }
  });

  it("safely retries release when persistence rolls back after expired bytes were deleted", async () => {
    const context = await setup();
    try {
      const content = Buffer.from("%PDF-1.7\nrollback after cleanup\n");
      const checksum = createHash("sha256").update(content).digest("hex");
      const session = await context.service.createAttachmentUploadSession(context.imaging, context.versionId, {
        filename: "rollback-cleanup.pdf",
        mimeType: "application/pdf",
        sizeBytes: content.length,
        checksum,
        expectedVersion: context.versionGuard,
        idempotencyKey: "attachment-rollback-cleanup-session"
      });
      await context.service.uploadAttachment(context.imaging, session.attachment.id, content);
      const attachment = context.store.getState().attachments.find((entry) => entry.id === session.attachment.id);
      if (!attachment) throw new Error("uploaded attachment missing");
      await context.store.transaction((state) => ({
        state: {
          ...state,
          attachments: state.attachments.map((entry) => entry.id === attachment.id
            ? { ...entry, expiresAt: new Date(Date.now() - 1_000).toISOString() }
            : entry)
        },
        result: undefined
      }));
      const localStorage = new LocalFileStore(context.root);
      let simulatedCommitFailure = false;
      const rollbackAfterCleanupStore: StateStore = {
        getState: context.store.getState.bind(context.store),
        readState: context.store.readState.bind(context.store),
        transaction: async (operation) => {
          if (!simulatedCommitFailure) {
            await operation(context.store.getState());
            simulatedCommitFailure = true;
            throw new Error("synthetic release commit failure");
          }
          return context.store.transaction(operation);
        }
      };
      const retryableService = createApplicationService(rollbackAfterCleanupStore, { storage: localStorage });
      const releaseInput = {
        expectedVersion: context.resultGuard,
        idempotencyKey: "release-after-cleanup-rollback"
      };

      await expect(retryableService.releaseResult(context.imaging, context.resultId, releaseInput))
        .rejects.toThrow("synthetic release commit failure");
      expect(simulatedCommitFailure).toBe(true);
      expect(await localStorage.exists(attachment.storageKey)).toBe(false);
      expect(context.store.getState().attachments.some((entry) => entry.id === attachment.id)).toBe(true);
      expect(context.store.getState().resultVersions.find((entry) => entry.id === context.versionId)?.status).toBe("DRAFT");

      await expect(retryableService.releaseResult(context.imaging, context.resultId, releaseInput))
        .resolves.toMatchObject({ version: { status: "RELEASED" } });
      expect(await localStorage.exists(attachment.storageKey)).toBe(false);
      expect(context.store.getState().attachments.some((entry) => entry.id === attachment.id)).toBe(false);
      expect(context.store.getState().auditEvents.filter((event) =>
        event.eventType === "AttachmentUploadSessionExpired" && event.entityId === attachment.id
      )).toHaveLength(1);
    } finally {
      await rm(context.root, { recursive: true, force: true });
    }
  });

  it("does not delete expired attachment bytes before release authorization succeeds", async () => {
    const context = await setup();
    try {
      const content = Buffer.from("%PDF-1.7\nunauthorized cleanup\n");
      const checksum = createHash("sha256").update(content).digest("hex");
      const session = await context.service.createAttachmentUploadSession(context.imaging, context.versionId, {
        filename: "unauthorized-cleanup.pdf",
        mimeType: "application/pdf",
        sizeBytes: content.length,
        checksum,
        expectedVersion: context.versionGuard,
        idempotencyKey: "attachment-unauthorized-cleanup-session"
      });
      await context.service.uploadAttachment(context.imaging, session.attachment.id, content);
      const attachment = context.store.getState().attachments.find((entry) => entry.id === session.attachment.id);
      if (!attachment) throw new Error("uploaded attachment missing");
      await context.store.transaction((state) => ({
        state: {
          ...state,
          users: state.users.map((user) => user.id === context.imaging.id ? { ...user, serviceCodes: [] } : user),
          attachments: state.attachments.map((entry) => entry.id === attachment.id
            ? { ...entry, expiresAt: new Date(Date.now() - 1_000).toISOString() }
            : entry)
        },
        result: undefined
      }));
      const restrictedActor = context.store.getState().users.find((user) => user.id === context.imaging.id);
      if (!restrictedActor) throw new Error("restricted actor missing");
      const localStorage = new LocalFileStore(context.root);
      const deletedKeys: string[] = [];
      const guardedService = createApplicationService(context.store, {
        storage: {
          put: localStorage.put.bind(localStorage),
          get: localStorage.get.bind(localStorage),
          delete: async (key) => {
            deletedKeys.push(key);
            await localStorage.remove(key);
          },
          remove: localStorage.remove.bind(localStorage),
          exists: localStorage.exists.bind(localStorage),
          healthcheck: localStorage.healthcheck.bind(localStorage)
        }
      });

      await expect(guardedService.releaseResult(restrictedActor, context.resultId, {
        expectedVersion: context.resultGuard,
        idempotencyKey: "release-with-unauthorized-cleanup"
      })).rejects.toMatchObject({ code: "SCOPE_DENIED", status: 404 });
      expect(deletedKeys).toEqual([]);
      expect(await localStorage.exists(attachment.storageKey)).toBe(true);
      expect(context.store.getState().attachments.some((entry) => entry.id === attachment.id)).toBe(true);
    } finally {
      await rm(context.root, { recursive: true, force: true });
    }
  });

  it("rejects stored bytes whose size or checksum changed after finalization", async () => {
    const context = await setup();
    try {
      const content = Buffer.from("%PDF-1.7\nverified attachment bytes\n");
      const checksum = createHash("sha256").update(content).digest("hex");
      const session = await context.service.createAttachmentUploadSession(context.imaging, context.versionId, {
        filename: "integrity.pdf",
        mimeType: "application/pdf",
        sizeBytes: content.length,
        checksum,
        expectedVersion: context.versionGuard,
        idempotencyKey: "attachment-integrity-session"
      });
      await context.service.uploadAttachment(context.imaging, session.attachment.id, content);
      await context.service.finalizeAttachment(context.imaging, session.attachment.id, {
        expectedVersion: context.versionGuard,
        idempotencyKey: "attachment-integrity-finalize"
      });
      await context.service.releaseResult(context.imaging, context.resultId, {
        expectedVersion: context.resultGuard,
        idempotencyKey: "attachment-integrity-release"
      });
      const persisted = context.store.getState().attachments.find((attachment) => attachment.id === session.attachment.id);
      if (!persisted) throw new Error("persisted attachment missing");
      await writeFile(path.join(context.root, persisted.storageKey), Buffer.from("tampered"));

      await expect(context.service.downloadAttachment(context.actor, session.attachment.id)).rejects.toMatchObject({
        code: "ATTACHMENT_INTEGRITY_FAILED",
        status: 503
      });
    } finally {
      await rm(context.root, { recursive: true, force: true });
    }
  });

  it("requires idempotency and rejects stale result-version guards for session and finalization", async () => {
    const context = await setup();
    try {
      const content = Buffer.from("%PDF-1.7\nversion guarded attachment\n");
      const checksum = createHash("sha256").update(content).digest("hex");
      const currentVersion = context.store.getState().resultVersions.find((entry) => entry.id === context.versionId);
      if (!currentVersion) throw new Error("result version missing");

      await expect(context.service.createAttachmentUploadSession(context.imaging, context.versionId, {
        filename: "guarded.pdf",
        mimeType: "application/pdf",
        sizeBytes: content.length,
        checksum,
        expectedVersion: currentVersion.version
      })).rejects.toMatchObject({ code: "IDEMPOTENCY_KEY_REQUIRED", status: 400 });
      await expect(context.service.createAttachmentUploadSession(context.imaging, context.versionId, {
        filename: "guarded.pdf",
        mimeType: "application/pdf",
        sizeBytes: content.length,
        checksum,
        expectedVersion: currentVersion.version + 1,
        idempotencyKey: "attachment-stale-session"
      })).rejects.toMatchObject({ code: "STALE_VERSION", status: 409 });

      const session = await context.service.createAttachmentUploadSession(context.imaging, context.versionId, {
        filename: "guarded.pdf",
        mimeType: "application/pdf",
        sizeBytes: content.length,
        checksum,
        expectedVersion: currentVersion.version,
        idempotencyKey: "attachment-fresh-session"
      });
      await context.service.uploadAttachment(context.imaging, session.attachment.id, content);
      await expect(context.service.finalizeAttachment(context.imaging, session.attachment.id, {
        expectedVersion: currentVersion.version + 1,
        idempotencyKey: "attachment-stale-finalize"
      })).rejects.toMatchObject({ code: "STALE_VERSION", status: 409 });
      expect(context.store.getState().attachments.find((entry) => entry.id === session.attachment.id)?.uploadStatus).toBe("UPLOADED");
    } finally {
      await rm(context.root, { recursive: true, force: true });
    }
  });

  it("maps private storage upload failures to an explicit retryable dependency error", async () => {
    const context = await setup();
    try {
      const content = Buffer.from("%PDF-1.7\nstorage unavailable\n");
      const checksum = createHash("sha256").update(content).digest("hex");
      const session = await context.service.createAttachmentUploadSession(context.imaging, context.versionId, {
        filename: "storage-failure.pdf",
        mimeType: "application/pdf",
        sizeBytes: content.length,
        checksum,
        expectedVersion: context.versionGuard,
        idempotencyKey: "attachment-storage-failure-session"
      });
      const localStorage = new LocalFileStore(context.root);
      const failingService = createApplicationService(context.store, {
        storage: {
          put: async () => { throw new Error("synthetic private storage outage"); },
          get: localStorage.get.bind(localStorage),
          delete: localStorage.remove.bind(localStorage),
          remove: localStorage.remove.bind(localStorage),
          exists: localStorage.exists.bind(localStorage),
          healthcheck: localStorage.healthcheck.bind(localStorage)
        }
      });

      await expect(failingService.uploadAttachment(context.imaging, session.attachment.id, content)).rejects.toMatchObject({
        code: "STORAGE_UNAVAILABLE",
        status: 503,
        details: { retryable: true }
      });
      expect(context.store.getState().attachments.find((entry) => entry.id === session.attachment.id)?.uploadStatus).toBe("INITIATED");
    } finally {
      await rm(context.root, { recursive: true, force: true });
    }
  });

  it("claims an upload before external I/O and never lets a stale writer overwrite its object", async () => {
    const context = await setup();
    const firstPutStarted = deferred();
    const allowFirstPut = deferred();
    try {
      const content = Buffer.from("%PDF-1.7\nclaimed upload\n");
      const checksum = createHash("sha256").update(content).digest("hex");
      const session = await context.service.createAttachmentUploadSession(context.imaging, context.versionId, {
        filename: "claimed.pdf",
        mimeType: "application/pdf",
        sizeBytes: content.length,
        checksum,
        expectedVersion: context.versionGuard,
        idempotencyKey: "attachment-claimed-session"
      });
      const localStorage = new LocalFileStore(context.root);
      const writtenKeys: string[] = [];
      const racingService = createApplicationService(context.store, {
        storage: {
          put: async (key, bytes) => {
            writtenKeys.push(key);
            if (writtenKeys.length > 1) throw new Error("a competing writer reached object storage");
            firstPutStarted.resolve();
            await allowFirstPut.promise;
            await localStorage.put(key, bytes);
          },
          get: localStorage.get.bind(localStorage),
          delete: localStorage.remove.bind(localStorage),
          remove: localStorage.remove.bind(localStorage),
          exists: localStorage.exists.bind(localStorage),
          healthcheck: localStorage.healthcheck.bind(localStorage)
        }
      });

      const firstUpload = racingService.uploadAttachment(context.imaging, session.attachment.id, content);
      await firstPutStarted.promise;
      await expect(racingService.uploadAttachment(context.imaging, session.attachment.id, content)).rejects.toMatchObject({
        code: "UPLOAD_IN_PROGRESS",
        status: 409
      });
      expect(writtenKeys).toHaveLength(1);
      allowFirstPut.resolve();
      const uploaded = await firstUpload;

      const persisted = context.store.getState().attachments.find((entry) => entry.id === session.attachment.id);
      expect(uploaded.attachment).not.toHaveProperty("uploadClaimToken");
      expect(persisted).toMatchObject({ uploadStatus: "UPLOADED", uploadClaimToken: undefined, uploadClaimExpiresAt: undefined });
      expect(writtenKeys[0]).toBe(persisted?.storageKey);
    } finally {
      allowFirstPut.resolve();
      await rm(context.root, { recursive: true, force: true });
    }
  });

  it("reconciles an ambiguous transaction result without deleting a committed object", async () => {
    const context = await setup();
    try {
      const content = Buffer.from("%PDF-1.7\nambiguous commit\n");
      const checksum = createHash("sha256").update(content).digest("hex");
      const session = await context.service.createAttachmentUploadSession(context.imaging, context.versionId, {
        filename: "ambiguous.pdf",
        mimeType: "application/pdf",
        sizeBytes: content.length,
        checksum,
        expectedVersion: context.versionGuard,
        idempotencyKey: "attachment-ambiguous-session"
      });
      let simulatedCommitFailure = false;
      const ambiguousStore: StateStore = {
        getState: context.store.getState.bind(context.store),
        readState: context.store.readState.bind(context.store),
        transaction: async (operation) => {
          const result = await context.store.transaction(operation);
          const attachment = context.store.getState().attachments.find((entry) => entry.id === session.attachment.id);
          if (!simulatedCommitFailure && attachment?.uploadStatus === "UPLOADED") {
            simulatedCommitFailure = true;
            throw new Error("synthetic ambiguous commit response");
          }
          return result;
        }
      };
      const localStorage = new LocalFileStore(context.root);
      const ambiguousService = createApplicationService(ambiguousStore, { storage: localStorage });

      const uploaded = await ambiguousService.uploadAttachment(context.imaging, session.attachment.id, content);
      const persisted = context.store.getState().attachments.find((entry) => entry.id === session.attachment.id);

      expect(simulatedCommitFailure).toBe(true);
      expect(uploaded.attachment.uploadStatus).toBe("UPLOADED");
      expect(persisted?.storageKey).toBeTruthy();
      expect(await localStorage.exists(persisted!.storageKey)).toBe(true);
    } finally {
      await rm(context.root, { recursive: true, force: true });
    }
  });

  it("rechecks session expiry after upload I/O and compensates the uncommitted object", async () => {
    const context = await setup();
    try {
      const content = Buffer.from("%PDF-1.7\nexpired during upload\n");
      const checksum = createHash("sha256").update(content).digest("hex");
      const session = await context.service.createAttachmentUploadSession(context.imaging, context.versionId, {
        filename: "expires.pdf",
        mimeType: "application/pdf",
        sizeBytes: content.length,
        checksum,
        expectedVersion: context.versionGuard,
        idempotencyKey: "attachment-expiry-session"
      });
      const localStorage = new LocalFileStore(context.root);
      let writtenKey = "";
      const expiringService = createApplicationService(context.store, {
        storage: {
          put: async (key, bytes) => {
            writtenKey = key;
            await localStorage.put(key, bytes);
            await context.store.transaction((state) => ({
              state: {
                ...state,
                attachments: state.attachments.map((entry) => entry.id === session.attachment.id
                  ? { ...entry, expiresAt: new Date(0).toISOString() }
                  : entry)
              },
              result: undefined
            }));
          },
          get: localStorage.get.bind(localStorage),
          delete: localStorage.delete.bind(localStorage),
          remove: localStorage.remove.bind(localStorage),
          exists: localStorage.exists.bind(localStorage),
          healthcheck: localStorage.healthcheck.bind(localStorage)
        }
      });

      await expect(expiringService.uploadAttachment(context.imaging, session.attachment.id, content)).rejects.toMatchObject({
        code: "UPLOAD_EXPIRED",
        status: 409
      });

      const persisted = context.store.getState().attachments.find((entry) => entry.id === session.attachment.id);
      expect(await localStorage.exists(writtenKey)).toBe(false);
      expect(persisted).toMatchObject({ uploadStatus: "INITIATED", uploadClaimToken: undefined, uploadClaimExpiresAt: undefined });
    } finally {
      await rm(context.root, { recursive: true, force: true });
    }
  });

  it("rechecks authorization after upload I/O and deletes the uncommitted claimed object", async () => {
    const context = await setup();
    try {
      const content = Buffer.from("%PDF-1.7\nauthorization changed during upload\n");
      const checksum = createHash("sha256").update(content).digest("hex");
      const session = await context.service.createAttachmentUploadSession(context.imaging, context.versionId, {
        filename: "reauthorize.pdf",
        mimeType: "application/pdf",
        sizeBytes: content.length,
        checksum,
        expectedVersion: context.versionGuard,
        idempotencyKey: "attachment-reauthorize-session"
      });
      const originalAttachment = context.store.getState().attachments.find((entry) => entry.id === session.attachment.id);
      if (!originalAttachment) throw new Error("attachment missing");
      const localStorage = new LocalFileStore(context.root);
      const writtenKeys: string[] = [];
      const deletedKeys: string[] = [];
      const racingService = createApplicationService(context.store, {
        storage: {
          put: async (key, bytes) => {
            writtenKeys.push(key);
            await localStorage.put(key, bytes);
            await context.store.transaction((state) => ({
              state: {
                ...state,
                users: state.users.map((user) => user.id === context.imaging.id ? { ...user, active: false } : user)
              },
              result: undefined
            }));
          },
          get: localStorage.get.bind(localStorage),
          delete: async (key) => {
            deletedKeys.push(key);
            await localStorage.remove(key);
          },
          remove: localStorage.remove.bind(localStorage),
          exists: localStorage.exists.bind(localStorage),
          healthcheck: localStorage.healthcheck.bind(localStorage)
        }
      });

      await expect(racingService.uploadAttachment(context.imaging, session.attachment.id, content)).rejects.toMatchObject({
        code: "UNAUTHENTICATED",
        status: 401
      });

      const persisted = context.store.getState().attachments.find((entry) => entry.id === session.attachment.id);
      expect(writtenKeys).toHaveLength(1);
      expect(writtenKeys[0]).not.toBe(originalAttachment.storageKey);
      expect(deletedKeys).toEqual(writtenKeys);
      expect(await localStorage.exists(writtenKeys[0])).toBe(false);
      expect(await localStorage.exists(originalAttachment.storageKey)).toBe(false);
      expect(persisted).toMatchObject({ storageKey: originalAttachment.storageKey, uploadStatus: "INITIATED", uploadClaimToken: undefined, uploadClaimExpiresAt: undefined });
    } finally {
      await rm(context.root, { recursive: true, force: true });
    }
  });

  it("keeps an uncompensated orphan inaccessible when storage deletion itself fails", async () => {
    const context = await setup();
    try {
      const content = Buffer.from("%PDF-1.7\norphan remains inaccessible\n");
      const checksum = createHash("sha256").update(content).digest("hex");
      const session = await context.service.createAttachmentUploadSession(context.imaging, context.versionId, {
        filename: "orphan.pdf",
        mimeType: "application/pdf",
        sizeBytes: content.length,
        checksum,
        expectedVersion: context.versionGuard,
        idempotencyKey: "attachment-orphan-session"
      });
      const originalAttachment = context.store.getState().attachments.find((entry) => entry.id === session.attachment.id);
      if (!originalAttachment) throw new Error("attachment missing");
      const localStorage = new LocalFileStore(context.root);
      let orphanKey = "";
      const racingService = createApplicationService(context.store, {
        storage: {
          put: async (key, bytes) => {
            orphanKey = key;
            await localStorage.put(key, bytes);
            await context.store.transaction((state) => ({
              state: {
                ...state,
                users: state.users.map((user) => user.id === context.imaging.id ? { ...user, active: false } : user)
              },
              result: undefined
            }));
          },
          get: localStorage.get.bind(localStorage),
          delete: async () => { throw new Error("synthetic cleanup outage"); },
          remove: localStorage.remove.bind(localStorage),
          exists: localStorage.exists.bind(localStorage),
          healthcheck: localStorage.healthcheck.bind(localStorage)
        }
      });

      await expect(racingService.uploadAttachment(context.imaging, session.attachment.id, content)).rejects.toMatchObject({
        code: "UNAUTHENTICATED",
        status: 401
      });

      const persisted = context.store.getState().attachments.find((entry) => entry.id === session.attachment.id);
      expect(orphanKey).not.toBe(originalAttachment.storageKey);
      expect(await localStorage.exists(orphanKey)).toBe(true);
      expect(await localStorage.exists(originalAttachment.storageKey)).toBe(false);
      expect(persisted).toMatchObject({ storageKey: originalAttachment.storageKey, uploadStatus: "INITIATED", uploadClaimToken: undefined, uploadClaimExpiresAt: undefined });
    } finally {
      await rm(context.root, { recursive: true, force: true });
    }
  });

  it("preserves a concurrent authorization failure instead of reporting storage unavailable", async () => {
    const context = await setup();
    try {
      const content = Buffer.from("%PDF-1.7\nconcurrent authorization\n");
      const checksum = createHash("sha256").update(content).digest("hex");
      const session = await context.service.createAttachmentUploadSession(context.imaging, context.versionId, {
        filename: "concurrent.pdf",
        mimeType: "application/pdf",
        sizeBytes: content.length,
        checksum,
        expectedVersion: context.versionGuard,
        idempotencyKey: "attachment-concurrent-session"
      });
      await context.service.uploadAttachment(context.imaging, session.attachment.id, content);
      await context.service.finalizeAttachment(context.imaging, session.attachment.id, { expectedVersion: context.versionGuard, idempotencyKey: "attachment-concurrent-finalize" });
      await context.service.releaseResult(context.imaging, context.resultId, { expectedVersion: context.resultGuard, idempotencyKey: "attachment-concurrent-release" });
      const localStorage = new LocalFileStore(context.root);
      const racingService = createApplicationService(context.store, {
        storage: {
          put: localStorage.put.bind(localStorage),
          get: async (key) => {
            await context.store.transaction((state) => ({
              state: { ...state, users: state.users.map((user) => user.id === context.actor.id ? { ...user, active: false } : user) },
              result: undefined
            }));
            return localStorage.get(key);
          },
          delete: localStorage.remove.bind(localStorage),
          remove: localStorage.remove.bind(localStorage),
          exists: localStorage.exists.bind(localStorage),
          healthcheck: localStorage.healthcheck.bind(localStorage)
        }
      });

      await expect(racingService.downloadAttachment(context.actor, session.attachment.id)).rejects.toMatchObject({
        code: "UNAUTHENTICATED",
        status: 401
      });
    } finally {
      await rm(context.root, { recursive: true, force: true });
    }
  });

  it("denies every attachment operation outside the executor serviceCodes", async () => {
    const context = await setup();
    const content = Buffer.from("%PDF-1.7\nservice scope report\n");
    const checksum = createHash("sha256").update(content).digest("hex");
    const setServiceCodes = async (serviceCodes: string[]) => {
      await context.store.transaction((state) => ({
        state: { ...state, users: state.users.map((user) => user.id === context.imaging.id ? { ...user, serviceCodes } : user) },
        result: undefined
      }));
      const actor = context.store.getState().users.find((user) => user.id === context.imaging.id);
      if (!actor) throw new Error("imaging actor missing");
      return actor;
    };
    try {
      const restrictedForSession = await setServiceCodes([]);
      await expect(context.service.createAttachmentUploadSession(restrictedForSession, context.versionId, {
        filename: "scope.pdf",
        mimeType: "application/pdf",
        sizeBytes: content.length,
        checksum,
        expectedVersion: context.versionGuard,
        idempotencyKey: "attachment-scope-denied-session"
      })).rejects.toMatchObject({ code: "SCOPE_DENIED", status: 404 });

      const authorized = await setServiceCodes(["XRAY_THORAX"]);
      const session = await context.service.createAttachmentUploadSession(authorized, context.versionId, {
        filename: "scope.pdf",
        mimeType: "application/pdf",
        sizeBytes: content.length,
        checksum,
        expectedVersion: context.versionGuard,
        idempotencyKey: "attachment-scope-session"
      });
      const restrictedForUpload = await setServiceCodes([]);
      await expect(context.service.uploadAttachment(restrictedForUpload, session.attachment.id, content)).rejects.toMatchObject({ code: "SCOPE_DENIED", status: 404 });

      const authorizedForUpload = await setServiceCodes(["XRAY_THORAX"]);
      await context.service.uploadAttachment(authorizedForUpload, session.attachment.id, content);
      const restrictedForFinalize = await setServiceCodes([]);
      await expect(context.service.finalizeAttachment(restrictedForFinalize, session.attachment.id, {
        expectedVersion: context.versionGuard,
        idempotencyKey: "attachment-scope-denied-finalize"
      })).rejects.toMatchObject({ code: "SCOPE_DENIED", status: 404 });

      const authorizedForFinalize = await setServiceCodes(["XRAY_THORAX"]);
      await context.service.finalizeAttachment(authorizedForFinalize, session.attachment.id, {
        expectedVersion: context.versionGuard,
        idempotencyKey: "attachment-scope-finalize"
      });
      await context.service.releaseResult(authorizedForFinalize, context.resultId, { expectedVersion: context.resultGuard, idempotencyKey: "attachment-scope-release" });
      const restrictedForDownload = await setServiceCodes([]);
      await expect(context.service.downloadAttachment(restrictedForDownload, session.attachment.id)).rejects.toMatchObject({ code: "SCOPE_DENIED", status: 404 });
    } finally {
      await rm(context.root, { recursive: true, force: true });
    }
  });

  it("requires clean finalized content before release and streams only authorized finalized bytes", async () => {
    const context = await setup();
    try {
      const content = Buffer.from("%PDF-1.7\nsynthetic report\n");
      const checksum = createHash("sha256").update(content).digest("hex");
      const session = await context.service.createAttachmentUploadSession(context.imaging, context.versionId, { filename: "laudo clínico.pdf", mimeType: "application/pdf", sizeBytes: content.length, checksum, expectedVersion: context.versionGuard, idempotencyKey: "attachment-session" });
      expect(session.uploadUrl).toContain(`/attachments/${session.attachment.id}/content`);
      expect(session.attachment).not.toHaveProperty("storageKey");
      await expect(context.service.releaseResult(context.imaging, context.resultId, { expectedVersion: context.resultGuard, idempotencyKey: "release-blocked" })).rejects.toMatchObject({ code: "RESULT_RELEASE_BLOCKED" });
      const uploaded = await context.service.uploadAttachment(context.imaging, session.attachment.id, content);
      expect(uploaded.attachment.scanStatus).toBe("CLEAN");
      const finalized = await context.service.finalizeAttachment(context.imaging, session.attachment.id, { expectedVersion: context.versionGuard, idempotencyKey: "attachment-finalize" });
      expect(finalized.attachment.uploadStatus).toBe("FINALIZED");
      expect(finalized.attachment).not.toHaveProperty("storageKey");
      await expect(context.service.downloadAttachment(context.actor, session.attachment.id)).rejects.toMatchObject({ code: "NOT_FOUND", status: 404 });
      const released = await context.service.releaseResult(context.imaging, context.resultId, { expectedVersion: context.resultGuard, idempotencyKey: "release-after-attachment" });
      expect((await context.service.timeline(context.actor, context.requestId)).items.some((event) => event.entityType === "Attachment")).toBe(true);
      const downloaded = await context.service.downloadAttachment(context.actor, session.attachment.id);
      expect(downloaded.content.equals(content)).toBe(true);
      expect(context.store.getState().auditEvents).toContainEqual(expect.objectContaining({
        eventType: "AttachmentDownloaded",
        actorId: context.actor.id,
        entityId: session.attachment.id
      }));
      await context.service.voidResult(context.imaging, released.result.id, {
        reason: "Invalidar anexo com o resultado",
        expectedVersion: released.result.version,
        idempotencyKey: "void-after-attachment"
      });
      await expect(context.service.downloadAttachment(context.actor, session.attachment.id)).rejects.toMatchObject({ code: "NOT_FOUND", status: 404 });
    } finally {
      await rm(context.root, { recursive: true, force: true });
    }
  });

  it("quarantines content whose detected signature does not match its declared MIME", async () => {
    const context = await setup();
    try {
      const content = Buffer.from("not a PDF");
      const session = await context.service.createAttachmentUploadSession(context.imaging, context.versionId, { filename: "laudo.pdf", mimeType: "application/pdf", sizeBytes: content.length, checksum: createHash("sha256").update(content).digest("hex"), expectedVersion: context.versionGuard, idempotencyKey: "quarantine-session" });
      const uploaded = await context.service.uploadAttachment(context.imaging, session.attachment.id, content);
      expect(uploaded.attachment.scanStatus).toBe("QUARANTINED");
      await expect(context.service.finalizeAttachment(context.imaging, session.attachment.id, { expectedVersion: context.versionGuard, idempotencyKey: "quarantine-finalize" })).rejects.toMatchObject({ code: "ATTACHMENT_QUARANTINED" });
    } finally {
      await rm(context.root, { recursive: true, force: true });
    }
  });

  it("rejects a content checksum mismatch before writing the private object", async () => {
    const context = await setup();
    try {
      const declaredContent = Buffer.from("%PDF-1.7\nsynthetic report\n");
      const receivedContent = Buffer.from("%PDF-1.7\nsynthetic reporT\n");
      const session = await context.service.createAttachmentUploadSession(context.imaging, context.versionId, {
        filename: "laudo.pdf",
        mimeType: "application/pdf",
        sizeBytes: declaredContent.length,
        checksum: createHash("sha256").update(declaredContent).digest("hex"),
        expectedVersion: context.versionGuard,
        idempotencyKey: "checksum-session"
      });

      await expect(context.service.uploadAttachment(context.imaging, session.attachment.id, receivedContent)).rejects.toMatchObject({ code: "ATTACHMENT_CHECKSUM_MISMATCH", status: 400 });
      expect(context.store.getState().attachments.find((entry) => entry.id === session.attachment.id)?.uploadStatus).toBe("INITIATED");
    } finally {
      await rm(context.root, { recursive: true, force: true });
    }
  });
});
