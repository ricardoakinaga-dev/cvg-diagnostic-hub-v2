import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  configReferencesForNames,
  createDryRunRestorePlan,
  createRecoveryManifest,
  type RecoveryManifest,
  validateRecoveryManifest,
  verifyRecoveryArtifacts
} from "../src/server/operations/recovery-manifest";

type ObjectInput = {
  key: string;
  artifactPath: string;
  contentType?: string;
  versionId?: string;
  metadata?: Record<string, string>;
};

const usage = "Uso: tsx scripts/recovery-manifest.ts <create|verify|plan> ...";

async function main(args: string[]): Promise<void> {
  const [command, ...rest] = args;
  if (!command) throw new Error(usage);
  if (command === "create") {
    const manifestPath = requiredOption(rest, "--manifest");
    const databaseArtifactPath = requiredOption(rest, "--database-artifact");
    const objectManifestPath = optionalOption(rest, "--object-manifest");
    const configNames = optionalOption(rest, "--config-names")?.split(",").map((name) => name.trim()).filter(Boolean);
    const objects = objectManifestPath ? await readObjectManifest(objectManifestPath) : undefined;
    const manifest = await createRecoveryManifest({
      manifestId: optionalOption(rest, "--id") ?? path.basename(manifestPath).replace(/\.manifest\.json$/i, "").replace(/[^A-Za-z0-9._-]/g, "-"),
      createdAt: optionalOption(rest, "--created-at"),
      manifestPath,
      databaseArtifactPath,
      objectProviderReference: optionalOption(rest, "--provider-ref"),
      objectBucketReference: optionalOption(rest, "--bucket-ref"),
      objects,
      configReferences: configNames ? configReferencesForNames(configNames) : undefined
    });
    await writeJson(manifestPath, manifest);
    console.log(JSON.stringify({ status: "PASS", command, manifest: manifestPath, objectStatus: manifest.objects.status }, null, 2));
    return;
  }
  const manifestPath = requiredOption(rest, "--manifest");
  const manifest = await readManifest(manifestPath);
  if (command === "verify") {
    const artifactRoot = requiredOption(rest, "--artifact-root");
    const restoredRoot = optionalOption(rest, "--restored-root");
    const expectedDatabaseArtifact = optionalOption(rest, "--database-artifact");
    const result = await verifyRecoveryArtifacts(manifest, artifactRoot, restoredRoot, expectedDatabaseArtifact);
    console.log(JSON.stringify({ ...result, command, manifest: manifestPath }, null, 2));
    if (!result.ok) throw new Error("RECOVERY_VERIFICATION_FAILED");
    return;
  }
  if (command === "plan") {
    const artifactRoot = requiredOption(rest, "--artifact-root");
    const targetRoot = requiredOption(rest, "--target-root");
    console.log(JSON.stringify(createDryRunRestorePlan(manifest, artifactRoot, targetRoot), null, 2));
    return;
  }
  throw new Error(`${usage}: comando desconhecido ${command}`);
}

async function readManifest(filePath: string): Promise<RecoveryManifest> {
  const parsed: unknown = JSON.parse(await readFile(filePath, "utf8"));
  validateRecoveryManifest(parsed);
  return parsed;
}

async function readObjectManifest(filePath: string): Promise<ObjectInput[]> {
  const parsed: unknown = JSON.parse(await readFile(filePath, "utf8"));
  const items = Array.isArray(parsed) ? parsed : parsed && typeof parsed === "object" && "objects" in parsed ? (parsed as { objects?: unknown }).objects : undefined;
  if (!Array.isArray(items)) throw new Error("OBJECT_MANIFEST_INVALID:objects_array_required");
  return items as ObjectInput[];
}

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx" });
}

function requiredOption(args: string[], name: string): string {
  const value = optionalOption(args, name);
  if (!value) throw new Error(`OPTION_REQUIRED:${name}`);
  return value;
}

function optionalOption(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index < 0) return undefined;
  const value = args[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`OPTION_VALUE_REQUIRED:${name}`);
  return value;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
  main(process.argv.slice(2)).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
