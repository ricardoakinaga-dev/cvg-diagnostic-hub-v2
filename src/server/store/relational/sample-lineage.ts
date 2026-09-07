import type { DiagnosticItem, Sample, StoreState } from "../../domain/models";

export type RelationalSampleLinkStatus = "ACTIVE" | "REJECTED" | "REPLACED";

export interface RelationalSampleItemLink extends Readonly<Record<string, string | number | null>> {
  readonly id: string;
  readonly sample_id: string;
  readonly item_id: string;
  readonly request_id: string;
  readonly link_status: RelationalSampleLinkStatus;
  readonly linked_at: string;
  readonly linked_by: string | null;
  readonly rejection_note: string | null;
  readonly version: number;
}

interface RelationalVersionedProjection {
  readonly table: string;
  readonly id: string;
  readonly version: number;
  readonly expectedVersion?: number;
  readonly insertSql: string;
  readonly insertValues: readonly unknown[];
  readonly updateSql: string;
  readonly updateValues: readonly unknown[];
}

export function sampleLinkStatus(status: Sample["status"]): RelationalSampleLinkStatus {
  if (status === "REJECTED") return "REJECTED";
  if (status === "REPLACED") return "REPLACED";
  return "ACTIVE";
}

export function sampleTimestamp(sample: Sample, state: Pick<StoreState, "items">): string {
  const item = sample.itemIds
    .map((id) => state.items.find((candidate) => candidate.id === id))
    .find(Boolean);
  const timestamp = sample.receivedAt ?? sample.collectedAt ?? item?.requestedAt;
  if (!timestamp) throw new Error(`POSTGRES_RELATIONAL_UNMAPPABLE_STATE:samples.created_at:${sample.id}`);
  return timestamp;
}

export function sampleItemLink(
  sample: Sample,
  item: Pick<DiagnosticItem, "id" | "requestId" | "requestedAt">
): RelationalSampleItemLink {
  const linkedAt = sample.receivedAt ?? sample.collectedAt ?? item.requestedAt;
  return {
    id: `sample-item-link:${sample.id}:${item.id}`,
    sample_id: sample.id,
    item_id: item.id,
    request_id: sample.requestId,
    link_status: sampleLinkStatus(sample.status),
    linked_at: linkedAt,
    linked_by: sample.receivedBy ?? null,
    rejection_note: sample.rejectionNote ?? null,
    version: sample.version
  };
}

function sampleLinkProjection(
  current: RelationalSampleItemLink,
  previous?: RelationalSampleItemLink
): RelationalVersionedProjection {
  const values = [
    current.id,
    current.sample_id,
    current.item_id,
    current.request_id,
    current.link_status,
    current.linked_at,
    current.linked_by,
    current.rejection_note,
    current.version
  ];
  return {
    table: "sample_item_links",
    id: current.id,
    version: current.version,
    expectedVersion: previous?.version,
    insertSql: "INSERT INTO sample_item_links (id, sample_id, item_id, request_id, link_status, linked_at, linked_by, rejection_note, version) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id, version",
    insertValues: values,
    updateSql: "UPDATE sample_item_links SET sample_id = $2, item_id = $3, request_id = $4, link_status = $5, linked_at = $6, linked_by = $7, rejection_note = $8, version = $9 WHERE id = $1 AND version = $10 RETURNING id, version",
    updateValues: [...values, previous?.version]
  };
}

export function sampleLinkProjections(before: StoreState, after: StoreState): RelationalVersionedProjection[] {
  const beforeSamples = new Map(before.samples.map((sample) => [sample.id, sample]));
  const afterSamples = new Map(after.samples.map((sample) => [sample.id, sample]));
  const beforeItems = new Map(before.items.map((item) => [item.id, item]));
  const items = new Map(after.items.map((item) => [item.id, item]));
  const writes: RelationalVersionedProjection[] = [];
  for (const sample of afterSamples.values()) {
    const previous = beforeSamples.get(sample.id);
    const priorItemIds = new Set(previous?.itemIds ?? []);
    for (const itemId of sample.itemIds) {
      const item = items.get(itemId);
      if (!item || item.requestId !== sample.requestId) {
        throw new Error(`POSTGRES_RELATIONAL_UNMAPPABLE_STATE:sample_item_links:${sample.id}`);
      }
      const currentLink = sampleItemLink(sample, item);
      if (!previous || !priorItemIds.has(itemId)) {
        if (previous) throw new Error(`POSTGRES_RELATIONAL_LINK_ADDITION_UNSUPPORTED:${sample.id}:${itemId}`);
        writes.push(sampleLinkProjection(currentLink));
        continue;
      }
      const previousItem = beforeItems.get(itemId) ?? item;
      const previousLink = sampleItemLink(previous, previousItem);
      if (JSON.stringify(previousLink) !== JSON.stringify(currentLink)) writes.push(sampleLinkProjection(currentLink, previousLink));
    }
    for (const priorItemId of priorItemIds) {
      if (!sample.itemIds.includes(priorItemId)) {
        throw new Error(`POSTGRES_RELATIONAL_LINK_REMOVAL_UNSUPPORTED:${sample.id}:${priorItemId}`);
      }
    }
  }
  for (const previous of beforeSamples.values()) {
    if (!afterSamples.has(previous.id)) throw new Error(`POSTGRES_RELATIONAL_DELETION_UNSUPPORTED:samples:${previous.id}`);
  }
  return writes;
}
