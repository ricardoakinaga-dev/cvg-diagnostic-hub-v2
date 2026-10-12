import type { Permission } from "./identity-permissions";
import type { HospitalTaskReaction } from "./hospital-tasks";
export interface HospitalTaskCommentRevision { version: number; body: string; mentionedUserIds: string[]; editedBy: string; editedAt: string }
export interface HospitalTaskComment {
  id: string; taskId: string; authorId: string; body: string; mentionedUserIds: string[];
  revisions: HospitalTaskCommentRevision[]; deletedAt?: string; deletedBy?: string; deleteReason?: string;
  reactions?: HospitalTaskReaction[];
  version: number; createdAt: string; updatedAt: string;
}
export interface HospitalTaskCommentView { comment: HospitalTaskComment; permissions: Permission[]; author: { id: string; displayName: string } }
export interface HospitalTaskCommentPage { items: HospitalTaskCommentView[]; total: number; limit: number; nextCursor?: string }
/** Separate from result attachments: no diagnostic version is fabricated for a task. */
export interface HospitalTaskAttachment {
  id: string; taskId: string; safeName: string; declaredMime: string; detectedMime?: string;
  sizeBytes: number; checksum: string; storageKey: string;
  scanStatus: "PENDING" | "CLEAN" | "QUARANTINED" | "FAILED";
  uploadStatus: "INITIATED" | "UPLOADED" | "FINALIZED";
  expiresAt: string; createdBy: string; createdAt: string; updatedAt: string; version: number;
  uploadClaimToken?: string; uploadClaimExpiresAt?: string;
}
export type HospitalTaskPublicAttachment = Omit<HospitalTaskAttachment, "storageKey" | "uploadClaimToken" | "uploadClaimExpiresAt">;
export interface HospitalTaskAttachmentSession { attachment: HospitalTaskPublicAttachment; uploadUrl: string; expiresAt: string }
