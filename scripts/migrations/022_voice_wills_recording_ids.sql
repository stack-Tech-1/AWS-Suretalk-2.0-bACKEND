-- Voice wills whose Twilio recording id ("RE…") was stored in s3_key instead of twilio_recording_sid.
-- This used to run on EVERY will sent from the phone line (in server.js); it only needs to run once.
-- Playback works either way; this just puts the id in the right column. Safe to re-run.
ALTER TABLE voice_wills ADD COLUMN IF NOT EXISTS twilio_sync_status VARCHAR(20) DEFAULT 'pending';

UPDATE voice_wills
SET twilio_recording_sid = s3_key,
    s3_key = NULL,
    twilio_sync_status = 'synced'
WHERE s3_key LIKE 'RE%'
  AND length(s3_key) > 30
  AND s3_key NOT LIKE '%/%'
  AND s3_key NOT LIKE 'http%'
  AND twilio_recording_sid IS NULL
  AND deleted_at IS NULL;
