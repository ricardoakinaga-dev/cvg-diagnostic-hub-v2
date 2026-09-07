import { createHash } from "node:crypto";
import type { StoreState } from "../../domain/models";
import type { RelationalClinicalRequestRead } from "./clinical-core-contracts";
import { sampleItemLink } from "./sample-lineage";

/**
 * Runtime authority is deliberately explicit. `SNAPSHOT` is the only
 * authority currently wired into PostgresStore; `SHADOW` permits dual-write
 * and comparison probes; `RELATIONAL` is a guarded future state.
 */
export type RelationalAuthorityMode = "SNAPSHOT" | "SHADOW" | "RELATIONAL";

export const RELATIONAL_CUTOVER_GATES = [
  "schemaReady",
  "backfillComplete",
  "reconciliationClean",
  "relationalReadReady",
  "relationalWriteReady",
  "transactionAtomic",
  "rollbackVerified",
  "operationalApproval"
] as const;

export type RelationalCutoverGate = (typeof RELATIONAL_CUTOVER_GATES)[number];

export interface RelationalCutoverEvidence {
  readonly schemaReady: boolean;
  readonly backfillComplete: boolean;
  readonly reconciliationClean: boolean;
  readonly relationalReadReady: boolean;
  readonly relationalWriteReady: boolean;
  readonly transactionAtomic: boolean;
  readonly rollbackVerified: boolean;
  readonly operationalApproval: boolean;
}

export interface RelationalCutoverDecision {
  readonly mode: RelationalAuthorityMode;
  readonly allowed: boolean;
  readonly missing: readonly RelationalCutoverGate[];
}

export interface RelationalReconciliationMismatch {
  readonly entity: string;
  readonly id: string;
  readonly field: string;
  readonly expectedHash: string;
  readonly actualHash: string;
}

export interface RelationalRequestReconciliation {
  readonly requestId: string;
  readonly sourceAuthority: "SNAPSHOT";
  readonly targetAuthority: "RELATIONAL";
  readonly sourceHash: string;
  readonly targetHash: string;
  readonly comparedEntities: number;
  readonly mismatches: readonly RelationalReconciliationMismatch[];
}

/**
 * Returns the missing gates without changing any runtime mode. A caller may
 * use this in a readiness endpoint or an evidence packet; no claim is made
 * that a true value was witnessed by this module.
 */
export function assessRelationalCutover(
  mode: RelationalAuthorityMode,
  evidence: Partial<RelationalCutoverEvidence> = {}
): RelationalCutoverDecision {
  if (mode !== "RELATIONAL") return { mode, allowed: true, missing: [] };
  const missing = RELATIONAL_CUTOVER_GATES.filter((gate) => evidence[gate] !== true);
  return { mode, allowed: missing.length === 0, missing };
}

/**
 * The store calls this only when a future relational authority flag is
 * introduced. Keeping the guard separate makes accidental cutover impossible
 * while the existing snapshot contract remains the production authority.
 */
export function assertRelationalCutoverAllowed(
  evidence: Partial<RelationalCutoverEvidence>
): void {
  const decision = assessRelationalCutover("RELATIONAL", evidence);
  if (!decision.allowed) {
    throw new Error(`POSTGRES_RELATIONAL_CUTOVER_NOT_READY:${decision.missing.join(",")}`);
  }
}

export function assertReconciliationClean(
  report: Pick<RelationalRequestReconciliation, "mismatches">
): void {
  if (report.mismatches.length > 0) {
    throw new Error(`POSTGRES_RELATIONAL_RECONCILIATION_DIVERGED:${report.mismatches.length}`);
  }
}

/**
 * Compares the fields that the relational clinical core owns. The comparison
 * intentionally returns hashes instead of values so a diagnostic payload is
 * not accidentally copied into logs or evidence packets.
 */
