import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AuditEvent, OutboxMessage, StoreState } from "../domain/models";
import { createDemoState } from "./fixtures";

const pool = vi.hoisted(() => ({
  connect: vi.fn(),
  end: vi.fn(),
  on: vi.fn(),
  options: [] as unknown[],
  query: vi.fn()
}));

vi.mock("pg", () => ({
  Pool: class MockPool {
    constructor(options: unknown) {
      pool.options.push(options);
    }

    connect = pool.connect;
    end = pool.end;
    on = pool.on;
    query = pool.query;
  }
}));

import { PostgresStore } from "./postgres-store";

const readyRuntimeSchema = {
  state_exists: true,
  latest_migration_applied: true,
  runtime_state_shape_ready: true,
  migration_ledger_shape_ready: true,
  runtime_state_payload_ready: true,
  audit_append_only_ready: true,
  audit_truncate_guard_ready: true,
  event_projection_ready: true,
  outbox_claim_ownership_ready: true,
  outbox_routing_ready: true,
  outbox_dead_letter_ready: true,
  rate_limit_schema_ready: true,
  relational_clinical_core_ready: true,
  transitional_storage_boundary_ready: true,
  invalidation_trigger_ready: true
};

function result(rowCount: number, rows: readonly unknown[] = []) {
  return { rowCount, rows };
}

function stateRow(state: StoreState, version: unknown = "1") {
  return result(1, [{ state, version }]);
}

function queueReadyOpen(state: StoreState, version: unknown = "1") {
  pool.query
    .mockResolvedValueOnce(stateRow(state, version))
    .mockResolvedValueOnce(result(1, [readyRuntimeSchema]));
}

function createClient(initial: StoreState, updatedVersion: unknown = "2") {
  return {
    query: vi.fn(async (text: string) => {
      if (text === "BEGIN" || text === "COMMIT" || text === "ROLLBACK") return result(0);
      if (text.includes("FOR UPDATE")) return stateRow(initial, "1");
      if (text.startsWith("UPDATE cvg_runtime_state")) return result(1, [{ version: updatedVersion }]);
      return result(0);
    }),
    release: vi.fn()
  };
}

