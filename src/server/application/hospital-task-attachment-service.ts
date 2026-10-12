import { createHash, randomUUID } from "node:crypto";
import type { HospitalTaskAttachment, HospitalTaskAttachmentSession } from "@cvg/contracts";
import type { User } from "../domain/models";
import type { CommandMeta } from "./service-types";
import type { ApplicationServiceContext } from "./service-context";
import type { HospitalTaskAttachmentFilters, HospitalTaskAttachmentUploadInput } from "./hospital-task-attachment-types";
import { ApiError } from "../http/envelope";
import { assertAttachmentMetadata, createAudit, createOutbox, ensureExpectedVersion, findOrThrowScoped, id, now, requireActiveUser, requireIdempotencyKey, saveIdempotency, withIdempotency } from "./service-common";
import { requireHospitalTaskAccess } from "./hospital-task-policy";
import { pagePlannerObjects, requireOpenTask, validateTaskBody } from "./hospital-task-common";
import { publicTaskAttachment, requireDownloadableTaskAttachment, requireTaskAttachmentAccess, requireUploadWindow } from "./hospital-task-attachment-policy";
import { createHospitalTaskAttachmentUpload } from "./hospital-task-attachment-upload";
import { hospitalTaskAttachmentFiltersSchema, hospitalTaskAttachmentFinalizeSchema, hospitalTaskAttachmentUploadSchema } from "../http/hospital-task-attachment-schemas";