export function reconcileRelationalRequest(
  state: StoreState,
  requestId: string,
  relational: RelationalClinicalRequestRead | undefined
): RelationalRequestReconciliation {
  const snapshot = expectedRequestAggregate(state, requestId);
  const target = relational === undefined ? undefined : normalizeRelationalAggregate(relational);
  const sourceHash = stableHash(canonicalAggregate(snapshot));
  const targetHash = stableHash(target ? canonicalAggregate(comparableTarget(snapshot, target)) : undefined);
  const mismatches: RelationalReconciliationMismatch[] = [];

  if (!target) {
    mismatches.push({
      entity: "diagnostic_requests",
      id: requestId,
      field: "row",
      expectedHash: stableHash(snapshot.request),
      actualHash: stableHash(undefined)
    });
  } else {
    compareRows(mismatches, "diagnostic_requests", snapshot.request, target.request);
    compareCollection(mismatches, "diagnostic_request_items", snapshot.items, target.items);
    compareCollection(mismatches, "samples", snapshot.samples, target.samples);
    compareCollection(mismatches, "sample_item_links", snapshot.sampleItemLinks, target.sampleItemLinks);
    compareCollection(mismatches, "procedures", snapshot.procedures, target.procedures);
    compareCollection(mismatches, "procedure_schedules", snapshot.schedules, target.schedules);
    compareCollection(mismatches, "results", snapshot.results, target.results);
    compareCollection(mismatches, "result_versions", snapshot.resultVersions, target.resultVersions);
    compareCollection(mismatches, "attachments", snapshot.attachments, target.attachments);
    compareCollection(mismatches, "notifications", snapshot.notifications, target.notifications);
  }

  return {
    requestId,
    sourceAuthority: "SNAPSHOT",
    targetAuthority: "RELATIONAL",
    sourceHash,
    targetHash,
    comparedEntities: 1
      + snapshot.items.length
      + snapshot.samples.length
      + snapshot.sampleItemLinks.length
      + snapshot.procedures.length
      + snapshot.schedules.length
      + snapshot.results.length
      + snapshot.resultVersions.length
      + snapshot.attachments.length
      + snapshot.notifications.length,
    mismatches
  };
}

type ComparableRow = Readonly<Record<string, unknown>>;
type ExpectedAggregate = {
  readonly request: ComparableRow;
  readonly items: readonly ComparableRow[];
  readonly samples: readonly ComparableRow[];
  readonly sampleItemLinks: readonly ComparableRow[];
  readonly procedures: readonly ComparableRow[];
  readonly schedules: readonly ComparableRow[];
  readonly results: readonly ComparableRow[];
  readonly resultVersions: readonly ComparableRow[];
  readonly attachments: readonly ComparableRow[];
  readonly notifications: readonly ComparableRow[];
};

const TEMPORAL_FIELDS = new Set([
  "created_at",
  "updated_at",
  "requested_at",
  "received_at",
  "started_at",
  "performed_at",
  "released_at",
  "reviewed_at",
  "completed_at",
  "sla_started_at",
  "due_at",
  "collected_at",
  "linked_at",
  "starts_at",
  "ends_at",
  "acknowledged_at",
  "upload_claim_expires_at",
  "expires_at"
]);

