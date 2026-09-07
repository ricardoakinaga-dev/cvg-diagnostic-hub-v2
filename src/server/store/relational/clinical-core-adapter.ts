import type {
  DiagnosticItem,
  DiagnosticRequest,
  Notification,
  Procedure,
  ProcedureSchedule,
  Result,
  ResultVersion,
  Sample,
  StoreState
} from "../../domain/models";
import type {
  RelationalClinicalCoreRuntime,
  RelationalClinicalRequestRead,
  RelationalClinicalCoreReadinessOptions,
  RelationalSqlClient,
  RelationalSqlResult
} from "./clinical-core-contracts";
import { readRelationalAggregate } from "./clinical-core-read";
import {
  RELATIONAL_CORE_MARKER,
  RELATIONAL_CORE_READINESS_SQL,
  RELATIONAL_SAMPLE_MEMBERSHIP_REPAIR_SQL,
  RELATIONAL_SAMPLE_MEMBERSHIP_VALIDATION_SQL,
  relationalCoreReadinessValues
} from "./clinical-core-readiness-sql";
import { idempotentInsertSql, replaySql } from "./projection-sql";
import { sampleLinkProjections, sampleTimestamp } from "./sample-lineage";

export type {
  RelationalClinicalCoreRuntime,
  RelationalClinicalRequestRead,
  RelationalSqlClient,
  RelationalSqlResult
} from "./clinical-core-contracts";
export {
  RELATIONAL_CORE_MARKER,
  RELATIONAL_CORE_READINESS_SQL,
  RELATIONAL_SAMPLE_MEMBERSHIP_REPAIR_SQL,
  RELATIONAL_SAMPLE_MEMBERSHIP_VALIDATION_SQL
} from "./clinical-core-readiness-sql";

/**
 * One statement gives the caller one MVCC snapshot for the whole clinical
 * request aggregate. The JSON is only a transport envelope; the source rows
 * remain the 007–009 relational tables and every identifier remains text.
 */
export const RELATIONAL_REQUEST_READ_SQL = `
WITH target_items AS (
  SELECT item.id
    FROM diagnostic_request_items item
   WHERE item.request_id = $1
), target_samples AS (
  SELECT sample.id
    FROM samples sample
   WHERE sample.request_id = $1
), target_procedures AS (
  SELECT procedure_row.id
    FROM procedures procedure_row
    JOIN target_items item ON item.id = procedure_row.item_id
), target_results AS (
  SELECT result_row.id
    FROM results result_row
    JOIN target_items item ON item.id = result_row.item_id
), target_result_versions AS (
  SELECT version_row.id
    FROM result_versions version_row
    JOIN target_results result_row ON result_row.id = version_row.result_id
)
SELECT jsonb_build_object(
  'request', to_jsonb(request_row),
  'items', COALESCE((SELECT jsonb_agg(to_jsonb(item) ORDER BY item.id) FROM diagnostic_request_items item WHERE item.request_id = request_row.id), '[]'::jsonb),
  'samples', COALESCE((SELECT jsonb_agg(to_jsonb(sample) ORDER BY sample.id) FROM samples sample WHERE sample.request_id = request_row.id), '[]'::jsonb),
  'sampleItemLinks', COALESCE((SELECT jsonb_agg(to_jsonb(link) ORDER BY link.id) FROM sample_item_links link WHERE link.request_id = request_row.id), '[]'::jsonb),
  'procedures', COALESCE((SELECT jsonb_agg(to_jsonb(procedure_row) ORDER BY procedure_row.id) FROM procedures procedure_row WHERE procedure_row.id IN (SELECT id FROM target_procedures)), '[]'::jsonb),
  'schedules', COALESCE((SELECT jsonb_agg(to_jsonb(schedule) ORDER BY schedule.id) FROM procedure_schedules schedule WHERE schedule.procedure_id IN (SELECT id FROM target_procedures)), '[]'::jsonb),
  'results', COALESCE((SELECT jsonb_agg(to_jsonb(result_row) ORDER BY result_row.id) FROM results result_row WHERE result_row.id IN (SELECT id FROM target_results)), '[]'::jsonb),
  'resultVersions', COALESCE((SELECT jsonb_agg(to_jsonb(version_row) ORDER BY version_row.id) FROM result_versions version_row WHERE version_row.id IN (SELECT id FROM target_result_versions)), '[]'::jsonb),
  'attachments', COALESCE((SELECT jsonb_agg(to_jsonb(attachment) ORDER BY attachment.id) FROM attachments attachment WHERE attachment.result_version_id IN (SELECT id FROM target_result_versions)), '[]'::jsonb),
  'notifications', COALESCE((
    SELECT jsonb_agg(to_jsonb(notification) ORDER BY notification.id)
      FROM notifications notification
     WHERE notification.entity_id = request_row.id
        OR notification.entity_id IN (SELECT id FROM target_items)
        OR notification.entity_id IN (SELECT id FROM target_samples)
        OR notification.entity_id IN (SELECT id FROM target_result_versions)
  ), '[]'::jsonb)
) AS aggregate
  FROM diagnostic_requests request_row
 WHERE request_row.id = $1`;

