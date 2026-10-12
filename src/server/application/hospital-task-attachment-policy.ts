import type { HospitalTaskAttachment, HospitalTaskPublicAttachment, Permission } from "@cvg/contracts";
import type { StoreState, User } from "../domain/models";
import { ApiError } from "../http/envelope";
import { findOrThrowScoped } from "./service-common";
import { requireHospitalTaskAccess } from "./hospital-task-policy";
import { requireOpenTask } from "./hospital-task-common";

export function publicTaskAttachment(attachment: HospitalTaskAttachment): HospitalTaskPublicAttachment {
  const { storageKey: _key, uploadClaimToken: _token, uploadClaimExpiresAt: _expires, ...result } = attachment; return result;
}
export function requireTaskAttachmentAccess(state: StoreState, actor: User, attachment: HospitalTaskAttachment, permission: Permission, owner = false): void {
  const task = findOrThrowScoped(state.hospitalTasks.find((entry) => entry.id === attachment.taskId)); requireHospitalTaskAccess(state, actor, "hospital_task.view", task); requireHospitalTaskAccess(state, actor, permission, task);
  if (owner) { requireOpenTask(task); if (attachment.createdBy !== actor.id) throw new ApiError("SCOPE_DENIED", "Você não tem acesso a este envio.", 404); }
}
export function requireUploadWindow(attachment: HospitalTaskAttachment): void {
  if (Date.parse(attachment.expiresAt) <= Date.now()) throw new ApiError("UPLOAD_EXPIRED", "A sessão de upload expirou.", 409);
}
export function requireDownloadableTaskAttachment(state: StoreState, actor: User, attachment: HospitalTaskAttachment): void {
  requireTaskAttachmentAccess(state, actor, attachment, "hospital_task.attachment.view"); requireTaskAttachmentAccess(state, actor, attachment, "hospital_task.attachment.download");
  if (attachment.scanStatus !== "CLEAN" || attachment.uploadStatus !== "FINALIZED") throw new ApiError("NOT_FOUND", "Anexo não disponível.", 404);
}
