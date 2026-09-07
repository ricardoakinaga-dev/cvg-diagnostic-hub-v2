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
    const environment = {
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
      idleTimeoutMillis: 30_000
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
});
