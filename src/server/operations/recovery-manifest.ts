import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";

/**
 * A recovery manifest is an inventory and verification contract. It is not a
 * backup itself and it never contains credentials or key material. Keeping
 * this distinction explicit prevents a successful checksum check from being
 * mistaken for a completed recovery exercise.
 */
export const RECOVERY_MANIFEST_VERSION = 1 as const;
export const RECOVERY_CONFIG_REFERENCE_NAMES = [
  "DATABASE_URL",
  "STORAGE_ENDPOINT",
  "STORAGE_REGION",
  "STORAGE_BUCKET",
  "STORAGE_ACCESS_KEY",
  "STORAGE_SECRET_KEY"
] as const;

const SHA256 = /^[a-f0-9]{64}$/i;
const CONFIG_NAME = /^[A-Z][A-Z0-9_]{1,127}$/;
const SAFE_REFERENCE = /^(?:env|secret|vault|kms):[A-Za-z0-9._/@:+-]+$/;
const SECRET_MATERIAL = [
  /-----BEGIN [^-]*PRIVATE KEY-----/i,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/i,
  /\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?)\:\/\/[^\s/@]+:[^\s/@]+@/i,
  /\bAKIA[0-9A-Z]{16}\b/
];

export type RecoveryStatus = "CAPTURED" | "REFERENCE_ONLY" | "NOT_CAPTURED";

export interface ConfigReference {
  name: string;
  reference: string;
  required: boolean;
  status: "REFERENCE_ONLY" | "VERIFIED" | "MISSING";
}

export interface RecoveryObjectMetadata {
  key: string;
  artifactPath: string;
  sizeBytes: number;
  checksum: string;
  contentType?: string;
  versionId?: string;
  metadata?: Record<string, string>;
}

export interface RecoveryDatabaseArtifact {
  format: "pg_dump-custom";
  artifactPath: string;
  sizeBytes: number;
  checksum: string;
}

export interface RecoveryObjectInventory {
  providerReference: string;
  bucketReference: string;
  status: RecoveryStatus;
  items: RecoveryObjectMetadata[];
}

export interface RecoveryManifest {
  schemaVersion: typeof RECOVERY_MANIFEST_VERSION;
  manifestId: string;
  createdAt: string;
  database: RecoveryDatabaseArtifact;
  objects: RecoveryObjectInventory;
  configReferences: ConfigReference[];
  safety: {
    secretsIncluded: false;
    destructiveRestore: "EXPLICIT_OPT_IN";
    rpoStatus: "NOT_APPROVED";
    rtoStatus: "NOT_APPROVED";
  };
}

export interface RecoveryManifestInput {
  manifestId: string;
  createdAt?: string;
  manifestPath: string;
  databaseArtifactPath: string;
  objectProviderReference?: string;
  objectBucketReference?: string;
  objects?: Array<{
    key: string;
    artifactPath: string;
    contentType?: string;
    versionId?: string;
    metadata?: Record<string, string>;
  }>;
  configReferences?: ConfigReference[];
}

export interface RecoveryVerificationResult {
  ok: boolean;
  status: "PASS" | "BLOCKED" | "FAIL";
  checked: number;
  failures: string[];
}

export interface RestorePlan {
  status: "DRY_RUN";
  destructive: false;
  isolationRequired: true;
  targetRoot: string;
  database: { source: string; target: string; checksum: string };
  objects: Array<{ key: string; source: string; target: string; checksum: string }>;
  configReferences: ConfigReference[];
  limits: string[];
}

