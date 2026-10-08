import { createHash, randomUUID } from "node:crypto";
import type { StateStore } from "../domain/models";
import { createStructuredLogger } from "../observability/structured-logger";
import { recordLoginDistributedAttemptSignal } from "../observability/metrics";
import { consumeRateLimitCounter, readRateLimitCounter } from "./rate-limit";

/**
 * Aggregated per-account monitoring (PROD-203, agreed alternative of PROD-517).
 *
 * D-021 rejected per-account lockout because it lets an attacker lock the
 * victim out. This signal therefore only observes: it never throttles, blocks
 * or changes the per-(e-mail, client) backoff. It answers "is this account
 * being guessed from many places?", which the per-pair counters cannot see.
 */
const DEFAULT_WINDOW_MS = 15 * 60 * 1000;
const MAX_WINDOW_MS = 60 * 60 * 1000;
const DEFAULT_THRESHOLD = 20;

export type LoginSignalEnvironment = Readonly<Record<string, string | undefined>>;

export interface LoginDistributedAttemptSignal {
  readonly accountId: string;
  readonly attempts: number;
  readonly distinctClients: number;
  readonly windowMs: number;
  readonly threshold: number;
}

function boundedInteger(value: string | undefined, fallback: number, minimum: number, maximum: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= minimum && parsed <= maximum ? parsed : fallback;
}

/** Pseudonymous account id: the e-mail never reaches logs, metrics or the signal counters. */
export function pseudonymousAccountId(email: string, environment: LoginSignalEnvironment = process.env): string {
  return createHash("sha256").update(`${environment.SESSION_SECRET ?? ""}${email.trim().toLowerCase()}`).digest("hex").slice(0, 16);
}

/**
 * Counts one wrong password against the account (any client) and returns the
 * signal exactly once per window, when the count reaches the threshold.
 */
export async function registerAccountLoginFailure(
  identity: { email: string; clientKey: string },
  environment: LoginSignalEnvironment = process.env,
  timestamp = Date.now()
): Promise<LoginDistributedAttemptSignal | undefined> {
  const windowMs = boundedInteger(environment.LOGIN_ACCOUNT_SIGNAL_WINDOW_MS, DEFAULT_WINDOW_MS, 1000, MAX_WINDOW_MS);
  const threshold = boundedInteger(environment.LOGIN_ACCOUNT_SIGNAL_THRESHOLD, DEFAULT_THRESHOLD, 1, 1_000_000);
  const accountId = pseudonymousAccountId(identity.email, environment);
  const clientId = createHash("sha256").update(identity.clientKey).digest("hex").slice(0, 16);
  const attempts = await consumeRateLimitCounter(`login-signal:${accountId}`, windowMs, timestamp);
  // The first failure of a client inside the window adds one distinct client.
  const firstFromClient = await consumeRateLimitCounter(`login-signal-client:${accountId}:${clientId}`, windowMs, timestamp) === 1;
  const distinctKey = `login-signal-clients:${accountId}`;
  const distinctClients = firstFromClient ? await consumeRateLimitCounter(distinctKey, windowMs, timestamp) : await readRateLimitCounter(distinctKey, windowMs, timestamp);
  if (attempts !== threshold) return undefined;
  return { accountId, attempts, distinctClients: Math.max(1, distinctClients), windowMs, threshold };
}

/** Log, metric and audit event for one crossed threshold. */
export async function reportDistributedAttempts(store: StateStore, signal: LoginDistributedAttemptSignal, correlationId: string): Promise<void> {
  createStructuredLogger().warn("security.login_distributed_attempts", {
    component: "security",
    accountId: signal.accountId,
    attempts: signal.attempts,
    distinctClients: signal.distinctClients,
    windowMs: signal.windowMs,
    threshold: signal.threshold
  });
  recordLoginDistributedAttemptSignal();
  await store.transaction((state) => ({
    state: {
      ...state,
      auditEvents: [...state.auditEvents, {
        id: `audit_${randomUUID()}`,
        eventType: "LoginDistributedAttemptsDetected",
        entityType: "Account",
        entityId: signal.accountId,
        correlationId,
        metadata: { attempts: signal.attempts, distinctClients: signal.distinctClients, windowMs: signal.windowMs, threshold: signal.threshold },
        occurredAt: new Date().toISOString()
      }]
    },
    result: undefined
  }));
}

/**
 * Best-effort wrapper for the login failure path: monitoring must never turn
 * a wrong password into a different response, so every failure is swallowed
 * after a structured warning.
 */
export async function observeLoginFailure(store: StateStore, identity: { email: string; clientKey: string }, correlationId: string): Promise<void> {
  try {
    const signal = await registerAccountLoginFailure(identity);
    if (signal) await reportDistributedAttempts(store, signal, correlationId);
  } catch {
    createStructuredLogger().warn("security.login_signal_unavailable", { component: "security" });
  }
}
