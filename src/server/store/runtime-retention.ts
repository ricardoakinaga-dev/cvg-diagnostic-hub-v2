import { randomUUID } from "node:crypto";
import type { AuditEvent, RuntimeRetentionOptions, RuntimeRetentionSummary, StoreState } from "../domain/models";

const DEFAULT_OUTBOX_HOT_WINDOW = 100;
const DEFAULT_SESSION_RETENTION_MS = 24 * 60 * 60 * 1000;
const DEFAULT_IDEMPOTENCY_RETENTION_MS = 24 * 60 * 60 * 1000;
const DEFAULT_OUTBOX_RETENTION_MS = 24 * 60 * 60 * 1000;

export interface RuntimeRetentionCompaction {
  readonly state: StoreState;
  readonly summary: RuntimeRetentionSummary;
  readonly retainedSessionIds: readonly string[];
  readonly removedOutboxMessageIds: readonly string[];
}

export function compactRuntimeState(
  state: StoreState,
  options: RuntimeRetentionOptions = {}
): RuntimeRetentionCompaction {
  const nowMs = (options.now ?? new Date()).getTime();
  const { hotWindow: outboxHotWindow, retentionMs: outboxRetentionMs } = outboxRetentionPolicy(options);
  const sessionRetentionMs = positiveDuration(options.sessionRetentionMs, configuredPositiveInteger("SESSION_RETENTION_MS", DEFAULT_SESSION_RETENTION_MS));
  const idempotencyRetentionMs = positiveDuration(options.idempotencyRetentionMs, configuredPositiveInteger("IDEMPOTENCY_RETENTION_MS", DEFAULT_IDEMPOTENCY_RETENTION_MS));

  // Memory keeps its complete history; PostgreSQL passes only transaction-local
  // events and retains durable history in audit_events. Retention removes neither.
  const auditEvents = [...state.auditEvents];
  const processedOutbox = state.outbox.filter((message) => {
    if (message.status !== "PROCESSED") return false;
    const availableAt = Date.parse(message.availableAt);
    return Number.isFinite(availableAt) && nowMs - availableAt <= outboxRetentionMs;
  }).slice(-outboxHotWindow);
  const retainedProcessedIds = new Set(processedOutbox.map((message) => message.id));
  const outbox = state.outbox.filter((message) => message.status !== "PROCESSED" || retainedProcessedIds.has(message.id));
  const retainedOutboxIds = new Set(outbox.map((message) => message.id));
  const sessions = state.sessions.filter((session) => {
    if (!session.revokedAt && Date.parse(session.expiresAt) > nowMs) return true;
    const reference = Date.parse(session.revokedAt ?? session.expiresAt);
    return Number.isFinite(reference) && nowMs - reference <= sessionRetentionMs;
  });
  const idempotency = state.idempotency.filter((record) => {
    const createdAt = Date.parse(record.createdAt);
    return Number.isFinite(createdAt) && nowMs - createdAt <= idempotencyRetentionMs;
  });

  return {
    state: {
      ...state,
      auditEvents,
      outbox,
      sessions,
      idempotency
    },
    summary: {
      auditEventsRemoved: state.auditEvents.length - auditEvents.length,
      outboxMessagesRemoved: state.outbox.length - outbox.length,
      sessionsRemoved: state.sessions.length - sessions.length,
      idempotencyRecordsRemoved: state.idempotency.length - idempotency.length,
      sessionActivityRowsRemoved: 0
    },
    retainedSessionIds: sessions.map((session) => session.id),
    removedOutboxMessageIds: state.outbox
      .filter((message) => !retainedOutboxIds.has(message.id))
      .map((message) => message.id)
  };
}

/** Same configured fallback for both authorities, including invalid overrides. */
export function outboxRetentionPolicy(options: RuntimeRetentionOptions): { hotWindow: number; retentionMs: number } {
  return {
    hotWindow: boundedCount(options.outboxHotWindow, configuredPositiveInteger("STATE_OUTBOX_HOT_WINDOW", DEFAULT_OUTBOX_HOT_WINDOW)),
    retentionMs: positiveDuration(options.outboxRetentionMs, configuredPositiveInteger("OUTBOX_STATE_RETENTION_MS", DEFAULT_OUTBOX_RETENTION_MS))
  };
}

/**
 * Expiry of the idle timeout is evaluated against the session-activity table,
 * so retention must additionally drop rows whose session is gone. Each store
 * prunes that table natively; this helper applies the same rule in memory so
 * both implementations keep liveness and snapshot in agreement.
 */
export function activityRowsAfterPrune<T extends { readonly sessionId: string }>(
  activity: readonly T[],
  retainedSessionIds: readonly string[]
): readonly T[] {
  const retained = new Set(retainedSessionIds);
  return activity.filter((record) => retained.has(record.sessionId));
}

/**
 * Retention is an administrative act, so every compaction appends exactly one
 * audit event describing what it removed. The event carries counts only: no
 * session, patient or payload value is ever written to the audit trail.
 */
export function runtimeRetentionAuditEvent(summary: RuntimeRetentionSummary, occurredAt: Date): AuditEvent {
  return {
    id: `audit-runtime-retention-${occurredAt.getTime()}-${randomUUID()}`,
    eventType: "RuntimeStateRetentionApplied",
    entityType: "RuntimeState",
    entityId: "cvg-runtime-state",
    previousState: "GROWING",
    newState: "COMPACTED",
    correlationId: `corr-runtime-retention-${randomUUID()}`,
    metadata: {
      sessionsRemoved: summary.sessionsRemoved,
      sessionActivityRowsRemoved: summary.sessionActivityRowsRemoved,
      idempotencyRecordsRemoved: summary.idempotencyRecordsRemoved,
      outboxMessagesRemoved: summary.outboxMessagesRemoved,
      auditEventsRemoved: summary.auditEventsRemoved
    },
    occurredAt: occurredAt.toISOString()
  };
}

function configuredPositiveInteger(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

function boundedCount(value: number | undefined, fallback: number): number {
  const candidate = value ?? fallback;
  return Number.isSafeInteger(candidate) && candidate > 0 ? Math.min(candidate, 100_000) : fallback;
}

function positiveDuration(value: number | undefined, fallback: number): number {
  const candidate = value ?? fallback;
  return Number.isSafeInteger(candidate) && candidate > 0 ? candidate : fallback;
}
