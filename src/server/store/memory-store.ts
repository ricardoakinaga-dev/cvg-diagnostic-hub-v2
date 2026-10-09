import type { ClinicalArchiveEntry, ClinicalArchiveOptions, ClinicalArchivePurgeOptions, ClinicalArchivePurgeSummary, ClinicalArchiveQuery, ClinicalArchiveRow, ClinicalArchiveSummary, AuditEntity, AuditMetrics, AuditMetricsQuery, AuditReadPage, AuditReadQuery, AuditTransactionReader, RuntimeRetentionOptions, RuntimeRetentionSummary, SessionActivity, StateStore, StoreState } from "../domain/models";
import { auditPage } from "./audit-read";
import { auditMetrics } from "../domain/audit-metrics";
import { outboxMetrics, outboxPage } from "../domain/outbox-read";
import type { OutboxTransactionQuery } from "../domain/models";
import { activityRowsAfterPrune, compactRuntimeState, retentionRemovedAnything, runtimeRetentionAuditEvent } from "./runtime-retention";
import { freezeState } from "./immutable-state";
import { archiveAuditEvent, archiveEntries, assertBoundedArchiveQuery, archiveRows, archiveSummary, newArchiveBatchId, planClinicalArchive, purgeAuditEvent, purgeCutoff } from "../domain/clinical-archive";

function cloneState(state: StoreState): StoreState {
  return structuredClone(state);
}

function touchedActivity(activity: SessionActivity, previous?: SessionActivity): SessionActivity {
  const observedAt = Date.parse(activity.lastSeenAt);
  if (!Number.isFinite(observedAt)) throw new Error("MEMORY_SESSION_ACTIVITY_TIMESTAMP_INVALID");
  const lastSeenAt = new Date(Math.max(observedAt, previous ? Date.parse(previous.lastSeenAt) : observedAt)).toISOString();
  return { ...activity, lastSeenAt };
}

export class MemoryStore implements StateStore {
  private state: StoreState;
  private queue: Promise<unknown> = Promise.resolve();
  private readonly activity = new Map<string, SessionActivity>();
  /** The clinical archive (D5) that PostgreSQL keeps in cvg_clinical_archive. */
  private archive: ClinicalArchiveRow[] = [];
  /** Mirrors the runtime state row version that PostgreSQL bumps per write. */
  private version = 1;

  constructor(initialState: StoreState) {
    this.state = freezeState(cloneState(initialState));
  }

  /** A mutable copy for tests and diagnostics; runtime reads share the frozen aggregate. */
  getState(): StoreState {
    return cloneState(this.state);
  }

  async readState(): Promise<StoreState> {
    const run = this.queue.then(() => this.state);
    this.queue = run.then(() => undefined, () => undefined);
    return run;
  }

  async readStateSnapshot(): Promise<{ state: StoreState; version: number }> {
    const state = await this.readState();
    return { state, version: this.version };
  }

  async readStateVersion(): Promise<number> {
    return this.version;
  }

  async readOutbox(query: { kind: "replay" | "dead-letter"; limit: number }) {
    return outboxPage((await this.readState()).outbox, query);
  }

  async readOutboxMetrics() {
    return outboxMetrics((await this.readState()).outbox);
  }

  async readRealtimeSnapshot(limit: number): Promise<{ state: StoreState; version: number }> {
    const snapshot = await this.readStateSnapshot();
    return { ...snapshot, state: { ...snapshot.state, outbox: outboxPage(snapshot.state.outbox, { kind: "replay", limit }) } };
  }

  async outboxTransaction<T>(_query: OutboxTransactionQuery, operation: (state: StoreState) => Promise<{ state: StoreState; result: T }> | { state: StoreState; result: T }): Promise<T> {
    return this.transaction(operation);
  }

  async readAuditEvents(query: AuditReadQuery): Promise<AuditReadPage> {
    return auditPage((await this.readState()).auditEvents, query);
  }

