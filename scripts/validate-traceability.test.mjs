import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { validateTraceability } from "./validate-traceability.mjs";

function fixture({ code = "export function feature() { return true; }", testFile = "import test from 'node:test'; import assert from 'node:assert/strict'; test('feature', () => assert.equal(1, 1));", command = "node tests/feature.test.mjs", evidence = "Evidence date: 2026-09-04\nCommand: node tests/feature.test.mjs\nResult: PASS\n", cells = {}, planningOnly = false } = {}) {
  const rootDir = mkdtempSync(path.join(os.tmpdir(), "cvg-traceability-"));
  mkdirSync(path.join(rootDir, "docs/prd"), { recursive: true });
  mkdirSync(path.join(rootDir, "docs"), { recursive: true });
  mkdirSync(path.join(rootDir, "src"), { recursive: true });
  mkdirSync(path.join(rootDir, "tests"), { recursive: true });
  mkdirSync(path.join(rootDir, "evidence"), { recursive: true });

  writeFileSync(path.join(rootDir, "src/feature.ts"), code);
  writeFileSync(path.join(rootDir, "tests/feature.test.mjs"), testFile);
  writeFileSync(path.join(rootDir, "evidence/run.txt"), evidence);
  writeFileSync(
    path.join(rootDir, "docs/prd/PRD.md"),
    [
      "# PRD",
      "",
      "| ID | Requirement | Priority |",
      "| --- | --- | --- |",
      "| FR-CORE-001 | Build the feature. | MUST |",
      "",
      "**AC-FR-CORE-001-01**",
      "The feature behaves correctly."
    ].join("\n")
  );
  const matrix = planningOnly
    ? [
      "| Problem | Requirement | Acceptance criterion | Specification | Build task | Test ID/strategy | Status |",
      "| --- | --- | --- | --- | --- | --- | --- |",
      "| P-001 | FR-CORE-001 | AC-FR-CORE-001-01 | SYSTEM_SPEC | BLD-001 | TEST-FR-CORE-001 | planned |"
    ]
    : [
      "| Problem | Requirement | Acceptance criterion | Code | Test | Command | Evidence | Status |",
      "| --- | --- | --- | --- | --- | --- | --- | --- |",
      `| P-001 | FR-CORE-001 | AC-FR-CORE-001-01 | ${cells.code ?? "[implementation](../src/feature.ts)"} | ${cells.test ?? "[test](../tests/feature.test.mjs)"} | ${cells.command ?? `\`${command}\``} | ${cells.evidence ?? "[run](../evidence/run.txt)"} | implemented |`
    ];
  writeFileSync(path.join(rootDir, "docs/TRACEABILITY_MATRIX.md"), ["# Traceability", "", "## 3. Matrix", "", ...matrix].join("\n"));
  return { rootDir, matrixPath: path.join(rootDir, "docs/TRACEABILITY_MATRIX.md"), prdPath: path.join(rootDir, "docs/prd/PRD.md") };
}

function withFixture(options, callback) {
  const paths = fixture(options);
  try {
    return callback(paths);
  } finally {
    rmSync(paths.rootDir, { recursive: true, force: true });
  }
}

test("accepts a row only when code, executable test, local command and dated result are linked", () => {
  withFixture({}, (paths) => {
    const result = validateTraceability(paths);
    assert.equal(result.ok, true, result.issues.map((issue) => `${issue.code}: ${issue.message}`).join("\n"));
    assert.deepEqual(result.issues, []);
  });
});

test("rejects IDs and statuses that masquerade as implementation or test evidence", () => {
  withFixture(
    {
      cells: {
        code: "FR-CORE-001",
        test: "TEST-FR-CORE-001",
        command: "planned",
        evidence: "pending"
      }
    },
    (paths) => {
      const result = validateTraceability(paths);
      assert.equal(result.ok, false);
      assert.deepEqual(
        result.issues.map((issue) => issue.code),
        ["CODE_REFERENCE_MISSING", "COMMAND_NOT_LOCAL_OR_MISSING", "EVIDENCE_REFERENCE_MISSING", "TEST_REFERENCE_MISSING"]
      );
    }
  );
});

test("rejects missing files and non-executable test files", () => {
  withFixture(
    {
      testFile: "// only a note",
      cells: {
        code: "[missing](../src/missing.ts)",
        test: "[not a test](../src/feature.ts)"
      }
    },
    (paths) => {
      const result = validateTraceability(paths);
      assert.equal(result.ok, false);
      assert.ok(result.issues.some((issue) => issue.code === "REFERENCE_NOT_FOUND"));
      assert.ok(result.issues.some((issue) => issue.code === "TEST_REFERENCE_NOT_EXECUTABLE"));
    }
  );
});

test("fails closed on a planning-only matrix with no executable evidence columns", () => {
  withFixture({ planningOnly: true }, (paths) => {
    const result = validateTraceability(paths);
    assert.equal(result.ok, false);
    assert.deepEqual(
      result.issues.filter((issue) => issue.code === "MATRIX_MISSING_COLUMN").map((issue) => issue.message),
      [
        "matrix must contain a separate `code` column; ID-only planning fields do not prove evidence.",
        "matrix must contain a separate `command` column; ID-only planning fields do not prove evidence.",
        "matrix must contain a separate `evidence` column; ID-only planning fields do not prove evidence.",
        "matrix must contain a separate `test` column; ID-only planning fields do not prove evidence."
      ]
    );
  });
});
