import { afterEach, describe, expect, it, vi } from "vitest";
import type { StoreState, User } from "../domain/models";
import { createDemoState } from "../store/fixtures";
import { MemoryStore } from "../store/memory-store";

const postgresPool = vi.hoisted(() => ({
  options: [] as Array<Record<string, unknown>>,
  connect: vi.fn(),
  query: vi.fn(),
  end: vi.fn().mockResolvedValue(undefined),
  on: vi.fn()
}));

vi.mock("pg", () => ({
  Pool: class MockPool {
    constructor(options: Record<string, unknown>) {
      postgresPool.options.push(options);
    }

    connect = postgresPool.connect;
    query = postgresPool.query;
    end = postgresPool.end;
    on = postgresPool.on;
  }
}));

import {
  assertRealtimeNotificationConfiguration,
  closeRealtimeNotificationAdapter,
  getRealtimeNotificationAdapter,
  notifyRealtimeMutation,
  PostgresListenRealtimeNotificationAdapter,
  type RealtimeNotificationClient,
  type RealtimeNotificationMessage,
  type RealtimeNotificationPool
} from "./realtime";
import { createRealtimeResponse, type RealtimeAccessPolicy } from "./realtime-stream";
import { runtimePoolTimeouts } from "../domain/database-timeouts";

const REALTIME_ENV_KEYS = [
  "REALTIME_NOTIFICATION_ADAPTER",
  "DATABASE_URL",
  "REALTIME_NOTIFICATION_CHANNEL",
  "REALTIME_LISTEN_POOL_MAX",
  "REALTIME_REPLAY_WINDOW"
] as const;
const initialRealtimeEnvironment = new Map(REALTIME_ENV_KEYS.map((key) => [key, process.env[key]]));

function flushMicrotasks(): Promise<void> {
  return Promise.resolve().then(() => undefined);
}

async function settleConnection(): Promise<void> {
  for (let index = 0; index < 6; index += 1) await flushMicrotasks();
}

function resetPostgresMocks(): void {
  postgresPool.options.length = 0;
  postgresPool.connect.mockReset();
  postgresPool.query.mockReset();
  postgresPool.end.mockReset().mockResolvedValue(undefined);
  postgresPool.on.mockReset();
}

function mockClient(): {
  client: RealtimeNotificationClient;
  notifications: Array<(message: RealtimeNotificationMessage) => void>;
  errors: Array<(error: Error) => void>;
} {
  const notifications: Array<(message: RealtimeNotificationMessage) => void> = [];
  const errors: Array<(error: Error) => void> = [];
  const client: RealtimeNotificationClient = {
    query: vi.fn().mockResolvedValue(undefined),
    on: vi.fn((event: "notification" | "error", listener: ((message: RealtimeNotificationMessage) => void) | ((error: Error) => void)) => {
      if (event === "notification") notifications.push(listener as (message: RealtimeNotificationMessage) => void);
      else errors.push(listener as (error: Error) => void);
    }),
    release: vi.fn()
  };
  return { client, notifications, errors };
}

