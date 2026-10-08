import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { StateStore } from "./models";
import {
  DEFAULT_SESSION_ACTIVITY_TOUCH_INTERVAL_MS,
  DEFAULT_SESSION_IDLE_TIMEOUT_MS,
  renewSessionActivity,
  resetSessionActivityRenewals,
  sessionActivityTouchIntervalMs,
  sessionIdleTimeoutMs,
  sessionIsIdle,
  shouldTouchSessionActivity
} from "./session-activity";
import { createDemoState } from "../store/fixtures";
import { MemoryStore } from "../store/memory-store";

function storeRecordingTouches(): { store: StateStore; touches: { sessionId: string; userId: string; lastSeenAt: string }[] } {
  const touches: { sessionId: string; userId: string; lastSeenAt: string }[] = [];
  const backing = new MemoryStore(createDemoState("session-activity-domain-password"));
  const store: StateStore = {
    getState: backing.getState.bind(backing),
    readState: backing.readState.bind(backing),
    readStateSnapshot: backing.readStateSnapshot.bind(backing),
    readStateVersion: backing.readStateVersion.bind(backing),
    readAuditEvents: backing.readAuditEvents.bind(backing),
    readAuditActors: backing.readAuditActors.bind(backing),
    readAuditMetrics: backing.readAuditMetrics.bind(backing),
    readOutbox: backing.readOutbox.bind(backing),
    readOutboxMetrics: backing.readOutboxMetrics.bind(backing),
    readRealtimeSnapshot: backing.readRealtimeSnapshot.bind(backing),
    outboxTransaction: backing.outboxTransaction.bind(backing),
    readAuthorizationSnapshot: backing.readAuthorizationSnapshot.bind(backing),
    readSessionActivity: backing.readSessionActivity.bind(backing),
    touchSessionActivity: async (activity) => {
      touches.push({ ...activity });
      return backing.touchSessionActivity(activity);
    },
    compactRuntimeState: backing.compactRuntimeState.bind(backing),
    archiveClinicalRecords: backing.archiveClinicalRecords.bind(backing),
    readClinicalArchive: backing.readClinicalArchive.bind(backing),
    readArchivedRequest: backing.readArchivedRequest.bind(backing),
    purgeClinicalArchive: backing.purgeClinicalArchive.bind(backing),
    transaction: backing.transaction.bind(backing)
  };
  return { store, touches };
}

