import { randomUUID } from "node:crypto";
import { PostgresStateCache } from "./postgres-state-cache";
import { freezeState } from "./immutable-state";
import { Pool, type PoolClient } from "pg";
import { outboxEnvelopeFor, type ClinicalArchiveEntry, type ClinicalArchiveOptions, type ClinicalArchivePurgeOptions, type ClinicalArchivePurgeSummary, type ClinicalArchiveQuery, type ClinicalArchiveRow, type ClinicalArchiveSummary, type AuditEntity, type AuditEvent, type AuditMetrics, type AuditMetricsQuery, type AuditReadPage, type AuditReadQuery, type AuditTransactionReader, type RuntimeRetentionOptions, type RuntimeRetentionSummary, type Session, type SessionActivity, type StateStore, type StoreState, type User, type WriteQueueMetrics } from "../domain/models";
import { auditEventsForReset, insertPostgresAuditEvent, postgresAuditTransactionReader, readPostgresAuditActors, readPostgresAuditEvents, readPostgresAuditMetrics } from "./postgres-audit-read";
import type { OutboxMessage, OutboxTransactionQuery } from "../domain/models";
import { outboxReadLimit } from "../domain/outbox-read";
import { hasClaimablePostgresOutbox, lockPostgresOutbox, outboxFromRow, prunePostgresOutbox, readPostgresOutbox, readPostgresOutboxMetrics, REALTIME_OUTBOX_SQL, RUNTIME_SEED_WITH_EVENTS_SQL, projectPostgresOutbox } from "./postgres-outbox-read";
import { assertRuntimeSchemaReady } from "./migrations";
import {
  assertAuditEventsAppendOnly,
  CURRENT_VERSION_SQL,
  LOCKED_VERSION_SQL,
  stateFromRow,
  versionFromRow
} from "./postgres-state-codec";
import { loadEntityState, stateHeader, writeEntityState, type EntityQueryable } from "./postgres-entity-state";
import { relationalClient } from "./postgres-backfill-support";
import { executePostgresClinicalCoreBackfill } from "./postgres-backfill-executor";
import {
  administrativeResetAuditEvent,
  assertAdministrativeResetAuthorized,
  assertInitializationAuthorized,
  stateForAdministrativeReset,
  type DatabaseOperationAuthorization
} from "./postgres-administration";
import { projectDurableNotificationRows } from "./postgres-notification-projection";
import { readPostgresAuthorizationSnapshot } from "./postgres-authorization-read";
import { prunePostgresSessionActivity, readPostgresSessionActivity, touchPostgresSessionActivity } from "./postgres-session-activity";
import { archiveAuditEvent, archiveEntries, assertBoundedArchiveQuery, archiveSummary, newArchiveBatchId, planClinicalArchive, purgeAuditEvent, purgeCutoff } from "../domain/clinical-archive";
import { insertClinicalArchive, purgeClinicalArchiveRows, readArchivedRequestRows, readClinicalArchiveRows } from "./postgres-clinical-archive";
import { compactRuntimeState, retentionRemovedAnything, runtimeRetentionAuditEvent } from "./runtime-retention";
import {
  RelationalClinicalCoreAdapter,
  type RelationalClinicalCoreRuntime,
  type RelationalClinicalRequestRead
} from "./relational/clinical-core-adapter";
import {
  normalizeRelationalClinicalCoreBackfillOptions,
  type RelationalClinicalCoreBackfillOptions,
  type RelationalClinicalCoreBackfillReport
} from "./relational/clinical-core-backfill";
import {
  reconcileRelationalRequest,
  type RelationalRequestReconciliation
} from "./relational/cutover";
import { runtimePoolTimeouts } from "../domain/database-timeouts";

export type {
  RelationalClinicalCoreBackfillOptions,
  RelationalClinicalCoreBackfillReport
} from "./relational/clinical-core-backfill";

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

