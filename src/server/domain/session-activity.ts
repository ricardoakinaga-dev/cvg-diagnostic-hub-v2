import type { SessionActivity, StateStore, Timestamp } from "./models";

export const DEFAULT_SESSION_IDLE_TIMEOUT_MS = 30 * 60 * 1000;
export const DEFAULT_SESSION_ACTIVITY_TOUCH_INTERVAL_MS = 60 * 1000;

/** Consecutive renewals kept in memory to suppress redundant writes. */
const RENEWAL_CACHE_LIMIT = 10_000;

const renewalTimestamps = new Map<string, number>();

export function sessionIdleTimeoutMs(environment: Partial<NodeJS.ProcessEnv> = process.env): number {
  return positiveEnvironmentInteger(environment, "SESSION_IDLE_TIMEOUT_MS", DEFAULT_SESSION_IDLE_TIMEOUT_MS);
}

export function sessionActivityTouchIntervalMs(environment: Partial<NodeJS.ProcessEnv> = process.env): number {
  return positiveEnvironmentInteger(environment, "SESSION_ACTIVITY_TOUCH_INTERVAL_MS", DEFAULT_SESSION_ACTIVITY_TOUCH_INTERVAL_MS);
}

/**
 * Liveness lives outside the snapshot on purpose (finding F-01, review A-01):
 * recording it inside cvg_runtime_state turned every authenticated read into a
 * global write that locked and rewrote the whole aggregate. The idle timeout is
 * therefore a product decision with an operational cost, documented in
 * docs/operations/DEPLOYMENT.md and DECISION_LOG.md.
 */
export function sessionIsIdle(
  lastSeenAt: Timestamp,
  nowMs: number = Date.now(),
  idleTimeoutMs: number = sessionIdleTimeoutMs()
): boolean {
  const referenceMs = Date.parse(lastSeenAt);
  if (!Number.isFinite(referenceMs)) return true;
  return referenceMs + idleTimeoutMs <= nowMs;
}

export function shouldTouchSessionActivity(
  activity: SessionActivity | undefined,
  createdAt: Timestamp,
  nowMs: number = Date.now(),
  touchIntervalMs: number = sessionActivityTouchIntervalMs()
): boolean {
  const referenceMs = activity ? Date.parse(activity.lastSeenAt) : Date.parse(createdAt);
  if (!Number.isFinite(referenceMs)) return true;
  return nowMs - referenceMs >= touchIntervalMs;
}

/**
 * Records liveness for long-lived surfaces such as an open SSE stream, so a
 * passive monitoring screen keeps its session during a shift. Suppressed within
 * the touch interval, and failures are swallowed on purpose: the next
 * authenticated request re-evaluates idle expiry from the store, so a dropped
 * renewal can only make a session expire earlier, never later.
 */
export function renewSessionActivity(
  store: StateStore,
  actor: { readonly id: string; readonly sessionId?: string },
  environment: Partial<NodeJS.ProcessEnv> = process.env
): void {
  const sessionId = actor.sessionId;
  if (!sessionId) return;
  const nowMs = Date.now();
  const previous = renewalTimestamps.get(sessionId);
  if (previous !== undefined && nowMs - previous < sessionActivityTouchIntervalMs(environment)) return;
  renewalTimestamps.set(sessionId, nowMs);
  if (renewalTimestamps.size > RENEWAL_CACHE_LIMIT) pruneRenewalTimestamps(nowMs);
  const userId = actor.id;
  void Promise.resolve()
    .then(() => store.touchSessionActivity({ sessionId, userId, lastSeenAt: new Date(nowMs).toISOString() }))
    .catch(() => undefined);
}

export function resetSessionActivityRenewals(): void {
  renewalTimestamps.clear();
}

function pruneRenewalTimestamps(nowMs: number): void {
  const staleBefore = nowMs - sessionActivityTouchIntervalMs() * 2;
  for (const [sessionId, timestamp] of renewalTimestamps) {
    if (timestamp < staleBefore) renewalTimestamps.delete(sessionId);
  }
}

function positiveEnvironmentInteger(environment: Partial<NodeJS.ProcessEnv>, name: string, fallback: number): number {
  const value = Number(environment[name]);
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}