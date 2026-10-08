import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fake = vi.hoisted(() => ({
  options: [] as unknown[],
  connect: vi.fn(), end: vi.fn(), on: vi.fn(),
  client: { query: vi.fn(), on: vi.fn(), release: vi.fn() }
}));

vi.mock("pg", () => ({
  Pool: class ListenerPool {
    constructor(options: unknown) { fake.options.push(options); }
    connect = fake.connect;
    end = fake.end;
    on = fake.on;
  }
}));

import { PostgresStateInvalidation } from "./postgres-state-invalidation";
import { runtimePoolTimeouts } from "../domain/database-timeouts";

const listeners: PostgresStateInvalidation[] = [];
function open() {
  const invalidate = vi.fn();
  const listener = new PostgresStateInvalidation("postgres://test.invalid/cvg_test_listener", invalidate);
  listeners.push(listener);
  return { listener, invalidate };
}

async function connected() { await vi.advanceTimersByTimeAsync(0); }

function emit(event: string, value?: unknown) {
  for (const [, callback] of fake.client.on.mock.calls.filter(([name]) => name === event)) callback(value);
}

describe("PostgresStateInvalidation dedicated connection lifecycle", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    fake.options.length = 0;
    fake.connect.mockReset().mockResolvedValue(fake.client);
    fake.end.mockReset().mockResolvedValue(undefined);
    fake.on.mockReset();
    fake.client.query.mockReset().mockResolvedValue({ rowCount: 0, rows: [] });
    fake.client.on.mockReset();
    fake.client.release.mockReset();
  });

  afterEach(async () => {
    await Promise.all(listeners.splice(0).map((listener) => listener.close()));
    vi.useRealTimers();
  });

  it("subscribes immediately on a separate max-one pool and invalidates after LISTEN", async () => {
    const { invalidate } = open();
    expect(fake.connect).toHaveBeenCalledOnce();
    expect(fake.options).toEqual([{
      connectionString: "postgres://test.invalid/cvg_test_listener", max: 1,
      application_name: "cvg-runtime-state-cache", ...runtimePoolTimeouts()
    }]);
    await connected();
    expect(fake.client.query).toHaveBeenCalledWith("LISTEN cvg_runtime_state_changed");
    expect(invalidate).toHaveBeenCalledOnce();
    emit("notification", { channel: "unrelated", payload: "2" });
    expect(invalidate).toHaveBeenCalledOnce();
    emit("notification", { channel: "cvg_runtime_state_changed", payload: "untrusted hint" });
    expect(invalidate).toHaveBeenCalledTimes(2);
  });

  it("consumes idle pool errors as invalidation hints", async () => {
    const { invalidate } = open();
    await connected();
    const [, onError] = fake.on.mock.calls.find(([name]) => name === "error")!;
    onError(new Error("idle connection failed"));
    expect(invalidate).toHaveBeenCalledTimes(2);
  });

  it.each(["error", "end"])("destroys a disconnected client on %s and retries once after five seconds", async (event) => {
    const { listener, invalidate } = open();
    await connected();
    emit(event, new Error("connection failed"));
    // A second event from the abandoned connection cannot create another retry.
    emit("end");
    expect(fake.client.release).toHaveBeenCalledExactlyOnceWith(true);
    expect(invalidate).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(4_999);
    expect(fake.connect).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1);
    expect(fake.connect).toHaveBeenCalledTimes(2);
    expect(fake.client.query).toHaveBeenCalledTimes(2);
    expect(invalidate).toHaveBeenCalledTimes(3);
    await listener.close();
    expect(fake.client.release).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("retries failed acquisition and cancels pending retry during close", async () => {
    fake.connect.mockRejectedValue(new Error("connect failed"));
    const { listener, invalidate } = open();
    await connected();
    expect(invalidate).toHaveBeenCalledOnce();
    expect(fake.client.release).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(fake.connect).toHaveBeenCalledTimes(2);
    expect(invalidate).toHaveBeenCalledTimes(2);
    await Promise.all([listener.close(), listener.close()]);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(fake.connect).toHaveBeenCalledTimes(2);
    expect(fake.end).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("destroys an acquired client when LISTEN fails and recovers with a new connection", async () => {
    fake.client.query.mockRejectedValueOnce(new Error("LISTEN failed"));
    const { invalidate } = open();
    await connected();
    expect(fake.client.release).toHaveBeenCalledExactlyOnceWith(true);
    expect(invalidate).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(fake.connect).toHaveBeenCalledTimes(2);
    expect(fake.client.query).toHaveBeenCalledTimes(2);
    expect(invalidate).toHaveBeenCalledTimes(2);
  });

  it("drains a connection acquired after close without subscribing or scheduling retries", async () => {
    let resolveConnect!: (client: typeof fake.client) => void;
    fake.connect.mockReturnValue(new Promise<typeof fake.client>((resolve) => { resolveConnect = resolve; }));
    const { listener, invalidate } = open();
    const closing = listener.close();
    await Promise.resolve();
    expect(fake.end).not.toHaveBeenCalled();
    resolveConnect(fake.client);
    await closing;
    expect(fake.client.release).toHaveBeenCalledOnce();
    expect(fake.client.query).not.toHaveBeenCalled();
    expect(fake.client.on).not.toHaveBeenCalled();
    expect(invalidate).not.toHaveBeenCalled();
    expect(fake.end).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("drains a failing in-flight LISTEN without recovering after close begins", async () => {
    let rejectListen!: (error: Error) => void;
    fake.client.query.mockReturnValue(new Promise((_, reject) => { rejectListen = reject; }));
    const { listener, invalidate } = open();
    await connected();
    const closing = listener.close();
    expect(fake.end).not.toHaveBeenCalled();
    rejectListen(new Error("LISTEN ended during close"));
    await closing;
    emit("error", new Error("late client error"));
    emit("end");
    expect(fake.client.release).toHaveBeenCalledExactlyOnceWith(true);
    expect(invalidate).not.toHaveBeenCalled();
    expect(fake.end).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });
});