/** pg-pool never reaches a NaN ceiling, so a malformed DB_POOL_MAX must fall back instead of becoming unbounded. */
export function databasePoolMax(value: string | undefined): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : 10;
}

export class PostgresStore implements StateStore {
  private readonly pool: Pool;
  private readonly connectionString: string;
  private readonly relationalClinicalCore?: RelationalClinicalCoreRuntime;
  private readonly relationalReadiness: PostgresRelationalClinicalCoreReadiness;
  private readonly cache: PostgresStateCache;
  private readonly concurrentWork = new Set<Promise<unknown>>();
  private queue: Promise<unknown> = Promise.resolve();
  private readonly writeQueue = { inFlight: 0, completed: 0, waitMsTotal: 0, holdMsTotal: 0 };
  private isClosing = false;
  private closePromise?: Promise<void>;

  private constructor(pool: Pool, connectionString: string, state: StoreState, version: number, relationalClinicalCore?: RelationalClinicalCoreRuntime, relationalReadiness: PostgresRelationalClinicalCoreReadiness = "STRICT") {
    this.pool = pool;
    this.connectionString = connectionString;
    this.relationalClinicalCore = relationalClinicalCore;
    this.relationalReadiness = relationalReadiness;
    this.cache = new PostgresStateCache(pool, { state, version }, connectionString);
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
    const pool = new Pool({ connectionString, max: databasePoolMax(process.env.DB_POOL_MAX), idleTimeoutMillis: 30_000, ...runtimePoolTimeouts() });
    if (typeof pool.on === "function") {
      pool.on("error", () => {
        // Idle-client failures are surfaced by the next readiness/transaction call;
        // keep them from becoming process-level unhandled errors during failover.
      });
    }
    try {
      const result = await pool.query<{ version: unknown }>(CURRENT_VERSION_SQL);
      if (result.rowCount === 0) {
        if (!fallbackState) throw new Error("PostgreSQL runtime state row is missing. Execute the explicit synthetic seed when appropriate.");
        assertInitializationAuthorized(connectionString, initialization?.authorization);
        const validatedFallbackState = stateFromRow(fallbackState);
        await pool.query(RUNTIME_SEED_WITH_EVENTS_SQL,
        [JSON.stringify({ ...validatedFallbackState, outbox: validatedFallbackState.outbox.map((message) => ({ ...message, ...outboxEnvelopeFor(message.eventType, message.payload, message.consumerType, message.routingKey) })) })]);
        const seeded = await pool.query<{ version: unknown }>(CURRENT_VERSION_SQL);
        if (seeded.rowCount !== 1) throw new Error("PostgreSQL runtime state row is missing after seed initialization.");
      } else if (result.rowCount !== 1) {
        throw new Error("PostgreSQL runtime state cardinality is invalid.");
      }
      await assertRuntimeSchemaReady({ query: (text, values) => pool.query(text, values) });
      if (relationalClinicalCore) {
        await relationalClinicalCore.assertReady({ query: (text, values) => pool.query(text, values) }, { allowUnvalidatedSampleMembership: relationalReadiness === "BACKFILL" });
      }
      const initial = await PostgresStore.readConsistently(pool, (client) => loadEntityState(client));
      return new PostgresStore(pool, connectionString, initial.state, initial.version, relationalClinicalCore, relationalReadiness);
    } catch (error) {
      await pool.end();
      throw new Error(`Não foi possível abrir o estado PostgreSQL. Execute npm run db:migrate antes de iniciar. ${(error as Error).message}`);
    }
  }

  getState(): StoreState {
    return this.cache.getState();
  }

  async readOutbox(query: { kind: "replay" | "dead-letter"; limit: number }) {
    return this.concurrent(() => readPostgresOutbox(this.pool, query));
  }

  async readOutboxMetrics() {
    return this.concurrent(() => readPostgresOutboxMetrics(this.pool));
  }

