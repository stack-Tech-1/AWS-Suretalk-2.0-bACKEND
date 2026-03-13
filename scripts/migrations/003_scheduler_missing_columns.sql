-- Migration: 003_scheduler_missing_columns.sql
-- Description: Adds missing columns to scheduled_messages used by the scheduler worker.

ALTER TABLE scheduled_messages ADD COLUMN IF NOT EXISTS custom_message  TEXT;
ALTER TABLE scheduled_messages ADD COLUMN IF NOT EXISTS last_attempt_at TIMESTAMP;
ALTER TABLE scheduled_messages ADD COLUMN IF NOT EXISTS error_message   TEXT;
