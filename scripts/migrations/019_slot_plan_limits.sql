-- Plan limits = phone-line keypad slots (decided 2026-10-18):
--   Lite 3, Essential 9, Premium 9 voice notes and contacts (each slot is one contact + their voice note).
--   Premium also gets 9 voice wills (enforced in the app code, no column).
-- Brings every account's stored limits in line with its plan. Old values were Essential 100 notes,
-- Premium 25-50 contacts and 500-1000 notes. Nothing is deleted: anyone already over the new limit
-- keeps everything, they just can't add more until they're under it.
-- Safe to re-run.

UPDATE users SET contacts_limit = 3, voice_notes_limit = 3
WHERE COALESCE(subscription_tier, 'LITE') NOT IN ('ESSENTIAL', 'LEGACY_VAULT_PREMIUM', 'PREMIUM');

UPDATE users SET contacts_limit = 9, voice_notes_limit = 9
WHERE subscription_tier IN ('ESSENTIAL', 'LEGACY_VAULT_PREMIUM', 'PREMIUM');

-- New accounts created by the database itself (no limits given) follow the same numbers
CREATE OR REPLACE FUNCTION set_user_limits()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.contacts_limit IS NULL THEN
    NEW.contacts_limit := CASE WHEN NEW.subscription_tier IN ('ESSENTIAL', 'LEGACY_VAULT_PREMIUM', 'PREMIUM') THEN 9 ELSE 3 END;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

ALTER TABLE users ALTER COLUMN voice_notes_limit SET DEFAULT 3;

-- Check afterwards (who is over the new limits — they keep everything):
-- SELECT u.email, u.phone, u.subscription_tier,
--        (SELECT COUNT(*) FROM contacts c WHERE c.user_id = u.id) AS contacts,
--        (SELECT COUNT(*) FROM voice_notes v WHERE v.user_id = u.id AND v.deleted_at IS NULL) AS notes,
--        (SELECT COUNT(*) FROM voice_wills w WHERE w.user_id = u.id AND w.deleted_at IS NULL AND w.admin_removed_at IS NULL) AS wills
-- FROM users u WHERE u.deleted_at IS NULL
--   AND ((SELECT COUNT(*) FROM contacts c WHERE c.user_id = u.id) > u.contacts_limit
--     OR (SELECT COUNT(*) FROM voice_notes v WHERE v.user_id = u.id AND v.deleted_at IS NULL) > u.voice_notes_limit
--     OR (SELECT COUNT(*) FROM voice_wills w WHERE w.user_id = u.id AND w.deleted_at IS NULL AND w.admin_removed_at IS NULL) > 9);