type VersionedEntity =
  | DiagnosticRequest
  | DiagnosticItem
  | Sample
  | Procedure
  | ProcedureSchedule
  | Result
  | ResultVersion
  | Notification;

interface VersionedProjection {
  readonly table: string;
  readonly id: string;
  readonly version: number;
  readonly expectedVersion?: number;
  readonly insertSql: string;
  readonly insertValues: readonly unknown[];
  readonly updateSql: string;
  readonly updateValues: readonly unknown[];
}

interface AppendOnlyProjection {
  readonly table: string;
  readonly id: string;
  readonly sql: string;
  readonly values: readonly unknown[];
}

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

function positiveVersion(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1) {
    throw new Error(`POSTGRES_RELATIONAL_INVALID_VERSION:${field}`);
  }
  return Number(value);
}

function nullable(value: string | undefined): string | null {
  return value ?? null;
}

function json(value: unknown): string {
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new Error("POSTGRES_RELATIONAL_UNMAPPABLE_JSON");
  return encoded;
}

function affectedRows(result: RelationalSqlResult): number {
  return typeof result.rowCount === "number" ? result.rowCount : result.rows.length;
}

function stateIndex<T extends { id: string }>(rows: readonly T[], collection: string): Map<string, T> {
  const index = new Map<string, T>();
  for (const row of rows) {
    const id = text(row.id, `${collection}.id`);
    if (index.has(id)) throw new Error(`POSTGRES_RELATIONAL_DUPLICATE_STATE_ID:${collection}:${id}`);
    index.set(id, row);
  }
  return index;
}

function reasonId(
  state: StoreState,
  value: string | undefined,
  field: string,
  allowedTypes: readonly string[]
): string | null {
  if (value === undefined) return null;
  const reason = state.reasonCodes.find((candidate) =>
    (candidate.id === value || candidate.code === value) && allowedTypes.includes(candidate.type)
  );
  if (!reason) throw new Error(`POSTGRES_RELATIONAL_UNMAPPABLE_STATE:${field}`);
  return text(reason.id, `${field}.id`);
}

function itemTimestamp(item: DiagnosticItem): string {
  return text(
    item.completedAt ?? item.reviewedAt ?? item.releasedAt ?? item.performedAt ?? item.startedAt ?? item.receivedAt ?? item.requestedAt,
    "diagnostic_request_items.updated_at"
  );
}

function resultTimestamp(result: Result, state: StoreState): string {
  const version = result.currentVersionId
    ? state.resultVersions.find((candidate) => candidate.id === result.currentVersionId)
    : state.resultVersions.find((candidate) => candidate.resultId === result.id);
  const item = state.items.find((candidate) => candidate.id === result.itemId);
  return text(version?.createdAt ?? item?.requestedAt, "results.created_at");
}

function versionedProjection(
  table: string,
  id: string,
  version: number,
  previousVersion: number | undefined,
  insertSql: string,
  insertValues: readonly unknown[],
  updateSql: string,
  updateValues: readonly unknown[]
): VersionedProjection {
  return { table, id, version, expectedVersion: previousVersion, insertSql, insertValues, updateSql, updateValues };
}

