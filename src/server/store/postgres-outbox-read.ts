import type { PoolClient } from "pg";
import type { SqlQueryable } from "./migrations";
import { outboxEnvelopeFor } from "../domain/models";
import type { OutboxMessage, OutboxTransactionQuery, RuntimeRetentionOptions } from "../domain/models";
import { outboxReadLimit } from "../domain/outbox-read";
import { outboxRetentionPolicy } from "./runtime-retention";

const COLUMNS = `id, event_type AS "eventType", aggregate_type AS "aggregateType", aggregate_id AS "aggregateId",
  payload, consumer_type AS "consumerType", routing_key AS "routingKey", status, attempts,
  available_at AS "availableAt", correlation_id AS "correlationId", locked_at AS "lockedAt", worker_id AS "workerId",
  claim_token AS "claimToken", last_error AS "lastError", dead_lettered_at AS "deadLetteredAt",
  discarded_at AS "discardedAt", discarded_by AS "discardedBy", discard_reason AS "discardReason"`;

export function outboxFromRow(row: OutboxMessage): OutboxMessage {
  const message = { ...row, availableAt: new Date(row.availableAt).toISOString() };
  for (const key of ["lockedAt", "deadLetteredAt", "discardedAt"] as const) {
    if (row[key]) message[key] = new Date(row[key]).toISOString();
    else delete message[key];
  }
  for (const key of ["workerId", "claimToken", "lastError", "discardedBy", "discardReason"] as const) {
    if (row[key] === null || row[key] === undefined) delete message[key];
  }
  return message;
}

export async function readPostgresOutbox(client: SqlQueryable, query: { kind: "replay" | "dead-letter"; limit: number }): Promise<OutboxMessage[]> {
  const limit = outboxReadLimit(query.limit);
  const replay = query.kind === "replay";
  const result = await client.query(`SELECT ${COLUMNS} FROM outbox_messages
    WHERE status IN (${replay ? "'PENDING', 'PROCESSED'" : "'FAILED', 'DISCARDED'"})
    ORDER BY ${replay ? "event_position DESC" : "COALESCE(dead_lettered_at, available_at) DESC, event_position ASC"} LIMIT $1`, [limit]);
  const messages = (result.rows as readonly OutboxMessage[]).map(outboxFromRow);
  return replay ? messages.reverse() : messages;
}

/** Called after the snapshot lock: all command/worker locks have the same order. */
export async function lockPostgresOutbox(client: PoolClient, query: OutboxTransactionQuery): Promise<OutboxMessage[]> {
  if (query.kind === "message") {
    const result = await client.query<OutboxMessage>(`SELECT ${COLUMNS} FROM outbox_messages WHERE id = $1 FOR UPDATE`, [query.id]);
    return result.rows.map(outboxFromRow);
  }
  let cursor = "0";
  for (;;) {
    const result = await client.query<OutboxMessage & { position: string }>(`SELECT ${COLUMNS}, event_position::text AS position
      FROM outbox_messages WHERE event_position > $1::bigint AND
      ((status = 'PENDING' AND available_at <= $2::timestamptz) OR
       (status = 'PROCESSING' AND (locked_at IS NULL OR locked_at <= $2::timestamptz - $3::double precision * interval '1 millisecond')))
      ORDER BY event_position LIMIT 100 FOR UPDATE SKIP LOCKED`, [cursor, query.now, query.leaseMs]);
    for (const row of result.rows) {
      const { position, ...raw } = row;
      cursor = position;
      const message = outboxFromRow(raw);
      if (query.accepts(message)) return [message];
    }
    if (result.rows.length < 100) return [];
  }
}

export async function readPostgresOutboxMetrics(client: SqlQueryable): Promise<{ pending: number; oldestAvailableAt?: string }> {
  // Only notification deliveries are worker work; domain events are replay history (outboxMessageSettled).
  const result = await client.query(`SELECT count(*)::text AS pending, min(available_at) AS oldest
    FROM outbox_messages WHERE status IN ('PENDING', 'PROCESSING') AND consumer_type = 'NOTIFICATION_DELIVERY'`);
  const row = result.rows[0] as { pending: string; oldest: Date | null };
  return { pending: Number(row.pending), ...(row.oldest ? { oldestAvailableAt: row.oldest.toISOString() } : {}) };
}

