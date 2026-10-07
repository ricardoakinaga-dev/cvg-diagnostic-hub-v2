-- Coordinated cutover: stop old app/worker writers before applying this migration.
-- The row lock serializes legacy reconciliation with snapshot writes. The runner
-- commits the data, constraint and ledger entry together; a mismatch rolls back.
DO $$
DECLARE
  snapshot jsonb;
BEGIN
  SELECT state INTO snapshot FROM cvg_runtime_state WHERE id = 1 FOR UPDATE;
  IF snapshot IS NOT NULL THEN
    IF jsonb_typeof(snapshot->'auditEvents') IS DISTINCT FROM 'array' THEN
      RAISE EXCEPTION 'AUDIT_CUTOVER_INVALID_SNAPSHOT';
    END IF;
    IF (SELECT count(*) <> count(DISTINCT event->>'id')
          FROM jsonb_array_elements(snapshot->'auditEvents') event) THEN
      RAISE EXCEPTION 'AUDIT_CUTOVER_DUPLICATE_ID';
    END IF;
    IF EXISTS (
      SELECT 1 FROM jsonb_to_recordset(snapshot->'auditEvents') AS event(
        id text, "eventType" text, "actorId" text, "entityType" text, "entityId" text,
        "previousState" text, "newState" text, "correlationId" text, metadata jsonb, "occurredAt" timestamptz)
      JOIN audit_events persisted ON persisted.id = event.id
      WHERE ROW(persisted.event_type, persisted.actor_id, persisted.entity_type, persisted.entity_id,
                persisted.previous_state, persisted.new_state, persisted.correlation_id, persisted.metadata, persisted.occurred_at)
        IS DISTINCT FROM ROW(event."eventType", event."actorId", event."entityType", event."entityId",
                event."previousState", event."newState", event."correlationId", event.metadata, event."occurredAt")
    ) THEN
      RAISE EXCEPTION 'AUDIT_CUTOVER_PROJECTION_DIVERGED';
    END IF;
    INSERT INTO audit_events (id, event_type, actor_id, entity_type, entity_id, previous_state, new_state, correlation_id, metadata, occurred_at)
    SELECT id, "eventType", "actorId", "entityType", "entityId", "previousState", "newState", "correlationId", metadata, "occurredAt"
      FROM jsonb_to_recordset(snapshot->'auditEvents') AS event(
        id text, "eventType" text, "actorId" text, "entityType" text, "entityId" text,
        "previousState" text, "newState" text, "correlationId" text, metadata jsonb, "occurredAt" timestamptz)
    ON CONFLICT (id) DO NOTHING;
    UPDATE cvg_runtime_state
       SET state = jsonb_set(state, '{auditEvents}', '[]'::jsonb), version = version + 1, updated_at = now()
     WHERE id = 1;
  END IF;
END $$;

ALTER TABLE cvg_runtime_state ADD CONSTRAINT runtime_audit_is_transient
  CHECK (COALESCE(state->'auditEvents' = '[]'::jsonb, false));

CREATE INDEX audit_events_page_idx ON audit_events (occurred_at DESC, id COLLATE "C" ASC);
CREATE INDEX audit_events_entity_page_idx ON audit_events (entity_type, entity_id, occurred_at, id COLLATE "C");
CREATE INDEX audit_events_view_evidence_idx ON audit_events (entity_type, entity_id, actor_id, event_type);
CREATE INDEX audit_events_entity_actor_idx ON audit_events (entity_id, actor_id);

UPDATE runtime_storage_boundaries SET projected_relations = ARRAY['outbox_messages']
 WHERE boundary_key = 'runtime-jsonb-snapshot-v1';
INSERT INTO runtime_storage_boundaries (boundary_key, authoritative_store, read_mode, write_mode, projected_relations, status, reconciliation_mode, contract_version)
VALUES ('audit-events-v1', 'audit_events', 'RELATIONAL', 'RELATIONAL', ARRAY[]::text[], 'RELATIONAL_READY', 'COMPLETE', 'AuditEvent-v1');

UPDATE relational_schema_markers SET schema_version = '013_audit_read_authority'
 WHERE marker_key = 'RELATIONAL_CLINICAL_CORE_EXPAND_V1';