function expectedRequestAggregate(state: StoreState, requestId: string): ExpectedAggregate {
  const request = state.requests.find((row) => row.id === requestId);
  const items = state.items.filter((row) => row.requestId === requestId);
  const itemIds = new Set(items.map((row) => row.id));
  const samples = state.samples.filter((row) => row.requestId === requestId);
  const sampleIds = new Set(samples.map((row) => row.id));
  const procedures = state.procedures.filter((row) => itemIds.has(row.itemId));
  const procedureIds = new Set(procedures.map((row) => row.id));
  const schedules = state.schedules.filter((row) => procedureIds.has(row.procedureId));
  const results = state.results.filter((row) => itemIds.has(row.itemId));
  const resultIds = new Set(results.map((row) => row.id));
  const resultVersions = state.resultVersions.filter((row) => resultIds.has(row.resultId));
  const resultVersionIds = new Set(resultVersions.map((row) => row.id));
  const attachments = state.attachments.filter((row) => resultVersionIds.has(row.resultVersionId));
  const notifications = state.notifications.filter((row) =>
    row.entityId === requestId
      || itemIds.has(row.entityId)
      || sampleIds.has(row.entityId)
      || resultVersionIds.has(row.entityId)
  );

  return {
    request: request ? requestRow(request) : { id: requestId },
    items: items.map(itemRow),
    samples: samples.map((sample) => sampleRow(sample, state)),
    sampleItemLinks: samples.flatMap((sample) => sample.itemIds.map((itemId) => {
      const item = state.items.find((candidate) => candidate.id === itemId);
      if (!item) throw new Error(`POSTGRES_RELATIONAL_RECONCILIATION_INVALID:sample_item_links:${sample.id}:${itemId}`);
      return sampleItemLink(sample, item);
    })),
    procedures: procedures.map(procedureRow),
    schedules: schedules.map(scheduleRow),
    results: results.map(resultRow),
    resultVersions: resultVersions.map(resultVersionRow),
    attachments: attachments.map(attachmentRow),
    notifications: notifications.map(notificationRow)
  };
}

function requestRow(row: StoreState["requests"][number]): ComparableRow {
  return {
    id: row.id,
    request_code: row.requestCode,
    patient_id: row.patientId,
    encounter_id: row.encounterId,
    admission_id: row.admissionId ?? null,
    requester_id: row.requesterId,
    requesting_department_id: row.requestingDepartmentCode,
    priority: row.priority,
    aggregate_status: row.aggregateStatus,
    created_at: row.createdAt,
    updated_at: row.updatedAt,
    version: row.version
  };
}

function itemRow(row: StoreState["items"][number]): ComparableRow {
  return {
    id: row.id,
    request_id: row.requestId,
    service_id: row.serviceId,
    department_id: row.departmentCode,
    workflow_type: row.workflowType,
    priority: row.priority,
    status: row.status,
    note: row.note ?? null,
    requested_at: row.requestedAt,
    received_at: row.receivedAt ?? null,
    started_at: row.startedAt ?? null,
    performed_at: row.performedAt ?? null,
    released_at: row.releasedAt ?? null,
    reviewed_at: row.reviewedAt ?? null,
    completed_at: row.completedAt ?? null,
    sla_started_at: row.slaStartedAt,
    due_at: row.dueAt,
    sla_policy_version: row.slaPolicyVersion,
    current_result_id: row.currentResultId ?? null,
    current_sample_id: row.currentSampleId ?? null,
    procedure_id: row.procedureId ?? null,
    version: row.version
  };
}

function sampleRow(row: StoreState["samples"][number], state: StoreState): ComparableRow {
  const rejectionReasonId = row.rejectionCode === undefined
    ? null
    : state.reasonCodes.find((reason) =>
      (reason.id === row.rejectionCode || reason.code === row.rejectionCode)
      && ["RECOLLECTION", "REJECT"].includes(reason.type)
    )?.id ?? row.rejectionCode;
  return {
    id: row.id,
    request_id: row.requestId,
    accession_code: row.accessionCode,
    sample_type: row.sampleType,
    status: row.status,
    replaces_sample_id: row.replacesSampleId ?? null,
    rejection_reason_id: rejectionReasonId,
    rejection_note: row.rejectionNote ?? null,
    item_ids: [...row.itemIds],
    collected_at: row.collectedAt ?? null,
    received_at: row.receivedAt ?? null,
    received_by: row.receivedBy ?? null,
    version: row.version
  };
}

function procedureRow(row: StoreState["procedures"][number]): ComparableRow {
  return {
    id: row.id,
    item_id: row.itemId,
    workflow_type: row.workflowType,
    status: row.status,
    performed_at: row.performedAt ?? null,
    performed_by: row.performedBy ?? null,
    version: row.version
  };
}

