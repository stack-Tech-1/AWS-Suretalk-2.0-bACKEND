-- Tracks when each user last used the app, for the admin dashboard's "Active now" / "Active today".
-- Written by middleware/auth.js at most once every 5 minutes per user.
ALTER TABLE users ADD COLUMN IF NOT EXISTS last_active_at TIMESTAMP;
CREATE INDEX IF NOT EXISTS idx_users_last_active_at ON users(last_active_at);

-- Start from the last sign-in so the numbers aren't empty on day one
UPDATE users SET last_active_at = last_login WHERE last_active_at IS NULL AND last_login IS NOT NULL;
