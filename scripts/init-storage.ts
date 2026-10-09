// Creates the attachments bucket and, with STORAGE_HARDEN=true (PROD-307, D-050), applies and verifies the hardening:
// versioning, default encryption at rest, no anonymous access and a lifecycle that only expires non-current versions.
// `--verify` only checks and exits 1 on any deviation (runbook and release checklist).
//
//   npm run storage:init                 # create (and harden when STORAGE_HARDEN=true)
//   npm run storage:init -- --verify     # verify only, never changes the bucket (except a probe object it removes)
import { CreateBucketCommand, HeadBucketCommand, S3Client } from "@aws-sdk/client-s3";
import { hardenBucket, objectUrl, verifyBucket, type BucketHardeningOptions } from "../src/server/storage/bucket-hardening";
import { loadFileSecrets } from "../src/server/security/file-secrets";
// PROD-302: secrets mounted as files (NAME_FILE) are read before anything touches process.env.
loadFileSecrets();

const endpoint = required(process.env.STORAGE_ENDPOINT, "STORAGE_ENDPOINT");
const bucket = required(process.env.STORAGE_BUCKET, "STORAGE_BUCKET");
const accessKeyId = required(process.env.STORAGE_ACCESS_KEY, "STORAGE_ACCESS_KEY");
const secretAccessKey = required(process.env.STORAGE_SECRET_KEY, "STORAGE_SECRET_KEY");
const forcePathStyle = process.env.STORAGE_FORCE_PATH_STYLE !== "false";
const harden = (process.env.STORAGE_HARDEN ?? "false").trim().toLowerCase() === "true";
const verifyOnly = process.argv.includes("--verify");
const client = new S3Client({ endpoint, region: process.env.STORAGE_REGION ?? "us-east-1", forcePathStyle, credentials: { accessKeyId, secretAccessKey } });

const options: BucketHardeningOptions = {
  bucket,
  noncurrentVersionDays: integer(process.env.STORAGE_NONCURRENT_VERSION_DAYS, 30)
};

const probe = {
  async anonymousGet(key: string): Promise<number> {
    const response = await fetch(objectUrl(endpoint, bucket, key, forcePathStyle), { method: "GET", redirect: "manual", signal: AbortSignal.timeout(10_000) });
    await response.arrayBuffer().catch(() => undefined);
    return response.status;
  }
};

async function main(): Promise<void> {
  if (verifyOnly) {
    const verification = await verifyBucket(client, options, probe);
    console.log(JSON.stringify({ event: verification.ok ? "storage.verified" : "storage.verification_failed", ...verification.report, problems: verification.problems }));
    if (!verification.ok) process.exitCode = 1;
    return;
  }
  if (!harden) {
    try {
      await client.send(new HeadBucketCommand({ Bucket: bucket }));
      console.log(`Bucket ${bucket} já existe.`);
      return;
    } catch {
      await client.send(new CreateBucketCommand({ Bucket: bucket }));
      console.log(`Bucket ${bucket} criado em endpoint S3-compatible.`);
    }
    return;
  }
  const { created } = await hardenBucket(client, options);
  const verification = await verifyBucket(client, options, probe);
  console.log(JSON.stringify({ event: verification.ok ? "storage.hardened" : "storage.verification_failed", created, ...verification.report, problems: verification.problems }));
  if (!verification.ok) process.exitCode = 1;
}

function required(value: string | undefined, name: string): string {
  if (!value?.trim()) throw new Error(`${name} é obrigatório para inicializar o storage.`);
  return value.trim();
}

function integer(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === "") return fallback;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : Number.NaN;
}

void main().catch((error: unknown) => { console.error(error instanceof Error ? error.message : "Falha ao inicializar storage."); process.exitCode = 1; });
