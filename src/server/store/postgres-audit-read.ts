import type { AuditEntity, AuditEvent, AuditMetrics, AuditMetricsQuery, AuditReadPage, AuditReadQuery, AuditTransactionReader } from "../domain/models";
import type { SqlQueryable } from "./migrations";
import { assertAuditReadQuery } from "./audit-read";

const EVENT_COLUMNS = `id, event_type AS "eventType", actor_id AS "actorId", entity_type AS "entityType", entity_id AS "entityId",
  previous_state AS "previousState", new_state AS "newState", correlation_id AS "correlationId", metadata, occurred_at AS "occurredAt"`;

function eventFromRow(row: AuditEvent): AuditEvent {
  const { actorId, previousState, newState, ...event } = row;
  return { ...event, occurredAt: new Date(row.occurredAt).toISOString(),
    ...(actorId == null ? {} : { actorId }), ...(previousState == null ? {} : { previousState }), ...(newState == null ? {} : { newState }) };
}

export async function readPostgresAuditEvents(sql: SqlQueryable, query: AuditReadQuery): Promise<AuditReadPage> {
  assertAuditReadQuery(query);
  const comparator = query.order === "asc" ? ">" : "<";
  const direction = query.order === "asc" ? "ASC" : "DESC";
  const result = await sql.query(`WITH authorized AS NOT MATERIALIZED (
    SELECT ${EVENT_COLUMNS} FROM audit_events event WHERE
      EXISTS (SELECT 1 FROM jsonb_to_recordset($1::jsonb) AS entity("entityType" text, "entityId" text)
        WHERE entity."entityType" = event.entity_type AND entity."entityId" = event.entity_id)
      OR event.entity_type = ANY($2::text[])
      OR ($3::boolean AND NOT EXISTS (
        SELECT 1 FROM jsonb_to_recordset($4::jsonb) AS entity("entityType" text, "entityId" text)
        WHERE entity."entityType" = event.entity_type AND entity."entityId" = event.entity_id))
  ) SELECT (SELECT count(*)::text FROM authorized) AS total,
    COALESCE((SELECT jsonb_agg(to_jsonb(page) ORDER BY "occurredAt" ${direction}, id COLLATE "C" ASC) FROM (
      SELECT * FROM authorized WHERE $5::timestamptz IS NULL OR "occurredAt" ${comparator} $5::timestamptz
        OR ("occurredAt" = $5::timestamptz AND id COLLATE "C" > $6::text COLLATE "C")
      ORDER BY "occurredAt" ${direction}, id COLLATE "C" ASC LIMIT $7
    ) page), '[]'::jsonb) AS events`, [
    JSON.stringify(query.scope.entities), query.scope.entityTypes ?? [], Boolean(query.scope.unresolved),
    JSON.stringify(query.scope.unresolved?.resolvedEntities ?? []), query.cursor?.occurredAt ?? null, query.cursor?.id ?? null, query.limit + 1
  ]);
  const row = result.rows[0] as { total: string; events: AuditEvent[] };
  return { total: Number(row.total), items: row.events.slice(0, query.limit).map(eventFromRow), hasMore: row.events.length > query.limit };
}

/** ID-only matching preserves the existing reviewer search contract. */
export async function readPostgresAuditActors(sql: SqlQueryable, entities: AuditEntity[], actorIds?: readonly string[]): Promise<{ entityId: string; actorId: string }[]> {
  if (!entities.length || actorIds?.length === 0) return [];
  const entityIds = [...new Set(entities.map((entity) => entity.entityId))];
  const result = actorIds
    ? await sql.query(`SELECT DISTINCT entity_id AS "entityId", actor_id AS "actorId"
      FROM audit_events WHERE actor_id = ANY($2::text[]) AND entity_id = ANY($1::text[])`, [entityIds, [...new Set(actorIds)]])
    : await sql.query(`SELECT DISTINCT entity_id AS "entityId", actor_id AS "actorId"
      FROM audit_events WHERE entity_id = ANY($1::text[]) AND actor_id IS NOT NULL`, [entityIds]);
  return result.rows as { entityId: string; actorId: string }[];
}

