import { Pool } from "pg";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { StoreState } from "../../src/server/domain/models";
import { authenticateRequest, authorizationSnapshotIsCurrent, loginUser, revokeSession } from "../../src/server/security/session";
import { createDemoState } from "../../src/server/store/fixtures";
import { CURRENT_STATE_SQL, CURRENT_VERSION_SQL } from "../../src/server/store/postgres-state-codec";
import { withDisposablePostgresDatabase, type DisposablePostgresDatabase } from "../support/postgres-test-harness";

const PASSWORD = "postgres-cache-integration-password";
const LISTENER_NAME = "cvg-runtime-state-cache";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => { resolve = yes; });
  return { promise, resolve };
}

async function bounded<T>(operation: Promise<T>): Promise<T> {
  let timer!: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("Committed read did not finish while the local write was held.")), 3_000);
  });
  try { return await Promise.race([operation, timeout]); }
  finally { clearTimeout(timer); }
}

async function listenerRows(database: DisposablePostgresDatabase) {
  const result = await database.query(`SELECT pid FROM pg_stat_activity
    WHERE datname = current_database() AND application_name = $1
      AND state = 'idle' AND query = 'LISTEN cvg_runtime_state_changed'`, [LISTENER_NAME]);
  return result.rows as { pid: number }[];
}

async function waitForListeners(database: DisposablePostgresDatabase, count: number) {
  await vi.waitFor(async () => expect(await listenerRows(database)).toHaveLength(count), { interval: 20, timeout: 3_000 });
}

function eventFixture(): StoreState {
  const state = createDemoState(PASSWORD);
  state.auditEvents = [{
    id: "audit-cache-committed", eventType: "RequestCreated", actorId: "user-vet",
    entityType: "DiagnosticRequest", entityId: "request-cache-committed",
    correlationId: "correlation-cache", metadata: { committed: true }, occurredAt: "2026-10-04T12:00:00.000Z"
  }];
  state.outbox = [{
    // A notification delivery: pending worker work, so it also proves the committed metrics read.
    id: "outbox-cache-committed", eventType: "ResultReleased", aggregateType: "DiagnosticRequest",
    aggregateId: "request-cache-committed", payload: { committed: true, notificationId: "notification-cache-committed" }, consumerType: "NOTIFICATION_DELIVERY",
    routingKey: "notification.in_app", status: "PENDING", attempts: 0,
    availableAt: "2026-10-04T12:00:00.000Z", correlationId: "correlation-cache"
  }];
  return state;
}