  async readRealtimeSnapshot(limit: number): Promise<{ state: StoreState; version: number }> {
    return this.concurrent(() => PostgresStore.readConsistently(this.pool, async (client) => {
      const snapshot = await this.cache.refreshWith(client);
      const result = await client.query<{ outbox: OutboxMessage[] }>(REALTIME_OUTBOX_SQL, [outboxReadLimit(limit)]);
      return { state: { ...snapshot.state, outbox: result.rows[0].outbox.map(outboxFromRow) }, version: snapshot.version };
    }));
  }

  async outboxTransaction<T>(query: OutboxTransactionQuery, operation: (state: StoreState) => Promise<{ state: StoreState; result: T }> | { state: StoreState; result: T }): Promise<T> {
    // An idle worker cycle must not queue behind, nor hold, the runtime row lock of the clinical writes.
    if (query.kind === "claim" && !(await this.concurrent(() => hasClaimablePostgresOutbox(this.pool, query)))) {
      return (await operation(freezeState({ ...this.cache.current().state, outbox: [] }))).result;
    }
    return this.runExclusiveTransaction((_client, state) => operation(state), { outboxScope: query });
  }

  async readAuditEvents(query: AuditReadQuery): Promise<AuditReadPage> {
    return this.concurrent(() => readPostgresAuditEvents(this.pool, query));
  }

  async readAuditActors(entities: AuditEntity[], actorIds?: readonly string[]): Promise<{ entityId: string; actorId: string }[]> {
    return this.concurrent(() => readPostgresAuditActors(this.pool, entities, actorIds));
  }

  /** Audit is outside the snapshot (PROD-101): an audited read inserts its row alone, beside the write queue (D-061). */
  async appendReadAudit(event: AuditEvent): Promise<void> {
    return this.concurrent(() => insertPostgresAuditEvent(this.pool, event));
  }

  async readAuditMetrics(query: AuditMetricsQuery): Promise<AuditMetrics> {
    return this.concurrent(() => readPostgresAuditMetrics(this.pool, query));
  }

  async readState(): Promise<StoreState> {
    return this.concurrent(async () => (await this.cache.read()).state);
  }

  /** The cache entry is validated against a fresh durable version before use. */
  async readStateSnapshot(): Promise<{ state: StoreState; version: number }> {
    return this.concurrent(() => this.cache.read());
  }

  /** The version column expands no JSONB and never waits for the write queue. */
  async readStateVersion(): Promise<number> {
    return this.concurrent(async () => {
      const result = await this.pool.query<{ version: unknown }>(CURRENT_VERSION_SQL);
      if (result.rowCount !== 1) throw new Error("PostgreSQL runtime state row is missing.");
      return versionFromRow(result.rows[0].version);
    });
  }

  async readAuthorizationSnapshot(query: { userId: string; sessionId?: string }): Promise<{ user?: StoreState["users"][number]; session?: StoreState["sessions"][number] }> {
    return this.concurrent(() => readPostgresAuthorizationSnapshot(this.pool, query));
  }

  /**
   * Deliberately outside enqueue(): liveness is one indexed row read and must
   * not queue behind the serial write path that the snapshot aggregate forces.
   */
  async readSessionActivity(sessionId: string): Promise<SessionActivity | undefined> {
    return this.concurrent(() => readPostgresSessionActivity(this.pool, sessionId));
  }

  async touchSessionActivity(activity: { sessionId: string; userId: string; lastSeenAt: string }): Promise<SessionActivity> {
    return this.concurrent(() => touchPostgresSessionActivity(this.pool, activity, activity.lastSeenAt));
  }