function outboxEvent(id: string): StoreState["outbox"][number] {
  return {
    id,
    eventType: "diagnostic.updated",
    aggregateType: "DiagnosticRequest",
    aggregateId: "request-realtime-coverage",
    payload: { requestId: "request-realtime-coverage" },
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

function realtimePolicy(): RealtimeAccessPolicy {
  return {
    isAuthorized: () => true,
    eventVisible: () => true,
    authorizationError: () => new Error("authorization revoked")
  };
}

function realtimeRequest(): Request {
  return new Request("http://localhost/api/v1/realtime/events");
}

afterEach(async () => {
  vi.useRealTimers();
  await closeRealtimeNotificationAdapter();
  for (const key of REALTIME_ENV_KEYS) {
    const original = initialRealtimeEnvironment.get(key);
    if (original === undefined) delete process.env[key];
    else process.env[key] = original;
  }
  resetPostgresMocks();
});

describe("realtime public contract coverage", () => {
  it("fails closed for invalid configuration and preserves the durable fallback", async () => {
    const invalidAdapter = {
      NODE_ENV: "test",
      REALTIME_NOTIFICATION_ADAPTER: "unsupported"
    } as NodeJS.ProcessEnv;
    const invalidDatabase = {
      NODE_ENV: "test",
      REALTIME_NOTIFICATION_ADAPTER: "postgres-listen",
      DATABASE_URL: "not-a-postgres-url"
    } as NodeJS.ProcessEnv;

    expect(getRealtimeNotificationAdapter(invalidAdapter)).toBeUndefined();
    expect(getRealtimeNotificationAdapter(invalidDatabase)).toBeUndefined();
    expect(() => notifyRealtimeMutation(invalidDatabase)).not.toThrow();
    expect(postgresPool.options).toHaveLength(0);
    expect(() => closeRealtimeNotificationAdapter()).not.toThrow();

    expect(() => assertRealtimeNotificationConfiguration(invalidAdapter)).toThrow(/process-local ou postgres-listen/i);
    expect(() => assertRealtimeNotificationConfiguration(invalidDatabase)).toThrow(/DATABASE_URL.*PostgreSQL/i);
    expect(() => assertRealtimeNotificationConfiguration({
      NODE_ENV: "production",
      REALTIME_NOTIFICATION_ADAPTER: "postgres-listen",
      DATABASE_URL: "postgresql://db.example/cvg",
      REALTIME_NOTIFICATION_CHANNEL: "channel with spaces"
    })).toThrow(/CHANNEL/i);

    await expect(closeRealtimeNotificationAdapter()).resolves.toBeUndefined();
  });

  it("serves a durable snapshot fallback with cursor-based SSE IDs when the adapter is absent", async () => {
    process.env.REALTIME_NOTIFICATION_ADAPTER = "postgres-listen";
    process.env.DATABASE_URL = "not-a-postgres-url";
    const state = createDemoState("realtime-coverage-snapshot-password");
    state.outbox = [outboxEvent("snapshot-event-1"), outboxEvent("snapshot-event-2")];

    const response = await createRealtimeResponse(
      new MemoryStore(state),
      actorFor(state),
      "snapshot-coverage-correlation",
      "snapshot-event-1",
      true,
      realtimeRequest(),
      realtimePolicy()
    );
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    expect(response.headers.get("x-correlation-id")).toBe("snapshot-coverage-correlation");
    expect(body).toContain("id: snapshot-event-2");
    expect(body).not.toContain("id: snapshot-event-1");
    const dataLine = body.split("\n").find((line) => line.startsWith("data: "));
    expect(JSON.parse(dataLine?.slice("data: ".length) ?? "{}")).toEqual({
      eventId: "snapshot-event-2",
      type: "diagnostic.updated",
      occurredAt: "2026-08-20T10:00:00.000Z",
      entityType: "DiagnosticRequest",
      entityId: "request-realtime-coverage",
      correlationId: "correlation-snapshot-event-2"
    });
  });

  it("publishes process-local wake-ups once per listener and isolates listener errors", () => {
    const environment: NodeJS.ProcessEnv = {
      NODE_ENV: "test",
      REALTIME_NOTIFICATION_ADAPTER: "process-local"
    } as NodeJS.ProcessEnv;
    const adapter = getRealtimeNotificationAdapter(environment);
    if (!adapter) throw new Error("process-local adapter missing");

    const throwingListener = vi.fn(() => {
      throw new Error("consumer failure");
    });
    const healthyListener = vi.fn();
    const unsubscribeFirst = adapter.subscribe(throwingListener);
    const unsubscribeDuplicate = adapter.subscribe(throwingListener);
    const unsubscribeHealthy = adapter.subscribe(healthyListener);

    expect(() => notifyRealtimeMutation(environment)).not.toThrow();
    expect(throwingListener).toHaveBeenCalledOnce();
    expect(healthyListener).toHaveBeenCalledOnce();

    unsubscribeFirst();
    unsubscribeDuplicate();
    unsubscribeFirst();
    expect(() => notifyRealtimeMutation(environment)).not.toThrow();
    expect(throwingListener).toHaveBeenCalledOnce();
    expect(healthyListener).toHaveBeenCalledTimes(2);

    unsubscribeHealthy();
    expect(() => notifyRealtimeMutation(environment)).not.toThrow();
    expect(healthyListener).toHaveBeenCalledTimes(2);
  });

  it("deduplicates the cached adapter by channel identity and bounds the pool size", async () => {
    const environment = {
      NODE_ENV: "production",
      REALTIME_NOTIFICATION_ADAPTER: "postgres-listen",
      DATABASE_URL: "postgresql://db.example/cvg",
      REALTIME_NOTIFICATION_CHANNEL: "cvg_identity",
      REALTIME_LISTEN_POOL_MAX: "99"
    } as NodeJS.ProcessEnv;

    const first = getRealtimeNotificationAdapter(environment);
    const sameIdentity = getRealtimeNotificationAdapter({ ...environment });

    expect(first).toMatchObject({ name: "postgres-listen", scope: "multi-instance" });
    expect(sameIdentity).toBe(first);
    expect(postgresPool.options).toEqual([{
      connectionString: "postgresql://db.example/cvg",
      max: 10,
      idleTimeoutMillis: 30_000,
      ...runtimePoolTimeouts()
    }]);

    await closeRealtimeNotificationAdapter();
    const differentChannel = getRealtimeNotificationAdapter({
      ...environment,
      REALTIME_NOTIFICATION_CHANNEL: "cvg_other_identity"
    });
    expect(differentChannel).toBeDefined();
    expect(differentChannel).not.toBe(first);
    await closeRealtimeNotificationAdapter();
    expect(postgresPool.end).toHaveBeenCalledTimes(2);
  });

  it("publishes through LISTEN/NOTIFY, filters channel IDs, and contains broker failures", async () => {
    const { client, notifications } = mockClient();
    const pool: RealtimeNotificationPool = {
      connect: vi.fn().mockResolvedValue(client),
      query: vi.fn().mockResolvedValue(undefined),
      end: vi.fn().mockResolvedValue(undefined)
    };
    const channel = "cvg\"quoted";
    const adapter = new PostgresListenRealtimeNotificationAdapter(pool, channel);
    const throwingListener = vi.fn(() => {
      throw new Error("stream failure");
    });
    const healthyListener = vi.fn();

    adapter.subscribe(throwingListener);
    adapter.subscribe(throwingListener);
    adapter.subscribe(healthyListener);
    await settleConnection();

    expect(pool.connect).toHaveBeenCalledOnce();
    expect(client.query).toHaveBeenCalledWith('LISTEN "cvg""quoted"');
    notifications[0]?.({ channel: "cvg_other", payload: "ignored" });
    expect(throwingListener).not.toHaveBeenCalled();
    notifications[0]?.({ channel, payload: "wake-up-only" });
    expect(throwingListener).toHaveBeenCalledOnce();
    expect(healthyListener).toHaveBeenCalledOnce();

    adapter.notify();
    await settleConnection();
    expect(pool.query).toHaveBeenCalledWith("SELECT pg_notify($1, $2)", [channel, "mutation"]);

    vi.mocked(pool.query).mockRejectedValueOnce(new Error("broker unavailable"));
    expect(() => adapter.notify()).not.toThrow();
    await settleConnection();
    expect(pool.query).toHaveBeenCalledTimes(2);

    await adapter.close();
    expect(client.release).toHaveBeenCalledOnce();
    expect(pool.end).toHaveBeenCalledOnce();
  });

  it("releases a client that resolves after shutdown without issuing LISTEN", async () => {
    let resolveConnect: ((client: RealtimeNotificationClient) => void) | undefined;
    const connection = new Promise<RealtimeNotificationClient>((resolve) => {
      resolveConnect = resolve;
    });
    const client = mockClient().client;
    const pool: RealtimeNotificationPool = {
      connect: vi.fn().mockReturnValue(connection),
      query: vi.fn().mockResolvedValue(undefined),
      end: vi.fn().mockResolvedValue(undefined)
    };
    const adapter = new PostgresListenRealtimeNotificationAdapter(pool, "cvg_shutdown");

    adapter.subscribe(vi.fn());
    await flushMicrotasks();
    const closing = adapter.close();
    resolveConnect?.(client);
    await closing;

    expect(client.release).toHaveBeenCalledOnce();
    expect(client.query).not.toHaveBeenCalled();
    expect(pool.end).toHaveBeenCalledOnce();
  });

  it("contains connection and LISTEN errors and closes retry state safely", async () => {
    vi.useFakeTimers();
    try {
      const rejectedPool: RealtimeNotificationPool = {
        connect: vi.fn().mockRejectedValue(new Error("connection unavailable")),
        query: vi.fn().mockResolvedValue(undefined),
        end: vi.fn().mockResolvedValue(undefined)
      };
      const rejectedAdapter = new PostgresListenRealtimeNotificationAdapter(rejectedPool, "cvg_connect_error");
      rejectedAdapter.subscribe(vi.fn());
      await settleConnection();
      expect(rejectedPool.connect).toHaveBeenCalledOnce();
      await rejectedAdapter.close();
      expect(rejectedPool.end).toHaveBeenCalledOnce();

      const failedClient = mockClient();
      vi.mocked(failedClient.client.query).mockRejectedValueOnce(new Error("LISTEN unavailable"));
      const listenFailurePool: RealtimeNotificationPool = {
        connect: vi.fn().mockResolvedValue(failedClient.client),
        query: vi.fn().mockResolvedValue(undefined),
        end: vi.fn().mockResolvedValue(undefined)
      };
      const listenFailureAdapter = new PostgresListenRealtimeNotificationAdapter(listenFailurePool, "cvg_listen_error");
      listenFailureAdapter.subscribe(vi.fn());
      await settleConnection();
      expect(failedClient.client.release).toHaveBeenCalledOnce();
      await listenFailureAdapter.close();
      expect(listenFailurePool.end).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it("makes subscriptions and publication inert after shutdown", async () => {
    const { client, notifications, errors } = mockClient();
    const pool: RealtimeNotificationPool = {
      connect: vi.fn().mockResolvedValue(client),
      query: vi.fn().mockResolvedValue(undefined),
      end: vi.fn().mockResolvedValue(undefined)
    };
    const adapter = new PostgresListenRealtimeNotificationAdapter(pool, "cvg_disposal");
    const listener = vi.fn();
    const unsubscribe = adapter.subscribe(listener);
    await settleConnection();
    notifications[0]?.({ channel: "cvg_disposal" });
    expect(listener).toHaveBeenCalledOnce();

    unsubscribe();
    unsubscribe();
    notifications[0]?.({ channel: "cvg_disposal" });
    expect(listener).toHaveBeenCalledOnce();
    await adapter.close();

    const lateListener = vi.fn();
    const unsubscribeLate = adapter.subscribe(lateListener);
    expect(unsubscribeLate()).toBeUndefined();
    adapter.notify();
    errors[0]?.(new Error("late socket error"));
    notifications[0]?.({ channel: "cvg_disposal" });
    await settleConnection();
    expect(lateListener).not.toHaveBeenCalled();
    expect(pool.query).not.toHaveBeenCalled();
    expect(pool.connect).toHaveBeenCalledOnce();
    expect(client.release).toHaveBeenCalledOnce();
    expect(pool.end).toHaveBeenCalledOnce();
  });

  it("stops delivery to active subscribers when closed despite late transport callbacks", async () => {
    vi.useFakeTimers();
    const { client, notifications, errors } = mockClient();
    const pool: RealtimeNotificationPool = {
      connect: vi.fn().mockResolvedValue(client),
      query: vi.fn().mockResolvedValue(undefined),
      end: vi.fn().mockResolvedValue(undefined)
    };
    const adapter = new PostgresListenRealtimeNotificationAdapter(pool, "cvg_active_shutdown");
    const activeListener = vi.fn();
    const unsubscribeActive = adapter.subscribe(activeListener);
    let closed = false;
    try {
      await settleConnection();
      const notification = notifications[0];
      const transportError = errors[0];
      if (!notification || !transportError) throw new Error("transport callbacks missing");
      notification({ channel: "cvg_active_shutdown" });
      expect(activeListener).toHaveBeenCalledOnce();

      // Keep the subscriber registered across close: unsubscription must not
      // hide late delivery by the released transport's retained callbacks.
      await adapter.close();
      closed = true;
      const lateListener = vi.fn();
      const unsubscribeLate = adapter.subscribe(lateListener);
      expect(unsubscribeLate()).toBeUndefined();
      adapter.notify();
      transportError(new Error("released socket error"));
      notification({ channel: "cvg_active_shutdown", payload: "late wake-up" });
      await vi.advanceTimersByTimeAsync(10_000);

      expect(lateListener).not.toHaveBeenCalled();
      expect(pool.query).not.toHaveBeenCalled();
      expect(pool.connect).toHaveBeenCalledOnce();
      expect(client.release).toHaveBeenCalledOnce();
      expect(pool.end).toHaveBeenCalledOnce();
      expect(vi.getTimerCount()).toBe(0);
      expect(activeListener).toHaveBeenCalledOnce();
    } finally {
      unsubscribeActive();
      if (!closed) await adapter.close();
    }
  });

  it("ignores a released connection's notifications before and after reconnecting", async () => {
    vi.useFakeTimers();
    const first = mockClient();
    const replacement = mockClient();
    const pool: RealtimeNotificationPool = {
      connect: vi.fn().mockResolvedValueOnce(first.client).mockResolvedValueOnce(replacement.client),
      query: vi.fn().mockResolvedValue(undefined),
      end: vi.fn().mockResolvedValue(undefined)
    };
    const adapter = new PostgresListenRealtimeNotificationAdapter(pool, "cvg_connection_owner");
    const listener = vi.fn();
    const unsubscribe = adapter.subscribe(listener);
    try {
      await settleConnection();
      first.notifications[0]?.({ channel: "cvg_connection_owner" });
      expect(listener).toHaveBeenCalledOnce();
      first.errors[0]?.(new Error("socket lost"));
      expect(first.client.release).toHaveBeenCalledOnce();
      first.notifications[0]?.({ channel: "cvg_connection_owner" });
      expect(listener).toHaveBeenCalledOnce();

      await vi.advanceTimersByTimeAsync(5_000);
      await settleConnection();
      expect(pool.connect).toHaveBeenCalledTimes(2);
      replacement.notifications[0]?.({ channel: "cvg_connection_owner" });
      expect(listener).toHaveBeenCalledTimes(2);
      first.notifications[0]?.({ channel: "cvg_connection_owner" });
      expect(listener).toHaveBeenCalledTimes(2);
    } finally {
      unsubscribe();
      await adapter.close();
    }
  });

  it("fences prior handlers when the pool reacquires the same client after LISTEN fails", async () => {
    vi.useFakeTimers();
    const { client, notifications, errors } = mockClient();
    vi.mocked(client.query).mockRejectedValueOnce(new Error("temporary LISTEN rejection"));
    const pool: RealtimeNotificationPool = {
      connect: vi.fn().mockResolvedValue(client),
      query: vi.fn().mockResolvedValue(undefined),
      end: vi.fn().mockResolvedValue(undefined)
    };
    const adapter = new PostgresListenRealtimeNotificationAdapter(pool, "cvg_reused_listener");
    const listener = vi.fn();
    const unsubscribe = adapter.subscribe(listener);
    try {
      await settleConnection();
      expect(client.release).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(5_000);
      await settleConnection();
      expect(pool.connect).toHaveBeenCalledTimes(2);
      expect(client.query).toHaveBeenCalledTimes(2);
      expect(notifications).toHaveLength(2);
      // One transport event can reach both retained callbacks on a reused
      // client, but only the current acquisition may deliver its wake-up.
      for (const callback of notifications) callback({ channel: "cvg_reused_listener" });
      expect(listener).toHaveBeenCalledOnce();
      errors[0]?.(new Error("error retained from prior acquisition"));
      expect(client.release).toHaveBeenCalledOnce();
      expect(vi.getTimerCount()).toBe(0);
      for (const callback of notifications) callback({ channel: "cvg_reused_listener" });
      expect(listener).toHaveBeenCalledTimes(2);
    } finally {
      unsubscribe();
      await adapter.close();
    }
  });

  it("stops the current fan-out when an active subscriber closes the adapter", async () => {
    const { client, notifications } = mockClient();
    const pool: RealtimeNotificationPool = {
      connect: vi.fn().mockResolvedValue(client),
      query: vi.fn().mockResolvedValue(undefined),
      end: vi.fn().mockResolvedValue(undefined)
    };
    const adapter = new PostgresListenRealtimeNotificationAdapter(pool, "cvg_close_in_callback");
    let closePromise: Promise<void> | undefined;
    const firstListener = vi.fn(() => { closePromise = adapter.close(); });
    const remainingListener = vi.fn();
    const unsubscribeFirst = adapter.subscribe(firstListener);
    const unsubscribeRemaining = adapter.subscribe(remainingListener);
    try {
      await settleConnection();
      notifications[0]?.({ channel: "cvg_close_in_callback" });
      expect(firstListener).toHaveBeenCalledOnce();
      expect(remainingListener).not.toHaveBeenCalled();
      if (!closePromise) throw new Error("first subscriber did not close the adapter");
      await closePromise;
      expect(client.release).toHaveBeenCalledOnce();
      expect(pool.end).toHaveBeenCalledOnce();
    } finally {
      unsubscribeFirst();
      unsubscribeRemaining();
      await (closePromise ?? adapter.close());
    }
  });

  it("waits for a rejected pending connection during shutdown without retrying", async () => {
    vi.useFakeTimers();
    let rejectConnection: (error: Error) => void = () => {
      throw new Error("connection not initialized");
    };
    const connection = new Promise<RealtimeNotificationClient>((_, reject) => {
      rejectConnection = reject;
    });
    const pool: RealtimeNotificationPool = {
      connect: vi.fn().mockReturnValue(connection),
      query: vi.fn().mockResolvedValue(undefined),
      end: vi.fn().mockResolvedValue(undefined)
    };
    const adapter = new PostgresListenRealtimeNotificationAdapter(pool, "cvg_pending_shutdown");
    const unsubscribe = adapter.subscribe(vi.fn());
    const closing = adapter.close();
    expect(pool.end).not.toHaveBeenCalled();
    rejectConnection(new Error("connection rejected after close"));
    await expect(closing).resolves.toBeUndefined();
    unsubscribe();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(pool.connect).toHaveBeenCalledOnce();
    expect(pool.end).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("contains pool-level errors while keeping subsequent wake-ups available", async () => {
    postgresPool.query.mockResolvedValue(undefined);
    const environment: NodeJS.ProcessEnv = {
      NODE_ENV: "production",
      DATABASE_URL: "postgresql://db.example/cvg",
      REALTIME_NOTIFICATION_ADAPTER: "postgres-listen"
    };
    const adapter = getRealtimeNotificationAdapter(environment);
    expect(adapter).toBeDefined();
    const registration = postgresPool.on.mock.calls.find(([event]) => event === "error");
    if (!registration) throw new Error("pool error handler missing");
    const [, handleError] = registration;
    expect(() => handleError(new Error("idle connection lost"))).not.toThrow();

    notifyRealtimeMutation(environment);
    await settleConnection();
    expect(postgresPool.query).toHaveBeenCalledWith("SELECT pg_notify($1, $2)", ["cvg_realtime_wakeup", "mutation"]);
    await closeRealtimeNotificationAdapter();
    expect(postgresPool.end).toHaveBeenCalledOnce();
  });
});
