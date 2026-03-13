-- Migration: 004_sync_outbox.sql
-- Description: Creates sync_outbox table for durable IVR sync with retry logic.

CREATE TABLE IF NOT EXISTS sync_outbox (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_type      VARCHAR(50)  NOT NULL,
  payload         JSONB        NOT NULL,
  target          VARCHAR(20)  DEFAULT 'ivr',
  status          VARCHAR(20)  DEFAULT 'pending',
  attempts        INTEGER      DEFAULT 0,
  last_attempt_at TIMESTAMP,
  error_message   TEXT,
  created_at      TIMESTAMP    DEFAULT CURRENT_TIMESTAMP,
  sent_at         TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_sync_outbox_status   ON sync_outbox(status);
CREATE INDEX IF NOT EXISTS idx_sync_outbox_created  ON sync_outbox(created_at DESC);
