import type { StateStore } from "../src/server/domain/models";
import type { ArchivedAttachmentKey } from "../src/server/storage/attachments-reconcile";
import type { RestorableAttachmentBytes } from "./attachment-bytes";

/** Archived attachments remain part of the recovered clinical record until the archive rows themselves are purged. */
export async function archivedAttachmentReferences(store: StateStore): Promise<(ArchivedAttachmentKey & RestorableAttachmentBytes)[]> {
  const keys: (ArchivedAttachmentKey & RestorableAttachmentBytes)[] = [];
  const pageSize = 200;
  for (let offset = 0; ; offset += pageSize) {
    const entries = await store.readClinicalArchive({ limit: pageSize, offset });
    for (const entry of entries) {
      for (const row of await store.readArchivedRequest(entry.requestId) ?? []) {
        if (row.collection !== "attachments") continue;
        const storageKey = row.data.storageKey;
        if (typeof storageKey !== "string" || !storageKey) throw new Error("Anexo arquivado sem chave de objeto válida.");
        keys.push({ requestId: entry.requestId, storageKey, checksum: row.data.checksum, sizeBytes: row.data.sizeBytes,
          uploadStatus: row.data.uploadStatus, uploadClaimToken: row.data.uploadClaimToken });
      }
    }
    if (entries.length < pageSize) return keys;
  }
}

export async function archivedAttachmentKeys(store: StateStore): Promise<ArchivedAttachmentKey[]> {
  return (await archivedAttachmentReferences(store)).map(({ requestId, storageKey }) => ({ requestId, storageKey }));
}