function scheduleRow(row: StoreState["schedules"][number]): ComparableRow {
  return {
    id: row.id,
    procedure_id: row.procedureId,
    starts_at: row.startsAt,
    ends_at: row.endsAt,
    resource: row.resource,
    status: row.status,
    reason: row.reason ?? null,
    actor_id: row.actorId,
    created_at: row.createdAt,
    version: row.version
  };
}

function resultRow(row: StoreState["results"][number]): ComparableRow {
  return {
    id: row.id,
    item_id: row.itemId,
    current_version_id: row.currentVersionId ?? null,
    lifecycle_status: row.lifecycleStatus,
    needs_re_review: row.needsReReview,
    version: row.version
  };
}

function resultVersionRow(row: StoreState["resultVersions"][number]): ComparableRow {
  return {
    id: row.id,
    result_id: row.resultId,
    sequence: row.sequence,
    status: row.status,
    content: row.content,
    narrative: row.narrative,
    conclusion: row.conclusion ?? null,
    author_id: row.authorId,
    created_at: row.createdAt,
    released_at: row.releasedAt ?? null,
    released_by: row.releasedBy ?? null,
    amendment_reason: row.amendmentReason ?? null,
    supersedes_id: row.supersedesId ?? null,
    critical: row.critical,
    needs_re_review: row.needsReReview,
    version: row.version
  };
}

function attachmentRow(row: StoreState["attachments"][number]): ComparableRow {
  return {
    id: row.id,
    result_version_id: row.resultVersionId,
    safe_name: row.safeName,
    storage_key: row.storageKey,
    detected_mime: row.detectedMime,
    size_bytes: row.sizeBytes,
    checksum: row.checksum,
    scan_status: row.scanStatus,
    upload_status: row.uploadStatus,
    upload_claim_token: row.uploadClaimToken ?? null,
    upload_claim_expires_at: row.uploadClaimExpiresAt ?? null,
    expires_at: row.expiresAt ?? null,
    created_by: row.createdBy,
    created_at: row.createdAt
  };
}

function notificationRow(row: StoreState["notifications"][number]): ComparableRow {
  return {
    id: row.id,
    category: row.category,
    priority: row.priority,
    recipient_user_id: row.recipientUserId,
    entity_type: row.entityType,
    entity_id: row.entityId,
    deep_link: row.deepLink,
    title: row.title,
    body: row.body,
    dedupe_key: row.dedupeKey,
    state: row.state,
    created_at: row.createdAt,
    acknowledged_at: row.acknowledgedAt ?? null,
    acknowledged_by: row.acknowledgedBy ?? null,
    attempts: row.attempts,
    version: row.version
  };
}

function normalizeRelationalAggregate(relational: RelationalClinicalRequestRead): ExpectedAggregate {
  return {
    request: relational.request,
    items: relational.items,
    samples: relational.samples,
    sampleItemLinks: relational.sampleItemLinks,
    procedures: relational.procedures,
    schedules: relational.schedules,
    results: relational.results,
    resultVersions: relational.resultVersions,
    attachments: relational.attachments,
    notifications: relational.notifications
  };
}

function compareCollection(
  mismatches: RelationalReconciliationMismatch[],
  entity: string,
  expected: readonly ComparableRow[],
  actual: readonly ComparableRow[]
): void {
  const expectedById = new Map(expected.map((row) => [String(row.id), row]));
  const actualById = new Map(actual.map((row) => [String(row.id), row]));
  for (const [id, row] of expectedById) {
    const current = actualById.get(id);
    if (!current) {
      mismatches.push({ entity, id, field: "row", expectedHash: stableHash(row), actualHash: stableHash(undefined) });
      continue;
    }
    compareRows(mismatches, entity, row, current);
  }
  for (const [id, row] of actualById) {
    if (!expectedById.has(id)) {
      mismatches.push({ entity, id, field: "unexpected_row", expectedHash: stableHash(undefined), actualHash: stableHash(row) });
    }
  }
}

