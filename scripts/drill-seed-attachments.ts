import "./load-file-secrets";
// Used ONLY by scripts/full-restore-drill.sh on a disposable Compose project: writes DRILL_ATTACHMENT_COUNT finalized
// attachments through the same store and file store the application uses (one aggregate write, one object each), so the
// restore rehearsal has real rows to reconcile against real objects. Prints one JSON line with the last write time.
import { createHash, randomBytes } from "node:crypto";
import type { Attachment } from "../src/server/domain/models";
import { getRuntimeFileStore, getRuntimeStoreAsync } from "../src/server/store/runtime";

const count = Number.parseInt(process.env.DRILL_ATTACHMENT_COUNT ?? "50", 10);
const sizeKb = Number.parseInt(process.env.DRILL_ATTACHMENT_KB ?? "64", 10);
if (!Number.isSafeInteger(count) || count < 1 || count > 10_000 || !Number.isSafeInteger(sizeKb) || sizeKb < 1 || sizeKb > 10_240) {
  throw new Error("DRILL_ATTACHMENT_COUNT (1-10000) e DRILL_ATTACHMENT_KB (1-10240) inválidos.");
}

async function main(): Promise<void> {
  const store = await getRuntimeStoreAsync();
  const files = getRuntimeFileStore();
  const batch = process.env.DRILL_BATCH ?? new Date().toISOString().replaceAll(/[^0-9]/g, "").slice(0, 14);
  const attachments: Attachment[] = [];
  for (let index = 1; index <= count; index += 1) {
    const content = randomBytes(sizeKb * 1024);
    const id = `attachment-drill-${batch}-${index}`;
    const storageKey = `attachments/drill-${batch}/${index}.bin`;
    await files.put(storageKey, content);
    attachments.push({
      id, resultVersionId: `result-version-drill-${batch}`, safeName: `drill-${index}.bin`, storageKey, detectedMime: "application/octet-stream",
      sizeBytes: content.byteLength, checksum: createHash("sha256").update(content).digest("hex"), scanStatus: "CLEAN", uploadStatus: "FINALIZED",
      createdBy: "drill", createdAt: new Date().toISOString()
    });
  }
  await store.transaction((state) => ({ state: { ...state, attachments: [...state.attachments, ...attachments] }, result: undefined }));
  const lastWriteAt = new Date().toISOString();
  console.log(JSON.stringify({ event: "drill.attachments_seeded", batch, count, bytes: count * sizeKb * 1024, lastWriteAt }));
  await (store as { close?: () => Promise<void> }).close?.();
}

main().catch((error: unknown) => {
  console.error(JSON.stringify({ event: "drill.seed_error", message: error instanceof Error ? error.message : String(error) }));
  process.exit(2);
});
