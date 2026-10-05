import assert from "node:assert/strict";
import test from "node:test";
import { assessPostgresPerf, type PostgresPerfEvidence } from "./perf-postgres-report";
import { summarize, type PerfSummary } from "./perf-report";

function evidenceFixture(): PostgresPerfEvidence {
  return {
    auditEvents: 100_000,
    expectedAuditEvents: 100_000,
    sseConnections: 100,
    expectedSseConnections: 100,
    requests: [
      summarize("/api/v1/search", [{ status: 200, durationMs: 12 }, { status: 200, durationMs: 30 }]),
      summarize("/api/v1/dashboard", [{ status: 200, durationMs: 5 }])
    ],
    expectedReads: [{ endpoint: "/api/v1/search", requests: 2 }, { endpoint: "/api/v1/dashboard", requests: 1 }],
    writes: summarize("/api/v1/write", [{ status: 201, durationMs: 20 }, { status: 201, durationMs: 25 }]),
    durableWrites: 2,
    expectedWrites: 2,
    unexpectedStreamClosures: 0
  };
}

function assertFailure(evidence: PostgresPerfEvidence, message: RegExp): void {
  const gate = assessPostgresPerf(evidence);
  assert.equal(gate.pass, false);
  assert.ok(gate.failures.some((failure) => message.test(failure)), gate.failures.join("\n"));
}

test("accepts complete HTTP/PG/SSE evidence without mutating it", () => {
  const evidence = evidenceFixture();
  const before = structuredClone(evidence);
  const gate = assessPostgresPerf(evidence);
  assert.equal(gate.pass, true);
  assert.deepEqual(gate.failures, []);
  assert.match(gate.timingPolicy, /Latency is informational in CI/);
  assert.match(gate.timingPolicy, /no hard timing or regression thresholds/);
  assert.deepEqual(evidence, before);
});

test("accepts zero and arbitrarily slow finite timings without host-dependent thresholds", () => {
  for (const durationMs of [0, 0.001, 1_000_000, Number.MAX_VALUE]) {
    const evidence = evidenceFixture();
    evidence.requests = [summarize("/slow", [{ status: 200, durationMs }])];
    evidence.expectedReads = [{ endpoint: "/slow", requests: 1 }];
    evidence.writes = summarize("/write", Array.from({ length: evidence.expectedWrites }, () => ({ status: 201, durationMs })));
    assert.deepEqual(assessPostgresPerf(evidence).failures, []);
    assert.equal(assessPostgresPerf(evidence).pass, true);
  }
});

test("rejects missing or extra audit events, SSE connections, writes and durable writes", () => {
  for (const delta of [-1, 1]) {
    for (const field of ["auditEvents", "sseConnections", "durableWrites"] as const) {
      const evidence = evidenceFixture();
      evidence[field] += delta;
      assertFailure(evidence, new RegExp(field));
    }
    const evidence = evidenceFixture();
    evidence.writes.requests += delta;
    assertFailure(evidence, /writes: measured count/);
  }
});

test("rejects invalid expected counts even when the measured count matches", () => {
  for (const value of [0, -1, 1.5, NaN, Infinity, -Infinity, Number.MAX_SAFE_INTEGER + 1, undefined, null, "2"]) {
    for (const field of ["expectedAuditEvents", "expectedSseConnections", "expectedWrites"] as const) {
      const evidence = evidenceFixture();
      Object.assign(evidence, { [field]: value });
      if (field === "expectedAuditEvents") Object.assign(evidence, { auditEvents: value });
      if (field === "expectedSseConnections") Object.assign(evidence, { sseConnections: value });
      if (field === "expectedWrites") {
        Object.assign(evidence.writes, { requests: value });
        Object.assign(evidence, { durableWrites: value });
      }
      assertFailure(evidence, /expected count must be a positive safe integer/);
    }
  }
});

