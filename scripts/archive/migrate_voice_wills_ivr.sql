-- Migration: Align voice_wills table with IVR sync requirements
-- Safe to run multiple times (ADD COLUMN IF NOT EXISTS is idempotent)
-- Run against production RDS via psql or the RDS Query Editor

BEGIN;

-- 1. Relax NOT NULL constraints that IVR sync cannot satisfy
--    IVR wills have no title or s3_bucket, and s3_key is NULL when using Twilio Recording SID
ALTER TABLE voice_wills ALTER COLUMN title DROP NOT NULL;
ALTER TABLE voice_wills ALTER COLUMN s3_key DROP NOT NULL;
ALTER TABLE voice_wills ALTER COLUMN s3_bucket DROP NOT NULL;

-- 2. Add IVR-required columns (idempotent)
ALTER TABLE voice_wills ADD COLUMN IF NOT EXISTS will_slot_number INT;
ALTER TABLE voice_wills ADD COLUMN IF NOT EXISTS contact_phone VARCHAR(50);
ALTER TABLE voice_wills ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMP;
ALTER TABLE voice_wills ADD COLUMN IF NOT EXISTS source VARCHAR(50) DEFAULT 'webapp';

-- 3. Add Twilio tracking columns (idempotent — safe if addTwilioRecordingSid.sql already ran)
ALTER TABLE voice_wills ADD COLUMN IF NOT EXISTS twilio_recording_sid VARCHAR(64);
ALTER TABLE voice_wills ADD COLUMN IF NOT EXISTS twilio_sync_status VARCHAR(20) DEFAULT 'pending';
ALTER TABLE voice_wills ADD COLUMN IF NOT EXISTS twilio_sync_attempts INT DEFAULT 0;
ALTER TABLE voice_wills ADD COLUMN IF NOT EXISTS twilio_synced_at TIMESTAMPTZ;

COMMIT;

-- Verify: confirm all columns are present after running
-- SELECT column_name, data_type, is_nullable
-- FROM information_schema.columns
-- WHERE table_name = 'voice_wills'
-- ORDER BY ordinal_position;
