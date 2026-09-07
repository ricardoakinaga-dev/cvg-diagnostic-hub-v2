import { createHash } from "node:crypto";

/**
 * The backfill runner is deliberately storage-neutral. A PostgreSQL adapter
 * supplies the source page, target upsert and checkpoint persistence; this
 * module owns the ordering, cursor semantics and reconciliation contract.
 * It can therefore be exercised without pretending that a local memory test
 * is a live database migration.
 */
export const RELATIONAL_BACKFILL_PHASES = [
  "departments",
  "roles",
  "users",
  "sessions",
  "auth_identities",
  "owners",
  "patients",
  "patient_owners",
  "external_references",
  "encounters",
  "admissions",
  "user_roles",
  "diagnostic_services",
  "service_instructions",
  "sla_policies",
  "critical_result_policies",
  "reason_codes",
  "request_code_sequences",
  "diagnostic_requests",
  "diagnostic_request_items",
  "samples",
  "sample_item_links",
  "procedures",
  "procedure_schedules",
  "results",
  "result_versions",
  "result_components",
  "attachments",
  "notifications",
  "notification_deliveries",
  "acknowledgements",
  "idempotency_keys",
  "outbox_messages"
] as const;

export type RelationalBackfillPhase = (typeof RELATIONAL_BACKFILL_PHASES)[number];

export interface RelationalBackfillRow {
  readonly id: string;
  readonly value: Readonly<Record<string, unknown>>;
}

export interface RelationalBackfillPage {
  readonly rows: readonly RelationalBackfillRow[];
  readonly nextCursor?: string;
  readonly done: boolean;
}

export interface RelationalBackfillCheckpoint {
  readonly transformVersion: string;
  readonly phase?: RelationalBackfillPhase;
  readonly cursor?: string;
}

export interface RelationalBackfillSource {
  page(phase: RelationalBackfillPhase, afterId: string | undefined, limit: number): Promise<RelationalBackfillPage>;
}

export interface RelationalBackfillTarget {
  upsert(phase: RelationalBackfillPhase, row: RelationalBackfillRow): Promise<void>;
  hash(phase: RelationalBackfillPhase, id: string): Promise<string | undefined>;
}

export interface RelationalBackfillCheckpointStore {
  read(): Promise<RelationalBackfillCheckpoint | undefined>;
  write(checkpoint: RelationalBackfillCheckpoint): Promise<void>;
}

export interface RelationalBackfillOptions {
  readonly source: RelationalBackfillSource;
  readonly target: RelationalBackfillTarget;
  readonly checkpoint: RelationalBackfillCheckpointStore;
  readonly transformVersion: string;
  readonly batchSize?: number;
  readonly signal?: AbortSignal;
}

export interface RelationalBackfillReconciliation {
  readonly phase: RelationalBackfillPhase;
  readonly id: string;
  readonly sourceHash: string;
  readonly targetHash: string;
}

export interface RelationalBackfillReport {
  readonly transformVersion: string;
  readonly counts: Readonly<Partial<Record<RelationalBackfillPhase, number>>>;
  readonly reconciled: readonly RelationalBackfillReconciliation[];
  readonly resumedFrom?: RelationalBackfillCheckpoint;
}

export class RelationalBackfillMismatchError extends Error {
  constructor(readonly mismatch: RelationalBackfillReconciliation) {
    super(`RELATIONAL_BACKFILL_MISMATCH:${mismatch.phase}:${mismatch.id}`);
    this.name = "RelationalBackfillMismatchError";
  }
}

export class RelationalBackfillPostWriteMismatchError extends Error {
  constructor(readonly mismatch: RelationalBackfillReconciliation) {
    super(`RELATIONAL_BACKFILL_POST_WRITE_MISMATCH:${mismatch.phase}:${mismatch.id}`);
    this.name = "RelationalBackfillPostWriteMismatchError";
  }
}