export function createHospitalTaskAttachmentService(context: ApplicationServiceContext) {
  const { store, storage } = context;
  return {
    ...createHospitalTaskAttachmentUpload(context),
    async listHospitalTaskAttachments(actor: User, taskId: string, filters: HospitalTaskAttachmentFilters = {}) {
      validateTaskBody(hospitalTaskAttachmentFiltersSchema, filters); const state = await store.readState(); const current = requireActiveUser(state, actor); const task = findOrThrowScoped(state.hospitalTasks.find((entry) => entry.id === taskId)); requireHospitalTaskAccess(state, current, "hospital_task.view", task); requireHospitalTaskAccess(state, current, "hospital_task.attachment.view", task);
      const page = pagePlannerObjects(state.hospitalTaskAttachments.filter((entry) => entry.taskId === taskId && (entry.createdBy === current.id || entry.uploadStatus === "FINALIZED" && entry.scanStatus === "CLEAN")), filters); return { ...page, items: page.items.map(publicTaskAttachment) };
    },
    async createHospitalTaskAttachmentSession(actor: User, taskId: string, input: HospitalTaskAttachmentUploadInput): Promise<HospitalTaskAttachmentSession> {
      return store.transaction((state) => {
        const current = requireActiveUser(state, actor); const task = findOrThrowScoped(state.hospitalTasks.find((entry) => entry.id === taskId)); requireHospitalTaskAccess(state, current, "hospital_task.view", task); requireHospitalTaskAccess(state, current, "hospital_task.attachment.upload", task); validateTaskBody(hospitalTaskAttachmentUploadSchema, input); requireIdempotencyKey(input.idempotencyKey);
        const scope = `POST:/hospital-tasks/${taskId}/attachments/upload-sessions`; const replay = withIdempotency<HospitalTaskAttachmentSession>(state, current.id, scope, input.idempotencyKey, { input });
        if (replay.found) { const attachment = findOrThrowScoped(state.hospitalTaskAttachments.find((entry) => entry.id === replay.existing!.attachment.id)); requireTaskAttachmentAccess(state, current, attachment, "hospital_task.attachment.upload", true); return { state, result: { attachment: publicTaskAttachment(attachment), uploadUrl: replay.existing!.uploadUrl, expiresAt: attachment.expiresAt } }; }
        requireOpenTask(task); ensureExpectedVersion(task.version, input.expectedVersion); const metadata = assertAttachmentMetadata(input); const timestamp = now();
        const attachment: HospitalTaskAttachment = { id: id("task-attachment"), taskId, safeName: metadata.safeName, declaredMime: metadata.mimeType, sizeBytes: input.sizeBytes, checksum: metadata.checksum, storageKey: `hospital-tasks/${task.id}/${randomUUID()}/${metadata.safeName}`, scanStatus: "PENDING", uploadStatus: "INITIATED", expiresAt: new Date(Date.now() + 900_000).toISOString(), createdBy: current.id, createdAt: timestamp, updatedAt: timestamp, version: 1 };
        const next = { ...state, hospitalTaskAttachments: [...state.hospitalTaskAttachments, attachment], auditEvents: [...state.auditEvents, createAudit("HospitalTaskAttachmentSessionCreated", current.id, "HospitalTaskAttachment", attachment.id, input.correlationId ?? id("corr"), undefined, "INITIATED", { taskId, sizeBytes: attachment.sizeBytes })] }; const result = { attachment: publicTaskAttachment(attachment), uploadUrl: `/api/v1/hospital-task-attachments/${attachment.id}/content`, expiresAt: attachment.expiresAt };
        return { state: saveIdempotency(next, current.id, scope, input.idempotencyKey, result, { input }), result };
      });
    },
    async finalizeHospitalTaskAttachment(actor: User, attachmentId: string, input: CommandMeta) {
      return store.transaction((state) => {
        const current = requireActiveUser(state, actor); const previous = findOrThrowScoped(state.hospitalTaskAttachments.find((entry) => entry.id === attachmentId)); requireTaskAttachmentAccess(state, current, previous, "hospital_task.attachment.upload", true); validateTaskBody(hospitalTaskAttachmentFinalizeSchema, input); requireIdempotencyKey(input.idempotencyKey);
        const scope = `POST:/hospital-task-attachments/${attachmentId}/finalize`; const replay = withIdempotency<{ attachment: ReturnType<typeof publicTaskAttachment> }>(state, current.id, scope, input.idempotencyKey, { input }); if (replay.found) return { state, result: { attachment: publicTaskAttachment(previous) } };
        ensureExpectedVersion(previous.version, input.expectedVersion); requireUploadWindow(previous); if (previous.uploadStatus !== "UPLOADED") throw new ApiError("INVALID_STATE_TRANSITION", "Envie o arquivo antes de finalizar.", 409); if (previous.scanStatus !== "CLEAN") throw new ApiError("ATTACHMENT_QUARANTINED", "A varredura não liberou este arquivo.", 422);
        const attachment: HospitalTaskAttachment = { ...previous, uploadStatus: "FINALIZED", version: previous.version + 1, updatedAt: now() }; const correlation = input.correlationId ?? id("corr"); const next = { ...state, hospitalTaskAttachments: state.hospitalTaskAttachments.map((entry) => entry.id === attachmentId ? attachment : entry), auditEvents: [...state.auditEvents, createAudit("HospitalTaskAttachmentFinalized", current.id, "HospitalTaskAttachment", attachmentId, correlation, "UPLOADED", "FINALIZED", { taskId: attachment.taskId })], outbox: [...state.outbox, createOutbox("HospitalTaskAttachmentFinalized", "HospitalTaskAttachment", attachmentId, correlation, { taskId: attachment.taskId, version: attachment.version })] }; const result = { attachment: publicTaskAttachment(attachment) };
        return { state: saveIdempotency(next, current.id, scope, input.idempotencyKey, result, { input }), result };
      });
    },
    async downloadHospitalTaskAttachment(actor: User, attachmentId: string) {
      const state = await store.readState(); const current = requireActiveUser(state, actor); const attachment = findOrThrowScoped(state.hospitalTaskAttachments.find((entry) => entry.id === attachmentId)); requireDownloadableTaskAttachment(state, current, attachment);
      let content: Buffer; try { content = await storage.get(attachment.storageKey); } catch { throw new ApiError("STORAGE_UNAVAILABLE", "O arquivo privado não está disponível.", 503, { retryable: true }); }
      const authoritative = await store.transaction((latest) => {
        const refreshed = requireActiveUser(latest, actor); const updated = findOrThrowScoped(latest.hospitalTaskAttachments.find((entry) => entry.id === attachmentId)); requireDownloadableTaskAttachment(latest, refreshed, updated);
        if (updated.version !== attachment.version || updated.storageKey !== attachment.storageKey || content.length !== updated.sizeBytes || createHash("sha256").update(content).digest("hex") !== updated.checksum) throw new ApiError("ATTACHMENT_INTEGRITY_FAILED", "A integridade do arquivo não pôde ser confirmada.", 503);
        const audit = createAudit("HospitalTaskAttachmentDownloaded", refreshed.id, "HospitalTaskAttachment", attachmentId, id("corr"), undefined, undefined, { taskId: updated.taskId }); return { state: { ...latest, auditEvents: [...latest.auditEvents, audit] }, result: publicTaskAttachment(updated) };
      });
      return { attachment: authoritative, content };
    }
  };
}