function requestProjection(current: DiagnosticRequest, previous?: DiagnosticRequest): VersionedProjection {
  const id = text(current.id, "diagnostic_requests.id");
  const version = positiveVersion(current.version, `diagnostic_requests.version:${id}`);
  const expectedVersion = previous ? positiveVersion(previous.version, `diagnostic_requests.previous_version:${id}`) : undefined;
  const values = [
    id,
    text(current.requestCode, "diagnostic_requests.request_code"),
    text(current.patientId, "diagnostic_requests.patient_id"),
    text(current.encounterId, "diagnostic_requests.encounter_id"),
    nullable(current.admissionId),
    text(current.requesterId, "diagnostic_requests.requester_id"),
    text(current.requestingDepartmentCode, "diagnostic_requests.requesting_department_id"),
    text(current.priority, "diagnostic_requests.priority"),
    text(current.aggregateStatus, "diagnostic_requests.aggregate_status"),
    text(current.createdAt, "diagnostic_requests.created_at"),
    text(current.updatedAt, "diagnostic_requests.updated_at"),
    version
  ];
  return versionedProjection(
    "diagnostic_requests",
    id,
    version,
    expectedVersion,
    "INSERT INTO diagnostic_requests (id, request_code, patient_id, encounter_id, admission_id, requester_id, requesting_department_id, priority, aggregate_status, created_at, updated_at, version) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id, version",
    values,
    "UPDATE diagnostic_requests SET request_code = $2, patient_id = $3, encounter_id = $4, admission_id = $5, requester_id = $6, requesting_department_id = $7, priority = $8, aggregate_status = $9, created_at = $10, updated_at = $11, version = $12 WHERE id = $1 AND version = $13 RETURNING id, version",
    [...values, expectedVersion]
  );
}

function itemProjection(current: DiagnosticItem, previous: DiagnosticItem | undefined, state: StoreState): VersionedProjection {
  const id = text(current.id, "diagnostic_request_items.id");
  const version = positiveVersion(current.version, `diagnostic_request_items.version:${id}`);
  const expectedVersion = previous ? positiveVersion(previous.version, `diagnostic_request_items.previous_version:${id}`) : undefined;
  const values = [
    id,
    text(current.requestId, "diagnostic_request_items.request_id"),
    text(current.serviceId, "diagnostic_request_items.service_id"),
    text(current.departmentCode, "diagnostic_request_items.department_id"),
    text(current.workflowType, "diagnostic_request_items.workflow_type"),
    text(current.priority, "diagnostic_request_items.priority"),
    text(current.status, "diagnostic_request_items.status"),
    nullable(current.note),
    text(current.requestedAt, "diagnostic_request_items.requested_at"),
    nullable(current.receivedAt),
    nullable(current.startedAt),
    nullable(current.performedAt),
    nullable(current.releasedAt),
    nullable(current.reviewedAt),
    nullable(current.completedAt),
    text(current.slaStartedAt, "diagnostic_request_items.sla_started_at"),
    text(current.dueAt, "diagnostic_request_items.due_at"),
    positiveVersion(current.slaPolicyVersion, `diagnostic_request_items.sla_policy_version:${id}`),
    reasonId(state, current.cancellationReason, "diagnostic_request_items.cancellation_reason_id", ["CANCEL"]),
    reasonId(state, current.rejectionReason, "diagnostic_request_items.rejection_reason_id", ["REJECT"]),
    nullable(current.currentResultId),
    nullable(current.currentSampleId),
    nullable(current.procedureId),
    text(current.requestedAt, "diagnostic_request_items.created_at"),
    itemTimestamp(current),
    version
  ];
  return versionedProjection(
    "diagnostic_request_items",
    id,
    version,
    expectedVersion,
    "INSERT INTO diagnostic_request_items (id, request_id, service_id, department_id, workflow_type, priority, status, note, requested_at, received_at, started_at, performed_at, released_at, reviewed_at, completed_at, sla_started_at, due_at, sla_policy_version, cancellation_reason_id, rejection_reason_id, current_result_id, current_sample_id, procedure_id, created_at, updated_at, version) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26) RETURNING id, version",
    values,
    "UPDATE diagnostic_request_items SET request_id = $2, service_id = $3, department_id = $4, workflow_type = $5, priority = $6, status = $7, note = $8, requested_at = $9, received_at = $10, started_at = $11, performed_at = $12, released_at = $13, reviewed_at = $14, completed_at = $15, sla_started_at = $16, due_at = $17, sla_policy_version = $18, cancellation_reason_id = $19, rejection_reason_id = $20, current_result_id = $21, current_sample_id = $22, procedure_id = $23, created_at = $24, updated_at = $25, version = $26 WHERE id = $1 AND version = $27 RETURNING id, version",
    [...values, expectedVersion]
  );
}

