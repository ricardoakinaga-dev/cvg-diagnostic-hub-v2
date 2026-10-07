import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { buildCoverageReport, evaluateCoverageGate, readCoverageExceptions } from "./coverage-report.mjs";

test("coverage report aggregates executable layers and retains below-threshold files", () => {
  const report = buildCoverageReport({
    total: {},
    "/workspace/src/server/security/policy.ts": {
      lines: { total: 10, covered: 10, skipped: 0 },
      functions: { total: 2, covered: 2, skipped: 0 },
      branches: { total: 4, covered: 3, skipped: 0 }
    },
    "/workspace/packages/ui/src/index.tsx": {
      lines: { total: 10, covered: 5, skipped: 0 },
      functions: { total: 2, covered: 1, skipped: 0 },
      branches: { total: 2, covered: 2, skipped: 0 }
    }
  }, "/workspace");

  assert.equal(report.totals.lines.pct, 75);
  assert.equal(report.layers.security.lines.pct, 100);
  assert.equal(report.layers.ui.lines.pct, 50);
  assert.deepEqual(report.belowThresholdFiles, [
    { file: "packages/ui/src/index.tsx", lines: 50, functions: 50, branches: 100 },
    { file: "src/server/security/policy.ts", lines: 100, functions: 100, branches: 75 }
  ]);
});

test("coverage report preserves the official V8 aggregate percentage when available", () => {
  const report = buildCoverageReport({
    total: {
      lines: { total: 100, covered: 92, skipped: 0, pct: 92 },
      functions: { total: 100, covered: 94, skipped: 0, pct: 94 },
      branches: { total: 100, covered: 86, skipped: 0, pct: 86.02 }
    },
    "/workspace/src/server/security/policy.ts": {
      lines: { total: 100, covered: 92, skipped: 0 },
      functions: { total: 100, covered: 94, skipped: 0 },
      branches: { total: 100, covered: 86, skipped: 0 }
    }
  }, "/workspace");

  assert.equal(report.totals.branches.pct, 86.02);
});

test("coverage gate rejects uncovered and stale exception entries", () => {
  const report = {
    belowThresholdFiles: [
      { file: "src/server/security/policy.ts", lines: 100, functions: 100, branches: 75 },
      { file: "src/server/storage/file-store.ts", lines: 80, functions: 80, branches: 80 }
    ]
  };

  assert.deepEqual(evaluateCoverageGate(report, [{ file: "src/server/security/policy.ts", reason: "security fixture" }]), {
    passed: false,
    uncovered: ["src/server/storage/file-store.ts"],
    stale: []
  });
  assert.deepEqual(evaluateCoverageGate(report, [
    { file: "src/server/security/policy.ts", reason: "security fixture" },
    { file: "src/server/old.ts", reason: "removed source" }
  ]), {
    passed: false,
    uncovered: ["src/server/storage/file-store.ts"],
    stale: ["src/server/old.ts"]
  });
  assert.deepEqual(evaluateCoverageGate(report, [
    { file: "src/server/security/policy.ts", reason: "security fixture" },
    { file: "src/server/storage/file-store.ts", reason: "storage fixture" }
  ]), { passed: true, uncovered: [], stale: [] });
});

test("coverage exception registry rejects malformed and duplicate entries", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "cvg-coverage-report-"));
  t.after(() => rm(directory, { recursive: true, force: true }));

  const invalid = path.join(directory, "invalid.json");
  await writeFile(invalid, JSON.stringify({ schemaVersion: 2, entries: [] }));
  await assert.rejects(readCoverageExceptions(invalid), /Invalid coverage exception registry/);

  const duplicate = path.join(directory, "duplicate.json");
  await writeFile(duplicate, JSON.stringify({
    schemaVersion: 1,
    entries: [
      { file: "src/a.ts", reason: "first" },
      { file: "src/a.ts", reason: "second" }
    ]
  }));
  await assert.rejects(readCoverageExceptions(duplicate), /Duplicate coverage exception/);
});

test("coverage CLI exits non-zero when a below-threshold file lacks an exception", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "cvg-coverage-cli-"));
  t.after(() => rm(directory, { recursive: true, force: true }));

  const root = process.cwd();
  const summaryPath = path.join(directory, "summary.json");
  const exceptionsPath = path.join(directory, "exceptions.json");
  await writeFile(summaryPath, JSON.stringify({
    total: {},
    [path.join(root, "src/server/uncovered.ts")]: {
      lines: { total: 10, covered: 5, skipped: 0 },
      functions: { total: 10, covered: 5, skipped: 0 },
      branches: { total: 10, covered: 5, skipped: 0 }
    }
  }));
  await writeFile(exceptionsPath, JSON.stringify({ schemaVersion: 1, entries: [] }));

  const result = spawnSync(process.execPath, ["scripts/coverage-report.mjs", "--check"], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, COVERAGE_SUMMARY: summaryPath, COVERAGE_EXCEPTIONS: exceptionsPath }
  });

  assert.equal(result.status, 1);
  assert.match(result.stdout, /"status": "FAIL"/);
  assert.match(result.stderr, /Coverage files without a declared exception/);
});
