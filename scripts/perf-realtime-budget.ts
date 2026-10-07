import { performance } from "node:perf_hooks";
import type { StateStore, StoreState, User } from "../src/server/domain/models";
import { createDemoState } from "../src/server/store/fixtures";
import { MemoryStore } from "../src/server/store/memory-store";
import { createRealtimeResponse, type RealtimeAccessPolicy } from "../src/server/observability/realtime-stream";
import { resetSharedRealtimeStateReaders } from "../src/server/observability/realtime-state-reader";

export const REALTIME_BUDGET_BENCHMARK_VERSION = "prod-2026-10-realtime-budget-v1";
/** Reads per second the process may spend on the aggregate, per the cadence. */
export const REALTIME_MAX_STATE_READS_PER_SECOND = 1;

/**
 * Slows every aggregate read so the budget is measured in read *calls*, not in
 * CPU: with 100 connections and a five second tick, the pre-fix implementation
 * issued 40 reads per second against the serial queue.
 */
class InstrumentedMemoryStore extends MemoryStore {
  readCalls = 0;
  authorizationCalls = 0;

  override async readState(): Promise<StoreState> {
    this.readCalls += 1;
    return super.readState();
  }

  override async readStateSnapshot(): Promise<{ state: StoreState; version: number }> {
    this.readCalls += 1;
    return super.readStateSnapshot();
  }

  override async readAuthorizationSnapshot(query: { userId: string; sessionId?: string }) {
    this.authorizationCalls += 1;
    return super.readAuthorizationSnapshot(query);
  }
}

export interface RealtimeBudgetReport {
  readonly benchmark: string;
  readonly version: string;
  readonly connections: number;
  readonly windowMs: number;
  readonly stateReads: number;
  readonly authorizationReads: number;
  readonly stateReadsPerSecond: number;
  readonly budgetReadsPerSecond: number;
  /** Reads the configured cadence allows inside the measured window. */
  readonly budgetReadsInWindow: number;
  readonly pass: boolean;
  readonly limitations: readonly string[];
}

export interface RealtimeBudgetOptions {
  readonly connections?: number;
  readonly windowMs?: number;
  readonly pollIntervalMs?: number;
  readonly sharedReadMinIntervalMs?: number;
}

export async function measureRealtimeReadBudget(options: RealtimeBudgetOptions = {}): Promise<RealtimeBudgetReport> {
  const connections = options.connections ?? 100;
  const windowMs = options.windowMs ?? 6_000;
  const pollIntervalMs = options.pollIntervalMs ?? 5_000;
  const sharedReadMinIntervalMs = options.sharedReadMinIntervalMs ?? 1_000;
  const state = createDemoState("perf-realtime-budget-password");
  const store = new InstrumentedMemoryStore(state);
  const actor = state.users.find((user) => user.id === "user-vet");
  if (!actor) throw new Error("fixture actor missing");
  const accessPolicy: RealtimeAccessPolicy = {
    isAuthorized: () => true,
    eventVisible: () => true,
    authorizationError: () => new Error("authorization revoked")
  };

  const previousInterval = process.env.REALTIME_STREAM_INTERVAL_MS;
  const previousMaxConnections = process.env.REALTIME_MAX_CONNECTIONS;
  const previousSharedRead = process.env.REALTIME_SHARED_READ_MIN_INTERVAL_MS;
  process.env.REALTIME_STREAM_INTERVAL_MS = String(pollIntervalMs);
  process.env.REALTIME_MAX_CONNECTIONS = String(Math.max(connections, 1_000));
  process.env.REALTIME_SHARED_READ_MIN_INTERVAL_MS = String(sharedReadMinIntervalMs);
  resetSharedRealtimeStateReaders();

  const responses = [];
  try {
    for (let index = 0; index < connections; index += 1) {
      const controller = new AbortController();
      const response = await createRealtimeResponse(
        store,
        actor as User,
        `perf-${index}`,
        undefined,
        false,
        new Request("http://localhost/api/v1/realtime/events", { signal: controller.signal }),
        accessPolicy
      );
      responses.push({ controller, reader: response.body!.getReader() });
    }

    // Drain every connection so stream backpressure cannot end a poll loop and
    // quietly reduce the measured read count.
    const draining = responses.map(async ({ reader }) => {
      while (!(await reader.read()).done) {
        // discard frames
      }
    });

    // Count only the window itself: connection setup legitimately reads once
    // per burst and must not be charged to the steady-state budget.
    await new Promise((resolve) => setTimeout(resolve, 50));
    const readsAtWindowStart = store.readCalls;
    const startedAt = performance.now();
    await new Promise((resolve) => setTimeout(resolve, windowMs));
    const elapsedMs = Math.max(1, performance.now() - startedAt);
    const stateReads = store.readCalls - readsAtWindowStart;
    const budgetReadsInWindow = Math.ceil(elapsedMs / sharedReadMinIntervalMs) + 1;

    for (const { controller, reader } of responses) {
      controller.abort();
      await reader.cancel().catch(() => undefined);
    }
    await Promise.allSettled(draining);

    const stateReadsPerSecond = Number(((stateReads / elapsedMs) * 1_000).toFixed(2));
    return {
      benchmark: "PROD-104 realtime aggregate read budget",
      version: REALTIME_BUDGET_BENCHMARK_VERSION,
      connections,
      windowMs: elapsedMs,
      stateReads,
      authorizationReads: store.authorizationCalls,
      stateReadsPerSecond,
      budgetReadsPerSecond: REALTIME_MAX_STATE_READS_PER_SECOND,
      budgetReadsInWindow,
      pass: stateReads <= budgetReadsInWindow,
      limitations: [
        "Counts aggregate read calls in-process; it does not claim PostgreSQL latency, WAL cost or lock behaviour.",
        "Runs without HTTP framing or TLS, so it is a budget for the read path, not an end-to-end load test.",
        "Must be paired with the approved D2 volume and a staging PostgreSQL run before production acceptance."
      ]
    };
  } finally {
    if (previousInterval === undefined) delete process.env.REALTIME_STREAM_INTERVAL_MS;
    else process.env.REALTIME_STREAM_INTERVAL_MS = previousInterval;
    if (previousMaxConnections === undefined) delete process.env.REALTIME_MAX_CONNECTIONS;
    else process.env.REALTIME_MAX_CONNECTIONS = previousMaxConnections;
    if (previousSharedRead === undefined) delete process.env.REALTIME_SHARED_READ_MIN_INTERVAL_MS;
    else process.env.REALTIME_SHARED_READ_MIN_INTERVAL_MS = previousSharedRead;
  }
}

async function main(): Promise<void> {
  const report = await measureRealtimeReadBudget();
  console.log(JSON.stringify(report, null, 2));
  if (!report.pass) {
    console.error(`PERF_REALTIME_BUDGET_FAILED: ${report.stateReads} aggregate reads with ${report.connections} connections exceeds the ${report.budgetReadsInWindow} reads the shared cadence allows.`);
    process.exitCode = 1;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) void main();