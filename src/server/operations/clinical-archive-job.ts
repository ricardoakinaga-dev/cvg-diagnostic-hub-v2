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

/**
 * Archives (and, once the legal period is configured, purges) on its own
 * cadence inside the worker. The attempt is recorded before the run so a
 * failure retries on the next cadence, not on every cycle. Object deletion
 * happens after the database commit and never fails the job.
 */
export async function runScheduledClinicalArchive(
  store: StateStore,
  schedule: ClinicalArchiveSchedule,
  options: { readonly fileStore?: ObjectRemover; readonly now?: () => number; readonly config?: ClinicalArchiveConfig } = {}
): Promise<boolean> {
  const config = options.config ?? clinicalArchiveConfig();
  if (!config.enabled) return false;
  const nowMs = (options.now ?? Date.now)();
  if (!schedule.shouldRun(nowMs)) return false;
  schedule.record(nowMs);
  const now = new Date(nowMs);
  const archived = await store.archiveClinicalRecords({ now, activeMonths: config.activeMonths, actor: "system:clinical-archive" });
  const purged = config.purgeAfterMonths
    ? await store.purgeClinicalArchive({ now, purgeAfterMonths: config.purgeAfterMonths })
    : undefined;
  const { removed: objectsRemoved, failures: objectRemovalFailures } = await removeArchivedObjects(options.fileStore, purged?.attachmentKeys ?? []);
  if (archived.requestsArchived > 0 || (purged?.requestsPurged ?? 0) > 0) {
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

