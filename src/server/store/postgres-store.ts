import { randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import { outboxEnvelopeFor, type RuntimeRetentionOptions, type RuntimeRetentionSummary, type Session, type SessionActivity, type StateStore, type StoreState, type User } from "../domain/models";
import { assertRuntimeSchemaReady } from "./migrations";
import {
  assertAuditEventsAppendOnly,
  cloneState,
  CURRENT_STATE_SQL,
  CURRENT_VERSION_SQL,
  LOCKED_STATE_SQL,
  runtimeStateFromRow,
  stateFromRow,
  versionFromRow
} from "./postgres-state-codec";
import {
  assertBackfillNotAborted,
  assertBackfillRunCompatible,
  assertBackfillSourceStable,
  backfillReport,
  relationalClient,
  verifyRelationalClinicalCoreTarget
} from "./postgres-backfill-support";
import { projectDurableNotificationRows } from "./postgres-notification-projection";
import { readPostgresAuthorizationSnapshot } from "./postgres-authorization-read";
import { deletePostgresProcessedOutbox, prunePostgresSessionActivity, readPostgresSessionActivity, touchPostgresSessionActivity } from "./postgres-session-activity";
import { compactRuntimeState, runtimeRetentionAuditEvent } from "./runtime-retention";
import {
  RelationalClinicalCoreAdapter,
  type RelationalClinicalCoreRuntime,
  type RelationalClinicalRequestRead,
  type RelationalSqlClient
} from "./relational/clinical-core-adapter";
import {
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
  verifyRelationalClinicalCoreCompleteness,
  type RelationalClinicalCoreBackfillOptions,
  type RelationalClinicalCoreBackfillReport,
  type RelationalClinicalCoreBackfillRun
} from "./relational/clinical-core-backfill";
import {
  assertReconciliationClean,
  reconcileRelationalRequest,
  type RelationalRequestReconciliation
} from "./relational/cutover";

export type {
  RelationalClinicalCoreBackfillOptions,
  RelationalClinicalCoreBackfillReport
} from "./relational/clinical-core-backfill";

type DatabaseOperationAuthorization =
  | "ALLOW_SYNTHETIC_SEED"
  | "ALLOW_DB_SMOKE_RESET"
  | "ALLOW_POSTGRES_INTEGRATION_TESTS";

const ADMINISTRATIVE_RESET_AUTHORIZATIONS: ReadonlySet<DatabaseOperationAuthorization> = new Set([
  "ALLOW_SYNTHETIC_SEED",
  "ALLOW_DB_SMOKE_RESET"
]);
const INITIALIZATION_AUTHORIZATIONS: ReadonlySet<DatabaseOperationAuthorization> = new Set([
  "ALLOW_SYNTHETIC_SEED",
  "ALLOW_DB_SMOKE_RESET",
  "ALLOW_POSTGRES_INTEGRATION_TESTS"
]);
const LOOPBACK_DATABASE_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

export interface PostgresAdministrativeResetOptions {
  authorization: "ALLOW_SYNTHETIC_SEED" | "ALLOW_DB_SMOKE_RESET";
}

export interface PostgresInitializationOptions {
  authorization: DatabaseOperationAuthorization;
}

export type PostgresRelationalClinicalCoreReadiness = "STRICT" | "BACKFILL";

/**
 * Explicit opt-in for the 007–009 relational shadow seam. The default PostgresStore
 * remains the transitional StoreState snapshot until the aggregate contract is
 * split and a live backfill/cutover has been proven.
 */
export interface PostgresRelationalClinicalCoreOptions {
  readonly adapter?: RelationalClinicalCoreRuntime;
  readonly fallbackState?: StoreState;
  readonly initialization?: PostgresInitializationOptions;
  /**
   * BACKFILL is an explicit migration-only mode. It permits only the sample
   * membership constraint to remain unvalidated until the backfill repairs and
   * validates every projected sample; normal runtime opens stay STRICT.
   */
  readonly relationalReadiness?: PostgresRelationalClinicalCoreReadiness;
}

interface AuthorizedAdministrativeResetTarget {
  authorization: DatabaseOperationAuthorization;
  databaseHost: string;
  databaseName: string;
}

interface DatabaseAuthorizationErrors {
  forbiddenInProduction: string;
  requiresAuthorization: string;
  targetNotAllowed: string;
}

function assertDatabaseOperationAuthorized(
  connectionString: string,
  authorization: DatabaseOperationAuthorization | undefined,
  allowedAuthorizations: ReadonlySet<DatabaseOperationAuthorization>,
  errors: DatabaseAuthorizationErrors
): AuthorizedAdministrativeResetTarget {
  if (!authorization || !allowedAuthorizations.has(authorization)) {
    throw new Error(errors.requiresAuthorization);
  }
  if (process.env.NODE_ENV === "production") {
    throw new Error(errors.forbiddenInProduction);
  }
  if (process.env[authorization] !== "true") {
    throw new Error(errors.requiresAuthorization);
  }

  let databaseUrl: URL;
  try {
    databaseUrl = new URL(connectionString);
  } catch {
    throw new Error(errors.targetNotAllowed);
  }
  const databaseName = decodeURIComponent(databaseUrl.pathname.replace(/^\//, ""));
  const databaseNamePattern = authorization === "ALLOW_SYNTHETIC_SEED"
    ? /^cvg_(?:diagnostics|seed|synthetic|test)(?:[a-z0-9_-]*)$/i
    : authorization === "ALLOW_DB_SMOKE_RESET"
      ? /^cvg_(?:smoke|test)(?:[a-z0-9_-]*)$/i
      : /^cvg_test_[1-9][0-9]*_[a-f0-9]{32}$/;
  if (
    !["postgres:", "postgresql:"].includes(databaseUrl.protocol)
    || !LOOPBACK_DATABASE_HOSTS.has(databaseUrl.hostname.toLowerCase())
    || !databaseNamePattern.test(databaseName)
  ) {
    throw new Error(errors.targetNotAllowed);
  }
  return {
    authorization,
    databaseHost: databaseUrl.hostname.toLowerCase(),
    databaseName
  };
}

function assertAdministrativeResetAuthorized(
  connectionString: string,
  options: PostgresAdministrativeResetOptions | undefined
): AuthorizedAdministrativeResetTarget {
  return assertDatabaseOperationAuthorized(
    connectionString,
    options?.authorization,
    ADMINISTRATIVE_RESET_AUTHORIZATIONS,
    {
      forbiddenInProduction: "POSTGRES_ADMIN_RESET_FORBIDDEN_IN_PRODUCTION",
      requiresAuthorization: "POSTGRES_ADMIN_RESET_REQUIRES_AUTHORIZATION",
      targetNotAllowed: "POSTGRES_ADMIN_RESET_TARGET_NOT_ALLOWED"
    }
  );
}

function assertInitializationAuthorized(
  connectionString: string,
  options: PostgresInitializationOptions | undefined
): void {
  assertDatabaseOperationAuthorized(
    connectionString,
    options?.authorization,
    INITIALIZATION_AUTHORIZATIONS,
    {
      forbiddenInProduction: "POSTGRES_INITIALIZATION_FORBIDDEN_IN_PRODUCTION",
      requiresAuthorization: "POSTGRES_INITIALIZATION_REQUIRES_AUTHORIZATION",
      targetNotAllowed: "POSTGRES_INITIALIZATION_TARGET_NOT_ALLOWED"
    }
  );
}

function administrativeResetAuditEvent(
  target: AuthorizedAdministrativeResetTarget
): StoreState["auditEvents"][number] {
  return {
    id: `audit-postgres-reset-${randomUUID()}`,
    eventType: "PostgresAdministrativeReset",
    entityType: "RuntimeState",
    entityId: "cvg-runtime-state",
    previousState: "ACTIVE",
    newState: "RESET",
    correlationId: `corr-postgres-reset-${randomUUID()}`,
    metadata: {
      authorization: target.authorization,
      databaseHost: target.databaseHost,
      databaseName: target.databaseName
    },
    occurredAt: new Date().toISOString()
  };
}

function stateForAdministrativeReset(
  before: StoreState,
  target: StoreState,
  resetAuditEvent: StoreState["auditEvents"][number]
): StoreState {
  const targetAuditEventsById = new Map(target.auditEvents.map((event) => [event.id, event]));
  if (targetAuditEventsById.size !== target.auditEvents.length) {
    throw new Error("POSTGRES_AUDIT_LOG_MUTATION");
  }
  const previousAuditEventsById = new Map(before.auditEvents.map((event) => [event.id, event]));
  for (const previousEvent of before.auditEvents) {
    const targetEvent = targetAuditEventsById.get(previousEvent.id);
    if (targetEvent && JSON.stringify(targetEvent) !== JSON.stringify(previousEvent)) {
      throw new Error("POSTGRES_AUDIT_LOG_MUTATION");
    }
  }
  return {
    ...target,
    auditEvents: [
      ...before.auditEvents,
      ...target.auditEvents.filter((event) => !previousAuditEventsById.has(event.id)),
      resetAuditEvent
    ]
  };
}

export class PostgresStore implements StateStore {
  private readonly pool: Pool;
  private readonly connectionString: string;
  private readonly relationalClinicalCore?: RelationalClinicalCoreRuntime;
  private readonly relationalReadiness: PostgresRelationalClinicalCoreReadiness;
  private state: StoreState;
  private queue: Promise<unknown> = Promise.resolve();
  private isClosing = false;
  private closePromise?: Promise<void>;

  private constructor(pool: Pool, connectionString: string, state: StoreState, relationalClinicalCore?: RelationalClinicalCoreRuntime, relationalReadiness: PostgresRelationalClinicalCoreReadiness = "STRICT") {
    this.pool = pool;
    this.connectionString = connectionString;
    this.relationalClinicalCore = relationalClinicalCore;
    this.relationalReadiness = relationalReadiness;
    this.state = cloneState(state);
  }

  static create(connectionString: string): Promise<PostgresStore>;
  static create(
    connectionString: string,
    fallbackState: StoreState,
    initialization: PostgresInitializationOptions
  ): Promise<PostgresStore>;
  static async create(
    connectionString: string,
    fallbackState?: StoreState,
    initialization?: PostgresInitializationOptions
  ): Promise<PostgresStore> {
    return PostgresStore.open(connectionString, fallbackState, initialization);
  }

  /**
   * Opens the same store with an explicit, transaction-participating
   * relational shadow adapter. This does not change read authority: readState
   * remains the JSONB-compatible StateStore contract, while
   * readRelationalClinicalRequest exposes the normalized read seam for staged
   * cutover work. Parent/reference rows must already be backfilled; this path
   * never invents or seeds them.
   */
  static async createWithRelationalClinicalCore(
    connectionString: string,
    options: PostgresRelationalClinicalCoreOptions = {}
  ): Promise<PostgresStore> {
    return PostgresStore.open(connectionString, options.fallbackState, options.initialization, options.adapter ?? new RelationalClinicalCoreAdapter(), options.relationalReadiness ?? "STRICT");
  }

  private static async open(connectionString: string, fallbackState?: StoreState, initialization?: PostgresInitializationOptions, relationalClinicalCore?: RelationalClinicalCoreRuntime, relationalReadiness: PostgresRelationalClinicalCoreReadiness = "STRICT"): Promise<PostgresStore> {
    const pool = new Pool({ connectionString, max: Number(process.env.DB_POOL_MAX ?? 10), idleTimeoutMillis: 30_000 });
    if (typeof pool.on === "function") {
      pool.on("error", () => {
        // Idle-client failures are surfaced by the next readiness/transaction call;
        // keep them from becoming process-level unhandled errors during failover.
      });
    }
    try {
      const result = await pool.query<{ state: unknown; version: unknown }>(CURRENT_STATE_SQL);
      let initialState: StoreState;
      if (result.rowCount === 0) {
        if (!fallbackState) throw new Error("PostgreSQL runtime state row is missing. Execute the explicit synthetic seed when appropriate.");
        assertInitializationAuthorized(connectionString, initialization);
        const validatedFallbackState = stateFromRow(fallbackState);
        await pool.query(
          "INSERT INTO cvg_runtime_state (id, state) VALUES (1, $1::jsonb) ON CONFLICT (id) DO NOTHING",
          [JSON.stringify(validatedFallbackState)]
        );
        const seeded = await pool.query<{ state: unknown; version: unknown }>(CURRENT_STATE_SQL);
        if (seeded.rowCount !== 1) throw new Error("PostgreSQL runtime state row is missing after seed initialization.");
        initialState = runtimeStateFromRow(seeded.rows[0]);
      } else {
        if (result.rowCount !== 1) throw new Error("PostgreSQL runtime state cardinality is invalid.");
        initialState = runtimeStateFromRow(result.rows[0]);
      }
      await assertRuntimeSchemaReady({ query: (text, values) => pool.query(text, values) });
      if (relationalClinicalCore) {
        await relationalClinicalCore.assertReady({ query: (text, values) => pool.query(text, values) }, { allowUnvalidatedSampleMembership: relationalReadiness === "BACKFILL" });
      }
      return new PostgresStore(pool, connectionString, initialState, relationalClinicalCore, relationalReadiness);
    } catch (error) {
      await pool.end();
      throw new Error(`Não foi possível abrir o estado PostgreSQL. Execute npm run db:migrate antes de iniciar. ${(error as Error).message}`);
    }
  }

  getState(): StoreState {
    return cloneState(this.state);
  }

  async readState(): Promise<StoreState> {
    return this.enqueue(async () => {
      const result = await this.pool.query<{ state: unknown; version: unknown }>(CURRENT_STATE_SQL);
      if (result.rowCount !== 1) throw new Error("PostgreSQL runtime state row is missing.");
      const currentState = runtimeStateFromRow(result.rows[0]);
      this.state = cloneState(currentState);
      return cloneState(currentState);
    });
  }

  /**
   * One statement returns the aggregate and the version it was read at, so the
   * realtime authorization recheck can compare a version that provably belongs
   * to the same snapshot instead of issuing a second read.
   */
  async readStateSnapshot(): Promise<{ state: StoreState; version: number }> {
    return this.enqueue(async () => {
      const result = await this.pool.query<{ state: unknown; version: unknown }>(CURRENT_STATE_SQL);
      if (result.rowCount !== 1) throw new Error("PostgreSQL runtime state row is missing.");
      const currentState = runtimeStateFromRow(result.rows[0]);
      this.state = cloneState(currentState);
      return { state: cloneState(currentState), version: versionFromRow(result.rows[0].version) };
    });
  }

  /** Deliberately outside enqueue(): the version column expands no JSONB. */
  async readStateVersion(): Promise<number> {
    if (this.isClosing) throw new Error("PostgreSQL store is closing or closed.");
    const result = await this.pool.query<{ version: unknown }>(CURRENT_VERSION_SQL);
    if (result.rowCount !== 1) throw new Error("PostgreSQL runtime state row is missing.");
    return versionFromRow(result.rows[0].version);
  }

  async readAuthorizationSnapshot(query: { userId: string; sessionId?: string }): Promise<{ user?: StoreState["users"][number]; session?: StoreState["sessions"][number] }> {
    return this.enqueue(() => readPostgresAuthorizationSnapshot(this.pool, query));
  }

  /**
   * Deliberately outside enqueue(): liveness is one indexed row read and must
   * not queue behind the serial write path that the snapshot aggregate forces.
   */
  async readSessionActivity(sessionId: string): Promise<SessionActivity | undefined> {
    if (this.isClosing) throw new Error("PostgreSQL store is closing or closed.");
    return readPostgresSessionActivity(this.pool, sessionId);
  }

  async touchSessionActivity(activity: { sessionId: string; userId: string; lastSeenAt: string }): Promise<SessionActivity> {
    if (this.isClosing) throw new Error("PostgreSQL store is closing or closed.");
    return touchPostgresSessionActivity(this.pool, activity, activity.lastSeenAt);
  }

  /**
   * Runtime retention. The snapshot compaction is serialised with clinical
   * writes because it rewrites the aggregate, but it runs on a schedule rather
   * than per request: session-activity rows and processed outbox rows are
   * pruned in the same transaction so the JSONB projection stays exactly
   * reconciled with the relational tables readiness asserts.
   */
  async compactRuntimeState(options: RuntimeRetentionOptions = {}): Promise<RuntimeRetentionSummary> {
    if (this.relationalClinicalCore) throw new Error("POSTGRES_RELATIONAL_RETENTION_UNSUPPORTED");
    const now = options.now ?? new Date();
    return this.runExclusiveTransaction(async (client, current) => {
      const compaction = compactRuntimeState(current, { ...options, now });
      const sessionActivityRowsRemoved = await prunePostgresSessionActivity(client, compaction.retainedSessionIds);
      await deletePostgresProcessedOutbox(client, compaction.removedOutboxMessageIds);
      const summary: RuntimeRetentionSummary = { ...compaction.summary, sessionActivityRowsRemoved };
      return {
        state: { ...compaction.state, auditEvents: [...compaction.state.auditEvents, runtimeRetentionAuditEvent(summary, now)] },
        result: summary
      };
    });
  }

  async readRelationalClinicalRequest(requestId: string): Promise<RelationalClinicalRequestRead | undefined> {
    if (!this.relationalClinicalCore) {
      throw new Error("POSTGRES_RELATIONAL_RUNTIME_NOT_ENABLED");
    }
    return this.enqueue(() => this.relationalClinicalCore!.readRequest({ query: (text, values) => this.pool.query(text, values) }, requestId));
  }

  /**
   * Performs a repeatable dual-read probe over one database snapshot. The
   * JSONB state remains the source of truth; this method only returns a
   * sanitised hash/mismatch report for cutover evidence and never changes
   * authority or writes either representation.
   */
  async reconcileRelationalClinicalRequest(requestId: string): Promise<RelationalRequestReconciliation> {
    if (!this.relationalClinicalCore) {
      throw new Error("POSTGRES_RELATIONAL_RUNTIME_NOT_ENABLED");
    }
    return this.enqueue(async () => {
      const client = await this.pool.connect();
      try {
        await client.query("BEGIN");
        await client.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ");
        const snapshot = await client.query<{ state: unknown; version: unknown }>(CURRENT_STATE_SQL);
        if (snapshot.rowCount !== 1) throw new Error("PostgreSQL runtime state row is missing.");
        const currentState = runtimeStateFromRow(snapshot.rows[0]);
        const relational = await this.relationalClinicalCore!.readRequest(relationalClient(client), requestId);
        const report = reconcileRelationalRequest(currentState, requestId, relational);
        await client.query("COMMIT");
        return report;
      } catch (error) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
    });
  }

  /**
   * Backfills the ten currently mappable clinical-core tables from one stable
   * JSONB snapshot into the relational shadow. Each batch commits its clinical
   * aggregates and checkpoint together; a source version/hash change stops the
   * run before it can mix two snapshot representations. This method never
   * writes cvg_runtime_state and never changes the runtime authority.
   */
  async backfillRelationalClinicalCore(
    options: RelationalClinicalCoreBackfillOptions = {}
  ): Promise<RelationalClinicalCoreBackfillReport> {
    if (!this.relationalClinicalCore) {
      throw new Error("POSTGRES_RELATIONAL_RUNTIME_NOT_ENABLED");
    }
    const normalized = normalizeRelationalClinicalCoreBackfillOptions(options);
    const runId = normalized.runId ?? randomUUID();
    return this.enqueue(async () => {
      const lockClient = await this.pool.connect();
      const client = relationalClient(lockClient);
      let runInitialized = false;
      let transactionOpen = false;
      try {
        await lockClient.query("SELECT pg_advisory_lock(hashtext($1))", [`cvg_relational_backfill:${runId}`]);
        await this.relationalClinicalCore!.assertReady(client, {
          allowUnvalidatedSampleMembership: this.relationalReadiness === "BACKFILL"
        });

        const initial = await lockClient.query<{ state: unknown; version: unknown }>(CURRENT_STATE_SQL);
        if (initial.rowCount !== 1) throw new Error("PostgreSQL runtime state row is missing.");
        const sourceSnapshotVersion = versionFromRow(initial.rows[0]?.version);
        const sourceState = runtimeStateFromRow(initial.rows[0]);
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
            const current = await lockClient.query<{ state: unknown; version: unknown }>(LOCKED_STATE_SQL);
            assertBackfillSourceStable(current.rows[0], sourceSnapshotVersion, sourceSnapshotHash);
            for (const requestId of requestIds) {
              await this.relationalClinicalCore!.repairSampleMembership(
                client,
                stateForRelationalClinicalRequest(sourceState, requestId)
              );
            }
            await verifyRelationalClinicalCoreTarget(this.relationalClinicalCore!, client, sourceState, requestIds);
            await this.relationalClinicalCore!.validateSampleMembership(client);
            await this.relationalClinicalCore!.assertReady(client);
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
            const current = await lockClient.query<{ state: unknown; version: unknown }>(LOCKED_STATE_SQL);
            assertBackfillSourceStable(current.rows[0], sourceSnapshotVersion, sourceSnapshotHash);
            await lockClient.query("SET CONSTRAINTS ALL DEFERRED");
            let batchRowsProjected = 0;
            for (const requestId of batchIds) {
              assertBackfillNotAborted(normalized.signal);
              const scopedState = stateForRelationalClinicalRequest(sourceState, requestId);
              await this.relationalClinicalCore!.repairSampleMembership(client, scopedState);
              await this.relationalClinicalCore!.projectStateDelta(
                client,
                emptyRelationalClinicalCoreState(scopedState),
                scopedState
              );
              const relational = await this.relationalClinicalCore!.readRequest(client, requestId);
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
          const current = await lockClient.query<{ state: unknown; version: unknown }>(LOCKED_STATE_SQL);
          assertBackfillSourceStable(current.rows[0], sourceSnapshotVersion, sourceSnapshotHash);
          await verifyRelationalClinicalCoreTarget(this.relationalClinicalCore!, client, sourceState, requestIds);
          await this.relationalClinicalCore!.validateSampleMembership(client);
          await this.relationalClinicalCore!.assertReady(client);
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
    });
  }

  async transaction<T>(operation: (state: StoreState) => Promise<{ state: StoreState; result: T }> | { state: StoreState; result: T }): Promise<T> {
    return this.runTransaction(operation);
  }

  async reset(state: StoreState, options?: PostgresAdministrativeResetOptions): Promise<void> {
    const authorizedTarget = assertAdministrativeResetAuthorized(this.connectionString, options);
    if (this.relationalClinicalCore) throw new Error("POSTGRES_RELATIONAL_RESET_UNSUPPORTED");
    const target = stateFromRow(state);
    await this.runTransaction((current) => ({
      state: stateForAdministrativeReset(current, target, administrativeResetAuditEvent(authorizedTarget)),
      result: undefined
    }), { replaceOutboxProjection: true });
  }

  async close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.isClosing = true;
    const pendingWork = this.queue;
    this.closePromise = (async () => {
      await pendingWork;
      await this.pool.end();
    })();
    return this.closePromise;
  }

  async healthcheck(): Promise<void> {
    await this.enqueue(async () => {
      await assertRuntimeSchemaReady({ query: (text, values) => this.pool.query(text, values) });
      if (this.relationalClinicalCore) {
        await this.relationalClinicalCore.assertReady({
          query: (text, values) => this.pool.query(text, values)
        });
      }
    });
  }

  private async runTransaction<T>(
    operation: (state: StoreState) => Promise<{ state: StoreState; result: T }> | { state: StoreState; result: T },
    options: { replaceOutboxProjection?: boolean } = {}
  ): Promise<T> {
    return this.runExclusiveTransaction((_client, current) => operation(current), options);
  }

  private async runExclusiveTransaction<T>(
    operation: (client: PoolClient, current: StoreState) => Promise<{ state: StoreState; result: T }> | { state: StoreState; result: T },
    options: { replaceOutboxProjection?: boolean } = {}
  ): Promise<T> {
    return this.enqueue(async () => {
      const client = await this.pool.connect();
      try {
        await client.query("BEGIN");
        const locked = await client.query<{ state: unknown; version: unknown }>(LOCKED_STATE_SQL);
        if (locked.rowCount !== 1) throw new Error("PostgreSQL runtime state row is missing.");
        const currentState = runtimeStateFromRow(locked.rows[0]);
        const previousSessionIds = new Set(currentState.sessions.map((session) => session.id));
        const outcome = await operation(client, currentState);
        const nextState = stateFromRow(outcome.state);
        assertAuditEventsAppendOnly(currentState, nextState);
        if (this.relationalClinicalCore) {
          await client.query("SET CONSTRAINTS ALL DEFERRED");
          await this.relationalClinicalCore.projectStateDelta(
            relationalClient(client),
            currentState,
            nextState
          );
        }
        const updated = await client.query<{ version: unknown }>(
          "UPDATE cvg_runtime_state SET state = $1::jsonb, version = version + 1, updated_at = now() WHERE id = 1 RETURNING version",
          [JSON.stringify(nextState)]
        );
        if (updated.rowCount !== 1) throw new Error("PostgreSQL runtime state update failed.");
        versionFromRow(updated.rows[0]?.version);
        const projectionBefore = options.replaceOutboxProjection
          ? { ...currentState, outbox: [] }
          : currentState;
        if (options.replaceOutboxProjection) {
          await client.query("DELETE FROM outbox_messages");
        }
        await this.projectCommittedEvents(client, projectionBefore, nextState);
        // Session creation and its initial idle window must commit together.
        for (const session of nextState.sessions) {
          if (!previousSessionIds.has(session.id)) {
            await touchPostgresSessionActivity(client, { sessionId: session.id, userId: session.userId }, session.createdAt);
          }
        }
        await client.query("COMMIT");
        this.state = cloneState(nextState);
        return outcome.result;
      } catch (error) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
    });
  }

  private enqueue<T>(operation: () => Promise<T> | T): Promise<T> {
    if (this.isClosing) return Promise.reject(new Error("PostgreSQL store is closing or closed."));
    const run = this.queue.then(operation);
    this.queue = run.then(() => undefined, () => undefined);
    return run;
  }

  private async projectCommittedEvents(client: PoolClient, before: StoreState, after: StoreState): Promise<void> {
    // The default runtime still uses the JSONB aggregate as its clinical
    // authority.  The durable in-app outbox sink nevertheless has a foreign
    // key to the relational notification table.  Keep that narrow delivery
    // seam synchronized without pretending that the full clinical cutover is
    // complete; the opt-in relational adapter owns its broader projection.
    if (!this.relationalClinicalCore) await projectDurableNotificationRows(client, before, after);
    const previousAuditIds = new Set(before.auditEvents.map((event) => event.id));
    for (const event of after.auditEvents.filter((entry) => !previousAuditIds.has(entry.id))) {
      const inserted = await client.query(
        "INSERT INTO audit_events (id, event_type, actor_id, entity_type, entity_id, previous_state, new_state, correlation_id, metadata, occurred_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10) ON CONFLICT (id) DO NOTHING RETURNING id",
        [event.id, event.eventType, event.actorId ?? null, event.entityType, event.entityId, event.previousState ?? null, event.newState ?? null, event.correlationId, JSON.stringify(event.metadata), event.occurredAt]
      );
      if (inserted.rowCount !== 1) throw new Error(`POSTGRES_AUDIT_PROJECTION_DIVERGED:${event.id}`);
    }
    const previousOutbox = new Map(before.outbox.map((event) => [event.id, event]));
    for (const message of after.outbox.filter((entry) => !previousOutbox.has(entry.id))) {
      const envelope = outboxEnvelopeFor(message.eventType, message.payload, message.consumerType, message.routingKey);
      const inserted = await client.query(
        "INSERT INTO outbox_messages (id, event_type, aggregate_type, aggregate_id, payload, consumer_type, routing_key, status, attempts, available_at, correlation_id, locked_at, worker_id, claim_token, last_error, dead_lettered_at, discarded_at, discarded_by, discard_reason) VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19) ON CONFLICT (id) DO NOTHING RETURNING id",
        [message.id, message.eventType, message.aggregateType, message.aggregateId, JSON.stringify(message.payload), envelope.consumerType, envelope.routingKey, message.status, message.attempts, message.availableAt, message.correlationId, message.lockedAt ?? null, message.workerId ?? null, message.claimToken ?? null, message.lastError ?? null, message.deadLetteredAt ?? null, message.discardedAt ?? null, message.discardedBy ?? null, message.discardReason ?? null]
      );
      if (inserted.rowCount !== 1) throw new Error(`POSTGRES_OUTBOX_PROJECTION_DIVERGED:${message.id}`);
    }
    for (const message of after.outbox) {
      const previous = previousOutbox.get(message.id);
      if (!previous || JSON.stringify(previous) === JSON.stringify(message)) continue;
      const envelope = outboxEnvelopeFor(message.eventType, message.payload, message.consumerType, message.routingKey);
      const updated = await client.query(
        "UPDATE outbox_messages SET consumer_type = $2, routing_key = $3, status = $4, attempts = $5, available_at = $6, locked_at = $7, worker_id = $8, claim_token = $9, last_error = $10, dead_lettered_at = $11, discarded_at = $12, discarded_by = $13, discard_reason = $14 WHERE id = $1",
        [message.id, envelope.consumerType, envelope.routingKey, message.status, message.attempts, message.availableAt, message.lockedAt ?? null, message.workerId ?? null, message.claimToken ?? null, message.lastError ?? null, message.deadLetteredAt ?? null, message.discardedAt ?? null, message.discardedBy ?? null, message.discardReason ?? null]
      );
      if (updated.rowCount !== 1) throw new Error(`POSTGRES_OUTBOX_PROJECTION_DIVERGED:${message.id}`);
    }
  }
}
