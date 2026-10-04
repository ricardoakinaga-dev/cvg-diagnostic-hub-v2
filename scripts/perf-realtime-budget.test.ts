import assert from "node:assert/strict";
import test from "node:test";
import {
  measureRealtimeReadBudget,
  REALTIME_BUDGET_BENCHMARK_VERSION,
  REALTIME_MAX_STATE_READS_PER_SECOND
} from "./perf-realtime-budget";

/**
 * The PROD-104 acceptance criterion is an executable number: with many open
 * connections a process must not issue one aggregate read per connection per
 * tick. A short window keeps the check inside the unit lane while still
 * crossing several poll ticks.
 */
test("holds the aggregate read budget with many concurrent connections", async () => {
  const report = await measureRealtimeReadBudget({
    connections: 25,
    windowMs: 1_500,
    pollIntervalMs: 50,
    sharedReadMinIntervalMs: 1_000
  });

  assert.equal(report.version, REALTIME_BUDGET_BENCHMARK_VERSION);
  assert.equal(report.connections, 25);
  assert.equal(report.budgetReadsPerSecond, REALTIME_MAX_STATE_READS_PER_SECOND);
  assert.ok(report.budgetReadsInWindow >= 1);
  // The cadence allows one aggregate read per second plus the one that opens
  // the window. Twenty-five connections polling every 50ms used to produce one
  // read each per tick.
  assert.ok(
    report.stateReads <= report.budgetReadsInWindow,
    `expected at most ${String(report.budgetReadsInWindow)} aggregate reads, measured ${String(report.stateReads)}`
  );
  assert.ok(report.stateReads < report.connections, "reads must not scale with the connection count");
  assert.equal(report.pass, true);
  // With no write between polls the version guard is exact, so no narrow
  // authorization read is needed either.
  assert.equal(report.authorizationReads, 0);
  assert.ok(report.limitations.length > 0);
});