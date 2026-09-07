import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { StateStore, StoreState, User } from "../domain/models";
import { createDemoState } from "../store/fixtures";
import { MemoryStore } from "../store/memory-store";
import { notifyRealtimeMutation } from "./realtime";
import { createRealtimeResponse, type RealtimeAccessPolicy } from "./realtime-stream";
import { renderPrometheus, resetMetrics } from "./metrics";

const REALTIME_ENV_KEYS = [
  "REALTIME_NOTIFICATION_ADAPTER",
  "DATABASE_URL",
  "REALTIME_MAX_CONNECTIONS",
  "REALTIME_STREAM_INTERVAL_MS",
  "REALTIME_POLL_TIMEOUT_MS",
  "REALTIME_REPLAY_WINDOW",
  "REALTIME_STREAM_MAX_MS"
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

class SequenceStore implements StateStore {
  private index = 0;

  constructor(private readonly states: StoreState[]) {}

  getState(): StoreState {
    return structuredClone(this.states[Math.min(this.index, this.states.length - 1)]!);
  }

  async readState(): Promise<StoreState> {
    const state = this.states[Math.min(this.index, this.states.length - 1)]!;
    this.index += 1;
    return structuredClone(state);
  }

  async transaction<T>(operation: (state: StoreState) => Promise<{ state: StoreState; result: T }> | { state: StoreState; result: T }): Promise<T> {
    const current = this.getState();
    const outcome = await operation(current);
    this.states[Math.min(this.index, this.states.length - 1)] = structuredClone(outcome.state);
    return outcome.result;
  }
}

describe("bounded realtime stream contract", () => {
  beforeEach(() => {
    resetMetrics();
  });

  afterEach(() => {
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

  it("fails closed when authorization changes between snapshot reads", async () => {
    const state = createDemoState("realtime-snapshot-auth-password");
    const revoked = structuredClone(state);
    revoked.users = revoked.users.map((user) => user.id === "user-vet" ? { ...user, active: false } : user);
    const store = new SequenceStore([state, revoked]);

    await expect(createRealtimeResponse(store, actorFor(state), "snapshot-auth", undefined, true, request(), policy({
      isAuthorized: (current, actor) => current.users.find((user) => user.id === actor.id)?.active === true
    }))).rejects.toThrow("authorization revoked");
    expect(renderPrometheus()).toContain('cvg_realtime_poll_duration_ms_count{mode="snapshot",outcome="success"} 1');
  });

  it("records a bounded poll failure when snapshot persistence is unavailable", async () => {
    const state = createDemoState("realtime-snapshot-failure-password");
    const store = new MemoryStore(state);
    vi.spyOn(store, "readState").mockRejectedValue(new Error("database unavailable"));

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

  it("rechecks authorization before enqueueing a stream payload", async () => {
    const state = createDemoState("realtime-stream-auth-password");
    state.outbox = [event("event-auth")];
    const revoked = structuredClone(state);
    revoked.users = revoked.users.map((user) => user.id === "user-vet" ? { ...user, active: false } : user);
    const store = new SequenceStore([state, revoked]);
    const response = await createRealtimeResponse(store, actorFor(state), "stream-auth", undefined, false, request(), policy({
      isAuthorized: (current, actor) => current.users.find((user) => user.id === actor.id)?.active === true
    }));

    const result = await response.body!.getReader().read();
    expect(result.done).toBe(true);
    expect(renderPrometheus()).toContain('cvg_realtime_stream_closures_total{reason="authorization_revoked"} 1');
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
});
