import { randomUUID } from "node:crypto";
import {
  CreateBucketCommand,
  DeleteObjectCommand,
  GetBucketEncryptionCommand,
  GetBucketLifecycleConfigurationCommand,
  GetBucketPolicyCommand,
  GetBucketVersioningCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  PutBucketEncryptionCommand,
  PutBucketLifecycleConfigurationCommand,
  PutBucketVersioningCommand,
  PutObjectCommand
} from "@aws-sdk/client-s3";
import type { LifecycleRule } from "@aws-sdk/client-s3";

/**
 * Hardening of the attachments bucket (PROD-307, D-050): versioning, default encryption at rest, no public access and a
 * lifecycle that only expires NON-current versions (and the delete markers left behind). Current objects are never
 * expired or transitioned by the bucket: an attachment stays readable until the clinical purge (PROD-501) removes it
 * after the legal retention period, so any age-based rule on current objects is a defect, not a policy. The app writes
 * every object with a single PUT (no multipart), and MinIO drops stale multipart uploads by itself, so no abort rule.
 */
export interface BucketHardeningOptions {
  bucket: string;
  /** Days a non-current version (left behind by a delete or an overwrite) is kept before the bucket drops it. */
  noncurrentVersionDays: number;
}

/** The subset of S3Client the hardening needs; tests pass a fake. */
export interface BucketCommandClient {
  send(command: unknown): Promise<unknown>;
}

export interface BucketProbe {
  /** Performs an UNAUTHENTICATED GET of the key and returns the HTTP status (a private bucket answers 403). */
  anonymousGet(key: string): Promise<number>;
}

export interface BucketReport {
  bucket: string;
  versioning: string;
  encryption: string;
  lifecycle: { noncurrentVersionDays?: number; ruleCount: number };
  policy: "none" | "private" | "public";
  anonymousGetStatus?: number;
  probeObjectEncryption?: string;
}

export interface BucketVerification {
  ok: boolean;
  report: BucketReport;
  problems: string[];
}

export const NONCURRENT_RULE_ID = "cvg-noncurrent-versions";
const PROBE_PREFIX = ".cvg-bucket-probe/";

export function lifecycleRules(options: BucketHardeningOptions): LifecycleRule[] {
  return [
    {
      ID: NONCURRENT_RULE_ID,
      Status: "Enabled",
      Filter: { Prefix: "" },
      NoncurrentVersionExpiration: { NoncurrentDays: options.noncurrentVersionDays },
      Expiration: { ExpiredObjectDeleteMarker: true }
    }
  ];
}

export function validateHardeningOptions(options: BucketHardeningOptions): void {
  if (!options.bucket.trim()) throw new Error("STORAGE_BUCKET é obrigatório.");
  const value = options.noncurrentVersionDays;
  if (!Number.isSafeInteger(value) || value < 1 || value > 3650) throw new Error("STORAGE_NONCURRENT_VERSION_DAYS deve ser um inteiro entre 1 e 3650 dias.");
}

/** Creates the bucket when missing and applies versioning, default encryption and the lifecycle. Idempotent. */
export async function hardenBucket(client: BucketCommandClient, options: BucketHardeningOptions): Promise<{ created: boolean }> {
  validateHardeningOptions(options);
  let created = false;
  try {
    await client.send(new HeadBucketCommand({ Bucket: options.bucket }));
  } catch {
    await client.send(new CreateBucketCommand({ Bucket: options.bucket }));
    created = true;
  }
  await client.send(new PutBucketVersioningCommand({ Bucket: options.bucket, VersioningConfiguration: { Status: "Enabled" } }));
  await client.send(new PutBucketEncryptionCommand({
    Bucket: options.bucket,
    ServerSideEncryptionConfiguration: { Rules: [{ ApplyServerSideEncryptionByDefault: { SSEAlgorithm: "AES256" } }] }
  }));
  await client.send(new PutBucketLifecycleConfigurationCommand({ Bucket: options.bucket, LifecycleConfiguration: { Rules: lifecycleRules(options) } }));
  return { created };
}

