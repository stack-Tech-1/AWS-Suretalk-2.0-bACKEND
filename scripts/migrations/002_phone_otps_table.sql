-- Migration: 002_phone_otps_table.sql
-- Description: Creates phone_otps table for IVR account claiming OTP flow.

CREATE TABLE IF NOT EXISTS phone_otps (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  phone      VARCHAR(50)  NOT NULL,
  otp_hash   VARCHAR(255) NOT NULL,
  expires_at TIMESTAMP    NOT NULL,
  used_at    TIMESTAMP,
  created_at TIMESTAMP    DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_phone_otps_phone   ON phone_otps(phone);
CREATE INDEX IF NOT EXISTS idx_phone_otps_expires ON phone_otps(expires_at);
