ALTER TABLE outbox_messages
  ADD COLUMN IF NOT EXISTS locked_at timestamptz,
  ADD COLUMN IF NOT EXISTS worker_id text,
  ADD COLUMN IF NOT EXISTS claim_token text,
  ADD COLUMN IF NOT EXISTS last_error text;

ALTER TABLE outbox_messages DROP CONSTRAINT IF EXISTS outbox_messages_status_check;
ALTER TABLE outbox_messages
  ADD CONSTRAINT outbox_messages_status_check
  CHECK (status IN ('PENDING', 'PROCESSING', 'PROCESSED', 'FAILED'));

CREATE INDEX IF NOT EXISTS outbox_messages_claim_idx
  ON outbox_messages (status, available_at, locked_at);
