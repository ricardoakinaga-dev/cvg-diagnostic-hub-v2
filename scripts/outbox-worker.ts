import "./load-file-secrets";
import { unlink } from "node:fs/promises";
import { Pool } from "pg";
import { createOutboxSinkFromEnv, type ConfiguredOutboxSink, type OutboxProcessSummary, type OutboxSqlExecutor, processOutboxBatch } from "../src/server/operations/outbox";
import { nextOutboxHeartbeatErrorCount, outboxCycleHeartbeatResult, resolveOutboxHeartbeatFile, writeOutboxHeartbeat, type OutboxHeartbeat, type OutboxHeartbeatResult } from "../src/server/operations/outbox-heartbeat";
import { pruneRateLimitBuckets } from "../src/server/security/rate-limit";
import { createRuntimeRetentionSchedule, runScheduledRuntimeRetention } from "../src/server/operations/runtime-retention-job";
import { clinicalArchiveConfig, createClinicalArchiveSchedule, runScheduledClinicalArchive } from "../src/server/operations/clinical-archive-job";
import { closeRealtimeNotificationAdapter } from "../src/server/observability/realtime";
import { startupEvent } from "../src/server/observability/build-info";
import { closeRuntimeStore, getRuntimeFileStore, getRuntimeStoreAsync } from "../src/server/store/runtime";
import { runtimePoolTimeouts } from "../src/server/domain/database-timeouts";
import { whatsAppCloudConfigFromEnv } from "../src/server/operations/whatsapp-cloud-api";
import { runCriticalEscalation } from "../src/server/application/critical-escalation";
import { createWhatsAppAlertResolver, createWhatsAppOutboxSink } from "../src/server/operations/whatsapp-outbox-sink";

const once = process.argv.includes("--once") || process.env.OUTBOX_ONCE === "true";
const intervalMs = positiveInteger(process.env.OUTBOX_INTERVAL_MS, 5_000);
const heartbeatFile = resolveOutboxHeartbeatFile();
// PROD-103: retention runs on its own cadence inside the worker. It used to be
// dead code, so the snapshot grew without bound in production.
const retentionSchedule = createRuntimeRetentionSchedule();
// PROD-501 (D5): archiving after the active window, with its own daily cadence.
const archiveConfig = clinicalArchiveConfig();
const archiveSchedule = createClinicalArchiveSchedule(archiveConfig.intervalMs);
let stopping = false;
let consecutiveCycleErrors = 0;

interface WorkerSink {
  sink: ConfiguredOutboxSink;
  close(): Promise<void>;
}

async function runOnce(sink: ConfiguredOutboxSink): Promise<OutboxProcessSummary> {
  const store = await getRuntimeStoreAsync();
  const summary = await processOutboxBatch(store, sink, {
    workerId: process.env.OUTBOX_WORKER_ID ?? `worker_${process.pid}`,
    batchSize: positiveInteger(process.env.OUTBOX_BATCH_SIZE, 25),
    maxAttempts: positiveInteger(process.env.OUTBOX_MAX_ATTEMPTS, 5),
    leaseMs: positiveInteger(process.env.OUTBOX_LEASE_MS, 30_000)
  });
  return summary;
}

async function runRetention(): Promise<void> {
  try {
    const store = await getRuntimeStoreAsync();
    await runScheduledRuntimeRetention(store, retentionSchedule, { pruneRateLimitBuckets });
  } catch (error) {
    console.error(JSON.stringify({ event: "runtime.retention_error", errorCode: "RUNTIME_RETENTION_FAILED" }));
    throw error;
  }
}

async function runArchive(): Promise<void> {
  try {
    const store = await getRuntimeStoreAsync();
    // Objects are only removed after a purge, which needs the legal period to be configured.
    await runScheduledClinicalArchive(store, archiveSchedule, { config: archiveConfig, fileStore: archiveConfig.purgeAfterMonths ? getRuntimeFileStore() : undefined });
  } catch (error) {
    console.error(JSON.stringify({ event: "clinical.archive_error", errorCode: "CLINICAL_ARCHIVE_FAILED" }));
    throw error;
  }
}

// PROD-402: an unacknowledged critical result climbs the policy ladder; the new notifications
// are delivered by the batch that follows in the same cycle.
async function runEscalation(): Promise<void> {
  try {
    const summary = await runCriticalEscalation(await getRuntimeStoreAsync());
    if (summary.due > 0) console.log(JSON.stringify({ event: "critical.escalation", ...summary }));
    // D-056: a level that found nobody clinical is an incident, not a quiet audit row.
    if (summary.unreachable > 0) console.error(JSON.stringify({ event: "critical.escalation_unreachable", errorCode: "CRITICAL_RECIPIENTS_UNAVAILABLE", unreachable: summary.unreachable }));
  } catch (error) {
    console.error(JSON.stringify({ event: "critical.escalation_error", errorCode: "CRITICAL_ESCALATION_FAILED" }));
    throw error;
  }
}