function sampleProjection(current: Sample, previous: Sample | undefined, state: StoreState): VersionedProjection {
  const id = text(current.id, "samples.id");
  const version = positiveVersion(current.version, `samples.version:${id}`);
  const expectedVersion = previous ? positiveVersion(previous.version, `samples.previous_version:${id}`) : undefined;
  const values = [
    id,
    text(current.requestId, "samples.request_id"),
    text(current.accessionCode, "samples.accession_code"),
    text(current.sampleType, "samples.sample_type"),
    text(current.status, "samples.status"),
    nullable(current.replacesSampleId),
    reasonId(state, current.rejectionCode, "samples.rejection_reason_id", ["RECOLLECTION", "REJECT"]),
    nullable(current.rejectionNote),
    [...current.itemIds],
    nullable(current.collectedAt),
    nullable(current.receivedAt),
    nullable(current.receivedBy),
    sampleTimestamp(current, state),
    sampleTimestamp(current, state),
    version
  ];
  return versionedProjection(
    "samples",
    id,
    version,
    expectedVersion,
    "INSERT INTO samples (id, request_id, accession_code, sample_type, status, replaces_sample_id, rejection_reason_id, rejection_note, item_ids, collected_at, received_at, received_by, created_at, updated_at, version) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING id, version",
    values,
    "UPDATE samples SET request_id = $2, accession_code = $3, sample_type = $4, status = $5, replaces_sample_id = $6, rejection_reason_id = $7, rejection_note = $8, item_ids = $9, collected_at = $10, received_at = $11, received_by = $12, created_at = $13, updated_at = $14, version = $15 WHERE id = $1 AND version = $16 RETURNING id, version",
    [...values, expectedVersion]
  );
}

function assertSampleLineage(state: Pick<StoreState, "samples" | "items">): void {
  const samples = stateIndex(state.samples, "samples");
  const items = stateIndex(state.items, "diagnostic_request_items");
  const accessions = new Map<string, string>();

  for (const sample of samples.values()) {
    const id = text(sample.id, "samples.id");
    const accessionCode = text(sample.accessionCode, `samples.accession_code:${id}`);
    if (!/^[A-Z0-9][A-Z0-9-]{2,39}$/.test(accessionCode)) {
      throw new Error(`POSTGRES_RELATIONAL_UNMAPPABLE_STATE:samples.accession_code:${id}`);
    }
    const existing = accessions.get(accessionCode);
    if (existing) throw new Error(`POSTGRES_RELATIONAL_DUPLICATE_STATE_VALUE:samples.accession_code:${accessionCode}`);
    accessions.set(accessionCode, id);
    positiveVersion(sample.version, `samples.version:${id}`);
    if (!Array.isArray(sample.itemIds) || sample.itemIds.length === 0) {
      throw new Error(`POSTGRES_RELATIONAL_UNMAPPABLE_STATE:sample_item_links:${id}`);
    }
    const itemIds = new Set<string>();
    for (const rawItemId of sample.itemIds) {
      const itemId = text(rawItemId, `sample_item_links.item_id:${id}`);
      if (itemIds.has(itemId)) {
        throw new Error(`POSTGRES_RELATIONAL_DUPLICATE_STATE_ID:sample_item_links:${id}:${itemId}`);
      }
      itemIds.add(itemId);
      const item = items.get(itemId);
      if (!item || item.requestId !== sample.requestId) {
        throw new Error(`POSTGRES_RELATIONAL_UNMAPPABLE_STATE:sample_item_links:${id}`);
      }
    }
    if ((sample.status === "REJECTED" || sample.status === "REPLACED") && !sample.rejectionCode) {
      throw new Error(`POSTGRES_RELATIONAL_UNMAPPABLE_STATE:samples.rejection_reason_id:${id}`);
    }
    if (sample.replacesSampleId !== undefined) {
      const predecessor = samples.get(sample.replacesSampleId);
      if (!predecessor || predecessor.id === id || predecessor.requestId !== sample.requestId) {
        throw new Error(`POSTGRES_RELATIONAL_UNMAPPABLE_STATE:samples.replaces_sample_id:${id}`);
      }
      const visited = new Set<string>([id]);
      let cursor: Sample | undefined = predecessor;
      while (cursor) {
        if (visited.has(cursor.id)) {
          throw new Error(`POSTGRES_RELATIONAL_CYCLE:samples:${id}`);
        }
        if (cursor.requestId !== sample.requestId) {
          throw new Error(`POSTGRES_RELATIONAL_UNMAPPABLE_STATE:samples.replaces_sample_id:${id}`);
        }
        visited.add(cursor.id);
        if (cursor.replacesSampleId) {
          const next = samples.get(cursor.replacesSampleId);
          if (!next) throw new Error(`POSTGRES_RELATIONAL_UNMAPPABLE_STATE:samples.replaces_sample_id:${id}`);
          cursor = next;
        } else {
          cursor = undefined;
        }
      }
    }
  }
}

