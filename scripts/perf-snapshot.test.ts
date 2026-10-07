import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createDemoState } from "../src/server/store/fixtures";
import {
  buildAuditHeavyState,
  evaluatePerfBaseline,
  measureSnapshotScale,
  normalizeSnapshotFixture,
  PERF_BASELINE_PATH,
  readPerfBaseline,
  runSnapshotScaleBenchmark,
  SNAPSHOT_BENCHMARK_VERSION,
  type PerfBaseline,
  type SnapshotScaleReport
} from "./perf-snapshot";

function baselineFixture() {
  return {
    schemaVersion: 1,
    benchmark: SNAPSHOT_BENCHMARK_VERSION,
    recordedOn: "2026-10-03",
    recordedOnNode: process.version,
    policy: "Bytes only; timings informational.",
    regressionToleranceRatio: 0,
    samples: [1_000, 10_000, 100_000].map((auditEvents) => ({
      auditEvents,
      recorded: { bytes: 400, stringifyMs: 4, parseMs: 4, doubleCloneMs: 4 },
      max: { bytes: 1_000, stringifyMs: 10, parseMs: 10, doubleCloneMs: 10 }
    }))
  };
}

function reportFixture(baseline: PerfBaseline = baselineFixture()): SnapshotScaleReport {
  return {
    benchmark: "PROD-110 JSONB snapshot scale baseline",
    version: SNAPSHOT_BENCHMARK_VERSION,
    result: "MEASURED",
    samples: baseline.samples.map((sample) => ({ auditEvents: sample.auditEvents, ...sample.recorded })),
    limitations: []
  };
}

test("builds a reproducible audit-heavy state without changing the domain shape", () => {
  const state = buildAuditHeavyState(12);
  assert.equal(state.auditEvents.length, 12);
  assert.ok(state.users.length > 0);
  assert.equal(state.auditEvents[0]?.eventType, "ScaleProbe");
  assert.equal(state.auditEvents[0]?.occurredAt, "2025-10-01T00:00:00.000Z");
  assert.equal(state.auditEvents[11]?.occurredAt, "2025-10-01T00:00:11.000Z");
  assert.equal(JSON.stringify(buildAuditHeavyState(12)), JSON.stringify(state));
});

test("normalizes random password values and fixture timestamps without mutating the fixture", () => {
  const state = createDemoState("snapshot-scale-password");
  const varied = structuredClone(state);
  varied.users.forEach((user, index) => {
    user.passwordHash = "different-random-salt-" + index + ":" + "a".repeat(64 + index);
    user.createdAt = "2040-01-01T00:00:00.000Z";
  });
  varied.encounters.forEach((encounter) => { encounter.openedAt = "2041-01-01T00:00:00.000Z"; });
  varied.admissions.forEach((admission) => { admission.admittedAt = "2042-01-01T00:00:00.000Z"; });
  const before = structuredClone(varied);
  assert.equal(JSON.stringify(normalizeSnapshotFixture(varied)), JSON.stringify(normalizeSnapshotFixture(state)));
  assert.deepEqual(varied, before);
  assert.equal(Buffer.byteLength(JSON.stringify(normalizeSnapshotFixture(state))), Buffer.byteLength(JSON.stringify(state)));
  assert.deepEqual(Object.keys(normalizeSnapshotFixture(state)), Object.keys(state));
});

test("measures serialization, parsing and two-clone cost with stable UTF-8 bytes", () => {
  const sample = measureSnapshotScale(100);
  assert.equal(sample.auditEvents, 100);
  assert.equal(sample.bytes, Buffer.byteLength(JSON.stringify(buildAuditHeavyState(100)), "utf8"));
  assert.equal(measureSnapshotScale(100).bytes, sample.bytes);
  for (const metric of ["stringifyMs", "parseMs", "doubleCloneMs"] as const) {
    assert.ok(Number.isFinite(sample[metric]) && sample[metric] >= 0);
  }
});

test("returns a versioned report for custom informational workloads", () => {
  const report = runSnapshotScaleBenchmark([10, 20]);
  assert.equal(report.version, SNAPSHOT_BENCHMARK_VERSION);
  assert.equal(report.result, "MEASURED");
  assert.deepEqual(report.samples.map((sample) => sample.auditEvents), [10, 20]);
});