describe("session activity policy", () => {
  beforeEach(() => {
    resetSessionActivityRenewals();
  });

  afterEach(() => {
    resetSessionActivityRenewals();
    delete process.env.SESSION_IDLE_TIMEOUT_MS;
    delete process.env.SESSION_ACTIVITY_TOUCH_INTERVAL_MS;
    vi.useRealTimers();
  });

  it("resolves documented defaults and rejects hostile configuration", () => {
    expect(sessionIdleTimeoutMs({})).toBe(DEFAULT_SESSION_IDLE_TIMEOUT_MS);
    expect(sessionIdleTimeoutMs({ SESSION_IDLE_TIMEOUT_MS: "0" })).toBe(DEFAULT_SESSION_IDLE_TIMEOUT_MS);
    expect(sessionIdleTimeoutMs({ SESSION_IDLE_TIMEOUT_MS: "-1" })).toBe(DEFAULT_SESSION_IDLE_TIMEOUT_MS);
    expect(sessionIdleTimeoutMs({ SESSION_IDLE_TIMEOUT_MS: "nope" })).toBe(DEFAULT_SESSION_IDLE_TIMEOUT_MS);
    expect(sessionIdleTimeoutMs({ SESSION_IDLE_TIMEOUT_MS: "900000" })).toBe(900_000);
    expect(sessionActivityTouchIntervalMs({})).toBe(DEFAULT_SESSION_ACTIVITY_TOUCH_INTERVAL_MS);
    expect(sessionActivityTouchIntervalMs({ SESSION_ACTIVITY_TOUCH_INTERVAL_MS: "1.5" })).toBe(DEFAULT_SESSION_ACTIVITY_TOUCH_INTERVAL_MS);
    expect(sessionActivityTouchIntervalMs({ SESSION_ACTIVITY_TOUCH_INTERVAL_MS: "1000" })).toBe(1_000);
  });

  it("treats an unreadable liveness reference as idle", () => {
    const nowMs = Date.parse("2026-10-03T12:00:00.000Z");

    expect(sessionIsIdle("2026-10-03T11:59:00.000Z", nowMs)).toBe(false);
    expect(sessionIsIdle("2026-10-03T11:00:00.000Z", nowMs)).toBe(true);
    expect(sessionIsIdle("not-a-date", nowMs)).toBe(true);
    expect(sessionIsIdle("2026-10-03T11:59:00.000Z", nowMs, 1_000)).toBe(true);
  });

  it("refreshes only after the touch interval and fails safe on bad input", () => {
    const nowMs = Date.parse("2026-10-03T12:00:00.000Z");
    const activity = { sessionId: "s1", userId: "u1", lastSeenAt: "2026-10-03T11:59:30.000Z" };

    expect(shouldTouchSessionActivity(activity, "2026-10-03T11:00:00.000Z", nowMs, 60_000)).toBe(false);
    expect(shouldTouchSessionActivity(activity, "2026-10-03T11:00:00.000Z", nowMs, 1_000)).toBe(true);
    expect(shouldTouchSessionActivity(undefined, "2026-10-03T11:59:59.000Z", nowMs, 60_000)).toBe(false);
    expect(shouldTouchSessionActivity(undefined, "not-a-date", nowMs, 60_000)).toBe(true);
    expect(shouldTouchSessionActivity({ ...activity, lastSeenAt: "not-a-date" }, "2026-10-03T11:59:59.000Z", nowMs, 60_000)).toBe(true);
  });

  it("suppresses redundant renewals within the touch interval", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-03T12:00:00.000Z"));
    const { store, touches } = storeRecordingTouches();

    renewSessionActivity(store, { id: "user-vet", sessionId: "session-1" });
    renewSessionActivity(store, { id: "user-vet", sessionId: "session-1" });
    await Promise.resolve();
    await Promise.resolve();

    expect(touches).toHaveLength(1);
    expect(touches[0]).toMatchObject({ sessionId: "session-1", userId: "user-vet" });

    // A different session still renews, and an actor without a session cannot.
    renewSessionActivity(store, { id: "user-vet" });
    vi.setSystemTime(new Date("2026-10-03T12:02:00.000Z"));
    renewSessionActivity(store, { id: "user-vet", sessionId: "session-1" });
    renewSessionActivity(store, { id: "user-admin", sessionId: "session-2" });
    await Promise.resolve();
    await Promise.resolve();

    expect(touches.map((touch) => touch.sessionId)).toEqual(["session-1", "session-1", "session-2"]);
  });

  it("swallows a failed renewal and prunes its suppression cache", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-03T12:00:00.000Z"));
    const failing: StateStore = {
      ...storeRecordingTouches().store,
      touchSessionActivity: async () => {
        throw new Error("database unavailable");
      }
    };

    renewSessionActivity(failing, { id: "user-vet", sessionId: "session-failing" });
    await Promise.resolve();
    await Promise.resolve();

    // The suppression map grew past its bound and dropped the stale entry, so
    // the same session is eligible again after the interval.
    const { store, touches } = storeRecordingTouches();
    for (let index = 0; index < 10_001; index += 1) {
      vi.setSystemTime(new Date(Date.parse("2026-10-03T12:00:00.000Z") + index * 61_000));
      renewSessionActivity(store, { id: "user-vet", sessionId: `session-${index}` });
    }
    vi.setSystemTime(new Date("2026-10-03T20:00:00.000Z"));
    renewSessionActivity(store, { id: "user-vet", sessionId: "session-failing" });
    await Promise.resolve();
    await Promise.resolve();

    expect(touches.some((touch) => touch.sessionId === "session-failing")).toBe(true);
  });
});
