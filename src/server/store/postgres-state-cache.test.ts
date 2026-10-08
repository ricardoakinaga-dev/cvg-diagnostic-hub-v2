import type { Pool } from "pg";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { StoreState } from "../domain/models";
import { createDemoState } from "./fixtures";
import { CURRENT_STATE_SQL, CURRENT_VERSION_SQL } from "./postgres-state-codec";

const listener = vi.hoisted(() => ({
  options: [] as unknown[],
  connect: vi.fn(), end: vi.fn(), on: vi.fn(),
  client: { query: vi.fn(), on: vi.fn(), release: vi.fn() }
}));

vi.mock("pg", () => ({
  Pool: class MockListenerPool {
    constructor(options: unknown) { listener.options.push(options); }
    connect = listener.connect;
    end = listener.end;
    on = listener.on;
  }
}));

import { PostgresStateCache } from "./postgres-state-cache";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function versionRow(version: unknown) { return { rowCount: 1, rows: [{ version }] }; }
function stateRow(state: unknown, version: unknown) { return { rowCount: 1, rows: [{ state, version }] }; }
type SourceResult = { rowCount: number; rows: unknown[] };
const connectionString = "postgres://test.invalid/cvg_test_cache";
const caches: PostgresStateCache[] = [];

function makeCache(state: StoreState = createDemoState("cache-unit-password")) {
  const query = vi.fn(async (sql: string): Promise<SourceResult> => {
    if (sql === CURRENT_VERSION_SQL) return versionRow("1");
    if (sql === CURRENT_STATE_SQL) return stateRow(state, "1");
    throw new Error(`Unexpected source SQL: ${sql}`);
  });
  const cache = new PostgresStateCache({ query } as unknown as Pool, { state, version: 1 }, connectionString);
  caches.push(cache);
  return { cache, query, state };
}

function emit(event: string, value?: unknown) {
  const handlers = listener.client.on.mock.calls.filter(([name]) => name === event);
  expect(handlers.length).toBeGreaterThan(0);
  for (const [, handler] of handlers) handler(value);
}

async function readyCache() {
  const context = makeCache();
  // A completed LISTEN invalidates anything read before subscription. Warm once.
  await vi.waitFor(() => expect(listener.client.query).toHaveBeenCalledWith("LISTEN cvg_runtime_state_changed"));
  await context.cache.read();
  context.query.mockClear();
  return context;
}

