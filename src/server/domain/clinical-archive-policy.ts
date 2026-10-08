import { ARCHIVED_COLLECTIONS, type ArchivedCollection, type Attachment, type DiagnosticItem, type Notification, type StoreState } from "./models";

/**
 * Archive policy (PROD-501, decision D5): a request whose work is finished
 * leaves the active aggregate after `activeMonths`, keeping memory and the
 * snapshot bounded. The functions are pure: the stores decide where the
 * archived entities go.
 */
export const DEFAULT_ARCHIVE_ACTIVE_MONTHS = 24;

const ARCHIVABLE_AGGREGATE_STATUSES = new Set(["COMPLETED", "CANCELLED"]);
const TERMINAL_ITEM_STATUSES = new Set(["COMPLETED", "CANCELLED", "REJECTED"]);
/** A notification still travelling to or waiting on a person keeps its request active. */
const OPEN_NOTIFICATION_STATES = new Set(["PENDING", "DELIVERED", "SEEN", "ESCALATED"]);

export interface ArchivePolicyOptions {
  readonly now: Date;
  readonly activeMonths: number;
}

export interface ArchivedEntity {
  readonly requestId: string;
  readonly collection: ArchivedCollection;
  readonly entityKey: string;
  /** 1-based index in the original collection; keeps the order on read. */
  readonly position: number;
  readonly entity: { readonly id: string };
}

export interface ArchivePartition {
  /** The active state without the archived entities; untouched arrays are shared. */
  readonly state: StoreState;
  readonly entities: readonly ArchivedEntity[];
  readonly requestIds: readonly string[];
  readonly attachmentCount: number;
}

/** Calendar-month subtraction in UTC. */
export function archiveCutoff(now: Date, activeMonths: number): Date {
  const cutoff = new Date(now.getTime());
  cutoff.setUTCMonth(cutoff.getUTCMonth() - activeMonths);
  return cutoff;
}

/** Everything that hangs off a request, resolved once for the whole state. */
interface RequestIndex {
  readonly itemsByRequest: Map<string, DiagnosticItem[]>;
  readonly requestOfItem: Map<string, string>;
  readonly requestOfResult: Map<string, string>;
  readonly requestOfVersion: Map<string, string>;
}

function groupBy<T>(entries: readonly T[], keyOf: (entry: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const entry of entries) {
    const key = keyOf(entry);
    const bucket = groups.get(key);
    if (bucket) bucket.push(entry); else groups.set(key, [entry]);
  }
  return groups;
}

function requestIndex(state: StoreState): RequestIndex {
  const itemsByRequest = groupBy(state.items, (item) => item.requestId);
  const requestOfItem = new Map(state.items.map((item) => [item.id, item.requestId]));
  const requestOfResult = new Map<string, string>();
  for (const result of state.results) {
    const requestId = requestOfItem.get(result.itemId);
    if (requestId !== undefined) requestOfResult.set(result.id, requestId);
  }
  const requestOfVersion = new Map<string, string>();
  for (const version of state.resultVersions) {
    const requestId = requestOfResult.get(version.resultId);
    if (requestId !== undefined) requestOfVersion.set(version.id, requestId);
  }
  return { itemsByRequest, requestOfItem, requestOfResult, requestOfVersion };
}

function requestOfNotification(notification: Notification, index: RequestIndex, requestOfSample: Map<string, string>): string | undefined {
  switch (notification.entityType) {
    case "REQUEST": return notification.entityId;
    case "ITEM": return index.requestOfItem.get(notification.entityId);
    case "RESULT_VERSION": return index.requestOfVersion.get(notification.entityId);
    case "SAMPLE": return requestOfSample.get(notification.entityId);
  }
}

function requestOfAttachment(attachment: Attachment, index: RequestIndex): string | undefined {
  return index.requestOfVersion.get(attachment.resultVersionId);
}

