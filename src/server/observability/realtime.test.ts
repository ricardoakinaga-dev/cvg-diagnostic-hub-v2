import { afterEach, describe, expect, it, vi } from "vitest";
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

import { assertRealtimeNotificationConfiguration, closeRealtimeNotificationAdapter, getRealtimeNotificationAdapter, notifyRealtimeMutation, PostgresListenRealtimeNotificationAdapter, type RealtimeNotificationClient, type RealtimeNotificationMessage, type RealtimeNotificationPool } from "./realtime";
import { runtimePoolTimeouts } from "../domain/database-timeouts";

describe("realtime notification seam", () => {
  const previousAdapter = process.env.REALTIME_NOTIFICATION_ADAPTER;

  afterEach(() => {
    if (previousAdapter === undefined) delete process.env.REALTIME_NOTIFICATION_ADAPTER;
    else process.env.REALTIME_NOTIFICATION_ADAPTER = previousAdapter;
    postgresPool.options.length = 0;
    postgresPool.connect.mockReset();
    postgresPool.query.mockReset();
    postgresPool.end.mockReset().mockResolvedValue(undefined);
    postgresPool.on.mockReset();
  });

  it("provides a bounded process-local wake-up adapter", () => {
    delete process.env.REALTIME_NOTIFICATION_ADAPTER;
    const adapter = getRealtimeNotificationAdapter();
    const listener = vi.fn();
    const unsubscribe = adapter?.subscribe(listener);

    notifyRealtimeMutation();
    expect(adapter).toMatchObject({ name: "process-local", scope: "process-local" });
    expect(listener).toHaveBeenCalledTimes(1);

    unsubscribe?.();
    notifyRealtimeMutation();
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("does not silently treat an unavailable broker flag as multi-instance support", () => {
    process.env.REALTIME_NOTIFICATION_ADAPTER = "postgres-listen";

    expect(getRealtimeNotificationAdapter()).toBeUndefined();
    expect(() => notifyRealtimeMutation()).not.toThrow();
  });

  it("keeps process-local fan-out available only outside production", () => {
    expect(assertRealtimeNotificationConfiguration({ NODE_ENV: "test" })).toBe("process-local");
    expect(assertRealtimeNotificationConfiguration({ NODE_ENV: "production", DATABASE_URL: "postgresql://db.example/cvg" })).toBe("postgres-listen");
    expect(() => assertRealtimeNotificationConfiguration({ NODE_ENV: "production", DATABASE_URL: "postgresql://db.example/cvg", REALTIME_NOTIFICATION_ADAPTER: "process-local" })).toThrow(/process-local.*produção/i);
    expect(getRealtimeNotificationAdapter({ NODE_ENV: "production", REALTIME_NOTIFICATION_ADAPTER: "process-local" })).toBeUndefined();
  });

  it("rejects an invalid production PostgreSQL wake-up configuration without exposing the URL", () => {
    expect(() => assertRealtimeNotificationConfiguration({ NODE_ENV: "production", REALTIME_NOTIFICATION_ADAPTER: "postgres-listen", DATABASE_URL: "https://db.example/cvg" })).toThrow(/DATABASE_URL.*PostgreSQL/i);
    expect(() => assertRealtimeNotificationConfiguration({ NODE_ENV: "production", REALTIME_NOTIFICATION_ADAPTER: "postgres-listen", DATABASE_URL: "postgresql://db.example/cvg", REALTIME_NOTIFICATION_CHANNEL: "invalid-channel" })).toThrow(/CHANNEL/i);
  });

  it("constructs the multi-instance adapter only for a valid PostgreSQL configuration", async () => {
    const adapter = getRealtimeNotificationAdapter({
      NODE_ENV: "test",
      REALTIME_NOTIFICATION_ADAPTER: "postgres-listen",
      DATABASE_URL: "postgresql://db.example/cvg",
      REALTIME_NOTIFICATION_CHANNEL: "cvg_test_wakeup",
      REALTIME_LISTEN_POOL_MAX: "3"
    });

    expect(adapter).toMatchObject({ name: "postgres-listen", scope: "multi-instance" });
    expect(postgresPool.options).toEqual([{ connectionString: "postgresql://db.example/cvg", max: 3, idleTimeoutMillis: 30_000, ...runtimePoolTimeouts() }]);
    await closeRealtimeNotificationAdapter();
    expect(postgresPool.end).toHaveBeenCalledOnce();
  });

  it("defaults production PostgreSQL selection to the multi-instance adapter", async () => {
    const adapter = getRealtimeNotificationAdapter({ NODE_ENV: "production", DATABASE_URL: "postgresql://db.example/cvg" });

    expect(adapter).toMatchObject({ name: "postgres-listen", scope: "multi-instance" });
    await closeRealtimeNotificationAdapter();
  });

  it("uses a dedicated LISTEN client and publishes payload-free cross-instance wake-ups", async () => {
    let notificationListener: ((message: { channel: string; payload?: string }) => void) | undefined;
    const client: RealtimeNotificationClient = {
      query: vi.fn().mockResolvedValue(undefined),
      on: vi.fn((event: "notification" | "error", listener: ((message: { channel: string; payload?: string }) => void) | ((error: Error) => void)) => {
        if (event === "notification") notificationListener = listener as (message: { channel: string; payload?: string }) => void;
      }),
      release: vi.fn()
    };
    const pool: RealtimeNotificationPool = {
      connect: vi.fn().mockResolvedValue(client),
      query: vi.fn().mockResolvedValue(undefined),
      end: vi.fn().mockResolvedValue(undefined)
    };
    const adapter = new PostgresListenRealtimeNotificationAdapter(pool, "cvg_test_wakeup");
    const listener = vi.fn();

    const unsubscribe = adapter.subscribe(listener);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(pool.connect).toHaveBeenCalledOnce();
    expect(client.query).toHaveBeenCalledWith('LISTEN "cvg_test_wakeup"');
    notificationListener?.({ channel: "cvg_other_channel" });
    notificationListener?.({ channel: "cvg_test_wakeup", payload: "ignored" });
    expect(listener).toHaveBeenCalledOnce();

    adapter.notify();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(pool.query).toHaveBeenCalledWith("SELECT pg_notify($1, $2)", ["cvg_test_wakeup", "mutation"]);

    unsubscribe();
    await adapter.close();
    expect(client.release).toHaveBeenCalledOnce();
    expect(pool.end).toHaveBeenCalledOnce();
  });

  it("reconnects the LISTEN client after a transport error without losing subscribers", async () => {
    vi.useFakeTimers();
    const firstNotifications: Array<(message: RealtimeNotificationMessage) => void> = [];
    const firstErrors: Array<(error: Error) => void> = [];
    const secondNotifications: Array<(message: RealtimeNotificationMessage) => void> = [];
    const secondErrors: Array<(error: Error) => void> = [];
    const makeClient = (
      notifications: Array<(message: RealtimeNotificationMessage) => void>,
      errors: Array<(error: Error) => void>
    ): RealtimeNotificationClient => ({
      query: vi.fn().mockResolvedValue(undefined),
      on: vi.fn((event: "notification" | "error", listener: ((message: RealtimeNotificationMessage) => void) | ((error: Error) => void)) => {
        if (event === "notification") notifications.push(listener as (message: RealtimeNotificationMessage) => void);
        else errors.push(listener as (error: Error) => void);
      }),
      release: vi.fn()
    });
    const first = makeClient(firstNotifications, firstErrors);
    const second = makeClient(secondNotifications, secondErrors);
    const pool: RealtimeNotificationPool = {
      connect: vi.fn().mockResolvedValueOnce(first).mockResolvedValueOnce(second),
      query: vi.fn().mockResolvedValue(undefined),
      end: vi.fn().mockResolvedValue(undefined)
    };
    const adapter = new PostgresListenRealtimeNotificationAdapter(pool, "cvg_test_reconnect");
    const listener = vi.fn();
    const flushMicrotasks = async () => {
      for (let index = 0; index < 5; index += 1) await Promise.resolve();
    };

    try {
      const unsubscribe = adapter.subscribe(listener);
      await flushMicrotasks();
      expect(pool.connect).toHaveBeenCalledTimes(1);
      expect(firstNotifications).toHaveLength(1);
      expect(firstErrors).toHaveLength(1);

      firstErrors[0]?.(new Error("LISTEN transport reset"));
      expect(first.release).toHaveBeenCalledOnce();

      await vi.advanceTimersByTimeAsync(5_000);
      await flushMicrotasks();
      expect(pool.connect).toHaveBeenCalledTimes(2);
      expect(secondNotifications).toHaveLength(1);

      secondNotifications[0]?.({ channel: "cvg_test_reconnect", payload: "wake-up-only" });
      expect(listener).toHaveBeenCalledOnce();

      unsubscribe();
      await adapter.close();
      expect(second.release).toHaveBeenCalledOnce();
      expect(pool.end).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });
});
