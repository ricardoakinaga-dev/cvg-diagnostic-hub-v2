import { percentile, round } from "./perf-report";

/**
 * Pure pieces of the hospital load benchmark (scripts/perf-hospital.ts): the arrival rate derived from D2, a
 * seeded arrival schedule, per-window summaries and the verdicts. Kept apart so they are unit-tested without a
 * database or a server.
 */

export interface D2Rate {
  /** D2: up to 150 exams a day. */
  readonly examsPerDay: number;
  /** Hours a day in which almost every request is made (the night shift is quieter). */
  readonly operatingHours: number;
  /** How much busier the busiest hour is than the average operating hour. */
  readonly peakFactor: number;
  /** Exams per request in the journeys the benchmark replays (one per journey). */
  readonly examsPerJourney: number;
}

/** Journeys per second in the D2 peak hour: the unit of the load levels (1 = the D2 peak, 10 = ten times it). */
export function d2PeakJourneysPerSecond(rate: D2Rate): number {
  for (const [name, value] of Object.entries(rate)) {
    if (!Number.isFinite(value) || value <= 0) throw new Error(`HOSPITAL_LOAD_INVALID_${name.toUpperCase()}`);
  }
  if (rate.operatingHours > 24) throw new Error("HOSPITAL_LOAD_INVALID_OPERATINGHOURS");
  return (rate.examsPerDay / rate.examsPerJourney / rate.operatingHours) * rate.peakFactor / 3600;
}

/** Deterministic PRNG, so two runs with the same seed replay the same arrivals. */
export function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Poisson arrivals (exponential gaps) at `perSecond` over `durationMs`, as offsets from the start. At least one
 * arrival is returned so that a low level still measures something.
 */
export function poissonArrivals(perSecond: number, durationMs: number, random: () => number): number[] {
  if (!(perSecond > 0) || !(durationMs > 0)) throw new Error("HOSPITAL_LOAD_INVALID_ARRIVALS");
  const arrivals: number[] = [];
  let at = 0;
  for (;;) {
    at += (-Math.log(1 - random()) / perSecond) * 1000;
    if (at >= durationMs) break;
    arrivals.push(round(at));
  }
  return arrivals.length > 0 ? arrivals : [0];
}

export interface OperationSample {
  readonly operation: string;
  readonly kind: "read" | "write";
  readonly status: number;
  readonly durationMs: number;
  /** Milliseconds since the benchmark started. */
  readonly startedAtMs: number;
  readonly errorCode?: string;
}

export interface OperationSummary {
  readonly operation: string;
  readonly kind: "read" | "write";
  readonly requests: number;
  readonly errors: number;
  readonly p50Ms: number;
  readonly p95Ms: number;
  readonly p99Ms: number;
  readonly maxMs: number;
  readonly errorCodes: Record<string, number>;
}

/** A response is an error when it is not 2xx; status 0 is a transport failure (refused, reset, timeout). */
export function isError(sample: Pick<OperationSample, "status">): boolean {
  return sample.status < 200 || sample.status >= 300;
}

export function summarizeOperations(samples: readonly OperationSample[]): OperationSummary[] {
  const groups = new Map<string, OperationSample[]>();
  for (const sample of samples) groups.set(sample.operation, [...(groups.get(sample.operation) ?? []), sample]);
  return [...groups.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([operation, entries]) => {
    const durations = entries.map((entry) => entry.durationMs).sort((left, right) => left - right);
    const errors = entries.filter(isError);
    const errorCodes: Record<string, number> = {};
    for (const error of errors) {
      const code = error.errorCode ?? (error.status === 0 ? "TRANSPORT" : `HTTP_${error.status}`);
      errorCodes[code] = (errorCodes[code] ?? 0) + 1;
    }
    return {
      operation, kind: entries[0]!.kind, requests: entries.length, errors: errors.length,
      p50Ms: percentile(durations, 0.5), p95Ms: percentile(durations, 0.95), p99Ms: percentile(durations, 0.99), maxMs: durations.at(-1) ?? 0, errorCodes
    };
  });
}

/** Overall p95 of one kind of operation (all writes, or all reads), the figure the PRD targets apply to. */
export function kindP95(samples: readonly OperationSample[], kind: OperationSample["kind"]): number {
  return percentile(samples.filter((sample) => sample.kind === kind && !isError(sample)).map((sample) => sample.durationMs).sort((left, right) => left - right), 0.95);
}

export interface LevelTargets {
  readonly readP95Ms: number;
  readonly writeP95Ms: number;
  /** Errors allowed at a level, as a fraction of its requests (conflicts of concurrent users included). */
  readonly maxErrorRate: number;
}

export interface LevelVerdict {
  readonly multiple: number;
  readonly readP95Ms: number;
  readonly writeP95Ms: number;
  readonly writesPerSecond: number;
  readonly errorRate: number;
  readonly withinTargets: boolean;
}

