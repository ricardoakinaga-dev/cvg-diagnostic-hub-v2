import { readFileSync } from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { createDemoState } from "../src/server/store/fixtures";
import type { StoreState } from "../src/server/domain/models";

export const SNAPSHOT_BENCHMARK_VERSION = "prod-2026-10-snapshot-v2";
export const PERF_BASELINE_PATH = path.resolve(process.cwd(), "docs/build/PERF_BASELINE.json");
const DEFAULT_EVENT_COUNTS = [1_000, 10_000, 100_000];
const FIXTURE_TIMESTAMP = "2026-08-19T12:00:00.000Z";
const TIMING_METRICS = ["stringifyMs", "parseMs", "doubleCloneMs"] as const;

export type PerfMetric = "bytes" | "stringifyMs" | "parseMs" | "doubleCloneMs";

export interface PerfBaselineSample {
  readonly auditEvents: number;
  /** Only bytes are gated; recorded timings are informational. */
  readonly recorded: Readonly<Record<PerfMetric, number>>;
  /** Only max.bytes is enforced; timing ceilings are historical information. */
  readonly max: Readonly<Record<PerfMetric, number>>;
}

export interface PerfBaseline {
  readonly schemaVersion: number;
  readonly benchmark: string;
  readonly recordedOn: string;
  readonly recordedOnNode: string;
  readonly policy: string;
  readonly regressionToleranceRatio: number;
  readonly samples: readonly PerfBaselineSample[];
}

export interface PerfRegression {
  readonly auditEvents: number;
  readonly metric: string;
  readonly measured: number;
  readonly ceiling: number;
  readonly ratio: number;
  readonly reason: "absolute_ceiling" | "regression_vs_baseline";
}

export interface PerfGateReport {
  readonly benchmark: string;
  readonly baseline: string;
  readonly measuredOnNode: string;
  readonly regressionToleranceRatio: number;
  readonly gatedMetrics: readonly ["bytes"];
  readonly informationalMetrics: readonly (typeof TIMING_METRICS)[number][];
  readonly regressions: readonly PerfRegression[];
  readonly pass: boolean;
}

export interface SnapshotScaleSample {
  auditEvents: number;
  bytes: number;
  stringifyMs: number;
  parseMs: number;
  doubleCloneMs: number;
}

export interface SnapshotScaleReport {
  benchmark: string;
  version: string;
  result: "MEASURED";
  samples: SnapshotScaleSample[];
  limitations: string[];
}

/** Normalize only fixture entropy, preserving the serialized domain shape. */
export function normalizeSnapshotFixture(state: StoreState): StoreState {
  return {
    ...state,
    users: state.users.map((user) => ({
      ...user,
      // Synthetic salt/hash with the fixture's scrypt encoding and width.
      passwordHash: `fixture-${user.id}:${"0".repeat(128)}`,
      createdAt: FIXTURE_TIMESTAMP
    })),
    encounters: state.encounters.map((encounter) => ({ ...encounter, openedAt: FIXTURE_TIMESTAMP })),
    admissions: state.admissions.map((admission) => ({ ...admission, admittedAt: FIXTURE_TIMESTAMP }))
  };
}

export function buildAuditHeavyState(auditEvents: number): StoreState {
  validateCounts([auditEvents], "PERF_WORKLOAD_INVALID");
  const state = normalizeSnapshotFixture(createDemoState("snapshot-scale-password"));
  const events = Array.from({ length: auditEvents }, (_, index) => ({
    id: `audit-scale-${index}`,
    eventType: "ScaleProbe",
    entityType: "DiagnosticRequest",
    entityId: "request-scale",
    correlationId: `corr-scale-${index}`,
    metadata: { index, source: "perf-snapshot" },
    occurredAt: new Date(Date.UTC(2025, 9, 1) + index * 1_000).toISOString()
  }));
  return { ...state, auditEvents: events };
}

export function measureSnapshotScale(auditEvents: number): SnapshotScaleSample {
  const state = buildAuditHeavyState(auditEvents);
  const stringifyStarted = performance.now();
  const serialized = JSON.stringify(state);
  const stringifyMs = performance.now() - stringifyStarted;
  const parseStarted = performance.now();
  const parsed = JSON.parse(serialized) as StoreState;
  const parseMs = performance.now() - parseStarted;
  const cloneStarted = performance.now();
  structuredClone(parsed);
  structuredClone(parsed);
  const doubleCloneMs = performance.now() - cloneStarted;
  return {
    auditEvents,
    bytes: Buffer.byteLength(serialized, "utf8"),
    stringifyMs: round(stringifyMs),
    parseMs: round(parseMs),
    doubleCloneMs: round(doubleCloneMs)
  };
}

export function runSnapshotScaleBenchmark(eventCounts = DEFAULT_EVENT_COUNTS): SnapshotScaleReport {
  validateCounts(eventCounts, "PERF_WORKLOAD_INVALID");
  return {
    benchmark: "PROD-110 JSONB snapshot scale baseline",
    version: SNAPSHOT_BENCHMARK_VERSION,
    result: "MEASURED",
    samples: eventCounts.map(measureSnapshotScale),
    limitations: [
      "Only deterministic snapshot bytes are gated; stringify, parse and double-clone timings are informational and vary by host and load.",
      "This baseline isolates JSON serialization, parsing and cloning; it does not claim PostgreSQL WAL, lock or network latency.",
      "The events are synthetic and must be paired with the approved D2 volume, p95 targets and a staging PostgreSQL load run before production acceptance."
    ]
  };
}

/**
 * Reads the committed baseline. The gate fails closed when the baseline is
 * missing or malformed: an unparsable baseline must never silently disable the
 * regression check.
 */
