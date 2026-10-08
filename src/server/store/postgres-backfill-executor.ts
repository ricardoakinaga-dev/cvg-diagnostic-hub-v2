import type { Pool, PoolClient } from "pg";
import type { StoreState } from "../domain/models";
import type { RelationalClinicalCoreRuntime } from "./relational/clinical-core-contracts";
import { loadEntityState } from "./postgres-entity-state";
import {
  assertBackfillNotAborted,
  assertBackfillRunCompatible,
  assertBackfillSourceStable,
  backfillReport,
  relationalClient,
  verifyRelationalClinicalCoreTarget
} from "./postgres-backfill-support";
import {
  backfillFailureCode,
  checkpointRelationalClinicalCoreBackfillRun,
  completeRelationalClinicalCoreBackfillRun,
  emptyRelationalClinicalCoreState,
  failRelationalClinicalCoreBackfillRun,
  insertRelationalClinicalCoreBackfillRun,
  type normalizeRelationalClinicalCoreBackfillOptions,
  readRelationalClinicalCoreBackfillRun,
  relationalClinicalCoreRequestIds,
  relationalClinicalCoreRowCount,
  relationalClinicalCoreSourceHash,
  resumeRelationalClinicalCoreBackfillRun,
  stateForRelationalClinicalRequest,
  type RelationalClinicalCoreBackfillReport,
  type RelationalClinicalCoreBackfillRun
} from "./relational/clinical-core-backfill";
import {
  assertReconciliationClean,
  reconcileRelationalRequest
} from "./relational/cutover";

interface PostgresBackfillExecution {
  readonly pool: Pick<Pool, "connect">;
  readonly adapter: RelationalClinicalCoreRuntime;
  readonly allowUnvalidatedSampleMembership: boolean;
  readonly normalized: ReturnType<typeof normalizeRelationalClinicalCoreBackfillOptions>;
  readonly runId: string;
}

/**
 * The backfill source is the whole runtime aggregate. Inside the batch
 * transactions `lock` takes the cvg_runtime_state row lock first, as the
 * former `SELECT ... FOR UPDATE` on the snapshot row did.
 */
async function loadSourceSnapshot(client: PoolClient, lock: boolean): Promise<{ state: StoreState; version: number }> {
  if (lock) return loadEntityState(client, { lock: true });
  // Outside a transaction: one REPEATABLE READ view for the header and the entities.
  await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
  try {
    const snapshot = await loadEntityState(client);
    await client.query("COMMIT");
    return snapshot;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  }
}