function procedureProjection(current: Procedure, previous: Procedure | undefined, state: StoreState): VersionedProjection {
  const id = text(current.id, "procedures.id");
  const item = state.items.find((candidate) => candidate.id === current.itemId);
  const version = positiveVersion(current.version, `procedures.version:${id}`);
  const expectedVersion = previous ? positiveVersion(previous.version, `procedures.previous_version:${id}`) : undefined;
  const createdAt = text(item?.requestedAt, "procedures.created_at");
  const updatedAt = text(current.performedAt ?? item?.requestedAt, "procedures.updated_at");
  const insertValues = [
    id,
    text(current.itemId, "procedures.item_id"),
    text(current.workflowType, "procedures.workflow_type"),
    text(current.status, "procedures.status"),
    json({}),
    nullable(current.performedAt),
    nullable(current.performedBy),
    createdAt,
    updatedAt,
    version
  ];
  const updateValues = [
    id,
    text(current.itemId, "procedures.item_id"),
    text(current.workflowType, "procedures.workflow_type"),
    text(current.status, "procedures.status"),
    nullable(current.performedAt),
    nullable(current.performedBy),
    updatedAt,
    version,
    expectedVersion
  ];
  return versionedProjection(
    "procedures",
    id,
    version,
    expectedVersion,
    "INSERT INTO procedures (id, item_id, workflow_type, status, metadata, performed_at, performed_by, created_at, updated_at, version) VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7,$8,$9,$10) RETURNING id, version",
    insertValues,
    "UPDATE procedures SET item_id = $2, workflow_type = $3, status = $4, performed_at = $5, performed_by = $6, updated_at = $7, version = $8 WHERE id = $1 AND version = $9 RETURNING id, version",
    updateValues
  );
}

function scheduleProjection(current: ProcedureSchedule, previous?: ProcedureSchedule): VersionedProjection {
  const id = text(current.id, "procedure_schedules.id");
  const version = positiveVersion(current.version, `procedure_schedules.version:${id}`);
  const expectedVersion = previous ? positiveVersion(previous.version, `procedure_schedules.previous_version:${id}`) : undefined;
  const values = [
    id,
    text(current.procedureId, "procedure_schedules.procedure_id"),
    text(current.startsAt, "procedure_schedules.starts_at"),
    text(current.endsAt, "procedure_schedules.ends_at"),
    text(current.resource, "procedure_schedules.resource"),
    text(current.status, "procedure_schedules.status"),
    nullable(current.reason),
    text(current.actorId, "procedure_schedules.actor_id"),
    text(current.createdAt, "procedure_schedules.created_at"),
    text(current.createdAt, "procedure_schedules.updated_at"),
    version
  ];
  return versionedProjection(
    "procedure_schedules",
    id,
    version,
    expectedVersion,
    "INSERT INTO procedure_schedules (id, procedure_id, starts_at, ends_at, resource, status, reason, actor_id, created_at, updated_at, version) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id, version",
    values,
    "UPDATE procedure_schedules SET procedure_id = $2, starts_at = $3, ends_at = $4, resource = $5, status = $6, reason = $7, actor_id = $8, created_at = $9, updated_at = $10, version = $11 WHERE id = $1 AND version = $12 RETURNING id, version",
    [...values, expectedVersion]
  );
}

function resultProjection(current: Result, previous: Result | undefined, state: StoreState): VersionedProjection {
  const id = text(current.id, "results.id");
  const version = positiveVersion(current.version, `results.version:${id}`);
  const expectedVersion = previous ? positiveVersion(previous.version, `results.previous_version:${id}`) : undefined;
  const timestamp = resultTimestamp(current, state);
  const values = [
    id,
    text(current.itemId, "results.item_id"),
    nullable(current.currentVersionId),
    text(current.lifecycleStatus, "results.lifecycle_status"),
    Boolean(current.needsReReview),
    timestamp,
    timestamp,
    version
  ];
  return versionedProjection(
    "results",
    id,
    version,
    expectedVersion,
    "INSERT INTO results (id, item_id, current_version_id, lifecycle_status, needs_re_review, created_at, updated_at, version) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id, version",
    values,
    "UPDATE results SET item_id = $2, current_version_id = $3, lifecycle_status = $4, needs_re_review = $5, created_at = $6, updated_at = $7, version = $8 WHERE id = $1 AND version = $9 RETURNING id, version",
    [...values, expectedVersion]
  );
}

