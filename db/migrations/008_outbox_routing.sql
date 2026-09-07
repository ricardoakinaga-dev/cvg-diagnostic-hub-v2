-- AAA2-017/018 local durable envelope boundary.
-- Existing outbox rows are backfilled from their immutable event type and
-- payload. Domain events and notification delivery intents then have an
-- explicit consumer and route before a worker can acknowledge them.

ALTER TABLE outbox_messages
  ADD COLUMN IF NOT EXISTS consumer_type text,
  ADD COLUMN IF NOT EXISTS routing_key text;

UPDATE outbox_messages
   SET consumer_type = CASE
         WHEN NULLIF(btrim(payload ->> 'notificationId'), '') IS NOT NULL
           OR event_type IN ('ResultReleased', 'ResultVoided', 'RecollectionRequested')
           THEN 'NOTIFICATION_DELIVERY'
         ELSE 'DOMAIN_EVENT'
       END,
       routing_key = CASE
         WHEN NULLIF(btrim(payload ->> 'notificationId'), '') IS NOT NULL
           OR event_type IN ('ResultReleased', 'ResultVoided', 'RecollectionRequested')
           THEN 'notification.in_app'
         ELSE 'domain.' || event_type
       END
 WHERE consumer_type IS NULL OR routing_key IS NULL;

ALTER TABLE outbox_messages
  ALTER COLUMN consumer_type SET NOT NULL,
  ALTER COLUMN routing_key SET NOT NULL;

DO $outbox_routing_constraints$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'outbox_messages'::regclass
       AND conname = 'outbox_messages_consumer_type_check'
  ) THEN
    ALTER TABLE outbox_messages
      ADD CONSTRAINT outbox_messages_consumer_type_check
      CHECK (consumer_type IN ('DOMAIN_EVENT', 'NOTIFICATION_DELIVERY'));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'outbox_messages'::regclass
       AND conname = 'outbox_messages_routing_key_check'
  ) THEN
    ALTER TABLE outbox_messages
      ADD CONSTRAINT outbox_messages_routing_key_check
      CHECK (btrim(routing_key) <> '');
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'outbox_messages'::regclass
       AND conname = 'outbox_messages_route_consistency_check'
  ) THEN
    ALTER TABLE outbox_messages
      ADD CONSTRAINT outbox_messages_route_consistency_check
      CHECK (
        (consumer_type = 'NOTIFICATION_DELIVERY' AND routing_key = 'notification.in_app')
        OR (consumer_type = 'DOMAIN_EVENT' AND routing_key LIKE 'domain.%')
      );
  END IF;
END;
$outbox_routing_constraints$;

CREATE INDEX IF NOT EXISTS outbox_messages_route_idx
  ON outbox_messages (status, consumer_type, routing_key, available_at);

UPDATE relational_schema_markers
   SET schema_version = '008_outbox_routing'
 WHERE marker_key = 'RELATIONAL_CLINICAL_CORE_EXPAND_V1';

COMMENT ON COLUMN outbox_messages.consumer_type IS 'Durable consumer class: domain event or notification delivery intent.';
COMMENT ON COLUMN outbox_messages.routing_key IS 'Validated route for the consumer class; notification.in_app is the only durable notification channel in this slice.';
