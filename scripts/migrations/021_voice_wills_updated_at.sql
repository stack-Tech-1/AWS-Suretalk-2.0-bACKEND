-- Every change to an existing voice will failed with: record "new" has no field "updated_at".
-- The database stamps updated_at on every UPDATE (trigger update_voice_wills_updated_at), but the live
-- voice_wills table was created without that column — so new wills save, but nothing can change one
-- afterwards (all 10 will-contact changes from the phone line failed this way).
-- Adds the column if it's missing; does nothing if it's already there. Safe to re-run.
ALTER TABLE voice_wills ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP;

-- Check: should return one row
-- SELECT column_name FROM information_schema.columns WHERE table_name = 'voice_wills' AND column_name = 'updated_at';