function resultVersionProjection(current: ResultVersion, previous?: ResultVersion): VersionedProjection {
  const id = text(current.id, "result_versions.id");
  const version = positiveVersion(current.version, `result_versions.version:${id}`);
  const expectedVersion = previous ? positiveVersion(previous.version, `result_versions.previous_version:${id}`) : undefined;
  const values = [
    id,
    text(current.resultId, "result_versions.result_id"),
    positiveVersion(current.sequence, `result_versions.sequence:${id}`),
    text(current.status, "result_versions.status"),
    json(current.content),
    text(current.narrative, "result_versions.narrative"),
    nullable(current.conclusion),
    text(current.authorId, "result_versions.author_id"),
    text(current.createdAt, "result_versions.created_at"),
    nullable(current.releasedAt),
    nullable(current.releasedBy),
    nullable(current.amendmentReason),
    nullable(current.supersedesId),
    Boolean(current.critical),
    Boolean(current.needsReReview),
    version
  ];
  return versionedProjection(
    "result_versions",
    id,
    version,
    expectedVersion,
    "INSERT INTO result_versions (id, result_id, sequence, status, content, narrative, conclusion, author_id, created_at, released_at, released_by, amendment_reason, supersedes_id, critical, needs_re_review, version) VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) RETURNING id, version",
    values,
    "UPDATE result_versions SET result_id = $2, sequence = $3, status = $4, content = $5::jsonb, narrative = $6, conclusion = $7, author_id = $8, released_at = $9, released_by = $10, amendment_reason = $11, supersedes_id = $12, critical = $13, needs_re_review = $14, version = $15 WHERE id = $1 AND version = $16 RETURNING id, version",
    [...values.slice(0, 8), ...values.slice(9), expectedVersion]
  );
}

function notificationProjection(current: Notification, previous?: Notification): VersionedProjection {
  const id = text(current.id, "notifications.id");
  const version = positiveVersion(current.version, `notifications.version:${id}`);
  const expectedVersion = previous ? positiveVersion(previous.version, `notifications.previous_version:${id}`) : undefined;
  const values = [
    id,
    text(current.category, "notifications.category"),
    text(current.priority, "notifications.priority"),
    text(current.recipientUserId, "notifications.recipient_user_id"),
    text(current.entityType, "notifications.entity_type"),
    text(current.entityId, "notifications.entity_id"),
    text(current.deepLink, "notifications.deep_link"),
    text(current.title, "notifications.title"),
    text(current.body, "notifications.body"),
    text(current.dedupeKey, "notifications.dedupe_key"),
    text(current.state, "notifications.state"),
    text(current.createdAt, "notifications.created_at"),
    nullable(current.acknowledgedAt),
    nullable(current.acknowledgedBy),
    positiveVersion(current.attempts + 1, `notifications.attempts:${id}`) - 1,
    version
  ];
  return versionedProjection(
    "notifications",
    id,
    version,
    expectedVersion,
    "INSERT INTO notifications (id, category, priority, recipient_user_id, entity_type, entity_id, deep_link, title, body, dedupe_key, state, created_at, acknowledged_at, acknowledged_by, attempts, version) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) RETURNING id, version",
    values,
    "UPDATE notifications SET category = $2, priority = $3, recipient_user_id = $4, entity_type = $5, entity_id = $6, deep_link = $7, title = $8, body = $9, dedupe_key = $10, state = $11, acknowledged_at = $12, acknowledged_by = $13, attempts = $14, version = $15 WHERE id = $1 AND version = $16 RETURNING id, version",
    [
      id,
      ...values.slice(1, 11),
      ...values.slice(12, 15),
      version,
      expectedVersion
    ]
  );
}

function attachmentProjection(
  current: StoreState["attachments"][number]
): AppendOnlyProjection {
  const id = text(current.id, "attachments.id");
  return {
    table: "attachments",
    id,
    sql: "INSERT INTO attachments (id, result_version_id, safe_name, storage_key, detected_mime, size_bytes, checksum, scan_status, upload_status, upload_claim_token, upload_claim_expires_at, expires_at, created_by, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) ON CONFLICT (id) DO NOTHING RETURNING id",
    values: [
      id,
      text(current.resultVersionId, "attachments.result_version_id"),
      text(current.safeName, "attachments.safe_name"),
      text(current.storageKey, "attachments.storage_key"),
      text(current.detectedMime, "attachments.detected_mime"),
      current.sizeBytes,
      text(current.checksum, "attachments.checksum"),
      text(current.scanStatus, "attachments.scan_status"),
      text(current.uploadStatus, "attachments.upload_status"),
      nullable(current.uploadClaimToken),
      nullable(current.uploadClaimExpiresAt),
      nullable(current.expiresAt),
      text(current.createdBy, "attachments.created_by"),
      text(current.createdAt, "attachments.created_at")
    ]
  };
}

