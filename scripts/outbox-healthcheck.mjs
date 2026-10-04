#!/usr/bin/env node
/**
 * Outbox worker liveness probe.
 *
 * Deliberately plain node with no TypeScript toolchain: the previous probe
 * started `tsx` on every Docker health check, so each probe paid a full
 * transpile for a file read (review A-07). The tolerance policy is not
 * duplicated here either - the worker resolves it and writes the resulting
 * `health` verdict into the heartbeat, so this script only reads the file,
 * checks its age and trusts that verdict.
 */
import { readFile } from "node:fs/promises";

const DEFAULT_HEARTBEAT_FILE = "/tmp/outbox-worker-heartbeat.json";
const DEFAULT_MAX_AGE_MS = 30_000;

function resolveHeartbeatFile(environment) {
  const configured = typeof environment.OUTBOX_HEARTBEAT_FILE === "string" ? environment.OUTBOX_HEARTBEAT_FILE.trim() : "";
  return configured || DEFAULT_HEARTBEAT_FILE;
}

function resolveMaxAgeMs(environment) {
  const configured = environment.OUTBOX_HEARTBEAT_MAX_AGE_MS;
  if (configured === undefined || configured === "") return DEFAULT_MAX_AGE_MS;
  const parsed = Number(configured);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) return Number.NaN;
  return parsed;
}

async function main() {
  const filePath = resolveHeartbeatFile(process.env);
  const maxAgeMs = resolveMaxAgeMs(process.env);
  if (!Number.isFinite(maxAgeMs)) {
    return fail("OUTBOX_HEARTBEAT_MAX_AGE_INVALID");
  }

  let content;
  try {
    content = await readFile(filePath, "utf8");
  } catch (error) {
    return fail(error && error.code === "ENOENT" ? "OUTBOX_HEARTBEAT_FILE_MISSING" : "OUTBOX_HEARTBEAT_FILE_UNREADABLE");
  }

  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch {
    return fail("OUTBOX_HEARTBEAT_INVALID");
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return fail("OUTBOX_HEARTBEAT_INVALID");
  }
  const timestampMs = Date.parse(parsed.timestamp);
  if (typeof parsed.timestamp !== "string" || !Number.isFinite(timestampMs)) {
    return fail("OUTBOX_HEARTBEAT_INVALID");
  }
  if (parsed.health !== "ok" && parsed.health !== "degraded" && parsed.health !== "unhealthy") {
    return fail("OUTBOX_HEARTBEAT_INVALID");
  }

  const ageMs = Date.now() - timestampMs;
  if (ageMs < 0) return fail("OUTBOX_HEARTBEAT_FUTURE");
  if (ageMs > maxAgeMs) return fail("OUTBOX_HEARTBEAT_STALE");
  // A degraded worker is still delivering; only an exhausted error budget is
  // reported unhealthy, so one transient failure cannot flap the container.
  if (parsed.health === "unhealthy") return fail("OUTBOX_WORKER_LAST_CYCLE_FAILED");

  console.log(JSON.stringify({
    event: "outbox.healthcheck",
    status: "ok",
    ageMs,
    lastResult: parsed.lastResult,
    consecutiveErrors: parsed.consecutiveErrors
  }));
  return undefined;
}

function fail(reason) {
  console.error(JSON.stringify({ event: "outbox.healthcheck", status: "failed", reason }));
  process.exitCode = 1;
  return reason;
}

await main();