  /**
   * Runtime retention. The snapshot compaction is serialised with clinical
   * writes because it rewrites the aggregate, but it runs on a schedule rather
   * than per request: session-activity rows and processed outbox rows are
   * pruned in the same transaction as their audit record. Outbox delivery
   * history remains authoritative in the table, with a bounded replay window.
   */
  async compactRuntimeState(options: RuntimeRetentionOptions = {}): Promise<RuntimeRetentionSummary> {
    if (this.relationalClinicalCore) throw new Error("POSTGRES_RELATIONAL_RETENTION_UNSUPPORTED");
    const now = options.now ?? new Date();
    return this.runExclusiveTransaction(async (client, current) => {
      await pruneEntityRemovals(client, now);
      const compaction = compactRuntimeState(current, { ...options, now });
      const sessionActivityRowsRemoved = await prunePostgresSessionActivity(client, compaction.retainedSessionIds);
      const outboxMessagesRemoved = await prunePostgresOutbox(client, options, now);
      const summary: RuntimeRetentionSummary = { ...compaction.summary, sessionActivityRowsRemoved, outboxMessagesRemoved };
      return {
        state: retentionRemovedAnything(summary)
          ? { ...compaction.state, auditEvents: [...compaction.state.auditEvents, runtimeRetentionAuditEvent(summary, now)] }
          : compaction.state,
        result: summary
      };
    });
  }

  /**
   * D5. The moved entities are inserted into cvg_clinical_archive and leave the
   * aggregate in the same transaction: the normal entity diff records their
   * removals, so every other process drops them incrementally. Dry runs only
   * read the cached aggregate.
   */
  async archiveClinicalRecords(options: ClinicalArchiveOptions = {}): Promise<ClinicalArchiveSummary> {
    if (this.relationalClinicalCore) throw new Error("POSTGRES_RELATIONAL_ARCHIVE_UNSUPPORTED");
    const now = options.now ?? new Date();
    const preview = planClinicalArchive(await this.readState(), { ...options, now });
    if (options.dryRun || preview.partition.requestIds.length === 0) return archiveSummary(preview);
    return this.runExclusiveTransaction(async (client, current) => {
      const plan = planClinicalArchive(current, { ...options, now });
      if (plan.partition.requestIds.length === 0) return { state: current, result: archiveSummary(plan) };
      const batchId = newArchiveBatchId(now);
      await insertClinicalArchive(client, plan, { id: batchId, archivedAt: now, actor: options.actor });
      const summary = { ...archiveSummary(plan, batchId), batchId };
      return {
        state: { ...plan.partition.state, auditEvents: [...plan.partition.state.auditEvents, archiveAuditEvent(summary, now, options.actor)] },
        result: summary
      };
    });
  }

  async readClinicalArchive(query: ClinicalArchiveQuery): Promise<ClinicalArchiveEntry[]> {
    assertBoundedArchiveQuery(query);
    return this.concurrent(async () => {
      const [rows, snapshot] = await Promise.all([readClinicalArchiveRows(this.pool, query), this.cache.read()]);
      return archiveEntries(rows, snapshot.state.services);
    });
  }

  async readArchivedRequest(requestId: string): Promise<ClinicalArchiveRow[] | undefined> {
    return this.concurrent(() => readArchivedRequestRows(this.pool, requestId));
  }

  /** Deletes archive rows past the legal period; the caller removes the returned attachment objects. */
  async purgeClinicalArchive(options: ClinicalArchivePurgeOptions = {}): Promise<ClinicalArchivePurgeSummary> {
    if (this.relationalClinicalCore) throw new Error("POSTGRES_RELATIONAL_ARCHIVE_UNSUPPORTED");
    const now = options.now ?? new Date();
    const cutoff = purgeCutoff(now, options.purgeAfterMonths);
    if (!cutoff) return { requestsPurged: 0, entitiesPurged: 0, attachmentKeys: [] };
    if (options.dryRun) return this.concurrent(() => purgeClinicalArchiveRows(this.pool, cutoff, false));
    return this.runExclusiveTransaction(async (client, current) => {
      const summary = await purgeClinicalArchiveRows(client, cutoff, true);
      return {
        state: summary.entitiesPurged > 0 ? { ...current, auditEvents: [...current.auditEvents, purgeAuditEvent(summary, now)] } : current,
        result: summary
      };
    });
  }