export function sha256Bytes(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export async function sha256File(filePath: string): Promise<{ checksum: string; sizeBytes: number }> {
  const [bytes, fileStats] = await Promise.all([readFile(filePath), stat(filePath)]);
  return { checksum: sha256Bytes(bytes), sizeBytes: fileStats.size };
}

export function configReferencesForNames(names: readonly string[] = RECOVERY_CONFIG_REFERENCE_NAMES): ConfigReference[] {
  return names.map((name) => {
    if (!CONFIG_NAME.test(name)) throw new Error(`INVALID_CONFIG_REFERENCE_NAME:${name}`);
    return { name, reference: `env:${name}`, required: true, status: "REFERENCE_ONLY" };
  });
}

export async function createRecoveryManifest(input: RecoveryManifestInput): Promise<RecoveryManifest> {
  const manifestDirectory = path.resolve(path.dirname(input.manifestPath));
  const databasePath = assertContainedArtifact(manifestDirectory, input.databaseArtifactPath);
  const database = await sha256File(databasePath);
  const suppliedObjects = input.objects ?? [];
  const objectItems: RecoveryObjectMetadata[] = [];
  for (const object of suppliedObjects) {
    const objectPath = assertContainedArtifact(manifestDirectory, object.artifactPath);
    const digest = await sha256File(objectPath);
    const key = validateObjectKey(object.key);
    objectItems.push({
      key,
      artifactPath: path.relative(manifestDirectory, objectPath).split(path.sep).join("/"),
      sizeBytes: digest.sizeBytes,
      checksum: digest.checksum,
      ...(object.contentType ? { contentType: object.contentType } : {}),
      ...(object.versionId ? { versionId: object.versionId } : {}),
      ...(object.metadata ? { metadata: validateMetadata(object.metadata) } : {})
    });
  }

  const configReferences = input.configReferences ?? configReferencesForNames();
  const providerReference = validateReference(input.objectProviderReference ?? "env:STORAGE_MODE");
  const bucketReference = validateReference(input.objectBucketReference ?? "env:STORAGE_BUCKET");
  const manifest: RecoveryManifest = {
    schemaVersion: RECOVERY_MANIFEST_VERSION,
    manifestId: validateManifestId(input.manifestId),
    createdAt: validateIsoDate(input.createdAt ?? new Date().toISOString()),
    database: {
      format: "pg_dump-custom",
      artifactPath: path.relative(manifestDirectory, databasePath).split(path.sep).join("/"),
      sizeBytes: database.sizeBytes,
      checksum: database.checksum
    },
    objects: {
      providerReference,
      bucketReference,
      status: objectItems.length > 0 ? "CAPTURED" : "NOT_CAPTURED",
      items: objectItems
    },
    configReferences: configReferences.map(validateConfigReference),
    safety: {
      secretsIncluded: false,
      destructiveRestore: "EXPLICIT_OPT_IN",
      rpoStatus: "NOT_APPROVED",
      rtoStatus: "NOT_APPROVED"
    }
  };
  validateRecoveryManifest(manifest);
  return manifest;
}

export function validateRecoveryManifest(value: unknown): asserts value is RecoveryManifest {
  if (!value || typeof value !== "object") throw new Error("RECOVERY_MANIFEST_INVALID:object_required");
  const manifest = value as Partial<RecoveryManifest>;
  if (manifest.schemaVersion !== RECOVERY_MANIFEST_VERSION) throw new Error("RECOVERY_MANIFEST_INVALID:schema_version");
  validateManifestId(manifest.manifestId);
  validateIsoDate(manifest.createdAt);
  if (!manifest.database || manifest.database.format !== "pg_dump-custom") throw new Error("RECOVERY_MANIFEST_INVALID:database");
  validateRelativeArtifact(manifest.database.artifactPath);
  validateDigestAndSize(manifest.database.checksum, manifest.database.sizeBytes, "database");
  if (!manifest.objects || typeof manifest.objects !== "object") throw new Error("RECOVERY_MANIFEST_INVALID:objects");
  validateReference(manifest.objects.providerReference);
  validateReference(manifest.objects.bucketReference);
  if (!Array.isArray(manifest.objects.items)) throw new Error("RECOVERY_MANIFEST_INVALID:object_items");
  if (manifest.objects.status === "CAPTURED" && manifest.objects.items.length === 0) throw new Error("RECOVERY_MANIFEST_INVALID:captured_objects_empty");
  if (manifest.objects.status === "NOT_CAPTURED" && manifest.objects.items.length > 0) throw new Error("RECOVERY_MANIFEST_INVALID:not_captured_objects_present");
  const keys = new Set<string>();
  for (const item of manifest.objects.items) {
    if (!item || typeof item !== "object") throw new Error("RECOVERY_MANIFEST_INVALID:object_item");
    const key = validateObjectKey(item.key);
    if (keys.has(key)) throw new Error(`RECOVERY_MANIFEST_INVALID:duplicate_object:${key}`);
    keys.add(key);
    validateRelativeArtifact(item.artifactPath);
    validateDigestAndSize(item.checksum, item.sizeBytes, `object:${key}`);
    if (item.metadata !== undefined) validateMetadata(item.metadata);
  }
  if (!Array.isArray(manifest.configReferences) || manifest.configReferences.length === 0) throw new Error("RECOVERY_MANIFEST_INVALID:config_references");
  for (const reference of manifest.configReferences) validateConfigReference(reference);
  if (manifest.safety?.secretsIncluded !== false) throw new Error("RECOVERY_MANIFEST_INVALID:secret_material");
  if (manifest.safety?.destructiveRestore !== "EXPLICIT_OPT_IN") throw new Error("RECOVERY_MANIFEST_INVALID:restore_guard");
  if (manifest.safety?.rpoStatus !== "NOT_APPROVED" || manifest.safety?.rtoStatus !== "NOT_APPROVED") throw new Error("RECOVERY_MANIFEST_INVALID:unapproved_target");
  assertNoSecretMaterial(manifest);
}

export async function verifyRecoveryArtifacts(
  manifest: RecoveryManifest,
  artifactRoot: string,
  restoredRoot?: string,
  expectedDatabaseArtifact?: string
): Promise<RecoveryVerificationResult> {
  validateRecoveryManifest(manifest);
  const failures: string[] = [];
  let checked = 0;
  const roots = restoredRoot ? [path.resolve(restoredRoot)] : [path.resolve(artifactRoot)];
  if (expectedDatabaseArtifact && path.resolve(expectedDatabaseArtifact) !== resolveContained(roots[0], manifest.database.artifactPath)) {
    return { ok: false, status: "FAIL", checked: 0, failures: ["database:MANIFEST_ARTIFACT_MISMATCH"] };
  }
  const pathsFor = (relative: string): string[] => roots.map((root) => resolveContained(root, relative));
  const verify = async (relative: string, expectedChecksum: string, expectedSize: number, label: string): Promise<void> => {
    for (const candidate of pathsFor(relative)) {
      checked += 1;
      try {
        const actual = await sha256File(candidate);
        if (actual.checksum !== expectedChecksum || actual.sizeBytes !== expectedSize) {
          failures.push(`${label}:CHECKSUM_OR_SIZE_MISMATCH`);
        }
      } catch {
        failures.push(`${label}:MISSING_ARTIFACT`);
      }
    }
  };
  await verify(manifest.database.artifactPath, manifest.database.checksum, manifest.database.sizeBytes, "database");
  for (const object of manifest.objects.items) await verify(object.artifactPath, object.checksum, object.sizeBytes, `object:${object.key}`);
  return { ok: failures.length === 0, status: failures.length === 0 ? "PASS" : "FAIL", checked, failures };
}

export function createDryRunRestorePlan(manifest: RecoveryManifest, artifactRoot: string, targetRoot: string): RestorePlan {
  validateRecoveryManifest(manifest);
  const sourceRoot = path.resolve(artifactRoot);
  const target = path.resolve(targetRoot);
  if (sourceRoot === target) throw new Error("RESTORE_PLAN_INVALID:target_must_be_isolated");
  if (target === path.parse(target).root) throw new Error("RESTORE_PLAN_INVALID:root_target_forbidden");
  return {
    status: "DRY_RUN",
    destructive: false,
    isolationRequired: true,
    targetRoot: target,
    database: {
      source: resolveContained(sourceRoot, manifest.database.artifactPath),
      target: resolveContained(target, manifest.database.artifactPath),
      checksum: manifest.database.checksum
    },
    objects: manifest.objects.items.map((object) => ({
      key: object.key,
      source: resolveContained(sourceRoot, object.artifactPath),
      target: resolveContained(target, object.artifactPath),
      checksum: object.checksum
    })),
    configReferences: manifest.configReferences,
    limits: [
      "Plan only: no pg_restore, object copy, key retrieval or application start is performed.",
      "The manifest does not set or claim an approved RPO/RTO.",
      "A successful checksum verification does not prove database semantics, application reads or clinical acceptance."
    ]
  };
}

function validateManifestId(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value)) throw new Error("RECOVERY_MANIFEST_INVALID:manifest_id");
  return value;
}

