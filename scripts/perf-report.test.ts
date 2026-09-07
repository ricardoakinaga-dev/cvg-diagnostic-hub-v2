import assert from "node:assert/strict";
import test from "node:test";
import { percentile, round, summarize } from "./perf-report";

test("reports request count, errors and p50/p95/p99 without hiding tail latency", () => {
  const report = summarize("/api/v1/search", [
    { status: 200, durationMs: 30 },
    { status: 200, durationMs: 10 },
    { status: 503, durationMs: 90 },
    { status: 200, durationMs: 50 }
  ]);

  assert.deepEqual(report, {
    endpoint: "/api/v1/search",
    requests: 4,
    errors: 1,
    errorRate: 0.25,
    p50Ms: 30,
    p95Ms: 90,
    p99Ms: 90,
    maxMs: 90
  });
});

test("handles empty samples and rounds emitted durations deterministically", () => {
  assert.equal(percentile([], 0.95), 0);
  assert.equal(round(12.345), 12.35);
  assert.equal(summarize("/health", []).p99Ms, 0);
});