  async readRelationalClinicalRequest(requestId: string): Promise<RelationalClinicalRequestRead | undefined> {
    if (!this.relationalClinicalCore) {
      throw new Error("POSTGRES_RELATIONAL_RUNTIME_NOT_ENABLED");
    }
    return this.concurrent(() => this.relationalClinicalCore!.readRequest({ query: (text, values) => this.pool.query(text, values) }, requestId));
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
    return this.concurrent(async () => {
      const client = await this.pool.connect();
      try {
        await client.query("BEGIN");
        await client.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ");
        const { state: currentState } = await this.cache.refreshWith(client, { exact: true });
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
    return this.enqueue(() => executePostgresClinicalCoreBackfill({
      pool: this.pool,
      adapter: this.relationalClinicalCore!,
      allowUnvalidatedSampleMembership: this.relationalReadiness === "BACKFILL",
      normalized,
      runId
    }));
  }

  async transaction<T>(operation: (state: StoreState, audit?: AuditTransactionReader) => Promise<{ state: StoreState; result: T }> | { state: StoreState; result: T }): Promise<T> {
    return this.runTransaction(operation);
  }

  async reset(state: StoreState, options?: PostgresAdministrativeResetOptions): Promise<void> {
    const authorizedTarget = assertAdministrativeResetAuthorized(this.connectionString, options?.authorization);
    if (this.relationalClinicalCore) throw new Error("POSTGRES_RELATIONAL_RESET_UNSUPPORTED");
    const target = stateFromRow(state);
    await this.runExclusiveTransaction(async (client, current) => ({
      state: stateForAdministrativeReset(current, { ...target, auditEvents: await auditEventsForReset(client, target.auditEvents) }, administrativeResetAuditEvent(authorizedTarget)),
      result: undefined
    }), { replaceOutboxProjection: true });
  }

  async close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.isClosing = true;
    const pendingWork = this.queue;
    this.closePromise = (async () => {
      await Promise.all([pendingWork, Promise.allSettled([...this.concurrentWork]), this.cache.close()]);
      await this.pool.end();
    })();
    return this.closePromise;
  }

  async healthcheck(): Promise<void> {
    await this.concurrent(async () => {
      await assertRuntimeSchemaReady({ query: (text, values) => this.pool.query(text, values) });
      if (this.relationalClinicalCore) {
        await this.relationalClinicalCore.assertReady({
          query: (text, values) => this.pool.query(text, values)
        });
      }
    });
  }

  private async runTransaction<T>(
    operation: (state: StoreState, audit?: AuditTransactionReader) => Promise<{ state: StoreState; result: T }> | { state: StoreState; result: T },
    options: { replaceOutboxProjection?: boolean; outboxScope?: OutboxTransactionQuery } = {}
  ): Promise<T> {
    return this.runExclusiveTransaction((client, current) => operation(current, postgresAuditTransactionReader(client)), options);
  }

  private async runExclusiveTransaction<T>(
    operation: (client: PoolClient, current: StoreState) => Promise<{ state: StoreState; result: T }> | { state: StoreState; result: T },
    options: { replaceOutboxProjection?: boolean; outboxScope?: OutboxTransactionQuery } = {}
  ): Promise<T> {
    return this.enqueue(async () => {
      const client = await this.pool.connect();
      try {
        await client.query("BEGIN");
        // Lock by version only; the aggregate comes from the shared cache when it is
        // current, so a write no longer re-reads and re-parses the whole JSONB row.
        const locked = await client.query<{ version: unknown }>(LOCKED_VERSION_SQL);
        if (locked.rowCount !== 1) throw new Error("PostgreSQL runtime state row is missing.");
        const lockedVersion = versionFromRow(locked.rows[0].version);
        const cached = this.cache.current();
        // Under the row lock nothing else can commit, so a stale cache catches up
        // by applying only the entities written since its version.
        const baseState = cached.version === lockedVersion
          ? cached.state
          : (await this.cache.refreshWith(client, { exact: true })).state;
        const currentState = freezeState(options.outboxScope
          ? { ...baseState, outbox: await lockPostgresOutbox(client, options.outboxScope) }
          : baseState);
        const previousSessionIds = new Set(currentState.sessions.map((session) => session.id));
        const outcome = await operation(client, currentState);
        // Nothing changed: no new version, no rewrite of the header or entity rows (D-059).
        if (outcome.state === currentState) {
          await client.query("COMMIT");
          return outcome.result;
        }
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
        const persistedState = { ...nextState, auditEvents: [], outbox: [] };
        const updated = await client.query<{ version: unknown }>(
          "UPDATE cvg_runtime_state SET state = $1::jsonb, version = version + 1, updated_at = now() WHERE id = 1 RETURNING version",
          [JSON.stringify(stateHeader(nextState))]
        );
        if (updated.rowCount !== 1) throw new Error("PostgreSQL runtime state update failed.");
        const committedVersion = versionFromRow(updated.rows[0]?.version);
        // Only the entities whose identity changed are written (structural sharing).
        await writeEntityState(client, currentState, persistedState, committedVersion);
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
        this.cache.observe(persistedState, committedVersion);
        return outcome.result;
      } catch (error) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
    });
  }

  /** One REPEATABLE READ snapshot for reads that combine several statements. */
  private static async readConsistently<T>(pool: Pool, read: (client: PoolClient & EntityQueryable) => Promise<T>): Promise<T> {
    const client = await pool.connect();
    try {
      await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
      const result = await read(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  private concurrent<T>(operation: () => Promise<T> | T): Promise<T> {
    if (this.isClosing) return Promise.reject(new Error("PostgreSQL store is closing or closed."));
    const work = Promise.resolve().then(operation);
    this.concurrentWork.add(work);
    void work.then(() => this.concurrentWork.delete(work), () => this.concurrentWork.delete(work));
    return work;
  }

  writeQueueMetrics(): WriteQueueMetrics {
    return { ...this.writeQueue };
  }

  private enqueue<T>(operation: () => Promise<T> | T): Promise<T> {
    if (this.isClosing) return Promise.reject(new Error("PostgreSQL store is closing or closed."));
    // Every write waits here for the single runtime row (D-061): the wait and the hold are what to watch.
    const queuedAt = performance.now();
    this.writeQueue.inFlight += 1;
    const run = this.queue.then(async () => {
      const startedAt = performance.now();
      try {
        return await operation();
      } finally {
        this.writeQueue.inFlight -= 1;
        this.writeQueue.completed += 1;
        this.writeQueue.waitMsTotal += startedAt - queuedAt;
        this.writeQueue.holdMsTotal += performance.now() - startedAt;
      }
    });
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
    for (const event of after.auditEvents.filter((entry) => !previousAuditIds.has(entry.id))) await insertPostgresAuditEvent(client, event);
    await projectPostgresOutbox(client, before.outbox, after.outbox);
  }
}

/** Removal records only serve caches that are behind; a day covers any live process. */
export const ENTITY_REMOVAL_RETENTION_MS = 24 * 60 * 60 * 1000;

async function pruneEntityRemovals(client: PoolClient, now: Date): Promise<void> {
  // The floor tells a cache older than the pruned removals to reload every entity.
  await client.query(
    `WITH pruned AS (
       DELETE FROM cvg_runtime_entity_removals WHERE removed_at < $1::timestamptz RETURNING removed_version
     )
     UPDATE cvg_runtime_state
        SET entity_removal_floor = GREATEST(entity_removal_floor, COALESCE((SELECT max(removed_version) FROM pruned), 0))
      WHERE id = 1`,
    [new Date(now.getTime() - ENTITY_REMOVAL_RETENTION_MS).toISOString()]
  );
}
