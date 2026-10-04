import { describe, expect, it, vi } from "vitest";
import type { StateStore, StoreState } from "../domain/models";
import { createDemoState } from "../store/fixtures";
import { MemoryStore } from "../store/memory-store";
import {
  createRuntimeRetentionSchedule,
  runScheduledRuntimeRetention,
  runtimeRetentionIntervalMs
} from "./runtime-retention-job";

function storeWithExpiredSession(): MemoryStore {
  const state = createDemoState("retention-job-password");
  const expired = { ...state.sessions[0]!, id: "expired", expiresAt: "2026-09-01T12:00:00.000Z" };
  const live = { ...state.sessions[0]!, id: "live", expiresAt: "2026-10-03T12:00:00.000Z" };
  return new MemoryStore({ ...state, sessions: [expired, live] } satisfies StoreState);
}

describe("scheduled runtime retention", () => {
  it("uses the wall clock when no schedule options are supplied", async () => {
    const store = storeWithExpiredSession();
    const schedule = createRuntimeRetentionSchedule();

    // Without an injected clock the schedule still fires once and then waits a
    // full cadence, which is what the worker relies on.
    await expect(runScheduledRuntimeRetention(store, schedule)).resolves.toBe(true);
    await expect(runScheduledRuntimeRetention(store, schedule)).resolves.toBe(false);
  });

  it("bounds the interval and rejects hostile configuration", () => {
    expect(runtimeRetentionIntervalMs({})).toBe(3_600_000);
    expect(runtimeRetentionIntervalMs({ RUNTIME_RETENTION_INTERVAL_MS: "not-a-number" })).toBe(3_600_000);
    expect(runtimeRetentionIntervalMs({ RUNTIME_RETENTION_INTERVAL_MS: "-5" })).toBe(3_600_000);
    expect(runtimeRetentionIntervalMs({ RUNTIME_RETENTION_INTERVAL_MS: "1" })).toBe(60_000);
    expect(runtimeRetentionIntervalMs({ RUNTIME_RETENTION_INTERVAL_MS: "999999999" })).toBe(86_400_000);
  });

  it("runs on the first cycle and then only after the cadence", async () => {
    const store = storeWithExpiredSession();
    const compactSpy = vi.spyOn(store, "compactRuntimeState");
    const schedule = createRuntimeRetentionSchedule(60_000);
    let nowMs = Date.parse("2026-10-02T12:00:00.000Z");
    const now = () => nowMs;

    await expect(runScheduledRuntimeRetention(store, schedule, { now })).resolves.toBe(true);
    expect(compactSpy).toHaveBeenCalledTimes(1);

    nowMs += 30_000;
    await expect(runScheduledRuntimeRetention(store, schedule, { now })).resolves.toBe(false);
    expect(compactSpy).toHaveBeenCalledTimes(1);

    nowMs += 31_000;
    await expect(runScheduledRuntimeRetention(store, schedule, { now })).resolves.toBe(true);
    expect(compactSpy).toHaveBeenCalledTimes(2);
    expect(store.getState().sessions.map((session) => session.id)).toEqual(["live"]);
  });

  it("retries on the next cadence instead of every cycle after a failure", async () => {
    const store = storeWithExpiredSession();
    const schedule = createRuntimeRetentionSchedule(60_000);
    const failure = new Error("database unavailable");
    const compactSpy = vi.spyOn(store, "compactRuntimeState").mockRejectedValue(failure);
    let nowMs = Date.parse("2026-10-02T12:00:00.000Z");

    await expect(runScheduledRuntimeRetention(store, schedule, { now: () => nowMs }))
      .rejects.toThrow("database unavailable");
    expect(compactSpy).toHaveBeenCalledTimes(1);

    nowMs += 1_000;
    await expect(runScheduledRuntimeRetention(store, schedule, { now: () => nowMs }))
      .resolves.toBe(false);

    nowMs += 60_000;
    await expect(runScheduledRuntimeRetention(store, schedule, { now: () => nowMs }))
      .rejects.toThrow("database unavailable");
    expect(compactSpy).toHaveBeenCalledTimes(2);
  });

  it("runs against any StateStore implementation", async () => {
    const base = storeWithExpiredSession();
    const store: StateStore = base;
    const schedule = createRuntimeRetentionSchedule(60_000);

    await expect(runScheduledRuntimeRetention(store, schedule, { now: () => Date.parse("2026-10-02T12:00:00.000Z") }))
      .resolves.toBe(true);
    expect(base.getState().sessions.map((session) => session.id)).toEqual(["live"]);
  });
});