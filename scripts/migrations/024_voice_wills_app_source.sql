-- Wills saved from the website were labelled as phone recordings, so the app showed "No audio".
-- Run this BEFORE deploying the backend that writes file_size_bytes. Safe to re-run.
ALTER TABLE voice_wills ADD COLUMN IF NOT EXISTS file_size_bytes BIGINT;
ALTER TABLE voice_wills ALTER COLUMN source SET DEFAULT 'app';

UPDATE voice_wills
SET source = 'app'
WHERE source = 'ivr'
  AND s3_key LIKE 'wills/%'
  AND twilio_recording_sid IS NULL;
