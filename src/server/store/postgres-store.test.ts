import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DiagnosticItem, DiagnosticRequest, StoreState } from "../domain/models";
import { createDemoState } from "./fixtures";

const pool = vi.hoisted(() => ({
  connect: vi.fn(),
  end: vi.fn(),
  query: vi.fn()
}));

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
  rate_limit_schema_ready: true,
  relational_clinical_core_ready: true,
  transitional_storage_boundary_ready: true,
  invalidation_trigger_ready: true
};

vi.mock("pg", () => ({
  Pool: class MockPool {
    connect = pool.connect;
    end = pool.end;
    query = pool.query;
  }
}));

import { PostgresStore } from "./postgres-store";

function row(state: ReturnType<typeof createDemoState>, version: string | number = "1") {
  return { rowCount: 1, rows: [{ state, version }] };
}

describe("PostgresStore fresh reads", () => {
  beforeEach(() => {
    pool.connect.mockReset();
    pool.end.mockReset().mockResolvedValue(undefined);
    pool.query.mockReset();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("selects the current versioned row and refreshes an immutable inspection cache", async () => {
    const initial = createDemoState("postgres-read-password");
    const current = {
      ...initial,
      protocolSequence: initial.protocolSequence + 7,
      users: initial.users.map((user) => user.email === "vet@cvg.local" ? { ...user, active: false, version: user.version + 1 } : user)
    };
    pool.query
      .mockResolvedValueOnce(row(initial, "1"))
      .mockResolvedValueOnce({ rowCount: 1, rows: [readyRuntimeSchema] })
      .mockResolvedValueOnce(row(current, "2"))
      .mockResolvedValueOnce(row(current, "2"));
    const store = await PostgresStore.create("postgres://test.invalid/cvg_test_read");

    const fresh = await store.readState();
    fresh.protocolSequence = 999;

    expect(pool.query).toHaveBeenNthCalledWith(3, "SELECT state, version FROM cvg_runtime_state WHERE id = 1");
    expect(store.getState().protocolSequence).toBe(current.protocolSequence);
    expect((await store.readState()).protocolSequence).toBe(current.protocolSequence);
  });

  it("rejects malformed versioned rows without poisoning the last validated cache", async () => {
    const initial = createDemoState("postgres-invalid-password");
    pool.query
      .mockResolvedValueOnce(row(initial, "4"))
      .mockResolvedValueOnce({ rowCount: 1, rows: [readyRuntimeSchema] })
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ state: { users: [] }, version: "not-a-version" }] });
    const store = await PostgresStore.create("postgres://test.invalid/cvg_test_invalid");

    await expect(store.readState()).rejects.toThrow(/runtime state|version/i);

    expect(store.getState()).toEqual(initial);
  });

  it("waits for an in-flight read before closing and rejects new work after close begins", async () => {
    const initial = createDemoState("postgres-close-password");
    let resolveRead!: (value: ReturnType<typeof row>) => void;
    const pendingRead = new Promise<ReturnType<typeof row>>((resolve) => {
      resolveRead = resolve;
    });
    pool.query
      .mockResolvedValueOnce(row(initial, "1"))
      .mockResolvedValueOnce({ rowCount: 1, rows: [readyRuntimeSchema] })
      .mockReturnValueOnce(pendingRead);
    const store = await PostgresStore.create("postgres://test.invalid/cvg_test_close");

    const read = store.readState();
    const closing = store.close();

    await Promise.resolve();
    expect(pool.end).not.toHaveBeenCalled();
    await expect(store.readState()).rejects.toThrow(/closed|closing/i);

    resolveRead(row({ ...initial, protocolSequence: 3 }, "2"));
    await read;
    await closing;

    expect(pool.end).toHaveBeenCalledTimes(1);
    await expect(store.transaction((state) => ({ state, result: undefined }))).rejects.toThrow(/closed|closing/i);
    await expect(store.close()).resolves.toBeUndefined();
    expect(pool.end).toHaveBeenCalledTimes(1);
  });

  it("fails closed when the complete runtime schema is not ready", async () => {
    const initial = createDemoState("postgres-not-ready-password");
    pool.query
      .mockResolvedValueOnce(row(initial, "1"))
      .mockResolvedValueOnce({
        rowCount: 1,
        rows: [{ ...readyRuntimeSchema, audit_append_only_ready: false }]
      });

    await expect(PostgresStore.create("postgres://test.invalid/cvg_test_not_ready"))
      .rejects.toThrow("POSTGRES_RUNTIME_SCHEMA_NOT_READY");

    expect(pool.end).toHaveBeenCalledOnce();
  });

  it("rejects removal of an audit event from the transactional snapshot", async () => {
    const base = createDemoState("postgres-audit-password");
    const initial: StoreState = {
      ...base,
      auditEvents: [{
        id: "audit-existing",
        eventType: "ExistingAudit",
        entityType: "DiagnosticRequest",
        entityId: "request-existing",
        correlationId: "correlation-existing",
        metadata: {},
        occurredAt: "2026-08-22T00:00:00.000Z"
      }]
    };
    const client = {
      query: vi.fn(async (text: string) => {
        if (text.includes("FOR UPDATE")) return row(initial, "1");
        if (text.startsWith("UPDATE cvg_runtime_state")) return { rowCount: 1, rows: [{ version: "2" }] };
        return { rowCount: 0, rows: [] };
      }),
      release: vi.fn()
    };
    pool.query
      .mockResolvedValueOnce(row(initial, "1"))
      .mockResolvedValueOnce({ rowCount: 1, rows: [readyRuntimeSchema] });
    pool.connect.mockResolvedValueOnce(client);
    const store = await PostgresStore.create("postgres://test.invalid/cvg_test_audit");

    await expect(store.transaction((state) => ({
      state: { ...state, auditEvents: [] },
      result: undefined
    }))).rejects.toThrow("POSTGRES_AUDIT_LOG_MUTATION");

    expect(client.query).not.toHaveBeenCalledWith(expect.stringContaining("UPDATE cvg_runtime_state"), expect.anything());
  });

  it("allows an explicitly authorized administrative reset to be repeated without removing audit history", async () => {
    vi.stubEnv("ALLOW_DB_SMOKE_RESET", "true");
    const base = createDemoState("postgres-reset-password");
    const existingAuditEvent = {
      id: "audit-before-reset",
      eventType: "ExistingAudit",
      entityType: "DiagnosticRequest",
      entityId: "request-before-reset",
      correlationId: "correlation-before-reset",
      metadata: { retained: true },
      occurredAt: "2026-08-22T00:00:00.000Z"
    };
    const initial: StoreState = {
      ...base,
      protocolSequence: 9,
      auditEvents: [existingAuditEvent],
      outbox: [{
        id: "outbox-before-reset",
        eventType: "RequestCreated",
        aggregateType: "DiagnosticRequest",
        aggregateId: "request-before-reset",
        payload: {},
        consumerType: "DOMAIN_EVENT",
        routingKey: "domain.RequestCreated",
        status: "PENDING" as const,
        attempts: 0,
        availableAt: "2026-08-22T00:00:00.000Z",
        correlationId: "correlation-before-reset"
      }]
    };
    const resetTarget = {
      ...createDemoState("postgres-reset-password"),
      protocolSequence: 1,
      auditEvents: []
    };
    let persistedState: StoreState = structuredClone(initial);
    let persistedVersion = 1;
    const projectedAuditIds = new Set(initial.auditEvents.map((event) => event.id));
    const projectedOutboxIds = new Set(initial.outbox.map((message) => message.id));
    const client = {
      query: vi.fn(async (text: string, values?: readonly unknown[]) => {
        if (text.includes("FOR UPDATE")) return row(persistedState, String(persistedVersion));
        if (text.startsWith("UPDATE cvg_runtime_state")) {
          persistedState = JSON.parse(String(values?.[0])) as StoreState;
          persistedVersion += 1;
          return { rowCount: 1, rows: [{ version: String(persistedVersion) }] };
        }
        if (text === "DELETE FROM outbox_messages") {
          projectedOutboxIds.clear();
          return { rowCount: 1, rows: [] };
        }
        if (text.startsWith("INSERT INTO audit_events")) {
          const eventId = String(values?.[0]);
          if (projectedAuditIds.has(eventId)) return { rowCount: 0, rows: [] };
          projectedAuditIds.add(eventId);
          return { rowCount: 1, rows: [{ id: eventId }] };
        }
        return { rowCount: 0, rows: [] };
      }),
      release: vi.fn()
    };
    pool.query
      .mockResolvedValueOnce(row(initial, "1"))
      .mockResolvedValueOnce({ rowCount: 1, rows: [readyRuntimeSchema] });
    pool.connect.mockResolvedValue(client);
    const store = await PostgresStore.create("postgres://test:test@127.0.0.1/cvg_test_reset");

    await store.reset(resetTarget, { authorization: "ALLOW_DB_SMOKE_RESET" });
    await store.reset(resetTarget, { authorization: "ALLOW_DB_SMOKE_RESET" });

    expect(persistedState.protocolSequence).toBe(1);
    expect(persistedState.auditEvents[0]).toEqual(existingAuditEvent);
    const resetAuditEvents = persistedState.auditEvents.filter((event) => event.eventType === "PostgresAdministrativeReset");
    expect(resetAuditEvents).toHaveLength(2);
    expect(new Set(resetAuditEvents.map((event) => event.correlationId)).size).toBe(2);
    expect(resetAuditEvents.every((event) => event.actorId === undefined)).toBe(true);
    expect(resetAuditEvents).toEqual(expect.arrayContaining([
      expect.objectContaining({
        entityType: "RuntimeState",
        entityId: "cvg-runtime-state",
        metadata: {
          authorization: "ALLOW_DB_SMOKE_RESET",
          databaseHost: "127.0.0.1",
          databaseName: "cvg_test_reset"
        }
      })
    ]));
    expect(projectedAuditIds.size).toBe(3);
    expect(projectedOutboxIds).toEqual(new Set());
    expect(client.query.mock.calls.filter(([text]) => String(text).startsWith("UPDATE cvg_runtime_state"))).toHaveLength(2);
  });

  it("rejects an administrative reset without explicit authorization", async () => {
    const initial = createDemoState("postgres-reset-authorization-password");
    pool.query
      .mockResolvedValueOnce(row(initial, "1"))
      .mockResolvedValueOnce({ rowCount: 1, rows: [readyRuntimeSchema] });
    const store = await PostgresStore.create("postgres://test.invalid/cvg_test_reset_authorization");

    await expect(store.reset(initial)).rejects.toThrow("POSTGRES_ADMIN_RESET_REQUIRES_AUTHORIZATION");

    expect(pool.connect).not.toHaveBeenCalled();
  });

  it("does not accept an authorization literal without the matching environment opt-in", async () => {
    vi.stubEnv("ALLOW_DB_SMOKE_RESET", "false");
    const initial = createDemoState("postgres-reset-opt-in-password");
    pool.query
      .mockResolvedValueOnce(row(initial, "1"))
      .mockResolvedValueOnce({ rowCount: 1, rows: [readyRuntimeSchema] });
    const store = await PostgresStore.create("postgres://test:test@127.0.0.1/cvg_test_reset_opt_in");

    await expect(store.reset(initial, { authorization: "ALLOW_DB_SMOKE_RESET" }))
      .rejects.toThrow("POSTGRES_ADMIN_RESET_REQUIRES_AUTHORIZATION");

    expect(pool.connect).not.toHaveBeenCalled();
  });

  it("rejects a synthetic reset against a remote database even with environment opt-in", async () => {
    vi.stubEnv("ALLOW_SYNTHETIC_SEED", "true");
    const initial = createDemoState("postgres-reset-target-password");
    pool.query
      .mockResolvedValueOnce(row(initial, "1"))
      .mockResolvedValueOnce({ rowCount: 1, rows: [readyRuntimeSchema] });
    const store = await PostgresStore.create("postgres://test:test@db.example.test/cvg_diagnostics");

    await expect(store.reset(initial, { authorization: "ALLOW_SYNTHETIC_SEED" }))
      .rejects.toThrow("POSTGRES_ADMIN_RESET_TARGET_NOT_ALLOWED");

    expect(pool.connect).not.toHaveBeenCalled();
  });

  it("rejects remote fallback initialization before inserting a missing runtime row", async () => {
    vi.stubEnv("ALLOW_SYNTHETIC_SEED", "true");
    const fallbackState = createDemoState("postgres-initialization-target-password");
    pool.query
      .mockResolvedValueOnce({ rowCount: 0, rows: [] })
      .mockResolvedValueOnce({ rowCount: 1, rows: [] })
      .mockResolvedValueOnce(row(fallbackState, "1"))
      .mockResolvedValueOnce({ rowCount: 1, rows: [readyRuntimeSchema] });

    await expect(PostgresStore.create(
      "postgres://test:test@db.example.test/cvg_diagnostics",
      fallbackState,
      { authorization: "ALLOW_SYNTHETIC_SEED" }
    )).rejects.toThrow("POSTGRES_INITIALIZATION_TARGET_NOT_ALLOWED");

    expect(pool.query).not.toHaveBeenCalledWith(
      expect.stringContaining("INSERT INTO cvg_runtime_state"),
      expect.anything()
    );
    expect(pool.end).toHaveBeenCalledOnce();
  });
});

