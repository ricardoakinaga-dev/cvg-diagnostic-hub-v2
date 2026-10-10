/** Objects the bucket hardening writes and removes by itself (scripts/init-storage.ts); never attachments. */
export const BUCKET_PROBE_PREFIX = ".cvg-bucket-probe/";

/**
 * The fields of an attachment that the reconciliation reads. Declared here, not picked from the domain model: the
 * storage layer depends on nothing else (architecture fitness test); an `Attachment` satisfies it structurally.
 */
export interface ReconcilableAttachment {
  readonly id: string;
  readonly storageKey: string;
  readonly uploadStatus: "INITIATED" | "UPLOADED" | "FINALIZED";
  readonly uploadClaimToken?: string;
}

export interface ArchivedAttachmentKey {
  readonly requestId: string;
  readonly storageKey: string;
}

export interface AttachmentsReconciliation {
  readonly ok: boolean;
  readonly counts: {
    /** Active attachments in the aggregate, by upload status. */
    readonly active: number;
    readonly finalized: number;
    readonly pending: number;
    /** Attachments of archived requests (PROD-501) whose objects stay until the purge. */
    readonly archived: number;
    /** Objects in the bucket, probe objects excluded. */
    readonly objects: number;
    readonly expectedObjects: number;
  };
  /** Finalized or archived attachments whose object is missing: a restore lost clinical content. */
  readonly missingObjects: readonly { id: string; source: "active" | "archive" }[];
  /** Objects no attachment (active, pending or archived) accounts for: a restore brought back something the record no longer has. */
  readonly orphanObjects: number;
  /** Pending uploads whose object is absent are normal (claim expired or never uploaded) and are only counted. */
  readonly pendingWithoutObject: number;
}

/**
 * PROD-514 (D-057): a restore of the database and of the bucket is only accepted when both halves agree. Every
 * finalized attachment and every archived one must have its object; every object must belong to some attachment.
 * Pending uploads may or may not have an object (the claim key or the final key); neither case is an error.
 */
export function reconcileAttachments(
  active: readonly ReconcilableAttachment[],
  archived: readonly ArchivedAttachmentKey[],
  objectKeys: readonly string[]
): AttachmentsReconciliation {
  const objects = new Set(objectKeys.filter((key) => !key.startsWith(BUCKET_PROBE_PREFIX)));
  const accounted = new Set<string>();
  const missingObjects: { id: string; source: "active" | "archive" }[] = [];
  let finalized = 0;
  let pending = 0;
  let pendingWithoutObject = 0;
  for (const attachment of active) {
    const claimKey = attachment.uploadClaimToken ? `${attachment.storageKey}.claim-${attachment.uploadClaimToken}` : undefined;
    if (attachment.uploadStatus === "FINALIZED") {
      finalized += 1;
      accounted.add(attachment.storageKey);
      if (!objects.has(attachment.storageKey)) missingObjects.push({ id: attachment.id, source: "active" });
      continue;
    }
    pending += 1;
    accounted.add(attachment.storageKey);
    if (claimKey) accounted.add(claimKey);
    if (!objects.has(attachment.storageKey) && !(claimKey && objects.has(claimKey))) pendingWithoutObject += 1;
  }
  const archivedKeys = new Set<string>();
  for (const entry of archived) {
    archivedKeys.add(entry.storageKey);
    accounted.add(entry.storageKey);
    if (!objects.has(entry.storageKey)) missingObjects.push({ id: `${entry.requestId}:${entry.storageKey}`, source: "archive" });
  }
  let orphanObjects = 0;
  for (const key of objects) if (!accounted.has(key)) orphanObjects += 1;
  missingObjects.sort((left, right) => left.id.localeCompare(right.id));
  return {
    ok: missingObjects.length === 0 && orphanObjects === 0,
    counts: { active: active.length, finalized, pending, archived: archivedKeys.size, objects: objects.size, expectedObjects: finalized + archivedKeys.size },
    missingObjects,
    orphanObjects,
    pendingWithoutObject
  };
}
