import assert from "node:assert/strict";
import { test } from "node:test";
import { buildCoverageReport } from "./coverage-report.mjs";

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
