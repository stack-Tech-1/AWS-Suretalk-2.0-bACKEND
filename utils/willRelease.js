// Automatic voice will release ("Voice Will Release Plan", approved 2026-11-19).
//
// Every will with release_flow = 'auto' has one release date, stored here (voice_wills.release_date).
// The phone line and the website both read and change it through this file, so they never disagree.
//
//   3 days before: owner gets a call, a text and an email           (warning_stage 1)
//   2 days before: second call and text to the owner                (warning_stage 2)
//   1 day before:  trusted contact gets a call and text (if named),
//                  owner gets a last text                           (warning_stage 3)
//   release date:  each recipient gets a call that plays the will, plus a text and email with a private link
//
// Postponing (owner: 30 days or a chosen date, with their PIN; trusted contact: 30 days, with a code
// sent to their phone) moves the date and starts the warnings again.
//
// Switch: WILL_AUTO_RELEASE = off (default) | test | on
//   off  - nothing happens. New wills are created the old way (release_flow 'admin').
//   test - only accounts marked users.will_test_account are processed, and for them a "day" is
//          WILL_TEST_DAY_MINUTES minutes (default 5), so a whole cycle takes under an hour.
//   on   - every 'auto' will is processed. Test accounts still use short days.

const crypto = require('crypto');
const { pool } = require('../config/database');
const logger = require('./logger');
const emailService = require('./emailService');

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_TZ = 'America/New_York';
const DEFAULT_DELAY_DAYS = 182;        // "6 months" when the owner doesn't pick a date
const POSTPONE_DAYS = 30;
const TRUSTED_POSTPONE_LIMIT = 3;
const RELEASE_LINK_DAYS = 30;          // recipients' listening links
const MAX_RELEASE_ATTEMPTS = 3;
const CALL_HOURS = { from: 9, to: 19 }; // warnings and release calls: 9am to 7pm owner's time

const mode = () => {
  const m = String(process.env.WILL_AUTO_RELEASE || 'off').toLowerCase();
  return ['test', 'on'].includes(m) ? m : 'off';
};
const isEnabled = () => mode() !== 'off';
const testDayMs = () => Math.max(1, Number(process.env.WILL_TEST_DAY_MINUTES) || 5) * 60 * 1000;
const dayMs = (isTestAccount) => (isTestAccount ? testDayMs() : DAY_MS);

const twilioClient = process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN
  ? require('twilio')(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN)
  : null;

// Where Twilio sends key presses from a warning call. Same server as the call-status webhook.
const apiBaseUrl = () => {
  if (process.env.WILL_CALL_BASE_URL) return process.env.WILL_CALL_BASE_URL.replace(/\/+$/, '');
  try { return new URL(process.env.TWILIO_STATUS_CALLBACK_URL).origin; } catch { return null; }
};

const xml = (v) => String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
const last4 = (p) => `...${String(p || '').replace(/\D/g, '').slice(-4)}`;
const validTz = (tz) => { try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true; } catch { return false; } };
const tzOf = (will) => (will.owner_timezone && validTz(will.owner_timezone) ? will.owner_timezone : DEFAULT_TZ);
const hash = (token) => crypto.createHash('sha256').update(String(token)).digest('hex');

const dateText = (date, tz) => new Date(date).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: tz || DEFAULT_TZ });
const willTitle = (w) => w.title || (w.will_slot_number ? `Phone voice will ${w.will_slot_number}` : 'Your voice will');

function withinCallHours(will, now = new Date()) {
  const hour = Number(new Intl.DateTimeFormat('en-US', { hour: 'numeric', hourCycle: 'h23', timeZone: tzOf(will) }).format(now));
  return hour >= CALL_HOURS.from && hour < CALL_HOURS.to;
}

// Release date for a new will: the owner's choice, otherwise 6 months from now
function initialReleaseDate(chosen, now = new Date()) {
  if (chosen) {
    const d = new Date(chosen);
    if (!isNaN(d) && d.getTime() > now.getTime()) return d;
  }
  return new Date(now.getTime() + DEFAULT_DELAY_DAYS * DAY_MS);
}

