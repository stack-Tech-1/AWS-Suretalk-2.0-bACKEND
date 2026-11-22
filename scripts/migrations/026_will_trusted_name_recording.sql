-- 026: trusted contact set on a phone call. Keypads can't type names, so the caller says the name
-- and the Twilio recording id is kept here; the trusted contact's warning call plays it.
-- Adds one field; changes no existing value.
ALTER TABLE voice_wills ADD COLUMN IF NOT EXISTS trusted_name_recording VARCHAR(64);
