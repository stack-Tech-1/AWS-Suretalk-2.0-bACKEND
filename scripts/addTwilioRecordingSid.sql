-- Migration: addTwilioRecordingSid.sql
-- Adds Twilio recording SID tracking columns to voice_notes and voice_wills

ALTER TABLE voice_notes
  ADD COLUMN IF NOT EXISTS twilio_recording_sid    VARCHAR(64),
  ADD COLUMN IF NOT EXISTS twilio_sync_status      VARCHAR(20) DEFAULT 'pending'
    CHECK (twilio_sync_status IN ('pending', 'synced', 'failed', 'skipped')),
  ADD COLUMN IF NOT EXISTS twilio_sync_attempts    INT DEFAULT 0,
  ADD COLUMN IF NOT EXISTS twilio_synced_at        TIMESTAMPTZ;

ALTER TABLE voice_wills
  ADD COLUMN IF NOT EXISTS twilio_recording_sid    VARCHAR(64),
  ADD COLUMN IF NOT EXISTS twilio_sync_status      VARCHAR(20) DEFAULT 'pending'
    CHECK (twilio_sync_status IN ('pending', 'synced', 'failed', 'skipped')),
  ADD COLUMN IF NOT EXISTS twilio_sync_attempts    INT DEFAULT 0,
  ADD COLUMN IF NOT EXISTS twilio_synced_at        TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_voice_notes_twilio_sync_status
  ON voice_notes(twilio_sync_status)
  WHERE twilio_sync_status = 'pending';

CREATE INDEX IF NOT EXISTS idx_voice_wills_twilio_sync_status
  ON voice_wills(twilio_sync_status)
  WHERE twilio_sync_status = 'pending';