test("rejects empty, duplicate and invalid workload inputs instead of dropping them", () => {
  for (const counts of [[], [10, 10], [0], [-1], [1.5], [NaN], [Infinity], [Number.MAX_SAFE_INTEGER + 1], [10, NaN]]) {
    assert.throws(() => runSnapshotScaleBenchmark(counts), /PERF_WORKLOAD_INVALID/);
  }
  for (const count of [0, -1, 1.5, NaN, Infinity]) {
    assert.throws(() => buildAuditHeavyState(count), /PERF_WORKLOAD_INVALID/);
  }
});

test("ships a complete versioned baseline with zero byte-growth tolerance", () => {
  const baseline = readPerfBaseline(PERF_BASELINE_PATH);
  assert.equal(baseline.schemaVersion, 1);
  assert.equal(baseline.benchmark, SNAPSHOT_BENCHMARK_VERSION);
  assert.equal(baseline.regressionToleranceRatio, 0);
  assert.deepEqual(baseline.samples.map((sample) => sample.auditEvents), [1_000, 10_000, 100_000]);
});

test("passes the real complete benchmark at the committed byte baselines", () => {
  const baseline = readPerfBaseline();
  const report = runSnapshotScaleBenchmark();
  assert.deepEqual(report.samples.map((sample) => sample.bytes), baseline.samples.map((sample) => sample.recorded.bytes));
  const gate = evaluatePerfBaseline(report, baseline);
  assert.deepEqual(gate.regressions, []);
  assert.equal(gate.pass, true);
  assert.deepEqual(gate.gatedMetrics, ["bytes"]);
  assert.deepEqual(gate.informationalMetrics, ["stringifyMs", "parseMs", "doubleCloneMs"]);
});

test("rejects even one extra byte in any workload while accepting smaller snapshots", () => {
  const baseline = baselineFixture();
  for (let index = 0; index < baseline.samples.length; index++) {
    const report = reportFixture(baseline);
    report.samples[index]!.bytes += 1;
    const gate = evaluatePerfBaseline(report, baseline);
    assert.equal(gate.pass, false);
    assert.equal(gate.regressions.length, 1);
    assert.equal(gate.regressions[0]?.metric, "bytes");
    assert.equal(gate.regressions[0]?.auditEvents, baseline.samples[index]!.auditEvents);
    assert.equal(gate.regressions[0]?.reason, "regression_vs_baseline");
    report.samples[index]!.bytes -= 2;
    assert.equal(evaluatePerfBaseline(report, baseline).pass, true);
  }
});

test("enforces both byte ceilings and the configured byte tolerance boundaries", () => {
  const baseline = baselineFixture();
  baseline.regressionToleranceRatio = 0.25;
  const report = reportFixture(baseline);
  report.samples[0]!.bytes = 500;
  assert.equal(evaluatePerfBaseline(report, baseline).pass, true);
  report.samples[0]!.bytes = 501;
  assert.equal(evaluatePerfBaseline(report, baseline).regressions[0]?.reason, "regression_vs_baseline");
  baseline.regressionToleranceRatio = 10;
  report.samples[0]!.bytes = 1_000;
  assert.equal(evaluatePerfBaseline(report, baseline).pass, true);
  report.samples[0]!.bytes = 1_001;
  const gate = evaluatePerfBaseline(report, baseline);
  assert.equal(gate.pass, false);
  assert.equal(gate.regressions[0]?.reason, "absolute_ceiling");
});

test("timing variation beyond recorded and historical maximum values does not fail the gate", () => {
  const baseline = baselineFixture();
  for (const timing of [0, 0.01, 5.01, 11, 1_000_000, Number.MAX_VALUE]) {
    const report = reportFixture(baseline);
    for (const sample of report.samples) {
      sample.stringifyMs = timing;
      sample.parseMs = timing;
      sample.doubleCloneMs = timing;
    }
    assert.deepEqual(evaluatePerfBaseline(report, baseline).regressions, []);
    assert.equal(evaluatePerfBaseline(report, baseline).pass, true);
  }
});

test("fails closed on missing, extra, duplicate or invalid report workloads", () => {
  const baseline = baselineFixture();
  const samples = reportFixture(baseline).samples;
  for (const invalid of [[], samples.slice(1), [...samples, samples[0]!], [samples[0]!, samples[0]!, samples[2]!],
    samples.map((sample, index) => index === 0 ? { ...sample, auditEvents: 7 } : sample),
    samples.map((sample, index) => index === 0 ? { ...sample, auditEvents: NaN } : sample),
    [null, ...samples.slice(1)]]) {
    assert.throws(() => evaluatePerfBaseline({ ...reportFixture(), samples: invalid } as SnapshotScaleReport, baseline), /PERF_REPORT_INVALID:coverage/);
  }
  assert.throws(() => evaluatePerfBaseline(runSnapshotScaleBenchmark([7]), baseline), /PERF_REPORT_INVALID:coverage/);
});

