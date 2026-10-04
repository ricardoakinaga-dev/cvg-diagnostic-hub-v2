import { afterEach, describe, expect, it } from "vitest";
import { createDemoState } from "./fixtures";
import { MemoryStore } from "./memory-store";
import { activityRowsAfterPrune, compactRuntimeState, runtimeRetentionAuditEvent } from "./runtime-retention";

const RETENTION_ENV_KEYS = [
  "STATE_OUTBOX_HOT_WINDOW",
  "SESSION_RETENTION_MS",
  "IDEMPOTENCY_RETENTION_MS",
  "OUTBOX_STATE_RETENTION_MS"
] as const;

describe("runtime snapshot retention", () => {
  afterEach(() => {
    for (const key of RETENTION_ENV_KEYS) delete process.env[key];
  });

  it("keeps a bounded audit/outbox hot window and removes expired operational rows", () => {
    const state = createDemoState("retention-password");
    const now = new Date("2026-10-02T12:00:00.000Z");
    const old = "2026-09-01T12:00:00.000Z";
    const recent = "2026-10-02T11:59:00.000Z";
    const expanded = {
      ...state,
      auditEvents: Array.from({ length: 4 }, (_, index) => ({
        id: `audit-${index}`,
        eventType: "Test",
        entityType: "Request",
        entityId: "request-1",
        correlationId: `corr-${index}`,
        metadata: {},
        occurredAt: new Date(Date.parse(old) + index * 1_000).toISOString()
      })),
      outbox: [
        { ...state.outbox[0]!, id: "processed-old", status: "PROCESSED" as const, availableAt: old },
        { ...state.outbox[0]!, id: "processed-recent", status: "PROCESSED" as const, availableAt: recent },
        { ...state.outbox[0]!, id: "pending", status: "PENDING" as const, availableAt: recent }
      ],
      sessions: [
        { ...state.sessions[0]!, id: "expired-old", expiresAt: old },
        { ...state.sessions[0]!, id: "active", expiresAt: "2026-10-02T20:00:00.000Z" }
      ],
      idempotency: [
        { ...state.idempotency[0]!, key: "old", createdAt: old },
        { ...state.idempotency[0]!, key: "recent", createdAt: recent }
      ]
    };

    const result = compactRuntimeState(expanded, {
      now,
      outboxHotWindow: 2,
      sessionRetentionMs: 60 * 60 * 1_000,
      idempotencyRetentionMs: 60 * 60 * 1_000,
      outboxRetentionMs: 60 * 60 * 1_000
    });

    expect(result.state.auditEvents.map((event) => event.id)).toEqual(["audit-0", "audit-1", "audit-2", "audit-3"]);
    expect(result.state.outbox.map((message) => message.id)).toEqual(["processed-recent", "pending"]);
    expect(result.state.sessions.map((session) => session.id)).toEqual(["active"]);
    expect(result.state.idempotency.map((record) => record.key)).toEqual(["recent"]);
    expect(result.summary).toEqual({
      auditEventsRemoved: 0,
      outboxMessagesRemoved: 1,
      sessionsRemoved: 1,
      idempotencyRecordsRemoved: 1,
      sessionActivityRowsRemoved: 0
    });
    // The store needs the surviving ids to prune liveness in the same step.
    expect(result.retainedSessionIds).toEqual(["active"]);
    expect(result.removedOutboxMessageIds).toEqual(["processed-old"]);
  });

  it("reads documented retention windows from the environment and rejects hostile values", () => {
    const state = createDemoState("retention-env-password");
    const now = new Date("2026-10-02T12:00:00.000Z");
    const expanded = {
      ...state,
      sessions: [
        { ...state.sessions[0]!, id: "expired-recently", expiresAt: "2026-10-02T11:00:00.000Z" },
        { ...state.sessions[0]!, id: "expired-long-ago", expiresAt: "2026-09-01T12:00:00.000Z" }
      ],
      idempotency: [
        { ...state.idempotency[0]!, key: "recent", createdAt: "2026-10-02T11:00:00.000Z" },
        { ...state.idempotency[0]!, key: "old", createdAt: "2026-09-01T12:00:00.000Z" }
      ]
    };

    process.env.SESSION_RETENTION_MS = "-1";
    process.env.IDEMPOTENCY_RETENTION_MS = "not-a-number";
    process.env.OUTBOX_STATE_RETENTION_MS = "0";
    process.env.STATE_OUTBOX_HOT_WINDOW = "5";
    const configured = compactRuntimeState(expanded, { now });

    // Hostile or missing values fall back to the documented 24h default instead
    // of disabling retention or emptying the snapshot: the hour-old row is kept
    // and only the month-old row goes.
    expect(configured.state.sessions.map((session) => session.id)).toEqual(["expired-recently"]);
    expect(configured.state.idempotency.map((record) => record.key)).toEqual(["recent"]);
    expect(configured.retainedSessionIds).toEqual(["expired-recently"]);
  });

  it("keeps only activity rows whose session survived the compaction", () => {
    const activity = [
      { sessionId: "active", userId: "user-vet", lastSeenAt: "2026-10-02T11:59:00.000Z" },
      { sessionId: "expired", userId: "user-vet", lastSeenAt: "2026-10-02T11:00:00.000Z" }
    ];

    expect(activityRowsAfterPrune(activity, ["active"]).map((record) => record.sessionId)).toEqual(["active"]);
  });

  it("records one audit event per compaction with counts only", () => {
    const summary = {
      auditEventsRemoved: 0,
      outboxMessagesRemoved: 2,
      sessionsRemoved: 3,
      idempotencyRecordsRemoved: 4,
      sessionActivityRowsRemoved: 5
    };
    const event = runtimeRetentionAuditEvent(summary, new Date("2026-10-02T12:00:00.000Z"));

    expect(event.eventType).toBe("RuntimeStateRetentionApplied");
    expect(event.metadata).toEqual({
      auditEventsRemoved: 0,
      outboxMessagesRemoved: 2,
      sessionsRemoved: 3,
      idempotencyRecordsRemoved: 4,
      sessionActivityRowsRemoved: 5
    });
    expect(JSON.stringify(event)).not.toContain("tokenHash");
    expect(event.occurredAt).toBe("2026-10-02T12:00:00.000Z");
  });

  it("compacts a live store, prunes liveness with the session and audits the run", async () => {
    const state = createDemoState("retention-store-password");
    const now = new Date("2026-10-02T12:00:00.000Z");
    const expiredSession = { ...state.sessions[0]!, id: "expired", expiresAt: "2026-09-01T12:00:00.000Z" };
    const liveSession = { ...state.sessions[0]!, id: "live", expiresAt: "2026-10-02T20:00:00.000Z" };
    const store = new MemoryStore({ ...state, sessions: [expiredSession, liveSession] });
    await store.touchSessionActivity({ sessionId: "expired", userId: expiredSession.userId, lastSeenAt: "2026-10-02T11:00:00.000Z" });
    await store.touchSessionActivity({ sessionId: "live", userId: liveSession.userId, lastSeenAt: "2026-10-02T11:59:00.000Z" });

    const summary = await store.compactRuntimeState({ now, sessionRetentionMs: 1 });

    expect(summary.sessionsRemoved).toBe(1);
    expect(summary.sessionActivityRowsRemoved).toBe(1);
    expect(await store.readSessionActivity("expired")).toBeUndefined();
    expect(await store.readSessionActivity("live")).toMatchObject({ sessionId: "live" });
    const auditEvent = store.getState().auditEvents.at(-1);
    expect(auditEvent?.eventType).toBe("RuntimeStateRetentionApplied");
    expect(auditEvent?.metadata.sessionsRemoved).toBe(1);
  });

  it("never evicts live outbox work when the processed hot window is small", () => {
    const state = createDemoState("retention-live-outbox-password");
    const liveMessages = ["PENDING", "PROCESSING", "FAILED"].map((status, index) => ({
      ...state.outbox[0]!,
      id: `live-${index}`,
      status: status as "PENDING" | "PROCESSING" | "FAILED"
    }));

    const result = compactRuntimeState({ ...state, outbox: liveMessages }, { outboxHotWindow: 1 });

    expect(result.state.outbox.map((message) => message.id)).toEqual(["live-0", "live-1", "live-2"]);
    expect(result.summary.outboxMessagesRemoved).toBe(0);
  });
});
