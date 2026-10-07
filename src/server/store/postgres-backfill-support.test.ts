import { describe, expect, it } from "vitest";
import type { StoreState } from "../domain/models";
import {
  assertBackfillNotAborted,
  assertBackfillRunCompatible,
  assertBackfillSourceStable,
  backfillReport,
  relationalClient,
  verifyRelationalClinicalCoreTarget
} from "./postgres-backfill-support";
import { createDemoState } from "./fixtures";
import { relationalClinicalCoreSourceHash } from "./relational/clinical-core-backfill";

function backfillRun(overrides: Record<string, unknown> = {}) {
  return {
    runId: "run-1",
    scope: "RELATIONAL_SHADOW",
    sourceAuthority: "JSONB_SNAPSHOT",
    targetAuthority: "RELATIONAL_SHADOW",
    transformVersion: "transform-v1",
    sourceSnapshotVersion: 4,
    sourceSnapshotHash: "hash-1",
    status: "RUNNING" as const,
    requestsProcessed: 3,
    rowsProjected: 12,
    requestsReconciled: 3,
    lastRequestId: "request-3",
    ...overrides
  } as unknown as Parameters<typeof backfillReport>[0];
}

function stateRow(state: StoreState, version: unknown) {
  return { state, version };
}

describe("relational backfill support", () => {
  it("adapts a pool client to the narrow relational contract", async () => {
    const calls: unknown[] = [];
    const client = {
      query: async (text: string, values?: unknown[]) => {
        calls.push([text, values]);
        return { rows: [], rowCount: 0 };
      }
    } as unknown as Parameters<typeof relationalClient>[0];

    const sql = relationalClient(client);
    await sql.query("SELECT 1", [1]);

    expect(calls).toEqual([["SELECT 1", [1]]]);
  });

  it("refuses a run whose transform or source no longer matches", () => {
    const run = backfillRun();

    expect(() => assertBackfillRunCompatible(run, "transform-v1", 4, "hash-1")).not.toThrow();
    expect(() => assertBackfillRunCompatible(run, "transform-v2", 4, "hash-1")).toThrow("POSTGRES_RELATIONAL_BACKFILL_SOURCE_CHANGED");
    expect(() => assertBackfillRunCompatible(run, "transform-v1", 5, "hash-1")).toThrow("POSTGRES_RELATIONAL_BACKFILL_SOURCE_CHANGED");
    expect(() => assertBackfillRunCompatible(run, "transform-v1", 4, "hash-2")).toThrow("POSTGRES_RELATIONAL_BACKFILL_SOURCE_CHANGED");
  });

  it("stops a batch as soon as the source snapshot moved under the run", () => {
    const state = createDemoState("backfill-source-stability-password");
    const hash = "hash-1";

    expect(() => assertBackfillSourceStable(stateRow(state, 4), 4, hash)).toThrow("POSTGRES_RELATIONAL_BACKFILL_SOURCE_CHANGED");
    expect(() => assertBackfillSourceStable(undefined, 4, hash)).toThrow("row is missing");

    const matching = stateRow(state, 4);
    expect(() => assertBackfillSourceStable(matching, 4, relationalHashOf(state))).not.toThrow();
  });

  it("honours an abort signal between batches", () => {
    expect(() => assertBackfillNotAborted(undefined)).not.toThrow();
    const controller = new AbortController();
    expect(() => assertBackfillNotAborted(controller.signal)).not.toThrow();
    controller.abort();
    expect(() => assertBackfillNotAborted(controller.signal)).toThrow("POSTGRES_RELATIONAL_BACKFILL_ABORTED");
  });

  it("reports the projected counters and only names a cursor when resuming", () => {
    const report = backfillReport(backfillRun(), 9, undefined);
    expect(report).toMatchObject({
      runId: "run-1",
      scope: "RELATIONAL_SHADOW",
      sourceAuthority: "JSONB_SNAPSHOT",
      targetAuthority: "RELATIONAL_SHADOW",
      transformVersion: "transform-v1",
      sourceSnapshotVersion: 4,
      requestCount: 9,
      requestsProcessed: 3,
      rowsProjected: 12,
      requestsReconciled: 3
    });
    expect(report).not.toHaveProperty("resumedFromRequestId");
    expect(backfillReport(backfillRun(), 9, "request-2")).toMatchObject({ resumedFromRequestId: "request-2" });
  });

  it("verifies the relational target for every request of the run", async () => {
    const state = createDemoState("backfill-target-verification-password");
    const requestIds = state.requests.slice(0, 2).map((request) => request.id);
    const reads: string[] = [];
    const runtime = {
      readRequest: async (_client: unknown, requestId: string) => {
        reads.push(requestId);
        return {
          request: state.requests.find((request) => request.id === requestId),
          items: [],
          resultVersions: [],
          samples: []
        };
      }
    };
    const client = { query: async () => ({ rows: [], rowCount: 0 }) };

    await verifyRelationalClinicalCoreTarget(
      runtime as unknown as Parameters<typeof verifyRelationalClinicalCoreTarget>[0],
      client as unknown as Parameters<typeof verifyRelationalClinicalCoreTarget>[1],
      state,
      requestIds
    );

    expect(reads).toEqual(requestIds);
  });
});

function relationalHashOf(state: StoreState): string {
  return relationalClinicalCoreSourceHash(state);
}