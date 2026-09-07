import type { StoreState } from "../../domain/models";
import type { RelationalSqlClient, RelationalSqlResult } from "./clinical-core-contracts";
import { stableHash } from "./backfill";

export const RELATIONAL_CLINICAL_CORE_BACKFILL_SCOPE = "CLINICAL_CORE_REQUESTS" as const;
export const RELATIONAL_CLINICAL_CORE_BACKFILL_TARGET = "RELATIONAL_SHADOW" as const;
export const RELATIONAL_CLINICAL_CORE_BACKFILL_SOURCE = "SNAPSHOT" as const;
export const RELATIONAL_CLINICAL_CORE_BACKFILL_TRANSFORM_VERSION = "clinical-core-request-v1";

export const RELATIONAL_CLINICAL_CORE_BACKFILL_TABLES = [
  "diagnostic_requests",
  "diagnostic_request_items",
  "samples",
  "sample_item_links",
  "procedures",
  "procedure_schedules",
  "results",
  "result_versions",
  "attachments",
  "notifications"
] as const;

export type RelationalClinicalCoreBackfillStatus = "RUNNING" | "COMPLETED" | "FAILED";

export interface RelationalClinicalCoreBackfillOptions {
  readonly runId?: string;
  readonly transformVersion?: string;
  readonly batchSize?: number;
  readonly signal?: AbortSignal;
}

export interface RelationalClinicalCoreBackfillRun {
  readonly runId: string;
  readonly scope: typeof RELATIONAL_CLINICAL_CORE_BACKFILL_SCOPE;
  readonly sourceAuthority: typeof RELATIONAL_CLINICAL_CORE_BACKFILL_SOURCE;
  readonly targetAuthority: typeof RELATIONAL_CLINICAL_CORE_BACKFILL_TARGET;
  readonly transformVersion: string;
  readonly sourceSnapshotVersion: number;
  readonly sourceSnapshotHash: string;
  readonly status: RelationalClinicalCoreBackfillStatus;
  readonly lastRequestId?: string;
  readonly requestsProcessed: number;
  readonly rowsProjected: number;
  readonly requestsReconciled: number;
  readonly failureCode?: string;
  readonly completedAt?: string;
}

export interface RelationalClinicalCoreBackfillReport {
  readonly runId: string;
  readonly scope: typeof RELATIONAL_CLINICAL_CORE_BACKFILL_SCOPE;
  readonly sourceAuthority: typeof RELATIONAL_CLINICAL_CORE_BACKFILL_SOURCE;
  readonly targetAuthority: typeof RELATIONAL_CLINICAL_CORE_BACKFILL_TARGET;
  readonly transformVersion: string;
  readonly sourceSnapshotVersion: number;
  readonly requestCount: number;
  readonly requestsProcessed: number;
  readonly rowsProjected: number;
  readonly requestsReconciled: number;
  readonly resumedFromRequestId?: string;
}

const BACKFILL_RUN_SELECT = `
SELECT run_id, scope, source_authority, target_authority, transform_version,
       source_snapshot_version::text AS source_snapshot_version,
       source_snapshot_hash, status, last_request_id,
       requests_processed::text AS requests_processed,
       rows_projected::text AS rows_projected,
       requests_reconciled::text AS requests_reconciled,
       failure_code, completed_at::text AS completed_at
  FROM relational_backfill_runs
 WHERE run_id = $1`;

const BACKFILL_RUN_RETURNING = `
run_id, scope, source_authority, target_authority, transform_version,
source_snapshot_version::text AS source_snapshot_version,
source_snapshot_hash, status, last_request_id,
requests_processed::text AS requests_processed,
rows_projected::text AS rows_projected,
requests_reconciled::text AS requests_reconciled,
failure_code, completed_at::text AS completed_at`;