  async readAuditActors(entities: AuditEntity[], actorIds?: readonly string[]): Promise<{ entityId: string; actorId: string }[]> {
    const ids = new Set(entities.map((entity) => entity.entityId));
    const actors = actorIds ? new Set(actorIds) : undefined;
    const pairs = new Map<string, { entityId: string; actorId: string }>();
    for (const event of (await this.readState()).auditEvents) {
      if (event.actorId && ids.has(event.entityId) && (!actors || actors.has(event.actorId))) pairs.set(JSON.stringify([event.entityId, event.actorId]), { entityId: event.entityId, actorId: event.actorId });
    }
    return [...pairs.values()];
  }

  async readAuditMetrics(query: AuditMetricsQuery): Promise<AuditMetrics> {
    return auditMetrics((await this.readState()).auditEvents, query);
  }

  async readAuthorizationSnapshot(query: { userId: string; sessionId?: string }): Promise<{ user?: StoreState["users"][number]; session?: StoreState["sessions"][number] }> {
    const user = this.state.users.find((entry) => entry.id === query.userId);
    const session = query.sessionId ? this.state.sessions.find((entry) => entry.id === query.sessionId && entry.userId === query.userId) : undefined;
    return {
      user: user ? structuredClone(user) : undefined,
      session: session ? structuredClone(session) : undefined
    };
  }

  async readSessionActivity(sessionId: string): Promise<SessionActivity | undefined> {
    const record = this.activity.get(sessionId);
    return record ? { ...record } : undefined;
  }

  async touchSessionActivity(activity: { sessionId: string; userId: string; lastSeenAt: string }): Promise<SessionActivity> {
    const record = touchedActivity(activity, this.activity.get(activity.sessionId));
    this.activity.set(activity.sessionId, record);
    return { ...record };
  }

  async compactRuntimeState(options: RuntimeRetentionOptions = {}): Promise<RuntimeRetentionSummary> {
    const now = options.now ?? new Date();
    const run = this.queue.then(async () => {
      const compaction = compactRuntimeState(this.state, { ...options, now });
      const prunedActivity = activityRowsAfterPrune([...this.activity.values()], compaction.retainedSessionIds);
      const sessionActivityRowsRemoved = this.activity.size - prunedActivity.length;
      this.activity.clear();
      for (const record of prunedActivity) this.activity.set(record.sessionId, record);
      const summary: RuntimeRetentionSummary = { ...compaction.summary, sessionActivityRowsRemoved };
      this.state = freezeState(retentionRemovedAnything(summary)
        ? { ...compaction.state, auditEvents: [...compaction.state.auditEvents, runtimeRetentionAuditEvent(summary, now)] }
        : compaction.state);
      this.version += 1;
      return summary;
    });
    this.queue = run.then(() => undefined, () => undefined);
    return run;
  }

  async archiveClinicalRecords(options: ClinicalArchiveOptions = {}): Promise<ClinicalArchiveSummary> {
    const now = options.now ?? new Date();
    const run = this.queue.then(() => {
      const plan = planClinicalArchive(this.state, { ...options, now });
      if (options.dryRun || plan.partition.requestIds.length === 0) return archiveSummary(plan);
      const batchId = newArchiveBatchId(now);
      const summary = { ...archiveSummary(plan, batchId), batchId };
      this.archive = [...this.archive, ...archiveRows(plan, batchId, now)];
      this.state = freezeState({ ...plan.partition.state, auditEvents: [...plan.partition.state.auditEvents, archiveAuditEvent(summary, now, options.actor)] });
      this.version += 1;
      return summary;
    });
    this.queue = run.then(() => undefined, () => undefined);
    return run;
  }

