// utils/phoneLineContent.js — sends voice notes and voice wills made in the app to the phone line
// (keypad slots 1–9 and will slots 1–9), through the phone line's sync-slot function.
//   notes:  { userId, slotNumber, contact, voiceMessage, action: 'create' | 'delete' | 'updateContact' }
//   wills:  same, plus kind: 'will' (slotNumber = will slot)
// Everything goes through syncToIvr, so it's retried on failure and shows in Failed syncs.
const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, GetCommand } = require('@aws-sdk/lib-dynamodb');
const { pool } = require('../config/database');
const { syncToIvr } = require('./syncIvr');
const { limitsFor, willLimitMessage } = require('./planLimits');
const { resolveIvrPlaybackUrl } = require('./resolveAudioUrl');

const WILL_SLOTS = limitsFor('LEGACY_VAULT_PREMIUM').wills; // 3
const lowestFree = (taken, max) => { for (let s = 1; s <= max; s++) if (!taken.has(s)) return s; return null; };

let doc;
const dynamo = () => {
  if (!doc) {
    doc = DynamoDBDocumentClient.from(new DynamoDBClient({
      region: process.env.IVR_AWS_REGION || 'eu-central-1',
      credentials: process.env.AWS_ACCESS_KEY_ID
        ? { accessKeyId: process.env.AWS_ACCESS_KEY_ID, secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY }
        : undefined,
      maxAttempts: 3,
    }));
  }
  return doc;
};

// The phone line's id for a number: +1XXXXXXXXXX for US numbers, otherwise + and the digits
const phoneLineId = (phone) => {
  const digits = String(phone || '').replace(/\D/g, '');
  return digits.length === 10 ? `+1${digits}` : `+${digits}`;
};

// The will slots on the person's phone-line account. Throws when the phone line can't be read.
async function phoneLineWills(phone) {
  if (!phone) return [];
  const r = await dynamo().send(new GetCommand({
    TableName: process.env.DYNAMO_USERS_TABLE || 'Users',
    Key: { userId: phoneLineId(phone) },
    ProjectionExpression: 'voiceWillSlots',
    ConsistentRead: true,
  }));
  return r.Item?.voiceWillSlots || [];
}

// The recording a link or id points at, without the link's signature
const recordingKey = (v) => String(v || '').split('?')[0].replace(/\/+$/, '').split('/').pop();

// Lowest keypad slot not used by one of the person's live notes (null when all are used)
async function freeNoteSlot(userId, tier, db = pool) {
  const r = await db.query(
    `SELECT ivr_slot_number FROM voice_notes WHERE user_id = $1 AND deleted_at IS NULL AND ivr_slot_number IS NOT NULL`,
    [userId]
  );
  return lowestFree(new Set(r.rows.map(x => x.ivr_slot_number)), limitsFor(tier).slots);
}

// Lowest will slot (1–3) free in the app AND on the phone line, which can hold wills recorded on a call
// that the app has no record of (removed-by-admin wills keep their slot: they can be restored)
async function freeWillSlot(userId, db = pool) {
  const r = await db.query(
    `SELECT will_slot_number FROM voice_wills WHERE user_id = $1 AND deleted_at IS NULL AND will_slot_number IS NOT NULL`,
    [userId]
  );
  const taken = new Set(r.rows.map(x => x.will_slot_number));
  try {
    const u = await db.query('SELECT phone FROM users WHERE id = $1', [userId]);
    for (const s of await phoneLineWills(u.rows[0]?.phone)) taken.add(Number(s.willSlotNumber));
  } catch (err) {
    console.warn(`Could not read phone-line will slots for user ${userId}: ${err.message}`);
  }
  return lowestFree(taken, WILL_SLOTS);
}

// How many voice wills the person holds, counting the app and the phone line once each. A recording on
// the phone line that the app has no record of counts too. If the phone line can't be read, the app's
// count is used and the phone line still refuses anything over the limit.
async function willCapacity(userId, tier, db = pool) {
  const max = limitsFor(tier).wills;
  const r = await db.query(
    `SELECT w.id, w.s3_key, w.twilio_recording_sid, w.admin_removed_at, u.phone
     FROM users u LEFT JOIN voice_wills w ON w.user_id = u.id AND w.deleted_at IS NULL
     WHERE u.id = $1`,
    [userId]
  );
  const wills = r.rows.filter(w => w.id);
  const known = new Set(wills.flatMap(w => [w.s3_key, w.twilio_recording_sid]).filter(Boolean).map(recordingKey));
  let phoneOnly = 0;
  try {
    phoneOnly = (await phoneLineWills(r.rows[0]?.phone)).filter(s => !known.has(recordingKey(s.voiceMessage))).length;
  } catch (err) {
    console.warn(`Could not read phone-line wills for user ${userId}: ${err.message}`);
  }
  const used = wills.filter(w => !w.admin_removed_at).length + phoneOnly;
  const message = willLimitMessage(used, tier);
  return { used, max, canCreate: !message, message };
}

