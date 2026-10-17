-- Scheduled messages: proper failed / paused / cancelled tracking for the admin page and the worker.
-- Safe to run more than once.

ALTER TABLE scheduled_messages ADD COLUMN IF NOT EXISTS failed_at TIMESTAMP;
ALTER TABLE scheduled_messages ADD COLUMN IF NOT EXISTS cancelled_at TIMESTAMP;
ALTER TABLE scheduled_messages ADD COLUMN IF NOT EXISTS paused_at TIMESTAMP;
ALTER TABLE scheduled_messages ADD COLUMN IF NOT EXISTS twilio_call_sid VARCHAR(64);
ALTER TABLE scheduled_messages ADD COLUMN IF NOT EXISTS twilio_message_sid VARCHAR(64);

-- App messages that used up all 3 delivery attempts used to stay "scheduled" forever.
-- Mark them failed so they show up as needing attention (the error_message is kept).
UPDATE scheduled_messages
SET delivery_status = 'failed',
    failed_at = COALESCE(last_attempt_at, updated_at, NOW()),
    error_message = COALESCE(error_message, 'Delivery failed after 3 attempts')
WHERE delivery_status = 'scheduled'
  AND delivery_attempts >= 3
  AND COALESCE(metadata->>'source', 'app') <> 'ivr';

CREATE INDEX IF NOT EXISTS idx_scheduled_messages_status_time ON scheduled_messages(delivery_status, scheduled_for);
