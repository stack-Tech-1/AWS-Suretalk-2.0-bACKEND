-- One keypad slot number for every voice note (Phase 3 Part B).
-- Notes recorded by phone stored their keypad slot in slot_number; notes made in the app use
-- ivr_slot_number. The app only looked at ivr_slot_number, so it treated phone-recorded slots as free
-- (and could try to put a new note into a slot already taken on the phone line), and deleting a
-- phone-recorded note in the app never removed it from the keypad.
-- This copies slot_number into ivr_slot_number for live notes that don't have one, unless another
-- live note of the same person already uses that slot. Nothing is deleted. Safe to re-run.

UPDATE voice_notes v
SET ivr_slot_number = v.slot_number
WHERE v.deleted_at IS NULL
  AND v.ivr_slot_number IS NULL
  AND v.slot_number BETWEEN 1 AND 9
  AND NOT EXISTS (
    SELECT 1 FROM voice_notes o
    WHERE o.user_id = v.user_id AND o.id <> v.id AND o.deleted_at IS NULL AND o.ivr_slot_number = v.slot_number
  );

-- Check afterwards: live notes that share a keypad slot with another live note (should be none)
-- SELECT user_id, ivr_slot_number, COUNT(*) FROM voice_notes
-- WHERE deleted_at IS NULL AND ivr_slot_number IS NOT NULL GROUP BY 1, 2 HAVING COUNT(*) > 1;
