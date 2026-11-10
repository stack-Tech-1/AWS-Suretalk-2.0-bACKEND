-- Stripe events the webhook has finished handling, so a resent event is not handled twice
-- (no double emails or payment records). The webhook still works without this table, it just
-- can't skip repeats. Safe to re-run.
CREATE TABLE IF NOT EXISTS stripe_events (
  id           VARCHAR(255) PRIMARY KEY,
  type         VARCHAR(100),
  processed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_stripe_events_processed_at ON stripe_events (processed_at);
