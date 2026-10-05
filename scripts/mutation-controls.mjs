import { cp, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const stage = await mkdtemp(path.join(os.tmpdir(), "cvg-mutation-controls-"));
const vitest = path.join(stage, "node_modules", "vitest", "vitest.mjs");

const mutations = [
  {
    id: "MC-AUTH-001",
    category: "authorization",
    file: "src/server/security/authorization.ts",
    needle: "if (actor.active === false || !hasPermission(actor.role, permission)) {",
    replacement: "if (actor.active === false) {",
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

async function prepareStage() {
  await cp(root, stage, {
    recursive: true,
    filter(source) {
      const relative = path.relative(root, source);
      if (!relative) return true;
      const first = relative.split(path.sep)[0];
      return !new Set([".git", "node_modules", ".next", "coverage", ".orchestrate", ".agent", ".gauntlet", "audit-reports", ".data"]).has(first);
    }
  });
  await symlink(path.join(root, "node_modules"), path.join(stage, "node_modules"), "dir");
}

async function runMutation(mutation) {
  const target = path.join(stage, mutation.file);
  const original = await readFile(target, "utf8");
  const occurrences = original.split(mutation.needle).length - 1;
  if (occurrences !== 1) {
    throw new Error(`${mutation.id}: expected one mutation site, found ${occurrences}`);
  }
  await writeFile(target, original.replace(mutation.needle, mutation.replacement), "utf8");
  const startedAt = Date.now();
  let result;
  try {
    result = spawnSync(process.execPath, [vitest, "run", ...mutation.tests, "--reporter=dot"], {
      cwd: stage,
      env: { ...process.env, CI: "1" },
      encoding: "utf8",
      maxBuffer: 8 * 1024 * 1024,
      timeout: 180_000
    });
  } finally {
    await writeFile(target, original, "utf8");
  }
  const detected = result.status !== 0;
  return {
    id: mutation.id,
    category: mutation.category,
    detected,
    exitCode: result.status,
    signal: result.signal ?? null,
    durationMs: Date.now() - startedAt,
    tests: mutation.tests,
    outputTail: outputTail(`${result.stdout ?? ""}\n${result.stderr ?? ""}`)
  };
}

try {
  await prepareStage();
  const results = [];
  for (const mutation of mutations) results.push(await runMutation(mutation));
  const undetected = results.filter((result) => !result.detected);
  const report = {
    schemaVersion: 1,
    status: undetected.length === 0 ? "PASS" : "FAIL",
    mutationCount: results.length,
    detectedCount: results.filter((result) => result.detected).length,
    results,
    limits: [
      "Mutants run in an isolated temporary copy with the repository node_modules linked; the working tree is not mutated.",
      "This is local mutation evidence, not a substitute for independent review, target infrastructure or clinical acceptance."
    ]
  };
  console.log(JSON.stringify(report, null, 2));
  if (undetected.length > 0) process.exitCode = 1;
} finally {
  await rm(stage, { recursive: true, force: true });
}