export function normalizeRelationalClinicalCoreBackfillOptions(
  options: RelationalClinicalCoreBackfillOptions = {}
): Required<Pick<RelationalClinicalCoreBackfillOptions, "transformVersion" | "batchSize">> &
  Pick<RelationalClinicalCoreBackfillOptions, "runId" | "signal"> {
  const transformVersion = options.transformVersion ?? RELATIONAL_CLINICAL_CORE_BACKFILL_TRANSFORM_VERSION;
  if (transformVersion !== RELATIONAL_CLINICAL_CORE_BACKFILL_TRANSFORM_VERSION) {
    throw new Error("POSTGRES_RELATIONAL_BACKFILL_TRANSFORM_INVALID");
  }
  const batchSize = options.batchSize ?? 25;
  if (!Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > 100) {
    throw new Error("POSTGRES_RELATIONAL_BACKFILL_BATCH_SIZE_INVALID");
  }
  if (options.runId !== undefined && !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(options.runId)) {
    throw new Error("POSTGRES_RELATIONAL_BACKFILL_RUN_ID_INVALID");
  }
  return { transformVersion, batchSize, runId: options.runId, signal: options.signal };
}

export function relationalClinicalCoreSourceHash(state: StoreState): string {
  return stableHash({
    users: sortRows(state.users),
    services: sortRows(state.services),
    reasonCodes: sortRows(state.reasonCodes),
    requests: sortRows(state.requests),
    items: sortRows(state.items),
    samples: sortRows(state.samples),
    procedures: sortRows(state.procedures),
    schedules: sortRows(state.schedules),
    results: sortRows(state.results),
    resultVersions: sortRows(state.resultVersions),
    attachments: sortRows(state.attachments),
    notifications: sortRows(state.notifications)
  });
}

export function relationalClinicalCoreRequestIds(state: StoreState): readonly string[] {
  const ids = state.requests.map((request) => request.id);
  if (ids.some((id) => typeof id !== "string" || id.length === 0)) {
    throw new Error("POSTGRES_RELATIONAL_BACKFILL_REQUEST_ID_INVALID");
  }
  if (new Set(ids).size !== ids.length) throw new Error("POSTGRES_RELATIONAL_BACKFILL_REQUEST_ID_DUPLICATE");
  return [...ids].sort((left, right) => left.localeCompare(right));
}

/**
 * Returns a lossless request aggregate for the ten tables owned by the current
 * relational clinical-core adapter. Reference/catalog rows are retained only
 * as lookup context for validation; they are never inserted by the backfill.
 */
export function stateForRelationalClinicalRequest(state: StoreState, requestId: string): StoreState {
  const request = state.requests.find((candidate) => candidate.id === requestId);
  if (!request) throw new Error(`POSTGRES_RELATIONAL_BACKFILL_REQUEST_MISSING:${requestId}`);
  const items = state.items.filter((item) => item.requestId === requestId);
  const itemIds = new Set(items.map((item) => item.id));
  const requestItemIds = new Set(request.itemIds);
  if (
    requestItemIds.size !== request.itemIds.length
    || itemIds.size !== requestItemIds.size
    || request.itemIds.some((itemId) => !itemIds.has(itemId))
    || items.some((item) => !requestItemIds.has(item.id))
  ) {
    throw new Error(`POSTGRES_RELATIONAL_BACKFILL_REQUEST_ITEMS_MISMATCH:${requestId}`);
  }
  const samples = state.samples.filter((sample) => sample.requestId === requestId);
  const sampleIds = new Set(samples.map((sample) => sample.id));
  const procedures = state.procedures.filter((procedure) => itemIds.has(procedure.itemId));
  const procedureIds = new Set(procedures.map((procedure) => procedure.id));
  const schedules = state.schedules.filter((schedule) => procedureIds.has(schedule.procedureId));
  const results = state.results.filter((result) => itemIds.has(result.itemId));
  const resultIds = new Set(results.map((result) => result.id));
  const resultVersions = state.resultVersions.filter((version) => resultIds.has(version.resultId));
  const resultVersionIds = new Set(resultVersions.map((version) => version.id));
  const attachments = state.attachments.filter((attachment) => resultVersionIds.has(attachment.resultVersionId));
  const notifications = state.notifications.filter((notification) =>
    notification.entityId === requestId
      || itemIds.has(notification.entityId)
      || sampleIds.has(notification.entityId)
      || resultVersionIds.has(notification.entityId)
  );

  return structuredClone({
    ...state,
    requests: [request],
    items,
    samples,
    procedures,
    schedules,
    results,
    resultVersions,
    attachments,
    notifications
  });
}

