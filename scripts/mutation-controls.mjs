import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { classifyMutation, inspectTestRun, prepareStage, runnerEnvironment } from "./mutation-controls-support.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const stage = await mkdtemp(path.join(os.tmpdir(), "cvg-mutation-controls-"));
const evidenceDirectory = await mkdtemp(path.join(os.tmpdir(), "cvg-mutation-evidence-"));
const vitest = path.join(stage, "node_modules", "vitest", "vitest.mjs");

const mutations = [
  {
    id: "MC-AUTH-001",
    category: "authorization",
    file: "src/server/security/authorization.ts",
    needle: " || !hasPermission(actor.role, permission)",
    replacement: "",
    tests: ["src/server/security/authorization.test.ts"]
  },
  {
    id: "MC-VERSION-001",
    category: "optimistic-version",
    file: "src/server/application/service-common.ts",
    needle: "if (actual !== expectedVersion) {",
    replacement: "if (false) {",
    tests: ["src/server/application/service.test.ts", "src/server/application/catalog.test.ts"]
  },
  {
    id: "MC-MIGRATION-001",
    category: "migration-integrity",
    file: "src/server/store/migrations.ts",
    needle: "if (expectedChecksum !== migration.checksum) {",
    replacement: "if (false) {",
    tests: ["src/server/store/migrations.test.ts"]
  },
  {
    id: "MC-UPLOAD-001",
    category: "upload-boundary",
    file: "src/server/application/service-common.ts",
    needle: "if (!ALLOWED_ATTACHMENT_MIME.has(mimeType)) throw new ApiError(\"VALIDATION_ERROR\", \"Tipo de arquivo não permitido.\", 400);",
    replacement: "if (false) throw new ApiError(\"VALIDATION_ERROR\", \"Tipo de arquivo não permitido.\", 400);",
    tests: ["src/server/application/attachments.test.ts"]
  },
  {
    id: "MC-OUTBOX-001",
    category: "outbox-lease",
    file: "src/server/operations/outbox.ts",
    needle: "if (!ownsUnexpiredLease) return { state, result: false };",
    replacement: "if (false) return { state, result: false };",
    tests: ["src/server/operations/outbox.test.ts"]
  },
  {
    id: "MC-REALTIME-001",
    category: "realtime-replay",
    file: "src/server/domain/outbox-read.ts",
    needle: "return messages.filter((message) => message.status === \"PENDING\" || message.status === \"PROCESSED\").slice(-limit);",
    replacement: "return messages.filter((message) => message.status === \"PENDING\" || message.status === \"PROCESSED\" || message.status === \"PROCESSING\").slice(-limit);",
    tests: ["src/server/store/memory-store.test.ts", "src/server/observability/realtime-stream.test.ts"]
  },
  {
    id: "MC-RECOVERY-001",
    category: "recovery-integrity",
    file: "src/server/operations/recovery-manifest.ts",
    needle: "if (actual.checksum !== expectedChecksum || actual.sizeBytes !== expectedSize) {",
    replacement: "if (false) {",
    tests: ["src/server/operations/recovery-manifest.test.ts"]
  }
];

function outputTail(value) {
  return String(value ?? "").trim().split("\n").slice(-12).join("\n");
}

async function recordArtifact(name, bytes) {
  const filename = path.join(evidenceDirectory, name);
  await writeFile(filename, bytes, { flag: "wx" });
  return { path: filename, bytes: Buffer.byteLength(bytes), sha256: createHash("sha256").update(bytes).digest("hex") };
}

