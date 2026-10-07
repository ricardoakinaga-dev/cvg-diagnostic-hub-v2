import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export const DEFAULT_OUTBOX_HEARTBEAT_FILE = "/tmp/outbox-worker-heartbeat.json";
export const DEFAULT_OUTBOX_HEARTBEAT_MAX_AGE_MS = 30_000;
export const DEFAULT_OUTBOX_HEARTBEAT_ERROR_TOLERANCE = 3;

export type OutboxHeartbeatResult = "success" | "error";
export type OutboxHeartbeatHealth = "ok" | "degraded" | "unhealthy";

export interface OutboxHeartbeatEnvironment {
  readonly OUTBOX_HEARTBEAT_FILE?: string;
  readonly OUTBOX_HEARTBEAT_MAX_AGE_MS?: string;
  readonly OUTBOX_HEARTBEAT_ERROR_TOLERANCE?: string;
}

export interface OutboxHeartbeat {
  readonly timestamp: string;
  readonly lastResult: OutboxHeartbeatResult;
  /** Consecutive failed cycles; reset to zero by the first clean cycle. */
  readonly consecutiveErrors: number;
  /**
   * Verdict already resolved by the worker, so the container probe stays a
   * plain node script and never has to duplicate the tolerance policy.
   */
  readonly health: OutboxHeartbeatHealth;
}

export interface OutboxHeartbeatCheck {
  readonly heartbeat: OutboxHeartbeat;
  readonly ageMs: number;
}

export type OutboxHeartbeatFailureCode =
  | "OUTBOX_HEARTBEAT_FILE_MISSING"
  | "OUTBOX_HEARTBEAT_FILE_UNREADABLE"
  | "OUTBOX_HEARTBEAT_INVALID"
  | "OUTBOX_HEARTBEAT_STALE"
  | "OUTBOX_HEARTBEAT_FUTURE"
  | "OUTBOX_HEARTBEAT_MAX_AGE_INVALID"
  | "OUTBOX_HEARTBEAT_PATH_INVALID"
  | "OUTBOX_HEARTBEAT_RESULT_INVALID"
  | "OUTBOX_HEARTBEAT_ERROR_TOLERANCE_INVALID"
  | "OUTBOX_WORKER_LAST_CYCLE_FAILED";

export class OutboxHeartbeatError extends Error {
  readonly code: OutboxHeartbeatFailureCode;

  constructor(code: OutboxHeartbeatFailureCode) {
    super(code);
    this.name = "OutboxHeartbeatError";
    this.code = code;
  }
}

export function resolveOutboxHeartbeatFile(
  environment: OutboxHeartbeatEnvironment | NodeJS.ProcessEnv = process.env
): string {
  const configured = environment.OUTBOX_HEARTBEAT_FILE?.trim();
  return configured || DEFAULT_OUTBOX_HEARTBEAT_FILE;
}

export function resolveOutboxHeartbeatMaxAgeMs(
  environment: OutboxHeartbeatEnvironment | NodeJS.ProcessEnv = process.env
): number {
  const configured = environment.OUTBOX_HEARTBEAT_MAX_AGE_MS;
  if (configured === undefined) return DEFAULT_OUTBOX_HEARTBEAT_MAX_AGE_MS;
  const parsed = Number(configured);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new OutboxHeartbeatError("OUTBOX_HEARTBEAT_MAX_AGE_INVALID");
  }
  return parsed;
}

export async function writeOutboxHeartbeat(
  filePath: string,
  lastResult: OutboxHeartbeatResult,
  now = new Date(),
  consecutiveErrors = lastResult === "error" ? 1 : 0
): Promise<OutboxHeartbeat> {
  const normalizedPath = normalizePath(filePath);
  if (lastResult !== "success" && lastResult !== "error") {
    throw new OutboxHeartbeatError("OUTBOX_HEARTBEAT_RESULT_INVALID");
  }
  const heartbeat: OutboxHeartbeat = {
    timestamp: now.toISOString(),
    lastResult,
    consecutiveErrors: Math.max(0, Math.trunc(consecutiveErrors)),
    health: outboxHeartbeatHealth(lastResult, consecutiveErrors, resolveOutboxHeartbeatErrorTolerance())
  };
  const temporaryPath = `${normalizedPath}.${process.pid}.${Date.now()}.tmp`;

  await mkdir(dirname(normalizedPath), { recursive: true });
  try {
    await writeFile(temporaryPath, `${JSON.stringify(heartbeat)}\n`, { encoding: "utf8", mode: 0o644 });
    await rename(temporaryPath, normalizedPath);
    return heartbeat;
  } finally {
    await unlink(temporaryPath).catch(() => undefined);
  }
}

export async function readOutboxHeartbeat(filePath: string): Promise<OutboxHeartbeat> {
  const normalizedPath = normalizePath(filePath);
  let content: string;
  try {
    content = await readFile(normalizedPath, "utf8");
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) throw new OutboxHeartbeatError("OUTBOX_HEARTBEAT_FILE_MISSING");
    throw new OutboxHeartbeatError("OUTBOX_HEARTBEAT_FILE_UNREADABLE");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(content) as unknown;
  } catch {
    throw new OutboxHeartbeatError("OUTBOX_HEARTBEAT_INVALID");
  }
  return parseHeartbeat(parsed);
}

export async function checkOutboxHeartbeat(
  filePath: string,
  maxAgeMs: number,
  now = new Date()
): Promise<OutboxHeartbeatCheck> {
  return assertFreshOutboxHeartbeat(await readOutboxHeartbeat(filePath), maxAgeMs, now);
}

