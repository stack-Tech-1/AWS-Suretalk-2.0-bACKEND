-- Prevent two active voice notes from sharing the same IVR slot for a user.
-- NULL slots (not yet synced) and soft-deleted rows are excluded.
CREATE UNIQUE INDEX IF NOT EXISTS voice_notes_user_slot_unique
  ON voice_notes (user_id, ivr_slot_number)
  WHERE ivr_slot_number IS NOT NULL AND deleted_at IS NULL;
