import type { PoolClient } from "pg";
import type { StoreState } from "../domain/models";
import {
  relationalClinicalCoreSourceHash,
  verifyRelationalClinicalCoreCompleteness,
  type RelationalClinicalCoreBackfillRun,
  type RelationalClinicalCoreBackfillReport
} from "./relational/clinical-core-backfill";
import type { RelationalClinicalCoreRuntime, RelationalSqlClient } from "./relational/clinical-core-contracts";
import { assertReconciliationClean, reconcileRelationalRequest } from "./relational/cutover";
import { runtimeStateFromRow, versionFromRow } from "./postgres-state-codec";

/**
 * Pure helpers of the relational backfill runner. They are extracted from the
 * store so the cutover evidence path stays reviewable and so the store file
 * does not grow past the architecture fitness limit (PROD-108).
 */
export function relationalClient(client: PoolClient): RelationalSqlClient {
  return {
    query: (text, values) => client.query(text, values)
  };
}

export async function verifyRelationalClinicalCoreTarget(
  runtime: RelationalClinicalCoreRuntime,
  client: RelationalSqlClient,
  sourceState: StoreState,
  requestIds: readonly string[]
): Promise<void> {
  await verifyRelationalClinicalCoreCompleteness(client, sourceState);
  for (const requestId of requestIds) {
    const relational = await runtime.readRequest(client, requestId);
    const reconciliation = reconcileRelationalRequest(sourceState, requestId, relational);
    assertReconciliationClean(reconciliation);
  }
}

export function assertBackfillRunCompatible(
  run: RelationalClinicalCoreBackfillRun,
  transformVersion: string,
  sourceSnapshotVersion: number,
  sourceSnapshotHash: string
): void {
  if (
    run.transformVersion !== transformVersion
    || run.sourceSnapshotVersion !== sourceSnapshotVersion
    || run.sourceSnapshotHash !== sourceSnapshotHash
  ) {
    throw new Error("POSTGRES_RELATIONAL_BACKFILL_SOURCE_CHANGED");
  }
}

export function assertBackfillSourceStable(
  row: { readonly state: unknown; readonly version: unknown } | undefined,
  sourceSnapshotVersion: number,
  sourceSnapshotHash: string
): void {
  if (!row) throw new Error("PostgreSQL runtime state row is missing.");
  const currentState = runtimeStateFromRow(row);
  if (
    versionFromRow(row.version) !== sourceSnapshotVersion
    || relationalClinicalCoreSourceHash(currentState) !== sourceSnapshotHash
  ) {
    throw new Error("POSTGRES_RELATIONAL_BACKFILL_SOURCE_CHANGED");
  }
}

export function assertBackfillNotAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new Error("POSTGRES_RELATIONAL_BACKFILL_ABORTED");
}

export function backfillReport(
  run: RelationalClinicalCoreBackfillRun,
  requestCount: number,
  resumedFromRequestId: string | undefined
): RelationalClinicalCoreBackfillReport {
  return {
    runId: run.runId,
    scope: run.scope,
    sourceAuthority: run.sourceAuthority,
    targetAuthority: run.targetAuthority,
    transformVersion: run.transformVersion,
    sourceSnapshotVersion: run.sourceSnapshotVersion,
    requestCount,
    requestsProcessed: run.requestsProcessed,
    rowsProjected: run.rowsProjected,
    requestsReconciled: run.requestsReconciled,
    ...(resumedFromRequestId ? { resumedFromRequestId } : {})
  };
}
