-- Voice will release delivery + admin "remove from service".
-- Safe to run more than once.

-- Admin removal keeps the recording (hidden from lists, phone line stops playing it, can be restored).
-- Separate from deleted_at, which is set when the owner deletes their own will.
ALTER TABLE voice_wills ADD COLUMN IF NOT EXISTS admin_removed_at TIMESTAMP;
ALTER TABLE voice_wills ADD COLUMN IF NOT EXISTS admin_removed_by UUID REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE voice_wills ADD COLUMN IF NOT EXISTS admin_removed_reason TEXT;

-- One private listening link per recipient, created when an admin releases a will
CREATE TABLE IF NOT EXISTS will_release_links (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  token UUID NOT NULL UNIQUE,
  will_id UUID NOT NULL REFERENCES voice_wills(id) ON DELETE CASCADE,
  contact_id UUID REFERENCES contacts(id) ON DELETE SET NULL,
  recipient_name VARCHAR(255),
  recipient_phone VARCHAR(50),
  recipient_email VARCHAR(255),
  sms_status VARCHAR(20) DEFAULT 'not_sent',    -- sent | failed | not_sent
  email_status VARCHAR(20) DEFAULT 'not_sent',  -- sent | failed | not_sent
  expires_at TIMESTAMP NOT NULL,
  play_count INTEGER DEFAULT 0,
  first_played_at TIMESTAMP,
  last_played_at TIMESTAMP,
  revoked_at TIMESTAMP,
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_will_release_links_will ON will_release_links(will_id);
CREATE INDEX IF NOT EXISTS idx_voice_wills_release ON voice_wills(is_released, release_condition, release_date);
