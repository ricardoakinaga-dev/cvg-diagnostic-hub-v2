import type { ArchivedCollection, ClinicalArchivePurgeSummary, ClinicalArchiveQuery, ClinicalArchiveRow } from "../domain/models";
import type { ClinicalArchivePlan } from "../domain/clinical-archive";
import type { EntityQueryable } from "./postgres-entity-state";

/** Narrow SQL for the clinical archive (migration 017). Rows are written in the writer's transaction. */
const INSERT_BATCH_SIZE = 2_000;
/** Bounds one purge transaction; the daily job simply continues on its next run. */
export const PURGE_REQUEST_LIMIT = 5_000;

const INSERT_BATCH_SQL = `INSERT INTO cvg_clinical_archive_batches (id, archived_at, cutoff, request_count, entity_count, attachment_count, actor)
  VALUES ($1, $2::timestamptz, $3::timestamptz, $4, $5, $6, $7)`;
const INSERT_ROWS_SQL = `INSERT INTO cvg_clinical_archive (request_id, collection, entity_key, position, data, archived_at, archive_batch)
  SELECT entry.request_id, entry.collection, entry.entity_key, entry.position, entry.data, $2::timestamptz, $3
    FROM jsonb_to_recordset($1::jsonb) AS entry(request_id text, collection text, entity_key text, position bigint, data jsonb)`;
const REQUEST_IDS_SQL = `SELECT request_id FROM cvg_clinical_archive
   WHERE collection = 'requests'
     AND ($1::text IS NULL OR data->>'patientId' = $1)
     AND ($2::text IS NULL OR request_id = $2)
   ORDER BY data->>'updatedAt' DESC, request_id
   LIMIT $3::int OFFSET $4::int`;
const ROWS_SQL = `SELECT request_id, collection, entity_key, position, data, archived_at, archive_batch
  FROM cvg_clinical_archive WHERE request_id = ANY($1::text[]) ORDER BY request_id, collection, position`;
const DUE_REQUESTS_SQL = `SELECT request_id FROM cvg_clinical_archive
   WHERE collection = 'requests' AND archived_at <= $1::timestamptz
   ORDER BY archived_at, request_id LIMIT $2`;
const DUE_SUMMARY_SQL = `SELECT count(*)::int AS entities,
       COALESCE(array_agg(data->>'storageKey') FILTER (WHERE collection = 'attachments'), ARRAY[]::text[]) AS attachment_keys
  FROM cvg_clinical_archive WHERE request_id = ANY($1::text[])`;
const DELETE_DUE_SQL = "DELETE FROM cvg_clinical_archive WHERE request_id = ANY($1::text[])";

interface ArchiveRowRecord {
  readonly request_id: string;
  readonly collection: ArchivedCollection;
  readonly entity_key: string;
  readonly position: string | number;
  readonly data: Record<string, unknown>;
  readonly archived_at: Date | string;
  readonly archive_batch: string;
}

export async function insertClinicalArchive(
  client: EntityQueryable,
  plan: ClinicalArchivePlan,
  batch: { id: string; archivedAt: Date; actor?: string }
): Promise<void> {
  const { partition } = plan;
  await client.query(INSERT_BATCH_SQL, [batch.id, batch.archivedAt.toISOString(), plan.cutoff.toISOString(), partition.requestIds.length, partition.entities.length, partition.attachmentCount, batch.actor ?? null]);
  const rows = partition.entities.map((archived) => ({
    request_id: archived.requestId,
    collection: archived.collection,
    entity_key: archived.entityKey,
    position: archived.position,
    data: archived.entity
  }));
  for (let start = 0; start < rows.length; start += INSERT_BATCH_SIZE) {
    const chunk = rows.slice(start, start + INSERT_BATCH_SIZE);
    const written = await client.query(INSERT_ROWS_SQL, [JSON.stringify(chunk), batch.archivedAt.toISOString(), batch.id]);
    if (written.rowCount !== chunk.length) throw new Error("POSTGRES_CLINICAL_ARCHIVE_DIVERGED:insert");
  }
}

function archiveRow(record: ArchiveRowRecord): ClinicalArchiveRow {
  return {
    requestId: record.request_id,
    collection: record.collection,
    entityKey: record.entity_key,
    position: Number(record.position),
    data: record.data,
    archivedAt: new Date(record.archived_at).toISOString(),
    archiveBatch: record.archive_batch
  };
}

/** Rows of the newest `limit` archived requests that match, after skipping `offset` (all of them without a limit: LIMIT NULL); request order follows REQUEST_IDS_SQL. */
export async function readClinicalArchiveRows(client: EntityQueryable, query: ClinicalArchiveQuery): Promise<ClinicalArchiveRow[]> {
  const ids = (await client.query(REQUEST_IDS_SQL, [query.patientId ?? null, query.requestId ?? null, query.limit ?? null, query.offset ?? 0])).rows as { request_id: string }[];
  if (ids.length === 0) return [];
  return ((await client.query(ROWS_SQL, [ids.map((row) => row.request_id)])).rows as ArchiveRowRecord[]).map(archiveRow);
}

export async function readArchivedRequestRows(client: EntityQueryable, requestId: string): Promise<ClinicalArchiveRow[] | undefined> {
  const rows = ((await client.query(ROWS_SQL, [[requestId]])).rows as ArchiveRowRecord[]).map(archiveRow);
  return rows.some((row) => row.collection === "requests") ? rows : undefined;
}

/** Counts (and optionally deletes) the archived requests archived at or before `cutoff`. */
export async function purgeClinicalArchiveRows(client: EntityQueryable, cutoff: Date, apply: boolean): Promise<ClinicalArchivePurgeSummary> {
  const due = ((await client.query(DUE_REQUESTS_SQL, [cutoff.toISOString(), PURGE_REQUEST_LIMIT])).rows as { request_id: string }[]).map((row) => row.request_id);
  if (due.length === 0) return { requestsPurged: 0, entitiesPurged: 0, attachmentKeys: [] };
  const found = (await client.query(DUE_SUMMARY_SQL, [due])).rows[0] as { entities: number; attachment_keys: string[] };
  if (apply) {
    const removed = await client.query(DELETE_DUE_SQL, [due]);
    if (removed.rowCount !== found.entities) throw new Error("POSTGRES_CLINICAL_ARCHIVE_DIVERGED:purge");
  }
  return { requestsPurged: due.length, entitiesPurged: found.entities, attachmentKeys: found.attachment_keys };
}