function validateIsoDate(value: unknown): string {
  if (typeof value !== "string" || Number.isNaN(Date.parse(value))) throw new Error("RECOVERY_MANIFEST_INVALID:created_at");
  return value;
}

function validateObjectKey(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 1024 || value.startsWith("/") || value.includes("\\") || value.split("/").some((part) => part === ".." || part === "." || part.length === 0)) {
    throw new Error("RECOVERY_MANIFEST_INVALID:object_key");
  }
  rejectSecretText(value, "object_key");
  return value;
}

function validateReference(value: unknown): string {
  if (typeof value !== "string" || !SAFE_REFERENCE.test(value)) throw new Error("RECOVERY_MANIFEST_INVALID:config_reference");
  rejectSecretText(value, "config_reference");
  return value;
}

function validateConfigReference(value: unknown): ConfigReference {
  if (!value || typeof value !== "object") throw new Error("RECOVERY_MANIFEST_INVALID:config_reference_entry");
  const reference = value as Partial<ConfigReference>;
  const name = reference.name;
  const referenceValue = reference.reference;
  const status = reference.status;
  const required = reference.required;
  if (typeof name !== "string" || !CONFIG_NAME.test(name)) throw new Error("RECOVERY_MANIFEST_INVALID:config_name");
  const safeReference = validateReference(referenceValue);
  if (typeof required !== "boolean" || !["REFERENCE_ONLY", "VERIFIED", "MISSING"].includes(status ?? "")) throw new Error("RECOVERY_MANIFEST_INVALID:config_reference_status");
  return { name, reference: safeReference, required, status: status as ConfigReference["status"] };
}