/** Unit-level store tests use mocked clients; live coverage is in tests/postgres/. */
describe("PostgresStore relational clinical core seam (static/mocked)", () => {
  beforeEach(() => {
    pool.connect.mockReset();
    pool.end.mockReset().mockResolvedValue(undefined);
    pool.query.mockReset();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  function relationalRequest(): DiagnosticRequest {
    return {
      id: "request-with-hyphen",
      requestCode: "EX-260904-0001",
      patientId: "patient-with-hyphen",
      encounterId: "encounter-with-hyphen",
      requesterId: "user-with-hyphen",
      requestingDepartmentCode: "INPATIENT",
      priority: "ROUTINE",
      aggregateStatus: "REQUESTED",
      itemIds: ["item-with-hyphen"],
      createdAt: "2026-09-04T12:00:00.000Z",
      updatedAt: "2026-09-04T12:00:00.000Z",
      version: 1
    };
  }

  function relationalItem(): DiagnosticItem {
    return {
      id: "item-with-hyphen",
      requestId: "request-with-hyphen",
      serviceId: "service-with-hyphen",
      departmentCode: "LABORATORY",
      workflowType: "LABORATORY",
      priority: "ROUTINE",
      status: "REQUESTED",
      requestedAt: "2026-09-04T12:00:00.000Z",
      slaStartedAt: "2026-09-04T12:00:00.000Z",
      dueAt: "2026-09-04T20:00:00.000Z",
      slaPolicyVersion: 1,
      version: 1
    };
  }

  function readyAdapterRow(overrides: Record<string, boolean> = {}) {
    return {
      marker_ready: true,
      tables_ready: true,
      write_shape_ready: true,
      constraints_ready: true,
      ...overrides
    };
  }

  it("requires explicit opt-in and joins relational writes to the existing transaction", async () => {
    const initial = createDemoState("postgres-relational-seam-password");
    const request = relationalRequest();
    const item = relationalItem();
    const client = {
      query: vi.fn(async (text: string, _values?: readonly unknown[]) => {
        if (text.includes("FOR UPDATE")) return row(initial, "1");
        if (text.startsWith("UPDATE cvg_runtime_state")) return { rowCount: 1, rows: [{ version: "2" }] };
        return { rowCount: 1, rows: [{ id: "relational-row", version: 2 }] };
      }),
      release: vi.fn()
    };
    pool.query
      .mockResolvedValueOnce(row(initial, "1"))
      .mockResolvedValueOnce({ rowCount: 1, rows: [readyRuntimeSchema] })
      .mockResolvedValueOnce({ rowCount: 1, rows: [readyAdapterRow()] });
    pool.connect.mockResolvedValueOnce(client);
    const store = await PostgresStore.createWithRelationalClinicalCore(
      "postgres://test.invalid/cvg_test_relational_seam"
    );

    await store.transaction((state) => ({
      state: { ...state, requests: [request], items: [item] },
      result: undefined
    }));

    expect(client.query.mock.calls.map(([text]) => String(text))).toEqual([
      "BEGIN",
      expect.stringContaining("SELECT state, version FROM cvg_runtime_state WHERE id = 1 FOR UPDATE"),
      "SET CONSTRAINTS ALL DEFERRED",
      expect.stringContaining("INSERT INTO diagnostic_requests"),
      expect.stringContaining("INSERT INTO diagnostic_request_items"),
      expect.stringContaining("UPDATE cvg_runtime_state"),
      "COMMIT"
    ]);
    expect(client.query.mock.calls.find(([text]) => String(text).startsWith("INSERT INTO diagnostic_requests"))?.[1]?.[0])
      .toBe("request-with-hyphen");
    expect(client.query.mock.calls.find(([text]) => String(text).startsWith("INSERT INTO diagnostic_request_items"))?.[1]?.[0])
      .toBe("item-with-hyphen");
    await store.close();
  });

  it("closes the pool when the opt-in relational readiness contract is incomplete", async () => {
    const initial = createDemoState("postgres-relational-not-ready-password");
    pool.query
      .mockResolvedValueOnce(row(initial, "1"))
      .mockResolvedValueOnce({ rowCount: 1, rows: [readyRuntimeSchema] })
      .mockResolvedValueOnce({ rowCount: 1, rows: [readyAdapterRow({ tables_ready: false })] });

    await expect(PostgresStore.createWithRelationalClinicalCore(
      "postgres://test.invalid/cvg_test_relational_not_ready"
    )).rejects.toThrow("POSTGRES_RELATIONAL_CLINICAL_CORE_NOT_READY");
    expect(pool.end).toHaveBeenCalledOnce();
  });

  it("exposes the relational request read seam only after opt-in readiness", async () => {
    const initial = createDemoState("postgres-relational-read-password");
    const relationalAggregate = {
      request: { id: "request-with-hyphen" },
      items: [],
      samples: [],
      sampleItemLinks: [],
      procedures: [],
      schedules: [],
      results: [],
      resultVersions: [],
      attachments: [],
      notifications: []
    };
    pool.query
      .mockResolvedValueOnce(row(initial, "1"))
      .mockResolvedValueOnce({ rowCount: 1, rows: [readyRuntimeSchema] })
      .mockResolvedValueOnce({ rowCount: 1, rows: [readyAdapterRow()] })
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ aggregate: relationalAggregate }] });
    const store = await PostgresStore.createWithRelationalClinicalCore(
      "postgres://test.invalid/cvg_test_relational_read"
    );

    await expect(store.readRelationalClinicalRequest("request-with-hyphen")).resolves.toEqual(relationalAggregate);
    expect(pool.query).toHaveBeenNthCalledWith(
      4,
      expect.stringContaining("FROM diagnostic_requests request_row"),
      ["request-with-hyphen"]
    );
    await store.close();
  });

  it("provides a repeatable dual-read reconciliation report without changing JSONB authority", async () => {
    const base = createDemoState("postgres-relational-reconcile-password");
    const request: DiagnosticRequest = {
      id: "request-with-hyphen",
      requestCode: "EX-260904-0001",
      patientId: "patient-with-hyphen",
      encounterId: "encounter-with-hyphen",
      requesterId: "user-with-hyphen",
      requestingDepartmentCode: "INPATIENT",
      priority: "ROUTINE",
      aggregateStatus: "REQUESTED",
      itemIds: [],
      createdAt: "2026-09-04T12:00:00.000Z",
      updatedAt: "2026-09-04T12:00:00.000Z",
      version: 1
    };
    const initial = { ...base, requests: [request] };
    const relationalAggregate = {
      request: { id: request.id },
      items: [], samples: [], sampleItemLinks: [], procedures: [], schedules: [], results: [], resultVersions: [], attachments: [], notifications: []
    };
    const client = {
      query: vi.fn(async (text: string) => {
        if (text.includes("SELECT state, version FROM cvg_runtime_state WHERE id = 1")) return row(initial, "1");
        if (text.includes("FROM diagnostic_requests request_row")) return { rowCount: 1, rows: [{ aggregate: relationalAggregate }] };
        return { rowCount: 1, rows: [{ id: "relational-row", version: 2 }] };
      }),
      release: vi.fn()
    };
    pool.query
      .mockResolvedValueOnce(row(initial, "1"))
      .mockResolvedValueOnce({ rowCount: 1, rows: [readyRuntimeSchema] })
      .mockResolvedValueOnce({ rowCount: 1, rows: [readyAdapterRow()] });
    pool.connect.mockResolvedValueOnce(client);
    const store = await PostgresStore.createWithRelationalClinicalCore(
      "postgres://test.invalid/cvg_test_relational_reconcile"
    );

    const report = await store.reconcileRelationalClinicalRequest(request.id);
    expect(report.sourceAuthority).toBe("SNAPSHOT");
    expect(report.targetAuthority).toBe("RELATIONAL");
    expect(report.mismatches).toEqual(expect.arrayContaining([
      expect.objectContaining({ entity: "diagnostic_requests", field: "request_code" })
    ]));
    expect(client.query).toHaveBeenNthCalledWith(1, "BEGIN");
    expect(client.query).toHaveBeenNthCalledWith(2, "SET TRANSACTION ISOLATION LEVEL REPEATABLE READ");
    expect(client.query).toHaveBeenCalledWith("COMMIT");
    expect(store.getState()).toEqual(initial);
    await store.close();
  });

  it("rolls back the JSON snapshot when a relational write fails", async () => {
    const initial = createDemoState("postgres-relational-rollback-password");
    const request = relationalRequest();
    const item = relationalItem();
    const client = {
      query: vi.fn(async (text: string, _values?: readonly unknown[]) => {
        if (text.includes("FOR UPDATE")) return row(initial, "1");
        if (text.startsWith("INSERT INTO diagnostic_requests")) throw new Error("foreign key violation");
        return { rowCount: 1, rows: [{ id: "relational-row", version: 2 }] };
      }),
      release: vi.fn()
    };
    pool.query
      .mockResolvedValueOnce(row(initial, "1"))
      .mockResolvedValueOnce({ rowCount: 1, rows: [readyRuntimeSchema] })
      .mockResolvedValueOnce({ rowCount: 1, rows: [readyAdapterRow()] });
    pool.connect.mockResolvedValueOnce(client);
    const store = await PostgresStore.createWithRelationalClinicalCore(
      "postgres://test.invalid/cvg_test_relational_rollback"
    );

    await expect(store.transaction((state) => ({
      state: { ...state, requests: [request], items: [item] },
      result: undefined
    }))).rejects.toThrow("foreign key violation");
    expect(client.query).toHaveBeenCalledWith("ROLLBACK");
    expect(client.query).not.toHaveBeenCalledWith(expect.stringContaining("UPDATE cvg_runtime_state"), expect.anything());
    expect(store.getState()).toEqual(initial);
    await store.close();
  });
});