async function runCycle(sink: ConfiguredOutboxSink): Promise<void> {
  try {
    await runRetention();
    await runEscalation();
    await runArchive();
    const summary = await runOnce(sink);
    const lastResult: OutboxHeartbeatResult = outboxCycleHeartbeatResult(summary);
    const heartbeat = await updateHeartbeat(lastResult);
    if (!heartbeat) throw new Error("OUTBOX_HEARTBEAT_WRITE_FAILED");
    console.log(JSON.stringify({
      event: "outbox.batch",
      sink: sink.kind,
      durability: sink.durability,
      heartbeat: heartbeatStatus(heartbeat),
      ...summary
    }));
    if (lastResult === "error") throw new Error("OUTBOX_BATCH_FAILED");
  } catch (error) {
    await updateHeartbeat("error");
    throw error;
  }
}

async function updateHeartbeat(lastResult: OutboxHeartbeatResult): Promise<OutboxHeartbeat | undefined> {
  consecutiveCycleErrors = nextOutboxHeartbeatErrorCount(consecutiveCycleErrors, lastResult);
  try {
    return await writeOutboxHeartbeat(heartbeatFile, lastResult, new Date(), consecutiveCycleErrors);
  } catch {
    await unlink(heartbeatFile).catch(() => undefined);
    console.error(JSON.stringify({ event: "outbox.heartbeat_error", lastResult, errorCode: "OUTBOX_HEARTBEAT_WRITE_FAILED" }));
    return undefined;
  }
}

function heartbeatStatus(heartbeat: OutboxHeartbeat | undefined): { timestamp?: string; lastResult: OutboxHeartbeatResult | "unavailable" } {
  return heartbeat
    ? { timestamp: heartbeat.timestamp, lastResult: heartbeat.lastResult }
    : { lastResult: "unavailable" };
}

async function main(): Promise<void> {
  console.log(startupEvent("worker"));
  const workerSink = createWorkerSink();
  try {
    if (once) {
      await runCycle(workerSink.sink);
      return;
    }
    while (!stopping) {
      try {
        await runCycle(workerSink.sink);
      } catch {
        console.error(JSON.stringify({ event: "outbox.worker_error", lastResult: "error", errorCode: "OUTBOX_WORKER_FAILED" }));
      }
      await new Promise<void>((resolve) => setTimeout(resolve, intervalMs));
    }
  } finally {
    try {
      await workerSink.close();
    } finally {
      try {
        await closeRealtimeNotificationAdapter();
      } finally {
        await closeRuntimeStore();
      }
    }
  }
}

process.once("SIGTERM", () => { stopping = true; });
process.once("SIGINT", () => { stopping = true; });

function positiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function createWorkerSink(): WorkerSink {
  const configuredMode = process.env.OUTBOX_SINK?.trim().toLowerCase();
  const connectionString = process.env.DATABASE_URL?.trim();
  const pool = configuredMode === "postgres" && connectionString
    ? new Pool({ connectionString, max: positiveInteger(process.env.OUTBOX_DB_POOL_MAX, 2), idleTimeoutMillis: 30_000, ...runtimePoolTimeouts() })
    : undefined;
  if (pool && typeof pool.on === "function") pool.on("error", () => undefined);
  try {
    const sql: OutboxSqlExecutor | undefined = pool
      ? {
          query: async (text, values) => {
            const result = await pool.query(text, values ? [...values] : undefined);
            return { rows: result.rows as Record<string, unknown>[], rowCount: result.rowCount };
          }
        }
      : undefined;
    // PROD-402: an enabled but incomplete WhatsApp configuration stops the worker at startup.
    const whatsapp = createWhatsAppOutboxSink(whatsAppCloudConfigFromEnv(process.env), async (notificationId, recipientUserId) =>
      createWhatsAppAlertResolver(await getRuntimeStoreAsync())(notificationId, recipientUserId));
    const sink = createOutboxSinkFromEnv(process.env, {
      logger: (line) => console.log(line),
      sql,
      whatsapp
    });
    return {
      sink,
      close: async () => {
        if (pool) await pool.end();
      }
    };
  } catch (error) {
    if (pool) void pool.end().catch(() => undefined);
    throw error;
  }
}

void main().catch(async () => {
  await updateHeartbeat("error");
  console.error(JSON.stringify({ event: "outbox.worker_fatal", lastResult: "error", errorCode: "OUTBOX_WORKER_FAILED" }));
  process.exitCode = 1;
});