// The one contact a will slot calls on the phone line: its first beneficiary (the app keeps them all)
async function willContactPhone(will, db = pool) {
  if (will.contact_phone) return will.contact_phone;
  const first = Array.isArray(will.beneficiaries) ? will.beneficiaries[0] : null;
  if (!first) return '';
  const r = await db.query('SELECT phone FROM contacts WHERE id = $1 AND user_id = $2', [first, will.user_id]);
  return r.rows[0]?.phone || '';
}

async function noteContactPhone(note, db = pool) {
  if (!note.contact_id) return '';
  const r = await db.query('SELECT phone FROM contacts WHERE id = $1 AND user_id = $2', [note.contact_id, note.user_id]);
  return r.rows[0]?.phone || '';
}

const send = (phone, fields) => (phone ? syncToIvr({ userId: phone, source: 'app', ...fields }, 'sync-slot') : undefined);

async function sendNote(phone, note, db = pool) {
  if (!note.ivr_slot_number) return;
  return send(phone, {
    slotNumber: String(note.ivr_slot_number),
    contact: await noteContactPhone(note, db),
    voiceMessage: resolveIvrPlaybackUrl(note),
    action: 'create',
  });
}

async function sendWill(phone, will, db = pool) {
  if (!will.will_slot_number) return;
  return send(phone, {
    kind: 'will',
    slotNumber: String(will.will_slot_number),
    contact: await willContactPhone(will, db),
    voiceMessage: resolveIvrPlaybackUrl(will),
    action: 'create',
  });
}

const removeNote = (phone, slot) => slot && send(phone, { slotNumber: String(slot), action: 'delete' });
const removeWill = (phone, slot) => slot && send(phone, { kind: 'will', slotNumber: String(slot), action: 'delete' });

// Removes a deleted will from the phone line, only if that slot really holds this will's recording.
// A will that never reached the phone line must not take another recording in the same slot with it.
async function removeWillRecording(phone, will) {
  if (!phone || !will.will_slot_number) return;
  try {
    const slot = (await phoneLineWills(phone)).find(s => Number(s.willSlotNumber) === Number(will.will_slot_number));
    if (!slot) return;
    const own = recordingKey(will.twilio_recording_sid || will.s3_key);
    if (!own || recordingKey(slot.voiceMessage) !== own) {
      console.warn(`Will ${will.id}: phone-line slot ${will.will_slot_number} holds another recording, so it was kept`);
      return;
    }
    return await removeWill(phone, will.will_slot_number);
  } catch (err) {
    console.warn(`Will ${will.id}: could not check the phone line, slot ${will.will_slot_number} was kept: ${err.message}`);
  }
}

const changeContact = (phone, { kind, slot, contact }) =>
  slot && send(phone, { ...(kind === 'will' ? { kind: 'will' } : {}), slotNumber: String(slot), contact: contact || '', action: 'updateContact' });

/**
 * Everything the person has in the app, sent to their phone line: used right after they set their
 * phone PIN (their phone-line account is new and empty) and by the Super admin catch-up.
 * Notes without a keypad slot get the lowest free one first. Only items in `only` are sent when given
 * ({ notes: [ids], wills: [ids] }).
 */
async function pushAllToPhoneLine(userId, { only = null } = {}) {
  const user = (await pool.query('SELECT id, phone, subscription_tier FROM users WHERE id = $1 AND deleted_at IS NULL', [userId])).rows[0];
  if (!user?.phone) return { notes: 0, wills: 0 };
  const limits = limitsFor(user.subscription_tier);

  const notes = (await pool.query(
    `SELECT * FROM voice_notes WHERE user_id = $1 AND deleted_at IS NULL AND COALESCE(is_will, false) = false
     ORDER BY ivr_slot_number NULLS LAST, created_at`,
    [userId]
  )).rows.filter(n => !only || (only.notes || []).includes(n.id));
  let sentNotes = 0;
  for (const n of notes) {
    if (!n.ivr_slot_number) {
      const slot = await freeNoteSlot(userId, user.subscription_tier);
      if (!slot) break; // keypad full: the rest stay in the app (over the plan's limit)
      await pool.query('UPDATE voice_notes SET ivr_slot_number = $1 WHERE id = $2', [slot, n.id]);
      n.ivr_slot_number = slot;
    }
    if (n.ivr_slot_number > limits.slots) continue;
    await sendNote(user.phone, n); sentNotes++;
  }

  let sentWills = 0;
  if (limits.wills > 0) {
    const wills = (await pool.query(
      `SELECT * FROM voice_wills WHERE user_id = $1 AND deleted_at IS NULL AND admin_removed_at IS NULL
       ORDER BY will_slot_number NULLS LAST, created_at`,
      [userId]
    )).rows.filter(w => !only || (only.wills || []).includes(w.id));
    for (const w of wills) {
      if (!w.will_slot_number) {
        const slot = await freeWillSlot(userId);
        if (!slot) break;
        await pool.query('UPDATE voice_wills SET will_slot_number = $1 WHERE id = $2', [slot, w.id]);
        w.will_slot_number = slot;
      }
      await sendWill(user.phone, w); sentWills++;
    }
  }
  return { notes: sentNotes, wills: sentWills };
}

module.exports = {
  freeNoteSlot, freeWillSlot, willCapacity, willContactPhone, sendNote, sendWill, removeNote, removeWill, removeWillRecording, changeContact,
  pushAllToPhoneLine, WILL_SLOTS,
};
