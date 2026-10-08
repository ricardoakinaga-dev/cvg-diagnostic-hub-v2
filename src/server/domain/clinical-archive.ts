import { randomUUID } from "node:crypto";
import {
  type ArchivedCollection,
  type AuditEvent,
  type ClinicalArchiveEntry,
  type ClinicalArchiveOptions,
  type ClinicalArchivePurgeSummary,
  type ClinicalArchiveRow,
  type ClinicalArchiveSummary,
  type DiagnosticService,
  type StoreState
} from "./models";
import {
  archiveCutoff,
  DEFAULT_ARCHIVE_ACTIVE_MONTHS,
  partitionArchive,
  selectArchivableRequests,
  type ArchivePartition
} from "./clinical-archive-policy";

/** Shared by both stores so memory and PostgreSQL archive exactly the same things. */
export interface ClinicalArchivePlan {
  readonly cutoff: Date;
  readonly partition: ArchivePartition;
}

export function planClinicalArchive(state: StoreState, options: ClinicalArchiveOptions = {}): ClinicalArchivePlan {
  const now = options.now ?? new Date();
  const activeMonths = options.activeMonths ?? DEFAULT_ARCHIVE_ACTIVE_MONTHS;
  const requestIds = selectArchivableRequests(state, { now, activeMonths });
  return { cutoff: archiveCutoff(now, activeMonths), partition: partitionArchive(state, requestIds) };
}

export function archiveSummary(plan: ClinicalArchivePlan, batchId?: string): ClinicalArchiveSummary {
  return {
    ...(batchId ? { batchId } : {}),
    cutoff: plan.cutoff.toISOString(),
    requestsArchived: plan.partition.requestIds.length,
    entitiesArchived: plan.partition.entities.length,
    attachmentsArchived: plan.partition.attachmentCount,
    requestIds: plan.partition.requestIds
  };
}

export function newArchiveBatchId(now: Date): string {
  return `archive-${now.getTime()}-${randomUUID()}`;
}

export function archiveRows(plan: ClinicalArchivePlan, batchId: string, archivedAt: Date): ClinicalArchiveRow[] {
  return plan.partition.entities.map((archived) => ({
    requestId: archived.requestId,
    collection: archived.collection,
    entityKey: archived.entityKey,
    position: archived.position,
    data: archived.entity as unknown as Record<string, unknown>,
    archivedAt: archivedAt.toISOString(),
    archiveBatch: batchId
  }));
}

/** Counts only: the batch table holds the requests, the audit trail never lists them. */
export function archiveAuditEvent(summary: ClinicalArchiveSummary & { batchId: string }, now: Date, actor?: string): AuditEvent {
  return {
    id: `audit-clinical-archive-${now.getTime()}-${randomUUID()}`,
    eventType: "ClinicalRecordsArchived",
    ...(actor ? { actorId: actor } : {}),
    entityType: "ClinicalArchive",
    entityId: summary.batchId,
    previousState: "ACTIVE",
    newState: "ARCHIVED",
    correlationId: `corr-clinical-archive-${randomUUID()}`,
    metadata: {
      requestsArchived: summary.requestsArchived,
      entitiesArchived: summary.entitiesArchived,
      attachmentsArchived: summary.attachmentsArchived,
      cutoff: summary.cutoff
    },
    occurredAt: now.toISOString()
  };
}

export function purgeAuditEvent(summary: ClinicalArchivePurgeSummary, now: Date): AuditEvent {
  return {
    id: `audit-clinical-archive-purge-${now.getTime()}-${randomUUID()}`,
    eventType: "ClinicalArchivePurged",
    entityType: "ClinicalArchive",
    entityId: "cvg-clinical-archive",
    previousState: "ARCHIVED",
    newState: "PURGED",
    correlationId: `corr-clinical-archive-purge-${randomUUID()}`,
    metadata: {
      requestsPurged: summary.requestsPurged,
      entitiesPurged: summary.entitiesPurged,
      attachmentsPurged: summary.attachmentKeys.length
    },
    occurredAt: now.toISOString()
  };
}

/** Months after archiving; anything but a positive integer means "never purge". */
export function purgeCutoff(now: Date, purgeAfterMonths: number | undefined): Date | undefined {
  if (purgeAfterMonths === undefined || !Number.isSafeInteger(purgeAfterMonths) || purgeAfterMonths <= 0) return undefined;
  return archiveCutoff(now, purgeAfterMonths);
}

/** The archived entities of one collection, in their original order. */
export function archivedEntitiesOf<T>(rows: readonly ClinicalArchiveRow[], collection: ArchivedCollection): T[] {
  return rows.filter((row) => row.collection === collection).sort((left, right) => left.position - right.position).map((row) => row.data as T);
}

interface ArchivedRequestShape { id: string; requestCode: string; patientId: string; encounterId: string; requestingDepartmentCode: string; updatedAt: string }
interface ArchivedItemShape { serviceId: string; departmentCode: string; completedAt?: string }

/** Summaries newest first (request updatedAt, then id); rows of several requests may be mixed. */
export function archiveEntries(rows: readonly ClinicalArchiveRow[], services: readonly DiagnosticService[]): ClinicalArchiveEntry[] {
  const byRequest = new Map<string, ClinicalArchiveRow[]>();
  for (const row of rows) {
    const bucket = byRequest.get(row.requestId);
    if (bucket) bucket.push(row); else byRequest.set(row.requestId, [row]);
  }
  const serviceById = new Map(services.map((service) => [service.id, service]));
  const entries: { entry: ClinicalArchiveEntry; updatedAt: string }[] = [];
  for (const [requestId, group] of byRequest) {
    const request = archivedEntitiesOf<ArchivedRequestShape>(group, "requests")[0];
    if (!request) continue;
    const items = archivedEntitiesOf<ArchivedItemShape>(group, "items");
    const seen = new Set<string>();
    const archivedServices: ClinicalArchiveEntry["services"] = [];
    for (const item of items) {
      if (seen.has(item.serviceId)) continue;
      seen.add(item.serviceId);
      const service = serviceById.get(item.serviceId);
      archivedServices.push({ code: service?.code ?? item.serviceId, name: service?.name ?? item.serviceId, departmentCode: item.departmentCode });
    }
    const completedAt = items.reduce((latest, item) => (item.completedAt && item.completedAt > latest ? item.completedAt : latest), request.updatedAt);
    entries.push({ updatedAt: request.updatedAt, entry: {
      requestId,
      requestCode: request.requestCode,
      patientId: request.patientId,
      encounterId: request.encounterId,
      requestingDepartmentCode: request.requestingDepartmentCode,
      archivedAt: group[0].archivedAt,
      completedAt,
      services: archivedServices,
      attachmentCount: group.filter((row) => row.collection === "attachments").length
    } });
  }
  return entries
    .sort((left, right) => (left.updatedAt === right.updatedAt ? left.entry.requestId.localeCompare(right.entry.requestId) : left.updatedAt < right.updatedAt ? 1 : -1))
    .map(({ entry }) => entry);
}
