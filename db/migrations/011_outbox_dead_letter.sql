-- AAA-W2-OUTBOX / OUTBOX_DEAD_LETTER_V1
-- Dead-letter actions are explicit operator commands. The worker never claims
-- DISCARDED messages and retries only after a deliberate reprocess command.

ALTER TABLE outbox_messages
  ADD COLUMN IF NOT EXISTS dead_lettered_at timestamptz,
  ADD COLUMN IF NOT EXISTS discarded_at timestamptz,
  ADD COLUMN IF NOT EXISTS discarded_by text,
  ADD COLUMN IF NOT EXISTS discard_reason text;

UPDATE outbox_messages
   SET dead_lettered_at = COALESCE(dead_lettered_at, CURRENT_TIMESTAMP)
 WHERE status = 'FAILED';

ALTER TABLE outbox_messages DROP CONSTRAINT IF EXISTS outbox_messages_status_check;
ALTER TABLE outbox_messages
  ADD CONSTRAINT outbox_messages_status_check
  CHECK (status IN ('PENDING', 'PROCESSING', 'PROCESSED', 'FAILED', 'DISCARDED'));

CREATE INDEX IF NOT EXISTS outbox_messages_dead_letter_idx
  ON outbox_messages (status, dead_lettered_at DESC)
  WHERE status IN ('FAILED', 'DISCARDED');

UPDATE relational_schema_markers
   SET schema_version = '011_outbox_dead_letter'
 WHERE marker_key = 'RELATIONAL_CLINICAL_CORE_EXPAND_V1';

COMMENT ON COLUMN outbox_messages.dead_lettered_at IS
  'Timestamp at which retry exhaustion moved the message into the operator dead-letter queue.';
COMMENT ON COLUMN outbox_messages.discarded_at IS
  'Timestamp at which an operator explicitly discarded a dead-lettered message.';
COMMENT ON COLUMN outbox_messages.discarded_by IS
  'Actor that explicitly discarded the dead-lettered message.';
COMMENT ON COLUMN outbox_messages.discard_reason IS
  'Required operator reason for discarding the dead-lettered message.';
