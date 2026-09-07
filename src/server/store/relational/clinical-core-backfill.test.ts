import { describe, expect, it } from "vitest";
import type { DiagnosticItem, DiagnosticRequest, Sample, StoreState } from "../../domain/models";
import { createDemoState } from "../fixtures";
import type { RelationalSqlClient } from "./clinical-core-contracts";
import {
  RELATIONAL_CLINICAL_CORE_BACKFILL_TRANSFORM_VERSION,
  backfillFailureCode,
  checkpointRelationalClinicalCoreBackfillRun,
  completeRelationalClinicalCoreBackfillRun,
  emptyRelationalClinicalCoreState,
  failRelationalClinicalCoreBackfillRun,
  insertRelationalClinicalCoreBackfillRun,
  normalizeRelationalClinicalCoreBackfillOptions,
  readRelationalClinicalCoreBackfillRun,
  relationalClinicalCoreRequestIds,
  relationalClinicalCoreRowCount,
  relationalClinicalCoreSourceHash,
  resumeRelationalClinicalCoreBackfillRun,
  stateForRelationalClinicalRequest,
  verifyRelationalClinicalCoreCompleteness
} from "./clinical-core-backfill";

const SOURCE_HASH = "a".repeat(64);

function runRow(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    run_id: "run-1",
    scope: "CLINICAL_CORE_REQUESTS",
    source_authority: "SNAPSHOT",
    target_authority: "RELATIONAL_SHADOW",
    transform_version: RELATIONAL_CLINICAL_CORE_BACKFILL_TRANSFORM_VERSION,
    source_snapshot_version: "7",
    source_snapshot_hash: SOURCE_HASH,
    status: "RUNNING",
    last_request_id: null,
    requests_processed: "0",
    rows_projected: "0",
    requests_reconciled: "0",
    failure_code: null,
    completed_at: null,
    ...overrides
  };
}

function requestState(): { readonly state: StoreState; readonly request: DiagnosticRequest; readonly item: DiagnosticItem; readonly sample: Sample } {
  const state = createDemoState("backfill-unit-password");
  const request: DiagnosticRequest = {
    id: "request-backfill-unit",
    requestCode: "BF-UNIT-001",
    patientId: "patient-thor",
    encounterId: "encounter-thor",
    requesterId: "user-vet",
    requestingDepartmentCode: "INPATIENT",
    priority: "ROUTINE",
    aggregateStatus: "IN_PROGRESS",
    itemIds: ["item-backfill-unit"],
    createdAt: "2026-09-06T01:00:00.000Z",
    updatedAt: "2026-09-06T01:30:00.000Z",
    version: 1
  };
  const item: DiagnosticItem = {
    id: "item-backfill-unit",
    requestId: request.id,
    serviceId: "service-hemogram",
    departmentCode: "LABORATORY",
    workflowType: "LABORATORY",
    priority: "ROUTINE",
    status: "RECEIVED",
    requestedAt: request.createdAt,
    receivedAt: request.updatedAt,
    slaStartedAt: request.createdAt,
    dueAt: "2026-09-06T09:00:00.000Z",
    slaPolicyVersion: 1,
    version: 1
  };
  const sample: Sample = {
    id: "sample-backfill-unit",
    requestId: request.id,
    accessionCode: "BF-UNIT-001",
    sampleType: "EDTA",
    status: "RECEIVED",
    itemIds: [item.id],
    collectedAt: request.createdAt,
    receivedAt: request.updatedAt,
    receivedBy: "user-lab",
    version: 1
  };
  return {
    state: { ...state, requests: [request], items: [item], samples: [sample] },
    request,
    item,
    sample
  };
}

function controlClient(rows: readonly Record<string, unknown>[] = [runRow()]): RelationalSqlClient & { readonly queries: string[] } {
  const queries: string[] = [];
  return {
    queries,
    async query(text: string) {
      queries.push(text);
      const normalized = text.trimStart();
      if (normalized.startsWith("SELECT run_id")) return { rowCount: rows.length, rows };
      if (normalized.startsWith("INSERT INTO relational_backfill_runs")) return { rowCount: 1, rows: [runRow()] };
      if (normalized.startsWith("SELECT count(*)")) return { rowCount: 1, rows: [{ row_count: "0" }] };
      return { rowCount: 1, rows: [] };
    }
  };
}