export function emptyRelationalClinicalCoreState(state: StoreState): StoreState {
  return {
    ...state,
    requests: [],
    items: [],
    samples: [],
    procedures: [],
    schedules: [],
    results: [],
    resultVersions: [],
    attachments: [],
    notifications: []
  };
}

export function relationalClinicalCoreRowCount(state: StoreState): number {
  return state.requests.length
    + state.items.length
    + state.samples.length
    + state.samples.reduce((total, sample) => total + sample.itemIds.length, 0)
    + state.procedures.length
    + state.schedules.length
    + state.results.length
    + state.resultVersions.length
    + state.attachments.length
    + state.notifications.length;
}

export async function readRelationalClinicalCoreBackfillRun(
  client: RelationalSqlClient,
  runId: string
): Promise<RelationalClinicalCoreBackfillRun | undefined> {
  const result = await client.query(BACKFILL_RUN_SELECT, [runId]);
  if (affectedRows(result) === 0) return undefined;
  if (affectedRows(result) !== 1) throw new Error("POSTGRES_RELATIONAL_BACKFILL_RUN_CARDINALITY_INVALID");
  return parseBackfillRun(result.rows[0]);
}

export async function insertRelationalClinicalCoreBackfillRun(
  client: RelationalSqlClient,
  run: Pick<RelationalClinicalCoreBackfillRun, "runId" | "transformVersion" | "sourceSnapshotVersion" | "sourceSnapshotHash">
): Promise<RelationalClinicalCoreBackfillRun> {
  const result = await client.query(
    `INSERT INTO relational_backfill_runs
      (run_id, scope, source_authority, target_authority, transform_version, source_snapshot_version, source_snapshot_hash, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 'RUNNING')
     RETURNING ${BACKFILL_RUN_RETURNING}`,
    [
      run.runId,
      RELATIONAL_CLINICAL_CORE_BACKFILL_SCOPE,
      RELATIONAL_CLINICAL_CORE_BACKFILL_SOURCE,
      RELATIONAL_CLINICAL_CORE_BACKFILL_TARGET,
      run.transformVersion,
      run.sourceSnapshotVersion,
      run.sourceSnapshotHash
    ]
  );
  if (affectedRows(result) !== 1) throw new Error("POSTGRES_RELATIONAL_BACKFILL_RUN_CREATE_FAILED");
  return parseBackfillRun(result.rows[0]);
}

export async function resumeRelationalClinicalCoreBackfillRun(
  client: RelationalSqlClient,
  runId: string
): Promise<void> {
  const result = await client.query(
    "UPDATE relational_backfill_runs SET status = 'RUNNING', failure_code = NULL, completed_at = NULL, updated_at = now() WHERE run_id = $1 AND status = 'FAILED'",
    [runId]
  );
  if (affectedRows(result) !== 1) throw new Error("POSTGRES_RELATIONAL_BACKFILL_RESUME_FAILED");
}

export async function checkpointRelationalClinicalCoreBackfillRun(
  client: RelationalSqlClient,
  runId: string,
  lastRequestId: string,
  requestsProcessed: number,
  rowsProjected: number,
  requestsReconciled: number
): Promise<void> {
  const result = await client.query(
    `UPDATE relational_backfill_runs
        SET status = 'RUNNING', last_request_id = $2,
            requests_processed = $3, rows_projected = $4,
            requests_reconciled = $5, failure_code = NULL,
            updated_at = now()
      WHERE run_id = $1 AND status = 'RUNNING'`,
    [runId, lastRequestId, requestsProcessed, rowsProjected, requestsReconciled]
  );
  if (affectedRows(result) !== 1) throw new Error("POSTGRES_RELATIONAL_BACKFILL_CHECKPOINT_FAILED");
}