test("rejects invalid measured counts instead of allowing NaN or coercion bypasses", () => {
  for (const value of [0, -1, 1.5, NaN, Infinity, -Infinity, Number.MAX_SAFE_INTEGER + 1, undefined, null, "2"]) {
    for (const field of ["auditEvents", "sseConnections", "durableWrites"] as const) {
      const evidence = evidenceFixture();
      Object.assign(evidence, { [field]: value });
      assertFailure(evidence, new RegExp(field));
    }
    for (const select of [(evidence: PostgresPerfEvidence) => evidence.requests[0]!, (evidence: PostgresPerfEvidence) => evidence.writes]) {
      const evidence = evidenceFixture();
      Object.assign(select(evidence), { requests: value });
      assertFailure(evidence, /request count must be a positive safe integer/);
    }
  }
});

test("rejects a missing workload and an empty route even when other routes succeed", () => {
  const evidence = evidenceFixture();
  evidence.requests = [];
  assertFailure(evidence, /at least one route summary/);
  evidence.requests = [...evidenceFixture().requests, summarize("/empty", [])];
  assertFailure(evidence, /requests\[2\]: request count/);
  evidence.requests = new Array<PerfSummary>(1);
  assertFailure(evidence, /requests\[0\]: missing request summary/);
  evidence.writes = summarize("/write", []);
  assertFailure(evidence, /writes: request count/);
});

test("rejects HTTP errors, transport errors and a truncated body represented as a failed sample", () => {
  for (const failedSample of [
    { status: 503, durationMs: 12 },
    { status: 0, durationMs: 12 },
    // The harness records body-consumption failure as an error even after HTTP 200 headers.
    { status: 502, durationMs: 12 }
  ]) {
    for (const target of ["requests", "writes"] as const) {
      const evidence = evidenceFixture();
      const summary = summarize("/failed", [{ status: 200, durationMs: 5 }, failedSample]);
      if (target === "requests") evidence.requests.push(summary);
      else evidence.writes = summary;
      assertFailure(evidence, /all samples must succeed/);
    }
  }
});

test("rejects errors hidden by a rounded rate and malformed error statistics", () => {
  for (const select of [(evidence: PostgresPerfEvidence) => evidence.requests[0]!, (evidence: PostgresPerfEvidence) => evidence.writes]) {
    for (const [field, values] of [
      ["errors", [1, -1, 0.5, NaN, Infinity, undefined, null, "0"]],
      ["errorRate", [0.0001, -1, NaN, Infinity, undefined, null, "0"]]
    ] as const) {
      for (const value of values) {
        const evidence = evidenceFixture();
        Object.assign(select(evidence), { [field]: value });
        assertFailure(evidence, /all samples must succeed/);
      }
    }
  }
});

test("rejects successful HTTP writes that did not all persist in PostgreSQL", () => {
  const evidence = evidenceFixture();
  assert.equal(evidence.writes.errors, 0);
  evidence.durableWrites = 1;
  assertFailure(evidence, /durableWrites: measured count 1 must equal expected count 2/);
});

test("rejects unexpected stream closures and invalid closure counts", () => {
  for (const value of [1, -1, 0.5, NaN, Infinity, undefined, null, "0"]) {
    const evidence = evidenceFixture();
    Object.assign(evidence, { unexpectedStreamClosures: value });
    assertFailure(evidence, /unexpectedStreamClosures/);
  }
});

test("validates every route and write timing statistic", () => {
  const selectSummaries: ((evidence: PostgresPerfEvidence) => PerfSummary)[] = [
    (evidence) => evidence.requests[0]!,
    (evidence) => evidence.requests[1]!,
    (evidence) => evidence.writes
  ];
  for (const select of selectSummaries) {
    for (const metric of ["p50Ms", "p95Ms", "p99Ms", "maxMs"] as const) {
      for (const value of [NaN, Infinity, -Infinity, -1, undefined, null, "12"]) {
        const evidence = evidenceFixture();
        Object.assign(select(evidence), { [metric]: value });
        assertFailure(evidence, new RegExp(`${metric} must be finite and nonnegative`));
      }
    }
  }
});