describe("PostgresStateCache authoritative version and immutable snapshots", () => {
  beforeEach(() => {
    listener.options.length = 0;
    listener.connect.mockReset().mockResolvedValue(listener.client);
    listener.end.mockReset().mockResolvedValue(undefined);
    listener.on.mockReset();
    listener.client.on.mockReset();
    listener.client.query.mockReset().mockResolvedValue({ rowCount: 0, rows: [] });
    listener.client.release.mockReset();
  });

  afterEach(async () => {
    await Promise.all(caches.splice(0).map((cache) => cache.close()));
    vi.useRealTimers();
  });

  it("takes ownership of the initial state by freezing it, while getState returns an independent copy", () => {
    const { cache, state } = makeCache();
    const original = structuredClone(state);
    expect(Object.isFrozen(state) && Object.isFrozen(state.users) && Object.isFrozen(state.users[0])).toBe(true);
    expect(() => { state.users[0].displayName = "caller mutation"; }).toThrow(TypeError);
    expect(() => { state.patients.length = 0; }).toThrow(TypeError);
    const inspected = cache.getState();
    expect(Object.isFrozen(inspected.users[0])).toBe(false);
    inspected.users[0].displayName = "inspection mutation";
    inspected.services.length = 0;
    expect(cache.getState()).toEqual(original);
  });

  it("probes the durable scalar version on every hit and shares one frozen snapshot", async () => {
    const { cache, query, state } = await readyCache();
    const [first, second] = await Promise.all([cache.read(), cache.read()]);
    // No per-read copy: callers share the same frozen aggregate and cannot change it.
    expect(first.state).toBe(second.state);
    expect(() => { first.state.users[0].displayName = "changed"; }).toThrow(TypeError);
    expect(() => first.state.users.pop()).toThrow(TypeError);
    expect(second).toEqual({ state, version: 1 });
    expect(cache.getState()).toEqual(state);
    await cache.read();
    expect(query.mock.calls.map(([sql]) => sql)).toEqual(Array(3).fill(CURRENT_VERSION_SQL));
  });

  it("singleflights full-state misses by observed version while probing each caller", async () => {
    const { cache, query, state } = await readyCache();
    const full = deferred<SourceResult>();
    query.mockImplementation(async (sql) => sql === CURRENT_VERSION_SQL ? versionRow("2") : full.promise);
    const reads = Array.from({ length: 4 }, () => cache.read());
    await vi.waitFor(() => expect(query.mock.calls.filter(([sql]) => sql === CURRENT_STATE_SQL)).toHaveLength(1));
    expect(query.mock.calls.filter(([sql]) => sql === CURRENT_VERSION_SQL)).toHaveLength(4);
    const next = { ...state, protocolSequence: state.protocolSequence + 1 };
    full.resolve(stateRow(next, "2"));
    const snapshots = await Promise.all(reads);
    expect(snapshots).toEqual(Array(4).fill({ state: next, version: 2 }));
    expect(snapshots.every((snapshot) => snapshot.state === snapshots[0].state)).toBe(true);
    expect(() => { snapshots[0].state.users[0].displayName = "shared"; }).toThrow(TypeError);
    expect(snapshots[1].state).toEqual(next);
    expect(cache.getState()).toEqual(next);
    query.mockClear();
    await cache.read();
    expect(query.mock.calls).toEqual([[CURRENT_VERSION_SQL]]);
  });

  it("does not join an older miss or let its late completion replace a newer cache", async () => {
    const { cache, query, state } = await readyCache();
    const oldLoad = deferred<SourceResult>();
    const newLoad = deferred<SourceResult>();
    let version = 2;
    let fullReads = 0;
    query.mockImplementation(async (sql) => {
      if (sql === CURRENT_VERSION_SQL) return versionRow(version);
      fullReads += 1;
      return fullReads === 1 ? oldLoad.promise : newLoad.promise;
    });
    const oldRead = cache.read();
    await vi.waitFor(() => expect(fullReads).toBe(1));
    version = 3;
    const newRead = cache.read();
    await vi.waitFor(() => expect(fullReads).toBe(2));
    const newest = { ...state, protocolSequence: 30 };
    newLoad.resolve(stateRow(newest, "3"));
    await expect(newRead).resolves.toEqual({ state: newest, version: 3 });
    const hit = await cache.read();
    expect(hit).toEqual({ state: newest, version: 3 });
    oldLoad.resolve(stateRow({ ...state, protocolSequence: 20 }, "2"));
    await oldRead;
    expect(cache.getState()).toEqual(newest);
    await expect(cache.read()).resolves.toEqual(hit);
  });

  it("freezes observations and ignores versions older than the inspection cache", async () => {
    const { cache, state } = await readyCache();
    const newest = { ...structuredClone(state), protocolSequence: 8 };
    cache.observe(newest, 8);
    expect(() => { newest.users[0].displayName = "mutated observation"; }).toThrow(TypeError);
    cache.observe({ ...state, protocolSequence: 2 }, 2);
    expect(cache.getState().protocolSequence).toBe(8);
    expect(cache.getState().users[0].displayName).toBe(state.users[0].displayName);
  });

  it.each([
    { rowCount: 0, rows: [] },
    { rowCount: 2, rows: [{ version: 1 }, { version: 1 }] },
    versionRow(0), versionRow(-1), versionRow("not-a-version"),
    versionRow("1.5"), versionRow(Number.MAX_SAFE_INTEGER + 1),
    versionRow(9007199254740992n), versionRow(undefined)
  ])("rejects invalid/missing version probes without returning cached state (case %#)", async (source) => {
    const { cache, query, state } = await readyCache();
    query.mockResolvedValueOnce(source);
    await expect(cache.read()).rejects.toThrow(/runtime state|version/i);
    expect(cache.getState()).toEqual(state);
    expect(query.mock.calls).toEqual([[CURRENT_VERSION_SQL]]);
  });

  it.each([
    { rowCount: 0, rows: [] },
    { rowCount: 2, rows: [] },
    stateRow({ users: [] }, "2"), stateRow(null, "2"),
    stateRow(createDemoState("invalid-full-password"), "bad"),
    stateRow(createDemoState("regressed-full-password"), "1")
  ])("rejects invalid/missing full rows after a valid probe (case %#)", async (source) => {
    const { cache, query, state } = await readyCache();
    query.mockResolvedValueOnce(versionRow("2")).mockResolvedValueOnce(source);
    await expect(cache.read()).rejects.toThrow(/runtime state|version/i);
    expect(cache.getState()).toEqual(state);
  });

  it("fails closed on a source probe failure and can recover without poisoning the cache", async () => {
    const { cache, query, state } = await readyCache();
    query.mockRejectedValueOnce(new Error("source unavailable"));
    await expect(cache.read()).rejects.toThrow("source unavailable");
    expect(cache.getState()).toEqual(state);
    await expect(cache.read()).resolves.toEqual({ state, version: 1 });
  });

  it("rejects every waiter on a failed full load and retries that version successfully", async () => {
    const { cache, query, state } = await readyCache();
    const full = deferred<SourceResult>();
    query.mockImplementation(async (sql) => sql === CURRENT_VERSION_SQL ? versionRow("2") : full.promise);
    const settled = Promise.allSettled([cache.read(), cache.read()]);
    await vi.waitFor(() => expect(query.mock.calls.filter(([sql]) => sql === CURRENT_STATE_SQL)).toHaveLength(1));
    full.reject(new Error("full source unavailable"));
    const results = await settled;
    expect(results).toEqual(Array(2).fill({ status: "rejected", reason: new Error("full source unavailable") }));
    expect(cache.getState()).toEqual(state);
    const next = { ...state, protocolSequence: 2 };
    query.mockImplementation(async (sql) => sql === CURRENT_VERSION_SQL ? versionRow("2") : stateRow(next, "2"));
    await expect(cache.read()).resolves.toEqual({ state: next, version: 2 });
    expect(query.mock.calls.filter(([sql]) => sql === CURRENT_STATE_SQL)).toHaveLength(2);
  });

  it("accepts a newer full-row version when a commit occurs after the scalar probe", async () => {
    const { cache, query, state } = await readyCache();
    const next = { ...state, protocolSequence: 3 };
    query.mockResolvedValueOnce(versionRow("2")).mockResolvedValueOnce(stateRow(next, "3"));
    await expect(cache.read()).resolves.toEqual({ state: next, version: 3 });
    expect(cache.getState()).toEqual(next);
  });

  it("treats notifications as invalidation hints and ignores unrelated channels", async () => {
    const { cache, query, state } = await readyCache();
    emit("notification", { channel: "unrelated", payload: "999" });
    await cache.read();
    expect(query.mock.calls).toEqual([[CURRENT_VERSION_SQL]]);
    query.mockClear();
    emit("notification", { channel: "cvg_runtime_state_changed", payload: "999" });
    await expect(cache.read()).resolves.toEqual({ state, version: 1 });
    expect(query.mock.calls).toEqual([[CURRENT_VERSION_SQL], [CURRENT_STATE_SQL]]);
  });

  it("does not acknowledge a notification received while the full read is in flight", async () => {
    const { cache, query, state } = await readyCache();
    const full = deferred<SourceResult>();
    query.mockResolvedValueOnce(versionRow("2")).mockReturnValueOnce(full.promise);
    const reading = cache.read();
    await vi.waitFor(() => expect(query).toHaveBeenCalledWith(CURRENT_STATE_SQL));
    emit("notification", { channel: "cvg_runtime_state_changed", payload: "2" });
    full.resolve(stateRow(state, "2"));
    await reading;
    query.mockClear();
    query.mockResolvedValueOnce(versionRow("2")).mockResolvedValueOnce(stateRow(state, "2"));
    await cache.read();
    expect(query.mock.calls).toEqual([[CURRENT_VERSION_SQL], [CURRENT_STATE_SQL]]);
  });

  it.each(["error", "end"])("recovers from listener %s and still probes the source before any cache use", async (event) => {
    vi.useFakeTimers();
    const { cache, query, state } = makeCache();
    await Promise.resolve();
    await Promise.resolve();
    await cache.read();
    query.mockClear();
    emit(event, event === "error" ? new Error("listener disconnected") : undefined);
    expect(listener.client.release).toHaveBeenCalledWith(true);
    await cache.read();
    expect(query.mock.calls).toEqual([[CURRENT_VERSION_SQL], [CURRENT_STATE_SQL]]);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(listener.connect).toHaveBeenCalledTimes(2);
    expect(cache.getState()).toEqual(state);
  });

  it("works through an unavailable listener and cancels reconnect on idempotent close", async () => {
    vi.useFakeTimers();
    listener.connect.mockRejectedValue(new Error("LISTEN unavailable"));
    const { cache, state } = makeCache();
    await Promise.resolve();
    await Promise.resolve();
    await expect(cache.read()).resolves.toEqual({ state, version: 1 });
    await Promise.all([cache.close(), cache.close()]);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(listener.connect).toHaveBeenCalledOnce();
    expect(listener.end).toHaveBeenCalledOnce();
  });

  it("uses a dedicated max-one listener pool and drains pending connect before ending it", async () => {
    const connection = deferred<typeof listener.client>();
    listener.connect.mockReturnValue(connection.promise);
    const { cache } = makeCache();
    expect(listener.options).toEqual([expect.objectContaining({ connectionString, max: 1, application_name: "cvg-runtime-state-cache" })]);
    const closing = cache.close();
    await Promise.resolve();
    expect(listener.end).not.toHaveBeenCalled();
    connection.resolve(listener.client);
    await closing;
    expect(listener.client.query).not.toHaveBeenCalled();
    expect(listener.client.release).toHaveBeenCalledOnce();
    expect(listener.end).toHaveBeenCalledOnce();
  });
});
