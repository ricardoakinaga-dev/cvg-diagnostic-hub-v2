import assert from "node:assert/strict";
import test from "node:test";
import {
  buildSyntheticDataset,
  defaultSyntheticWorkloads,
  executeSyntheticRequest,
  runSyntheticBenchmark,
  runSyntheticWorkload
} from "./perf-workload";

test("builds the same versioned synthetic dataset and digest for the same seed", () => {
  const first = buildSyntheticDataset({ seed: 12345, recordCount: 240 });
  const second = buildSyntheticDataset({ seed: 12345, recordCount: 240 });

  assert.deepEqual(second.manifest, first.manifest);
  assert.deepEqual(second.records, first.records);
  assert.equal(first.manifest.rareProtocol, "CVG-2026-RARE-0001");
  assert.equal(first.byProtocol.get(first.manifest.rareProtocol)?.length, 1);
  assert.ok((first.byTerm.get("thor")?.length ?? 0) > 1, "the fixture must include homonyms for textual search");
  assert.ok(first.manifest.historyEvents > first.manifest.records, "the fixture must include history volume");
  assert.ok(first.manifest.departmentCounts.LAB > first.manifest.departmentCounts.ICU, "the fixture must retain deterministic sector skew");
  assert.ok(first.manifest.maxQueueDepth > 25, "the fixture must include an extended queue");
});

test("search and queue operations apply the synthetic department scope before returning records", () => {
  const dataset = buildSyntheticDataset({ seed: 42, recordCount: 160, scopedDepartments: ["LAB"] });
  const exact = executeSyntheticRequest(dataset, "search-exact", 0, 42);
  const text = executeSyntheticRequest(dataset, "search-text", 0, 42);
  const queue = executeSyntheticRequest(dataset, "queue-read", 0, 42);

  assert.equal(exact.status, 200);
  assert.equal(exact.resultCount, 1, "the rare protocol remains visible when its department is in scope");
  assert.equal(text.status, 200);
  assert.equal(queue.status, 200);
  assert.ok(text.scannedRecords >= text.resultCount);
  assert.ok(queue.scannedRecords >= queue.resultCount);

  const blocked = buildSyntheticDataset({ seed: 42, recordCount: 160, scopedDepartments: ["CARDIO"] });
  const blockedExact = executeSyntheticRequest(blocked, "search-exact", 0, 42);
  assert.equal(blockedExact.resultCount, 0, "an out-of-scope rare protocol must not leak through exact search");
});

test("records expected validation errors separately from unexpected errors", () => {
  const dataset = buildSyntheticDataset({ seed: 9, recordCount: 80 });
  const workload = { id: "invalid", endpoint: "/api/v1/search?q=", operation: "invalid-search" as const, requests: 8, concurrency: 3 };
  const report = runSyntheticWorkload(dataset, workload, 9);

  assert.equal(report.requests, 8);
  assert.equal(report.errors, 8);
  assert.equal(report.expectedErrors, 8);
  assert.equal(report.unexpectedErrors, 0);
  assert.equal(report.errorRate, 1);
  assert.equal(report.maxInFlight, 3);
});

test("runs operational reads and exact/text search with deterministic tail metrics and bounded concurrency", () => {
  const options = { seed: 20260905, recordCount: 600, requestsPerWorkload: 32, concurrency: 8 };
  const first = runSyntheticBenchmark(options);
  const second = runSyntheticBenchmark(options);

  assert.deepEqual(second, first);
  assert.equal(first.result, "PASS");
  assert.equal(first.aggregate.unexpectedErrors, 0);
  assert.ok(first.aggregate.expectedErrors > 0);
  assert.equal(first.aggregate.maxConcurrency, 8);
  assert.ok(first.aggregate.maxP95Ms > 0);
  assert.ok(first.aggregate.maxP99Ms >= first.aggregate.maxP95Ms);
  assert.ok(first.localGates.readP95Ms <= first.localGates.thresholds.readP95Ms);
  assert.ok(first.localGates.exactSearchP95Ms <= first.localGates.thresholds.exactSearchP95Ms);
  assert.ok(first.localGates.textualSearchP95Ms <= first.localGates.thresholds.textualSearchP95Ms);
  assert.equal(defaultSyntheticWorkloads({ requestsPerWorkload: 20, concurrency: 5 })[0]?.concurrency, 5);
});

test("concurrency changes virtual completion time while preserving request-level latency distribution", () => {
  const dataset = buildSyntheticDataset({ seed: 77, recordCount: 200 });
  const serial = runSyntheticWorkload(dataset, { id: "serial", endpoint: "/queue", operation: "queue-read", requests: 24, concurrency: 1 }, 77);
  const parallel = runSyntheticWorkload(dataset, { id: "parallel", endpoint: "/queue", operation: "queue-read", requests: 24, concurrency: 6 }, 77);

  assert.equal(parallel.p50Ms, serial.p50Ms);
  assert.equal(parallel.p95Ms, serial.p95Ms);
  assert.equal(parallel.p99Ms, serial.p99Ms);
  assert.ok(parallel.virtualDurationMs < serial.virtualDurationMs);
  assert.equal(parallel.maxInFlight, 6);
});
