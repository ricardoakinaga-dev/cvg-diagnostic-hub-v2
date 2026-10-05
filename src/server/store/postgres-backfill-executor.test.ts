import { describe, expect, it, vi } from "vitest";
import type { Pool, PoolClient } from "pg";
import type { StoreState } from "../domain/models";
import type { RelationalClinicalCoreRuntime, RelationalSqlClient } from "./relational/clinical-core-contracts";
import { createDemoState } from "./fixtures";
import { executePostgresClinicalCoreBackfill } from "./postgres-backfill-executor";
import { CURRENT_STATE_SQL, LOCKED_STATE_SQL } from "./postgres-state-codec";
import {
  normalizeRelationalClinicalCoreBackfillOptions,
  relationalClinicalCoreSourceHash,
  RELATIONAL_CLINICAL_CORE_BACKFILL_SCOPE,
  RELATIONAL_CLINICAL_CORE_BACKFILL_SOURCE,
  RELATIONAL_CLINICAL_CORE_BACKFILL_TARGET,
  RELATIONAL_CLINICAL_CORE_BACKFILL_TRANSFORM_VERSION
} from "./relational/clinical-core-backfill";

const base = createDemoState("postgres-backfill-executor-focused-password");
const runId = "focused-backfill";
const timestamp = "2026-09-06T00:00:00.000Z";

function sourceState(): StoreState {
  return {
    ...structuredClone(base),
    requests: ["request-a", "request-b"].map((id) => ({
      id, requestCode: id, patientId: "patient-thor", encounterId: "encounter-thor",
      requesterId: "user-vet", requestingDepartmentCode: "INPATIENT", priority: "ROUTINE",
      aggregateStatus: "REQUESTED", itemIds: [], createdAt: timestamp, updatedAt: timestamp, version: 1
    }))
  };
}

