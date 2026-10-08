import type { Pool } from "pg";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { StoreState } from "../domain/models";
import { FakeEntityDatabase, type FakeQueryResult } from "../../test/fake-entity-database";
import { createDemoState } from "./fixtures";
import { CURRENT_VERSION_SQL } from "./postgres-state-codec";
import { loadEntityState, stateHeader } from "./postgres-entity-state";

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
const connectionString = "postgres://test.invalid/cvg_test_cache";
const caches: PostgresStateCache[] = [];

/**
 * The version probe goes through pool.query; a refresh checks out a client and
 * reads the entity tables inside REPEATABLE READ. `gate` holds the header read
 * of the next refresh so tests can interleave concurrent readers.
 */
function makeCache(state: StoreState = createDemoState("cache-unit-password"), database = new FakeEntityDatabase(state, 1)) {
  const probe = vi.fn(async (sql: string): Promise<FakeQueryResult> => {
    if (sql === CURRENT_VERSION_SQL) return versionRow(String(database.version));
    throw new Error(`Unexpected pool SQL: ${sql}`);
  });
  const gates: Array<Promise<unknown>> = [];
  const tx = vi.fn(async (sql: string, values?: unknown[]): Promise<FakeQueryResult> => {
    if (sql.startsWith("BEGIN") || sql === "COMMIT" || sql === "ROLLBACK") return { rowCount: 0, rows: [] };
    if (sql.startsWith("SELECT state, version, entity_removal_floor")) {
      const gate = gates.shift();
      if (gate) await gate;
    }
    const result = database.handle(sql, values ?? []);
    if (!result) throw new Error(`Unexpected refresh SQL: ${sql}`);
    return result;
  });
  const release = vi.fn();
  const connect = vi.fn(async () => ({ query: tx, release }));
  const cache = new PostgresStateCache({ query: probe, connect } as unknown as Pool, { state, version: 1 }, connectionString);
  caches.push(cache);
  const refreshes = () => tx.mock.calls.filter(([sql]) => String(sql).startsWith("SELECT state, version, entity_removal_floor")).length;
  const fullLoads = () => tx.mock.calls.filter(([sql]) => String(sql).startsWith("SELECT collection, entity_key, position, data FROM cvg_runtime_entities ORDER BY")).length;
  return { cache, probe, tx, connect, release, database, gates, state, refreshes, fullLoads };
}

/** Commits a header-only change (protocolSequence) as another process would. */
function externalCommit(database: FakeEntityDatabase, protocolSequence: number) {
  database.handle("UPDATE cvg_runtime_state SET state = $1::jsonb, version = version + 1", [JSON.stringify(stateHeader({ ...database.state(), protocolSequence }))]);
}

function emit(event: string, value?: unknown) {
  const handlers = listener.client.on.mock.calls.filter(([name]) => name === event);
  expect(handlers.length).toBeGreaterThan(0);
  for (const [, handler] of handlers) handler(value);
}