describe("PostgresStore behavior coverage with an isolated pg mock", () => {
  beforeEach(() => {
    pool.connect.mockReset();
    pool.end.mockReset().mockResolvedValue(undefined);
    pool.on.mockReset();
    pool.options.length = 0;
    pool.query.mockReset();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("requires explicit authorization before initializing a missing runtime row", async () => {
    const fallbackState = createDemoState("postgres-coverage-authorization-password");
    pool.query.mockResolvedValueOnce(result(0));

    await expect(PostgresStore.create(
      "postgres://test.invalid/cvg_test_coverage_missing_auth",
      fallbackState,
      { authorization: "ALLOW_POSTGRES_INTEGRATION_TESTS" }
    )).rejects.toThrow("POSTGRES_INITIALIZATION_REQUIRES_AUTHORIZATION");

    expect(pool.query).toHaveBeenCalledTimes(1);
    expect(pool.query).not.toHaveBeenCalledWith(
      expect.stringContaining("INSERT INTO cvg_runtime_state"),
      expect.anything()
    );
    expect(pool.end).toHaveBeenCalledOnce();
  });

  it("initializes only an explicitly authorized loopback test target and honors pool configuration", async () => {
    vi.stubEnv("ALLOW_POSTGRES_INTEGRATION_TESTS", "true");
    vi.stubEnv("DB_POOL_MAX", "3");
    const fallbackState = createDemoState("postgres-coverage-seed-password");
    const databaseName = `cvg_test_17_${"a".repeat(32)}`;
    const connectionString = `postgresql://seed:secret@localhost/${databaseName}`;
    pool.query
      .mockResolvedValueOnce(result(0))
      .mockResolvedValueOnce(result(1))
      .mockResolvedValueOnce(stateRow(fallbackState, "7"))
      .mockResolvedValueOnce(result(1, [readyRuntimeSchema]));

    const store = await PostgresStore.create(
      connectionString,
      fallbackState,
      { authorization: "ALLOW_POSTGRES_INTEGRATION_TESTS" }
    );

    expect(pool.options[0]).toEqual({
      connectionString,
      max: 3,
      idleTimeoutMillis: 30_000
    });
    expect(pool.on).toHaveBeenCalledWith("error", expect.any(Function));
    expect(pool.query).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining("INSERT INTO cvg_runtime_state"),
      [JSON.stringify(fallbackState)]
    );
    expect(store.getState()).toEqual(fallbackState);

    await store.close();
    expect(pool.end).toHaveBeenCalledOnce();
  });

  it("forbids an administrative reset in production before acquiring a client", async () => {
    const initial = createDemoState("postgres-coverage-production-password");
    queueReadyOpen(initial);
    const store = await PostgresStore.create("postgres://test.invalid/cvg_test_production");

    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("ALLOW_DB_SMOKE_RESET", "true");

    await expect(store.reset(initial, { authorization: "ALLOW_DB_SMOKE_RESET" }))
      .rejects.toThrow("POSTGRES_ADMIN_RESET_FORBIDDEN_IN_PRODUCTION");
    expect(pool.connect).not.toHaveBeenCalled();

    await store.close();
  });

  it("rejects an explicitly opted-in reset whose target is not an allowed loopback database", async () => {
    const initial = createDemoState("postgres-coverage-target-password");
    queueReadyOpen(initial);
    const store = await PostgresStore.create("postgres://test.invalid/cvg_test_target");

    vi.stubEnv("ALLOW_SYNTHETIC_SEED", "true");

    await expect(store.reset(initial, { authorization: "ALLOW_SYNTHETIC_SEED" }))
      .rejects.toThrow("POSTGRES_ADMIN_RESET_TARGET_NOT_ALLOWED");
    expect(pool.connect).not.toHaveBeenCalled();

    await store.close();
  });

  it("commits a transaction and projects appended audit and outbox records atomically", async () => {
    const initial = createDemoState("postgres-coverage-commit-password");
    const auditEvent: AuditEvent = {
      id: "audit-coverage-commit",
      eventType: "RequestCreated",
      actorId: "user-vet",
      entityType: "DiagnosticRequest",
      entityId: "request-coverage-commit",
      previousState: "NONE",
      newState: "REQUESTED",
      correlationId: "correlation-coverage-commit",
      metadata: { source: "coverage", attempt: 1 },
      occurredAt: "2026-09-07T12:00:00.000Z"
    };
    const outboxMessage: OutboxMessage = {
      id: "outbox-coverage-commit",
      eventType: "RequestCreated",
      aggregateType: "DiagnosticRequest",
      aggregateId: "request-coverage-commit",
      payload: { requestId: "request-coverage-commit" },
      consumerType: "DOMAIN_EVENT",
      routingKey: "domain.RequestCreated",
      status: "PENDING",
      attempts: 0,
      availableAt: "2026-09-07T12:00:00.000Z",
      correlationId: "correlation-coverage-commit"
    };
    const nextState: StoreState = {
      ...initial,
      auditEvents: [auditEvent],
      outbox: [outboxMessage],
      protocolSequence: initial.protocolSequence + 1
    };
    const client = createClient(initial, "8");
    client.query.mockImplementation(async (text: string, _values?: readonly unknown[]) => {
      if (text === "BEGIN" || text === "COMMIT" || text === "ROLLBACK") return result(0);
      if (text.includes("FOR UPDATE")) return stateRow(initial, "7");
      if (text.startsWith("UPDATE cvg_runtime_state")) return result(1, [{ version: "8" }]);
      if (text.startsWith("INSERT INTO audit_events")) return result(1, [{ id: auditEvent.id }]);
      if (text.startsWith("INSERT INTO outbox_messages")) return result(1, [{ id: outboxMessage.id }]);
      return result(0);
    });
    queueReadyOpen(initial, "7");
    pool.connect.mockResolvedValueOnce(client);
    const store = await PostgresStore.create("postgres://test.invalid/cvg_test_commit");

    await expect(store.transaction(async () => ({ state: nextState, result: "committed" })))
      .resolves.toBe("committed");

    expect(client.query.mock.calls.map(([text]) => String(text))).toEqual([
      "BEGIN",
      expect.stringContaining("SELECT state, version FROM cvg_runtime_state WHERE id = 1 FOR UPDATE"),
      expect.stringContaining("UPDATE cvg_runtime_state"),
      expect.stringContaining("INSERT INTO audit_events"),
      expect.stringContaining("INSERT INTO outbox_messages"),
      "COMMIT"
    ]);
    const updateCall = client.query.mock.calls.find(([text]) => String(text).startsWith("UPDATE cvg_runtime_state"));
    expect((updateCall as readonly unknown[] | undefined)?.[1]).toEqual([JSON.stringify(nextState)]);
    const auditCall = client.query.mock.calls.find(([text]) => String(text).startsWith("INSERT INTO audit_events"));
    expect((auditCall as readonly unknown[] | undefined)?.[1]).toEqual([
      auditEvent.id,
      auditEvent.eventType,
      auditEvent.actorId,
      auditEvent.entityType,
      auditEvent.entityId,
      auditEvent.previousState,
      auditEvent.newState,
      auditEvent.correlationId,
      JSON.stringify(auditEvent.metadata),
      auditEvent.occurredAt
    ]);
    const outboxCall = client.query.mock.calls.find(([text]) => String(text).startsWith("INSERT INTO outbox_messages"));
    expect((outboxCall as readonly unknown[] | undefined)?.[1]).toEqual([
      outboxMessage.id,
      outboxMessage.eventType,
      outboxMessage.aggregateType,
      outboxMessage.aggregateId,
      JSON.stringify(outboxMessage.payload),
      "DOMAIN_EVENT",
      "domain.RequestCreated",
      outboxMessage.status,
      outboxMessage.attempts,
      outboxMessage.availableAt,
      outboxMessage.correlationId,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null
    ]);
    expect(store.getState()).toEqual(nextState);
    expect(client.release).toHaveBeenCalledOnce();

    await store.close();
  });

  it("rolls back and preserves the cache when the runtime snapshot update affects no row", async () => {
    const initial = createDemoState("postgres-coverage-update-rollback-password");
    const client = createClient(initial);
    client.query.mockImplementation(async (text: string) => {
      if (text === "BEGIN" || text === "ROLLBACK") return result(0);
      if (text.includes("FOR UPDATE")) return stateRow(initial, "1");
      if (text.startsWith("UPDATE cvg_runtime_state")) return result(0);
      return result(0);
    });
    queueReadyOpen(initial);
    pool.connect.mockResolvedValueOnce(client);
    const store = await PostgresStore.create("postgres://test.invalid/cvg_test_update_rollback");

    await expect(store.transaction((state) => ({
      state: { ...state, protocolSequence: state.protocolSequence + 1 },
      result: undefined
    }))).rejects.toThrow("PostgreSQL runtime state update failed.");

    expect(client.query).toHaveBeenCalledWith("ROLLBACK");
    expect(client.query).not.toHaveBeenCalledWith("COMMIT");
    expect(store.getState()).toEqual(initial);
    expect(client.release).toHaveBeenCalledOnce();

    await store.close();
  });

  it("rolls back when the append-only audit projection reports a divergence", async () => {
    const initial = createDemoState("postgres-coverage-audit-projection-password");
    const auditEvent: AuditEvent = {
      id: "audit-coverage-diverged",
      eventType: "RequestUpdated",
      entityType: "DiagnosticRequest",
      entityId: "request-coverage-diverged",
      correlationId: "correlation-coverage-diverged",
      metadata: { source: "coverage" },
      occurredAt: "2026-09-07T12:10:00.000Z"
    };
    const client = createClient(initial);
    client.query.mockImplementation(async (text: string) => {
      if (text === "BEGIN" || text === "ROLLBACK") return result(0);
      if (text.includes("FOR UPDATE")) return stateRow(initial, "1");
      if (text.startsWith("UPDATE cvg_runtime_state")) return result(1, [{ version: "2" }]);
      if (text.startsWith("INSERT INTO audit_events")) return result(0);
      return result(0);
    });
    queueReadyOpen(initial);
    pool.connect.mockResolvedValueOnce(client);
    const store = await PostgresStore.create("postgres://test.invalid/cvg_test_audit_projection");

    await expect(store.transaction((state) => ({
      state: { ...state, auditEvents: [auditEvent] },
      result: undefined
    }))).rejects.toThrow(`POSTGRES_AUDIT_PROJECTION_DIVERGED:${auditEvent.id}`);

    expect(client.query).toHaveBeenCalledWith("ROLLBACK");
    expect(client.query).not.toHaveBeenCalledWith("COMMIT");
    expect(store.getState()).toEqual(initial);

    await store.close();
  });

  it("rejects mutation of an existing audit event and never updates the runtime snapshot", async () => {
    const originalAuditEvent: AuditEvent = {
      id: "audit-coverage-existing",
      eventType: "RequestCreated",
      entityType: "DiagnosticRequest",
      entityId: "request-coverage-existing",
      correlationId: "correlation-coverage-existing",
      metadata: { retained: true },
      occurredAt: "2026-09-07T12:20:00.000Z"
    };
    const initial: StoreState = {
      ...createDemoState("postgres-coverage-audit-append-only-password"),
      auditEvents: [originalAuditEvent]
    };
    const client = createClient(initial);
    client.query.mockImplementation(async (text: string) => {
      if (text === "BEGIN" || text === "ROLLBACK") return result(0);
      if (text.includes("FOR UPDATE")) return stateRow(initial, "1");
      return result(0);
    });
    queueReadyOpen(initial);
    pool.connect.mockResolvedValueOnce(client);
    const store = await PostgresStore.create("postgres://test.invalid/cvg_test_audit_append_only");

    await expect(store.transaction((state) => ({
      state: {
        ...state,
        auditEvents: [{ ...originalAuditEvent, metadata: { retained: false } }]
      },
      result: undefined
    }))).rejects.toThrow("POSTGRES_AUDIT_LOG_MUTATION");

    expect(client.query).toHaveBeenCalledWith("ROLLBACK");
    expect(client.query).not.toHaveBeenCalledWith(expect.stringContaining("UPDATE cvg_runtime_state"), expect.anything());
    expect(store.getState()).toEqual(initial);

    await store.close();
  });

  it("accepts a bigint PostgreSQL version but keeps the validated cache after a later invalid read", async () => {
    const initial = createDemoState("postgres-coverage-version-password");
    pool.query
      .mockResolvedValueOnce(stateRow(initial, 1n))
      .mockResolvedValueOnce(result(1, [readyRuntimeSchema]))
      .mockResolvedValueOnce(stateRow(initial, 2n))
      .mockResolvedValueOnce(stateRow(initial, 0));
    const store = await PostgresStore.create("postgres://test.invalid/cvg_test_version");

    await expect(store.readState()).resolves.toEqual(initial);
    await expect(store.readState()).rejects.toThrow("PostgreSQL runtime state version is invalid.");
    expect(store.getState()).toEqual(initial);

    await store.close();
  });

  it("closes idempotently and rejects new work after the pool has ended", async () => {
    const initial = createDemoState("postgres-coverage-close-password");
    queueReadyOpen(initial);
    const store = await PostgresStore.create("postgres://test.invalid/cvg_test_close_idempotent");

    await Promise.all([store.close(), store.close()]);
    expect(pool.end).toHaveBeenCalledOnce();
    await expect(store.readState()).rejects.toThrow("PostgreSQL store is closing or closed.");
    await expect(store.close()).resolves.toBeUndefined();
    expect(pool.end).toHaveBeenCalledOnce();
  });
});
