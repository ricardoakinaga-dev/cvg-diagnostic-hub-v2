import type { PerfSummary } from "./perf-report";

export interface PostgresPerfEvidence {
  auditEvents: number;
  expectedAuditEvents: number;
  sseConnections: number;
  expectedSseConnections: number;
  requests: PerfSummary[];
  expectedReads: { endpoint: string; requests: number }[];
  writes: PerfSummary;
  durableWrites: number;
  expectedWrites: number;
  unexpectedStreamClosures: number;
  /**
   * Optional absolute p95 ceilings (ms). Left out, latency stays informational. Set, a route or write
   * above its ceiling fails the gate. The ceiling is meant to catch gross regressions, not to certify
   * the PRD target on a shared runner, so callers pass a generous multiple of the target.
   */
  p95CeilingsMs?: { read: number; search: number; write: number };
}

export function assessPostgresPerf(evidence: PostgresPerfEvidence): {
  pass: boolean;
  failures: string[];
  timingPolicy: string;
} {
  const failures: string[] = [];

  function exactCount(label: string, actual: number, expected: number): void {
    if (!Number.isSafeInteger(expected) || expected <= 0) {
      failures.push(`${label}: expected count must be a positive safe integer.`);
    }
    if (!Number.isSafeInteger(actual) || actual < 0 || actual !== expected) {
      failures.push(`${label}: measured count ${actual} must equal expected count ${expected}.`);
    }
  }

  function successfulSummary(label: string, summary: PerfSummary): void {
    if (!summary || typeof summary !== "object") {
      failures.push(`${label}: missing request summary.`);
      return;
    }
    if (typeof summary.endpoint !== "string" || summary.endpoint.trim() === "") {
      failures.push(`${label}: endpoint must be nonempty.`);
    }
    if (!Number.isSafeInteger(summary.requests) || summary.requests <= 0) {
      failures.push(`${label}: request count must be a positive safe integer.`);
    }
    if (summary.errors !== 0 || summary.errorRate !== 0) {
      failures.push(`${label}: all samples must succeed (errors=${summary.errors}, errorRate=${summary.errorRate}).`);
    }
    for (const metric of ["p50Ms", "p95Ms", "p99Ms", "maxMs"] as const) {
      if (!Number.isFinite(summary[metric]) || summary[metric] < 0) {
        failures.push(`${label}: ${metric} must be finite and nonnegative.`);
      }
    }
  }

  exactCount("auditEvents", evidence.auditEvents, evidence.expectedAuditEvents);
  exactCount("sseConnections", evidence.sseConnections, evidence.expectedSseConnections);
  if (!Array.isArray(evidence.requests) || evidence.requests.length === 0) {
    failures.push("requests: at least one route summary is required.");
  } else {
    for (const [index, summary] of evidence.requests.entries()) {
      successfulSummary(`requests[${index}]`, summary);
    }
  }
  if (!Array.isArray(evidence.expectedReads) || evidence.expectedReads.length === 0) {
    failures.push("expectedReads: a nonempty route contract is required.");
  } else {
    const endpoints = new Set<string>();
    for (const expected of evidence.expectedReads) {
      if (!expected || typeof expected.endpoint !== "string" || !expected.endpoint.trim() || endpoints.has(expected.endpoint)) {
        failures.push("expectedReads: endpoints must be nonempty and unique.");
        continue;
      }
      endpoints.add(expected.endpoint);
      const summaries = Array.isArray(evidence.requests) ? evidence.requests.filter((summary) => summary?.endpoint === expected.endpoint) : [];
      if (summaries.length !== 1) failures.push(`requests: expected exactly one summary for ${expected.endpoint}.`);
      else exactCount(expected.endpoint, summaries[0].requests, expected.requests);
    }
    if (Array.isArray(evidence.requests) && evidence.requests.some((summary) => summary && !endpoints.has(summary.endpoint))) {
      failures.push("requests: contains an unexpected endpoint.");
    }
  }
  successfulSummary("writes", evidence.writes);
  exactCount("writes", evidence.writes?.requests, evidence.expectedWrites);
  exactCount("durableWrites", evidence.durableWrites, evidence.expectedWrites);
  if (evidence.unexpectedStreamClosures !== 0) {
    failures.push(`unexpectedStreamClosures: expected zero, measured ${evidence.unexpectedStreamClosures}.`);
  }

  const ceilings = evidence.p95CeilingsMs;
  if (ceilings !== undefined) {
    for (const [name, value] of Object.entries(ceilings)) {
      if (!Number.isFinite(value) || value <= 0) failures.push(`p95CeilingsMs.${name}: must be a positive finite number.`);
    }
    if (failures.every((failure) => !failure.startsWith("p95CeilingsMs"))) {
      const check = (label: string, summary: PerfSummary | undefined, ceiling: number): void => {
        if (summary && Number.isFinite(summary.p95Ms) && summary.p95Ms > ceiling) {
          failures.push(`${label}: p95 ${summary.p95Ms} ms exceeds the ceiling of ${ceiling} ms.`);
        }
      };
      if (Array.isArray(evidence.requests)) {
        for (const summary of evidence.requests) check(summary?.endpoint ?? "request", summary, summary?.endpoint?.includes("/search") ? ceilings.search : ceilings.read);
      }
      check("writes", evidence.writes, ceilings.write);
    }
  }

  return {
    pass: failures.length === 0,
    failures,
    timingPolicy: ceilings === undefined
      ? "Latency is informational in CI; timings must be finite and nonnegative, with no hard timing or regression thresholds."
      : `Latency has absolute p95 ceilings (read ${ceilings.read} ms, search ${ceilings.search} ms, write ${ceilings.write} ms) set above the PRD targets to catch gross regressions; there is no relative regression threshold.`
  };
}
