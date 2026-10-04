import type { StateStore } from "../domain/models";

export interface RuntimeRetentionSchedule {
  shouldRun(nowMs: number): boolean;
  record(nowMs: number): void;
}

const DEFAULT_RUNTIME_RETENTION_INTERVAL_MS = 60 * 60 * 1000;
const MIN_RUNTIME_RETENTION_INTERVAL_MS = 60 * 1000;
const MAX_RUNTIME_RETENTION_INTERVAL_MS = 24 * 60 * 60 * 1000;

export function runtimeRetentionIntervalMs(environment: Partial<NodeJS.ProcessEnv> = process.env): number {
  const configured = Number(environment.RUNTIME_RETENTION_INTERVAL_MS);
  if (!Number.isSafeInteger(configured) || configured <= 0) return DEFAULT_RUNTIME_RETENTION_INTERVAL_MS;
  return Math.min(Math.max(configured, MIN_RUNTIME_RETENTION_INTERVAL_MS), MAX_RUNTIME_RETENTION_INTERVAL_MS);
}

/**
 * Schedules runtime retention independently of the delivery loop so an idle or
 * failing outbox cannot postpone pruning. PROD-103 shipped `compactRuntimeState`
 * with no caller at all, which left the snapshot growing without bound; the
 * schedule is what makes retention observable in production.
 */
export function createRuntimeRetentionSchedule(
  intervalMs = runtimeRetentionIntervalMs()
): RuntimeRetentionSchedule {
  let lastRunAtMs: number | undefined;
  return {
    shouldRun(nowMs) {
      return lastRunAtMs === undefined || nowMs - lastRunAtMs >= intervalMs;
    },
    record(nowMs) {
      lastRunAtMs = nowMs;
    }
  };
}

export async function runScheduledRuntimeRetention(
  store: StateStore,
  schedule: RuntimeRetentionSchedule,
  options: { readonly now?: () => number } = {}
): Promise<boolean> {
  const nowMs = (options.now ?? Date.now)();
  if (!schedule.shouldRun(nowMs)) return false;
  // The attempt is recorded before the run so a failing retention job retries
  // on the next cadence instead of on every cycle.
  schedule.record(nowMs);
  const summary = await store.compactRuntimeState({ now: new Date(nowMs) });
  if (summary.sessionsRemoved + summary.sessionActivityRowsRemoved + summary.idempotencyRecordsRemoved + summary.outboxMessagesRemoved > 0) {
    console.log(JSON.stringify({
      event: "runtime.retention_applied",
      sessionsRemoved: summary.sessionsRemoved,
      sessionActivityRowsRemoved: summary.sessionActivityRowsRemoved,
      idempotencyRecordsRemoved: summary.idempotencyRecordsRemoved,
      outboxMessagesRemoved: summary.outboxMessagesRemoved
    }));
  }
  return true;
}