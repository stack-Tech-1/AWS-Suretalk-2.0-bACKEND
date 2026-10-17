-- Brings the live database in line with the columns the app code writes and reads.
-- The live database was found to be missing system_logs.ip_address (so every log insert that
-- recorded an IP — sign-ins, failed logins, 2FA — was silently failing). This adds that and any
-- other column the code relies on, ONLY where it's missing. Nothing is dropped or changed.
-- Safe to run more than once.

-- System logs
ALTER TABLE system_logs ADD COLUMN IF NOT EXISTS ip_address INET;
ALTER TABLE system_logs ADD COLUMN IF NOT EXISTS user_agent TEXT;
ALTER TABLE system_logs ADD COLUMN IF NOT EXISTS metadata JSONB DEFAULT '{}';

-- Voice notes
ALTER TABLE voice_notes ADD COLUMN IF NOT EXISTS source VARCHAR(20) DEFAULT 'app';
ALTER TABLE voice_notes ADD COLUMN IF NOT EXISTS twilio_recording_sid VARCHAR(64);
ALTER TABLE voice_notes ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMP;
ALTER TABLE voice_notes ADD COLUMN IF NOT EXISTS file_size_bytes BIGINT DEFAULT 0;

-- Voice wills
ALTER TABLE voice_wills ADD COLUMN IF NOT EXISTS source VARCHAR(20) DEFAULT 'app';
ALTER TABLE voice_wills ADD COLUMN IF NOT EXISTS twilio_recording_sid VARCHAR(64);
ALTER TABLE voice_wills ADD COLUMN IF NOT EXISTS will_slot_number INTEGER;
ALTER TABLE voice_wills ADD COLUMN IF NOT EXISTS contact_phone VARCHAR(50);
ALTER TABLE voice_wills ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMP;
ALTER TABLE voice_wills ADD COLUMN IF NOT EXISTS metadata JSONB DEFAULT '{}';
ALTER TABLE voice_wills ADD COLUMN IF NOT EXISTS description TEXT;
ALTER TABLE voice_wills ADD COLUMN IF NOT EXISTS release_notes TEXT;
ALTER TABLE voice_wills ADD COLUMN IF NOT EXISTS released_at TIMESTAMP;
ALTER TABLE voice_wills ADD COLUMN IF NOT EXISTS released_by UUID;
ALTER TABLE voice_wills ADD COLUMN IF NOT EXISTS beneficiaries UUID[] DEFAULT '{}';

-- Users
ALTER TABLE users ADD COLUMN IF NOT EXISTS source VARCHAR(20);
ALTER TABLE users ADD COLUMN IF NOT EXISTS two_factor_enabled BOOLEAN DEFAULT false;
ALTER TABLE users ADD COLUMN IF NOT EXISTS two_factor_secret VARCHAR(255);
ALTER TABLE users ADD COLUMN IF NOT EXISTS two_factor_backup_codes JSONB DEFAULT '[]';
ALTER TABLE users ADD COLUMN IF NOT EXISTS failed_login_attempts INTEGER DEFAULT 0;
ALTER TABLE users ADD COLUMN IF NOT EXISTS account_locked_until TIMESTAMP;
ALTER TABLE users ADD COLUMN IF NOT EXISTS last_login_ip VARCHAR(64);
ALTER TABLE users ADD COLUMN IF NOT EXISTS last_login_at TIMESTAMP;
ALTER TABLE users ADD COLUMN IF NOT EXISTS last_active_at TIMESTAMP;
ALTER TABLE users ADD COLUMN IF NOT EXISTS stripe_customer_id VARCHAR(255);
ALTER TABLE users ADD COLUMN IF NOT EXISTS stripe_subscription_id VARCHAR(255);

-- Sessions and admin sign-in tracking
ALTER TABLE user_sessions ADD COLUMN IF NOT EXISTS is_admin_session BOOLEAN DEFAULT false;
ALTER TABLE user_sessions ADD COLUMN IF NOT EXISTS ended_at TIMESTAMP;
ALTER TABLE login_attempts ADD COLUMN IF NOT EXISTS is_admin_attempt BOOLEAN DEFAULT false;
ALTER TABLE login_attempts ADD COLUMN IF NOT EXISTS failure_reason TEXT;
