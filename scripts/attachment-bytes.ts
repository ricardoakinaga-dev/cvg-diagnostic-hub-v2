import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import path from "node:path";

export interface RestorableAttachmentBytes {
  readonly storageKey: string;
  readonly checksum: unknown;
  readonly sizeBytes: unknown;
  readonly uploadStatus?: unknown;
  readonly uploadClaimToken?: unknown;
}

interface ByteVerificationFailure {
  readonly storageKey: string;
  readonly reason: "INVALID_OR_MISSING_METADATA" | "METADATA_CONFLICT" | "SIZE_MISMATCH" | "CHECKSUM_MISMATCH" | "UNREADABLE_OR_NOT_REGULAR";
}

/** Verify the immutable evidence against metadata in the recovered database BEFORE producing a copy list.
 * Keep this inventory private: object keys can identify clinical documents. No bytes or references are mutated. */
export async function verifySelectedAttachmentBytes(
  source: string, selectedObjectKeys: readonly string[], references: readonly RestorableAttachmentBytes[]
): Promise<{ ok: boolean; verifiedObjects: number; failures: readonly ByteVerificationFailure[] }> {
  const metadata = new Map<string, RestorableAttachmentBytes>();
  const conflicts = new Set<string>();
  for (const reference of references) {
    const keys = [reference.storageKey];
    if (reference.uploadStatus !== "FINALIZED" && typeof reference.uploadClaimToken === "string" && reference.uploadClaimToken) {
      keys.push(`${reference.storageKey}.claim-${reference.uploadClaimToken}`);
    }
    for (const key of keys) {
      const existing = metadata.get(key);
      if (existing && (existing.checksum !== reference.checksum || existing.sizeBytes !== reference.sizeBytes)) conflicts.add(key);
      metadata.set(key, reference);
    }
  }
  const sourcePath = await realpath(source);
  const failures: ByteVerificationFailure[] = [];
  let verifiedObjects = 0;
  for (const storageKey of selectedObjectKeys) {
    const reference = metadata.get(storageKey);
    if (conflicts.has(storageKey)) {
      failures.push({ storageKey, reason: "METADATA_CONFLICT" });
      continue;
    }
    if (!reference || typeof reference.checksum !== "string" || !/^[a-f0-9]{64}$/.test(reference.checksum) ||
      typeof reference.sizeBytes !== "number" || !Number.isSafeInteger(reference.sizeBytes) || reference.sizeBytes < 0) {
      failures.push({ storageKey, reason: "INVALID_OR_MISSING_METADATA" });
      continue;
    }
    try {
      if (/[\u0000-\u001f\u007f\\]/.test(storageKey) || storageKey.split("/").some(segment => !segment || segment === "." || segment === "..")) {
        throw new Error("Unsafe object key");
      }
      const file = path.resolve(sourcePath, storageKey);
      const resolvedFile = await realpath(file);
      if (!resolvedFile.startsWith(`${sourcePath}${path.sep}`)) throw new Error("Object escaped the evidence directory");
      const info = await lstat(file);
      if (!info.isFile() || info.isSymbolicLink()) throw new Error("Object is not a regular file");
      const digest = createHash("sha256");
      let sizeBytes = 0;
      const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        for await (const chunk of handle.createReadStream({ autoClose: false })) {
          sizeBytes += chunk.length;
          digest.update(chunk);
        }
      } finally { await handle.close(); }
      if (sizeBytes !== reference.sizeBytes) failures.push({ storageKey, reason: "SIZE_MISMATCH" });
      else if (digest.digest("hex") !== reference.checksum) failures.push({ storageKey, reason: "CHECKSUM_MISMATCH" });
      else verifiedObjects += 1;
    } catch {
      failures.push({ storageKey, reason: "UNREADABLE_OR_NOT_REGULAR" });
    }
  }
  return { ok: failures.length === 0, verifiedObjects, failures };
}