async function readyCache() {
  // Start from a real load so the cached arrays carry their persisted positions.
  const database = new FakeEntityDatabase(createDemoState("cache-unit-password"), 1);
  const loaded = await loadEntityState({ query: async (sql, values) => database.handle(sql, values ?? [])! });
  database.statements.length = 0;
  const context = makeCache(loaded.state, database);
  // A completed LISTEN invalidates anything read before subscription. Warm once.
  await vi.waitFor(() => expect(listener.client.query).toHaveBeenCalledWith("LISTEN cvg_runtime_state_changed"));
  await context.cache.read();
  context.probe.mockClear();
  context.tx.mockClear();
  context.connect.mockClear();
  context.release.mockClear();
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
    const { cache, probe, connect, state } = await readyCache();
    const [first, second] = await Promise.all([cache.read(), cache.read()]);
    // No per-read copy: callers share the same frozen aggregate and cannot change it.
    expect(first.state).toBe(second.state);
    expect(() => { first.state.users[0].displayName = "changed"; }).toThrow(TypeError);
    expect(() => first.state.users.pop()).toThrow(TypeError);
    expect(second).toEqual({ state, version: 1 });
    expect(cache.getState()).toEqual(state);
    await cache.read();
    expect(probe.mock.calls.map(([sql]) => sql)).toEqual(Array(3).fill(CURRENT_VERSION_SQL));
    expect(connect).not.toHaveBeenCalled();
  });

  it("singleflights misses by observed version while probing each caller", async () => {
    const { cache, probe, database, gates, refreshes, release, state } = await readyCache();
    const gate = deferred<void>();
    gates.push(gate.promise);
    externalCommit(database, state.protocolSequence + 1);
    const reads = Array.from({ length: 4 }, () => cache.read());
    await vi.waitFor(() => expect(refreshes()).toBe(1));
    expect(probe.mock.calls.filter(([sql]) => sql === CURRENT_VERSION_SQL)).toHaveLength(4);
    gate.resolve();
    const snapshots = await Promise.all(reads);
    const next = { ...state, protocolSequence: state.protocolSequence + 1 };
    expect(snapshots).toEqual(Array(4).fill({ state: next, version: 2 }));
    expect(snapshots.every((snapshot) => snapshot.state === snapshots[0].state)).toBe(true);
    expect(() => { snapshots[0].state.users[0].displayName = "shared"; }).toThrow(TypeError);
    expect(cache.getState()).toEqual(next);
    expect(release).toHaveBeenCalledOnce();
    probe.mockClear();
    await cache.read();
    expect(probe.mock.calls).toEqual([[CURRENT_VERSION_SQL]]);
    expect(refreshes()).toBe(1);
  });

  it("applies only the entities written after the cached version", async () => {
    const { cache, database, tx, fullLoads, state } = await readyCache();
    const writer = database.state();
    const renamed = { ...writer, users: writer.users.map((user, index) => index === 0 ? { ...user, displayName: "Renamed elsewhere" } : user) };
    const changedRow = database.rows.get(`users\u0000${writer.users[0].id}`)!;
    database.handle("UPDATE cvg_runtime_state SET state = $1::jsonb, version = version + 1", [JSON.stringify(stateHeader(renamed))]);
    database.rows.set(`users\u0000${writer.users[0].id}`, { ...changedRow, data: renamed.users[0] as unknown as Record<string, unknown>, written_version: database.version });
    const snapshot = await cache.read();
    expect(snapshot.state.users[0].displayName).toBe("Renamed elsewhere");
    expect(snapshot.state.patients).toBe((await cache.current()).state.patients);
    expect(snapshot.state.users.slice(1)).toEqual(state.users.slice(1));
    expect(fullLoads()).toBe(0);
    expect(tx.mock.calls.map(([sql]) => String(sql).split(" ").slice(0, 4).join(" "))).toEqual([
      "BEGIN ISOLATION LEVEL REPEATABLE",
      "SELECT state, version, entity_removal_floor",
      "SELECT collection, entity_key, position,",
      "SELECT collection, entity_key FROM",
      "COMMIT"
    ]);
  });

  it("does not join an older miss or let its late completion replace a newer cache", async () => {
    const { cache, probe, database, gates, refreshes, state } = await readyCache();
    const oldGate = deferred<void>();
    const newGate = deferred<void>();
    gates.push(oldGate.promise, newGate.promise);
    externalCommit(database, 20);
    const oldRead = cache.read();
    await vi.waitFor(() => expect(refreshes()).toBe(1));
    externalCommit(database, 30);
    const newRead = cache.read();
    await vi.waitFor(() => expect(refreshes()).toBe(2));
    expect(probe).toHaveBeenCalledTimes(2);
    newGate.resolve();
    const newest = { ...state, protocolSequence: 30 };
    await expect(newRead).resolves.toEqual({ state: newest, version: 3 });
    const hit = await cache.read();
    expect(hit).toEqual({ state: newest, version: 3 });
    oldGate.resolve();
    // The older miss reads the same committed tables, so it also lands on 3.
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
    const { cache, probe, connect, state } = await readyCache();
    probe.mockResolvedValueOnce(source);
    await expect(cache.read()).rejects.toThrow(/runtime state|version/i);
    expect(cache.getState()).toEqual(state);
    expect(probe.mock.calls).toEqual([[CURRENT_VERSION_SQL]]);
    expect(connect).not.toHaveBeenCalled();
  });

  it.each([
    { rowCount: 0, rows: [] },
    { rowCount: 2, rows: [] },
    { rowCount: 1, rows: [{ state: { users: [] }, version: "2", entity_removal_floor: "0" }] },
    { rowCount: 1, rows: [{ state: null, version: "2", entity_removal_floor: "0" }] },
    { rowCount: 1, rows: [{ state: stateHeader(createDemoState("invalid-full-password")), version: "bad", entity_removal_floor: "0" }] },
    { rowCount: 1, rows: [{ state: stateHeader(createDemoState("regressed-full-password")), version: "1", entity_removal_floor: "0" }] }
  ])("rejects invalid/missing header rows after a valid probe (case %#)", async (source) => {
    const { cache, probe, tx, release, state } = await readyCache();
    probe.mockResolvedValueOnce(versionRow("2"));
    tx.mockImplementationOnce(async () => ({ rowCount: 0, rows: [] })).mockImplementationOnce(async () => source);
    await expect(cache.read()).rejects.toThrow(/runtime state|version/i);
    expect(cache.getState()).toEqual(state);
    // Invalid rows roll back; a regressed version is refused after the read.
    expect(release).toHaveBeenCalledOnce();
  });

  it("fails closed on a source probe failure and can recover without poisoning the cache", async () => {
    const { cache, probe, state } = await readyCache();
    probe.mockRejectedValueOnce(new Error("source unavailable"));
    await expect(cache.read()).rejects.toThrow("source unavailable");
    expect(cache.getState()).toEqual(state);
    await expect(cache.read()).resolves.toEqual({ state, version: 1 });
  });

  it("rejects every waiter on a failed refresh and retries that version successfully", async () => {
    const { cache, database, gates, refreshes, state } = await readyCache();
    const gate = deferred<void>();
    gates.push(gate.promise);
    externalCommit(database, 2);
    const settled = Promise.allSettled([cache.read(), cache.read()]);
    await vi.waitFor(() => expect(refreshes()).toBe(1));
    gate.reject(new Error("refresh source unavailable"));
    const results = await settled;
    expect(results).toEqual(Array(2).fill({ status: "rejected", reason: new Error("refresh source unavailable") }));
    expect(cache.getState()).toEqual(state);
    await expect(cache.read()).resolves.toEqual({ state: { ...state, protocolSequence: 2 }, version: 2 });
    expect(refreshes()).toBe(2);
  });

  it("accepts a newer version when a commit lands between the probe and the refresh", async () => {
    const { cache, probe, database, state } = await readyCache();
    externalCommit(database, 2);
    probe.mockResolvedValueOnce(versionRow("1")).mockImplementationOnce(async () => {
      externalCommit(database, 3);
      return versionRow("2");
    });
    await expect(cache.read()).resolves.toEqual({ state, version: 1 });
    await expect(cache.read()).resolves.toEqual({ state: { ...state, protocolSequence: 3 }, version: 3 });
  });

  it("returns a cache already advanced by a local commit instead of an older view", async () => {
    const { cache, database, fullLoads, state } = await readyCache();
    externalCommit(database, 2);
    const local = { ...state, protocolSequence: 50 };
    // A local commit observed after the probed version was committed.
    cache.observe(local, 7);
    await expect(cache.read()).resolves.toEqual({ state: local, version: 7 });
    expect(fullLoads()).toBe(0);
  });

  it("treats notifications as invalidation hints and ignores unrelated channels", async () => {
    const { cache, probe, refreshes, fullLoads, state } = await readyCache();
    emit("notification", { channel: "unrelated", payload: "999" });
    await cache.read();
    expect(probe.mock.calls).toEqual([[CURRENT_VERSION_SQL]]);
    expect(refreshes()).toBe(0);
    emit("notification", { channel: "cvg_runtime_state_changed", payload: "999" });
    await expect(cache.read()).resolves.toEqual({ state, version: 1 });
    expect(refreshes()).toBe(1);
    expect(fullLoads()).toBe(0);
  });

  it("does not acknowledge a notification received while the refresh is in flight", async () => {
    const { cache, database, gates, refreshes, state } = await readyCache();
    const gate = deferred<void>();
    gates.push(gate.promise);
    externalCommit(database, 2);
    const reading = cache.read();
    await vi.waitFor(() => expect(refreshes()).toBe(1));
    emit("notification", { channel: "cvg_runtime_state_changed", payload: "2" });
    gate.resolve();
    await reading;
    await cache.read();
    expect(refreshes()).toBe(2);
    expect(cache.getState()).toEqual({ ...state, protocolSequence: 2 });
  });

  it.each(["error", "end"])("reloads every entity after listener %s and reconnects", async (event) => {
    vi.useFakeTimers();
    const { cache, probe, fullLoads, state } = makeCache();
    await Promise.resolve();
    await Promise.resolve();
    await cache.read();
    expect(fullLoads()).toBe(0);
    probe.mockClear();
    emit(event, event === "error" ? new Error("listener disconnected") : undefined);
    expect(listener.client.release).toHaveBeenCalledWith(true);
    await cache.read();
    expect(probe.mock.calls).toEqual([[CURRENT_VERSION_SQL]]);
    // Anything (even a restore reusing the version) may have gone unannounced.
    expect(fullLoads()).toBe(1);
    await cache.read();
    expect(fullLoads()).toBe(1);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(listener.connect).toHaveBeenCalledTimes(2);
    expect(cache.getState()).toEqual(state);
  });

  it("refreshes within a caller's transaction, exactly when asked", async () => {
    const { cache, database, fullLoads, state } = await readyCache();
    const client = { query: async (sql: string, values?: unknown[]) => database.handle(sql, values ?? [])! };
    externalCommit(database, 4);
    await expect(cache.refreshWith(client)).resolves.toEqual({ state: { ...state, protocolSequence: 4 }, version: 2 });
    cache.observe({ ...state, protocolSequence: 9 }, 5);
    await expect(cache.refreshWith(client)).resolves.toMatchObject({ version: 5 });
    await expect(cache.refreshWith(client, { exact: true })).resolves.toEqual({ state: { ...state, protocolSequence: 4 }, version: 2 });
    expect(fullLoads()).toBe(0);
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
