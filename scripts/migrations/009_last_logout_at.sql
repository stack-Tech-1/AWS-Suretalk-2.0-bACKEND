-- Migration 009: Add last_logout_at to users for server-side JWT invalidation.
-- After this runs, any token issued before a user's last_logout_at is rejected
-- by the authenticate middleware, making logout truly effective.

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS last_logout_at TIMESTAMPTZ;
