import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  configReferencesForNames,
  createDryRunRestorePlan,
  createRecoveryManifest,
  sha256Bytes,
  validateRecoveryManifest,
  verifyRecoveryArtifacts
} from "./recovery-manifest";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "cvg-recovery-manifest-"));
  temporaryDirectories.push(root);
  await mkdir(path.join(root, "objects"));
  await writeFile(path.join(root, "database.dump"), "synthetic pg custom dump\n");
  await writeFile(path.join(root, "objects", "attachment.bin"), Buffer.from([1, 2, 3, 4]));
  return { root, manifestPath: path.join(root, "manifest.json") };
}

describe("recovery manifest contract", () => {
  it("captures database, object metadata and configuration references without secret values", async () => {
    const { root, manifestPath } = await fixture();
    const manifest = await createRecoveryManifest({
      manifestId: "backup-2026-09-05T120000Z",
      createdAt: "2026-09-05T12:00:00.000Z",
      manifestPath,
      databaseArtifactPath: path.join(root, "database.dump"),
      objectProviderReference: "env:STORAGE_MODE",
      objectBucketReference: "secret:storage/bucket",
      objects: [{
        key: "attachments/result-1/a.bin",
        artifactPath: path.join(root, "objects", "attachment.bin"),
        contentType: "application/octet-stream",
        versionId: "version-1",
        metadata: { checksumAlgorithm: "sha256" }
      }],
      configReferences: configReferencesForNames(["DATABASE_URL", "STORAGE_BUCKET"])
    });

    expect(manifest.database).toMatchObject({ artifactPath: "database.dump", format: "pg_dump-custom", sizeBytes: 25 });
    expect(manifest.objects).toMatchObject({ status: "CAPTURED", bucketReference: "secret:storage/bucket" });
    expect(manifest.objects.items[0]).toMatchObject({ artifactPath: "objects/attachment.bin", sizeBytes: 4, contentType: "application/octet-stream" });
    expect(manifest.configReferences).toEqual([
      { name: "DATABASE_URL", reference: "env:DATABASE_URL", required: true, status: "REFERENCE_ONLY" },
      { name: "STORAGE_BUCKET", reference: "env:STORAGE_BUCKET", required: true, status: "REFERENCE_ONLY" }
    ]);
    expect(JSON.stringify(manifest)).not.toContain("pg custom dump");
    expect(manifest.safety).toEqual({ secretsIncluded: false, destructiveRestore: "EXPLICIT_OPT_IN", rpoStatus: "NOT_APPROVED", rtoStatus: "NOT_APPROVED" });
    expect(sha256Bytes(new TextEncoder().encode("abc"))).toHaveLength(64);
  });

  it("verifies checksums and sizes for a copied isolated artifact set", async () => {
    const { root, manifestPath } = await fixture();
    const restoredRoot = path.join(root, "restored");
    await mkdir(path.join(restoredRoot, "objects"), { recursive: true });
    await writeFile(path.join(restoredRoot, "database.dump"), "synthetic pg custom dump\n");
    await writeFile(path.join(restoredRoot, "objects", "attachment.bin"), Buffer.from([1, 2, 3, 4]));
    const manifest = await createRecoveryManifest({
      manifestId: "backup-copy",
      manifestPath,
      databaseArtifactPath: path.join(root, "database.dump"),
      objects: [{ key: "attachments/result-1/a.bin", artifactPath: path.join(root, "objects", "attachment.bin") }]
    });

    await expect(verifyRecoveryArtifacts(manifest, root, restoredRoot)).resolves.toEqual({ ok: true, status: "PASS", checked: 2, failures: [] });
    await expect(verifyRecoveryArtifacts(manifest, root, undefined, path.join(root, "wrong.dump"))).resolves.toMatchObject({ ok: false, status: "FAIL", failures: ["database:MANIFEST_ARTIFACT_MISMATCH"] });
    await writeFile(path.join(restoredRoot, "objects", "attachment.bin"), Buffer.from([9, 9, 9]));
    const result = await verifyRecoveryArtifacts(manifest, root, restoredRoot);
    expect(result).toMatchObject({ ok: false, status: "FAIL", checked: 2 });
    expect(result.failures).toContain("object:attachments/result-1/a.bin:CHECKSUM_OR_SIZE_MISMATCH");
  });

  it("produces a non-destructive isolated restore plan and refuses unsafe targets", async () => {
    const { root, manifestPath } = await fixture();
    const manifest = await createRecoveryManifest({
      manifestId: "backup-plan",
      manifestPath,
      databaseArtifactPath: path.join(root, "database.dump")
    });
    const plan = createDryRunRestorePlan(manifest, root, path.join(root, "empty-target"));
    expect(plan).toMatchObject({ status: "DRY_RUN", destructive: false, isolationRequired: true, targetRoot: path.join(root, "empty-target") });
    expect(plan.database.source).toBe(path.join(root, "database.dump"));
    expect(plan.objects).toEqual([]);
    await expect(Promise.resolve().then(() => createDryRunRestorePlan(manifest, root, root))).rejects.toThrow("target_must_be_isolated");
    await expect(Promise.resolve().then(() => createDryRunRestorePlan(manifest, root, path.parse(root).root))).rejects.toThrow("root_target_forbidden");
  });

  it("marks missing object inventory and unapproved recovery objectives explicitly", async () => {
    const { root, manifestPath } = await fixture();
    const manifest = await createRecoveryManifest({
      manifestId: "database-only",
      manifestPath,
      databaseArtifactPath: path.join(root, "database.dump")
    });
    expect(manifest.objects).toMatchObject({ status: "NOT_CAPTURED", items: [] });
    expect(manifest.safety.rpoStatus).toBe("NOT_APPROVED");
    expect(manifest.safety.rtoStatus).toBe("NOT_APPROVED");
    expect(() => validateRecoveryManifest({ ...manifest, safety: { ...manifest.safety, secretsIncluded: true } })).toThrow("secret_material");
  });

  it("fails closed on traversal, duplicate objects and raw credential material", async () => {
    const { root, manifestPath } = await fixture();
    await expect(createRecoveryManifest({
      manifestId: "outside",
      manifestPath,
      databaseArtifactPath: path.join(root, "..", "outside.dump")
    })).rejects.toThrow("artifact_outside_manifest_directory");

    const base = await createRecoveryManifest({ manifestId: "safe", manifestPath, databaseArtifactPath: path.join(root, "database.dump") });
    expect(() => validateRecoveryManifest({
      ...base,
      objects: {
        ...base.objects,
        status: "CAPTURED",
        items: [{ key: "safe/object", artifactPath: "objects/attachment.bin", checksum: "a".repeat(64), sizeBytes: 1 }, { key: "safe/object", artifactPath: "objects/attachment.bin", checksum: "a".repeat(64), sizeBytes: 1 }]
      }
    })).toThrow("duplicate_object");
    expect(() => validateRecoveryManifest({ ...base, configReferences: [{ name: "DATABASE_URL", reference: "env:DATABASE_URL?password=plaintext", required: true, status: "REFERENCE_ONLY" }] })).toThrow("config_reference");
  });
});