/** Reads the bucket back and lists every deviation from the hardening contract. Never changes the bucket except for a probe object it removes. */
export async function verifyBucket(client: BucketCommandClient, options: BucketHardeningOptions, probe?: BucketProbe): Promise<BucketVerification> {
  validateHardeningOptions(options);
  const problems: string[] = [];
  const report: BucketReport = { bucket: options.bucket, versioning: "unknown", encryption: "none", lifecycle: { ruleCount: 0 }, policy: "none" };

  try {
    await client.send(new HeadBucketCommand({ Bucket: options.bucket }));
  } catch {
    return { ok: false, report, problems: ["bucket não existe ou não está acessível"] };
  }

  const versioning = await client.send(new GetBucketVersioningCommand({ Bucket: options.bucket })) as { Status?: string };
  report.versioning = versioning.Status ?? "Disabled";
  if (report.versioning !== "Enabled") problems.push(`versionamento ${report.versioning}; esperado Enabled`);

  try {
    const encryption = await client.send(new GetBucketEncryptionCommand({ Bucket: options.bucket })) as { ServerSideEncryptionConfiguration?: { Rules?: Array<{ ApplyServerSideEncryptionByDefault?: { SSEAlgorithm?: string } }> } };
    report.encryption = encryption.ServerSideEncryptionConfiguration?.Rules?.[0]?.ApplyServerSideEncryptionByDefault?.SSEAlgorithm ?? "none";
  } catch {
    report.encryption = "none";
  }
  if (report.encryption === "none") problems.push("sem criptografia padrão no bucket (SSE)");

  let rules: LifecycleRule[] = [];
  try {
    const lifecycle = await client.send(new GetBucketLifecycleConfigurationCommand({ Bucket: options.bucket })) as { Rules?: LifecycleRule[] };
    rules = lifecycle.Rules ?? [];
  } catch {
    rules = [];
  }
  report.lifecycle.ruleCount = rules.length;
  for (const rule of rules) {
    if (rule.Status !== "Enabled") continue;
    const label = rule.ID ?? "(sem id)";
    if (rule.Expiration?.Days !== undefined || rule.Expiration?.Date !== undefined) {
      problems.push(`regra ${label} expira objetos correntes por idade; o anexo só sai no expurgo do PROD-501 (D-050)`);
    }
    if ((rule.Transitions?.length ?? 0) > 0 || (rule.NoncurrentVersionTransitions?.length ?? 0) > 0) {
      problems.push(`regra ${label} faz transição de classe de armazenamento; não prevista (D-050)`);
    }
    if (rule.NoncurrentVersionExpiration?.NoncurrentDays !== undefined) report.lifecycle.noncurrentVersionDays = rule.NoncurrentVersionExpiration.NoncurrentDays;
  }
  if (report.lifecycle.noncurrentVersionDays === undefined) problems.push("sem regra de expiração de versões não correntes");
  else if (report.lifecycle.noncurrentVersionDays !== options.noncurrentVersionDays) problems.push(`versões não correntes expiram em ${report.lifecycle.noncurrentVersionDays} dias; configurado ${options.noncurrentVersionDays}`);

  try {
    const policy = await client.send(new GetBucketPolicyCommand({ Bucket: options.bucket })) as { Policy?: string };
    report.policy = policyAllowsAnonymous(policy.Policy) ? "public" : "private";
  } catch {
    report.policy = "none";
  }
  if (report.policy === "public") problems.push("a policy do bucket concede acesso anônimo");

  const probeKey = `${PROBE_PREFIX}${randomUUID()}`;
  try {
    await client.send(new PutObjectCommand({ Bucket: options.bucket, Key: probeKey, Body: new Uint8Array([0]) }));
    const head = await client.send(new HeadObjectCommand({ Bucket: options.bucket, Key: probeKey })) as { ServerSideEncryption?: string };
    report.probeObjectEncryption = head.ServerSideEncryption ?? "none";
    if (report.probeObjectEncryption === "none") problems.push("objeto gravado sem criptografia em repouso (x-amz-server-side-encryption ausente)");
    if (probe) {
      report.anonymousGetStatus = await probe.anonymousGet(probeKey);
      if (report.anonymousGetStatus !== 403 && report.anonymousGetStatus !== 401) problems.push(`leitura anônima respondeu ${report.anonymousGetStatus}; esperado 403`);
    }
  } catch (error) {
    problems.push(`não foi possível gravar/ler o objeto de prova: ${error instanceof Error ? error.message : "erro"}`);
  } finally {
    await client.send(new DeleteObjectCommand({ Bucket: options.bucket, Key: probeKey })).catch(() => undefined);
  }

  return { ok: problems.length === 0, report, problems };
}

/** True when any Allow statement names the anonymous principal. */
export function policyAllowsAnonymous(policy: string | undefined): boolean {
  if (!policy) return false;
  let parsed: { Statement?: unknown };
  try {
    parsed = JSON.parse(policy) as { Statement?: unknown };
  } catch {
    return true;
  }
  const statements = Array.isArray(parsed.Statement) ? parsed.Statement : [parsed.Statement];
  return statements.some((statement) => {
    if (!statement || typeof statement !== "object") return false;
    const { Effect, Principal } = statement as { Effect?: string; Principal?: unknown };
    if (Effect !== "Allow") return false;
    if (Principal === "*") return true;
    if (Principal && typeof Principal === "object") {
      return Object.values(Principal as Record<string, unknown>).some((value) => value === "*" || (Array.isArray(value) && value.includes("*")));
    }
    return false;
  });
}

/** Path-style or virtual-host URL of an object, for the anonymous probe. */
export function objectUrl(endpoint: string, bucket: string, key: string, forcePathStyle: boolean): string {
  const base = new URL(endpoint);
  if (forcePathStyle) return new URL(`${base.pathname.replace(/\/$/, "")}/${bucket}/${key}`, base).toString();
  base.hostname = `${bucket}.${base.hostname}`;
  return new URL(`/${key}`, base).toString();
}
