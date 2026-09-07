import { Pool } from "pg";
import { createOutboxSinkFromEnv, type ConfiguredOutboxSink, type OutboxSqlExecutor, processOutboxBatch } from "../src/server/operations/outbox";
import { closeRealtimeNotificationAdapter } from "../src/server/observability/realtime";
import { closeRuntimeStore, getRuntimeStoreAsync } from "../src/server/store/runtime";

const once = process.argv.includes("--once") || process.env.OUTBOX_ONCE === "true";
const intervalMs = positiveInteger(process.env.OUTBOX_INTERVAL_MS, 5_000);
let stopping = false;

interface WorkerSink {
  sink: ConfiguredOutboxSink;
  close(): Promise<void>;
}

async function runOnce(sink: ConfiguredOutboxSink): Promise<void> {
  const store = await getRuntimeStoreAsync();
  const summary = await processOutboxBatch(store, sink, {
    workerId: process.env.OUTBOX_WORKER_ID ?? `worker_${process.pid}`,
    batchSize: positiveInteger(process.env.OUTBOX_BATCH_SIZE, 25),
    maxAttempts: positiveInteger(process.env.OUTBOX_MAX_ATTEMPTS, 5),
    leaseMs: positiveInteger(process.env.OUTBOX_LEASE_MS, 30_000)
  });
  console.log(JSON.stringify({ event: "outbox.batch", sink: sink.kind, durability: sink.durability, ...summary }));
}

async function main(): Promise<void> {
  const workerSink = createWorkerSink();
  try {
    if (once) {
      await runOnce(workerSink.sink);
      return;
    }
    while (!stopping) {
      try {
        await runOnce(workerSink.sink);
      } catch (error) {
        console.error(JSON.stringify({ event: "outbox.worker_error", message: error instanceof Error ? error.message : "OUTBOX_WORKER_FAILED" }));
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

void main().catch((error: unknown) => {
  console.error(JSON.stringify({ event: "outbox.worker_fatal", message: error instanceof Error ? error.message : "OUTBOX_WORKER_FAILED" }));
  process.exitCode = 1;
});
