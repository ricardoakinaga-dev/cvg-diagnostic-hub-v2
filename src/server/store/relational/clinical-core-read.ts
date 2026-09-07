import type { RelationalClinicalRequestRead } from "./clinical-core-contracts";

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function record(value: unknown, errorCode: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(errorCode);
  return value;
}

function text(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`POSTGRES_RELATIONAL_UNMAPPABLE_STATE:${field}`);
  }
  return value;
}

function textArray(value: unknown, field: string): readonly string[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`POSTGRES_RELATIONAL_READ_LINEAGE_MISMATCH:${field}`);
  }
  const values = value.map((entry) => text(entry, field));
  if (new Set(values).size !== values.length) {
    throw new Error(`POSTGRES_RELATIONAL_READ_LINEAGE_MISMATCH:${field}`);
  }
  return values;
}

function positiveVersion(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1) {
    throw new Error(`POSTGRES_RELATIONAL_READ_LINEAGE_MISMATCH:${field}`);
  }
  return Number(value);
}

function nullable(value: unknown): string | null {
  return value === undefined || value === null ? null : text(value, "relational_nullable_text");
}

function sampleStatus(value: unknown, sampleId: string): "EXPECTED" | "RECEIVED" | "REJECTED" | "REPLACED" {
  const status = text(value, `relational_samples.status:${sampleId}`);
  if (!["EXPECTED", "RECEIVED", "REJECTED", "REPLACED"].includes(status)) {
    throw new Error(`POSTGRES_RELATIONAL_READ_LINEAGE_MISMATCH:${sampleId}:status`);
  }
  return status as "EXPECTED" | "RECEIVED" | "REJECTED" | "REPLACED";
}

function expectedLinkStatus(status: ReturnType<typeof sampleStatus>): "ACTIVE" | "REJECTED" | "REPLACED" {
  if (status === "REJECTED") return "REJECTED";
  if (status === "REPLACED") return "REPLACED";
  return "ACTIVE";
}

function lineageMismatch(id: string, field: string): never {
  throw new Error(`POSTGRES_RELATIONAL_READ_LINEAGE_MISMATCH:${id}:${field}`);
}

