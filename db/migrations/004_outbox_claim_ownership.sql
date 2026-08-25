ALTER TABLE outbox_messages
  ADD CONSTRAINT outbox_messages_claim_token_unique UNIQUE (claim_token);

COMMENT ON COLUMN outbox_messages.claim_token IS 'Opaque ownership token for the currently active worker lease; completion must present the same token and owner.';
