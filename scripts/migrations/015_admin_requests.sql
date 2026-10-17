-- Admin access requests: who applied, why, and who decided. Adds only what's missing; safe to re-run.
ALTER TABLE users ADD COLUMN IF NOT EXISTS is_super_admin BOOLEAN DEFAULT false;
ALTER TABLE users ADD COLUMN IF NOT EXISTS admin_reason TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS admin_department VARCHAR(255);
ALTER TABLE users ADD COLUMN IF NOT EXISTS approved_by_admin_id UUID;
ALTER TABLE users ADD COLUMN IF NOT EXISTS approved_at TIMESTAMP;
ALTER TABLE users ADD COLUMN IF NOT EXISTS rejected_by_admin_id UUID;
ALTER TABLE users ADD COLUMN IF NOT EXISTS rejected_at TIMESTAMP;
ALTER TABLE users ADD COLUMN IF NOT EXISTS rejection_notes TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS requested_by_admin_id UUID;