export function postgresAuditTransactionReader(sql: SqlQueryable): AuditTransactionReader {
  return { hasAuditEvent: async (query) => {
    const result = await sql.query(`SELECT EXISTS (SELECT 1 FROM audit_events
      WHERE entity_type = $1 AND entity_id = $2 AND actor_id = $3 AND event_type = $4) AS present`,
    [query.entityType, query.entityId, query.actorId, query.eventType]);
    return (result.rows[0] as { present: boolean }).present;
  } };
}

export async function readPostgresAuditMetrics(sql: SqlQueryable, query: AuditMetricsQuery): Promise<AuditMetrics> {
  const result = await sql.query(`SELECT
    (SELECT count(DISTINCT sample."requestId")::float8 FROM audit_events event
      JOIN jsonb_to_recordset($1::jsonb) AS sample(id text, "requestId" text) ON sample.id = event.entity_id
      WHERE event.event_type = 'RecollectionRequested') AS recollections,
    (SELECT avg(GREATEST(0, extract(epoch FROM event.occurred_at) - version."releasedAtMs" / 1000.0))::float8 FROM audit_events event
      JOIN jsonb_to_recordset($2::jsonb) AS version(id text, "releasedAtMs" double precision) ON version.id = event.entity_id
      WHERE event.event_type = 'ResultViewed') AS latency`,
    [JSON.stringify(query.samples), JSON.stringify(query.releasedVersions.filter((version) => Number.isFinite(version.releasedAtMs)))]);
  const row = result.rows[0] as { recollections: number; latency: number | null };
  return { recollectionRate: query.requestCount > 0 ? row.recollections / query.requestCount : undefined, resultViewLatencySeconds: row.latency ?? undefined };
}

/** An authorized reset may replay identical fixture events, never rewrite them. */
export async function auditEventsForReset(sql: SqlQueryable, events: AuditEvent[]): Promise<AuditEvent[]> {
  if (!events.length) return [];
  const result = await sql.query(`SELECT ${EVENT_COLUMNS} FROM audit_events WHERE id = ANY($1::text[])`, [events.map((event) => event.id)]);
  const existing = new Map((result.rows as AuditEvent[]).map((row) => [row.id, eventFromRow(row)]));
  return events.filter((event) => {
    const persisted = existing.get(event.id);
    if (!persisted) return true;
    // Compare canonical timestamps/optional fields and metadata key order.
    const canonical = (entry: AuditEvent) => JSON.stringify([
      entry.id, entry.eventType, entry.actorId ?? null, entry.entityType, entry.entityId,
      entry.previousState ?? null, entry.newState ?? null, entry.correlationId,
      Object.entries(entry.metadata).sort(([left], [right]) => left.localeCompare(right)), new Date(entry.occurredAt).toISOString()
    ]);
    if (canonical(event) !== canonical(persisted)) throw new Error("POSTGRES_AUDIT_LOG_MUTATION");
    return false;
  });
}

/** Inserts one audit event into the append-only table; a second insert of the same id is a divergence, never a no-op. */
export async function insertPostgresAuditEvent(sql: SqlQueryable, event: AuditEvent): Promise<void> {
  const inserted = await sql.query(
    "INSERT INTO audit_events (id, event_type, actor_id, entity_type, entity_id, previous_state, new_state, correlation_id, metadata, occurred_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10) ON CONFLICT (id) DO NOTHING RETURNING id",
    [event.id, event.eventType, event.actorId ?? null, event.entityType, event.entityId, event.previousState ?? null, event.newState ?? null, event.correlationId, JSON.stringify(event.metadata), event.occurredAt]
  );
  if (inserted.rowCount !== 1) throw new Error(`POSTGRES_AUDIT_PROJECTION_DIVERGED:${event.id}`);
}
