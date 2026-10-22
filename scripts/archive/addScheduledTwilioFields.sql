-- Migration: addScheduledTwilioFields.sql
-- Adds Twilio delivery tracking columns to scheduled_messages

ALTER TABLE scheduled_messages
  ADD COLUMN IF NOT EXISTS twilio_call_sid    VARCHAR(64),
  ADD COLUMN IF NOT EXISTS twilio_message_sid VARCHAR(64);