  async readClinicalArchive(query: ClinicalArchiveQuery): Promise<ClinicalArchiveEntry[]> {
    assertBoundedArchiveQuery(query);
    const state = await this.readState();
    const requests = new Set(this.archive
      .filter((row) => row.collection === "requests" && (query.patientId === undefined || row.data.patientId === query.patientId) && (query.requestId === undefined || row.requestId === query.requestId))
      .map((row) => row.requestId));
    const entries = archiveEntries(this.archive.filter((row) => requests.has(row.requestId)), state.services);
    const offset = query.offset ?? 0;
    return entries.slice(offset, query.limit === undefined ? undefined : offset + query.limit);
  }

  async readArchivedRequest(requestId: string): Promise<ClinicalArchiveRow[] | undefined> {
    await this.readState();
    const rows = this.archive.filter((row) => row.requestId === requestId);
    return rows.some((row) => row.collection === "requests") ? structuredClone(rows) : undefined;
  }

  async purgeClinicalArchive(options: ClinicalArchivePurgeOptions = {}): Promise<ClinicalArchivePurgeSummary> {
    const now = options.now ?? new Date();
    const cutoff = purgeCutoff(now, options.purgeAfterMonths);
    const run = this.queue.then(() => {
      const due = cutoff ? this.archive.filter((row) => Date.parse(row.archivedAt) <= cutoff.getTime()) : [];
      const summary: ClinicalArchivePurgeSummary = {
        requestsPurged: new Set(due.filter((row) => row.collection === "requests").map((row) => row.requestId)).size,
        entitiesPurged: due.length,
        attachmentKeys: due.filter((row) => row.collection === "attachments").map((row) => String(row.data.storageKey))
      };
      if (options.dryRun || due.length === 0) return summary;
      const purged = new Set(due);
      this.archive = this.archive.filter((row) => !purged.has(row));
      this.state = freezeState({ ...this.state, auditEvents: [...this.state.auditEvents, purgeAuditEvent(summary, now)] });
      this.version += 1;
      return summary;
    });
    this.queue = run.then(() => undefined, () => undefined);
    return run;
  }

  async transaction<T>(
    operation: (state: StoreState, audit?: AuditTransactionReader) => Promise<{ state: StoreState; result: T }> | { state: StoreState; result: T }
  ): Promise<T> {
    const run = this.queue.then(async () => {
      const outcome = await operation(this.state, { hasAuditEvent: async (query) => this.state.auditEvents.some((event) => event.eventType === query.eventType && event.entityType === query.entityType && event.entityId === query.entityId && event.actorId === query.actorId) });
      const nextState = freezeState(outcome.state);
      const nextActivity = new Map(this.activity);
      const previousSessionIds = new Set(this.state.sessions.map((session) => session.id));
      for (const session of nextState.sessions) {
        if (!previousSessionIds.has(session.id)) {
          nextActivity.set(session.id, touchedActivity({
            sessionId: session.id, userId: session.userId, lastSeenAt: session.createdAt
          }, nextActivity.get(session.id)));
        }
      }
      // Stage activity first: an initialization failure cannot publish a session.
      this.state = nextState;
      this.activity.clear();
      for (const [sessionId, activity] of nextActivity) this.activity.set(sessionId, activity);
      this.version += 1;
      return outcome.result;
    });
    this.queue = run.then(() => undefined, () => undefined);
    return run;
  }

  async reset(state: StoreState): Promise<void> {
    this.archive = [];
    await this.transaction(() => ({ state: cloneState(state), result: undefined }));
  }

  async healthcheck(): Promise<void> {
    const state = await this.readState();
    const collections: (keyof typeof state)[] = ["users", "sessions", "patients", "encounters", "admissions", "services", "reasonCodes", "requests", "items", "samples", "procedures", "schedules", "results", "resultVersions", "notifications", "auditEvents", "outbox", "idempotency", "attachments"];
    if (!Number.isSafeInteger(state.protocolSequence) || state.protocolSequence < 0 || collections.some((key) => !Array.isArray(state[key]))) {
      throw new Error("MEMORY_RUNTIME_STATE_INVALID");
    }
  }
}