export async function prunePostgresOutbox(client: PoolClient, options: RuntimeRetentionOptions, now: Date): Promise<number> {
  const { hotWindow, retentionMs } = outboxRetentionPolicy(options);
  // Settled = processed, or a domain event (no worker consumer). Same window and hot set for both.
  const settled = "(status = 'PROCESSED' OR (status = 'PENDING' AND consumer_type = 'DOMAIN_EVENT'))";
  const result = await client.query(`DELETE FROM outbox_messages WHERE ${settled} AND id NOT IN (
    SELECT id FROM outbox_messages WHERE ${settled} AND available_at >= $1::timestamptz - $2::double precision * interval '1 millisecond'
    ORDER BY event_position DESC LIMIT $3)`, [now.toISOString(), retentionMs, hotWindow]);
  return result.rowCount ?? 0;
}

export const REALTIME_OUTBOX_SQL = `SELECT state, version,
  COALESCE((SELECT jsonb_agg(message ORDER BY position) FROM (
    SELECT to_jsonb(entry) - 'position' AS message, position FROM (
      SELECT ${COLUMNS}, event_position AS position FROM outbox_messages
      WHERE status IN ('PENDING', 'PROCESSED') ORDER BY event_position DESC LIMIT $1
    ) entry
  ) replay), '[]'::jsonb) AS outbox
  FROM cvg_runtime_state WHERE id = 1`;

/** Seed snapshot and both event authorities in one concurrent-safe statement. */
export const RUNTIME_SEED_WITH_EVENTS_SQL = `WITH source AS (SELECT $1::jsonb AS state), seeded AS (
          INSERT INTO cvg_runtime_state (id, state)
          SELECT 1, jsonb_set(jsonb_set(state, '{auditEvents}', '[]'::jsonb), '{outbox}', '[]'::jsonb) FROM source
          ON CONFLICT (id) DO NOTHING RETURNING id
        ), seeded_users AS (
          INSERT INTO users (id, email, display_name, password_hash, timezone, active, created_at, updated_at, version)
          SELECT person.id, email, "displayName", "passwordHash", timezone, COALESCE(active, true), "createdAt", now(), version
          FROM source, seeded, jsonb_to_recordset(source.state->'users') AS person (
            id text, email text, "displayName" text, "passwordHash" text, timezone text, active boolean, "createdAt" timestamptz, version integer)
          WHERE EXISTS (SELECT 1 FROM jsonb_array_elements(source.state->'notifications') notification
            WHERE notification->>'recipientUserId' = person.id OR notification->>'acknowledgedBy' = person.id)
          ON CONFLICT (id) DO UPDATE SET email = EXCLUDED.email, display_name = EXCLUDED.display_name,
            password_hash = EXCLUDED.password_hash, timezone = EXCLUDED.timezone, active = EXCLUDED.active,
            version = EXCLUDED.version, updated_at = now() RETURNING id
        ), seeded_notifications AS (
          INSERT INTO notifications (id, category, priority, recipient_user_id, entity_type, entity_id, deep_link, title, body,
            dedupe_key, state, created_at, acknowledged_at, acknowledged_by, attempts, version)
          SELECT notification.id, category, priority, "recipientUserId", "entityType", "entityId", "deepLink", title, body,
            "dedupeKey", notification.state, "createdAt", "acknowledgedAt", "acknowledgedBy", attempts, version
          FROM source, seeded, (SELECT count(*) FROM seeded_users) users_ready,
            jsonb_to_recordset(source.state->'notifications') AS notification (id text, category text, priority text,
              "recipientUserId" text, "entityType" text, "entityId" text, "deepLink" text, title text, body text,
              "dedupeKey" text, state text, "createdAt" timestamptz, "acknowledgedAt" timestamptz,
              "acknowledgedBy" text, attempts integer, version integer) RETURNING id
        ), audited AS (INSERT INTO audit_events (id, event_type, actor_id, entity_type, entity_id, previous_state, new_state, correlation_id, metadata, occurred_at)
          SELECT event.id, "eventType", "actorId", "entityType", "entityId", "previousState", "newState", "correlationId", metadata, "occurredAt"
          FROM source, seeded, jsonb_to_recordset(source.state->'auditEvents') AS event(
            id text, "eventType" text, "actorId" text, "entityType" text, "entityId" text,
            "previousState" text, "newState" text, "correlationId" text, metadata jsonb, "occurredAt" timestamptz) RETURNING id)
        INSERT INTO outbox_messages (id, event_type, aggregate_type, aggregate_id, payload, consumer_type, routing_key,
          status, attempts, available_at, correlation_id, locked_at, worker_id, claim_token, last_error,
          dead_lettered_at, discarded_at, discarded_by, discard_reason)
        SELECT message.id, "eventType", "aggregateType", "aggregateId", payload, "consumerType", "routingKey",
          status, attempts, "availableAt", "correlationId", "lockedAt", "workerId", "claimToken", "lastError",
          "deadLetteredAt", "discardedAt", "discardedBy", "discardReason"
        FROM source, seeded, jsonb_array_elements(source.state->'outbox') WITH ORDINALITY AS entries(value, ordinal),
          jsonb_to_record(entries.value) AS message (
          id text, "eventType" text, "aggregateType" text, "aggregateId" text, payload jsonb, "consumerType" text,
          "routingKey" text, status text, attempts integer, "availableAt" timestamptz, "correlationId" text,
          "lockedAt" timestamptz, "workerId" text, "claimToken" text, "lastError" text,
          "deadLetteredAt" timestamptz, "discardedAt" timestamptz, "discardedBy" text, "discardReason" text)
        ORDER BY entries.ordinal`;

