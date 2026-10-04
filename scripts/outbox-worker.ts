import { unlink } from "node:fs/promises";
import { Pool } from "pg";
import { createOutboxSinkFromEnv, type ConfiguredOutboxSink, type OutboxProcessSummary, type OutboxSqlExecutor, processOutboxBatch } from "../src/server/operations/outbox";
import { nextOutboxHeartbeatErrorCount, outboxCycleHeartbeatResult, resolveOutboxHeartbeatFile, writeOutboxHeartbeat, type OutboxHeartbeat, type OutboxHeartbeatResult } from "../src/server/operations/outbox-heartbeat";
import { createRuntimeRetentionSchedule, runScheduledRuntimeRetention } from "../src/server/operations/runtime-retention-job";
import { closeRealtimeNotificationAdapter } from "../src/server/observability/realtime";
import { closeRuntimeStore, getRuntimeStoreAsync } from "../src/server/store/runtime";

const once = process.argv.includes("--once") || process.env.OUTBOX_ONCE === "true";
const intervalMs = positiveInteger(process.env.OUTBOX_INTERVAL_MS, 5_000);
const heartbeatFile = resolveOutboxHeartbeatFile();
// PROD-103: retention runs on its own cadence inside the worker. It used to be
// dead code, so the snapshot grew without bound in production.
const retentionSchedule = createRuntimeRetentionSchedule();
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
    await runScheduledRuntimeRetention(store, retentionSchedule);
  } catch (error) {
    console.error(JSON.stringify({ event: "runtime.retention_error", errorCode: "RUNTIME_RETENTION_FAILED" }));
    throw error;
  }
}

async function runCycle(sink: ConfiguredOutboxSink): Promise<void> {
  try {
    await runRetention();
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
    ? new Pool({ connectionString, max: positiveInteger(process.env.OUTBOX_DB_POOL_MAX, 2), idleTimeoutMillis: 30_000 })
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
    const sink = createOutboxSinkFromEnv(process.env, {
      logger: (line) => console.log(line),
      sql
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
