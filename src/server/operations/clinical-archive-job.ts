import type { StateStore } from "../domain/models";
import { DEFAULT_ARCHIVE_ACTIVE_MONTHS } from "../domain/clinical-archive-policy";

/** The part of FileStore the job needs; operations may not depend on the storage layer. */
export interface ObjectRemover {
  remove(key: string): Promise<void>;
}

export interface ClinicalArchiveConfig {
  readonly enabled: boolean;
  readonly activeMonths: number;
  readonly intervalMs: number;
  /** Undefined until the legal retention period is configured: nothing is ever purged. */
  readonly purgeAfterMonths?: number;
}

export interface ClinicalArchiveSchedule {
  shouldRun(nowMs: number): boolean;
  record(nowMs: number): void;
}

const DEFAULT_ARCHIVE_INTERVAL_MS = 24 * 60 * 60 * 1000;
const MIN_ARCHIVE_INTERVAL_MS = 60 * 60 * 1000;
const MAX_MONTHS = 1_200;

function wholeMonths(value: string | undefined): number | undefined {
  if (value === undefined || value.trim() === "") return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? Math.min(parsed, MAX_MONTHS) : undefined;
}

/**
 * ARCHIVE_ACTIVE_MONTHS defaults to 24 (D5) and 0 disables archiving.
 * ARCHIVE_PURGE_AFTER_MONTHS is the legal retention period counted from the
 * archiving date; unset or 0 means "never purge" until jurídico defines it.
 */
export function clinicalArchiveConfig(environment: Partial<NodeJS.ProcessEnv> = process.env): ClinicalArchiveConfig {
  const activeMonths = wholeMonths(environment.ARCHIVE_ACTIVE_MONTHS) ?? DEFAULT_ARCHIVE_ACTIVE_MONTHS;
  const interval = Number(environment.ARCHIVE_INTERVAL_MS);
  const intervalMs = Number.isSafeInteger(interval) && interval > 0 ? Math.max(interval, MIN_ARCHIVE_INTERVAL_MS) : DEFAULT_ARCHIVE_INTERVAL_MS;
  const purgeAfterMonths = wholeMonths(environment.ARCHIVE_PURGE_AFTER_MONTHS);
  return {
    enabled: activeMonths > 0,
    activeMonths,
    intervalMs,
    ...(purgeAfterMonths ? { purgeAfterMonths } : {})
  };
}

export function createClinicalArchiveSchedule(intervalMs = clinicalArchiveConfig().intervalMs): ClinicalArchiveSchedule {
  let lastRunAtMs: number | undefined;
  return {
    shouldRun: (nowMs) => lastRunAtMs === undefined || nowMs - lastRunAtMs >= intervalMs,
    record: (nowMs) => { lastRunAtMs = nowMs; }
  };
}

/** Frequent durable-queue draining, with a provider outage backoff. */
export function createArchiveObjectRemovalSchedule(): ClinicalArchiveSchedule & { failed(nowMs: number): void } {
  let nextRunAtMs = Number.NEGATIVE_INFINITY;
  return {
    shouldRun: (nowMs) => nowMs >= nextRunAtMs,
    record: (nowMs) => { nextRunAtMs = nowMs + 5_000; },
    failed: (nowMs) => { nextRunAtMs = nowMs + 60_000; }
  };
}

/** Log-safe form of a storage key: the object path without the file name. */
function keyPrefix(key: string): string {
  return key.split("/").slice(0, 2).join("/");
}

/** Deletes the stored objects of purged attachments; a failure is logged and counted, never thrown. */
export async function removeArchivedObjects(fileStore: ObjectRemover | undefined, keys: readonly string[]): Promise<{ removed: number; failures: number }> {
  let removed = 0;
  let failures = 0;
  if (!fileStore) return { removed, failures };
  for (const key of keys) {
    try {
      await fileStore.remove(key);
      removed += 1;
    } catch {
      failures += 1;
      console.error(JSON.stringify({ event: "clinical.archive_object_removal_failed", keyPrefix: keyPrefix(key) }));
    }
  }
  return { removed, failures };
}

export interface ArchiveObjectRemovalOptions {
  readonly batchSize?: number;
  /** Budget for starting operations; an operation already in flight uses the storage timeout. */
  readonly maxDurationMs?: number;
  readonly now?: () => number;
  readonly shouldStop?: () => boolean;
}

