import "./load-file-secrets";
// PROD-514 (D-057): after a restore of the database AND of the attachments bucket (or at any time, as an audit),
// proves that both halves agree: every finalized or archived attachment has its object and every object belongs to
// an attachment. Prints one JSON line and exits 1 on any divergence.
//
//   npm run attachments:reconcile            # same environment as the worker (APP_DATA_MODE=postgres, DATABASE_URL, STORAGE_*)
//   npm run attachments:reconcile -- --json-only
import { ListObjectsV2Command, S3Client } from "@aws-sdk/client-s3";
import type { ArchivedCollection, StateStore } from "../src/server/domain/models";
import { reconcileAttachments, type ArchivedAttachmentKey } from "../src/server/storage/attachments-reconcile";
import { getRuntimeStoreAsync } from "../src/server/store/runtime";

const ARCHIVE_PAGE = 200;

interface BucketAccess { readonly client: S3Client; readonly bucket: string }

/** Read before the store opens, so a missing storage variable fails fast and without a database connection. */
function bucketAccess(): BucketAccess {
  const endpoint = required("STORAGE_ENDPOINT");
  const bucket = required("STORAGE_BUCKET");
  const client = new S3Client({
    endpoint, region: process.env.STORAGE_REGION ?? "us-east-1", forcePathStyle: process.env.STORAGE_FORCE_PATH_STYLE !== "false",
    credentials: { accessKeyId: required("STORAGE_ACCESS_KEY"), secretAccessKey: required("STORAGE_SECRET_KEY") }
  });
  return { client, bucket };
}

async function listObjectKeys({ client, bucket }: BucketAccess): Promise<string[]> {
  const keys: string[] = [];
  let token: string | undefined;
  do {
    const page = await client.send(new ListObjectsV2Command({ Bucket: bucket, ContinuationToken: token, MaxKeys: 1000 }));
    for (const object of page.Contents ?? []) if (object.Key) keys.push(object.Key);
    token = page.IsTruncated ? page.NextContinuationToken : undefined;
  } while (token);
  return keys;
}

/** Archived attachments stay in the bucket until the purge (PROD-501): read them request by request, in pages. */
async function archivedAttachmentKeys(store: StateStore): Promise<ArchivedAttachmentKey[]> {
  const keys: ArchivedAttachmentKey[] = [];
  const collection: ArchivedCollection = "attachments";
  for (let offset = 0; ; offset += ARCHIVE_PAGE) {
    const entries = await store.readClinicalArchive({ limit: ARCHIVE_PAGE, offset });
    for (const entry of entries) {
      const rows = await store.readArchivedRequest(entry.requestId);
      for (const row of rows ?? []) {
        if (row.collection !== collection) continue;
        const storageKey = row.data.storageKey;
        if (typeof storageKey === "string" && storageKey) keys.push({ requestId: entry.requestId, storageKey });
      }
    }
    if (entries.length < ARCHIVE_PAGE) return keys;
  }
}

async function main(): Promise<void> {
  const access = bucketAccess();
  const store = await getRuntimeStoreAsync();
  const state = await store.readState();
  const [archived, objectKeys] = await Promise.all([archivedAttachmentKeys(store), listObjectKeys(access)]);
  const report = reconcileAttachments(state.attachments, archived, objectKeys);
  // Attachment ids and counts only: no file name, no patient, no result content.
  console.log(JSON.stringify({ event: report.ok ? "attachments.reconciled" : "attachments.divergent", ...report, checkedAt: new Date().toISOString() }));
  if (!report.ok) process.exitCode = 1;
  await (store as { close?: () => Promise<void> }).close?.();
}

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} é obrigatório para reconciliar os anexos.`);
  return value;
}

main().catch((error: unknown) => {
  console.error(JSON.stringify({ event: "attachments.reconcile_error", message: error instanceof Error ? error.message : String(error) }));
  process.exit(2);
});
