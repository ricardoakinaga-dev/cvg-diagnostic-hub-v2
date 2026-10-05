import type { AuditEntity, AuditMetrics, AuditMetricsQuery, AuditReadPage, AuditReadQuery, AuditTransactionReader, RuntimeRetentionOptions, RuntimeRetentionSummary, SessionActivity, StateStore, StoreState } from "../domain/models";
import { auditPage } from "./audit-read";
import { auditMetrics } from "../domain/audit-metrics";
import { outboxMetrics, outboxPage } from "../domain/outbox-read";
import type { OutboxTransactionQuery } from "../domain/models";
import { activityRowsAfterPrune, compactRuntimeState, runtimeRetentionAuditEvent } from "./runtime-retention";

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
  /** Mirrors the runtime state row version that PostgreSQL bumps per write. */
  private version = 1;

  constructor(initialState: StoreState) {
    this.state = cloneState(initialState);
  }

  getState(): StoreState {
    return cloneState(this.state);
  }

  async readState(): Promise<StoreState> {
    const run = this.queue.then(() => this.getState());
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

  async readAuditActors(entities: AuditEntity[]): Promise<{ entityId: string; actorId: string }[]> {
    const ids = new Set(entities.map((entity) => entity.entityId));
    const pairs = new Map<string, { entityId: string; actorId: string }>();
    for (const event of (await this.readState()).auditEvents) {
      if (event.actorId && ids.has(event.entityId)) pairs.set(JSON.stringify([event.entityId, event.actorId]), { entityId: event.entityId, actorId: event.actorId });
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
      this.state = {
        ...compaction.state,
        auditEvents: [...compaction.state.auditEvents, runtimeRetentionAuditEvent(summary, now)]
      };
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
      const outcome = await operation(this.getState(), { hasAuditEvent: async (query) => this.state.auditEvents.some((event) => event.eventType === query.eventType && event.entityType === query.entityType && event.entityId === query.entityId && event.actorId === query.actorId) });
      const nextState = cloneState(outcome.state);
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
