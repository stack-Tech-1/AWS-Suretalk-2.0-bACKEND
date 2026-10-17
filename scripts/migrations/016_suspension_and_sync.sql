-- One real suspension switch for accounts, used by the super admin "Suspend" and the admin "Deactivate".
-- It's checked on every request and sign-in, and Stripe updates never touch it. Safe to re-run.
ALTER TABLE users ADD COLUMN IF NOT EXISTS is_suspended BOOLEAN DEFAULT false;
ALTER TABLE users ADD COLUMN IF NOT EXISTS suspended_at TIMESTAMP;
ALTER TABLE users ADD COLUMN IF NOT EXISTS suspended_reason TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS suspended_by UUID;

-- Accounts deactivated earlier from the admin Users page were marked subscription_status = 'suspended'
-- (Stripe never uses that value). Move them onto the new switch.
UPDATE users
SET is_suspended = true,
    suspended_at = COALESCE(suspended_at, updated_at, NOW()),
    subscription_status = 'active'
WHERE subscription_status = 'suspended';

-- Dead sync items a super admin has looked at and dismissed (couldn't or didn't need to be retried)
ALTER TABLE sync_outbox ADD COLUMN IF NOT EXISTS resolved_note TEXT;
ALTER TABLE sync_outbox ADD COLUMN IF NOT EXISTS resolved_at TIMESTAMP;
ALTER TABLE sync_outbox ADD COLUMN IF NOT EXISTS resolved_by UUID;

-- Super admin "View as user" sessions (5 minutes). Nothing in the repo created this table,
-- so it's defined here; on a database that already has it, only missing columns are added.
CREATE TABLE IF NOT EXISTS impersonation_tokens (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  token          TEXT NOT NULL,
  admin_id       UUID NOT NULL,
  target_user_id UUID NOT NULL,
  expires_at     TIMESTAMP NOT NULL,
  created_at     TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
ALTER TABLE impersonation_tokens ADD COLUMN IF NOT EXISTS is_active BOOLEAN DEFAULT true;
ALTER TABLE impersonation_tokens ADD COLUMN IF NOT EXISTS exited_at TIMESTAMP;
CREATE INDEX IF NOT EXISTS idx_impersonation_tokens_token ON impersonation_tokens (token);