test("rejects wrong report versions and malformed report structures", () => {
  for (const report of [null, {}, { ...reportFixture(), samples: null }, { ...reportFixture(), version: "old" },
    { ...reportFixture(), result: "PASS" }]) {
    assert.throws(() => evaluatePerfBaseline(report as SnapshotScaleReport, baselineFixture()), /PERF_REPORT_INVALID/);
  }
});

test("rejects invalid samples including non-finite informational timings", () => {
  for (const metric of ["bytes", "stringifyMs", "parseMs", "doubleCloneMs"] as const) {
    const values = [undefined, null, "4", NaN, Infinity, -Infinity, -1, ...(metric === "bytes" ? [0, 1.5, Number.MAX_SAFE_INTEGER + 1] : [])];
    for (const value of values) {
      const report = reportFixture();
      Object.assign(report.samples[0]!, { [metric]: value });
      assert.throws(() => evaluatePerfBaseline(report, baselineFixture()), /PERF_REPORT_INVALID:sample/);
    }
  }
});

test("refuses missing and malformed baseline files instead of skipping the gate", (t) => {
  const directory = mkdtempSync(path.join(tmpdir(), "cvg-perf-fix-baseline-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const baselinePath = path.join(directory, "baseline.json");
  assert.throws(() => readPerfBaseline(baselinePath), /ENOENT/);
  for (const contents of ["{", "null", "[]", "{}", JSON.stringify({ ...baselineFixture(), benchmark: "old" })]) {
    writeFileSync(baselinePath, contents);
    assert.throws(() => readPerfBaseline(baselinePath));
  }
});

test("validates direct baselines as well as file baselines", (t) => {
  const directory = mkdtempSync(path.join(tmpdir(), "cvg-perf-fix-baseline-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const baselinePath = path.join(directory, "baseline.json");
  const baseline = baselineFixture();
  const invalid: unknown[] = [null, {}, { ...baseline, schemaVersion: 2 }, { ...baseline, benchmark: "old" },
    { ...baseline, recordedOn: "" }, { ...baseline, recordedOnNode: null }, { ...baseline, policy: " " },
    { ...baseline, samples: [] }, { ...baseline, samples: baseline.samples.slice(1) },
    { ...baseline, samples: [...baseline.samples, baseline.samples[0]] },
    { ...baseline, samples: [baseline.samples[0], baseline.samples[0], baseline.samples[2]] },
    { ...baseline, samples: [null, ...baseline.samples.slice(1)] }];
  for (const ratio of [undefined, null, "0", -1, NaN, Infinity, Number.MAX_VALUE]) {
    invalid.push({ ...baseline, regressionToleranceRatio: ratio });
  }
  for (const level of ["recorded", "max"] as const) {
    for (const metric of ["bytes", "stringifyMs", "parseMs", "doubleCloneMs"] as const) {
      for (const value of [undefined, null, "4", NaN, Infinity, -1, ...(metric === "bytes" ? [0, 1.5] : [])]) {
        const malformed = baselineFixture();
        Object.assign(malformed.samples[0]![level], { [metric]: value });
        invalid.push(malformed);
      }
    }
    const missingMetrics = baselineFixture();
    Object.assign(missingMetrics.samples[0]!, { [level]: null });
    invalid.push(missingMetrics);
  }
  const badCeiling = baselineFixture();
  badCeiling.samples[0]!.max.bytes = 399;
  invalid.push(badCeiling);
  for (const malformed of invalid) {
    assert.throws(() => evaluatePerfBaseline(reportFixture(), malformed as PerfBaseline), /PERF_BASELINE/);
    writeFileSync(baselinePath, JSON.stringify(malformed));
    assert.throws(() => readPerfBaseline(baselinePath), /PERF_BASELINE/);
  }
});

test("the CLI fails closed for an incomplete or malformed workload selection", () => {
  for (const events of ["1000", "1000,1000,100000", "1000,invalid,100000", ""]) {
    const result = spawnSync(process.execPath, [path.resolve("node_modules/tsx/dist/cli.mjs"), path.resolve("scripts/perf-snapshot.ts"), "--check"], {
      env: { ...process.env, PERF_SNAPSHOT_EVENTS: events },
      encoding: "utf8",
      timeout: 15_000
    });
    assert.ifError(result.error);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /PERF_(REPORT|WORKLOAD)_INVALID/);
  }
});
