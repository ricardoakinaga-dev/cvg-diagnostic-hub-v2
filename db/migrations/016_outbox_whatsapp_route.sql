-- PROD-402 (D3): a critical result also reaches its recipient over WhatsApp
-- Business. A notification delivery intent may now be routed to
-- notification.whatsapp besides notification.in_app. Rolling migration: the
-- previous app writes only notification.in_app, which stays valid, and every
-- existing row satisfies the wider check.

ALTER TABLE outbox_messages DROP CONSTRAINT outbox_messages_route_consistency_check;

ALTER TABLE outbox_messages
  ADD CONSTRAINT outbox_messages_route_consistency_check
  CHECK (
    (consumer_type = 'NOTIFICATION_DELIVERY' AND routing_key IN ('notification.in_app', 'notification.whatsapp'))
    OR (consumer_type = 'DOMAIN_EVENT' AND routing_key LIKE 'domain.%')
  );

UPDATE relational_schema_markers SET schema_version = '016_outbox_whatsapp_route' WHERE marker_key = 'RELATIONAL_CLINICAL_CORE_EXPAND_V1';

COMMENT ON COLUMN outbox_messages.routing_key IS 'Validated route for the consumer class: notification.in_app or notification.whatsapp for notification delivery, domain.<event> for domain events.';
