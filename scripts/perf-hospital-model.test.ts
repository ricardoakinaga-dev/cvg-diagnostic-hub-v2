import assert from "node:assert/strict";
import test from "node:test";
import {
  d2PeakJourneysPerSecond, headroom, integrityHolds, isError, kindP95, levelVerdict, poissonArrivals, seededRandom, soakVerdict, summarizeOperations,
  type LevelVerdict, type OperationSample, type SoakWindow
} from "./perf-hospital-model";

const sample = (operation: string, kind: OperationSample["kind"], durationMs: number, status = 200, errorCode?: string): OperationSample =>
  ({ operation, kind, durationMs, status, startedAtMs: 0, ...(errorCode ? { errorCode } : {}) });

test("derives the D2 peak hour from exams a day, operating hours and the peak factor", () => {
  // 150 exams over 12 hours, the busiest hour three times the average: 37.5 journeys an hour.
  assert.ok(Math.abs(d2PeakJourneysPerSecond({ examsPerDay: 150, operatingHours: 12, peakFactor: 3, examsPerJourney: 1 }) * 3600 - 37.5) < 1e-9);
  assert.ok(Math.abs(d2PeakJourneysPerSecond({ examsPerDay: 150, operatingHours: 24, peakFactor: 1, examsPerJourney: 2 }) * 3600 - 3.125) < 1e-9);
  assert.throws(() => d2PeakJourneysPerSecond({ examsPerDay: 0, operatingHours: 12, peakFactor: 3, examsPerJourney: 1 }), /HOSPITAL_LOAD_INVALID_EXAMSPERDAY/);
  assert.throws(() => d2PeakJourneysPerSecond({ examsPerDay: 150, operatingHours: 25, peakFactor: 3, examsPerJourney: 1 }), /HOSPITAL_LOAD_INVALID_OPERATINGHOURS/);
});

test("replays the same Poisson arrivals for the same seed, near the requested rate, always at least one", () => {
  const first = poissonArrivals(2, 600_000, seededRandom(7));
  assert.deepEqual(poissonArrivals(2, 600_000, seededRandom(7)), first);
  assert.ok(first.length > 1_100 && first.length < 1_300, String(first.length));
  assert.ok(first.every((offset, index) => offset >= 0 && offset < 600_000 && (index === 0 || offset >= first[index - 1]!)));
  assert.deepEqual(poissonArrivals(0.0001, 1_000, seededRandom(1)), [0]);
  assert.throws(() => poissonArrivals(0, 1_000, seededRandom(1)), /HOSPITAL_LOAD_INVALID_ARRIVALS/);
});

test("summarizes each operation with its error codes and treats transport failures as errors", () => {
  const summaries = summarizeOperations([
    sample("POST create request", "write", 30), sample("POST create request", "write", 90, 503, "NOT_READY"), sample("POST create request", "write", 10, 0),
    sample("GET dashboard", "read", 20)
  ]);
  assert.deepEqual(summaries.map((entry) => entry.operation), ["GET dashboard", "POST create request"]);
  assert.deepEqual(summaries[1], { operation: "POST create request", kind: "write", requests: 3, errors: 2, p50Ms: 30, p95Ms: 90, p99Ms: 90, maxMs: 90, errorCodes: { NOT_READY: 1, TRANSPORT: 1 } });
  assert.equal(isError({ status: 409 }), true);
  assert.equal(isError({ status: 201 }), false);
  // The p95 a target is checked against only looks at answered requests of that kind.
  assert.equal(kindP95([sample("a", "write", 30), sample("a", "write", 5_000, 0), sample("b", "read", 999)], "write"), 30);
});

test("judges each level against the targets and takes the headroom up to the first level that misses them", () => {
  const targets = { readP95Ms: 500, writeP95Ms: 800, maxErrorRate: 0.01 };
  assert.deepEqual(levelVerdict(10, [sample("r", "read", 100), sample("w", "write", 200)], 2_000, targets),
    { multiple: 10, readP95Ms: 100, writeP95Ms: 200, writesPerSecond: 0.5, errorRate: 0, withinTargets: true });
  assert.equal(levelVerdict(50, [sample("w", "write", 900)], 1_000, targets).withinTargets, false);
  const failing = levelVerdict(50, [sample("w", "write", 100), sample("w", "write", 100, 500)], 1_000, targets);
  assert.equal(failing.errorRate, 0.5);
  assert.equal(failing.withinTargets, false);
  const level = (multiple: number, withinTargets: boolean): LevelVerdict => ({ multiple, readP95Ms: 0, writeP95Ms: 0, writesPerSecond: 0, errorRate: 0, withinTargets });
  assert.equal(headroom([level(25, true), level(1, true), level(10, true), level(50, false)]), 25);
  // Passing again above a failing level does not raise the headroom.
  assert.equal(headroom([level(1, true), level(10, false), level(25, true)]), 1);
  assert.equal(headroom([level(1, false)]), 0);
});

test("calls a soak stable only without latency drift, memory growth or errors", () => {
  const window = (minute: number, overrides: Partial<SoakWindow> = {}): SoakWindow => ({ minute, readP95Ms: 100, writeP95Ms: 200, errors: 0, requests: 100, rssBytes: 500_000_000, ...overrides });
  const limits = { maxDrift: 1.5, maxRssGrowthBytesPerHour: 200 * 1024 * 1024, maxErrorRate: 0.01 };
  const flat = Array.from({ length: 60 }, (_, minute) => window(minute));
  assert.deepEqual(soakVerdict(flat, limits), { windows: 60, readDrift: 1, writeDrift: 1, rssGrowthBytesPerHour: 0, errorRate: 0, stable: true });
  const slower = soakVerdict(Array.from({ length: 60 }, (_, minute) => window(minute, { writeP95Ms: minute < 20 ? 200 : 400 })), limits);
  assert.equal(slower.writeDrift, 2);
  assert.equal(slower.stable, false);
  // 10 MB a minute is 600 MB an hour: a leak.
  const leaking = soakVerdict(Array.from({ length: 60 }, (_, minute) => window(minute, { rssBytes: 500_000_000 + minute * 10_000_000 })), limits);
  assert.equal(leaking.rssGrowthBytesPerHour, 600_000_000);
  assert.equal(leaking.stable, false);
  const erring = soakVerdict(flat.map((entry) => ({ ...entry, errors: 5 })), limits);
  assert.equal(erring.errorRate, 0.05);
  assert.equal(erring.stable, false);
  assert.throws(() => soakVerdict(flat.slice(0, 2), limits), /HOSPITAL_SOAK_TOO_SHORT/);
});

test("holds integrity only when every acknowledged write is durable, single and delivered once", () => {
  const sound = { acknowledgedRequests: 10, durableRequests: 10, duplicatedRequests: 0, releasedResults: 8, deliveredNotifications: 8, duplicatedDeliveries: 0 };
  assert.equal(integrityHolds(sound), true);
  for (const broken of [{ durableRequests: 9 }, { duplicatedRequests: 1 }, { deliveredNotifications: 7 }, { duplicatedDeliveries: 1 }]) {
    assert.equal(integrityHolds({ ...sound, ...broken }), false, JSON.stringify(broken));
  }
});