function assertSampleLineage(
  samples: readonly Readonly<Record<string, unknown>>[],
  items: readonly Readonly<Record<string, unknown>>[],
  links: readonly Readonly<Record<string, unknown>>[],
  expectedRequestId: string
): void {
  if (samples.length === 0 && links.length === 0) return;
  const samplesById = new Map<string, Readonly<Record<string, unknown>>>();
  const itemsById = new Map<string, Readonly<Record<string, unknown>>>();
  const itemIdsBySample = new Map<string, readonly string[]>();
  const accessions = new Set<string>();

  for (const item of items) {
    const itemId = text(item.id, "relational_items.id");
    const itemRequestId = text(item.request_id, `relational_items.request_id:${itemId}`);
    if (itemRequestId !== expectedRequestId) lineageMismatch(itemId, "request_id");
    itemsById.set(itemId, item);
  }

  for (const sample of samples) {
    const sampleId = text(sample.id, "relational_samples.id");
    const sampleRequestId = text(sample.request_id, `relational_samples.request_id:${sampleId}`);
    if (sampleRequestId !== expectedRequestId) lineageMismatch(sampleId, "request_id");
    const accessionCode = text(sample.accession_code, `relational_samples.accession_code:${sampleId}`);
    if (accessions.has(accessionCode)) lineageMismatch(sampleId, "accession_code");
    accessions.add(accessionCode);
    const status = sampleStatus(sample.status, sampleId);
    const version = positiveVersion(sample.version, `relational_samples.version:${sampleId}`);
    const itemIds = textArray(sample.item_ids, `relational_samples.item_ids:${sampleId}`);
    for (const itemId of itemIds) {
      if (!itemsById.has(itemId)) lineageMismatch(sampleId, `item_ids:${itemId}`);
    }
    if ((status === "REJECTED" || status === "REPLACED") && nullable(sample.rejection_reason_id) === null) {
      lineageMismatch(sampleId, "rejection_reason_id");
    }
    if (samplesById.has(sampleId)) lineageMismatch(sampleId, "id");
    samplesById.set(sampleId, sample);
    itemIdsBySample.set(sampleId, itemIds);
    positiveVersion(version, `relational_samples.version:${sampleId}`);
  }

  for (const sample of samples) {
    const sampleId = text(sample.id, "relational_samples.id");
    const predecessorId = nullable(sample.replaces_sample_id);
    if (predecessorId === null) continue;
    const visited = new Set<string>();
    let cursor: Readonly<Record<string, unknown>> | undefined = sample;
    while (cursor) {
      const cursorId = text(cursor.id, "relational_samples.id");
      if (visited.has(cursorId)) throw new Error(`POSTGRES_RELATIONAL_READ_CYCLE:samples:${sampleId}`);
      visited.add(cursorId);
      const nextId = nullable(cursor.replaces_sample_id);
      if (nextId === null) break;
      const next = samplesById.get(nextId);
      if (!next) lineageMismatch(sampleId, "replaces_sample_id");
      if (text(next.request_id, `relational_samples.request_id:${nextId}`) !== text(sample.request_id, `relational_samples.request_id:${sampleId}`)) {
        lineageMismatch(sampleId, "replaces_sample_id");
      }
      cursor = next;
    }
  }

  const linkedPairs = new Set<string>();
  for (const link of links) {
    const linkId = text(link.id, "relational_sample_item_links.id");
    const sampleId = text(link.sample_id, `relational_sample_item_links.sample_id:${linkId}`);
    const itemId = text(link.item_id, `relational_sample_item_links.item_id:${linkId}`);
    const sample = samplesById.get(sampleId);
    const item = itemsById.get(itemId);
    if (!sample || !item) lineageMismatch(linkId, "foreign_key");
    const expectedItemIds = itemIdsBySample.get(sampleId);
    if (!expectedItemIds?.includes(itemId)) lineageMismatch(linkId, "item_ids");
    const requestId = text(link.request_id, `relational_sample_item_links.request_id:${linkId}`);
    if (requestId !== expectedRequestId || requestId !== text(sample.request_id, `relational_samples.request_id:${sampleId}`) || requestId !== text(item.request_id, `relational_items.request_id:${itemId}`)) {
      lineageMismatch(linkId, "request_id");
    }
    const pair = `${sampleId}:${itemId}`;
    if (linkedPairs.has(pair)) lineageMismatch(linkId, "sample_item_pair");
    linkedPairs.add(pair);
    const status = sampleStatus(sample.status, sampleId);
    if (text(link.link_status, `relational_sample_item_links.link_status:${linkId}`) !== expectedLinkStatus(status)) lineageMismatch(linkId, "link_status");
    if (positiveVersion(link.version, `relational_sample_item_links.version:${linkId}`) !== positiveVersion(sample.version, `relational_samples.version:${sampleId}`)) lineageMismatch(linkId, "version");
    const expectedLinkedAt = text(sample.received_at ?? sample.collected_at ?? item.requested_at, `relational_sample_item_links.linked_at:${linkId}`);
    if (text(link.linked_at, `relational_sample_item_links.linked_at:${linkId}`) !== expectedLinkedAt) lineageMismatch(linkId, "linked_at");
    if (nullable(link.linked_by) !== nullable(sample.received_by)) lineageMismatch(linkId, "linked_by");
    if (nullable(link.rejection_note) !== nullable(sample.rejection_note)) lineageMismatch(linkId, "rejection_note");
  }
  for (const sample of samples) {
    const sampleId = text(sample.id, "relational_samples.id");
    const expectedItemIds = itemIdsBySample.get(sampleId) ?? [];
    for (const itemId of expectedItemIds) {
      if (!linkedPairs.has(`${sampleId}:${itemId}`)) lineageMismatch(sampleId, `sample_item_links:${itemId}`);
    }
  }
}

export function readRelationalAggregate(value: unknown, expectedRequestId: string): RelationalClinicalRequestRead {
  const aggregate = record(value, "POSTGRES_RELATIONAL_READ_INVALID");
  const request = record(aggregate.request, "POSTGRES_RELATIONAL_READ_INVALID_REQUEST");
  const requestRowId = text(request.id, "relational_request.id");
  if (requestRowId !== expectedRequestId) throw new Error("POSTGRES_RELATIONAL_READ_REQUEST_MISMATCH");
  const array = (key: string): readonly Readonly<Record<string, unknown>>[] => {
    const values = aggregate[key];
    if (!Array.isArray(values) || values.some((entry) => !isRecord(entry))) {
      throw new Error(`POSTGRES_RELATIONAL_READ_INVALID:${key}`);
    }
    const ids = new Set<string>();
    for (const entry of values) {
      const id = text(entry.id, `relational_${key}.id`);
      if (ids.has(id)) throw new Error(`POSTGRES_RELATIONAL_READ_DUPLICATE:${key}:${id}`);
      ids.add(id);
      const rowRequestId = entry.request_id;
      if (typeof rowRequestId === "string" && rowRequestId !== expectedRequestId) {
        throw new Error(`POSTGRES_RELATIONAL_READ_SCOPE_MISMATCH:${key}:${id}`);
      }
    }
    return values as readonly Readonly<Record<string, unknown>>[];
  };
  const items = array("items");
  const samples = array("samples");
  const sampleItemLinks = array("sampleItemLinks");
  assertSampleLineage(samples, items, sampleItemLinks, expectedRequestId);
  return {
    request,
    items,
    samples,
    sampleItemLinks,
    procedures: array("procedures"),
    schedules: array("schedules"),
    results: array("results"),
    resultVersions: array("resultVersions"),
    attachments: array("attachments"),
    notifications: array("notifications")
  };
}