function changedVersioned<T extends VersionedEntity>(
  collection: string,
  beforeRows: readonly T[],
  afterRows: readonly T[],
  build: (current: T, previous?: T) => VersionedProjection
): VersionedProjection[] {
  const before = stateIndex(beforeRows, collection);
  const after = stateIndex(afterRows, collection);
  const writes: VersionedProjection[] = [];
  for (const current of after.values()) {
    const previous = before.get(current.id);
    if (!previous || JSON.stringify(previous) !== JSON.stringify(current)) writes.push(build(current, previous));
  }
  for (const previous of before.values()) {
    if (!after.has(previous.id)) throw new Error(`POSTGRES_RELATIONAL_DELETION_UNSUPPORTED:${collection}:${previous.id}`);
  }
  return writes;
}

function changedAttachments(
  beforeRows: readonly StoreState["attachments"][number][],
  afterRows: readonly StoreState["attachments"][number][]
): AppendOnlyProjection[] {
  const before = stateIndex(beforeRows, "attachments");
  const after = stateIndex(afterRows, "attachments");
  const writes: AppendOnlyProjection[] = [];
  for (const current of after.values()) {
    const previous = before.get(current.id);
    if (!previous) writes.push(attachmentProjection(current));
    else if (JSON.stringify(previous) !== JSON.stringify(current)) {
      throw new Error(`POSTGRES_RELATIONAL_APPEND_ONLY_CONFLICT:attachments:${current.id}`);
    }
  }
  for (const previous of before.values()) {
    if (!after.has(previous.id)) throw new Error(`POSTGRES_RELATIONAL_DELETION_UNSUPPORTED:attachments:${previous.id}`);
  }
  return writes;
}

async function writeVersioned(client: RelationalSqlClient, projection: VersionedProjection): Promise<void> {
  if (projection.expectedVersion === undefined) {
    if (projection.version !== 1) {
      throw new Error(`POSTGRES_RELATIONAL_INSERT_REQUIRES_VERSION_ONE:${projection.table}:${projection.id}`);
    }
    const inserted = await client.query(idempotentInsertSql(projection.insertSql), [...projection.insertValues]);
    if (affectedRows(inserted) !== 1) {
      const replayed = await client.query(
        replaySql(projection.table, projection.insertSql, "id, version"),
        [...projection.insertValues]
      );
      if (affectedRows(replayed) === 1) return;
      throw new Error(`POSTGRES_RELATIONAL_INSERT_CONFLICT:${projection.table}:${projection.id}`);
    }
    return;
  }
  if (projection.version !== projection.expectedVersion + 1) {
    throw new Error(`POSTGRES_RELATIONAL_VERSION_SEQUENCE_INVALID:${projection.table}:${projection.id}`);
  }
  const updated = await client.query(projection.updateSql, [...projection.updateValues]);
  if (affectedRows(updated) !== 1) {
    throw new Error(`POSTGRES_RELATIONAL_OPTIMISTIC_VERSION_CONFLICT:${projection.table}:${projection.id}`);
  }
}

async function writeAppendOnly(client: RelationalSqlClient, projection: AppendOnlyProjection): Promise<void> {
  const inserted = await client.query(projection.sql, [...projection.values]);
  if (affectedRows(inserted) !== 1) {
    const replayed = await client.query(
      replaySql(projection.table, projection.sql, "id"),
      [...projection.values]
    );
    if (affectedRows(replayed) === 1) return;
    throw new Error(`POSTGRES_RELATIONAL_APPEND_ONLY_CONFLICT:${projection.table}:${projection.id}`);
  }
}

export class RelationalClinicalCoreAdapter implements RelationalClinicalCoreRuntime {
  async assertReady(client: RelationalSqlClient, options: RelationalClinicalCoreReadinessOptions = {}): Promise<void> {
    try {
      const result = await client.query(RELATIONAL_CORE_READINESS_SQL, relationalCoreReadinessValues(options.allowUnvalidatedSampleMembership === true));
      const row = result.rows[0];
      if (
        !isRecord(row)
        || row.marker_ready !== true
        || row.tables_ready !== true
        || row.write_shape_ready !== true
        || row.constraints_ready !== true
      ) {
        throw new Error("POSTGRES_RELATIONAL_CLINICAL_CORE_NOT_READY");
      }
    } catch (error) {
      if (error instanceof Error && error.message === "POSTGRES_RELATIONAL_CLINICAL_CORE_NOT_READY") throw error;
      throw new Error("POSTGRES_RELATIONAL_CLINICAL_CORE_NOT_READY", { cause: error });
    }
  }

