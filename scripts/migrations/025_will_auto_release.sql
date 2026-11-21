-- Automatic voice will release (plan: "Voice Will Release Plan", approved by Shawn 2026-11-19).
-- Adds fields only. Nothing is released by this migration, and no existing value changes:
-- every will that exists today gets release_flow = 'admin', so it stays with admins exactly as now.
-- Only wills created after the switch is turned on get release_flow = 'auto'.
-- Safe to run more than once.

-- 1. Voice wills ----------------------------------------------------------------------------------
-- Which release rules apply: 'admin' = released by an admin (every will made before the switch),
-- 'auto' = released on release_date after the warnings.
ALTER TABLE voice_wills ADD COLUMN IF NOT EXISTS release_flow VARCHAR(10) NOT NULL DEFAULT 'admin';

-- Where an 'auto' will is: scheduled | paused (admin dispute) | releasing | released | failed
ALTER TABLE voice_wills ADD COLUMN IF NOT EXISTS release_state VARCHAR(20);

-- Warnings sent for the CURRENT release date: 0 none, 1 owner 3 days before, 2 owner 2 days before,
-- 3 trusted contact + owner's last text 1 day before. Postponing sets it back to 0.
ALTER TABLE voice_wills ADD COLUMN IF NOT EXISTS warning_stage SMALLINT NOT NULL DEFAULT 0;
ALTER TABLE voice_wills ADD COLUMN IF NOT EXISTS last_warning_at TIMESTAMP;

-- Owner's time zone, so warning calls only go out roughly 9am to 7pm their time
ALTER TABLE voice_wills ADD COLUMN IF NOT EXISTS owner_timezone VARCHAR(64);

-- Optional trusted contact (lawyer or family member). Never needs the owner's PIN.
ALTER TABLE voice_wills ADD COLUMN IF NOT EXISTS trusted_name VARCHAR(255);
ALTER TABLE voice_wills ADD COLUMN IF NOT EXISTS trusted_phone VARCHAR(50);
ALTER TABLE voice_wills ADD COLUMN IF NOT EXISTS trusted_email VARCHAR(255);
-- Postpones by the trusted contact since the owner last responded (limit 3, then admins look at it)
ALTER TABLE voice_wills ADD COLUMN IF NOT EXISTS trusted_postpones_in_row SMALLINT NOT NULL DEFAULT 0;

-- Admin "Pause" for disputes
ALTER TABLE voice_wills ADD COLUMN IF NOT EXISTS paused_at TIMESTAMP;
ALTER TABLE voice_wills ADD COLUMN IF NOT EXISTS paused_by UUID REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE voice_wills ADD COLUMN IF NOT EXISTS paused_reason TEXT;

-- Release attempts by the worker (a failed release is retried, then shown to admins)
ALTER TABLE voice_wills ADD COLUMN IF NOT EXISTS release_attempts SMALLINT NOT NULL DEFAULT 0;
ALTER TABLE voice_wills ADD COLUMN IF NOT EXISTS release_error TEXT;

-- What the release worker looks at every minute
CREATE INDEX IF NOT EXISTS idx_voice_wills_auto_due
  ON voice_wills (release_date)
  WHERE release_flow = 'auto' AND release_state = 'scheduled' AND deleted_at IS NULL;

-- 2. Test accounts ---------------------------------------------------------------------------------
-- Only accounts marked here can use the test setting that shrinks days to minutes.
ALTER TABLE users ADD COLUMN IF NOT EXISTS will_test_account BOOLEAN NOT NULL DEFAULT FALSE;

-- 3. History of every release date change, warning, pause and release -----------------------------
CREATE TABLE IF NOT EXISTS will_release_events (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  will_id    UUID NOT NULL REFERENCES voice_wills(id) ON DELETE CASCADE,
  event      VARCHAR(30) NOT NULL,  -- date_set | postponed | date_changed | warning_sent | paused | resumed | released | release_failed
  actor      VARCHAR(20) NOT NULL,  -- owner | trusted | admin | system
  channel    VARCHAR(20),           -- web | phone | text_link | warning_call | worker
  old_date   TIMESTAMP,
  new_date   TIMESTAMP,
  details    JSONB DEFAULT '{}',
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_will_release_events_will ON will_release_events (will_id, created_at);

-- 4. Private links in warning texts (owner: PIN page; trusted contact: one-time code page) ---------
-- Only a hash of each link is stored. A link works for one release date only: once the date
-- changes, links sent for the old date stop working.
CREATE TABLE IF NOT EXISTS will_action_links (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  token_hash       VARCHAR(64) NOT NULL UNIQUE,
  will_id          UUID NOT NULL REFERENCES voice_wills(id) ON DELETE CASCADE,
  audience         VARCHAR(10) NOT NULL,  -- owner | trusted
  for_release_date TIMESTAMP NOT NULL,
  expires_at       TIMESTAMP NOT NULL,
  used_at          TIMESTAMP,
  failed_attempts  SMALLINT NOT NULL DEFAULT 0,
  created_at       TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_will_action_links_will ON will_action_links (will_id);

-- Trusted contacts' one-time codes reuse phone_otps with purpose 'will_trusted' (no change needed).

-- Check afterwards:
-- SELECT release_flow, count(*) FROM voice_wills GROUP BY 1;   -- every existing will should be 'admin'