export async function runRelationalBackfill(options: RelationalBackfillOptions): Promise<RelationalBackfillReport> {
  const transformVersion = options.transformVersion.trim();
  if (!transformVersion || transformVersion.length > 100) throw new Error("RELATIONAL_BACKFILL_TRANSFORM_VERSION_INVALID");
  const batchSize = options.batchSize ?? 100;
  if (!Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > 1_000) throw new Error("RELATIONAL_BACKFILL_BATCH_SIZE_INVALID");

  const previous = await options.checkpoint.read();
  if (previous && previous.transformVersion !== transformVersion) {
    throw new Error(`RELATIONAL_BACKFILL_TRANSFORM_MISMATCH:${previous.transformVersion}:${transformVersion}`);
  }
  const startIndex = previous?.phase ? RELATIONAL_BACKFILL_PHASES.indexOf(previous.phase) : 0;
  if (startIndex < 0) throw new Error("RELATIONAL_BACKFILL_CHECKPOINT_PHASE_INVALID");

  const counts: Partial<Record<RelationalBackfillPhase, number>> = {};
  const reconciled: RelationalBackfillReconciliation[] = [];
  for (let phaseIndex = startIndex; phaseIndex < RELATIONAL_BACKFILL_PHASES.length; phaseIndex += 1) {
    const phase = RELATIONAL_BACKFILL_PHASES[phaseIndex];
    let cursor = previous?.phase === phase ? previous.cursor : undefined;
    let completed = false;
    while (!completed) {
      assertNotAborted(options.signal);
      const page = await options.source.page(phase, cursor, batchSize);
      assertPageOrder(page.rows, cursor);
      for (const row of page.rows) {
        assertNotAborted(options.signal);
        const sourceHash = stableHash(row.value);
        const targetHash = await options.target.hash(phase, row.id);
        if (targetHash !== undefined && targetHash !== sourceHash) {
          throw new RelationalBackfillMismatchError({ phase, id: row.id, sourceHash, targetHash });
        }
        if (targetHash !== undefined) reconciled.push({ phase, id: row.id, sourceHash, targetHash });
        await options.target.upsert(phase, row);
        const postWriteHash = await options.target.hash(phase, row.id);
        if (postWriteHash !== sourceHash) {
          throw new RelationalBackfillPostWriteMismatchError({
            phase,
            id: row.id,
            sourceHash,
            targetHash: postWriteHash ?? "<missing>"
          });
        }
        counts[phase] = (counts[phase] ?? 0) + 1;
        cursor = row.id;
        await options.checkpoint.write({ transformVersion, phase, cursor });
      }
      completed = page.done;
      if (!completed && page.rows.length === 0 && page.nextCursor === cursor) {
        throw new Error(`RELATIONAL_BACKFILL_CURSOR_STALLED:${phase}`);
      }
      if (!completed && page.nextCursor === undefined) throw new Error(`RELATIONAL_BACKFILL_CURSOR_MISSING:${phase}`);
      if (!completed && page.nextCursor !== undefined && page.rows.length > 0 && page.nextCursor !== cursor) {
        throw new Error(`RELATIONAL_BACKFILL_CURSOR_MISMATCH:${phase}`);
      }
      if (page.nextCursor !== undefined && page.nextCursor !== cursor) cursor = page.nextCursor;
      if (completed) await options.checkpoint.write({ transformVersion, phase, cursor });
    }
  }
  return { transformVersion, counts, reconciled, resumedFrom: previous };
}

export function stableHash(value: unknown): string {
  return createHash("sha256").update(stableSerialize(value)).digest("hex");
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

function assertPageOrder(rows: readonly RelationalBackfillRow[], cursor: string | undefined): void {
  let previous = cursor;
  for (const row of rows) {
    if (!row.id || (previous !== undefined && row.id <= previous)) throw new Error("RELATIONAL_BACKFILL_PAGE_NOT_ORDERED");
    previous = row.id;
  }
}

function assertNotAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new Error("RELATIONAL_BACKFILL_ABORTED");
}
