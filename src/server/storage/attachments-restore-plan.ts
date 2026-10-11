import { BUCKET_PROBE_PREFIX, reconcileAttachments, type ArchivedAttachmentKey, type ReconcilableAttachment } from "./attachments-reconcile";

export interface AttachmentRestorePlan {
  readonly ok: boolean;
  readonly selectedObjectKeys: readonly string[];
  /** Preserve these in the downloaded evidence and off-site copy; do not put them in the live recovered bucket. */
  readonly excludedObjectKeys: readonly string[];
  readonly missingObjects: readonly { id: string; source: "active" | "archive" }[];
}

function safeObjectKey(key: string): boolean {
  return key.length > 0 && !/[\u0000-\u001f\u007f\\]/.test(key) &&
    key.split("/").every(segment => segment !== "" && segment !== "." && segment !== "..");
}

/** Select the bucket for the DATABASE'S recovered instant, from a write-once off-site history. A later deletion or
 * purge removes a reference, not the evidence: the old bytes stay off-site and are excluded from the live restore.
 * Before the deletion the reference still exists and those same bytes MUST be present. Missing clinical bytes fail
 * closed. Pending uploads remain optional. Keys are suitable for rclone --files-from-raw without path traversal. */
export function planAttachmentRestore(
  active: readonly ReconcilableAttachment[], archived: readonly ArchivedAttachmentKey[], availableObjectKeys: readonly string[]
): AttachmentRestorePlan {
  const referenced = new Set<string>();
  for (const attachment of active) {
    referenced.add(attachment.storageKey);
    if (attachment.uploadStatus !== "FINALIZED" && attachment.uploadClaimToken) {
      referenced.add(`${attachment.storageKey}.claim-${attachment.uploadClaimToken}`);
    }
  }
  for (const attachment of archived) referenced.add(attachment.storageKey);
  if ([...referenced, ...availableObjectKeys].some(key => !safeObjectKey(key))) {
    throw new Error("Chave de objeto insegura para restauração seletiva.");
  }
  const objects = [...new Set(availableObjectKeys.filter(key => !key.startsWith(BUCKET_PROBE_PREFIX)))].sort();
  const selectedObjectKeys = objects.filter(key => referenced.has(key));
  const excludedObjectKeys = objects.filter(key => !referenced.has(key));
  const reconciliation = reconcileAttachments(active, archived, selectedObjectKeys);
  return { ok: reconciliation.ok, selectedObjectKeys, excludedObjectKeys, missingObjects: reconciliation.missingObjects };
}
