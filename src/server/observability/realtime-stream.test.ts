import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { StateStore, StoreState, User } from "../domain/models";
import { createDemoState } from "../store/fixtures";
import { MemoryStore } from "../store/memory-store";
import { notifyRealtimeMutation } from "./realtime";
import { createRealtimeResponse, type RealtimeAccessPolicy } from "./realtime-stream";
import { renderPrometheus, resetMetrics } from "./metrics";
import { resetSharedRealtimeStateReaders } from "./realtime-state-reader";

const REALTIME_ENV_KEYS = [
  "REALTIME_NOTIFICATION_ADAPTER",
  "DATABASE_URL",
  "REALTIME_MAX_CONNECTIONS",
  "REALTIME_STREAM_INTERVAL_MS",
  "REALTIME_POLL_TIMEOUT_MS",
  "REALTIME_REPLAY_WINDOW",
  "REALTIME_STREAM_MAX_MS",
  "REALTIME_SHARED_READ_MIN_INTERVAL_MS",
  "REALTIME_SHARED_NOTIFY_DEBOUNCE_MS"
] as const;

function event(id: string, aggregateId = "request-1"): StoreState["outbox"][number] {
  return {
    id,
    eventType: "diagnostic.updated",
    aggregateType: "DiagnosticRequest",
    aggregateId,
    payload: { requestId: aggregateId },
    consumerType: "DOMAIN_EVENT",
    routingKey: "domain.diagnostic.updated",
    status: "PROCESSED",
    attempts: 1,
    availableAt: "2026-08-20T10:00:00.000Z",
    correlationId: `correlation-${id}`
  };
}

function actorFor(state: StoreState): User {
  const actor = state.users.find((user) => user.id === "user-vet");
  if (!actor) throw new Error("fixture actor missing");
  return actor;
}

function policy(overrides: Partial<RealtimeAccessPolicy> = {}): RealtimeAccessPolicy {
  return {
    isAuthorized: () => true,
    eventVisible: () => true,
    authorizationError: () => new Error("authorization revoked"),
    ...overrides
  };
}

function request(signal?: AbortSignal): Request {
  return new Request("http://localhost/api/v1/realtime/events", { signal });
}

