-- Migration: 001_contact_recording_tier_fix.sql
-- Description: Adds contact linkage to voice_notes, fixes set_user_limits trigger,
--              adds source column to users, and creates refresh_tokens table.

-- ============================================================
-- PART 1: Add contact columns to voice_notes
-- ============================================================

ALTER TABLE voice_notes
  ADD COLUMN IF NOT EXISTS contact_id UUID REFERENCES contacts(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS contact_pending BOOLEAN DEFAULT FALSE;

-- ============================================================
-- PART 2: Fix set_user_limits trigger function
--   - Adds voice_notes_limit handling (was missing)
--   - Adds LEGACY_VAULT_PREMIUM tier (was missing)
--   - Corrects limits: LITE (3/3), ESSENTIAL (9/100), LEGACY_VAULT_PREMIUM (25/500)
--   - Only sets a limit when the column is NULL (preserves manual overrides)
-- ============================================================

CREATE OR REPLACE FUNCTION set_user_limits()
RETURNS TRIGGER AS $$
BEGIN
  CASE NEW.subscription_tier
    WHEN 'LITE' THEN
      IF NEW.contacts_limit IS NULL THEN NEW.contacts_limit := 3; END IF;
      IF NEW.voice_notes_limit IS NULL THEN NEW.voice_notes_limit := 3; END IF;
    WHEN 'ESSENTIAL' THEN
      IF NEW.contacts_limit IS NULL THEN NEW.contacts_limit := 9; END IF;
      IF NEW.voice_notes_limit IS NULL THEN NEW.voice_notes_limit := 100; END IF;
    WHEN 'LEGACY_VAULT_PREMIUM' THEN
      IF NEW.contacts_limit IS NULL THEN NEW.contacts_limit := 25; END IF;
      IF NEW.voice_notes_limit IS NULL THEN NEW.voice_notes_limit := 500; END IF;
    ELSE
      -- Default to LITE limits for unknown tiers
      IF NEW.contacts_limit IS NULL THEN NEW.contacts_limit := 3; END IF;
      IF NEW.voice_notes_limit IS NULL THEN NEW.voice_notes_limit := 3; END IF;
  END CASE;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trigger_set_user_limits ON users;
CREATE TRIGGER trigger_set_user_limits
  BEFORE INSERT OR UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION set_user_limits();

-- ============================================================
-- PART 3: Add source column to users
-- ============================================================

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS source VARCHAR(20) DEFAULT 'app';

-- ============================================================
-- PART 4: Create refresh_tokens table
-- ============================================================

CREATE TABLE IF NOT EXISTS refresh_tokens (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash  VARCHAR(255) NOT NULL,
  expires_at  TIMESTAMP NOT NULL,
  revoked_at  TIMESTAMP,
  created_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_refresh_tokens_user_id    ON refresh_tokens(user_id);
CREATE INDEX IF NOT EXISTS idx_refresh_tokens_token_hash ON refresh_tokens(token_hash);

-- ============================================================
-- PART 5: Create phone_otps table (IVR account claiming flow)
-- ============================================================

CREATE TABLE IF NOT EXISTS phone_otps (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  phone      VARCHAR(50) NOT NULL,
  otp_hash   VARCHAR(255) NOT NULL,
  expires_at TIMESTAMP NOT NULL,
  used_at    TIMESTAMP,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_phone_otps_phone ON phone_otps(phone);

-- ============================================================
-- PART 6: Admin audit log table
-- ============================================================

CREATE TABLE IF NOT EXISTS admin_audit_log (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  admin_user_id UUID NOT NULL REFERENCES users(id),
  action        VARCHAR(100) NOT NULL,
  target_id     VARCHAR(255),
  old_value     JSONB,
  new_value     JSONB,
  ip_address    INET,
  created_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_admin_audit_log_admin ON admin_audit_log(admin_user_id);
CREATE INDEX IF NOT EXISTS idx_admin_audit_log_ts    ON admin_audit_log(created_at DESC);