export async function projectPostgresOutbox(client: PoolClient, before: OutboxMessage[], after: OutboxMessage[]): Promise<void> {
    const previousOutbox = new Map(before.map((event) => [event.id, event]));
    for (const message of after.filter((entry) => !previousOutbox.has(entry.id))) {
      const envelope = outboxEnvelopeFor(message.eventType, message.payload, message.consumerType, message.routingKey);
      const inserted = await client.query(
        "INSERT INTO outbox_messages (id, event_type, aggregate_type, aggregate_id, payload, consumer_type, routing_key, status, attempts, available_at, correlation_id, locked_at, worker_id, claim_token, last_error, dead_lettered_at, discarded_at, discarded_by, discard_reason) VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19) ON CONFLICT (id) DO NOTHING RETURNING id",
        [message.id, message.eventType, message.aggregateType, message.aggregateId, JSON.stringify(message.payload), envelope.consumerType, envelope.routingKey, message.status, message.attempts, message.availableAt, message.correlationId, message.lockedAt ?? null, message.workerId ?? null, message.claimToken ?? null, message.lastError ?? null, message.deadLetteredAt ?? null, message.discardedAt ?? null, message.discardedBy ?? null, message.discardReason ?? null]
      );
      if (inserted.rowCount !== 1) throw new Error(`POSTGRES_OUTBOX_PROJECTION_DIVERGED:${message.id}`);
    }
    for (const message of after) {
      const previous = previousOutbox.get(message.id);
      if (!previous || JSON.stringify(previous) === JSON.stringify(message)) continue;
      if (previous.eventType !== message.eventType || previous.aggregateType !== message.aggregateType
        || previous.aggregateId !== message.aggregateId || previous.correlationId !== message.correlationId
        || JSON.stringify(previous.payload) !== JSON.stringify(message.payload)
        || previous.consumerType !== message.consumerType || previous.routingKey !== message.routingKey) {
        throw new Error(`POSTGRES_OUTBOX_IDENTITY_MUTATION:${message.id}`);
      }
      const envelope = outboxEnvelopeFor(message.eventType, message.payload, message.consumerType, message.routingKey);
      const updated = await client.query(
        "UPDATE outbox_messages SET consumer_type = $2, routing_key = $3, status = $4, attempts = $5, available_at = $6, locked_at = $7, worker_id = $8, claim_token = $9, last_error = $10, dead_lettered_at = $11, discarded_at = $12, discarded_by = $13, discard_reason = $14 WHERE id = $1",
        [message.id, envelope.consumerType, envelope.routingKey, message.status, message.attempts, message.availableAt, message.lockedAt ?? null, message.workerId ?? null, message.claimToken ?? null, message.lastError ?? null, message.deadLetteredAt ?? null, message.discardedAt ?? null, message.discardedBy ?? null, message.discardReason ?? null]
      );
      if (updated.rowCount !== 1) throw new Error(`POSTGRES_OUTBOX_PROJECTION_DIVERGED:${message.id}`);
    }
}