/** Executes a stable-source backfill; the store owns enqueue and shutdown. */
export async function executePostgresClinicalCoreBackfill({
  pool, adapter, allowUnvalidatedSampleMembership, normalized, runId
}: PostgresBackfillExecution): Promise<RelationalClinicalCoreBackfillReport> {
  const lockClient = await pool.connect();
  const client = relationalClient(lockClient);
  let runInitialized = false;
  let transactionOpen = false;
  try {
    await lockClient.query("SELECT pg_advisory_lock(hashtext($1))", [`cvg_relational_backfill:${runId}`]);
    await adapter.assertReady(client, {
      allowUnvalidatedSampleMembership
    });

    const initial = await loadSourceSnapshot(lockClient, false);
    const sourceSnapshotVersion = initial.version;
    const sourceState = initial.state;
    const sourceSnapshotHash = relationalClinicalCoreSourceHash(sourceState);
    const requestIds = relationalClinicalCoreRequestIds(sourceState);
    const existing = await readRelationalClinicalCoreBackfillRun(client, runId);
    let run: RelationalClinicalCoreBackfillRun;
    if (!existing) {
      run = await insertRelationalClinicalCoreBackfillRun(client, {
        runId,
        transformVersion: normalized.transformVersion,
        sourceSnapshotVersion,
        sourceSnapshotHash
      });
    } else {
      runInitialized = true;
      assertBackfillRunCompatible(existing, normalized.transformVersion, sourceSnapshotVersion, sourceSnapshotHash);
      if (existing.status === "FAILED") await resumeRelationalClinicalCoreBackfillRun(client, runId);
      run = existing.status === "FAILED"
        ? { ...existing, status: "RUNNING", failureCode: undefined, completedAt: undefined }
        : existing;
    }
    runInitialized = true;

    if (run.status === "COMPLETED") {
      await lockClient.query("BEGIN");
      transactionOpen = true;
      try {
        await lockClient.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ");
        assertBackfillSourceStable(await loadSourceSnapshot(lockClient, true), sourceSnapshotVersion, sourceSnapshotHash);
        for (const requestId of requestIds) {
          await adapter.repairSampleMembership(
            client,
            stateForRelationalClinicalRequest(sourceState, requestId)
          );
        }
        await verifyRelationalClinicalCoreTarget(adapter, client, sourceState, requestIds);
        await adapter.validateSampleMembership(client);
        await adapter.assertReady(client);
        await lockClient.query("COMMIT");
        transactionOpen = false;
      } catch (error) {
        await lockClient.query("ROLLBACK").catch(() => undefined);
        transactionOpen = false;
        throw error;
      }
      return backfillReport(run, requestIds.length, run.lastRequestId);
    }

    const resumeCursor = run.lastRequestId;
    const cursorIndex = resumeCursor === undefined ? -1 : requestIds.indexOf(resumeCursor);
    if (resumeCursor !== undefined && cursorIndex < 0) {
      throw new Error("POSTGRES_RELATIONAL_BACKFILL_CHECKPOINT_CURSOR_INVALID");
    }
    let requestsProcessed = run.requestsProcessed;
    let rowsProjected = run.rowsProjected;
    let requestsReconciled = run.requestsReconciled;
    const firstRequestIndex = cursorIndex + 1;

    for (let batchStart = firstRequestIndex; batchStart < requestIds.length; batchStart += normalized.batchSize) {
      assertBackfillNotAborted(normalized.signal);
      const batchIds = requestIds.slice(batchStart, batchStart + normalized.batchSize);
      await lockClient.query("BEGIN");
      transactionOpen = true;
      try {
        await lockClient.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ");
        assertBackfillSourceStable(await loadSourceSnapshot(lockClient, true), sourceSnapshotVersion, sourceSnapshotHash);
        await lockClient.query("SET CONSTRAINTS ALL DEFERRED");
        let batchRowsProjected = 0;
        for (const requestId of batchIds) {
          assertBackfillNotAborted(normalized.signal);
          const scopedState = stateForRelationalClinicalRequest(sourceState, requestId);
          await adapter.repairSampleMembership(client, scopedState);
          await adapter.projectStateDelta(
            client,
            emptyRelationalClinicalCoreState(scopedState),
            scopedState
          );
          const relational = await adapter.readRequest(client, requestId);
          const reconciliation = reconcileRelationalRequest(scopedState, requestId, relational);
          assertReconciliationClean(reconciliation);
          batchRowsProjected += relationalClinicalCoreRowCount(scopedState);
          requestsProcessed += 1;
          requestsReconciled += 1;
        }
        rowsProjected += batchRowsProjected;
        const lastRequestId = batchIds.at(-1);
        if (!lastRequestId) throw new Error("POSTGRES_RELATIONAL_BACKFILL_BATCH_EMPTY");
        await checkpointRelationalClinicalCoreBackfillRun(
          client,
          runId,
          lastRequestId,
          requestsProcessed,
          rowsProjected,
          requestsReconciled
        );
        await lockClient.query("COMMIT");
        transactionOpen = false;
      } catch (error) {
        await lockClient.query("ROLLBACK").catch(() => undefined);
        transactionOpen = false;
        throw error;
      }
    }

    assertBackfillNotAborted(normalized.signal);
    await lockClient.query("BEGIN");
    transactionOpen = true;
    try {
      await lockClient.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ");
      assertBackfillSourceStable(await loadSourceSnapshot(lockClient, true), sourceSnapshotVersion, sourceSnapshotHash);
      await verifyRelationalClinicalCoreTarget(adapter, client, sourceState, requestIds);
      await adapter.validateSampleMembership(client);
      await adapter.assertReady(client);
      await completeRelationalClinicalCoreBackfillRun(client, runId);
      await lockClient.query("COMMIT");
      transactionOpen = false;
    } catch (error) {
      await lockClient.query("ROLLBACK").catch(() => undefined);
      transactionOpen = false;
      throw error;
    }

    const completed = await readRelationalClinicalCoreBackfillRun(client, runId);
    if (!completed || completed.status !== "COMPLETED") {
      throw new Error("POSTGRES_RELATIONAL_BACKFILL_COMPLETE_STATE_INVALID");
    }
    return backfillReport(completed, requestIds.length, resumeCursor);
  } catch (error) {
    if (transactionOpen) await lockClient.query("ROLLBACK").catch(() => undefined);
    if (runInitialized) await failRelationalClinicalCoreBackfillRun(client, runId, backfillFailureCode(error)).catch(() => undefined);
    throw error;
  } finally {
    await lockClient.query("SELECT pg_advisory_unlock(hashtext($1))", [`cvg_relational_backfill:${runId}`]).catch(() => undefined);
    lockClient.release();
  }
}
