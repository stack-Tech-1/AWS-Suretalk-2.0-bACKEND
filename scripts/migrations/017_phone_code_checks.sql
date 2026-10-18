-- Text-message codes (phone_otps): limit wrong guesses and record what each code is for.
--   attempts: wrong guesses so far; a code is thrown away after 5.
--   purpose:  'claim_account' (claiming a phone-line account on the website) or
--             'phone_line'   (proving you own your number before creating a phone PIN).
-- Safe to re-run.
CREATE TABLE IF NOT EXISTS phone_otps (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  phone       VARCHAR(20) NOT NULL,
  otp_hash    VARCHAR(255) NOT NULL,
  expires_at  TIMESTAMP NOT NULL,
  used_at     TIMESTAMP,
  created_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
ALTER TABLE phone_otps ADD COLUMN IF NOT EXISTS attempts INTEGER DEFAULT 0;
ALTER TABLE phone_otps ADD COLUMN IF NOT EXISTS purpose VARCHAR(30) DEFAULT 'claim_account';
CREATE INDEX IF NOT EXISTS idx_phone_otps_phone ON phone_otps(phone);
