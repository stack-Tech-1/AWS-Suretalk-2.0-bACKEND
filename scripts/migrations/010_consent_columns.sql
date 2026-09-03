-- Migration 010: Legal consent tracking columns
-- Records when users agreed to Terms of Service and consented to SMS
ALTER TABLE users ADD COLUMN IF NOT EXISTS tos_accepted_at  TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN IF NOT EXISTS tos_version      VARCHAR(20) DEFAULT '1.0';
ALTER TABLE users ADD COLUMN IF NOT EXISTS sms_consent_at   TIMESTAMPTZ;