  async validateSampleMembership(client: RelationalSqlClient): Promise<void> {
    try {
      await client.query(RELATIONAL_SAMPLE_MEMBERSHIP_VALIDATION_SQL);
    } catch (error) {
      throw new Error("POSTGRES_RELATIONAL_SAMPLE_MEMBERSHIP_NOT_VALID", { cause: error });
    }
  }

  async repairSampleMembership(client: RelationalSqlClient, state: StoreState): Promise<void> {
    assertSampleLineage(state);
    for (const sample of state.samples) {
      await client.query(RELATIONAL_SAMPLE_MEMBERSHIP_REPAIR_SQL, [
        text(sample.id, "samples.id"),
        [...sample.itemIds],
        text(sample.requestId, "samples.request_id"),
        positiveVersion(sample.version, `samples.version:${sample.id}`)
      ]);
    }
  }

  async readRequest(client: RelationalSqlClient, requestId: string): Promise<RelationalClinicalRequestRead | undefined> {
    const id = text(requestId, "relational_request_id");
    try {
      const result = await client.query(RELATIONAL_REQUEST_READ_SQL, [id]);
      if (affectedRows(result) === 0) return undefined;
      if (affectedRows(result) !== 1) throw new Error("POSTGRES_RELATIONAL_READ_CARDINALITY_INVALID");
      const row = record(result.rows[0], "POSTGRES_RELATIONAL_READ_INVALID");
      return readRelationalAggregate(row.aggregate, id);
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("POSTGRES_RELATIONAL_")) throw error;
      throw new Error("POSTGRES_RELATIONAL_READ_FAILED", { cause: error });
    }
  }

  async projectStateDelta(client: RelationalSqlClient, before: StoreState, after: StoreState): Promise<void> {
    // The current StateStore aggregate has no lossless representation for the
    // auth/catalog tables, idempotency row IDs, or result_components. Those
    // remain outside this seam until their contracts are split. No fabricated
    // domain, policy, threshold, or role-scope value is inserted here; the
    // junction-table ID is a deterministic technical key over existing IDs.
    assertSampleLineage(after);
    const requestWrites = changedVersioned("requests", before.requests, after.requests, (current, previous) => requestProjection(current, previous));
    const itemWrites = changedVersioned("items", before.items, after.items, (current, previous) => itemProjection(current, previous, after));
    const sampleWrites = changedVersioned("samples", before.samples, after.samples, (current, previous) => sampleProjection(current, previous, after));
    const procedureWrites = changedVersioned("procedures", before.procedures, after.procedures, (current, previous) => procedureProjection(current, previous, after));
    const scheduleWrites = changedVersioned("schedules", before.schedules, after.schedules, (current, previous) => scheduleProjection(current, previous));
    const resultWrites = changedVersioned("results", before.results, after.results, (current, previous) => resultProjection(current, previous, after));
    const resultVersionWrites = changedVersioned("resultVersions", before.resultVersions, after.resultVersions, (current, previous) => resultVersionProjection(current, previous));
    const notificationWrites = changedVersioned("notifications", before.notifications, after.notifications, (current, previous) => notificationProjection(current, previous));
    const attachmentWrites = changedAttachments(before.attachments, after.attachments);
    const linkWrites = sampleLinkProjections(before, after);

    for (const projection of requestWrites) await writeVersioned(client, projection);
    for (const projection of itemWrites) await writeVersioned(client, projection);
    for (const projection of sampleWrites) await writeVersioned(client, projection);
    for (const projection of linkWrites) await writeVersioned(client, projection);
    for (const projection of procedureWrites) await writeVersioned(client, projection);
    for (const projection of scheduleWrites) await writeVersioned(client, projection);
    for (const projection of resultWrites) await writeVersioned(client, projection);
    for (const projection of resultVersionWrites) await writeVersioned(client, projection);
    for (const projection of attachmentWrites) await writeAppendOnly(client, projection);
    for (const projection of notificationWrites) await writeVersioned(client, projection);
  }
}
