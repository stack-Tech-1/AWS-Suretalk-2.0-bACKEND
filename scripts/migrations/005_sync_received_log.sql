-- Migration: 005_sync_received_log.sql
-- Description: Audit log for all incoming IVR sync events.

CREATE TABLE IF NOT EXISTS sync_received_log (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  source       VARCHAR(20) NOT NULL,
  event_type   VARCHAR(50) NOT NULL,
  payload      JSONB       NOT NULL,
  processed_at TIMESTAMP   DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_sync_received_log_event ON sync_received_log(event_type);
CREATE INDEX IF NOT EXISTS idx_sync_received_log_ts    ON sync_received_log(processed_at DESC);