async function runTests(mutation, phase) {
  const reportPath = path.join(evidenceDirectory, `${mutation.id}-${phase}.vitest.json`);
  const startedAt = Date.now();
  const result = spawnSync(process.execPath, [vitest, "run", ...mutation.tests, "--retry=0", "--reporter=dot", "--reporter=./scripts/mutation-controls-reporter.mjs", `--outputFile.json=${reportPath}`], {
      cwd: stage,
      env: runnerEnvironment(),
      encoding: "utf8",
      maxBuffer: 8 * 1024 * 1024,
      timeout: 180_000
    });
  const artifacts = {
    stdout: await recordArtifact(`${mutation.id}-${phase}.stdout.log`, result.stdout ?? ""),
    stderr: await recordArtifact(`${mutation.id}-${phase}.stderr.log`, result.stderr ?? "")
  };
  let report;
  try {
    const bytes = await readFile(reportPath);
    artifacts.vitest = { path: reportPath, bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
    report = JSON.parse(bytes.toString("utf8"));
  } catch { /* Missing/malformed reporter output cannot kill a mutant. */ }
  const execution = { exitCode: result.status, signal: result.signal ?? null, errorCode: result.error?.code ?? null, durationMs: Date.now() - startedAt };
  artifacts.execution = await recordArtifact(`${mutation.id}-${phase}.execution.json`, `${JSON.stringify(execution, null, 2)}\n`);
  return { ...execution, assessment: inspectTestRun(result, report, mutation.tests, stage), artifacts, outputTail: outputTail(`${result.stdout ?? ""}\n${result.stderr ?? ""}`) };
}

async function runMutation(mutation) {
  const target = path.join(stage, mutation.file);
  const original = await readFile(target, "utf8");
  const occurrences = original.split(mutation.needle).length - 1;
  if (occurrences !== 1) {
    return { id: mutation.id, category: mutation.category, detected: false, outcome: "MUTATION_SITE_INVALID", occurrences };
  }
  const baseline = await runTests(mutation, "baseline");
  if (!baseline.assessment.valid || baseline.assessment.failed !== 0) return { id: mutation.id, category: mutation.category, detected: false, outcome: "BASELINE_INVALID", tests: mutation.tests, baseline };
  let mutant;
  try {
    await writeFile(target, original.replace(mutation.needle, mutation.replacement), "utf8");
    mutant = await runTests(mutation, "mutant");
  } finally { await writeFile(target, original, "utf8"); }
  return { id: mutation.id, category: mutation.category, ...classifyMutation(baseline.assessment, mutant.assessment), tests: mutation.tests, baseline, mutant };
}

try {
  const inventory = await prepareStage(root, stage);
  const inventoryArtifact = await recordArtifact("stage-source-inventory.json", `${JSON.stringify(inventory, null, 2)}\n`);
  const results = [];
  for (const mutation of mutations) results.push(await runMutation(mutation));
  const undetected = results.filter((result) => !result.detected);
  const report = {
    schemaVersion: 2,
    status: undetected.length === 0 ? "PASS" : "FAIL",
    mutationCount: results.length,
    detectedCount: results.filter((result) => result.detected).length,
    evidenceDirectory,
    inventory: inventoryArtifact,
    results,
    limits: [
      "Only allowlisted, nonignored regular source/config/test inputs are staged; real env/data/secrets/builds/vendor files and source symlinks are excluded. Three root env examples are permitted.",
      "The sole created symlink exposes installed node_modules for module resolution. Runner environment excludes application credentials and database opt-ins; the working tree is not mutated.",
      "Detection requires a green baseline, the same complete test inventory and exit 1 with real failed assertions. Setup errors, timeouts, signals, spawn errors and zero-test runs fail the sentinel.",
      "This is local mutation evidence, not a substitute for independent review, target infrastructure or clinical acceptance."
    ]
  };
  await recordArtifact("mutation-report.json", `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report, null, 2));
  if (undetected.length > 0) process.exitCode = 1;
} catch (error) {
  const report = { schemaVersion: 2, status: "FAIL", evidenceDirectory, failure: error.message };
  await recordArtifact("mutation-runner-error.json", `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report, null, 2));
  process.exitCode = 1;
} finally {
  await rm(stage, { recursive: true, force: true });
}