async function logEvent(db, willId, event, actor, channel, { oldDate = null, newDate = null, details = {}, createdBy = null } = {}) {
  await (db || pool).query(
    `INSERT INTO will_release_events (will_id, event, actor, channel, old_date, new_date, details, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [willId, event, actor, channel, oldDate, newDate, JSON.stringify(details), createdBy]
  ).catch(err => logger.error(`will_release_events write failed (${event}, will ${willId}): ${err.message}`));
}

// ── Private links in warning texts ──────────────────────────────────────────────────────────────
// Only a hash is stored. A link works only while the will still has the release date it was sent for.
async function createActionLink(will, audience) {
  const token = crypto.randomBytes(24).toString('base64url');
  const expires = new Date(new Date(will.release_date).getTime() + DAY_MS);
  await pool.query(
    `INSERT INTO will_action_links (token_hash, will_id, audience, for_release_date, expires_at) VALUES ($1, $2, $3, $4, $5)`,
    [hash(token), will.id, audience, will.release_date, expires]
  );
  return `${process.env.FRONTEND_URL}/will-postpone/${token}`;
}

// The will a link belongs to, or a reason it no longer works
async function findActionLink(token) {
  if (!token || String(token).length > 100) return { ok: false, reason: 'NOT_FOUND' };
  const r = await pool.query(
    `SELECT l.*, vw.release_date, vw.release_state, vw.release_flow, vw.deleted_at, vw.is_released
     FROM will_action_links l JOIN voice_wills vw ON vw.id = l.will_id WHERE l.token_hash = $1`,
    [hash(token)]
  );
  const link = r.rows[0];
  if (!link) return { ok: false, reason: 'NOT_FOUND' };
  if (link.used_at) return { ok: false, reason: 'USED', link };
  if (link.expires_at < new Date()) return { ok: false, reason: 'EXPIRED', link };
  if (link.deleted_at || link.is_released || link.release_state === 'released') return { ok: false, reason: 'RELEASED', link };
  if (new Date(link.release_date).getTime() !== new Date(link.for_release_date).getTime()) return { ok: false, reason: 'DATE_CHANGED', link };
  if (link.failed_attempts >= 5) return { ok: false, reason: 'LOCKED', link };
  return { ok: true, link };
}

// ── Changing the release date (used by the website, the phone line, warning calls and text links) ─
// by: 'owner' | 'trusted' | 'admin'. Returns { ok, will?, error? }.
async function changeReleaseDate(willId, { newDate = null, postponeDays = null, by, channel, userId = null }) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const r = await client.query(
      `SELECT vw.*, u.will_test_account FROM voice_wills vw JOIN users u ON u.id = vw.user_id
       WHERE vw.id = $1 AND vw.deleted_at IS NULL FOR UPDATE OF vw`, [willId]);
    const will = r.rows[0];
    if (!will) { await client.query('ROLLBACK'); return { ok: false, error: 'NOT_FOUND' }; }
    if (will.release_flow !== 'auto') { await client.query('ROLLBACK'); return { ok: false, error: 'ADMIN_FLOW' }; }
    if (will.is_released || ['releasing', 'released'].includes(will.release_state)) { await client.query('ROLLBACK'); return { ok: false, error: 'ALREADY_RELEASED' }; }
    if (by === 'trusted' && will.trusted_postpones_in_row >= TRUSTED_POSTPONE_LIMIT) { await client.query('ROLLBACK'); return { ok: false, error: 'TRUSTED_LIMIT' }; }

    const now = Date.now();
    const day = dayMs(will.will_test_account);
    let target;
    if (postponeDays) {
      // 30 days from today or from the current date, whichever is later
      target = new Date(Math.max(now, new Date(will.release_date).getTime()) + postponeDays * day);
    } else {
      target = new Date(newDate);
      if (isNaN(target)) { await client.query('ROLLBACK'); return { ok: false, error: 'BAD_DATE' }; }
      // A new date must leave room for the warnings (at least 4 days away)
      if (target.getTime() < now + 4 * day) { await client.query('ROLLBACK'); return { ok: false, error: 'TOO_SOON' }; }
      if (target.getTime() > now + 10 * 365 * DAY_MS) { await client.query('ROLLBACK'); return { ok: false, error: 'TOO_FAR' }; }
    }
    if (by === 'trusted' && postponeDays == null) { await client.query('ROLLBACK'); return { ok: false, error: 'TRUSTED_POSTPONE_ONLY' }; }

    const updated = await client.query(
      `UPDATE voice_wills
       SET release_date = $2, warning_stage = 0, last_warning_at = NULL,
           release_state = CASE WHEN release_state = 'paused' THEN 'paused' ELSE 'scheduled' END,
           trusted_postpones_in_row = CASE WHEN $3 = 'trusted' THEN trusted_postpones_in_row + 1
                                           WHEN $3 = 'owner' THEN 0 ELSE trusted_postpones_in_row END,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $1 RETURNING *`,
      [willId, target, by]
    );
    await logEvent(client, willId, postponeDays ? 'postponed' : 'date_changed', by, channel,
      { oldDate: will.release_date, newDate: target, details: postponeDays ? { days: postponeDays } : {}, createdBy: userId });
    await client.query('COMMIT');
    return { ok: true, will: updated.rows[0] };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    logger.error(`Changing will ${willId} release date failed: ${err.message}`);
    return { ok: false, error: 'ERROR' };
  } finally {
    client.release();
  }
}

// ── Warnings ──────────────────────────────────────────────────────────────────────────────────
async function sendSms(to, body) {
  if (!twilioClient || !process.env.TWILIO_PHONE_NUMBER) throw new Error('Twilio not configured');
  const m = await twilioClient.messages.create({ to, from: process.env.TWILIO_PHONE_NUMBER, body,
    statusCallback: process.env.TWILIO_SMS_STATUS_CALLBACK_URL || undefined });
  return m.sid;
}

async function placeCall(to, twiml) {
  if (!twilioClient || !process.env.TWILIO_PHONE_NUMBER) throw new Error('Twilio not configured');
  const c = await twilioClient.calls.create({ to, from: process.env.TWILIO_PHONE_NUMBER, twiml, timeout: 30,
    statusCallback: process.env.TWILIO_STATUS_CALLBACK_URL || undefined });
  return c.sid;
}

const SAY = (text) => `<Say voice="Polly.Joanna" language="en-US">${xml(text)}</Say>`;

// Warning call: press 1 to postpone 30 days, 2 for a new date. The key presses go to
// routes/willRelease.js, which asks the owner for their PIN (or the trusted contact for a code).
function warningCallTwiml(will, audience) {
  const base = apiBaseUrl();
  const when = dateText(will.release_date, tzOf(will));
  const intro = audience === 'owner'
    ? `Hello, this is SureTalk. Your voice will is set to be released on ${when}.`
    : `Hello, this is SureTalk. ${will.owner_name || 'Someone'} named you as a trusted contact. Their voice will is set to be released on ${when}, and they have not answered our reminders.`;
  const choices = audience === 'owner'
    ? 'To postpone it by 30 days, press 1. To choose a new date, press 2. To let it go out as planned, simply hang up.'
    : 'To postpone it by 30 days, press 1. To let it go out as planned, simply hang up.';
  if (!base) return `<?xml version="1.0" encoding="UTF-8"?><Response>${SAY(intro)}${SAY('To postpone it, use the link in the text we sent you, or call 1 8 5 5 6 8 0 4 5 2 2.')}</Response>`;
  const action = xml(`${base}/api/will-release/call/menu?w=${will.id}&a=${audience}`);
  return `<?xml version="1.0" encoding="UTF-8"?><Response>${SAY(intro)}` +
    `<Gather numDigits="1" timeout="8" action="${action}" method="POST">${SAY(choices)}</Gather>` +
    `${SAY('We did not get a choice. You can still postpone using the link in the text we sent you. Goodbye.')}</Response>`;
}

async function sendWarning(will, stage) {
  const tz = tzOf(will);
  const when = dateText(will.release_date, tz);
  const sent = { stage, ownerCall: null, ownerText: null, ownerEmail: null, trustedCall: null, trustedText: null };
  const attempt = async (key, fn) => {
    try { await fn(); sent[key] = 'sent'; } catch (err) { sent[key] = 'failed'; logger.warn(`Will ${will.id} warning ${stage} ${key} failed: ${err.message}`); }
  };

  if (stage === 1 || stage === 2) {
    const link = await createActionLink(will, 'owner');
    if (will.owner_phone) {
      await attempt('ownerCall', () => placeCall(will.owner_phone, warningCallTwiml(will, 'owner')));
      await attempt('ownerText', () => sendSms(will.owner_phone,
        `SureTalk: Your voice will is set to be released on ${when}. To postpone it or choose a new date (PIN needed): ${link} Reply STOP to opt out.`));
    }
    if (stage === 1 && will.owner_email) {
      await attempt('ownerEmail', () => emailService.sendWillReleaseWarningEmail(will.owner_email, will.owner_name,
        { willTitle: willTitle(will), releaseDateText: when, postponeUrl: link }));
    }
  }
  if (stage === 3) {
    if (will.trusted_phone) {
      const tlink = await createActionLink(will, 'trusted');
      await attempt('trustedCall', () => placeCall(will.trusted_phone, warningCallTwiml(will, 'trusted')));
      await attempt('trustedText', () => sendSms(will.trusted_phone,
        `SureTalk: ${will.owner_name || 'Someone'} named you as a trusted contact. Their voice will is set to be released on ${when}. If it should wait, postpone it here: ${tlink} Reply STOP to opt out.`));
    }
    if (will.owner_phone) {
      const link = await createActionLink(will, 'owner');
      await attempt('ownerText', () => sendSms(will.owner_phone,
        `SureTalk: Last reminder. Your voice will is released tomorrow, ${when}. To postpone (PIN needed): ${link} Reply STOP to opt out.`));
    }
  }
  return sent;
}

// ── Release ───────────────────────────────────────────────────────────────────────────────────
// Same delivery as the admin Release button (private 30-day link by text and email), plus a call
// that plays the will. `willAudioUrl` and `buildRecipients` come from routes/adminWills.js.
async function deliverWill(will, { willAudioUrl, buildRecipients }) {
  const recipients = (await buildRecipients(will)).filter(r => r.reachable);
  const expiresAt = new Date(Date.now() + RELEASE_LINK_DAYS * DAY_MS);
  const expiresDate = expiresAt.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
  const ownerName = will.owner_name || 'Someone';
  let audioUrl = null;
  try { audioUrl = await willAudioUrl(will); } catch (err) { logger.warn(`Will ${will.id} audio URL failed: ${err.message}`); }
  const results = [];

  for (const r of recipients) {
    const token = crypto.randomUUID();
    const listenUrl = `${process.env.FRONTEND_URL}/will/${token}`;
    let smsStatus = 'not_sent', emailStatus = 'not_sent', callStatus = 'not_sent';

    if (r.phone && audioUrl) {
      try {
        await placeCall(r.phone, `<?xml version="1.0" encoding="UTF-8"?><Response>` +
          SAY(`Hello. This is SureTalk, with a voice will that ${ownerName} recorded for you.`) + '<Pause length="1"/>' +
          `<Play>${xml(audioUrl)}</Play><Pause length="1"/>` +
          SAY('We have also sent you a private link so you can listen again. Goodbye.') + '</Response>');
        callStatus = 'sent';
      } catch (err) { callStatus = 'failed'; logger.warn(`Will ${will.id} release call to ${last4(r.phone)} failed: ${err.message}`); }
    }
    if (r.phone) {
      try {
        await sendSms(r.phone, `SureTalk: ${ownerName} left a voice will for you. Listen privately here (link works until ${expiresDate}): ${listenUrl}\n\nReply STOP to opt out.`);
        smsStatus = 'sent';
      } catch (err) { smsStatus = 'failed'; logger.warn(`Will ${will.id} release text to ${last4(r.phone)} failed: ${err.message}`); }
    }
    if (r.email) {
      try {
        await emailService.sendWillReleasedEmail(r.email, r.name, { ownerName, listenUrl, expiresDate });
        emailStatus = 'sent';
      } catch (err) { emailStatus = 'failed'; logger.warn(`Will ${will.id} release email failed: ${err.message}`); }
    }
    await pool.query(
      `INSERT INTO will_release_links (token, will_id, contact_id, recipient_name, recipient_phone, recipient_email,
                                       sms_status, email_status, expires_at, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NULL)`,
      [token, will.id, r.contactId, r.name, r.phone, r.email, smsStatus, emailStatus, expiresAt]
    );
    results.push({ phone: r.phone ? last4(r.phone) : null, call: callStatus, sms: smsStatus, email: emailStatus });
  }
  const delivered = results.filter(r => [r.call, r.sms, r.email].includes('sent')).length;
  return { recipients: results.length, delivered, results };
}

// ── Owner's PIN (the same PIN the phone line uses, stored hashed in the phone line's Users table) ─
// 5 wrong PINs for a will in 30 minutes (calls and links together) locks postponing for 30 minutes.
const PIN_LOCK = { tries: 5, minutes: 30 };
let dynamoDoc;
const dynamo = () => {
  if (!dynamoDoc) {
    const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
    const { DynamoDBDocumentClient } = require('@aws-sdk/lib-dynamodb');
    dynamoDoc = DynamoDBDocumentClient.from(new DynamoDBClient({
      region: process.env.IVR_AWS_REGION || 'eu-central-1',
      credentials: process.env.AWS_ACCESS_KEY_ID
        ? { accessKeyId: process.env.AWS_ACCESS_KEY_ID, secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY }
        : undefined,
      maxAttempts: 3,
    }));
  }
  return dynamoDoc;
};
// '+14045551234' -> '4045551234' (the phone line's account id)
const phoneLineId = (phone) => {
  const d = String(phone || '').replace(/\D/g, '');
  if (d.length === 11 && d.startsWith('1')) return d.slice(1);
  return d.length === 10 ? d : null;
};

async function pinLocked(willId) {
  const r = await pool.query(
    `SELECT count(*)::int n FROM will_release_events
     WHERE will_id = $1 AND event = 'pin_failed' AND created_at > NOW() - ($2 * interval '1 minute')`,
    [willId, PIN_LOCK.minutes]);
  return r.rows[0].n >= PIN_LOCK.tries;
}

// → { ok: true } | { ok: false, reason: 'LOCKED' | 'NO_PHONE_ACCOUNT' | 'WRONG_PIN' | 'PIN_FORMAT' }
async function checkOwnerPin(will, pin, channel) {
  if (!/^\d{4}$/.test(String(pin || ''))) return { ok: false, reason: 'PIN_FORMAT' };
  if (await pinLocked(will.id)) return { ok: false, reason: 'LOCKED' };
  const id = phoneLineId(will.owner_phone);
  if (!id) return { ok: false, reason: 'NO_PHONE_ACCOUNT' };
  const { GetCommand } = require('@aws-sdk/lib-dynamodb');
  const r = await dynamo().send(new GetCommand({
    TableName: process.env.DYNAMO_USERS_TABLE || 'Users', Key: { userId: id }, ProjectionExpression: 'userPin, #st',
    ExpressionAttributeNames: { '#st': 'status' } }));
  const hashed = r.Item?.status !== 'deleted' ? r.Item?.userPin : null;
  if (!hashed) return { ok: false, reason: 'NO_PHONE_ACCOUNT' };
  const bcrypt = require('bcrypt');
  if (await bcrypt.compare(String(pin), String(hashed).replace(/^\$2y\$/, '$2a$'))) return { ok: true };
  await logEvent(null, will.id, 'pin_failed', 'owner', channel);
  return { ok: false, reason: (await pinLocked(will.id)) ? 'LOCKED' : 'WRONG_PIN' };
}

// ── New wills ─────────────────────────────────────────────────────────────────────────────────
// Whether a new will from this account follows the automatic rules (instead of waiting for an admin)
async function autoReleaseFor(userId) {
  if (mode() === 'on') return true;
  if (mode() !== 'test') return false;
  const r = await pool.query('SELECT will_test_account FROM users WHERE id = $1', [userId]);
  return !!r.rows[0]?.will_test_account;
}

const cleanPhone = (v) => {
  const d = String(v || '').replace(/\D/g, '');
  if (d.length === 10) return `+1${d}`;
  if (d.length === 11 && d.startsWith('1')) return `+${d}`;
  return null;
};

// Called right after a will is saved (website or phone line). Gives it its release date and trusted
// contact when the automatic rules apply; otherwise leaves it with admins. Never throws.
async function setUpNewWill(will, { chosenDate = null, timezone = null, trusted = null, channel = 'web' } = {}) {
  try {
    if (!(await autoReleaseFor(will.user_id))) return null;
    const date = initialReleaseDate(chosenDate);
    const tz = timezone && validTz(timezone) ? timezone : DEFAULT_TZ;
    const tPhone = cleanPhone(trusted?.phone);
    const r = await pool.query(
      `UPDATE voice_wills SET release_flow = 'auto', release_state = 'scheduled', release_condition = 'date',
              release_date = $2, owner_timezone = $3, trusted_name = $4, trusted_phone = $5, trusted_email = $6,
              warning_stage = 0, last_warning_at = NULL, updated_at = CURRENT_TIMESTAMP
       WHERE id = $1 RETURNING *`,
      [will.id, date, tz, tPhone ? String(trusted?.name || '').trim().slice(0, 255) || null : null, tPhone,
       tPhone && trusted?.email ? String(trusted.email).trim().slice(0, 255) : null]);
    await logEvent(null, will.id, 'date_set', 'owner', channel, { newDate: date, details: { chosen: !!chosenDate, trustedContact: !!tPhone } });
    return r.rows[0];
  } catch (err) {
    logger.error(`Setting up automatic release for will ${will.id} failed (stays with admins): ${err.message}`);
    return null;
  }
}

async function setTrustedContact(willId, { name, phone, email }, userId) {
  const tPhone = phone ? cleanPhone(phone) : null;
  if (phone && !tPhone) return { ok: false, error: 'BAD_PHONE' };
  const r = await pool.query(
    `UPDATE voice_wills SET trusted_name = $2, trusted_phone = $3, trusted_email = $4, trusted_postpones_in_row = 0,
            updated_at = CURRENT_TIMESTAMP
     WHERE id = $1 AND release_flow = 'auto' AND deleted_at IS NULL RETURNING id`,
    [willId, tPhone ? String(name || '').trim().slice(0, 255) || null : null, tPhone,
     tPhone && email ? String(email).trim().slice(0, 255) : null]);
  if (!r.rowCount) return { ok: false, error: 'NOT_FOUND' };
  await logEvent(null, willId, 'trusted_changed', 'owner', 'web', { details: { removed: !tPhone }, createdBy: userId });
  return { ok: true };
}

// Admin dispute pause. A paused will gets no warnings and is not released until resumed.
async function setPaused(willId, paused, adminId, reason) {
  const r = await pool.query(paused
    ? `UPDATE voice_wills SET release_state = 'paused', paused_at = CURRENT_TIMESTAMP, paused_by = $2, paused_reason = $3,
              updated_at = CURRENT_TIMESTAMP
       WHERE id = $1 AND release_flow = 'auto' AND release_state IN ('scheduled', 'failed') RETURNING release_date`
    : `UPDATE voice_wills SET release_state = 'scheduled', warning_stage = 0, last_warning_at = NULL, release_attempts = 0,
              paused_at = NULL, paused_by = NULL, paused_reason = NULL, updated_at = CURRENT_TIMESTAMP,
              release_date = GREATEST(release_date, NOW() + interval '4 days')
       WHERE id = $1 AND release_flow = 'auto' AND release_state IN ('paused', 'failed') RETURNING release_date`,
    paused ? [willId, adminId, reason || null] : [willId]);
  if (!r.rowCount) return { ok: false };
  await logEvent(null, willId, paused ? 'paused' : 'resumed', 'admin', 'web',
    { newDate: r.rows[0].release_date, details: reason ? { reason } : {}, createdBy: adminId });
  return { ok: true, releaseDate: r.rows[0].release_date };
}

module.exports = {
  mode, isEnabled, dayMs, withinCallHours, initialReleaseDate, tzOf, dateText, willTitle, hash, apiBaseUrl, phoneLineId,
  logEvent, createActionLink, findActionLink, changeReleaseDate, sendWarning, deliverWill, sendSms,
  checkOwnerPin, autoReleaseFor, setUpNewWill, setTrustedContact, setPaused,
  DEFAULT_TZ, POSTPONE_DAYS, TRUSTED_POSTPONE_LIMIT, MAX_RELEASE_ATTEMPTS,
};