export function levelVerdict(multiple: number, samples: readonly OperationSample[], durationMs: number, targets: LevelTargets): LevelVerdict {
  const readP95Ms = kindP95(samples, "read");
  const writeP95Ms = kindP95(samples, "write");
  const writes = samples.filter((sample) => sample.kind === "write" && !isError(sample)).length;
  const errorRate = samples.length === 0 ? 0 : samples.filter(isError).length / samples.length;
  return {
    multiple, readP95Ms, writeP95Ms, writesPerSecond: round(writes / Math.max(0.001, durationMs / 1000)), errorRate: round(errorRate),
    withinTargets: readP95Ms <= targets.readP95Ms && writeP95Ms <= targets.writeP95Ms && errorRate <= targets.maxErrorRate
  };
}

/**
 * The headroom over D2: the highest level whose p95 stayed within the targets, with every lower level also
 * within them (a level that only passes after a failing one does not count).
 */
export function headroom(levels: readonly LevelVerdict[]): number {
  let highest = 0;
  for (const level of [...levels].sort((left, right) => left.multiple - right.multiple)) {
    if (!level.withinTargets) break;
    highest = level.multiple;
  }
  return highest;
}

export interface SoakWindow {
  readonly minute: number;
  readonly readP95Ms: number;
  readonly writeP95Ms: number;
  readonly errors: number;
  readonly requests: number;
  readonly rssBytes?: number;
  readonly databaseBytes?: number;
}

export interface SoakVerdict {
  readonly windows: number;
  /** Last-third p95 over first-third p95 (1 = no drift). */
  readonly readDrift: number;
  readonly writeDrift: number;
  /** Resident memory growth per hour, from a least-squares line over the windows. */
  readonly rssGrowthBytesPerHour: number;
  readonly errorRate: number;
  readonly stable: boolean;
}

/** Stable = latency did not drift beyond `maxDrift`, memory growth stayed under `maxRssGrowthPerHour`, few errors. */
export function soakVerdict(windows: readonly SoakWindow[], limits: { maxDrift: number; maxRssGrowthBytesPerHour: number; maxErrorRate: number }): SoakVerdict {
  if (windows.length < 3) throw new Error("HOSPITAL_SOAK_TOO_SHORT: at least three windows");
  const third = Math.max(1, Math.floor(windows.length / 3));
  const mean = (values: number[]) => values.reduce((sum, value) => sum + value, 0) / Math.max(1, values.length);
  const drift = (pick: (window: SoakWindow) => number) => {
    const first = mean(windows.slice(0, third).map(pick));
    const last = mean(windows.slice(-third).map(pick));
    return first > 0 ? round(last / first) : 1;
  };
  const memory = windows.filter((window) => window.rssBytes !== undefined) as Array<SoakWindow & { rssBytes: number }>;
  const rssGrowthBytesPerHour = memory.length >= 2 ? Math.round(slope(memory.map((window) => [window.minute, window.rssBytes])) * 60) : 0;
  const requests = windows.reduce((sum, window) => sum + window.requests, 0);
  const errorRate = round(windows.reduce((sum, window) => sum + window.errors, 0) / Math.max(1, requests));
  const readDrift = drift((window) => window.readP95Ms);
  const writeDrift = drift((window) => window.writeP95Ms);
  return {
    windows: windows.length, readDrift, writeDrift, rssGrowthBytesPerHour, errorRate,
    stable: readDrift <= limits.maxDrift && writeDrift <= limits.maxDrift && rssGrowthBytesPerHour <= limits.maxRssGrowthBytesPerHour && errorRate <= limits.maxErrorRate
  };
}

function slope(points: Array<[number, number]>): number {
  const n = points.length;
  const meanX = points.reduce((sum, [x]) => sum + x, 0) / n;
  const meanY = points.reduce((sum, [, y]) => sum + y, 0) / n;
  const numerator = points.reduce((sum, [x, y]) => sum + (x - meanX) * (y - meanY), 0);
  const denominator = points.reduce((sum, [x]) => sum + (x - meanX) ** 2, 0);
  return denominator === 0 ? 0 : numerator / denominator;
}

export interface FaultOutcome {
  readonly fault: "app" | "worker" | "postgres";
  /** From the fault to the first successful request (the worker: to the first delivery after it). */
  readonly recoveryMs: number;
  readonly failedDuringOutage: number;
}

export interface IntegrityCheck {
  /** Journeys whose creation was acknowledged (2xx) at least once, possibly after retries. */
  readonly acknowledgedRequests: number;
  /** Of those, how many exist in the database after the run. */
  readonly durableRequests: number;
  /** Patients with more than one request: a retried creation that was applied twice. */
  readonly duplicatedRequests: number;
  readonly releasedResults: number;
  /** Released results whose requester notification ended DELIVERED or ACKNOWLEDGED. */
  readonly deliveredNotifications: number;
  /** Notifications with more than one delivery row. */
  readonly duplicatedDeliveries: number;
}

export function integrityHolds(check: IntegrityCheck): boolean {
  return check.durableRequests === check.acknowledgedRequests && check.duplicatedRequests === 0
    && check.deliveredNotifications === check.releasedResults && check.duplicatedDeliveries === 0;
}