function harness() {
  const state = sourceState();
  let run: Record<string, unknown> | undefined;
  let savedRun: Record<string, unknown> | undefined;
  const projected = new Set<string>();
  let savedProjected: string[] = [];
  const query = vi.fn(async (text: string, values: unknown[] = []) => {
    if (text === CURRENT_STATE_SQL || text === LOCKED_STATE_SQL) return { rows: [{ state, version: "7" }], rowCount: 1 };
    if (text === "BEGIN") {
      savedRun = structuredClone(run);
      savedProjected = [...projected];
    }
    if (text === "ROLLBACK") {
      run = savedRun;
      projected.clear();
      savedProjected.forEach((id) => projected.add(id));
    }
    if (text.includes("FROM relational_backfill_runs")) return { rows: run ? [structuredClone(run)] : [], rowCount: run ? 1 : 0 };
    if (text.startsWith("INSERT INTO relational_backfill_runs")) {
      run = runRow();
      return { rows: [structuredClone(run)], rowCount: 1 };
    }
    if (text.startsWith("UPDATE relational_backfill_runs")) {
      if (!run) throw new Error("test run missing");
      if (text.includes("last_request_id = $2")) {
        Object.assign(run, { last_request_id: values[1], requests_processed: values[2], rows_projected: values[3], requests_reconciled: values[4] });
      } else if (text.includes("status = 'COMPLETED'")) {
        Object.assign(run, { status: "COMPLETED", completed_at: timestamp });
      } else if (text.includes("status = 'FAILED'")) {
        Object.assign(run, { status: "FAILED", failure_code: values[1] });
      } else {
        Object.assign(run, { status: "RUNNING", failure_code: null, completed_at: null });
      }
      return { rows: [], rowCount: 1 };
    }
    if (text === "SELECT id FROM diagnostic_requests ORDER BY id") {
      return { rows: [...projected].sort().map((id) => ({ id })), rowCount: projected.size };
    }
    return { rows: [], rowCount: 0 };
  });
  const release = vi.fn();
  const lockClient = { query, release } as unknown as PoolClient;
  const pool: Pick<Pool, "connect"> = { connect: vi.fn(async () => lockClient) as Pool["connect"] };
  const adapter = {
    assertReady: vi.fn<RelationalClinicalCoreRuntime["assertReady"]>().mockResolvedValue(undefined),
    repairSampleMembership: vi.fn<RelationalClinicalCoreRuntime["repairSampleMembership"]>().mockResolvedValue(undefined),
    validateSampleMembership: vi.fn<RelationalClinicalCoreRuntime["validateSampleMembership"]>().mockResolvedValue(undefined),
    projectStateDelta: vi.fn(async (_client: RelationalSqlClient, _before: StoreState, after: StoreState) => {
      after.requests.forEach((request) => projected.add(request.id));
    }),
    readRequest: vi.fn(async (_client: RelationalSqlClient, requestId: string) => {
      const request = state.requests.find((candidate) => candidate.id === requestId);
      if (!request || !projected.has(requestId)) return undefined;
      return {
        request: {
          id: request.id, request_code: request.requestCode, patient_id: request.patientId,
          encounter_id: request.encounterId, admission_id: request.admissionId ?? null, requester_id: request.requesterId,
          requesting_department_id: request.requestingDepartmentCode, priority: request.priority,
          aggregate_status: request.aggregateStatus, created_at: request.createdAt,
          updated_at: request.updatedAt, version: request.version
        },
        items: [], samples: [], sampleItemLinks: [], procedures: [], schedules: [], results: [],
        resultVersions: [], attachments: [], notifications: []
      };
    })
  } satisfies RelationalClinicalCoreRuntime;
  function runRow(overrides: Record<string, unknown> = {}) {
    return {
      run_id: runId, scope: RELATIONAL_CLINICAL_CORE_BACKFILL_SCOPE,
      source_authority: RELATIONAL_CLINICAL_CORE_BACKFILL_SOURCE,
      target_authority: RELATIONAL_CLINICAL_CORE_BACKFILL_TARGET,
      transform_version: RELATIONAL_CLINICAL_CORE_BACKFILL_TRANSFORM_VERSION,
      source_snapshot_version: "7", source_snapshot_hash: relationalClinicalCoreSourceHash(state),
      status: "RUNNING", last_request_id: null, requests_processed: 0,
      rows_projected: 0, requests_reconciled: 0, failure_code: null, completed_at: null,
      ...overrides
    };
  }
  return {
    state, query, release, adapter, pool, projected,
    getRun: () => structuredClone(run),
    seedRun: (overrides: Record<string, unknown>) => { run = runRow(overrides); },
    execute: (signal?: AbortSignal, allowUnvalidatedSampleMembership = true) => executePostgresClinicalCoreBackfill({
      pool, adapter, allowUnvalidatedSampleMembership, runId,
      normalized: normalizeRelationalClinicalCoreBackfillOptions({ runId, batchSize: 1, signal })
    })
  };
}