/** Strict gate: any failed cycle is unhealthy. */
export function assertSuccessfulOutboxHeartbeat(check: OutboxHeartbeatCheck): OutboxHeartbeatCheck {
  if (check.heartbeat.lastResult !== "success") {
    throw new OutboxHeartbeatError("OUTBOX_WORKER_LAST_CYCLE_FAILED");
  }
  return check;
}

export function outboxCycleHeartbeatResult(summary: { failed: number; retried: number }): OutboxHeartbeatResult {
  return summary.failed > 0 || summary.retried > 0 ? "error" : "success";
}

export function nextOutboxHeartbeatErrorCount(previous: number, lastResult: OutboxHeartbeatResult): number {
  return lastResult === "error" ? Math.max(0, Math.trunc(previous)) + 1 : 0;
}

/**
 * A single failed cycle is not an outage. The container reports unhealthy only
 * after N consecutive failures, so one transient database hiccup cannot flap
 * the worker for the rest of its life (review A-07).
 */
export function outboxHeartbeatHealth(
  lastResult: OutboxHeartbeatResult,
  consecutiveErrors: number,
  tolerance: number
): OutboxHeartbeatHealth {
  if (lastResult === "success") return "ok";
  return Math.max(0, Math.trunc(consecutiveErrors)) >= tolerance ? "unhealthy" : "degraded";
}

export function resolveOutboxHeartbeatErrorTolerance(
  environment: OutboxHeartbeatEnvironment | NodeJS.ProcessEnv = process.env
): number {
  const configured = environment.OUTBOX_HEARTBEAT_ERROR_TOLERANCE;
  if (configured === undefined) return DEFAULT_OUTBOX_HEARTBEAT_ERROR_TOLERANCE;
  const parsed = Number(configured);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new OutboxHeartbeatError("OUTBOX_HEARTBEAT_ERROR_TOLERANCE_INVALID");
  }
  return parsed;
}

/**
 * Liveness gate used by the container probe and by operators. A degraded
 * heartbeat is reported but tolerated until the error budget is exhausted.
 */
export function assertOutboxHeartbeatWithinTolerance(
  check: OutboxHeartbeatCheck,
  tolerance: number
): OutboxHeartbeatCheck {
  if (check.heartbeat.health === "unhealthy" || check.heartbeat.consecutiveErrors >= tolerance) {
    throw new OutboxHeartbeatError("OUTBOX_WORKER_LAST_CYCLE_FAILED");
  }
  return check;
}

export function assertFreshOutboxHeartbeat(
  value: unknown,
  maxAgeMs: number,
  now = new Date()
): OutboxHeartbeatCheck {
  if (!Number.isSafeInteger(maxAgeMs) || maxAgeMs <= 0) {
    throw new OutboxHeartbeatError("OUTBOX_HEARTBEAT_MAX_AGE_INVALID");
  }
  const heartbeat = parseHeartbeat(value);
  const timestampMs = Date.parse(heartbeat.timestamp);
  const nowMs = now.getTime();
  if (!Number.isFinite(timestampMs) || !Number.isFinite(nowMs)) {
    throw new OutboxHeartbeatError("OUTBOX_HEARTBEAT_INVALID");
  }
  const ageMs = nowMs - timestampMs;
  if (ageMs < 0) throw new OutboxHeartbeatError("OUTBOX_HEARTBEAT_FUTURE");
  if (ageMs > maxAgeMs) throw new OutboxHeartbeatError("OUTBOX_HEARTBEAT_STALE");
  return { heartbeat, ageMs };
}

function parseHeartbeat(value: unknown): OutboxHeartbeat {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new OutboxHeartbeatError("OUTBOX_HEARTBEAT_INVALID");
  }
  const candidate = value as Record<string, unknown>;
  const allowedKeys = new Set(["timestamp", "lastResult", "consecutiveErrors", "health"]);
  const keys = Object.keys(candidate);
  if (keys.some((key) => !allowedKeys.has(key))) {
    throw new OutboxHeartbeatError("OUTBOX_HEARTBEAT_INVALID");
  }
  if (
    typeof candidate.timestamp !== "string"
    || !candidate.timestamp
    || !Number.isFinite(Date.parse(candidate.timestamp))
    || (candidate.lastResult !== "success" && candidate.lastResult !== "error")
  ) {
    throw new OutboxHeartbeatError("OUTBOX_HEARTBEAT_INVALID");
  }
  const lastResult = candidate.lastResult;
  const consecutiveErrors = candidate.consecutiveErrors === undefined
    ? lastResult === "error" ? 1 : 0
    : candidate.consecutiveErrors;
  if (!Number.isSafeInteger(consecutiveErrors) || Number(consecutiveErrors) < 0) {
    throw new OutboxHeartbeatError("OUTBOX_HEARTBEAT_INVALID");
  }
  const health = candidate.health === undefined
    ? outboxHeartbeatHealth(lastResult, Number(consecutiveErrors), resolveOutboxHeartbeatErrorTolerance())
    : candidate.health;
  if (health !== "ok" && health !== "degraded" && health !== "unhealthy") {
    throw new OutboxHeartbeatError("OUTBOX_HEARTBEAT_INVALID");
  }
  return { timestamp: candidate.timestamp, lastResult, consecutiveErrors: Number(consecutiveErrors), health };
}

function normalizePath(filePath: string): string {
  const normalized = filePath.trim();
  if (!normalized) throw new OutboxHeartbeatError("OUTBOX_HEARTBEAT_PATH_INVALID");
  return normalized;
}

function hasErrorCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}
