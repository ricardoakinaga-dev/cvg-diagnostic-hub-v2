import type { DiagnosticItem, DiagnosticRequest, Encounter, IdempotencyRecord, Notification, Result, ResultVersion, Sample, Session, StoreState } from "./models";

/**
 * Indexed lookups over the shared, frozen runtime snapshot.
 *
 * Read paths used to resolve every reference with a linear `.find`, so listing
 * requests cost O(items x requests): the 2026-10-07 profile measured ~37 s of
 * CPU for one request list at six months of data (27k exams). A frozen array
 * can never change, so its index is built once and lives exactly as long as
 * the array (WeakMap). A write replaces only the arrays it touched and the
 * untouched collections keep their index.
 *
 * Arrays still being assembled inside a transaction are not frozen. They fall
 * back to a scan, so every helper returns exactly what `.find`/`.filter` would:
 * the first match by array order, and groups in array order.
 */

type Identified = { readonly id: string };
type GroupName = "itemsByRequest" | "requestsByPatient" | "encountersByPatient" | "samplesByItem" | "resultsByItem" | "resultVersionsByResult" | "notificationsByDedupe" | "idempotencyByKey" | "sessionsByTokenHash";

const EMPTY: readonly never[] = Object.freeze([]);
const idIndexes = new WeakMap<readonly Identified[], ReadonlyMap<string, number>>();
const groupIndexes = new WeakMap<readonly object[], Map<GroupName, ReadonlyMap<string, readonly object[]>>>();

/** Position of the first entry with this id, or -1, like `findIndex`. */
export function positionOfId(entries: readonly Identified[], id: string | undefined): number {
  if (id === undefined) return -1;
  if (!Object.isFrozen(entries)) return entries.findIndex((entry) => entry.id === id);
  let index = idIndexes.get(entries);
  if (!index) {
    const built = new Map<string, number>();
    entries.forEach((entry, position) => {
      if (!built.has(entry.id)) built.set(entry.id, position);
    });
    idIndexes.set(entries, built);
    index = built;
  }
  return index.get(id) ?? -1;
}

export function findById<T extends Identified>(entries: readonly T[], id: string | undefined): T | undefined {
  const position = positionOfId(entries, id);
  return position < 0 ? undefined : entries[position];
}

function grouped<T extends object>(entries: readonly T[], name: GroupName, keysOf: (entry: T) => readonly string[], key: string): readonly T[] {
  if (!Object.isFrozen(entries)) return entries.filter((entry) => keysOf(entry).includes(key));
  let byName = groupIndexes.get(entries);
  if (!byName) {
    byName = new Map();
    groupIndexes.set(entries, byName);
  }
  let index = byName.get(name) as ReadonlyMap<string, readonly T[]> | undefined;
  if (!index) {
    const built = new Map<string, T[]>();
    for (const entry of entries) {
      for (const entryKey of new Set(keysOf(entry))) {
        const bucket = built.get(entryKey);
        if (bucket) bucket.push(entry); else built.set(entryKey, [entry]);
      }
    }
    for (const bucket of built.values()) Object.freeze(bucket);
    byName.set(name, built);
    index = built;
  }
  return index.get(key) ?? EMPTY;
}

const compositeKey = (...parts: readonly string[]): string => JSON.stringify(parts);

export function itemsForRequest(state: Pick<StoreState, "items">, requestId: string): readonly DiagnosticItem[] {
  return grouped(state.items, "itemsByRequest", (item) => [item.requestId], requestId);
}

export function requestsForPatient(state: Pick<StoreState, "requests">, patientId: string): readonly DiagnosticRequest[] {
  return grouped(state.requests, "requestsByPatient", (request) => [request.patientId], patientId);
}

export function encountersForPatient(state: Pick<StoreState, "encounters">, patientId: string): readonly Encounter[] {
  return grouped(state.encounters, "encountersByPatient", (encounter) => [encounter.patientId], patientId);
}

export function samplesForItem(state: Pick<StoreState, "samples">, itemId: string): readonly Sample[] {
  return grouped(state.samples, "samplesByItem", (sample) => sample.itemIds, itemId);
}

export function resultsForItem(state: Pick<StoreState, "results">, itemId: string): readonly Result[] {
  return grouped(state.results, "resultsByItem", (result) => [result.itemId], itemId);
}

export function resultVersionsForResult(state: Pick<StoreState, "resultVersions">, resultId: string): readonly ResultVersion[] {
  return grouped(state.resultVersions, "resultVersionsByResult", (version) => [version.resultId], resultId);
}

export function notificationForDedupe(state: Pick<StoreState, "notifications">, recipientUserId: string, dedupeKey: string): Notification | undefined {
  return grouped(state.notifications, "notificationsByDedupe", (notification) => [compositeKey(notification.recipientUserId, notification.dedupeKey)], compositeKey(recipientUserId, dedupeKey))[0];
}

export function idempotencyRecordFor(state: Pick<StoreState, "idempotency">, actorId: string, scope: string, key: string): IdempotencyRecord | undefined {
  return grouped(state.idempotency, "idempotencyByKey", (record) => [compositeKey(record.actorId, record.scope, record.key)], compositeKey(actorId, scope, key))[0];
}

export function sessionForTokenHash(state: Pick<StoreState, "sessions">, tokenHash: string): Session | undefined {
  return grouped(state.sessions, "sessionsByTokenHash", (session) => [session.tokenHash], tokenHash)[0];
}