describe("PostgreSQL backfill executor lifecycle", () => {
  it("commits each projection with its checkpoint, then verifies completion and safely replays", async () => {
    const h = harness();
    const before = structuredClone(h.state);
    await expect(h.execute()).resolves.toMatchObject({ requestCount: 2, requestsProcessed: 2, rowsProjected: 2, requestsReconciled: 2 });
    expect(h.getRun()).toMatchObject({ status: "COMPLETED", last_request_id: "request-b" });
    expect(h.adapter.assertReady.mock.calls[0][1]).toEqual({ allowUnvalidatedSampleMembership: true });
    expect(h.query.mock.calls.filter(([text]) => text === "COMMIT")).toHaveLength(3);
    const checkpoints = h.query.mock.calls.filter(([text]) => text.includes("last_request_id = $2"));
    expect(checkpoints.map(([, values]) => values)).toEqual([[runId, "request-a", 1, 1, 1], [runId, "request-b", 2, 2, 2]]);
    expect(h.query.mock.calls[0]).toEqual(["SELECT pg_advisory_lock(hashtext($1))", [`cvg_relational_backfill:${runId}`]]);
    expect(h.query.mock.calls.at(-1)).toEqual(["SELECT pg_advisory_unlock(hashtext($1))", [`cvg_relational_backfill:${runId}`]]);
    expect(h.state).toEqual(before);
    expect(h.query.mock.calls.some(([text]) => /UPDATE cvg_runtime_state/.test(text))).toBe(false);
    await expect(h.execute(undefined, false)).resolves.toMatchObject({ resumedFromRequestId: "request-b", requestsProcessed: 2 });
    expect(h.adapter.projectStateDelta).toHaveBeenCalledTimes(2);
    expect(h.adapter.repairSampleMembership).toHaveBeenCalledTimes(4);
    expect(h.release).toHaveBeenCalledTimes(2);
  });

  it.each(["RUNNING", "FAILED"])("resumes %s from the durable cursor without replaying its committed batch", async (status) => {
    const h = harness();
    h.seedRun({ status, last_request_id: "request-a", requests_processed: 1, rows_projected: 1, requests_reconciled: 1 });
    h.projected.add("request-a");
    await expect(h.execute()).resolves.toMatchObject({ resumedFromRequestId: "request-a", requestsProcessed: 2 });
    expect(h.adapter.projectStateDelta).toHaveBeenCalledTimes(1);
    expect(h.getRun()).toMatchObject({ status: "COMPLETED" });
    expect(h.query.mock.calls.some(([text]) => text.includes("failure_code = NULL, completed_at = NULL"))).toBe(status === "FAILED");
  });

  it("rolls back only the failed batch, records failure and releases the advisory lock", async () => {
    const h = harness();
    const error = new Error("projection failed");
    h.adapter.projectStateDelta.mockImplementationOnce(async (_client, _before, after) => { h.projected.add(after.requests[0].id); }).mockRejectedValueOnce(error);
    await expect(h.execute()).rejects.toBe(error);
    expect(h.getRun()).toMatchObject({ status: "FAILED", last_request_id: "request-a", requests_processed: 1, failure_code: "POSTGRES_RELATIONAL_BACKFILL_FAILED" });
    expect([...h.projected]).toEqual(["request-a"]);
    expect(h.query).toHaveBeenCalledWith("ROLLBACK");
    expect(h.release).toHaveBeenCalledOnce();
  });

  it.each(["RUNNING", "COMPLETED"])("rolls back %s verification failure and keeps the original error through cleanup failures", async (status) => {
    const h = harness();
    h.seedRun({ status });
    if (status === "COMPLETED") h.projected.add("request-a").add("request-b");
    const error = new Error("validation failed");
    h.adapter.validateSampleMembership.mockRejectedValue(error);
    const original = h.query.getMockImplementation()!;
    h.query.mockImplementation(async (text, values) => {
      if (text === "ROLLBACK" || text.includes("status = 'FAILED'") || text.includes("pg_advisory_unlock")) throw new Error("cleanup failed");
      return original(text, values);
    });
    await expect(h.execute()).rejects.toBe(error);
    expect(h.query).toHaveBeenCalledWith("ROLLBACK");
    expect(h.query.mock.calls.some(([text]) => text.includes("status = 'FAILED'"))).toBe(true);
    expect(h.release).toHaveBeenCalledOnce();
  });

  it.each(["missing snapshot", "readiness failure", "incompatible source", "invalid cursor", "invalid completion"])("cleans up on %s", async (failure) => {
    const h = harness();
    const original = h.query.getMockImplementation()!;
    let expected = "";
    if (failure === "missing snapshot") {
      expected = "runtime state row is missing";
      h.query.mockImplementation(async (text, values) => text === CURRENT_STATE_SQL ? { rows: [], rowCount: 0 } : original(text, values));
    } else if (failure === "readiness failure") {
      expected = "readiness failed";
      h.adapter.assertReady.mockRejectedValueOnce(new Error(expected));
    } else if (failure === "incompatible source") {
      expected = "POSTGRES_RELATIONAL_BACKFILL_SOURCE_CHANGED";
      h.seedRun({ source_snapshot_version: "8" });
    } else if (failure === "invalid cursor") {
      expected = "POSTGRES_RELATIONAL_BACKFILL_CHECKPOINT_CURSOR_INVALID";
      h.seedRun({ last_request_id: "request-missing" });
    } else {
      expected = "POSTGRES_RELATIONAL_BACKFILL_COMPLETE_STATE_INVALID";
      h.query.mockImplementation(async (text, values) => text.includes("status = 'COMPLETED'") ? { rows: [], rowCount: 1 } : original(text, values));
    }
    await expect(h.execute()).rejects.toThrow(expected);
    expect(h.release).toHaveBeenCalledOnce();
    expect(h.query.mock.calls.at(-1)?.[0]).toContain("pg_advisory_unlock");
    if (failure === "missing snapshot" || failure === "readiness failure") {
      expect(h.query.mock.calls.some(([text]) => text.includes("status = 'FAILED'"))).toBe(false);
    }
  });

  it("aborts between batches while preserving the last committed checkpoint", async () => {
    const h = harness();
    const controller = new AbortController();
    const original = h.adapter.projectStateDelta.getMockImplementation()!;
    h.adapter.projectStateDelta.mockImplementation(async (...args) => { await original(...args); controller.abort(); });
    await expect(h.execute(controller.signal)).rejects.toThrow("POSTGRES_RELATIONAL_BACKFILL_ABORTED");
    expect(h.getRun()).toMatchObject({ status: "FAILED", last_request_id: "request-a", requests_processed: 1 });
    expect(h.release).toHaveBeenCalledOnce();
  });

  it("refuses a moved source under the transaction lock before projecting", async () => {
    const h = harness();
    const original = h.query.getMockImplementation()!;
    h.query.mockImplementation(async (text, values) => text === LOCKED_STATE_SQL ? { rows: [{ state: h.state, version: "8" }], rowCount: 1 } : original(text, values));
    await expect(h.execute()).rejects.toThrow("POSTGRES_RELATIONAL_BACKFILL_SOURCE_CHANGED");
    expect(h.adapter.projectStateDelta).not.toHaveBeenCalled();
    expect(h.getRun()).toMatchObject({ status: "FAILED", requests_processed: 0 });
    expect(h.query).toHaveBeenCalledWith("ROLLBACK");
    expect(h.release).toHaveBeenCalledOnce();
  });

  it("preserves the projection error when batch rollback rejects and can resume from the durable checkpoint", async () => {
    const h = harness();
    const error = new Error("projection unavailable");
    h.adapter.projectStateDelta.mockRejectedValueOnce(error);
    const original = h.query.getMockImplementation()!;
    h.query.mockImplementation(async (text, values) => {
      if (text === "ROLLBACK") throw new Error("rollback connection lost");
      return original(text, values);
    });

    await expect(h.execute()).rejects.toBe(error);
    expect(h.getRun()).toMatchObject({ status: "FAILED", requests_processed: 0, last_request_id: null });
    expect(h.query).not.toHaveBeenCalledWith("COMMIT");
    expect(h.release).toHaveBeenCalledOnce();

    h.query.mockImplementation(original);
    await expect(h.execute()).resolves.toMatchObject({ requestsProcessed: 2, requestsReconciled: 2 });
    expect(h.getRun()).toMatchObject({ status: "COMPLETED", last_request_id: "request-b" });
    expect(h.release).toHaveBeenCalledTimes(2);
  });

  it("retries cleanup after a synchronous rollback failure and still releases the lock if that retry rejects", async () => {
    const h = harness();
    h.adapter.projectStateDelta.mockRejectedValueOnce(new Error("projection unavailable"));
    const cleanupError = new Error("client cannot dispatch rollback");
    const original = h.query.getMockImplementation()!;
    let rollbackAttempts = 0;
    h.query.mockImplementation((text, values) => {
      if (text === "ROLLBACK") {
        rollbackAttempts += 1;
        if (rollbackAttempts === 1) throw cleanupError;
        return Promise.reject(new Error("connection lost during cleanup retry"));
      }
      return original(text, values);
    });

    await expect(h.execute()).rejects.toBe(cleanupError);
    expect(rollbackAttempts).toBe(2);
    expect(h.query).not.toHaveBeenCalledWith("COMMIT");
    expect(h.getRun()).toMatchObject({ status: "FAILED", requests_processed: 0 });
    expect(h.query.mock.calls.at(-1)).toEqual(["SELECT pg_advisory_unlock(hashtext($1))", [`cvg_relational_backfill:${runId}`]]);
    expect(h.release).toHaveBeenCalledOnce();
  });
});