describe("PostgreSQL clinical-core backfill contract", () => {
  it("normalizes safe options, sorts requests and isolates one request aggregate", () => {
    const controller = new AbortController();
    const options = normalizeRelationalClinicalCoreBackfillOptions({
      runId: "run-unit",
      batchSize: 2,
      signal: controller.signal
    });
    expect(options).toEqual({
      runId: "run-unit",
      transformVersion: RELATIONAL_CLINICAL_CORE_BACKFILL_TRANSFORM_VERSION,
      batchSize: 2,
      signal: controller.signal
    });
    expect(() => normalizeRelationalClinicalCoreBackfillOptions({ transformVersion: " v1" })).toThrow("TRANSFORM_INVALID");
    expect(() => normalizeRelationalClinicalCoreBackfillOptions({ transformVersion: "clinical-core-request-v2" })).toThrow("TRANSFORM_INVALID");
    expect(() => normalizeRelationalClinicalCoreBackfillOptions({ batchSize: 101 })).toThrow("BATCH_SIZE_INVALID");
    expect(() => normalizeRelationalClinicalCoreBackfillOptions({ runId: "bad id" })).toThrow("RUN_ID_INVALID");

    const { state, request, item, sample } = requestState();
    const withSecondRequest = {
      ...state,
      requests: [{ ...request, id: "request-z" }, request],
      items: [{ ...item, id: "item-z", requestId: "request-z" }, item],
      samples: [{ ...sample, id: "sample-z", requestId: "request-z", itemIds: ["item-z"], accessionCode: "BF-UNIT-002" }, sample]
    };
    expect(relationalClinicalCoreRequestIds(withSecondRequest)).toEqual([request.id, "request-z"]);
    expect(() => relationalClinicalCoreRequestIds({ ...state, requests: [request, request] })).toThrow("REQUEST_ID_DUPLICATE");
    const scoped = stateForRelationalClinicalRequest(withSecondRequest, request.id);
    expect(scoped.requests).toHaveLength(1);
    expect(scoped.items).toEqual([item]);
    expect(scoped.samples).toEqual([sample]);
    expect(relationalClinicalCoreRowCount(scoped)).toBe(4);
    expect(emptyRelationalClinicalCoreState(scoped).requests).toEqual([]);
    expect(relationalClinicalCoreSourceHash(state)).toBe(relationalClinicalCoreSourceHash({ ...state, requests: [...state.requests].reverse() }));
  });

  it("fails closed when a request membership or request lookup is not lossless", () => {
    const { state, request } = requestState();
    expect(() => stateForRelationalClinicalRequest(state, "missing-request")).toThrow("REQUEST_MISSING");
    expect(() => stateForRelationalClinicalRequest({ ...state, requests: [{ ...request, itemIds: ["missing-item"] }] }, request.id))
      .toThrow("REQUEST_ITEMS_MISMATCH");
    expect(() => stateForRelationalClinicalRequest({
      ...state,
      items: [...state.items, { ...state.items[0], id: "item-extra" }]
    }, request.id)).toThrow("REQUEST_ITEMS_MISMATCH");
    expect(() => relationalClinicalCoreRequestIds({ ...state, requests: [{ ...request, id: "" }] }))
      .toThrow("REQUEST_ID_INVALID");
  });

  it("persists and parses the durable run contract through parameterized SQL", async () => {
    const client = controlClient([]);
    await expect(readRelationalClinicalCoreBackfillRun(client, "run-1")).resolves.toBeUndefined();
    const inserted = await insertRelationalClinicalCoreBackfillRun(client, {
      runId: "run-1",
      transformVersion: RELATIONAL_CLINICAL_CORE_BACKFILL_TRANSFORM_VERSION,
      sourceSnapshotVersion: 7,
      sourceSnapshotHash: SOURCE_HASH
    });
    expect(inserted).toMatchObject({ runId: "run-1", status: "RUNNING", sourceSnapshotVersion: 7 });

    const loaded = await readRelationalClinicalCoreBackfillRun(controlClient([runRow({ last_request_id: "request-1" })]), "run-1");
    expect(loaded).toMatchObject({ lastRequestId: "request-1" });
    await resumeRelationalClinicalCoreBackfillRun(client, "run-1");
    await checkpointRelationalClinicalCoreBackfillRun(client, "run-1", "request-1", 1, 4, 1);
    await completeRelationalClinicalCoreBackfillRun(client, "run-1");
    await failRelationalClinicalCoreBackfillRun(client, "run-1", "POSTGRES_RELATIONAL_BACKFILL_FAILED");
    await verifyRelationalClinicalCoreCompleteness(client, createDemoState("backfill-empty-password"));
    const extraRowClient: RelationalSqlClient = {
      async query(text: string) {
        if (text.startsWith("SELECT id FROM diagnostic_requests")) return { rowCount: 1, rows: [{ id: "unexpected-request" }] };
        return { rowCount: 1, rows: [] };
      }
    };
    await expect(verifyRelationalClinicalCoreCompleteness(extraRowClient, createDemoState("backfill-empty-password")))
      .rejects.toThrow("COMPLETENESS_MISMATCH:diagnostic_requests");
    expect(client.queries.some((query) => query.includes("WHERE run_id = $1"))).toBe(true);
  });

  it("sanitizes failure records without leaking row values", () => {
    expect(backfillFailureCode(new Error("POSTGRES_RELATIONAL_BACKFILL_SOURCE_CHANGED:patient-name")))
      .toBe("POSTGRES_RELATIONAL_BACKFILL_SOURCE_CHANGED");
    expect(backfillFailureCode(Object.assign(new Error("could not serialize access due to concurrent update"), { code: "40001" })))
      .toBe("POSTGRES_RELATIONAL_BACKFILL_SOURCE_CHANGED");
    expect(backfillFailureCode(new Error("foreign key violation with clinical value")))
      .toBe("POSTGRES_RELATIONAL_BACKFILL_FAILED");
    expect(backfillFailureCode("unknown")).toBe("POSTGRES_RELATIONAL_BACKFILL_FAILED");
  });
});
