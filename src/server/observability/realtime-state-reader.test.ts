import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { StateStore } from "../domain/models";
import { createDemoState } from "../store/fixtures";
import { MemoryStore } from "../store/memory-store";
import { renderPrometheus, resetMetrics } from "./metrics";
import {
  createSharedRealtimeStateReader,
  resetSharedRealtimeStateReaders,
  sharedRealtimeStateReader
} from "./realtime-state-reader";

function countingStore(): { store: StateStore; reads: () => number } {
  const backing = new MemoryStore(createDemoState("realtime-reader-password"));
  let reads = 0;
  const store: StateStore = {
    getState: backing.getState.bind(backing),
    readState: backing.readState.bind(backing),
    readStateSnapshot: backing.readStateSnapshot.bind(backing),
    readRealtimeSnapshot: async (limit) => {
      reads += 1;
      return backing.readRealtimeSnapshot(limit);
    },
    readOutbox: backing.readOutbox.bind(backing),
    readOutboxMetrics: backing.readOutboxMetrics.bind(backing),
    outboxTransaction: backing.outboxTransaction.bind(backing),
    readStateVersion: backing.readStateVersion.bind(backing),
    readAuditEvents: backing.readAuditEvents.bind(backing),
    readAuditActors: backing.readAuditActors.bind(backing),
    readAuditMetrics: backing.readAuditMetrics.bind(backing),
    readAuthorizationSnapshot: backing.readAuthorizationSnapshot.bind(backing),
    readSessionActivity: backing.readSessionActivity.bind(backing),
    touchSessionActivity: backing.touchSessionActivity.bind(backing),
    compactRuntimeState: backing.compactRuntimeState.bind(backing),
    transaction: backing.transaction.bind(backing)
  };
  return { store, reads: () => reads };
}

describe("shared realtime state reader", () => {
  beforeEach(() => {
    resetSharedRealtimeStateReaders();
    resetMetrics();
    delete process.env.REALTIME_SHARED_READ_MIN_INTERVAL_MS;
    delete process.env.REALTIME_SHARED_NOTIFY_DEBOUNCE_MS;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    resetSharedRealtimeStateReaders();
    delete process.env.REALTIME_SHARED_READ_MIN_INTERVAL_MS;
    delete process.env.REALTIME_SHARED_NOTIFY_DEBOUNCE_MS;
  });

  it("serves one aggregate read per cadence and collapses concurrent callers", async () => {
    const { store, reads } = countingStore();
    const realtimeRead = vi.spyOn(store, "readRealtimeSnapshot");
    const genericRead = vi.spyOn(store, "readStateSnapshot");
    let nowMs = 1_000;
    const reader = createSharedRealtimeStateReader(store, { minFullReadIntervalMs: 1_000, now: () => nowMs });

    const [first, second] = await Promise.all([reader.read(), reader.read()]);
    expect(first).toBe(second);
    expect(reads()).toBe(1);
    expect(first.version).toBeGreaterThanOrEqual(1);

    nowMs += 500;
    await reader.read("poll");
    expect(reads()).toBe(1);

    nowMs += 600;
    await reader.read("poll");
    expect(reads()).toBe(2);
    expect(reader.fullReadCount()).toBe(2);

    // A wake-up reads immediately: a committed mutation must become visible.
    await reader.read("notify");
    expect(reads()).toBe(3);

    reader.reset();
    expect(reader.fullReadCount()).toBe(0);
    await reader.read();
    expect(reads()).toBe(4);
    expect(realtimeRead.mock.calls).toEqual([[100], [100], [100], [100]]);
    expect(genericRead).not.toHaveBeenCalled();
  });

  it("bounds wake-up reads with the configured debounce", async () => {
    const { store, reads } = countingStore();
    let nowMs = 0;
    const reader = createSharedRealtimeStateReader(store, { minFullReadIntervalMs: 60_000, notifyDebounceMs: 250, now: () => nowMs });

    await reader.read("notify");
    nowMs += 100;
    await reader.read("notify");
    expect(reads()).toBe(1);

    nowMs += 200;
    await reader.read("notify");
    expect(reads()).toBe(2);
  });

  it("counts completed aggregate reads in telemetry rather than shared-cache requests", async () => {
    const { store, reads } = countingStore();
    let nowMs = 0;
    const reader = createSharedRealtimeStateReader(store, { minFullReadIntervalMs: 1_000, now: () => nowMs });
    await Promise.all(Array.from({ length: 100 }, () => reader.read()));
    await Promise.all(Array.from({ length: 100 }, () => reader.read()));
    expect(reads()).toBe(1);
    expect(renderPrometheus()).toContain('cvg_realtime_shared_reads_total{mode="stream"} 1\n');
    nowMs = 1_001;
    await reader.read();
    expect(reads()).toBe(2);
    expect(renderPrometheus()).toContain('cvg_realtime_shared_reads_total{mode="stream"} 2\n');
  });

  it("keeps one reader per store and rebuilds it on reset", async () => {
    const { store } = countingStore();

    const first = sharedRealtimeStateReader(store);
    expect(sharedRealtimeStateReader(store)).toBe(first);

    resetSharedRealtimeStateReaders();
    const second = sharedRealtimeStateReader(store);
    expect(second).not.toBe(first);
  });

  it("reads configured cadences and clamps hostile values", async () => {
    process.env.REALTIME_SHARED_READ_MIN_INTERVAL_MS = "not-a-number";
    process.env.REALTIME_SHARED_NOTIFY_DEBOUNCE_MS = "0";
    const { store, reads } = countingStore();
    let nowMs = 0;
    const reader = createSharedRealtimeStateReader(store, { now: () => nowMs });

    await reader.read();
    nowMs += 999;
    await reader.read();
    expect(reads()).toBe(1);
    nowMs += 2;
    await reader.read();
    expect(reads()).toBe(2);

    process.env.REALTIME_SHARED_READ_MIN_INTERVAL_MS = "5";
    const clamped = createSharedRealtimeStateReader(store, { now: () => nowMs });
    nowMs += 101;
    await clamped.read();
    expect(reads()).toBe(3);

    process.env.REALTIME_SHARED_NOTIFY_DEBOUNCE_MS = "999999";
    const debounced = createSharedRealtimeStateReader(store, { notifyDebounceMs: 999_999, now: () => nowMs });
    await debounced.read("notify");
    expect(reads()).toBe(4);
  });

  it("propagates a failed read without caching a partial snapshot", async () => {
    const backing = new MemoryStore(createDemoState("realtime-reader-failure-password"));
    const realtimeRead = vi.spyOn(backing, "readRealtimeSnapshot")
      .mockRejectedValueOnce(new Error("database unavailable"))
      .mockRejectedValueOnce(new Error("database unavailable"));
    const reader = createSharedRealtimeStateReader(backing);

    await expect(reader.read()).rejects.toThrow("database unavailable");
    expect(reader.fullReadCount()).toBe(0);
    await expect(reader.read()).rejects.toThrow("database unavailable");
    expect(reader.fullReadCount()).toBe(0);
    expect(renderPrometheus()).not.toContain('cvg_realtime_shared_reads_total{mode="stream"}');
    const recovered = await reader.read();
    expect(recovered.version).toBe(await backing.readStateVersion());
    expect(reader.fullReadCount()).toBe(1);
    expect(realtimeRead.mock.calls).toEqual([[100], [100], [100]]);
    expect(renderPrometheus()).toContain('cvg_realtime_shared_reads_total{mode="stream"} 1\n');
  });
});
