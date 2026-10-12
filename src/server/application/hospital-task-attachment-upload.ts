import { createHash, randomUUID } from "node:crypto";
import type { HospitalTaskAttachment } from "@cvg/contracts";
import type { User } from "../domain/models";
import type { ApplicationServiceContext } from "./service-context";
import { ApiError } from "../http/envelope";
import { reportAttachmentScan } from "../security/attachment-scan-signal";
import { deleteStoredObject, detectedMime, findOrThrowScoped, now, requireActiveUser } from "./service-common";
import { publicTaskAttachment, requireTaskAttachmentAccess, requireUploadWindow } from "./hospital-task-attachment-policy";

export function createHospitalTaskAttachmentUpload({ store, storage, scanner }: ApplicationServiceContext) {
  const authorize = async (actor: User, attachmentId: string) => {
    const state = await store.readState(); const current = requireActiveUser(state, actor); const attachment = findOrThrowScoped(state.hospitalTaskAttachments.find((entry) => entry.id === attachmentId)); requireTaskAttachmentAccess(state, current, attachment, "hospital_task.attachment.upload", true); requireUploadWindow(attachment);
    if (attachment.uploadStatus !== "INITIATED") throw new ApiError("INVALID_STATE_TRANSITION", "Esta sessão de envio já foi utilizada.", 409);
    return { sizeBytes: attachment.sizeBytes };
  };
  return {
    authorizeHospitalTaskAttachmentUpload: authorize,
    async uploadHospitalTaskAttachment(actor: User, attachmentId: string, content: Uint8Array) {
      const bytes = Buffer.from(content); const claimToken = randomUUID();
      const claimed = await store.transaction((state) => {
        const current = requireActiveUser(state, actor); const attachment = findOrThrowScoped(state.hospitalTaskAttachments.find((entry) => entry.id === attachmentId)); requireTaskAttachmentAccess(state, current, attachment, "hospital_task.attachment.upload", true); requireUploadWindow(attachment);
        if (attachment.uploadStatus !== "INITIATED") throw new ApiError("INVALID_STATE_TRANSITION", "Esta sessão de envio já foi utilizada.", 409);
        if (attachment.uploadClaimToken && (!attachment.uploadClaimExpiresAt || Date.parse(attachment.uploadClaimExpiresAt) > Date.now())) throw new ApiError("UPLOAD_IN_PROGRESS", "Este arquivo já está sendo enviado.", 409);
        if (attachment.sizeBytes !== bytes.length) throw new ApiError("ATTACHMENT_SIZE_MISMATCH", "O tamanho recebido difere do declarado.", 400);
        if (attachment.checksum !== createHash("sha256").update(bytes).digest("hex")) throw new ApiError("ATTACHMENT_CHECKSUM_MISMATCH", "O conteúdo recebido difere do declarado.", 400);
        const claimedAttachment = { ...attachment, uploadClaimToken: claimToken, uploadClaimExpiresAt: new Date(Date.now() + 300_000).toISOString() };
        return { state: { ...state, hospitalTaskAttachments: state.hospitalTaskAttachments.map((entry) => entry.id === attachmentId ? claimedAttachment : entry) }, result: { attachment, storageKey: `${attachment.storageKey}.claim-${claimToken}` } };
      });
      const cleanup = async () => {
        const state = await store.readState(); if (!state.hospitalTaskAttachments.some((entry) => entry.storageKey === claimed.storageKey)) await deleteStoredObject(storage, claimed.storageKey);
        await store.transaction((latest) => ({ state: { ...latest, hospitalTaskAttachments: latest.hospitalTaskAttachments.map((entry) => entry.id === attachmentId && entry.uploadClaimToken === claimToken ? { ...entry, uploadClaimToken: undefined, uploadClaimExpiresAt: undefined } : entry) }, result: undefined }));
      };
      const detected = detectedMime(bytes); let scanStatus: HospitalTaskAttachment["scanStatus"];
      try { await storage.put(claimed.storageKey, bytes); scanStatus = await scanner.scan({ content: bytes, checksum: claimed.attachment.checksum, declaredMime: claimed.attachment.declaredMime, detectedMime: detected }); }
      catch { await cleanup().catch(() => undefined); throw new ApiError("STORAGE_UNAVAILABLE", "O armazenamento ou a varredura privada não está disponível.", 503, { retryable: true }); }
      if (scanStatus === "CLEAN" && detected !== claimed.attachment.declaredMime) scanStatus = "QUARANTINED";
      reportAttachmentScan(scanStatus, { attachmentId, taskId: claimed.attachment.taskId, declaredMime: claimed.attachment.declaredMime, detectedMime: detected ?? "application/octet-stream", sizeBytes: bytes.length });
      try {
        return await store.transaction((state) => {
          const current = requireActiveUser(state, actor); const attachment = findOrThrowScoped(state.hospitalTaskAttachments.find((entry) => entry.id === attachmentId)); requireTaskAttachmentAccess(state, current, attachment, "hospital_task.attachment.upload", true); requireUploadWindow(attachment);
          if (attachment.uploadStatus !== "INITIATED" || attachment.uploadClaimToken !== claimToken || !attachment.uploadClaimExpiresAt || Date.parse(attachment.uploadClaimExpiresAt) <= Date.now()) throw new ApiError("UPLOAD_CLAIM_LOST", "O envio perdeu sua autorização temporária.", 409);
          const updated: HospitalTaskAttachment = { ...attachment, storageKey: claimed.storageKey, scanStatus, detectedMime: detected ?? "application/octet-stream", uploadStatus: "UPLOADED", uploadClaimToken: undefined, uploadClaimExpiresAt: undefined, version: attachment.version + 1, updatedAt: now() };
          return { state: { ...state, hospitalTaskAttachments: state.hospitalTaskAttachments.map((entry) => entry.id === attachmentId ? updated : entry) }, result: { attachment: publicTaskAttachment(updated) } };
        });
      } catch (error) { await cleanup().catch(() => undefined); throw error; }
    }
  };
}