/** Milliseconds, or undefined when the value is missing or not a date. */
function instant(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export function selectArchivableRequests(state: StoreState, options: ArchivePolicyOptions): string[] {
  if (!Number.isSafeInteger(options.activeMonths) || options.activeMonths <= 0) return [];
  const cutoffMs = archiveCutoff(options.now, options.activeMonths).getTime();
  const index = requestIndex(state);
  const requestOfSample = new Map(state.samples.map((sample) => [sample.id, sample.requestId]));
  const blocked = new Set<string>();
  for (const notification of state.notifications) {
    if (!OPEN_NOTIFICATION_STATES.has(notification.state)) continue;
    const requestId = requestOfNotification(notification, index, requestOfSample);
    if (requestId !== undefined) blocked.add(requestId);
  }
  for (const attachment of state.attachments) {
    if (attachment.uploadStatus === "FINALIZED") continue;
    const requestId = requestOfAttachment(attachment, index);
    if (requestId !== undefined) blocked.add(requestId);
  }
  // Any version written inside the window (an amendment, a late draft) keeps the request active.
  const newestVersionMs = new Map<string, number>();
  const draftResultIds = new Set<string>();
  for (const version of state.resultVersions) {
    if (version.status === "DRAFT") draftResultIds.add(version.resultId);
    const requestId = index.requestOfVersion.get(version.id);
    if (requestId === undefined) continue;
    const created = instant(version.createdAt);
    const released = instant(version.releasedAt);
    if (created === undefined || (version.releasedAt !== undefined && released === undefined)) {
      blocked.add(requestId);
      continue;
    }
    newestVersionMs.set(requestId, Math.max(newestVersionMs.get(requestId) ?? 0, created, released ?? 0));
  }
  const resultsByItem = groupBy(state.results, (result) => result.itemId);

  const selected: string[] = [];
  for (const request of state.requests) {
    if (!ARCHIVABLE_AGGREGATE_STATUSES.has(request.aggregateStatus) || blocked.has(request.id)) continue;
    const updatedMs = instant(request.updatedAt);
    if (updatedMs === undefined || updatedMs >= cutoffMs) continue;
    if ((newestVersionMs.get(request.id) ?? 0) >= cutoffMs) continue;
    const items = index.itemsByRequest.get(request.id) ?? [];
    if (items.length === 0 || items.length !== new Set(request.itemIds).size || !request.itemIds.every((id) => index.requestOfItem.get(id) === request.id)) continue;
    const settled = items.every((item) => {
      if (item.status === "RESULT_VOIDED") {
        const results = resultsByItem.get(item.id) ?? [];
        // Voided is final only when every result of the item is voided and no newer draft waits.
        if (results.length === 0 || results.some((result) => result.lifecycleStatus !== "VOIDED" || draftResultIds.has(result.id))) return false;
      } else if (!TERMINAL_ITEM_STATUSES.has(item.status)) {
        return false;
      }
      if (item.completedAt === undefined) return true;
      const completedMs = instant(item.completedAt);
      return completedMs !== undefined && completedMs < cutoffMs;
    });
    if (settled) selected.push(request.id);
  }
  return selected;
}

/**
 * Splits the aggregate for the requests to archive. Patients, encounters,
 * admissions, users, services, reason codes, sessions and idempotency records
 * are never archived. Order is preserved in both halves.
 */
export function partitionArchive(state: StoreState, requestIds: readonly string[]): ArchivePartition {
  const wanted = new Set(requestIds);
  const present = state.requests.filter((request) => wanted.has(request.id)).map((request) => request.id);
  const chosen = new Set(present);
  const index = requestIndex(state);
  const requestOfSample = new Map(state.samples.map((sample) => [sample.id, sample.requestId]));
  const itemOfProcedure = new Map(state.procedures.map((procedure) => [procedure.id, procedure.itemId]));
  const requestOfEntity: Record<ArchivedCollection, (entity: never) => string | undefined> = {
    requests: (entity: { id: string }) => entity.id,
    items: (entity: { requestId: string }) => entity.requestId,
    samples: (entity: { requestId: string }) => entity.requestId,
    procedures: (entity: { itemId: string }) => index.requestOfItem.get(entity.itemId),
    schedules: (entity: { procedureId: string }) => {
      const itemId = itemOfProcedure.get(entity.procedureId);
      return itemId === undefined ? undefined : index.requestOfItem.get(itemId);
    },
    results: (entity: { id: string }) => index.requestOfResult.get(entity.id),
    resultVersions: (entity: { id: string }) => index.requestOfVersion.get(entity.id),
    notifications: (entity: Notification) => requestOfNotification(entity, index, requestOfSample),
    attachments: (entity: Attachment) => requestOfAttachment(entity, index)
  };

  const entities: ArchivedEntity[] = [];
  const next: Record<string, unknown> = { ...state };
  let attachmentCount = 0;
  for (const collection of ARCHIVED_COLLECTIONS) {
    const source = state[collection] as readonly { id: string }[];
    const resolve = requestOfEntity[collection] as (entity: { id: string }) => string | undefined;
    const kept: { id: string }[] = [];
    source.forEach((entity, position) => {
      const requestId = resolve(entity);
      if (requestId !== undefined && chosen.has(requestId)) {
        entities.push({ requestId, collection, entityKey: entity.id, position: position + 1, entity });
        if (collection === "attachments") attachmentCount += 1;
      } else {
        kept.push(entity);
      }
    });
    // Share the original array when nothing left it, so the entity diff sees no change.
    if (kept.length !== source.length) next[collection] = kept;
  }
  return { state: next as unknown as StoreState, entities, requestIds: present, attachmentCount };
}