describe("PostgreSQL state cache freshness and concurrent read lifecycle", () => {
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

  it("finishes state, narrow authorization/audit/outbox, realtime and health reads against committed data before a held local write is released", async () => {
    vi.stubEnv("DB_POOL_MAX", "4");
    await withDisposablePostgresDatabase(async (database) => {
      const store = await database.createStore(eventFixture());
      await loginUser(store, "vet@cvg.local", PASSWORD);
      const before = await store.readStateSnapshot();
      const session = before.state.sessions[0];
      const entered = deferred<void>();
      const release = deferred<void>();
      let writeFinished = false;
      const write = store.transaction(async (state) => {
        entered.resolve();
        await release.promise;
        return {
          state: { ...state, protocolSequence: state.protocolSequence + 1, users: state.users.map((user) => user.id === "user-vet" ? { ...user, active: false } : user) },
          result: undefined
        };
      }).then(() => { writeFinished = true; });
      let reads: Promise<unknown> | undefined;
      try {
        await bounded(entered.promise);
        reads = Promise.all([
          store.readState(), store.readStateSnapshot(), store.readStateVersion(),
          store.readAuthorizationSnapshot({ userId: "user-vet", sessionId: session.id }),
          store.readAuditEvents({ scope: { entities: [], unresolved: { resolvedEntities: [] } }, order: "asc", limit: 100 }),
          store.readAuditActors([{ entityType: "DiagnosticRequest", entityId: "request-cache-committed" }]),
          store.readAuditMetrics({ requestCount: 1, samples: [], releasedVersions: [] }),
          store.readOutbox({ kind: "replay", limit: 100 }), store.readOutboxMetrics(),
          store.readRealtimeSnapshot(100), store.readSessionActivity(session.id), store.healthcheck()
        ]).then(([state, snapshot, version, auth, audit, actors, metrics, outbox, outboxMetrics, realtime, activity, health]) => {
          expect(state).toEqual(before.state);
          expect(snapshot).toEqual(before);
          expect(version).toBe(before.version);
          expect(auth.user).toMatchObject({ id: "user-vet", active: true });
          expect(auth.session?.id).toBe(session.id);
          expect(audit.items).toContainEqual(expect.objectContaining({ id: "audit-cache-committed" }));
          expect(actors).toContainEqual({ entityId: "request-cache-committed", actorId: "user-vet" });
          expect(metrics.recollectionRate).toBe(0);
          expect(outbox.map((message) => message.id)).toContain("outbox-cache-committed");
          expect(outboxMetrics.pending).toBeGreaterThan(0);
          expect(realtime.version).toBe(before.version);
          expect(realtime.state).toEqual({ ...before.state, outbox });
          expect(activity?.sessionId).toBe(session.id);
          expect(health).toBeUndefined();
          expect(writeFinished).toBe(false);
        });
        await bounded(reads);
      } finally {
        release.resolve();
        await Promise.allSettled([write, ...(reads ? [reads] : [])]);
      }
      expect(writeFinished).toBe(true);
      const after = await store.readStateSnapshot();
      expect(after.version).toBe(before.version + 1);
      expect(after.state.protocolSequence).toBe(before.state.protocolSequence + 1);
      expect(after.state.users.find((user) => user.id === "user-vet")?.active).toBe(false);
    });
  });

  it("returns frozen shared snapshots and immediately observes cross-instance role and session revocation", async () => {
    await withDisposablePostgresDatabase(async (database) => {
      const writer = await database.createStore(createDemoState(PASSWORD));
      const reader = await database.createStore();
      const login = await loginUser(writer, "vet@cvg.local", PASSWORD);
      const request = new Request("http://localhost/api/v1/me", { headers: { cookie: `cvg_session=${login.sessionToken}` } });
      const actor = await authenticateRequest(reader, request);
      const before = await reader.readStateSnapshot();
      const shared = await reader.readState();
      expect(shared).toBe(before.state);
      expect(() => { shared.users[0].displayName = "caller mutation"; }).toThrow(TypeError);
      expect(() => { shared.sessions.length = 0; }).toThrow(TypeError);
      const inspected = reader.getState();
      inspected.users.length = 0;
      const intact = await reader.readStateSnapshot();
      expect(intact.state.sessions).toHaveLength(1);
      expect(intact.state.users[0].displayName).not.toBe("caller mutation");
      expect(intact.state.users[0].displayName).not.toBe("snapshot mutation");
      await writer.transaction((state) => ({
        state: { ...state, users: state.users.map((user) => user.id === actor.id ? { ...user, role: "VIEWER", version: user.version + 1 } : user) },
        result: undefined
      }));
      const changed = await reader.readStateSnapshot();
      expect(changed.version).toBe(intact.version + 1);
      expect(authorizationSnapshotIsCurrent(changed.state, actor)).toBe(false);
      expect((await reader.readAuthorizationSnapshot({ userId: actor.id })).user?.role).toBe("VIEWER");
      await revokeSession(writer, login.sessionToken);
      expect((await reader.readState()).sessions[0]?.revokedAt).toBeTruthy();
      await expect(authenticateRequest(reader, request)).rejects.toMatchObject({ code: "SESSION_EXPIRED", status: 401 });
    });
  });

  it("uses real LISTEN hints to invalidate a same-version cache while retaining a fresh scalar probe", async () => {
    await withDisposablePostgresDatabase(async (database) => {
      const store = await database.createStore(createDemoState(PASSWORD));
      await waitForListeners(database, 1);
      const before = await store.readStateSnapshot();
      await store.readStateSnapshot();
      const queries = vi.spyOn(Pool.prototype, "query");
      await store.readStateSnapshot();
      expect(queries.mock.calls.filter(([sql]) => sql === CURRENT_STATE_SQL)).toHaveLength(0);
      await database.query("SELECT pg_notify('cvg_runtime_state_changed', $1)", ["999999"]);
      await vi.waitFor(async () => {
        expect(await store.readStateSnapshot()).toEqual(before);
        expect(queries.mock.calls.filter(([sql]) => sql === CURRENT_STATE_SQL)).toHaveLength(1);
      }, { interval: 20, timeout: 3_000 });
      expect(queries.mock.calls.filter(([sql]) => sql === CURRENT_VERSION_SQL).length).toBeGreaterThanOrEqual(2);
    });
  });

  it("observes a commit through the scalar fallback after listener disconnect and lost notification", async () => {
    await withDisposablePostgresDatabase(async (database) => {
      const writer = await database.createStore(createDemoState(PASSWORD));
      const reader = await database.createStore();
      await waitForListeners(database, 2);
      const before = await reader.readStateSnapshot();
      const listeners = await listenerRows(database);
      await database.query("SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE pid = ANY($1::int[])", [listeners.map((row) => row.pid)]);
      await waitForListeners(database, 0);
      // Validate the old version after disconnect, then commit while nobody listens.
      expect(await reader.readStateSnapshot()).toEqual(before);
      await writer.transaction((state) => ({ state: { ...state, protocolSequence: state.protocolSequence + 1 }, result: undefined }));
      expect(await listenerRows(database)).toHaveLength(0);
      const changed = await bounded(reader.readStateSnapshot());
      expect(changed.version).toBe(before.version + 1);
      expect(changed.state.protocolSequence).toBe(before.state.protocolSequence + 1);
    });
  });

  it("keeps LISTEN outside a main pool of one connection", async () => {
    vi.stubEnv("DB_POOL_MAX", "1");
    await withDisposablePostgresDatabase(async (database) => {
      const store = await database.createStore(createDemoState(PASSWORD));
      await waitForListeners(database, 1);
      const before = await bounded(store.readStateSnapshot());
      await bounded(store.healthcheck());
      await bounded(store.transaction((state) => ({ state: { ...state, protocolSequence: state.protocolSequence + 1 }, result: undefined })));
      const changed = await bounded(store.readStateSnapshot());
      expect(changed.version).toBe(before.version + 1);
      expect(changed.state.protocolSequence).toBe(before.state.protocolSequence + 1);
      await database.closeStore(store);
      await waitForListeners(database, 0);
    });
  });

  it("drains a real in-flight read before closing and rejects newly requested work", async () => {
    await withDisposablePostgresDatabase(async (database) => {
      const store = await database.createStore(createDemoState(PASSWORD));
      await waitForListeners(database, 1);
      const before = await store.readStateSnapshot();
      const blockerPool = new Pool({ connectionString: database.connectionString(), max: 1 });
      const blocker = await blockerPool.connect();
      let read: Promise<unknown> | undefined;
      let closing: Promise<void> | undefined;
      let closed = false;
      try {
        await blocker.query("BEGIN");
        await blocker.query("LOCK TABLE cvg_runtime_state IN ACCESS EXCLUSIVE MODE");
        read = store.readStateSnapshot();
        await vi.waitFor(async () => {
          const waiting = await database.query(`SELECT pid FROM pg_stat_activity WHERE datname = current_database()
            AND wait_event_type = 'Lock' AND query = $1`, [CURRENT_VERSION_SQL]);
          expect(waiting.rowCount).toBe(1);
        }, { interval: 20, timeout: 3_000 });
        closing = store.close().then(() => { closed = true; });
        await expect(store.readState()).rejects.toThrow(/closing|closed/i);
        await expect(store.readAuthorizationSnapshot({ userId: "user-vet" })).rejects.toThrow(/closing|closed/i);
        await expect(store.transaction((state) => ({ state, result: undefined }))).rejects.toThrow(/closing|closed/i);
        expect(closed).toBe(false);
        await blocker.query("COMMIT");
        await expect(bounded(read)).resolves.toEqual(before);
        await bounded(closing);
        expect(closed).toBe(true);
        await waitForListeners(database, 0);
        await expect(store.close()).resolves.toBeUndefined();
      } finally {
        await blocker.query("ROLLBACK");
        blocker.release();
        await blockerPool.end();
        await Promise.allSettled([...(read ? [read] : []), ...(closing ? [closing] : [])]);
      }
    });
  });

  it("fails closed on an unavailable source relation and recovers after the source returns", async () => {
    await withDisposablePostgresDatabase(async (database) => {
      const writer = await database.createStore(createDemoState(PASSWORD));
      const reader = await database.createStore();
      const before = await reader.readStateSnapshot();
      await database.query("ALTER TABLE cvg_runtime_state RENAME TO cvg_runtime_state_cache_source_unavailable");
      try {
        await expect(reader.readState()).rejects.toThrow(/cvg_runtime_state.*does not exist/i);
        await expect(reader.readStateSnapshot()).rejects.toThrow(/cvg_runtime_state.*does not exist/i);
        expect(reader.getState()).toEqual(before.state);
      } finally {
        await database.query("ALTER TABLE cvg_runtime_state_cache_source_unavailable RENAME TO cvg_runtime_state");
      }
      await writer.transaction((state) => ({ state: { ...state, protocolSequence: state.protocolSequence + 1 }, result: undefined }));
      const recovered = await reader.readStateSnapshot();
      expect(recovered.version).toBe(before.version + 1);
      expect(recovered.state.protocolSequence).toBe(before.state.protocolSequence + 1);
    });
  });
});