function validateMetadata(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("RECOVERY_MANIFEST_INVALID:object_metadata");
  const metadata: Record<string, string> = {};
  for (const [key, item] of Object.entries(value)) {
    if (!/^[A-Za-z0-9._-]{1,128}$/.test(key) || typeof item !== "string" || item.length > 4096) throw new Error("RECOVERY_MANIFEST_INVALID:object_metadata");
    rejectSecretText(item, `object_metadata:${key}`);
    metadata[key] = item;
  }
  return metadata;
}

function validateDigestAndSize(checksum: unknown, sizeBytes: unknown, label: string): void {
  if (typeof checksum !== "string" || !SHA256.test(checksum)) throw new Error(`RECOVERY_MANIFEST_INVALID:${label}_checksum`);
  if (typeof sizeBytes !== "number" || !Number.isSafeInteger(sizeBytes) || sizeBytes < 0) throw new Error(`RECOVERY_MANIFEST_INVALID:${label}_size`);
}

function validateRelativeArtifact(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || path.isAbsolute(value) || value.includes("\\") || value.split("/").some((part) => part === ".." || part === "." || part.length === 0)) throw new Error("RECOVERY_MANIFEST_INVALID:artifact_path");
  rejectSecretText(value, "artifact_path");
  return value;
}

function assertContainedArtifact(baseDirectory: string, candidate: string): string {
  const resolved = path.resolve(candidate);
  const base = path.resolve(baseDirectory);
  if (resolved === base || !resolved.startsWith(`${base}${path.sep}`)) throw new Error("RECOVERY_MANIFEST_INVALID:artifact_outside_manifest_directory");
  return resolved;
}

function resolveContained(root: string, relative: string): string {
  validateRelativeArtifact(relative);
  const resolved = path.resolve(root, relative);
  if (!resolved.startsWith(`${path.resolve(root)}${path.sep}`)) throw new Error("RECOVERY_MANIFEST_INVALID:artifact_escape");
  return resolved;
}

function rejectSecretText(value: string, label: string): void {
  for (const pattern of SECRET_MATERIAL) if (pattern.test(value)) throw new Error(`RECOVERY_MANIFEST_INVALID:secret_material:${label}`);
}

function assertNoSecretMaterial(value: unknown): void {
  if (typeof value === "string") {
    for (const pattern of SECRET_MATERIAL) if (pattern.test(value)) throw new Error("RECOVERY_MANIFEST_INVALID:secret_material");
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) assertNoSecretMaterial(item);
    return;
  }
  if (value && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      if (/^(?:value|secret|token|password|privateKey|secretAccessKey|credential)$/i.test(key)) {
        if (key !== "secretsIncluded") throw new Error(`RECOVERY_MANIFEST_INVALID:secret_field:${key}`);
      }
      assertNoSecretMaterial(item);
    }
  }
}