export async function completeRelationalClinicalCoreBackfillRun(
  client: RelationalSqlClient,
  runId: string
): Promise<void> {
  const result = await client.query(
    "UPDATE relational_backfill_runs SET status = 'COMPLETED', completed_at = now(), updated_at = now(), failure_code = NULL WHERE run_id = $1 AND status = 'RUNNING'",
    [runId]
  );
  if (affectedRows(result) !== 1) throw new Error("POSTGRES_RELATIONAL_BACKFILL_COMPLETE_FAILED");
}

export async function failRelationalClinicalCoreBackfillRun(
  client: RelationalSqlClient,
  runId: string,
  failureCode: string
): Promise<void> {
  const result = await client.query(
    "UPDATE relational_backfill_runs SET status = 'FAILED', failure_code = $2, completed_at = NULL, updated_at = now() WHERE run_id = $1 AND status = 'RUNNING'",
    [runId, failureCode]
  );
  if (affectedRows(result) !== 1) throw new Error("POSTGRES_RELATIONAL_BACKFILL_FAILURE_RECORD_FAILED");
}

export async function verifyRelationalClinicalCoreCompleteness(
  client: RelationalSqlClient,
  state: StoreState
): Promise<void> {
  const expected = new Map<string, readonly string[]>([
    ["diagnostic_requests", state.requests.map((request) => request.id)],
    ["diagnostic_request_items", state.items.map((item) => item.id)],
    ["samples", state.samples.map((sample) => sample.id)],
    ["sample_item_links", state.samples.flatMap((sample) => sample.itemIds.map((itemId) => `sample-item-link:${sample.id}:${itemId}`))],
    ["procedures", state.procedures.map((procedure) => procedure.id)],
    ["procedure_schedules", state.schedules.map((schedule) => schedule.id)],
    ["results", state.results.map((result) => result.id)],
    ["result_versions", state.resultVersions.map((version) => version.id)],
    ["attachments", state.attachments.map((attachment) => attachment.id)],
    ["notifications", state.notifications.map((notification) => notification.id)]
  ]);
  for (const table of RELATIONAL_CLINICAL_CORE_BACKFILL_TABLES) {
    const result = await client.query(`SELECT id FROM ${table} ORDER BY id`);
    const actualIds = result.rows.map((value, index) =>
      requiredText(asRecord(value, "POSTGRES_RELATIONAL_BACKFILL_COMPLETENESS_INVALID").id, `completeness:${table}:${index}`)
    );
    const expectedIds = sortIds(expected.get(table) ?? []);
    if (actualIds.length !== expectedIds.length || actualIds.some((id, index) => id !== expectedIds[index])) {
      throw new Error(`POSTGRES_RELATIONAL_BACKFILL_COMPLETENESS_MISMATCH:${table}`);
    }
  }
}

export function backfillFailureCode(error: unknown): string {
  if (error instanceof Error && /^POSTGRES_RELATIONAL_[A-Z0-9_]+/.test(error.message)) {
    return error.message.match(/^POSTGRES_RELATIONAL_[A-Z0-9_]+/)?.[0] ?? "POSTGRES_RELATIONAL_BACKFILL_FAILED";
  }
  if (error && typeof error === "object" && "code" in error && error.code === "40001") {
    return "POSTGRES_RELATIONAL_BACKFILL_SOURCE_CHANGED";
  }
  return "POSTGRES_RELATIONAL_BACKFILL_FAILED";
}

function sortRows<T extends { id: string }>(rows: readonly T[]): readonly T[] {
  return [...rows].sort((left, right) => left.id.localeCompare(right.id));
}

