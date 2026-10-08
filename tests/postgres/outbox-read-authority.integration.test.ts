import { randomUUID } from "node:crypto";
import { copyFile, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";
import { requireActiveUser, requirePermission } from "../../src/server/application/service-common";
import type { Notification, OutboxMessage, StoreState, User } from "../../src/server/domain/models";
import { refreshOperationalMetrics, renderPrometheus, resetMetrics } from "../../src/server/observability/metrics";
import { createRealtimeResponse, type RealtimeAccessPolicy } from "../../src/server/observability/realtime-stream";
import { createPostgresOutboxSink, discardDeadLetterMessage, listDeadLetterMessages, processOutboxBatch, reprocessDeadLetterMessage, type DeadLetterCommand, type OutboxSink } from "../../src/server/operations/outbox";
import { createDemoState } from "../../src/server/store/fixtures";
import { MemoryStore } from "../../src/server/store/memory-store";
import { applyMigrations, RUNTIME_MIGRATION_VERSIONS, type SqlQueryable } from "../../src/server/store/migrations";
import { readPostgresOutbox } from "../../src/server/store/postgres-outbox-read";
import { withDisposablePostgresDatabase, type DisposablePostgresDatabase } from "../support/postgres-test-harness";

const TIME = "2026-10-04T12:00:00.000Z";
const NOW = new Date(TIME);
const CUTOVER = "014_outbox_read_authority";
const MIGRATIONS = path.resolve(process.cwd(), "db/migrations");
const ALL_AUDITS = { scope: { entities: [], unresolved: { resolvedEntities: [] } }, order: "asc" as const, limit: 1000 };

function message(id: string, overrides: Partial<OutboxMessage> = {}): OutboxMessage {
  return { id, eventType: "SyntheticOutboxEvidence", aggregateType: "DiagnosticRequest", aggregateId: `request-${id}`,
    payload: { synthetic: true }, consumerType: "DOMAIN_EVENT", routingKey: "domain.SyntheticOutboxEvidence",
    status: "PENDING", attempts: 0, availableAt: TIME, correlationId: `correlation-${id}`, ...overrides };
}

function notification(id: string, state: Notification["state"] = "PENDING"): Notification {
  return { id, category: "ACTIONABLE", priority: "HIGH", recipientUserId: "user-vet", entityType: "REQUEST",
    entityId: `request-${id}`, deepLink: `/requests/request-${id}`, title: "Synthetic delivery", body: "PostgreSQL integration evidence",
    dedupeKey: id, state, createdAt: TIME, attempts: 0, version: 1 };
}

function delivery(id: string, overrides: Partial<OutboxMessage> = {}): OutboxMessage {
  return message(id, { eventType: "ResultReleased", consumerType: "NOTIFICATION_DELIVERY", routingKey: "notification.in_app",
    payload: { notificationId: `notification-${id}` }, ...overrides });
}

function fixture(outbox: OutboxMessage[] = [], notifications: Notification[] = []): StoreState {
  return { ...createDemoState("postgres-outbox-synthetic-password"), outbox, notifications };
}

function postgresSink(database: DisposablePostgresDatabase) {
  return createPostgresOutboxSink({ query: async (text, values) => {
    const result = await database.query(text, values);
    return { rows: result.rows as Record<string, unknown>[], rowCount: result.rowCount };
  } });
}

function command(actor: User, key: string): DeadLetterCommand {
  return { actorId: actor.id, correlationId: `correlation-${key}`, idempotencyKey: key, reason: "Synthetic operational recovery", now: () => NOW,
    authorize: (state) => requirePermission(requireActiveUser(state, actor), "outbox.manage", {}) };
}

async function durableEvidence(database: DisposablePostgresDatabase) {
  return {
    snapshot: await database.query("SELECT state, state::text AS bytes, pg_column_size(state)::int AS size, version::text, updated_at FROM cvg_runtime_state WHERE id = 1"),
    outbox: await database.query("SELECT * FROM outbox_messages ORDER BY id"),
    audits: await database.query("SELECT * FROM audit_events ORDER BY id"),
    notifications: await database.query("SELECT * FROM notifications ORDER BY id"),
    deliveries: await database.query("SELECT * FROM notification_deliveries ORDER BY id")
  };
}

interface MigrationProbe {
  sql: SqlQueryable;
  query: SqlQueryable["query"];
  upgrade(): ReturnType<typeof applyMigrations>;
}

async function with013Probe(database: DisposablePostgresDatabase, operation: (probe: MigrationProbe) => Promise<void>) {
  const schema = `outbox_upgrade_${process.pid}_${randomUUID().replaceAll("-", "")}`;
  if (!/^outbox_upgrade_[0-9]+_[a-f0-9]{32}$/.test(schema)) throw new Error("Invalid outbox upgrade schema.");
  const directory = await mkdtemp(path.join(os.tmpdir(), "cvg-outbox-upgrade-"));
  const pool = new Pool({ connectionString: database.connectionString(), max: 1 });
  try {
    await Promise.all(RUNTIME_MIGRATION_VERSIONS.filter((version) => version < CUTOVER).map((version) =>
      copyFile(path.join(MIGRATIONS, `${version}.sql`), path.join(directory, `${version}.sql`))));
    const client = await pool.connect();
    try {
      await client.query(`CREATE SCHEMA "${schema}"`);
      await client.query(`SET search_path TO "${schema}", public`);
      const sql: SqlQueryable = { query: async (text, values) => {
        const result = await client.query(text, values);
        return { rows: result.rows as readonly unknown[], rowCount: result.rowCount };
      } };
      await applyMigrations(sql, { migrationDirectory: directory, logger: { info: () => undefined } });
      // Upgrade through this cutover only; later migrations have their own suites.
      await copyFile(path.join(MIGRATIONS, `${CUTOVER}.sql`), path.join(directory, `${CUTOVER}.sql`));
      await operation({ sql, query: sql.query, upgrade: () => applyMigrations(sql, { migrationDirectory: directory, logger: { info: () => undefined } }) });
    } finally {
      client.release();
    }
  } finally {
    await pool.end();
    await rm(directory, { recursive: true, force: true });
    await database.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
  }
}

async function insertMessage(probe: MigrationProbe, entry: OutboxMessage) {
  await probe.query(`INSERT INTO outbox_messages (id, event_type, aggregate_type, aggregate_id, payload, consumer_type, routing_key,
    status, attempts, available_at, correlation_id, locked_at, worker_id, claim_token, last_error, dead_lettered_at, discarded_at, discarded_by, discard_reason)
    VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)`,
  [entry.id, entry.eventType, entry.aggregateType, entry.aggregateId, JSON.stringify(entry.payload), entry.consumerType, entry.routingKey,
    entry.status, entry.attempts, entry.availableAt, entry.correlationId, entry.lockedAt ?? null, entry.workerId ?? null, entry.claimToken ?? null,
    entry.lastError ?? null, entry.deadLetteredAt ?? null, entry.discardedAt ?? null, entry.discardedBy ?? null, entry.discardReason ?? null]);
}

async function migrationEvidence(probe: MigrationProbe) {
  return {
    snapshot: await probe.query("SELECT state, state::text AS bytes, version::text, updated_at FROM cvg_runtime_state WHERE id = 1"),
    table: await probe.query("SELECT * FROM outbox_messages ORDER BY id"),
    ledger: await probe.query("SELECT * FROM schema_migrations ORDER BY version"),
    marker: await probe.query("SELECT * FROM relational_schema_markers"),
    boundaries: await probe.query("SELECT * FROM runtime_storage_boundaries ORDER BY boundary_key"),
    artifacts: await probe.query(`SELECT
      (SELECT count(*)::int FROM pg_constraint WHERE conrelid = 'cvg_runtime_state'::regclass AND conname = 'runtime_outbox_is_transient') AS guard,
      (SELECT count(*)::int FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'outbox_messages' AND column_name = 'event_position') AS position,
      (SELECT count(*)::int FROM pg_indexes WHERE schemaname = current_schema() AND indexname IN ('outbox_messages_replay_idx', 'outbox_messages_claim_position_idx')) AS indexes`)
  };
}

describe("PROD-102 PostgreSQL outbox read authority", () => {
  it("keeps snapshot bytes fixed through processed history growth and worker status changes without growing idempotency", async () => {
    await withDisposablePostgresDatabase(async (database) => {
      // A delivered notification lets this isolate delivery-history growth from domain growth.
      const pending = delivery("growth-delivery");
      const store = await database.createStore(fixture([pending], [notification("notification-growth-delivery", "DELIVERED")]));
      const observer = await database.createStore();
      const before = await database.query("SELECT state::text AS bytes, pg_column_size(state)::int AS size, version::text FROM cvg_runtime_state WHERE id = 1");
      const initial = before.rows[0] as { bytes: string; size: number; version: string };
      const history = Array.from({ length: 250 }, (_, index) => message(`growth-${index}`, {
        status: "PROCESSED", payload: { synthetic: true, large: "outbox-history".repeat(100) }
      }));
      for (let offset = 0; offset < history.length; offset += 50) {
        await store.transaction((state) => {
          expect(state.outbox).toEqual([]);
          return { state: { ...state, outbox: history.slice(offset, offset + 50) }, result: undefined };
        });
        expect(store.getState().outbox).toEqual([]);
      }
      expect(await processOutboxBatch(store, postgresSink(database), { now: () => NOW, workerId: "growth-worker", batchSize: 1 }))
        .toEqual({ claimed: 1, processed: 1, retried: 0, failed: 0 });
      const after = await database.query("SELECT state::text AS bytes, pg_column_size(state)::int AS size, version::text FROM cvg_runtime_state WHERE id = 1");
      expect(after.rows).toEqual([{ ...initial, version: String(Number(initial.version) + 7) }]);
      expect((await observer.readState()).outbox).toEqual([]);
      expect(await database.query("SELECT status, count(*)::int AS count FROM outbox_messages GROUP BY status")).toEqual({ rows: [{ status: "PROCESSED", count: 251 }], rowCount: 1 });
      await database.closeStore(store);
      await database.closeStore(observer);
      const reopened = await database.createStore();
      expect(reopened.getState().outbox).toEqual([]);
      expect(await reopened.readOutbox({ kind: "replay", limit: 1000 })).toEqual(history.slice(-100));
      await expect(reopened.healthcheck()).resolves.toBeUndefined();
    });

  });

  it("serializes concurrent worker claims, selects supported due routes, and persists one delivery and audit per notification", async () => {
    await withDisposablePostgresDatabase(async (database) => {
      const entries = [message("unsupported"), delivery("future", { availableAt: "2026-10-05T12:00:00.000Z" }), delivery("worker-a"), delivery("worker-b")];
      const first = await database.createStore(fixture(entries, entries.filter((entry) => entry.consumerType === "NOTIFICATION_DELIVERY").map((entry) => notification(String(entry.payload.notificationId)))));
      const second = await database.createStore();
      const sink = postgresSink(database);
      const publish = vi.fn(sink.publish);
      const results = await Promise.all([first, second].map((store, index) => processOutboxBatch(store, { ...sink, publish }, { now: () => NOW, workerId: `worker-${index}`, batchSize: 1 })));
      expect(results).toEqual([{ claimed: 1, processed: 1, retried: 0, failed: 0 }, { claimed: 1, processed: 1, retried: 0, failed: 0 }]);
      expect(publish.mock.calls.map(([entry]) => entry.id).sort()).toEqual(["worker-a", "worker-b"]);
      expect(await database.query("SELECT id, status, attempts, locked_at, worker_id, claim_token FROM outbox_messages WHERE id LIKE 'worker-%' ORDER BY id"))
        .toEqual({ rows: ["worker-a", "worker-b"].map((id) => ({ id, status: "PROCESSED", attempts: 1, locked_at: null, worker_id: null, claim_token: null })), rowCount: 2 });
      expect(await database.query("SELECT notification_id, status, attempts FROM notification_deliveries ORDER BY notification_id"))
        .toEqual({ rows: ["notification-worker-a", "notification-worker-b"].map((notification_id) => ({ notification_id, status: "DELIVERED", attempts: 1 })), rowCount: 2 });
      expect((await second.readState()).notifications.filter((entry) => entry.state === "DELIVERED").map((entry) => entry.id).sort()).toEqual(["notification-worker-a", "notification-worker-b"]);
      expect((await second.readAuditEvents(ALL_AUDITS)).items.map((event) => [event.eventType, event.entityId]).sort())
        .toEqual([["NotificationDelivered", "notification-worker-a"], ["NotificationDelivered", "notification-worker-b"]]);
      expect((await second.readOutbox({ kind: "replay", limit: 100 })).filter((entry) => ["unsupported", "future"].includes(entry.id))).toEqual(entries.slice(0, 2));
      await first.transaction((state) => ({
        state: { ...state,
          notifications: [...state.notifications, notification("notification-after-prefix")],
          outbox: [...Array.from({ length: 105 }, (_, index) => message(`route-prefix-${index}`)), delivery("after-prefix")]
        }, result: undefined
      }));
      expect(await processOutboxBatch(second, { ...sink, publish }, { now: () => NOW, workerId: "paged-selector", batchSize: 1 }))
        .toEqual({ claimed: 1, processed: 1, retried: 0, failed: 0 });
      expect(publish.mock.calls.at(-1)?.[0].id).toBe("after-prefix");
      expect(await database.query(`SELECT count(*)::int AS count,
        bool_and(status = 'PENDING' AND attempts = 0 AND locked_at IS NULL AND worker_id IS NULL AND claim_token IS NULL) AS untouched
        FROM outbox_messages WHERE id LIKE 'route-prefix-%'`)).toEqual({ rows: [{ count: 105, untouched: true }], rowCount: 1 });
      expect(await database.query("SELECT status, attempts FROM outbox_messages WHERE id = 'unsupported'"))
        .toEqual({ rows: [{ status: "PENDING", attempts: 0 }], rowCount: 1 });
      expect((await second.readState()).notifications.find((entry) => entry.id === "notification-after-prefix"))
        .toMatchObject({ state: "DELIVERED", version: 2 });
      await database.closeStore(first);
      await database.closeStore(second);
      const reopened = await database.createStore();
      expect((await reopened.readState()).outbox).toEqual([]);
      expect(await database.query("SELECT count(*)::int AS count FROM outbox_messages WHERE status = 'PROCESSED'"))
        .toEqual({ rows: [{ count: 3 }], rowCount: 1 });
      expect((await reopened.readOutbox({ kind: "replay", limit: 100 })).find((entry) => entry.id === "after-prefix"))
        .toMatchObject({ status: "PROCESSED", attempts: 1 });
      await expect(reopened.healthcheck()).resolves.toBeUndefined();
    });
  });

  it("reclaims an expired lease and rejects the original worker's late completion", async () => {
    await withDisposablePostgresDatabase(async (database) => {
      const first = await database.createStore(fixture([delivery("lease")], [notification("notification-lease")]));
      const second = await database.createStore();
      const sink = postgresSink(database);
      let releasePublish: () => void = () => undefined;
      let claimObserved: () => void = () => undefined;
      const publishing = new Promise<void>((resolve) => { claimObserved = resolve; });
      const released = new Promise<void>((resolve) => { releasePublish = resolve; });
      let currentTime = NOW;
      const delayedSink: OutboxSink = { ...sink, publish: async (entry) => {
        const confirmation = await sink.publish(entry);
        claimObserved();
        await released;
        return confirmation;
      } };
      const original = processOutboxBatch(first, delayedSink, { now: () => currentTime, workerId: "original", leaseMs: 1000, batchSize: 1 });
      try {
        await Promise.race([publishing, original.then(() => { throw new Error("Worker completed before the controlled lease race."); })]);
        const oldClaim = await database.query("SELECT worker_id, claim_token, attempts FROM outbox_messages WHERE id = 'lease'");
        expect(oldClaim.rows).toMatchObject([{ worker_id: "original", claim_token: expect.stringMatching(/^[a-f0-9-]{36}$/), attempts: 1 }]);
        expect(await processOutboxBatch(second, sink, { now: () => NOW, workerId: "early", leaseMs: 1000, batchSize: 1 })).toEqual({ claimed: 0, processed: 0, retried: 0, failed: 0 });
        currentTime = new Date(NOW.getTime() + 1001);
        expect(await processOutboxBatch(second, sink, { now: () => currentTime, workerId: "replacement", leaseMs: 1000, batchSize: 1 })).toEqual({ claimed: 1, processed: 1, retried: 0, failed: 0 });
        const settled = await durableEvidence(database);
        releasePublish();
        expect(await original).toEqual({ claimed: 1, processed: 0, retried: 0, failed: 0 });
        // The sink is idempotent, and stale ownership cannot change notification/audit evidence.
        const after = await durableEvidence(database);
        expect(after.outbox).toEqual(settled.outbox);
        expect(after.notifications).toEqual(settled.notifications);
        expect(after.deliveries).toEqual(settled.deliveries);
        expect(after.audits).toEqual(settled.audits);
        expect((await second.readOutbox({ kind: "replay", limit: 1 }))[0]).toMatchObject({ id: "lease", status: "PROCESSED", attempts: 2 });
      } finally {
        releasePublish();
        await original;
      }
    });
  });

  it("persists retry/backoff and exhaustion, enforces fresh RBAC on idempotent recovery, and rolls back all dead-letter effects on a late write failure", async () => {
    await withDisposablePostgresDatabase(async (database) => {
      const store = await database.createStore(fixture([delivery("recover"), delivery("discard", { status: "FAILED", attempts: 2, deadLetteredAt: TIME, lastError: "Synthetic failure" })], [notification("notification-recover"), notification("notification-discard", "FAILED")]));
      const observer = await database.createStore();
      const failingSink: OutboxSink = { supportsRoute: (entry) => entry.consumerType === "NOTIFICATION_DELIVERY", publish: async () => { throw new Error("Synthetic downstream failure"); } };
      const options = { now: () => NOW, workerId: "retry", batchSize: 1, maxAttempts: 2, baseDelayMs: 1000 };
      expect(await processOutboxBatch(store, failingSink, options)).toEqual({ claimed: 1, processed: 0, retried: 1, failed: 0 });
      expect((await observer.readOutbox({ kind: "replay", limit: 100 }))[0]).toMatchObject({ id: "recover", attempts: 1, status: "PENDING", availableAt: "2026-10-04T12:00:01.000Z", lastError: "Synthetic downstream failure" });
      expect(await processOutboxBatch(store, failingSink, options)).toEqual({ claimed: 0, processed: 0, retried: 0, failed: 0 });
      expect(await processOutboxBatch(store, failingSink, { ...options, now: () => new Date(NOW.getTime() + 1000) })).toEqual({ claimed: 1, processed: 0, retried: 0, failed: 1 });
      expect((await listDeadLetterMessages(observer)).find((entry) => entry.id === "recover")).toMatchObject({ status: "FAILED", attempts: 2, deadLetteredAt: "2026-10-04T12:00:01.000Z" });
      expect((await observer.readState()).notifications.find((entry) => entry.id === "notification-recover")).toMatchObject({ state: "FAILED", version: 2 });
      const admin = store.getState().users.find((entry) => entry.id === "user-admin")!;
      const vet = store.getState().users.find((entry) => entry.id === "user-vet")!;
      const recovery = command(admin, "recover-once");
      const beforeDenied = await durableEvidence(database);
      await expect(reprocessDeadLetterMessage(observer, "recover", command(vet, "forbidden"))).rejects.toMatchObject({ code: "SCOPE_DENIED", status: 404 });
      expect(await durableEvidence(database)).toEqual(beforeDenied);
      await database.query(`CREATE FUNCTION reject_outbox_action() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
        IF OLD.id = 'recover' AND NEW.status = 'PENDING' THEN RAISE EXCEPTION 'LATE_OUTBOX_ACTION_TEST_FAILURE'; END IF; RETURN NEW; END; $$`);
      await database.query("CREATE TRIGGER reject_outbox_action BEFORE UPDATE ON outbox_messages FOR EACH ROW EXECUTE FUNCTION reject_outbox_action()");
      await expect(reprocessDeadLetterMessage(store, "recover", recovery)).rejects.toThrow("LATE_OUTBOX_ACTION_TEST_FAILURE");
      expect(await durableEvidence(database)).toEqual(beforeDenied);
      await database.query("DROP TRIGGER reject_outbox_action ON outbox_messages");
      const recovered = await reprocessDeadLetterMessage(store, "recover", recovery);
      expect(recovered).toMatchObject({ action: "REPROCESSED", message: { id: "recover", status: "PENDING", attempts: 0 } });
      const afterRecovery = await durableEvidence(database);
      expect(await reprocessDeadLetterMessage(observer, "recover", recovery)).toEqual(recovered);
      expect((await durableEvidence(database)).audits).toEqual(afterRecovery.audits);
      const beforeConflict = await durableEvidence(database);
      await expect(reprocessDeadLetterMessage(observer, "recover", { ...recovery, reason: "Different payload" })).rejects.toMatchObject({ code: "IDEMPOTENCY_KEY_REUSED", status: 409 });
      expect(await durableEvidence(database)).toEqual(beforeConflict);
      const discard = command(admin, "discard-once");
      const discarded = await discardDeadLetterMessage(observer, "discard", discard);
      expect(discarded).toMatchObject({ action: "DISCARDED", message: { discardedBy: admin.id, discardReason: discard.reason, discardedAt: TIME } });
      await database.closeStore(store);
      await database.closeStore(observer);
      const reopened = await database.createStore();
      expect(await discardDeadLetterMessage(reopened, "discard", discard)).toEqual(discarded);
      expect(await reprocessDeadLetterMessage(reopened, "recover", recovery)).toEqual(recovered);
      expect((await reopened.readState()).idempotency.map((entry) => entry.key).sort()).toEqual(["discard-once", "recover-once"]);
      expect((await reopened.readAuditEvents(ALL_AUDITS)).items.map((event) => event.eventType).sort()).toEqual(["NotificationDeliveryFailed", "NotificationDeliveryRequeued", "OutboxDeadLetterDiscarded", "OutboxDeadLetterReprocessed"]);
      expect((await reopened.readState()).notifications.find((entry) => entry.id === "notification-recover")).toMatchObject({ state: "PENDING", version: 3 });
      const beforeDeliveryDiscard = await database.query("SELECT * FROM outbox_messages WHERE id = 'discard'");
      expect(await processOutboxBatch(reopened, postgresSink(database), { now: () => NOW, workerId: "recovered-worker", batchSize: 10 }))
        .toEqual({ claimed: 1, processed: 1, retried: 0, failed: 0 });
      expect(await database.query("SELECT * FROM outbox_messages WHERE id = 'discard'")).toEqual(beforeDeliveryDiscard);
      expect((await reopened.readState()).notifications.find((entry) => entry.id === "notification-recover")).toMatchObject({ state: "DELIVERED", version: 4 });
      expect(await reprocessDeadLetterMessage(reopened, "recover", recovery)).toEqual(recovered);
      expect((await reopened.readOutbox({ kind: "replay", limit: 100 })).find((entry) => entry.id === "recover")).toMatchObject({ status: "PROCESSED", attempts: 1 });
      await reopened.transaction((state) => ({ state: { ...state, users: state.users.map((entry) => entry.id === admin.id ? { ...entry, role: "VIEWER", version: entry.version + 1 } : entry) }, result: undefined }));
      const beforeRevokedReplay = await durableEvidence(database);
      await expect(discardDeadLetterMessage(reopened, "discard", discard)).rejects.toMatchObject({ code: "UNAUTHENTICATED", status: 401 });
      expect(await durableEvidence(database)).toEqual(beforeRevokedReplay);
    });
  });

  it("audits repeated dead-letter failures distinctly and delivers once after two operator reprocess cycles", async () => {
    await withDisposablePostgresDatabase(async (database) => {
      const id = "repeat-failure";
      const notificationId = `notification-${id}`;
      const store = await database.createStore(fixture([delivery(id)], [notification(notificationId)]));
      const observer = await database.createStore();
      const admin = store.getState().users.find((entry) => entry.id === "user-admin")!;
      const failingSink: OutboxSink = { supportsRoute: (entry) => entry.consumerType === "NOTIFICATION_DELIVERY", publish: async () => { throw new Error("Synthetic repeat failure"); } };
      for (let cycle = 0; cycle < 2; cycle += 1) {
        await expect(processOutboxBatch(store, failingSink, { now: () => NOW, workerId: `failure-cycle-${cycle}`, batchSize: 1, maxAttempts: 1 }))
          .resolves.toEqual({ claimed: 1, processed: 0, retried: 0, failed: 1 });
        expect(await database.query("SELECT status, attempts, locked_at, worker_id, claim_token FROM outbox_messages WHERE id = $1", [id]))
          .toEqual({ rows: [{ status: "FAILED", attempts: 1, locked_at: null, worker_id: null, claim_token: null }], rowCount: 1 });
        expect((await observer.readState()).notifications.find((entry) => entry.id === notificationId))
          .toMatchObject({ state: "FAILED", version: 2 + cycle * 2 });
        const failures = (await observer.readAuditEvents(ALL_AUDITS)).items.filter((event) => event.eventType === "NotificationDeliveryFailed" && event.entityId === notificationId);
        expect(failures).toHaveLength(cycle + 1);
        expect(new Set(failures.map((event) => event.id)).size).toBe(cycle + 1);
        expect(failures.every((event) => event.previousState === "PENDING" && event.newState === "FAILED" && event.metadata.outboxId === id)).toBe(true);
        await expect(reprocessDeadLetterMessage(observer, id, command(admin, `repeat-reprocess-${cycle}`)))
          .resolves.toMatchObject({ action: "REPROCESSED", message: { id, status: "PENDING", attempts: 0 } });
      }
      await expect(processOutboxBatch(store, postgresSink(database), { now: () => NOW, workerId: "repeat-recovered", batchSize: 1 }))
        .resolves.toEqual({ claimed: 1, processed: 1, retried: 0, failed: 0 });
      await expect(processOutboxBatch(observer, postgresSink(database), { now: () => NOW, workerId: "repeat-idle", batchSize: 1 }))
        .resolves.toEqual({ claimed: 0, processed: 0, retried: 0, failed: 0 });
      const settled = await durableEvidence(database);
      const history = await observer.readAuditEvents(ALL_AUDITS);
      const transitions = history.items.filter((event) => event.entityId === notificationId && ["NotificationDeliveryFailed", "NotificationDelivered"].includes(event.eventType));
      expect(transitions.filter((event) => event.eventType === "NotificationDeliveryFailed")).toHaveLength(2);
      expect(transitions.filter((event) => event.eventType === "NotificationDelivered")).toHaveLength(1);
      expect(new Set(transitions.map((event) => event.id)).size).toBe(3);
      expect(await database.query("SELECT notification_id, status, attempts, version FROM notification_deliveries WHERE notification_id = $1", [notificationId]))
        .toEqual({ rows: [{ notification_id: notificationId, status: "DELIVERED", attempts: 1, version: 1 }], rowCount: 1 });
      await database.closeStore(store);
      await database.closeStore(observer);
      const reopened = await database.createStore();
      expect(await durableEvidence(database)).toEqual(settled);
      expect(await reopened.readAuditEvents(ALL_AUDITS)).toEqual(history);
      const snapshot = await reopened.readState();
      expect(snapshot.outbox).toEqual([]);
      expect(snapshot.auditEvents).toEqual([]);
      expect(snapshot.notifications.find((entry) => entry.id === notificationId)).toMatchObject({ state: "DELIVERED", version: 6 });
      expect(snapshot.idempotency.map((entry) => entry.key).sort()).toEqual(["repeat-reprocess-0", "repeat-reprocess-1"]);
      expect(await reopened.readOutbox({ kind: "dead-letter", limit: 100 })).toEqual([]);
      expect(await reopened.readOutbox({ kind: "replay", limit: 100 })).toEqual([delivery(id, { status: "PROCESSED", attempts: 1 })]);
      await expect(reopened.healthcheck()).resolves.toBeUndefined();
    });
  });

  it("replays by insertion order despite mutable retry availability, honors Last-Event-ID, and returns one bounded MVCC state/version", async () => {
    vi.stubEnv("REALTIME_REPLAY_WINDOW", "100");
    try {
      await withDisposablePostgresDatabase(async (database) => {
        // Reverse lexical IDs distinguish seed insertion order from timestamp/ID ordering.
        const entries = Array.from({ length: 105 }, (_, index) => message(`replay-${String(104 - index).padStart(3, "0")}`, { status: "PROCESSED" }));
        const store = await database.createStore(fixture(entries));
        const observer = await database.createStore();
        await store.outboxTransaction({ kind: "message", id: entries[100].id }, (state) => {
          expect(state.outbox.map((entry) => entry.id)).toEqual([entries[100].id]);
          return { state: { ...state, outbox: state.outbox.map((entry) => ({ ...entry, status: "PENDING", attempts: 1, availableAt: "2026-10-06T12:00:00.000Z" })) }, result: undefined };
        });
        expect((await observer.readOutbox({ kind: "replay", limit: 1000 })).map((entry) => entry.id)).toEqual(entries.slice(-100).map((entry) => entry.id));
        expect((await observer.readRealtimeSnapshot(3)).state.outbox.map((entry) => entry.id)).toEqual(entries.slice(-3).map((entry) => entry.id));
        const actor = store.getState().users.find((entry) => entry.id === "user-admin")!;
        const policy: RealtimeAccessPolicy = { isAuthorized: () => true, eventVisible: () => true, authorizationError: () => new Error("Synthetic authorization failure") };
        const response = await createRealtimeResponse(observer, actor, "replay-correlation", entries[100].id, true, new Request("http://localhost/api/v1/events?snapshot=true"), policy);
        const payload = await response.text();
        expect(payload.match(/^id: .+$/gm)).toEqual(entries.slice(101).map((entry) => `id: ${entry.id}`));
        expect(payload).not.toContain("resync_required");
        const expired = await createRealtimeResponse(observer, actor, "expired-correlation", entries[0].id, true, new Request("http://localhost/api/v1/events?snapshot=true"), policy);
        const expiredPayload = await expired.text();
        expect(expiredPayload).toContain('event: resync_required\ndata: {"reason":"event_window_expired"}');
        expect(expiredPayload.match(/^id: .+$/gm)).toEqual(entries.slice(-100).map((entry) => `id: ${entry.id}`));
        const baseline = await store.readStateSnapshot();
        await store.transaction((state) => ({ state: { ...state, outbox: [message("mvcc-initial", { payload: { sequence: state.protocolSequence } })] }, result: undefined }));
        const writing = (async () => {
          for (let index = 0; index < 15; index += 1) {
            await store.transaction((state) => ({ state: { ...state, protocolSequence: state.protocolSequence + 1,
              outbox: [message(`mvcc-${index}`, { payload: { sequence: state.protocolSequence + 1 } })] }, result: undefined }));
          }
        })();
        try {
          for (let index = 0; index < 20; index += 1) {
            const observed = await observer.readRealtimeSnapshot(1);
            expect(observed.state.outbox).toHaveLength(1);
            expect(observed.state.outbox[0].payload.sequence).toBe(observed.state.protocolSequence);
            expect(observed.version).toBe(baseline.version + 1 + observed.state.protocolSequence - baseline.state.protocolSequence);
          }
        } finally {
          await writing;
        }
        expect((await observer.readState()).outbox).toEqual([]);
        expect((await observer.readRealtimeSnapshot(1000)).state.outbox).toHaveLength(100);
      });
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("counts only notification deliveries as pending and prunes old domain events, which have no worker consumer", async () => {
    await withDisposablePostgresDatabase(async (database) => {
      const store = await database.createStore(fixture([
        message("domain-old", { availableAt: "2026-10-01T12:00:00.000Z" }),
        delivery("delivery-old", { availableAt: "2026-10-01T12:00:00.000Z" }),
        message("domain-recent", { availableAt: "2026-10-04T11:59:00.000Z" })
      ]));
      expect(await store.readOutboxMetrics()).toEqual({ pending: 1, oldestAvailableAt: "2026-10-01T12:00:00.000Z" });
      const summary = await store.compactRuntimeState({ now: NOW, outboxHotWindow: 100, outboxRetentionMs: 86_400_000 });
      expect(summary.outboxMessagesRemoved).toBe(1);
      expect(await database.query("SELECT id FROM outbox_messages ORDER BY event_position")).toEqual({ rows: [{ id: "delivery-old" }, { id: "domain-recent" }], rowCount: 2 });
      const memory = new MemoryStore(fixture([
        message("domain-old", { availableAt: "2026-10-01T12:00:00.000Z" }),
        delivery("delivery-old", { availableAt: "2026-10-01T12:00:00.000Z" }),
        message("domain-recent", { availableAt: "2026-10-04T11:59:00.000Z" })
      ]));
      expect(await memory.readOutboxMetrics()).toEqual({ pending: 1, oldestAvailableAt: "2026-10-01T12:00:00.000Z" });
      expect((await memory.compactRuntimeState({ now: NOW, outboxHotWindow: 100, outboxRetentionMs: 86_400_000 })).outboxMessagesRemoved).toBe(1);
    });
  });

  it("reads metrics from relational backlog and retains only the newest 100 processed rows within age without losing failed or active work", async () => {
    await withDisposablePostgresDatabase(async (database) => {
      const recent = Array.from({ length: 105 }, (_, index) => message(`recent-${index}`, { status: "PROCESSED", availableAt: "2026-10-04T11:59:00.000Z" }));
      const protectedRows = [delivery("pending", { availableAt: "2026-10-04T11:59:30.000Z" }), delivery("processing", { status: "PROCESSING", availableAt: "2026-10-04T11:58:00.000Z", lockedAt: TIME, workerId: "active", claimToken: randomUUID() }),
        message("failed", { status: "FAILED", availableAt: "2026-10-01T12:00:00.000Z", deadLetteredAt: TIME, lastError: "Keep evidence" }),
        message("discarded", { status: "DISCARDED", availableAt: "2026-10-01T12:00:00.000Z", deadLetteredAt: TIME, discardedAt: TIME, discardedBy: "user-admin", discardReason: "Keep disposition" })];
      // Insert old processed evidence last: a recent event_position alone cannot defeat the age limit.
      const old = message("old-processed", { status: "PROCESSED", availableAt: "2026-10-01T12:00:00.000Z" });
      const store = await database.createStore(fixture([...recent, ...protectedRows, old]));
      const beforeProtected = await database.query("SELECT * FROM outbox_messages WHERE status <> 'PROCESSED' ORDER BY id");
      expect(await store.readOutboxMetrics()).toEqual({ pending: 2, oldestAvailableAt: "2026-10-04T11:58:00.000Z" });
      resetMetrics();
      try {
        refreshOperationalMetrics(await store.readState(), NOW, { recollectionRate: undefined, resultViewLatencySeconds: undefined }, await store.readOutboxMetrics());
        expect(renderPrometheus()).toContain("cvg_outbox_pending 2");
        expect(renderPrometheus()).toContain("cvg_outbox_oldest_age_seconds 120");
      } finally {
        resetMetrics();
      }
      const summary = await store.compactRuntimeState({ now: NOW, outboxHotWindow: 100, outboxRetentionMs: 86_400_000 });
      expect(summary.outboxMessagesRemoved).toBe(6);
      expect(await database.query("SELECT id FROM outbox_messages WHERE status = 'PROCESSED' ORDER BY event_position")).toEqual({ rows: recent.slice(-100).map(({ id }) => ({ id })), rowCount: 100 });
      expect(await database.query("SELECT * FROM outbox_messages WHERE status <> 'PROCESSED' ORDER BY id")).toEqual(beforeProtected);
      expect((await store.readAuditEvents(ALL_AUDITS)).items).toMatchObject([{ eventType: "RuntimeStateRetentionApplied", metadata: { outboxMessagesRemoved: 6 } }]);
      await database.closeStore(store);
      const reopened = await database.createStore();
      expect((await reopened.readState()).outbox).toEqual([]);
      expect(await reopened.readOutbox({ kind: "dead-letter", limit: 100 })).toEqual(protectedRows.slice(2));
      expect(await reopened.readOutboxMetrics()).toEqual({ pending: 2, oldestAvailableAt: "2026-10-04T11:58:00.000Z" });
      await expect(reopened.healthcheck()).resolves.toBeUndefined();
    });
    vi.stubEnv("OUTBOX_STATE_RETENTION_MS", "604800000");
    vi.stubEnv("STATE_OUTBOX_HOT_WINDOW", "2");
    try {
      await withDisposablePostgresDatabase(async (database) => {
        const processed = ["env-oldest", "env-middle", "env-newest"].map((id) => message(id, { status: "PROCESSED", availableAt: "2026-10-02T12:00:00.000Z" }));
        const protectedRows = [delivery("env-active", { availableAt: "2026-09-01T12:00:00.000Z" }), message("env-failed", { status: "FAILED", availableAt: "2026-09-01T12:00:00.000Z", deadLetteredAt: TIME, lastError: "Keep evidence" })];
        const state = fixture([...processed, ...protectedRows]);
        const store = await database.createStore(state);
        const memory = new MemoryStore(state);
        const options = { now: NOW, outboxHotWindow: 0, outboxRetentionMs: 0 };
        expect((await store.compactRuntimeState(options)).outboxMessagesRemoved).toBe(1);
        expect((await memory.compactRuntimeState(options)).outboxMessagesRemoved).toBe(1);
        for (const kind of ["replay", "dead-letter"] as const) {
          expect(await store.readOutbox({ kind, limit: 100 })).toEqual(await memory.readOutbox({ kind, limit: 100 }));
        }
        expect(await database.query("SELECT id FROM outbox_messages ORDER BY event_position")).toEqual({ rows: [...processed.slice(1), ...protectedRows].map(({ id }) => ({ id })), rowCount: 4 });
        expect(await store.readOutboxMetrics()).toEqual(await memory.readOutboxMetrics());
      });
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("upgrades 013 matching/missing/table-only delivery evidence, preserves creation order and identity, rejects old writers and reruns unchanged", async () => {
    await withDisposablePostgresDatabase(async (database) => {
      await with013Probe(database, async (probe) => {
        const matching = message("z-matching", { availableAt: "2026-10-06T12:00:00.000Z" });
        const missing = message("a-missing", { availableAt: "2026-10-01T12:00:00.000Z" });
        const tableOnly = message("table-only", { status: "DISCARDED", attempts: 3, lastError: "Preserved error", deadLetteredAt: TIME, discardedAt: TIME, discardedBy: "user-admin", discardReason: "Preserved reason" });
        const state = fixture([matching, missing]);
        await probe.query("INSERT INTO cvg_runtime_state (id, state, version) VALUES (1, $1::jsonb, 7)", [JSON.stringify(state)]);
        await insertMessage(probe, matching);
        await insertMessage(probe, tableOnly);
        const tableBefore = await probe.query("SELECT * FROM outbox_messages WHERE id = $1", [tableOnly.id]);
        expect((await probe.upgrade()).applied).toEqual([CUTOVER]);
        expect(await probe.query("SELECT state, version::text FROM cvg_runtime_state WHERE id = 1")).toMatchObject({ rows: [{ state: { ...state, outbox: [] }, version: "8" }] });
        expect(await readPostgresOutbox(probe.sql, { kind: "replay", limit: 100 })).toEqual([matching, missing]);
        expect(await readPostgresOutbox(probe.sql, { kind: "dead-letter", limit: 100 })).toEqual([tableOnly]);
        const afterTableOnly = await probe.query("SELECT * FROM outbox_messages WHERE id = $1", [tableOnly.id]);
        expect(afterTableOnly.rows.map((row) => {
          const original = { ...row as Record<string, unknown> };
          delete original.event_position;
          return original;
        })).toEqual(tableBefore.rows);
        expect(await probe.query("SELECT id, event_position::text FROM outbox_messages ORDER BY event_position")).toEqual({ rows: [{ id: matching.id, event_position: "1" }, { id: missing.id, event_position: "2" }, { id: tableOnly.id, event_position: "3" }], rowCount: 3 });
        expect(await probe.query("SELECT schema_version FROM relational_schema_markers")).toMatchObject({ rows: [{ schema_version: CUTOVER }] });
        expect(await probe.query("SELECT is_identity, identity_generation FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'outbox_messages' AND column_name = 'event_position'")).toMatchObject({ rows: [{ is_identity: "YES", identity_generation: "BY DEFAULT" }] });
        const beforeRerun = await migrationEvidence(probe);
        await expect(probe.upgrade()).resolves.toEqual({ applied: [], alreadyApplied: RUNTIME_MIGRATION_VERSIONS.filter((version) => version <= CUTOVER) });
        expect(await migrationEvidence(probe)).toEqual(beforeRerun);
        await expect(probe.query("UPDATE cvg_runtime_state SET state = $1::jsonb, version = version + 1 WHERE id = 1", [JSON.stringify(state)])).rejects.toMatchObject({ code: "23514", constraint: "runtime_outbox_is_transient" });
        expect(await migrationEvidence(probe)).toEqual(beforeRerun);
        await expect(probe.query("UPDATE outbox_messages SET event_position = 1 WHERE id = $1", [missing.id])).rejects.toMatchObject({ code: "23505", constraint: "outbox_messages_event_position_unique" });
        const next = message("identity-next");
        await insertMessage(probe, next);
        expect(await probe.query("SELECT event_position::text FROM outbox_messages WHERE id = $1", [next.id])).toMatchObject({ rows: [{ event_position: "4" }] });
      });
    });
  });

  it("fails closed on every 013 delivery-field mismatch and duplicate/missing IDs, rolls back a late 014 failure, and recovers without losing rows", async () => {
    await withDisposablePostgresDatabase(async (database) => {
      await with013Probe(database, async (probe) => {
        const persisted = delivery("persisted", { status: "DISCARDED", attempts: 5, lockedAt: TIME, workerId: "old-worker", claimToken: randomUUID(), lastError: "Original failure",
          deadLetteredAt: TIME, discardedAt: TIME, discardedBy: "user-admin", discardReason: "Original disposition" });
        const missing = message("missing");
        const tableOnly = message("preserve-table-only", { status: "PROCESSED" });
        const state = fixture([missing, persisted]);
        await probe.query("INSERT INTO cvg_runtime_state (id, state, version) VALUES (1, $1::jsonb, 7)", [JSON.stringify(state)]);
        await insertMessage(probe, persisted);
        await insertMessage(probe, tableOnly);
        const mismatches: Partial<OutboxMessage>[] = [
          { eventType: "Different" }, { aggregateType: "Different" }, { aggregateId: "different" }, { payload: { different: true } },
          { consumerType: "DOMAIN_EVENT" }, { routingKey: "notification.other" }, { status: "FAILED" }, { attempts: 6 },
          { availableAt: "2026-10-04T12:00:00.001Z" }, { correlationId: "different" }, { lockedAt: undefined }, { workerId: undefined },
          { claimToken: undefined }, { lastError: undefined }, { deadLetteredAt: undefined }, { discardedAt: undefined }, { discardedBy: undefined }, { discardReason: undefined }
        ];
        for (const mismatch of mismatches) {
          await probe.query("UPDATE cvg_runtime_state SET state = $1::jsonb WHERE id = 1", [JSON.stringify({ ...state, outbox: [missing, { ...persisted, ...mismatch }] })]);
          const before = await migrationEvidence(probe);
          await expect(probe.upgrade(), `mismatch: ${Object.keys(mismatch)[0]}`).rejects.toThrow("OUTBOX_CUTOVER_PROJECTION_DIVERGED");
          expect(await migrationEvidence(probe)).toEqual(before);
        }
        for (const outbox of [[missing, persisted, persisted], [missing, { ...persisted, id: "" }]]) {
          await probe.query("UPDATE cvg_runtime_state SET state = $1::jsonb WHERE id = 1", [JSON.stringify({ ...state, outbox })]);
          const before = await migrationEvidence(probe);
          await expect(probe.upgrade()).rejects.toThrow("OUTBOX_CUTOVER_DUPLICATE_OR_MISSING_ID");
          expect(await migrationEvidence(probe)).toEqual(before);
        }
        await probe.query("UPDATE cvg_runtime_state SET state = $1::jsonb WHERE id = 1", [JSON.stringify(state)]);
        await probe.query(`CREATE FUNCTION reject_outbox_cutover_boundary() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
          IF NEW.boundary_key = 'outbox-messages-v1' THEN RAISE EXCEPTION 'LATE_OUTBOX_CUTOVER_TEST_FAILURE'; END IF; RETURN NEW; END; $$`);
        await probe.query("CREATE TRIGGER reject_outbox_cutover_boundary BEFORE INSERT ON runtime_storage_boundaries FOR EACH ROW EXECUTE FUNCTION reject_outbox_cutover_boundary()");
        const beforeLateFailure = await migrationEvidence(probe);
        await expect(probe.upgrade()).rejects.toThrow("LATE_OUTBOX_CUTOVER_TEST_FAILURE");
        expect(await migrationEvidence(probe)).toEqual(beforeLateFailure);
        expect(beforeLateFailure.artifacts.rows).toEqual([{ guard: 0, position: 0, indexes: 0 }]);
        await probe.query("DROP TRIGGER reject_outbox_cutover_boundary ON runtime_storage_boundaries");
        expect((await probe.upgrade()).applied).toEqual([CUTOVER]);
        expect(await readPostgresOutbox(probe.sql, { kind: "replay", limit: 100 })).toEqual([missing, tableOnly]);
        expect(await readPostgresOutbox(probe.sql, { kind: "dead-letter", limit: 100 })).toEqual([persisted]);
        const recovered = await migrationEvidence(probe);
        expect(recovered.artifacts.rows).toEqual([{ guard: 1, position: 1, indexes: 2 }]);
        await expect(probe.upgrade()).resolves.toEqual({ applied: [], alreadyApplied: RUNTIME_MIGRATION_VERSIONS.filter((version) => version <= CUTOVER) });
        expect(await migrationEvidence(probe)).toEqual(recovered);
      });
    });
  });
});
