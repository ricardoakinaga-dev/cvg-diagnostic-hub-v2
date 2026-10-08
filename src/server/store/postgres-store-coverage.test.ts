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

const listenerPool = vi.hoisted(() => ({
  connect: vi.fn(),
  end: vi.fn(),
  on: vi.fn(),
  query: vi.fn(),
  client: {
    query: vi.fn(),
    on: vi.fn(),
    off: vi.fn(),
    removeListener: vi.fn(),
    release: vi.fn()
  }
}));

vi.mock("pg", () => ({
  Pool: class MockPool {
    constructor(options: { application_name?: string }) {
      if (options.application_name === "cvg-runtime-state-cache") return listenerPool;
      pool.options.push(options);
      return pool;
    }
  }
}));

import { PostgresStore } from "./postgres-store";
import { runtimePoolTimeouts } from "../domain/database-timeouts";

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
  session_activity_schema_ready: true,
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
    listenerPool.client.query.mockReset().mockResolvedValue(result(0));
    listenerPool.client.on.mockReset();
    listenerPool.client.off.mockReset();
    listenerPool.client.removeListener.mockReset();
    listenerPool.client.release.mockReset();
    listenerPool.connect.mockReset().mockResolvedValue(listenerPool.client);
    listenerPool.end.mockReset().mockResolvedValue(undefined);
    listenerPool.on.mockReset();
    listenerPool.query.mockReset().mockResolvedValue(result(0));
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
      idleTimeoutMillis: 30_000,
      ...runtimePoolTimeouts()
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
      // The cache already holds version 7: the lock reads only the version column.
      expect.stringContaining("SELECT version FROM cvg_runtime_state WHERE id = 1 FOR UPDATE"),
      expect.stringContaining("UPDATE cvg_runtime_state"),
      expect.stringContaining("INSERT INTO audit_events"),
      expect.stringContaining("INSERT INTO outbox_messages"),
      "COMMIT"
    ]);
    const updateCall = client.query.mock.calls.find(([text]) => String(text).startsWith("UPDATE cvg_runtime_state"));
    expect((updateCall as readonly unknown[] | undefined)?.[1]).toEqual([JSON.stringify({ ...nextState, auditEvents: [], outbox: [] })]);
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
    expect(store.getState()).toEqual({ ...nextState, auditEvents: [], outbox: [] });
    expect(client.release).toHaveBeenCalledOnce();

    await store.close();
  });

  it.each(["success", "insert failure", "missing row"])("initializes new session activity on the transaction client: %s", async (outcome) => {
    const initial = createDemoState("postgres-activity-commit-password");
    const session = {
      id: "session-new", userId: "user-vet", tokenHash: "token", csrfTokenHash: "csrf",
      createdAt: "2026-10-03T12:00:00.000Z", expiresAt: "2026-10-03T20:00:00.000Z", version: 1
    };
    initial.sessions = [{ ...session, id: "session-existing" }];
    const nextState = { ...initial, sessions: [...initial.sessions, session] };
    const client = {
      query: vi.fn(async (text: string, values?: readonly unknown[]) => {
        if (text === "BEGIN" || text === "COMMIT" || text === "ROLLBACK") return result(0);
        if (text.includes("FOR UPDATE")) return stateRow(structuredClone(initial));
        if (text.startsWith("UPDATE cvg_runtime_state")) return result(1, [{ version: "2" }]);
        if (text.includes("INSERT INTO session_activity")) {
          expect(values).toEqual([session.id, session.userId, session.createdAt]);
          if (outcome === "insert failure") throw new Error("injected activity insert failure");
          if (outcome === "missing row") return result(0);
          return result(1, [{ session_id: values?.[0], user_id: values?.[1], last_seen_at: values?.[2] }]);
        }
        throw new Error(`Unexpected transaction SQL: ${text}`);
      }),
      release: vi.fn()
    };
    queueReadyOpen(initial);
    pool.connect.mockResolvedValueOnce(client);
    const store = await PostgresStore.create("postgres://test.invalid/cvg_test_activity_commit");
    try {
      const transaction = store.transaction((state) => ({ state: { ...state, sessions: [...state.sessions, session] }, result: "committed" }));
      if (outcome === "success") {
        await expect(transaction).resolves.toBe("committed");
        expect(store.getState()).toEqual(nextState);
      } else {
        await expect(transaction).rejects.toThrow(outcome === "insert failure"
          ? "injected activity insert failure" : "POSTGRES_SESSION_ACTIVITY_TOUCH_FAILED");
        expect(store.getState()).toEqual(initial);
        expect(client.query).not.toHaveBeenCalledWith("COMMIT");
      }
      expect(client.query.mock.calls.map(([text]) => text)).toEqual([
        "BEGIN",
        expect.stringContaining("FOR UPDATE"),
        expect.stringContaining("UPDATE cvg_runtime_state"),
        expect.stringContaining("INSERT INTO session_activity"),
        outcome === "success" ? "COMMIT" : "ROLLBACK"
      ]);
      expect(pool.query).toHaveBeenCalledTimes(2);
      expect(client.release).toHaveBeenCalledOnce();
    } finally {
      await store.close();
    }
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
      .mockResolvedValueOnce(result(1, [{ version: 2n }]))
      .mockResolvedValueOnce(stateRow(initial, 2n))
      .mockResolvedValueOnce(result(1, [{ version: 0 }]));
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

  it("rejects multiple runtime rows and closes the pool before accepting a cache", async () => {
    const initial = createDemoState("postgres-cardinality-password");
    pool.query.mockResolvedValueOnce(result(2, [{ state: initial, version: "1" }, { state: initial, version: "2" }]));
    await expect(PostgresStore.create("postgres://test.invalid/cvg_test_cardinality"))
      .rejects.toThrow("PostgreSQL runtime state cardinality is invalid.");
    expect(pool.query).toHaveBeenCalledOnce();
    expect(pool.end).toHaveBeenCalledOnce();
    expect(listenerPool.connect).not.toHaveBeenCalled();
  });

  it("fails closed when an authorized seed does not produce a runtime row", async () => {
    vi.stubEnv("ALLOW_POSTGRES_INTEGRATION_TESTS", "true");
    const initial = createDemoState("postgres-seed-missing-password");
    pool.query.mockResolvedValueOnce(result(0)).mockResolvedValueOnce(result(1)).mockResolvedValueOnce(result(0));
    await expect(PostgresStore.create(`postgres://localhost/cvg_test_18_${"b".repeat(32)}`, initial,
      { authorization: "ALLOW_POSTGRES_INTEGRATION_TESTS" }))
      .rejects.toThrow("PostgreSQL runtime state row is missing after seed initialization.");
    expect(pool.query).toHaveBeenCalledTimes(3);
    expect(pool.end).toHaveBeenCalledOnce();
    expect(listenerPool.connect).not.toHaveBeenCalled();
  });

  it("refuses relational operations without opt-in before acquiring a client and keeps normal writes available", async () => {
    const initial = createDemoState("postgres-relational-disabled-password");
    queueReadyOpen(initial);
    const store = await PostgresStore.create("postgres://test.invalid/cvg_test_relational_disabled");
    try {
      await expect(store.readRelationalClinicalRequest("request-a")).rejects.toThrow("POSTGRES_RELATIONAL_RUNTIME_NOT_ENABLED");
      await expect(store.reconcileRelationalClinicalRequest("request-a")).rejects.toThrow("POSTGRES_RELATIONAL_RUNTIME_NOT_ENABLED");
      await expect(store.backfillRelationalClinicalCore()).rejects.toThrow("POSTGRES_RELATIONAL_RUNTIME_NOT_ENABLED");
      expect(pool.connect).not.toHaveBeenCalled();
      expect(pool.query).toHaveBeenCalledTimes(2);
      const client = createClient(initial);
      pool.connect.mockResolvedValueOnce(client);
      await expect(store.transaction((state) => ({ state, result: "available" }))).resolves.toBe("available");
      expect(client.query).toHaveBeenCalledWith("COMMIT");
    } finally {
      await store.close();
    }
  });

  it("rejects missing realtime and version rows without replacing the validated cache, then recovers", async () => {
    const initial = createDemoState("postgres-missing-read-password");
    queueReadyOpen(initial);
    const store = await PostgresStore.create("postgres://test.invalid/cvg_test_missing_read");
    try {
      pool.query.mockResolvedValueOnce(result(0));
      await expect(store.readRealtimeSnapshot(5)).rejects.toThrow("PostgreSQL runtime state row is missing.");
      pool.query.mockResolvedValueOnce(result(0));
      await expect(store.readStateVersion()).rejects.toThrow("PostgreSQL runtime state row is missing.");
      expect(store.getState()).toEqual(initial);
      pool.query.mockResolvedValueOnce(result(1, [{ state: initial, version: "2", outbox: [] }]));
      await expect(store.readRealtimeSnapshot(5)).resolves.toEqual({ state: initial, version: 2 });
      pool.query.mockResolvedValueOnce(result(1, [{ version: "2" }]));
      await expect(store.readStateVersion()).resolves.toBe(2);
    } finally {
      await store.close();
    }
  });

  it("never invokes the operation without a locked snapshot and preserves its error if rollback also fails", async () => {
    const initial = createDemoState("postgres-locked-missing-password");
    const client = createClient(initial);
    client.query.mockImplementation(async (text) => {
      if (text === "ROLLBACK") throw new Error("rollback disconnected");
      return result(0);
    });
    queueReadyOpen(initial);
    pool.connect.mockResolvedValueOnce(client);
    const store = await PostgresStore.create("postgres://test.invalid/cvg_test_locked_missing");
    const operation = vi.fn((state: StoreState) => ({ state, result: "committed" }));
    try {
      await expect(store.transaction(operation)).rejects.toThrow("PostgreSQL runtime state row is missing.");
      expect(operation).not.toHaveBeenCalled();
      expect(client.query).toHaveBeenCalledWith("ROLLBACK");
      expect(client.query).not.toHaveBeenCalledWith("COMMIT");
      expect(client.release).toHaveBeenCalledOnce();
      expect(store.getState()).toEqual(initial);
      const healthyClient = createClient(initial);
      pool.connect.mockResolvedValueOnce(healthyClient);
      await expect(store.transaction(operation)).resolves.toBe("committed");
      expect(operation).toHaveBeenCalledOnce();
      expect(healthyClient.query).toHaveBeenCalledWith("COMMIT");
    } finally {
      await store.close();
    }
  });

  it("rejects a transaction callback that mutates the shared state in place, before anything is written", async () => {
    const initial = createDemoState("postgres-frozen-transaction-password");
    queueReadyOpen(initial, "1");
    const client = createClient(initial);
    pool.connect.mockResolvedValueOnce(client);
    const store = await PostgresStore.create("postgres://test.invalid/cvg_test_frozen_transaction");
    try {
      await expect(store.transaction((state) => {
        state.sessions.push({ ...state.sessions[0]!, id: "session-in-place" });
        return { state, result: undefined };
      })).rejects.toThrow(TypeError);
      const statements = client.query.mock.calls.map(([text]) => String(text));
      expect(statements).toContain("ROLLBACK");
      expect(statements.some((text) => text.startsWith("UPDATE cvg_runtime_state"))).toBe(false);
      expect(store.getState().sessions.some((session) => session.id === "session-in-place")).toBe(false);
    } finally {
      await store.close();
    }
  });

  it("returns the shared frozen snapshot with its durable version and keeps getState an independent copy", async () => {
    const initial = createDemoState("postgres-snapshot-isolation-password");
    const original = structuredClone(initial);
    queueReadyOpen(initial, "7");
    const store = await PostgresStore.create("postgres://test.invalid/cvg_test_snapshot_isolation");
    try {
      pool.query.mockResolvedValueOnce(result(1, [{ version: "7" }])).mockResolvedValueOnce(stateRow(initial, "7"));
      const snapshot = await store.readStateSnapshot();
      expect(snapshot).toEqual({ state: original, version: 7 });
      expect(() => { snapshot.state.users[0].active = false; }).toThrow(TypeError);
      const copy = store.getState();
      copy.users[0].active = false;
      expect(store.getState()).toEqual(original);
      pool.query.mockResolvedValueOnce(result(0));
      await expect(store.readStateSnapshot()).rejects.toThrow("PostgreSQL runtime state row is missing.");
      expect(store.getState()).toEqual(initial);
    } finally {
      await store.close();
    }
  });

  it("reads authorization and session liveness directly while a clinical transaction is waiting", async () => {
    const initial = createDemoState("postgres-direct-session-password");
    const session = {
      id: "session-direct", userId: initial.users[0].id, tokenHash: "token", csrfTokenHash: "csrf",
      createdAt: "2026-10-04T12:00:00.000Z", expiresAt: "2026-10-04T20:00:00.000Z", version: 1
    };
    queueReadyOpen(initial);
    const store = await PostgresStore.create("postgres://test.invalid/cvg_test_direct_session");
    const client = createClient(initial);
    let releaseConnection: (value: typeof client) => void = () => { throw new Error("connection gate missing"); };
    pool.connect.mockImplementationOnce(() => new Promise<typeof client>((resolve) => { releaseConnection = resolve; }));
    const operation = vi.fn((state: StoreState) => ({ state, result: "committed" }));
    const pending = store.transaction(operation);
    try {
      pool.query.mockResolvedValueOnce(result(1, [{ user: initial.users[0], session }]));
      const authorization = await store.readAuthorizationSnapshot({ userId: session.userId, sessionId: session.id });
      expect(authorization).toEqual({ user: initial.users[0], session });
      expect(pool.query.mock.calls.at(-1)?.[1]).toEqual([session.userId, session.id]);
      authorization.user!.active = false;
      authorization.session!.revokedAt = session.createdAt;
      expect(initial.users[0].active).toBe(true);
      expect(session).not.toHaveProperty("revokedAt");

      pool.query.mockResolvedValueOnce(result(0));
      await expect(store.readSessionActivity(session.id)).resolves.toBeUndefined();
      const lastSeenAt = "2026-10-04T12:30:00.000Z";
      const activityRow = { session_id: session.id, user_id: session.userId, last_seen_at: new Date(lastSeenAt) };
      pool.query.mockResolvedValueOnce(result(1, [activityRow]));
      await expect(store.touchSessionActivity({ sessionId: session.id, userId: session.userId, lastSeenAt }))
        .resolves.toEqual({ sessionId: session.id, userId: session.userId, lastSeenAt });
      expect(pool.query.mock.calls.at(-1)?.[1]).toEqual([session.id, session.userId, lastSeenAt]);
      pool.query.mockResolvedValueOnce(result(1, [activityRow]));
      await expect(store.readSessionActivity(session.id)).resolves.toEqual({ sessionId: session.id, userId: session.userId, lastSeenAt });
      pool.query.mockResolvedValueOnce(result(0));
      await expect(store.touchSessionActivity({ sessionId: session.id, userId: session.userId, lastSeenAt }))
        .rejects.toThrow("POSTGRES_SESSION_ACTIVITY_TOUCH_FAILED");
      pool.query.mockResolvedValueOnce(result(0));
      await expect(store.readAuthorizationSnapshot({ userId: session.userId }))
        .rejects.toThrow("PostgreSQL runtime state row is missing.");
      expect(operation).not.toHaveBeenCalled();
      expect(store.getState()).toEqual(initial);
    } finally {
      releaseConnection(client);
      await expect(pending).resolves.toBe("committed");
      await store.close();
    }
  });

  it("reads durable outbox pages and backlog metrics without expanding or mutating the snapshot", async () => {
    const initial = createDemoState("postgres-durable-outbox-read-password");
    const message: OutboxMessage = {
      id: "message-old", eventType: "RequestCreated", aggregateType: "DiagnosticRequest", aggregateId: "request-a",
      payload: { requestId: "request-a" }, consumerType: "DOMAIN_EVENT", routingKey: "domain.RequestCreated",
      status: "PENDING", attempts: 0, availableAt: "2026-10-04T12:00:00.000Z", correlationId: "correlation-a"
    };
    const newer = { ...message, id: "message-new", status: "PROCESSED" as const };
    queueReadyOpen(initial);
    const store = await PostgresStore.create("postgres://test.invalid/cvg_test_durable_outbox_read");
    try {
      pool.query.mockResolvedValueOnce(result(2, [newer, message]));
      await expect(store.readOutbox({ kind: "replay", limit: 2 })).resolves.toEqual([message, newer]);
      expect(pool.query.mock.calls.at(-1)).toEqual([expect.stringContaining("'PENDING', 'PROCESSED'"), [2]]);
      const failed = { ...message, id: "message-failed", status: "FAILED" as const, lastError: "delivery failed" };
      pool.query.mockResolvedValueOnce(result(1, [failed]));
      await expect(store.readOutbox({ kind: "dead-letter", limit: 1 })).resolves.toEqual([failed]);
      expect(pool.query.mock.calls.at(-1)).toEqual([expect.stringContaining("'FAILED', 'DISCARDED'"), [1]]);
      pool.query.mockResolvedValueOnce(result(1, [{ pending: "3", oldest: new Date(message.availableAt) }]));
      await expect(store.readOutboxMetrics()).resolves.toEqual({ pending: 3, oldestAvailableAt: message.availableAt });
      pool.query.mockResolvedValueOnce(result(1, [{ pending: "0", oldest: null }]));
      await expect(store.readOutboxMetrics()).resolves.toEqual({ pending: 0 });
      expect(pool.connect).not.toHaveBeenCalled();
      expect(store.getState()).toEqual(initial);
    } finally {
      await store.close();
    }
    const calls = pool.query.mock.calls.length;
    await expect(store.readOutbox({ kind: "replay", limit: 2 })).rejects.toThrow("PostgreSQL store is closing or closed.");
    await expect(store.readOutboxMetrics()).rejects.toThrow("PostgreSQL store is closing or closed.");
    expect(pool.query).toHaveBeenCalledTimes(calls);
  });

  it("reads durable audit pages, actors and metrics with bounded queries and rejects invalid pages before SQL", async () => {
    const initial = createDemoState("postgres-durable-audit-read-password");
    const event: AuditEvent = {
      id: "audit-a", eventType: "RequestCreated", actorId: "user-vet", entityType: "DiagnosticRequest",
      entityId: "request-a", correlationId: "correlation-a", metadata: { source: "unit" }, occurredAt: "2026-10-04T12:00:00.000Z"
    };
    const scope = { entities: [{ entityType: event.entityType, entityId: event.entityId }] };
    queueReadyOpen(initial);
    const store = await PostgresStore.create("postgres://test.invalid/cvg_test_durable_audit_read");
    try {
      const calls = pool.query.mock.calls.length;
      await expect(store.readAuditEvents({ scope, order: "desc", limit: 0 })).rejects.toThrow("AUDIT_READ_QUERY_INVALID");
      expect(pool.query).toHaveBeenCalledTimes(calls);
      pool.query.mockResolvedValueOnce(result(1, [{ total: "2", events: [event, { ...event, id: "audit-b" }] }]));
      await expect(store.readAuditEvents({ scope, order: "desc", limit: 1 }))
        .resolves.toEqual({ total: 2, items: [event], hasMore: true });
      expect(pool.query.mock.calls.at(-1)?.[1]).toEqual([JSON.stringify(scope.entities), [], false, "[]", null, null, 2]);
      pool.query.mockResolvedValueOnce(result(1, [{ total: "2", events: [{ ...event, id: "audit-b" }] }]));
      await expect(store.readAuditEvents({ scope, order: "desc", limit: 1, cursor: { occurredAt: event.occurredAt, id: event.id } }))
        .resolves.toEqual({ total: 2, items: [{ ...event, id: "audit-b" }], hasMore: false });
      const beforeActors = pool.query.mock.calls.length;
      await expect(store.readAuditActors([])).resolves.toEqual([]);
      expect(pool.query).toHaveBeenCalledTimes(beforeActors);
      pool.query.mockResolvedValueOnce(result(1, [{ entityId: event.entityId, actorId: event.actorId }]));
      await expect(store.readAuditActors([...scope.entities, ...scope.entities]))
        .resolves.toEqual([{ entityId: "request-a", actorId: "user-vet" }]);
      expect(pool.query.mock.calls.at(-1)?.[1]).toEqual([["request-a"]]);
      pool.query.mockResolvedValueOnce(result(1, [{ recollections: 1, latency: 30 }]));
      await expect(store.readAuditMetrics({ requestCount: 2, samples: [{ id: "sample-a", requestId: "request-a" }], releasedVersions: [] }))
        .resolves.toEqual({ recollectionRate: 0.5, resultViewLatencySeconds: 30 });
      pool.query.mockResolvedValueOnce(result(1, [{ recollections: 0, latency: null }]));
      await expect(store.readAuditMetrics({ requestCount: 0, samples: [], releasedVersions: [] }))
        .resolves.toEqual({ recollectionRate: undefined, resultViewLatencySeconds: undefined });
      expect(pool.connect).not.toHaveBeenCalled();
      expect(store.getState()).toEqual(initial);
    } finally {
      await store.close();
    }
  });
});
