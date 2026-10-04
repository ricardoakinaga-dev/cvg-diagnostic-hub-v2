import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import { readPostgresAuthorizationSnapshot } from "../../src/server/store/postgres-authorization-read";
import { createDemoState } from "../../src/server/store/fixtures";
import {
  deletePostgresProcessedOutbox,
  prunePostgresSessionActivity,
  readPostgresSessionActivity,
  touchPostgresSessionActivity
} from "../../src/server/store/postgres-session-activity";
import { authenticateRequest, loginUser } from "../../src/server/security/session";
import type { PostgresStore } from "../../src/server/store/postgres-store";
import { withDisposablePostgresDatabase } from "../support/postgres-test-harness";
import { Pool } from "pg";

const TEST_PASSWORD = "postgres-session-activity-password";

function poolFor(databaseUrl: string): Pool {
  return new Pool({ connectionString: databaseUrl, max: 2 });
}

/**
 * These seams are the ones production uses but the unit suite cannot prove:
 * the narrow authorization read, the session-activity UPSERT, the retention
 * prune and the runtime-state version read all issue SQL that has to run
 * against real PostgreSQL before it can be trusted (review A-03).
 */
describe("PostgreSQL session activity and narrow reads", () => {
  it("rolls back login when a before-session hook rejects", async () => {
    await withDisposablePostgresDatabase(async (database) => {
      const store = await database.createStore(createDemoState(TEST_PASSWORD));
      const observer = await database.createStore();
      try {
        const before = await observer.readStateSnapshot();
        const failure = new Error("login counter reset failed");
        await expect(loginUser(store, "vet@cvg.local", TEST_PASSWORD, {
          beforeSessionCreate: async () => { throw failure; }
        })).rejects.toBe(failure);
        expect(await observer.readStateSnapshot()).toEqual(before);
        expect(store.getState()).toEqual(before.state);
        expect(await database.query("SELECT count(*)::int AS count FROM session_activity"))
          .toEqual({ rows: [{ count: 0 }], rowCount: 1 });
      } finally {
        await database.closeStore(observer);
        await database.closeStore(store);
      }
    });
  });

  it("rolls back login, activity and snapshot version when activity INSERT fails", async () => {
    await withDisposablePostgresDatabase(async (database) => {
      const store = await database.createStore(createDemoState(TEST_PASSWORD));
      const observer = await database.createStore();
      try {
        const before = await observer.readStateSnapshot();
        expect(before.state.sessions).toHaveLength(0);
        await database.query(`
          CREATE FUNCTION reject_session_activity_insert() RETURNS trigger
          LANGUAGE plpgsql AS $$
          BEGIN
            RAISE EXCEPTION 'SESSION_ACTIVITY_INSERT_INJECTED_FAILURE';
          END;
          $$
        `);
        await database.query(`
          CREATE TRIGGER reject_session_activity_insert
          BEFORE INSERT ON session_activity
          FOR EACH ROW EXECUTE FUNCTION reject_session_activity_insert()
        `);

        await expect(loginUser(store, "vet@cvg.local", TEST_PASSWORD))
          .rejects.toThrow("SESSION_ACTIVITY_INSERT_INJECTED_FAILURE");

        // Read independently from the writer cache to prove durable rollback.
        expect(await observer.readStateSnapshot()).toEqual(before);
        expect(store.getState()).toEqual(before.state);
        expect(await database.query(`
          SELECT version::text AS version, jsonb_array_length(state->'sessions') AS sessions,
                 (SELECT count(*)::int FROM session_activity) AS activity
          FROM cvg_runtime_state WHERE id = 1
        `)).toEqual({ rows: [{ version: String(before.version), sessions: 0, activity: 0 }], rowCount: 1 });

        await database.query("DROP TRIGGER reject_session_activity_insert ON session_activity");
        await database.query("DROP FUNCTION reject_session_activity_insert()");
        const login = await loginUser(store, "vet@cvg.local", TEST_PASSWORD);
        const committed = await observer.readStateSnapshot();
        expect(committed.version).toBe(before.version + 1);
        expect(committed.state.sessions).toHaveLength(1);
        const session = committed.state.sessions[0]!;
        expect(await observer.readSessionActivity(session.id)).toEqual({
          sessionId: session.id, userId: session.userId, lastSeenAt: session.createdAt
        });
        expect(await authenticateRequest(observer, new Request("http://localhost/api/v1/me", {
          headers: { cookie: `cvg_session=${login.sessionToken}` }
        }))).toMatchObject({ email: "vet@cvg.local" });
      } finally {
        await database.closeStore(observer);
        await database.closeStore(store);
      }
    });
  });

  it("keeps last_seen_at monotonic under stale, replayed and concurrent touches", async () => {
    await withDisposablePostgresDatabase(async (database) => {
      const store = await database.createStore(createDemoState(TEST_PASSWORD));
      const pool = poolFor(database.connectionString());
      try {
        await loginUser(store, "vet@cvg.local", TEST_PASSWORD);
        const before = await store.readStateSnapshot();
        const session = before.state.sessions[0]!;
        const initial = Date.parse(session.createdAt);
        const at = (offset: number) => new Date(initial + offset).toISOString();
        const activity = { sessionId: session.id, userId: session.userId };
        expect(await touchPostgresSessionActivity(pool, activity, at(2000))).toEqual({ ...activity, lastSeenAt: at(2000) });
        for (const offset of [1000, 2000, -1000]) {
          expect(await touchPostgresSessionActivity(pool, activity, at(offset))).toEqual({ ...activity, lastSeenAt: at(2000) });
          expect(await store.readSessionActivity(session.id)).toEqual({ ...activity, lastSeenAt: at(2000) });
        }
        await Promise.all([
          touchPostgresSessionActivity(pool, activity, at(4000)),
          touchPostgresSessionActivity(pool, activity, at(3000))
        ]);
        expect(await store.readSessionActivity(session.id)).toEqual({ ...activity, lastSeenAt: at(4000) });
        expect(await store.readStateSnapshot()).toEqual(before);

        // Existing session updates do not initialize activity again.
        await store.transaction((state) => ({
          state: { ...state, sessions: state.sessions.map((entry) => ({ ...entry, createdAt: at(5000), version: entry.version + 1 })) },
          result: undefined
        }));
        expect(await store.readSessionActivity(session.id)).toEqual({ ...activity, lastSeenAt: at(4000) });
      } finally {
        await pool.end();
        await database.closeStore(store);
      }
    });
  });

  it("records liveness in its own table without rewriting the snapshot", async () => {
    await withDisposablePostgresDatabase(async (database) => {
      const store = await database.createStore(createDemoState(TEST_PASSWORD));
      const pool = poolFor(database.connectionString());
      try {
        const login = await loginUser(store, "vet@cvg.local", TEST_PASSWORD);
        const session = store.getState().sessions.at(-1);
        if (!session) throw new Error("fixture session missing");
        const versionBefore = await store.readStateVersion();
        const snapshotBefore = await store.readState();

        const activity = await readPostgresSessionActivity(pool, session.id);
        expect(activity).toMatchObject({ sessionId: session.id, userId: session.userId });
        expect(Date.parse(activity?.lastSeenAt ?? "")).toBeGreaterThan(0);

        const touched = await store.touchSessionActivity({
          sessionId: session.id,
          userId: session.userId,
          lastSeenAt: new Date().toISOString()
        });
        expect(Date.parse(touched.lastSeenAt)).toBeGreaterThanOrEqual(Date.parse(activity?.lastSeenAt ?? ""));

        // Liveness never touches the snapshot row: no version bump, no lock,
        // no aggregate rewrite (the whole point of migration 012).
        expect(await store.readStateVersion()).toBe(versionBefore);
        expect((await store.readState()).sessions).toEqual(snapshotBefore.sessions);
        expect(await database.query("SELECT count(*)::int AS count FROM session_activity")).toEqual({
          rows: [{ count: 1 }],
          rowCount: 1
        });
        expect(await authenticateRequest(
          store,
          new Request("http://localhost/api/v1/me", { headers: { cookie: `cvg_session=${login.sessionToken}` } })
        )).toMatchObject({ email: "vet@cvg.local" });
      } finally {
        await pool.end();
        await database.closeStore(store);
      }
    });
  });

  it("fails closed on a missing row or an unrepresentable liveness timestamp", async () => {
    await withDisposablePostgresDatabase(async (database) => {
      const pool = poolFor(database.connectionString());
      try {
        const store = await database.createStore(createDemoState(TEST_PASSWORD));
        try {
          expect(await readPostgresSessionActivity(pool, "session-does-not-exist")).toBeUndefined();

          // An unrepresentable timestamp must not be read as "recent", or a
          // broken liveness record would keep a session alive forever.
          await database.query(
            "INSERT INTO session_activity (session_id, user_id, last_seen_at) VALUES ($1, $2, 'infinity'::timestamptz)",
            ["session-infinity", "user-vet"]
          );
          await expect(readPostgresSessionActivity(pool, "session-infinity"))
            .rejects.toThrow("POSTGRES_SESSION_ACTIVITY_TIMESTAMP_INVALID");
        } finally {
          await database.closeStore(store);
        }
      } finally {
        await pool.end();
      }
    });
  });

  it("refuses to report liveness or authorization from an incomplete row", async () => {
    const emptyRow = { query: async () => ({ rows: [{}], rowCount: 1 }) };

    await expect(readPostgresAuthorizationSnapshot(emptyRow as unknown as Pool, { userId: "user-vet" }))
      .resolves.toEqual({ user: undefined, session: undefined });
    await expect(readPostgresAuthorizationSnapshot({ query: async () => ({ rows: [], rowCount: 0 }) } as unknown as Pool, { userId: "user-vet" }))
      .rejects.toThrow("PostgreSQL runtime state row is missing.");
    await expect(readPostgresSessionActivity({ query: async () => ({ rows: [], rowCount: 1 }) } as unknown as Pool, "session-1"))
      .rejects.toThrow("POSTGRES_SESSION_ACTIVITY_ROW_MISSING");
    await expect(readPostgresSessionActivity({ query: async () => ({ rows: [{ session_id: "s", user_id: "u", last_seen_at: "not-a-date" }], rowCount: 1 }) } as unknown as Pool, "s"))
      .rejects.toThrow("POSTGRES_SESSION_ACTIVITY_TIMESTAMP_INVALID");

    const noTouchedRow = { query: async () => ({ rows: [], rowCount: 0 }) };
    await expect(touchPostgresSessionActivity(noTouchedRow as unknown as Pool, { sessionId: "s", userId: "u" }, "2026-10-02T12:00:00.000Z"))
      .rejects.toThrow("POSTGRES_SESSION_ACTIVITY_TOUCH_FAILED");
  });

  it("reads one user and session for realtime authorization, scoped to the owner", async () => {
    await withDisposablePostgresDatabase(async (database) => {
      const store = await database.createStore(createDemoState(TEST_PASSWORD));
      const pool = poolFor(database.connectionString());
      try {
        const login = await loginUser(store, "vet@cvg.local", TEST_PASSWORD);
        const session = store.getState().sessions.at(-1);
        if (!session) throw new Error("fixture session missing");

        const scoped = await readPostgresAuthorizationSnapshot(pool, { userId: session.userId, sessionId: session.id });
        expect(scoped.user?.email).toBe("vet@cvg.local");
        expect(scoped.session?.id).toBe(session.id);

        // A session id belonging to somebody else must never be returned.
        const crossAccount = await readPostgresAuthorizationSnapshot(pool, { userId: "user-admin", sessionId: session.id });
        expect(crossAccount.user?.email).toBe("admin@cvg.local");
        expect(crossAccount.session).toBeUndefined();

        const missing = await readPostgresAuthorizationSnapshot(pool, { userId: "user-unknown" });
        expect(missing.user).toBeUndefined();
        expect(missing.session).toBeUndefined();
        expect(login.sessionToken).toEqual(expect.any(String));
      } finally {
        await pool.end();
        await database.closeStore(store);
      }
    });
  });

  it("prunes activity and processed outbox rows in the retention transaction", async () => {
    await withDisposablePostgresDatabase(async (database) => {
      const store = await database.createStore(createDemoState(TEST_PASSWORD));
      try {
        const login = await loginUser(store, "vet@cvg.local", TEST_PASSWORD);
        const session = store.getState().sessions.at(-1);
        if (!session) throw new Error("fixture session missing");
        await store.touchSessionActivity({ sessionId: session.id, userId: session.userId, lastSeenAt: "2026-10-02T12:00:00.000Z" });

        const summary = await store.compactRuntimeState({
          now: new Date(Date.now() + 9 * 24 * 60 * 60 * 1000)
        });

        expect(summary.sessionActivityRowsRemoved).toBeGreaterThanOrEqual(1);
        expect(await database.query("SELECT count(*)::int AS count FROM session_activity")).toEqual({
          rows: [{ count: 0 }],
          rowCount: 1
        });
        // Retention keeps the JSONB projection and the relational outbox in
        // exact agreement, which is what runtime readiness asserts.
        const outboxCounts = await database.query(
          `SELECT jsonb_array_length(state->'outbox')::text AS snapshot,
                  (SELECT count(*) FROM outbox_messages)::text AS relational
             FROM cvg_runtime_state WHERE id = 1`
        );
        const [snapshotCount, relationalCount] = Object.values(outboxCounts.rows[0] ?? {}).map(Number);
        expect(snapshotCount).toBeGreaterThanOrEqual(0);
        expect(snapshotCount).toBe(relationalCount);
        const auditEvent = store.getState().auditEvents.at(-1);
        expect(auditEvent?.eventType).toBe("RuntimeStateRetentionApplied");
      } finally {
        await database.closeStore(store);
      }
    });
  });

  it("keeps the runtime-state version guard in step with committed writes", async () => {
    await withDisposablePostgresDatabase(async (database) => {
      const store: PostgresStore = await database.createStore(createDemoState(TEST_PASSWORD));
      const other = await database.createStore();
      try {
        const initial = await store.readStateSnapshot();
        expect(initial.version).toBeGreaterThanOrEqual(1);
        expect(await store.readStateVersion()).toBe(initial.version);

        await other.transaction((state) => ({
          state: { ...state, protocolSequence: state.protocolSequence + 1 },
          result: undefined
        }));

        // The integer guard is what lets realtime skip a second aggregate read
        // when nothing changed, so it must move with every committed write.
        expect(await store.readStateVersion()).toBe(initial.version + 1);
        expect((await store.readStateSnapshot()).version).toBe(initial.version + 1);
      } finally {
        await database.closeStore(other);
        await database.closeStore(store);
      }
    });
  });

  it("seeds one idle window for sessions created before the activity table", async () => {
    await withDisposablePostgresDatabase(async (database) => {
      const token = "legacy-session-token";
      const now = Date.now();
      const legacySession = {
        id: "legacy-session",
        userId: "user-vet",
        tokenHash: createHash("sha256").update(token).digest("hex"),
        csrfTokenHash: createHash("sha256").update("legacy-csrf-token").digest("hex"),
        createdAt: new Date(now - 24 * 60 * 60 * 1000).toISOString(),
        expiresAt: new Date(now + 2 * 60 * 60 * 1000).toISOString(),
        version: 1
      };
      const state = { ...createDemoState(TEST_PASSWORD), sessions: [legacySession] };
      const store = await database.createStore(state);
      const pool = poolFor(database.connectionString());
      let clock: ReturnType<typeof vi.spyOn> | undefined;
      vi.stubEnv("SESSION_IDLE_TIMEOUT_MS", "60000");
      vi.stubEnv("SESSION_ACTIVITY_TOUCH_INTERVAL_MS", "60000");
      try {
        const before = await store.readStateSnapshot();
        expect(before.state.sessions).toEqual([legacySession]);
        expect(await store.readSessionActivity(legacySession.id)).toBeUndefined();

        // The harness migrated before inserting the snapshot. Recreate the
        // pre-012 schema with the real legacy session already persisted.
        await database.query("DROP TABLE session_activity");
        expect(await database.query("SELECT to_regclass('session_activity') AS activity_table"))
          .toEqual({ rows: [{ activity_table: null }], rowCount: 1 });
        const migrationSql = await readFile(new URL("../../db/migrations/012_session_activity.sql", import.meta.url), "utf8");
        const deploymentBefore = await pool.query<{ at: Date }>("SELECT clock_timestamp() AS at");
        await database.query(migrationSql);
        const deploymentAfter = await pool.query<{ at: Date }>("SELECT clock_timestamp() AS at");

        // Assert the migration's persisted result before authentication could
        // renew it: deploy time must replace the day-old creation reference.
        const seeded = await store.readSessionActivity(legacySession.id);
        expect(seeded).toMatchObject({ sessionId: legacySession.id, userId: legacySession.userId });
        const seededAt = Date.parse(seeded?.lastSeenAt ?? "");
        expect(seededAt).toBeGreaterThanOrEqual(deploymentBefore.rows[0]!.at.getTime());
        expect(seededAt).toBeLessThanOrEqual(deploymentAfter.rows[0]!.at.getTime());
        expect(seededAt - Date.parse(legacySession.createdAt)).toBeGreaterThan(60000);
        expect(await pool.query("SELECT count(*)::int AS count FROM session_activity"))
          .toMatchObject({ rows: [{ count: 1 }] });

        const request = new Request("http://localhost/api/v1/me", { headers: { cookie: `cvg_session=${token}` } });
        clock = vi.spyOn(Date, "now").mockReturnValue(seededAt + 59999);
        expect(await authenticateRequest(store, request))
          .toMatchObject({ id: legacySession.userId, sessionId: legacySession.id });
        expect(await store.readSessionActivity(legacySession.id)).toEqual(seeded);
        vi.mocked(Date.now).mockReturnValue(seededAt + 60000);
        await expect(authenticateRequest(store, request)).rejects.toMatchObject({ code: "SESSION_EXPIRED", status: 401 });
        expect(await store.readStateSnapshot()).toEqual(before);
      } finally {
        clock?.mockRestore();
        vi.unstubAllEnvs();
        await pool.end();
        await database.closeStore(store);
      }
    });
  });

  it("reports how many activity rows a prune removed", async () => {
    await withDisposablePostgresDatabase(async (database) => {
      const store = await database.createStore(createDemoState(TEST_PASSWORD));
      const pool = poolFor(database.connectionString());
      const client = await pool.connect();
      try {
        expect(await prunePostgresSessionActivity(client, [])).toBe(0);
        expect(await deletePostgresProcessedOutbox(client, [])).toBe(0);
      } finally {
        client.release();
        await pool.end();
        await database.closeStore(store);
      }
    });
  });
});
