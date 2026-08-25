CREATE TABLE IF NOT EXISTS rate_limit_buckets (
  bucket_key text PRIMARY KEY,
  window_started_at timestamptz NOT NULL,
  request_count integer NOT NULL CHECK (request_count >= 0)
);

COMMENT ON TABLE rate_limit_buckets IS 'Distributed fixed-window abuse control. Rows contain no clinical payload and may be pruned by operations.';