function compareRows(
  mismatches: RelationalReconciliationMismatch[],
  entity: string,
  expected: ComparableRow,
  actual: ComparableRow
): void {
  // The expected projection is the contract owned by StoreState. Relational
  // tables may carry additional provenance/policy columns that this runtime
  // aggregate does not yet own; those columns must not create false drift.
  const keys = new Set(Object.keys(expected));
  const id = String(expected.id ?? actual.id ?? "unknown");
  for (const field of keys) {
    if (stableHash(canonicalFieldValue(field, expected[field])) !== stableHash(canonicalFieldValue(field, actual[field]))) {
      mismatches.push({
        entity,
        id,
        field,
        expectedHash: stableHash(expected[field]),
        actualHash: stableHash(actual[field])
      });
    }
  }
}

function comparableTarget(expected: ExpectedAggregate, actual: ExpectedAggregate): ExpectedAggregate {
  return {
    request: pickFields(expected.request, actual.request),
    items: projectRows(expected.items, actual.items),
    samples: projectRows(expected.samples, actual.samples),
    sampleItemLinks: projectRows(expected.sampleItemLinks, actual.sampleItemLinks),
    procedures: projectRows(expected.procedures, actual.procedures),
    schedules: projectRows(expected.schedules, actual.schedules),
    results: projectRows(expected.results, actual.results),
    resultVersions: projectRows(expected.resultVersions, actual.resultVersions),
    attachments: projectRows(expected.attachments, actual.attachments),
    notifications: projectRows(expected.notifications, actual.notifications)
  };
}

function canonicalAggregate(value: ExpectedAggregate): ExpectedAggregate {
  return {
    request: canonicalRow(value.request),
    items: sortRows(value.items).map(canonicalRow),
    samples: sortRows(value.samples).map(canonicalRow),
    sampleItemLinks: sortRows(value.sampleItemLinks).map(canonicalRow),
    procedures: sortRows(value.procedures).map(canonicalRow),
    schedules: sortRows(value.schedules).map(canonicalRow),
    results: sortRows(value.results).map(canonicalRow),
    resultVersions: sortRows(value.resultVersions).map(canonicalRow),
    attachments: sortRows(value.attachments).map(canonicalRow),
    notifications: sortRows(value.notifications).map(canonicalRow)
  };
}

function canonicalRow(row: ComparableRow): ComparableRow {
  return Object.fromEntries(Object.entries(row).map(([field, value]) => [field, canonicalFieldValue(field, value)]));
}

function canonicalFieldValue(field: string, value: unknown): unknown {
  if (!TEMPORAL_FIELDS.has(field) || typeof value !== "string") return value;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? value : new Date(parsed).toISOString();
}

function projectRows(expected: readonly ComparableRow[], actual: readonly ComparableRow[]): readonly ComparableRow[] {
  const expectedById = new Map(expected.map((row) => [String(row.id), row]));
  return actual
    .map((row) => pickFields(expectedById.get(String(row.id)) ?? {}, row))
    .sort((left, right) => String(left.id).localeCompare(String(right.id)));
}

function sortRows(rows: readonly ComparableRow[]): readonly ComparableRow[] {
  return [...rows].sort((left, right) => String(left.id).localeCompare(String(right.id)));
}

function pickFields(expected: ComparableRow, actual: ComparableRow): ComparableRow {
  return Object.fromEntries(Object.keys(expected).map((key) => [key, actual[key]]));
}

export function stableCutoverHash(value: unknown): string {
  return createHash("sha256").update(stableSerialize(value)).digest("hex");
}

function stableHash(value: unknown): string {
  return stableCutoverHash(value);
}

function stableSerialize(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableSerialize).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableSerialize(entry)}`)
      .join(",")}}`;
  }
  if (value === undefined) return "undefined";
  const serialized = JSON.stringify(value);
  return serialized === undefined ? String(value) : serialized;
}
