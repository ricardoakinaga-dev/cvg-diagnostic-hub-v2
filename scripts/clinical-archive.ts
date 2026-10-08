import { clinicalArchiveConfig, parseArchiveArguments, removeArchivedObjects } from "../src/server/operations/clinical-archive-job";
import { closeRuntimeStore, getRuntimeFileStore, getRuntimeStoreAsync } from "../src/server/store/runtime";

/**
 * On-demand clinical archive (PROD-501, D5). Default is a dry run that prints
 * what would move; --apply archives, --purge also deletes archive rows past the
 * legal period (and their stored attachments). --months overrides
 * ARCHIVE_ACTIVE_MONTHS for this run.
 */
async function main(): Promise<void> {
  const options = parseArchiveArguments(process.argv.slice(2));
  const config = clinicalArchiveConfig();
  if (options.purge && !config.purgeAfterMonths) {
    throw new Error("--purge exige ARCHIVE_PURGE_AFTER_MONTHS (prazo legal definido pelo jurídico).");
  }
  const store = await getRuntimeStoreAsync();
  const now = new Date();
  const archive = await store.archiveClinicalRecords({ now, activeMonths: options.months ?? config.activeMonths, dryRun: !options.apply, actor: "system:clinical-archive-cli" });
  const purge = options.purge
    ? await store.purgeClinicalArchive({ now, purgeAfterMonths: config.purgeAfterMonths, dryRun: !options.apply })
    : undefined;
  const objects = purge && options.apply ? await removeArchivedObjects(getRuntimeFileStore(), purge.attachmentKeys) : { removed: 0, failures: 0 };
  console.log(JSON.stringify({
    event: "clinical.archive_completed",
    mode: options.apply ? "apply" : "dry-run",
    archive,
    ...(purge ? { purge: { requestsPurged: purge.requestsPurged, entitiesPurged: purge.entitiesPurged, attachmentObjects: purge.attachmentKeys.length, objectsRemoved: objects.removed, objectRemovalFailures: objects.failures } } : {})
  }, null, 2));
}

void main()
  .catch((error: unknown) => {
    console.error(JSON.stringify({ event: "clinical.archive_failed", errorCode: "CLINICAL_ARCHIVE_FAILED", message: error instanceof Error ? error.message : "CLINICAL_ARCHIVE_FAILED" }));
    process.exitCode = 1;
  })
  .finally(async () => { await closeRuntimeStore(); });