/** An intent survives every storage failure and crash before acknowledgement. */
export async function removePendingArchiveObjects(store: StateStore, fileStore: ObjectRemover | undefined, options: ArchiveObjectRemovalOptions = {}): Promise<{ removed: number; failures: number }> {
  const batchSize = options.batchSize ?? 25;
  const maxDurationMs = options.maxDurationMs ?? 10_000;
  if (!Number.isSafeInteger(maxDurationMs) || maxDurationMs <= 0) throw new Error("ARCHIVE_OBJECT_REMOVAL_BUDGET_INVALID");
  const now = options.now ?? Date.now;
  const startedAt = now();
  const keys = await store.readPendingArchiveObjectDeletions(batchSize);
  if (keys.length > 0 && !fileStore) throw new Error("ARCHIVE_OBJECT_STORE_REQUIRED");
  let removed = 0;
  let failures = 0;
  for (const key of keys) {
    if (options.shouldStop?.() || now() - startedAt >= maxDurationMs) break;
    try {
      await fileStore!.remove(key);
      await store.completeArchiveObjectDeletion(key);
      removed += 1;
    } catch {
      failures += 1;
      console.error(JSON.stringify({ event: "clinical.archive_object_removal_failed", keyPrefix: keyPrefix(key) }));
      // An unavailable provider must not turn a batch into thousands of timeouts.
      break;
    }
  }
  return { removed, failures };
}

/** One tracked maintenance task; delivery never awaits it, shutdown always does. */
export function createClinicalArchiveMaintenance(onError: (error: unknown) => void | Promise<void>): { start: (work: () => Promise<void>) => void; close: () => Promise<void> } {
  let pending: Promise<void> | undefined;
  let closed = false;
  return {
    start(work) {
      if (closed || pending) return;
      pending = Promise.resolve().then(work).catch(async (error: unknown) => {
        // A failed logger also cannot create an unhandled background rejection.
        try { await onError(error); } catch { /* The task still settles and its durable intents remain. */ }
      }).finally(() => { pending = undefined; });
    },
    async close() {
      closed = true;
      await pending;
    }
  };
}

/**
 * Archives (and, once the legal period is configured, purges) on its own
 * cadence inside the worker. The attempt is recorded before the run so a
 * failure retries on the next cadence, not on every cycle. Object deletion
 * happens after the database commit. Failures remain in a durable queue and
 * fail this cycle; subsequent runs also drain previously committed intents.
 */
export async function runScheduledClinicalArchive(
  store: StateStore,
  schedule: ClinicalArchiveSchedule,
  options: { readonly fileStore?: ObjectRemover; readonly now?: () => number; readonly config?: ClinicalArchiveConfig; readonly deferObjectRemoval?: boolean } = {}
): Promise<boolean> {
  const config = options.config ?? clinicalArchiveConfig();
  const nowMs = (options.now ?? Date.now)();
  if (!schedule.shouldRun(nowMs)) return false;
  schedule.record(nowMs);
  const now = new Date(nowMs);
  if (!config.enabled) {
    if (options.deferObjectRemoval) return false;
    const objects = await removePendingArchiveObjects(store, options.fileStore);
    if (objects.failures > 0) throw new Error("ARCHIVE_OBJECT_REMOVAL_PENDING");
    return objects.removed > 0;
  }
  if (config.purgeAfterMonths && !options.fileStore) throw new Error("ARCHIVE_OBJECT_STORE_REQUIRED");
  const archived = await store.archiveClinicalRecords({ now, activeMonths: config.activeMonths, actor: "system:clinical-archive" });
  const purged = config.purgeAfterMonths
    ? await store.purgeClinicalArchive({ now, purgeAfterMonths: config.purgeAfterMonths })
    : undefined;
  const { removed: objectsRemoved, failures: objectRemovalFailures } = options.deferObjectRemoval
    ? { removed: 0, failures: 0 }
    : await removePendingArchiveObjects(store, options.fileStore);
  if (archived.requestsArchived > 0 || (purged?.requestsPurged ?? 0) > 0 || objectsRemoved > 0 || objectRemovalFailures > 0) {
    console.log(JSON.stringify({
      event: "clinical.archive_applied",
      requestsArchived: archived.requestsArchived,
      entitiesArchived: archived.entitiesArchived,
      attachmentsArchived: archived.attachmentsArchived,
      requestsPurged: purged?.requestsPurged ?? 0,
      entitiesPurged: purged?.entitiesPurged ?? 0,
      objectsRemoved,
      objectRemovalFailures
    }));
  }
  if (objectRemovalFailures > 0) throw new Error("ARCHIVE_OBJECT_REMOVAL_PENDING");
  return true;
}

export interface ArchiveCliOptions {
  readonly apply: boolean;
  readonly purge: boolean;
  readonly months?: number;
}

/** Arguments of scripts/clinical-archive.ts. */
export function parseArchiveArguments(args: readonly string[]): ArchiveCliOptions {
  let months: number | undefined;
  const monthsIndex = args.indexOf("--months");
  if (monthsIndex >= 0) {
    months = Number(args[monthsIndex + 1]);
    if (!Number.isSafeInteger(months) || months <= 0) throw new Error("--months exige um inteiro positivo.");
  }
  if (args.includes("--apply") && args.includes("--dry-run")) throw new Error("Use --dry-run ou --apply, não ambos.");
  return { apply: args.includes("--apply"), purge: args.includes("--purge"), months };
}