test("rejects malformed route collections, missing summaries and unnamed routes", () => {
  for (const value of [undefined, null, {}]) {
    const evidence = evidenceFixture();
    Object.assign(evidence, { requests: value });
    assertFailure(evidence, /at least one route summary/);
  }
  for (const value of [undefined, null]) {
    const evidence = evidenceFixture();
    Object.assign(evidence.requests, { 1: value });
    assertFailure(evidence, /requests\[1\]: missing request summary/);
    Object.assign(evidence, { writes: value });
    assertFailure(evidence, /writes: missing request summary/);
  }
  for (const value of ["", " ", undefined, null]) {
    const evidence = evidenceFixture();
    Object.assign(evidence.requests[0]!, { endpoint: value });
    assertFailure(evidence, /endpoint must be nonempty/);
  }
});

test("reports independent failures together instead of stopping at the first error", () => {
  const evidence = evidenceFixture();
  evidence.auditEvents -= 1;
  evidence.sseConnections -= 1;
  evidence.requests[1]!.errors = 1;
  evidence.writes.p99Ms = NaN;
  evidence.durableWrites -= 1;
  evidence.unexpectedStreamClosures = 1;
  const gate = assessPostgresPerf(evidence);
  assert.equal(gate.pass, false);
  assert.equal(gate.failures.length, 6);
});

test("requires all expected endpoints with exactly the expected sample counts", () => {
  for (const mutation of [
    (evidence: PostgresPerfEvidence) => { evidence.requests.pop(); },
    (evidence: PostgresPerfEvidence) => { evidence.requests[0].requests--; },
    (evidence: PostgresPerfEvidence) => { evidence.requests.push(evidence.requests[0]); },
    (evidence: PostgresPerfEvidence) => { evidence.requests = [summarize("/unrelated", [{ status: 200, durationMs: 1 }])]; }
  ]) {
    const evidence = evidenceFixture();
    mutation(evidence);
    assert.equal(assessPostgresPerf(evidence).pass, false);
  }
  for (const expected of [[], [{ endpoint: "/api/v1/search", requests: NaN }], [...evidenceFixture().expectedReads, evidenceFixture().expectedReads[0]]]) {
    const evidence = evidenceFixture();
    evidence.expectedReads = expected;
    assert.equal(assessPostgresPerf(evidence).pass, false);
  }
});

test("fails a route or write whose p95 exceeds an explicit ceiling and keeps latency informational without one", () => {
  const slow = evidenceFixture();
  slow.requests = [
    summarize("/api/v1/search", [{ status: 200, durationMs: 1_700 }, { status: 200, durationMs: 1_800 }]),
    summarize("/api/v1/dashboard", [{ status: 200, durationMs: 900 }])
  ];
  slow.writes = summarize("/api/v1/write", [{ status: 201, durationMs: 1_700 }, { status: 201, durationMs: 1_800 }]);
  assert.equal(assessPostgresPerf(slow).pass, true);
  const gated = assessPostgresPerf({ ...slow, p95CeilingsMs: { read: 1_000, search: 1_600, write: 1_600 } });
  assert.equal(gated.pass, false);
  assert.ok(gated.failures.some((failure) => /\/api\/v1\/search: p95 .* exceeds the ceiling of 1600 ms/.test(failure)), gated.failures.join("\n"));
  assert.ok(gated.failures.some((failure) => /^writes: p95 .* exceeds the ceiling of 1600 ms/.test(failure)), gated.failures.join("\n"));
  assert.ok(!gated.failures.some((failure) => failure.startsWith("/api/v1/dashboard")), gated.failures.join("\n"));
  assert.match(gated.timingPolicy, /absolute p95 ceilings/);
});

test("accepts timings under the ceilings and rejects malformed ceilings", () => {
  const ok = assessPostgresPerf({ ...evidenceFixture(), p95CeilingsMs: { read: 1_000, search: 1_600, write: 1_600 } });
  assert.equal(ok.pass, true);
  for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
    const gate = assessPostgresPerf({ ...evidenceFixture(), p95CeilingsMs: { read: bad, search: 1_600, write: 1_600 } });
    assert.equal(gate.pass, false);
    assert.ok(gate.failures.some((failure) => /p95CeilingsMs\.read: must be a positive finite number/.test(failure)));
  }
});