export function readPerfBaseline(baselinePath: string = PERF_BASELINE_PATH): PerfBaseline {
  const parsed: unknown = JSON.parse(readFileSync(baselinePath, "utf8"));
  validatePerfBaseline(parsed);
  return parsed;
}

function validatePerfBaseline(value: unknown): asserts value is PerfBaseline {
  if (!value || typeof value !== "object") throw new Error("PERF_BASELINE_INVALID");
  const parsed = value as Partial<PerfBaseline>;
  const samples = parsed.samples;
  if (
    parsed.schemaVersion !== 1
    || typeof parsed.benchmark !== "string"
    || !Number.isFinite(parsed.regressionToleranceRatio)
    || Number(parsed.regressionToleranceRatio) < 0
    || ![parsed.recordedOn, parsed.recordedOnNode, parsed.policy].every((entry) => typeof entry === "string" && entry.trim().length > 0)
    || !Array.isArray(samples)
    || samples.length === 0
  ) {
    throw new Error("PERF_BASELINE_INVALID");
  }
  validateCounts(samples.map((sample) => sample?.auditEvents), "PERF_BASELINE_INVALID:coverage", DEFAULT_EVENT_COUNTS);
  for (const sample of samples) {
    for (const level of ["recorded", "max"] as const) {
      validateMetrics(sample[level], `PERF_BASELINE_INVALID:${level}`);
    }
    if (sample.max.bytes < sample.recorded.bytes || !Number.isFinite(sample.recorded.bytes * (1 + Number(parsed.regressionToleranceRatio)))) {
      throw new Error("PERF_BASELINE_INVALID:byteCeiling");
    }
  }
  if (parsed.benchmark !== SNAPSHOT_BENCHMARK_VERSION) {
    throw new Error(`PERF_BASELINE_BENCHMARK_MISMATCH:${parsed.benchmark}`);
  }
}

/**
 * PROD-110 acceptance gates deterministic byte size only. Timings remain in
 * the measurement report but never decide acceptance. Both inputs must cover
 * every required workload exactly once; malformed inputs fail closed.
 */
export function evaluatePerfBaseline(
  report: SnapshotScaleReport,
  baseline: PerfBaseline = readPerfBaseline()
): PerfGateReport {
  validatePerfBaseline(baseline);
  if (!report || report.version !== SNAPSHOT_BENCHMARK_VERSION || report.result !== "MEASURED" || !Array.isArray(report.samples)) {
    throw new Error("PERF_REPORT_INVALID");
  }
  validateCounts(report.samples.map((sample) => sample?.auditEvents), "PERF_REPORT_INVALID:coverage", DEFAULT_EVENT_COUNTS);
  for (const sample of report.samples) validateMetrics(sample, "PERF_REPORT_INVALID:sample");

  const regressions: PerfRegression[] = [];

  for (const sample of report.samples) {
    const expected = baseline.samples.find((entry) => entry.auditEvents === sample.auditEvents)!;
    const measured = sample.bytes;
    const hardMaximum = expected.max.bytes;
    if (measured > hardMaximum) {
      regressions.push({
        auditEvents: sample.auditEvents,
        metric: "bytes",
        measured,
        ceiling: hardMaximum,
        ratio: round(measured / hardMaximum),
        reason: "absolute_ceiling"
      });
      continue;
    }
    const recorded = expected.recorded.bytes;
    const tolerated = recorded * (1 + baseline.regressionToleranceRatio);
    if (measured > tolerated) {
      regressions.push({
        auditEvents: sample.auditEvents,
        metric: "bytes",
        measured,
        ceiling: round(tolerated),
        ratio: round(measured / recorded),
        reason: "regression_vs_baseline"
      });
    }
  }

  return {
    benchmark: report.benchmark,
    baseline: `${baseline.recordedOn}/${baseline.recordedOnNode}`,
    measuredOnNode: process.version,
    regressionToleranceRatio: baseline.regressionToleranceRatio,
    gatedMetrics: ["bytes"],
    informationalMetrics: TIMING_METRICS,
    regressions,
    pass: regressions.length === 0
  };
}

function validateCounts(counts: readonly number[], error: string, required?: readonly number[]): void {
  if (
    !Array.isArray(counts) || counts.length === 0
    || counts.some((count) => !Number.isSafeInteger(count) || count <= 0)
    || new Set(counts).size !== counts.length
    || (required && (counts.length !== required.length || required.some((count) => !counts.includes(count))))
  ) throw new Error(error);
}

function validateMetrics(value: unknown, error: string): void {
  const metrics = value as Partial<Record<PerfMetric, number>> | null | undefined;
  if (!Number.isSafeInteger(metrics?.bytes) || Number(metrics?.bytes) <= 0) throw new Error(`${error}.bytes`);
  for (const metric of TIMING_METRICS) {
    if (!Number.isFinite(metrics?.[metric]) || Number(metrics?.[metric]) < 0) throw new Error(`${error}.${metric}`);
  }
}

function round(value: number): number {
  return Number(value.toFixed(2));
}

function parseCounts(value: string | undefined): number[] {
  if (value === undefined) return DEFAULT_EVENT_COUNTS;
  const counts = value.split(",").map((entry) => Number(entry.trim()));
  validateCounts(counts, "PERF_WORKLOAD_INVALID");
  return counts;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const report = runSnapshotScaleBenchmark(parseCounts(process.env.PERF_SNAPSHOT_EVENTS));
  console.log(JSON.stringify(report, null, 2));
  if (process.argv.includes("--check")) {
    const gate = evaluatePerfBaseline(report);
    console.log(JSON.stringify(gate, null, 2));
    if (!gate.pass) {
      console.error("PERF_SNAPSHOT_GATE_FAILED: snapshot bytes regressed against docs/build/PERF_BASELINE.json.");
      process.exitCode = 1;
    }
  }
}
