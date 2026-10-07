import { closeRuntimeStore, getRuntimeStoreAsync } from "../src/server/store/runtime";
import { closeRateLimitBackend, pruneRateLimitBuckets } from "../src/server/security/rate-limit";
import { runtimeRetentionIntervalMs } from "../src/server/operations/runtime-retention-job";

/**
 * Explicit runtime retention entrypoint for operators and for evidence runs
 * (PROD-103). The outbox worker also runs it on its own cadence; this script
 * exists so retention can be executed, observed and replayed on demand without
 * waiting for a delivery cycle.
 */
async function main(): Promise<void> {
  const store = await getRuntimeStoreAsync();
  const summary = await store.compactRuntimeState();
  const rateLimitBucketsRemoved = await pruneRateLimitBuckets();
  console.log(JSON.stringify({
    event: "runtime.retention_completed",
    rateLimitBucketsRemoved,
    intervalMs: runtimeRetentionIntervalMs(),
    ...summary
  }));
}

void main()
  .catch((error: unknown) => {
    console.error(JSON.stringify({
      event: "runtime.retention_failed",
      errorCode: "RUNTIME_RETENTION_FAILED",
      message: error instanceof Error ? error.message : "RUNTIME_RETENTION_FAILED"
    }));
    process.exitCode = 1;
  })
  .finally(async () => { await closeRuntimeStore(); await closeRateLimitBackend(); });