describe("bounded realtime stream contract", () => {
  beforeEach(() => {
    resetMetrics();
    resetSharedRealtimeStateReaders();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    resetSharedRealtimeStateReaders();
    resetMetrics();
    for (const key of REALTIME_ENV_KEYS) delete process.env[key];
  });

  it("replays only events after the supplied cursor and preserves SSE metadata", async () => {
    const state = createDemoState("realtime-stream-password");
    state.outbox = [event("event-1"), event("event-2")];
    const response = await createRealtimeResponse(
      new MemoryStore(state),
      actorFor(state),
      "correlation-stream",
      "event-1",
      true,
      request(),
      policy()
    );

    const body = await response.text();
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    expect(response.headers.get("x-correlation-id")).toBe("correlation-stream");
    expect(body).toContain("id: event-2");
    expect(body).not.toContain("id: event-1");
    expect(body).not.toContain("resync_required");
    const dataLine = body.split("\n").find((line) => line.startsWith("data: "));
    expect(JSON.parse(dataLine?.slice("data: ".length) ?? "{}")).toEqual({
      eventId: "event-2",
      type: "diagnostic.updated",
      occurredAt: "2026-08-20T10:00:00.000Z",
      entityType: "DiagnosticRequest",
      entityId: "request-1",
      correlationId: "correlation-event-2"
    });
  });

  it("serves a durable snapshot when the wake-up adapter is unavailable", async () => {
    process.env.REALTIME_NOTIFICATION_ADAPTER = "postgres-listen";
    process.env.DATABASE_URL = "not-a-postgres-url";
    const state = createDemoState("realtime-snapshot-fallback-password");
    state.outbox = [event("snapshot-fallback-event")];

    const response = await createRealtimeResponse(
      new MemoryStore(state),
      actorFor(state),
      "snapshot-fallback",
      undefined,
      true,
      request(),
      policy()
    );

    expect(response.status).toBe(200);
    expect(await response.text()).toContain("id: snapshot-fallback-event");
  });

  it.each([
    ["2", 2],
    ["99999", 100],
    ["invalid", 20]
  ] as const)("uses the realtime seam with an empty generic outbox and replay config %s", async (configuredWindow, expectedWindow) => {
    process.env.REALTIME_REPLAY_WINDOW = configuredWindow;
    process.env.REALTIME_STREAM_INTERVAL_MS = "60000";
    const state = createDemoState("realtime-relational-seam-password");
    state.outbox = [];
    const store = new MemoryStore(state);
    const version = await store.readStateVersion();
    const genericRead = vi.spyOn(store, "readStateSnapshot").mockResolvedValue({ state, version });
    const messages = Array.from({ length: 100 }, (_, index) => event(`relational-${index}`));
    const realtimeRead = vi.spyOn(store, "readRealtimeSnapshot").mockResolvedValue({
      state: { ...state, outbox: messages }, version
    });

    const snapshot = await createRealtimeResponse(store, actorFor(state), "relational-snapshot", undefined, true, request(), policy());
    const snapshotBody = await snapshot.text();
    const stream = await createRealtimeResponse(store, actorFor(state), "relational-stream", undefined, false, request(), policy());
    const reader = stream.body!.getReader();
    try {
      const first = await reader.read();
      const streamBody = new TextDecoder().decode(first.value);
      for (const body of [snapshotBody, streamBody]) {
        const ids = [...body.matchAll(/^id: (.+)$/gm)].map((match) => match[1]);
        expect(ids).toEqual(messages.slice(-expectedWindow).map((message) => message.id));
      }
      expect(realtimeRead).toHaveBeenCalledWith(100);
      expect(genericRead).not.toHaveBeenCalled();
    } finally {
      await reader.cancel();
    }
  });

  it("replays committed pending/processed events but suppresses processing and failed delivery rows", async () => {
    const state = createDemoState("realtime-processed-only-password");
    state.outbox = [
      { ...event("event-pending"), status: "PENDING" },
      { ...event("event-processing"), status: "PROCESSING" },
      { ...event("event-failed"), status: "FAILED" },
      event("event-processed")
    ];

    const snapshot = await createRealtimeResponse(new MemoryStore(state), actorFor(state), "processed-only-snapshot", undefined, true, request(), policy());
    const snapshotBody = await snapshot.text();
    expect(snapshotBody).toContain("id: event-pending");
    expect(snapshotBody).toContain("id: event-processed");
    expect(snapshotBody).not.toMatch(/id: event-(processing|failed)/);

    process.env.REALTIME_STREAM_INTERVAL_MS = "60000";
    const stream = await createRealtimeResponse(new MemoryStore(state), actorFor(state), "processed-only-stream", undefined, false, request(), policy());
    const reader = stream.body!.getReader();
    const first = await reader.read();
    const streamBody = new TextDecoder().decode(first.value);
    expect(streamBody).toContain("id: event-pending");
    expect(streamBody).toContain("id: event-processed");
    expect(streamBody).not.toMatch(/id: event-(processing|failed)/);
    await reader.cancel();
  });

  it("rejects an initially unauthorized snapshot before replaying events", async () => {
    const state = createDemoState("realtime-initial-auth-password");

    await expect(createRealtimeResponse(new MemoryStore(state), actorFor(state), "initial-auth", undefined, true, request(), policy({
      isAuthorized: () => false
    }))).rejects.toThrow("authorization revoked");
  });

  it("fails closed when a write lands between the snapshot read and the enqueue", async () => {
    const state = createDemoState("realtime-snapshot-auth-password");
    const actor = actorFor(state);
    const store = new MemoryStore(state);
    // The aggregate was read at version N; a commit lands at N+1 before the
    // payload is enqueued, which is exactly the window a shared reader opens.
    // The version guard has to notice it and revalidate the actor.
    vi.spyOn(store, "readStateVersion").mockResolvedValue((await store.readStateVersion()) + 1);
    vi.spyOn(store, "readAuthorizationSnapshot").mockResolvedValue({ user: { ...actor, active: false } });

    await expect(createRealtimeResponse(store, actor, "snapshot-auth", undefined, true, request(), policy({
      isAuthorized: (current, currentActor) => current.users.find((user) => user.id === currentActor.id)?.active === true
    }))).rejects.toThrow("authorization revoked");
    expect(renderPrometheus()).toContain('cvg_realtime_authorization_staleness_total{mode="stream"} 1');
    expect(renderPrometheus()).toContain('cvg_realtime_poll_duration_ms_count{mode="snapshot",outcome="success"} 1');
  });

  it("serves the snapshot without a second aggregate read when no write intervened", async () => {
    const state = createDemoState("realtime-snapshot-quiet-password");
    const actor = actorFor(state);
    const store = new MemoryStore(state);
    const realtimeRead = vi.spyOn(store, "readRealtimeSnapshot");
    const authorizationSpy = vi.spyOn(store, "readAuthorizationSnapshot");

    await createRealtimeResponse(store, actor, "snapshot-quiet", undefined, true, request(), policy());

    // PROD-104 budget: one aggregate read, and the narrow authorization read
    // is skipped because the version proves the aggregate is still current.
    expect(realtimeRead).toHaveBeenCalledTimes(1);
    expect(realtimeRead).toHaveBeenCalledWith(100);
    expect(authorizationSpy).not.toHaveBeenCalled();
  });

  it("records a bounded poll failure when snapshot persistence is unavailable", async () => {
    const state = createDemoState("realtime-snapshot-failure-password");
    const store = new MemoryStore(state);
    vi.spyOn(store, "readRealtimeSnapshot").mockRejectedValue(new Error("database unavailable"));

    await expect(createRealtimeResponse(store, actorFor(state), "snapshot-failure", undefined, true, request(), policy())).rejects.toThrow("state_read_failed");
    expect(renderPrometheus()).toContain('cvg_realtime_poll_failures_total{mode="snapshot",reason="state_read_failed"} 1');
  });

  it("closes a stream after its configured maximum lifetime", async () => {
    process.env.REALTIME_STREAM_MAX_MS = "10";
    process.env.REALTIME_STREAM_INTERVAL_MS = "60000";
    const state = createDemoState("realtime-max-duration-password");
    const response = await createRealtimeResponse(new MemoryStore(state), actorFor(state), "stream-duration", undefined, false, request(), policy());
    const reader = response.body!.getReader();

    const first = await reader.read();
    expect(first.done).toBe(false);
    const second = await reader.read();
    expect(second.done).toBe(true);
    expect(renderPrometheus()).toContain('cvg_realtime_stream_closures_total{reason="max_duration"} 1');
    await reader.cancel();
  });

  it("closes an already aborted request before opening a polling loop", async () => {
    const controller = new AbortController();
    controller.abort();
    const state = createDemoState("realtime-abort-password");
    const response = await createRealtimeResponse(new MemoryStore(state), actorFor(state), "stream-abort", undefined, false, request(controller.signal), policy());
    const result = await response.body!.getReader().read();

    expect(result.done).toBe(true);
    expect(renderPrometheus()).toContain('cvg_realtime_stream_closures_total{reason="client_abort"} 1');
  });

  it("closes a stream when a deactivation commits after its shared read", async () => {
    const state = createDemoState("realtime-stream-auth-password");
    state.outbox = [event("event-auth")];
    const actor = actorFor(state);
    const store = new MemoryStore(state);
    vi.spyOn(store, "readStateVersion").mockResolvedValue((await store.readStateVersion()) + 1);
    vi.spyOn(store, "readAuthorizationSnapshot").mockResolvedValue({ user: { ...actor, active: false } });
    const response = await createRealtimeResponse(store, actor, "stream-auth", undefined, false, request(), policy({
      isAuthorized: (current, currentActor) => current.users.find((user) => user.id === currentActor.id)?.active === true
    }));

    const result = await response.body!.getReader().read();
    expect(result.done).toBe(true);
    expect(renderPrometheus()).toContain('cvg_realtime_stream_closures_total{reason="authorization_revoked"} 1');
  });

  it("shares one aggregate read per cadence across many concurrent connections", async () => {
    process.env.REALTIME_MAX_CONNECTIONS = "200";
    process.env.REALTIME_STREAM_INTERVAL_MS = "60";
    process.env.REALTIME_SHARED_READ_MIN_INTERVAL_MS = "60000";
    const state = createDemoState("realtime-shared-read-password");
    state.outbox = [event("event-shared")];
    const actor = actorFor(state);
    const store = new MemoryStore(state);
    const realtimeRead = vi.spyOn(store, "readRealtimeSnapshot");
    const authorizationSpy = vi.spyOn(store, "readAuthorizationSnapshot");

    const responses = await Promise.all(Array.from({ length: 40 }, (_, index) =>
      createRealtimeResponse(store, actor, `shared-${index}`, undefined, false, request(), policy())));
    await Promise.all(responses.map(async (response) => {
      const reader = response.body!.getReader();
      await reader.read();
      await reader.cancel();
    }));

    // PROD-104 acceptance: with 40 open connections the process still performs
    // a single aggregate read for the whole cadence.
    expect(realtimeRead).toHaveBeenCalledTimes(1);
    expect(realtimeRead).toHaveBeenCalledWith(100);
    expect(authorizationSpy).not.toHaveBeenCalled();
    expect(renderPrometheus()).toContain('cvg_realtime_shared_reads_total{mode="stream"}');
    delete process.env.REALTIME_SHARED_READ_MIN_INTERVAL_MS;
  });

  it("closes when a queued wake-up would overrun the stream backpressure budget", async () => {
    process.env.REALTIME_STREAM_INTERVAL_MS = "60000";
    const state = createDemoState("realtime-backpressure-password");
    const response = await createRealtimeResponse(new MemoryStore(state), actorFor(state), "stream-backpressure", undefined, false, request(), policy());
    await new Promise((resolve) => setTimeout(resolve, 0));
    notifyRealtimeMutation();
    const reader = response.body!.getReader();
    const first = await reader.read();
    const second = await reader.read();

    expect(first.done).toBe(false);
    expect(second.done).toBe(true);
    expect(renderPrometheus()).toContain('cvg_realtime_stream_closures_total{reason="backpressure"} 1');
    await reader.cancel();
  });

  it("rejects an oversized SSE payload before enqueueing it", async () => {
    const state = createDemoState("realtime-payload-password");
    state.outbox = [{ ...event("event-oversized"), correlationId: "x".repeat(256 * 1_024 + 1) }];
    const response = await createRealtimeResponse(new MemoryStore(state), actorFor(state), "stream-payload", undefined, false, request(), policy());
    const result = await response.body!.getReader().read();

    expect(result.done).toBe(true);
    expect(renderPrometheus()).toContain('cvg_realtime_poll_failures_total{mode="stream",reason="enqueue_failed"} 1');
    expect(renderPrometheus()).toContain('cvg_realtime_stream_closures_total{reason="backpressure"} 1');
  });

  it("continues a live cursor without duplicates and disposes its capacity, timers and wake-ups", async () => {
    process.env.REALTIME_STREAM_INTERVAL_MS = "60000";
    process.env.REALTIME_STREAM_MAX_MS = "60000";
    process.env.REALTIME_MAX_CONNECTIONS = "1";
    const state = createDemoState("realtime-live-cursor-password");
    state.outbox = [event("cursor-1"), event("cursor-2")];
    const store = new MemoryStore(state);
    const realtimeRead = vi.spyOn(store, "readRealtimeSnapshot");
    const response = await createRealtimeResponse(store, actorFor(state), "live-cursor", "cursor-1", false, request(), policy());
    const reader = response.body!.getReader();
    try {
      await expect(createRealtimeResponse(store, actorFor(state), "over-capacity", undefined, false, request(), policy())).rejects.toMatchObject({ name: "RealtimeUnavailableError", reason: "capacity" });
      const first = new TextDecoder().decode((await reader.read()).value);
      expect(first).toContain("id: cursor-2");
      expect(first).not.toContain("id: cursor-1");
      expect(first).not.toContain("resync_required");
      await store.transaction((current) => ({ state: { ...current, outbox: [...current.outbox, event("cursor-3")] }, result: undefined }));
      const nextChunk = reader.read();
      notifyRealtimeMutation();
      const next = new TextDecoder().decode((await nextChunk).value);
      expect(next).toContain("id: cursor-3");
      expect(next).not.toMatch(/id: cursor-[12]/);
      expect(next).not.toContain("retry:");
      expect(realtimeRead).toHaveBeenCalledTimes(2);
    } finally {
      await reader.cancel();
    }
    await reader.cancel();
    notifyRealtimeMutation();
    expect(realtimeRead).toHaveBeenCalledTimes(2);
    expect(renderPrometheus()).toContain('cvg_realtime_stream_closures_total{reason="consumer_cancel"} 1');

    const replacement = await createRealtimeResponse(store, actorFor(state), "replacement", "cursor-3", false, request(), policy());
    const replacementReader = replacement.body!.getReader();
    try {
      expect(new TextDecoder().decode((await replacementReader.read()).value)).toBe("retry: 5000\n\n: heartbeat\n\n");
    } finally {
      await replacementReader.cancel();
    }
  });

  it("coalesces wake-ups during a pending read into one follow-up without replaying an event twice", async () => {
    vi.useFakeTimers();
    process.env.REALTIME_STREAM_INTERVAL_MS = "60000";
    const state = createDemoState("realtime-coalesced-wakeup-password");
    state.outbox = [event("coalesced-event")];
    const store = new MemoryStore(state);
    const version = await store.readStateVersion();
    let resolveRead: ((snapshot: { state: StoreState; version: number }) => void) | undefined;
    const pending = new Promise<{ state: StoreState; version: number }>((resolve) => {
      resolveRead = resolve;
    });
    const realtimeRead = vi.spyOn(store, "readRealtimeSnapshot").mockReturnValueOnce(pending);
    const response = await createRealtimeResponse(store, actorFor(state), "coalesced", undefined, false, request(), policy());
    const reader = response.body!.getReader();
    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(realtimeRead).toHaveBeenCalledOnce();
      const firstChunk = reader.read();
      notifyRealtimeMutation();
      notifyRealtimeMutation();
      resolveRead?.({ state, version });
      expect(new TextDecoder().decode((await firstChunk).value)).toContain("id: coalesced-event");
      expect(new TextDecoder().decode((await reader.read()).value)).toBe(": heartbeat\n\n");
      await vi.advanceTimersByTimeAsync(0);
      expect(realtimeRead).toHaveBeenCalledOnce();
      expect(renderPrometheus()).toContain('cvg_realtime_poll_duration_ms_count{mode="stream",outcome="success"} 2');
    } finally {
      await reader.cancel();
    }
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["before", "during"] as const)("rejects a snapshot aborted %s its persistence read and emits no delayed events", async (phase) => {
    const state = createDemoState("realtime-snapshot-abort-password");
    state.outbox = [event("aborted-event")];
    const store = new MemoryStore(state);
    const version = await store.readStateVersion();
    const controller = new AbortController();
    let resolveRead: ((snapshot: { state: StoreState; version: number }) => void) | undefined;
    const pending = new Promise<{ state: StoreState; version: number }>((resolve) => {
      resolveRead = resolve;
    });
    const realtimeRead = vi.spyOn(store, "readRealtimeSnapshot").mockReturnValueOnce(pending);
    if (phase === "before") controller.abort();
    const result = createRealtimeResponse(store, actorFor(state), "snapshot-abort", undefined, true, request(controller.signal), policy());
    const rejection = expect(result).rejects.toThrow("client_aborted");
    if (phase === "during") {
      await vi.waitFor(() => expect(realtimeRead).toHaveBeenCalledOnce());
      controller.abort();
    }
    await rejection;
    if (phase === "before") expect(realtimeRead).not.toHaveBeenCalled();
    resolveRead?.({ state, version });
    expect(renderPrometheus()).toContain('cvg_realtime_poll_failures_total{mode="snapshot",reason="client_aborted"} 1');

    const healthy = await createRealtimeResponse(new MemoryStore(state), actorFor(state), "healthy-snapshot", undefined, true, request(), policy());
    expect(await healthy.text()).toContain("id: aborted-event");
  });

  it("aborts an in-flight live read, releases capacity once and ignores its late completion", async () => {
    vi.useFakeTimers();
    process.env.REALTIME_MAX_CONNECTIONS = "1";
    process.env.REALTIME_STREAM_MAX_MS = "60000";
    const state = createDemoState("realtime-inflight-abort-password");
    state.outbox = [event("late-event")];
    const store = new MemoryStore(state);
    const version = await store.readStateVersion();
    let resolveRead: ((snapshot: { state: StoreState; version: number }) => void) | undefined;
    const pending = new Promise<{ state: StoreState; version: number }>((resolve) => {
      resolveRead = resolve;
    });
    const realtimeRead = vi.spyOn(store, "readRealtimeSnapshot").mockReturnValueOnce(pending);
    const controller = new AbortController();
    const response = await createRealtimeResponse(store, actorFor(state), "live-abort", undefined, false, request(controller.signal), policy());
    const reader = response.body!.getReader();
    await vi.advanceTimersByTimeAsync(0);
    expect(realtimeRead).toHaveBeenCalledOnce();
    controller.abort();
    expect(await reader.read()).toEqual({ value: undefined, done: true });
    resolveRead?.({ state, version });
    await vi.advanceTimersByTimeAsync(0);
    await reader.cancel();
    notifyRealtimeMutation();
    expect(realtimeRead).toHaveBeenCalledOnce();
    expect(renderPrometheus()).toContain('cvg_realtime_stream_closures_total{reason="client_abort"} 1');
    expect(renderPrometheus()).not.toContain('reason="consumer_cancel"');
    expect(renderPrometheus()).toContain('cvg_realtime_poll_failures_total{mode="stream",reason="client_aborted"} 1');
    expect(vi.getTimerCount()).toBe(0);

    const replacement = await createRealtimeResponse(new MemoryStore(state), actorFor(state), "after-abort", undefined, false, request(), policy());
    const replacementReader = replacement.body!.getReader();
    try {
      expect(new TextDecoder().decode((await replacementReader.read()).value)).toContain("id: late-event");
    } finally {
      await replacementReader.cancel();
    }
    expect(vi.getTimerCount()).toBe(0);
  });

  it("contains unexpected visibility-policy failures before exposing an event", async () => {
    const state = createDemoState("realtime-policy-failure-password");
    state.outbox = [event("protected-event")];
    const response = await createRealtimeResponse(new MemoryStore(state), actorFor(state), "policy-failure", undefined, false, request(), policy({
      eventVisible: () => { throw new Error("policy unavailable"); }
    }));
    expect(await response.body!.getReader().read()).toEqual({ value: undefined, done: true });
    expect(renderPrometheus()).toContain('cvg_realtime_stream_closures_total{reason="poll_failure"} 1');
    expect(renderPrometheus()).toContain('cvg_realtime_poll_failures_total{mode="stream",reason="state_read_failed"} 1');
  });

  it("rejects a live stream without an adapter while its durable snapshot remains available", async () => {
    process.env.REALTIME_NOTIFICATION_ADAPTER = "unsupported";
    const state = createDemoState("realtime-adapter-guard-password");
    state.outbox = [event("fallback-event")];
    const store = new MemoryStore(state);
    await expect(createRealtimeResponse(store, actorFor(state), "unavailable", undefined, false, request(), policy())).rejects.toMatchObject({ name: "RealtimeUnavailableError", reason: "adapter_unavailable" });
    expect(renderPrometheus()).toContain('cvg_realtime_stream_closures_total{reason="adapter_unavailable"} 1');
    const snapshot = await createRealtimeResponse(store, actorFor(state), "fallback", undefined, true, request(), policy());
    expect(await snapshot.text()).toContain("id: fallback-event");
  });

  it.each([true, false])("resyncs an expired cursor and filters hidden events for snapshot=%s", async (snapshot) => {
    process.env.REALTIME_STREAM_INTERVAL_MS = "60000";
    process.env.REALTIME_REPLAY_WINDOW = "2";
    const state = createDemoState("realtime-expired-cursor-password");
    state.outbox = [event("expired-cursor"), event("visible-event"), event("hidden-event", "private-request")];
    const store = new MemoryStore(state);
    const response = await createRealtimeResponse(store, actorFor(state), "expired", "expired-cursor", snapshot, request(), policy({
      eventVisible: (_current, _actor, _type, entityId) => entityId !== "private-request"
    }));
    const reader = response.body!.getReader();
    try {
      const first = new TextDecoder().decode((await reader.read()).value);
      expect(first).toContain('event: resync_required\ndata: {"reason":"event_window_expired"}');
      expect(first).toContain("id: visible-event");
      expect(first).not.toContain("id: expired-cursor");
      expect(first).not.toContain("hidden-event");
      if (!snapshot) {
        const next = reader.read();
        notifyRealtimeMutation();
        expect(new TextDecoder().decode((await next).value)).toBe(": heartbeat\n\n");
      }
      expect(renderPrometheus()).toContain('cvg_realtime_resyncs_total{reason="event_window_expired"} 1');
    } finally {
      await reader.cancel();
    }
  });

  it("uses scheduled polls to deliver a committed event without a wake-up notification", async () => {
    vi.useFakeTimers();
    process.env.REALTIME_STREAM_INTERVAL_MS = "100";
    process.env.REALTIME_SHARED_READ_MIN_INTERVAL_MS = "100";
    const state = createDemoState("realtime-scheduled-poll-password");
    state.outbox = [];
    const store = new MemoryStore(state);
    const realtimeRead = vi.spyOn(store, "readRealtimeSnapshot");
    const response = await createRealtimeResponse(store, actorFor(state), "scheduled", undefined, false, request(), policy());
    const reader = response.body!.getReader();
    try {
      expect(new TextDecoder().decode((await reader.read()).value)).toBe("retry: 5000\n\n: heartbeat\n\n");
      await store.transaction((current) => ({ state: { ...current, outbox: [event("poll-only-event")] }, result: undefined }));
      const next = reader.read();
      await vi.advanceTimersByTimeAsync(100);
      expect(new TextDecoder().decode((await next).value)).toContain("id: poll-only-event");
      expect(realtimeRead).toHaveBeenCalledTimes(2);
    } finally {
      await reader.cancel();
    }
    await vi.advanceTimersByTimeAsync(1_000);
    expect(realtimeRead).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("closes an initially unauthorized live stream before consulting event visibility", async () => {
    const state = createDemoState("realtime-live-initial-auth-password");
    state.outbox = [event("unauthorized-event")];
    const eventVisible = vi.fn(() => true);
    const response = await createRealtimeResponse(new MemoryStore(state), actorFor(state), "live-initial-auth", undefined, false, request(), policy({
      isAuthorized: () => false, eventVisible
    }));
    expect(await response.body!.getReader().read()).toEqual({ value: undefined, done: true });
    expect(eventVisible).not.toHaveBeenCalled();
    expect(renderPrometheus()).toContain('cvg_realtime_stream_closures_total{reason="authorization_revoked"} 1');
  });

  it("closes at its polling deadline and never delivers the late persistence result", async () => {
    vi.useFakeTimers();
    process.env.REALTIME_POLL_TIMEOUT_MS = "10";
    const state = createDemoState("realtime-live-deadline-password");
    state.outbox = [event("late-deadline-event")];
    const store = new MemoryStore(state);
    const version = await store.readStateVersion();
    let resolveRead: ((snapshot: { state: StoreState; version: number }) => void) | undefined;
    vi.spyOn(store, "readRealtimeSnapshot").mockReturnValueOnce(new Promise((resolve) => { resolveRead = resolve; }));
    const response = await createRealtimeResponse(store, actorFor(state), "deadline", undefined, false, request(), policy());
    const reader = response.body!.getReader();
    const result = reader.read();
    await vi.advanceTimersByTimeAsync(9);
    expect(renderPrometheus()).not.toContain('reason="poll_timeout"');
    await vi.advanceTimersByTimeAsync(1);
    expect(await result).toEqual({ value: undefined, done: true });
    resolveRead?.({ state, version });
    await vi.advanceTimersByTimeAsync(0);
    expect(renderPrometheus()).toContain('cvg_realtime_stream_closures_total{reason="poll_timeout"} 1');
    expect(renderPrometheus()).toContain('cvg_realtime_poll_failures_total{mode="stream",reason="poll_timeout"} 1');
    expect(vi.getTimerCount()).toBe(0);
  });

  it("discards a read that completes after the maximum stream lifetime", async () => {
    vi.useFakeTimers();
    process.env.REALTIME_STREAM_MAX_MS = "10";
    const state = createDemoState("realtime-lifetime-read-password");
    state.outbox = [event("late-lifetime-event")];
    const store = new MemoryStore(state);
    const version = await store.readStateVersion();
    let resolveRead: ((snapshot: { state: StoreState; version: number }) => void) | undefined;
    vi.spyOn(store, "readRealtimeSnapshot").mockReturnValueOnce(new Promise((resolve) => { resolveRead = resolve; }));
    const eventVisible = vi.fn(() => true);
    const response = await createRealtimeResponse(store, actorFor(state), "lifetime-read", undefined, false, request(), policy({ eventVisible }));
    const reader = response.body!.getReader();
    await vi.advanceTimersByTimeAsync(10);
    expect(await reader.read()).toEqual({ value: undefined, done: true });
    resolveRead?.({ state, version });
    await vi.advanceTimersByTimeAsync(0);
    expect(eventVisible).not.toHaveBeenCalled();
    expect(renderPrometheus()).toContain('cvg_realtime_poll_failures_total{mode="stream",reason="stream_closed"} 1');
    expect(renderPrometheus()).toContain('cvg_realtime_stream_closures_total{reason="max_duration"} 1');
    expect(vi.getTimerCount()).toBe(0);
  });
});
