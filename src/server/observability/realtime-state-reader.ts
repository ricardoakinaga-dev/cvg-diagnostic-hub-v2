import type { StateStore, StoreState } from "../domain/models";
import { recordRealtimeSharedRead } from "./metrics";

const REALTIME_SHARED_READ_DEFAULT_MIN_INTERVAL_MS = 1_000;
const REALTIME_SHARED_READ_MIN_MINIMUM_MS = 100;
const REALTIME_SHARED_READ_MAX_INTERVAL_MS = 60_000;
/**
 * Wake-up reads are not debounced by default: a committed mutation must become
 * visible to an open stream, and coalescing already happens through the shared
 * in-flight read. The debounce exists as an operator control for write bursts,
 * not as a correctness requirement.
 */
const REALTIME_SHARED_NOTIFY_DEFAULT_DEBOUNCE_MS = 0;
const REALTIME_SHARED_NOTIFY_MAX_DEBOUNCE_MS = 10_000;

/**
 * Why a read was requested.
 *
 * - `poll` is the steady-state cost and obeys the full cadence.
 * - `notify` exists so a committed mutation is visible quickly.
 * - `fresh` is a new subscription, including a reconnect carrying
 *   Last-Event-ID: it must never be answered from a snapshot taken before the
 *   client reconnected, or the replay window would report "nothing new" for
 *   events that did happen.
 */
export type RealtimeReadTrigger = "poll" | "notify" | "fresh";

export interface RealtimeStateSnapshot {
  readonly state: StoreState;
  /**
   * Version of the runtime state row this aggregate was read at. One statement
   * produced both values, so an unchanged version proves that no write
   * committed between the aggregate read and the authorization recheck.
   */
  readonly version: number;
  readonly readAtMs: number;
}

export interface SharedRealtimeStateReader {
  read(trigger?: RealtimeReadTrigger): Promise<RealtimeStateSnapshot>;
  /** Full aggregate reads performed by this reader; the PROD-104 budget. */
  fullReadCount(): number;
  reset(): void;
}

export interface SharedRealtimeStateReaderOptions {
  readonly minFullReadIntervalMs?: number;
  readonly notifyDebounceMs?: number;
  readonly now?: () => number;
}

/**
 * One reader per store per process.
 *
 * Every SSE connection used to read the whole aggregate on its own interval,
 * so N connections meant N full reads per tick on the same serial queue, plus
 * an authorization read each (finding F-02 / review A-04). Connections now
 * share one cadence: at most one full aggregate read per
 * REALTIME_SHARED_READ_MIN_INTERVAL_MS per process, whatever the connection
 * count, and authorization is revalidated with an integer version read that
 * expands no JSONB.
 *
 * The cadence is deliberately not bypassable. A connection that detects a
 * newer version therefore enqueues from data at most one cadence old, which
 * bounds how long a revocation can take to reach an open stream. Making that
 * window explicit is the point: the alternative, reading per connection, is
 * what saturated the process in the first place.
 */
export function createSharedRealtimeStateReader(
  store: StateStore,
  options: SharedRealtimeStateReaderOptions = {}
): SharedRealtimeStateReader {
  const now = options.now ?? (() => Date.now());
  const minIntervalMs = boundedInterval(options.minFullReadIntervalMs ?? configuredMinInterval());
  const notifyDebounceMs = boundedDebounce(options.notifyDebounceMs ?? configuredNotifyDebounce());
  let cached: RealtimeStateSnapshot | undefined;
  let inFlight: Promise<RealtimeStateSnapshot> | undefined;
  let fullReads = 0;
  let lastFullReadAtMs = Number.NEGATIVE_INFINITY;

  const performRead = async (): Promise<RealtimeStateSnapshot> => {
    // Share the maximum replay tail; each stream applies its configured window.
    const { state, version } = await store.readRealtimeSnapshot(100);
    fullReads += 1;
    recordRealtimeSharedRead("stream");
    lastFullReadAtMs = now();
    cached = { state, version, readAtMs: lastFullReadAtMs };
    return cached;
  };

  return {
    async read(trigger: RealtimeReadTrigger = "poll") {
      const current = cached;
      const budgetMs = trigger === "poll" ? minIntervalMs : notifyDebounceMs;
      if (current && now() - current.readAtMs < budgetMs) return current;
      // Concurrent callers collapse onto the read already in flight, so a
      // wake-up storm produces one aggregate read rather than one per stream.
      if (inFlight) return inFlight;
      const pending = performRead();
      inFlight = pending;
      try {
        return await pending;
      } finally {
        inFlight = undefined;
      }
    },
    fullReadCount: () => fullReads,
    reset() {
      cached = undefined;
      inFlight = undefined;
      fullReads = 0;
      lastFullReadAtMs = Number.NEGATIVE_INFINITY;
    }
  };
}

let readerRegistry = new WeakMap<StateStore, SharedRealtimeStateReader>();

/** Returns the process-wide reader for a store, creating it on first use. */
export function sharedRealtimeStateReader(store: StateStore): SharedRealtimeStateReader {
  const existing = readerRegistry.get(store);
  if (existing) return existing;
  const created = createSharedRealtimeStateReader(store);
  readerRegistry.set(store, created);
  return created;
}

/**
 * Drops every registered reader. Suites that reuse one store across cases call
 * this so a cached aggregate from an earlier case cannot satisfy a later one.
 */
export function resetSharedRealtimeStateReaders(): void {
  readerRegistry = new WeakMap<StateStore, SharedRealtimeStateReader>();
}

function configuredMinInterval(): number {
  const parsed = Number(process.env.REALTIME_SHARED_READ_MIN_INTERVAL_MS);
  return boundedInterval(Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined);
}

function configuredNotifyDebounce(): number {
  const parsed = Number(process.env.REALTIME_SHARED_NOTIFY_DEBOUNCE_MS);
  return boundedDebounce(Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined);
}

function boundedDebounce(value: number | undefined): number {
  if (value === undefined) return REALTIME_SHARED_NOTIFY_DEFAULT_DEBOUNCE_MS;
  return Math.min(Math.max(value, 0), REALTIME_SHARED_NOTIFY_MAX_DEBOUNCE_MS);
}

function boundedInterval(value: number | undefined): number {
  if (value === undefined) return REALTIME_SHARED_READ_DEFAULT_MIN_INTERVAL_MS;
  return Math.min(Math.max(value, REALTIME_SHARED_READ_MIN_MINIMUM_MS), REALTIME_SHARED_READ_MAX_INTERVAL_MS);
}
