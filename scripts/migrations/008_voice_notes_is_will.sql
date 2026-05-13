ALTER TABLE voice_notes ADD COLUMN IF NOT EXISTS is_will BOOLEAN NOT NULL DEFAULT FALSE;

UPDATE voice_notes SET is_will = TRUE WHERE s3_bucket = 'suretalk-legacy-wills';