function sortIds(ids: readonly string[]): string[] {
  return [...ids].sort((left, right) => left.localeCompare(right));
}

function parseBackfillRun(value: unknown): RelationalClinicalCoreBackfillRun {
  const row = asRecord(value, "POSTGRES_RELATIONAL_BACKFILL_RUN_INVALID");
  const scope = requiredText(row.scope, "scope");
  const sourceAuthority = requiredText(row.source_authority, "source_authority");
  const targetAuthority = requiredText(row.target_authority, "target_authority");
  const status = requiredText(row.status, "status");
  if (scope !== RELATIONAL_CLINICAL_CORE_BACKFILL_SCOPE) throw new Error("POSTGRES_RELATIONAL_BACKFILL_SCOPE_INVALID");
  if (sourceAuthority !== RELATIONAL_CLINICAL_CORE_BACKFILL_SOURCE) throw new Error("POSTGRES_RELATIONAL_BACKFILL_SOURCE_INVALID");
  if (targetAuthority !== RELATIONAL_CLINICAL_CORE_BACKFILL_TARGET) throw new Error("POSTGRES_RELATIONAL_BACKFILL_TARGET_INVALID");
  if (!(["RUNNING", "COMPLETED", "FAILED"] as const).includes(status as RelationalClinicalCoreBackfillStatus)) {
    throw new Error("POSTGRES_RELATIONAL_BACKFILL_STATUS_INVALID");
  }
  const sourceSnapshotHash = requiredText(row.source_snapshot_hash, "source_snapshot_hash");
  if (!/^[a-f0-9]{64}$/.test(sourceSnapshotHash)) throw new Error("POSTGRES_RELATIONAL_BACKFILL_SOURCE_HASH_INVALID");
  return {
    runId: requiredText(row.run_id, "run_id"),
    scope,
    sourceAuthority,
    targetAuthority,
    transformVersion: requiredText(row.transform_version, "transform_version"),
    sourceSnapshotVersion: positiveInteger(row.source_snapshot_version, "source_snapshot_version"),
    sourceSnapshotHash,
    status: status as RelationalClinicalCoreBackfillStatus,
    lastRequestId: optionalText(row.last_request_id),
    requestsProcessed: nonnegativeInteger(row.requests_processed, "requests_processed"),
    rowsProjected: nonnegativeInteger(row.rows_projected, "rows_projected"),
    requestsReconciled: nonnegativeInteger(row.requests_reconciled, "requests_reconciled"),
    failureCode: optionalText(row.failure_code),
    completedAt: optionalText(row.completed_at)
  };
}

function affectedRows(result: RelationalSqlResult): number {
  return typeof result.rowCount === "number" ? result.rowCount : result.rows.length;
}

function asRecord(value: unknown, errorCode: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(errorCode);
  return value as Record<string, unknown>;
}

function requiredText(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) throw new Error(`POSTGRES_RELATIONAL_BACKFILL_FIELD_INVALID:${field}`);
  return value;
}

function optionalText(value: unknown): string | undefined {
  return value === null || value === undefined ? undefined : requiredText(value, "optional_text");
}

function positiveInteger(value: unknown, field: string): number {
  const numeric = numericValue(value);
  if (!Number.isSafeInteger(numeric) || numeric < 1) throw new Error(`POSTGRES_RELATIONAL_BACKFILL_FIELD_INVALID:${field}`);
  return numeric;
}

function nonnegativeInteger(value: unknown, field: string): number {
  const numeric = numericValue(value);
  if (!Number.isSafeInteger(numeric) || numeric < 0) throw new Error(`POSTGRES_RELATIONAL_BACKFILL_FIELD_INVALID:${field}`);
  return numeric;
}

function numericValue(value: unknown): number {
  if (typeof value === "bigint") return Number(value);
  if (typeof value === "number") return value;
  if (typeof value === "string" && /^\d+$/.test(value)) return Number(value);
  return Number.NaN;
}
