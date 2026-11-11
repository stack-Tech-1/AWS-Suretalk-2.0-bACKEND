// routes/phoneReset.js
// Public "change my phone ID or PIN" page (website /reset-pin). Works for phone-line customers,
// app customers and people who use both. Nobody is signed in, so every change needs a 6-digit code
// sent to the phone number (or to the account's email). Codes: utils/phoneCodes.js (10 minutes,
// max 3 sends per 10 minutes, 5 wrong guesses and the code is thrown away).
//
//   POST /lookup                 { phone }                       -> which ways we can send a code
//   POST /send-code              { phone, via: 'sms'|'email' }   -> sends the code
//   POST /check-code             { phone, code }                 -> is the code right (does not use it up)
//   POST /set-pin                { phone, code, pin }            -> new 4-digit phone PIN
//   POST /send-new-number-code   { phone, code, newPhone }       -> texts a code to the NEW number
//   POST /change-number          { phone, code, newPhone, newCode } -> moves the account to the new number
//
// The phone line only accepts US numbers (+1, the 10-digit ID callers type in).
const express = require('express');
const axios = require('axios');
const { pool } = require('../config/database');
const logger = require('../utils/logger');
const { issueCode, checkCode, markCodeUsed } = require('../utils/phoneCodes');
const { appUserByPhone, phoneLineAccount } = require('../utils/stripePlans');
const { syncAccountToIvr } = require('../utils/syncIvr');
const { ivrTierName } = require('../utils/tierMapping');
const emailService = require('../utils/emailService');

const router = express.Router();
const PURPOSE = 'pin_reset';
const NEW_NUMBER = 'change_number';
const WEAK_PINS = new Set(['1234', '4321', '0123', '1111', '0000', '2222', '3333', '4444', '5555', '6666', '7777', '8888', '9999', '1212', '2580']);

// '+1 (404) 555-1234', '4045551234', '14045551234' -> '+14045551234'; anything else -> null
const usPhone = (v) => {
  const d = String(v || '').replace(/[^0-9]/g, '');
  if (d.length === 10) return `+1${d}`;
  if (d.length === 11 && d.startsWith('1')) return `+${d}`;
  return null;
};
const maskEmail = (e) => {
  const [user, domain] = String(e).split('@');
  if (!domain) return null;
  return `${user.slice(0, 1)}${'*'.repeat(Math.max(2, Math.min(user.length - 1, 6)))}@${domain}`;
};
const last4 = (phone) => String(phone).slice(-4);
const fail = (res, status, code, error) => res.status(status).json({ success: false, code, error });

const twilioClient = () => {
  if (!process.env.TWILIO_ACCOUNT_SID || !process.env.TWILIO_AUTH_TOKEN || !process.env.TWILIO_PHONE_NUMBER) return null;
  return require('twilio')(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
};
const sendSms = async (to, body) => {
  const tw = twilioClient();
  if (!tw) throw new Error('Text messages are not set up');
  await tw.messages.create({ to, from: process.env.TWILIO_PHONE_NUMBER, body });
};
// Security notices: best effort, never block the change
const notify = (to, body) => sendSms(to, body).catch(err => logger.warn(`PIN reset notice to ${last4(to)} failed: ${err.message}`));

// Everything we know about a number: its phone-line account and/or app account
async function findAccount(phone) {
  const [line, app] = await Promise.all([phoneLineAccount(phone), appUserByPhone(phone)]);
  const phoneLine = line && line.status !== 'deleted' ? line : null;
  if (!phoneLine && !app) return null;
  return { phoneLine, app, email: app?.email || phoneLine?.email || null, name: app?.full_name || phoneLine?.firstName || null };
}

const CODE_ERRORS = {
  NO_CODE: 'Your code has expired. Ask for a new one.',
  WRONG_CODE: "That code isn't right. Check it and try again.",
  TOO_MANY_GUESSES: 'Too many wrong codes. Ask for a new one.',
};
async function requireCode(res, phone, purpose, code) {
  if (!/^\d{6}$/.test(String(code || ''))) { fail(res, 400, 'CODE_FORMAT', 'Enter the 6-digit code.'); return null; }
  const check = await checkCode(phone, purpose, String(code));
  if (!check.ok) { fail(res, 400, `CODE_${check.reason}`, CODE_ERRORS[check.reason]); return null; }
  return check;
}

const ivrConfigured = () => !!(process.env.IVR_API_URL && process.env.IVR_REQUEST_KEY);
const audit = (userId, message, metadata) => pool.query(
  `INSERT INTO system_logs (user_id, level, service, message, metadata) VALUES ($1, 'info', 'account', $2, $3)`,
  [userId || null, message, JSON.stringify(metadata)]
).catch(() => {});

// ── 1. Which ways can we reach this person? ────────────────────────────────
router.post('/lookup', async (req, res) => {
  try {
    const phone = usPhone(req.body.phone);
    if (!phone) return fail(res, 400, 'NOT_US', 'Enter your 10-digit US phone number.');
    const acc = await findAccount(phone);
    if (!acc) return fail(res, 404, 'NO_ACCOUNT', 'We could not find a SureTalk account for that number.');
    res.json({ success: true, data: {
      phone, hasPhoneLine: !!acc.phoneLine, hasApp: !!acc.app,
      email: acc.email ? maskEmail(acc.email) : null,
    } });
  } catch (err) {
    logger.error(`PIN reset lookup failed: ${err.message}`);
    fail(res, 500, 'ERROR', 'Something went wrong. Please try again.');
  }
});

// ── 2. Send the code (by text to the number, or to the account's email) ────
router.post('/send-code', async (req, res) => {
  try {
    const phone = usPhone(req.body.phone);
    if (!phone) return fail(res, 400, 'NOT_US', 'Enter your 10-digit US phone number.');
    const via = req.body.via === 'email' ? 'email' : 'sms';
    const acc = await findAccount(phone);
    if (!acc) return fail(res, 404, 'NO_ACCOUNT', 'We could not find a SureTalk account for that number.');
    if (via === 'email' && !acc.email) return fail(res, 400, 'NO_EMAIL', 'This account has no email address. Choose a text message instead.');

    const issued = await issueCode(phone, PURPOSE);
    if (!issued.ok) return fail(res, 429, 'TOO_MANY_CODES', 'Too many codes sent. Wait 10 minutes and try again.');

    if (via === 'sms') {
      await sendSms(phone, `Your SureTalk code to change your ID or PIN is ${issued.code}. It expires in 10 minutes. Do not share it with anyone.`);
    } else {
      await emailService.sendAccountCodeEmail(acc.email, acc.name, { code: issued.code, phoneEnding: last4(phone) });
    }
    res.json({ success: true, data: { via, to: via === 'sms' ? `the number ending ${last4(phone)}` : maskEmail(acc.email) } });
  } catch (err) {
    logger.error(`PIN reset send-code failed: ${err.message}`);
    fail(res, 502, 'SEND_FAILED', 'We could not send the code. Please try again.');
  }
});

// ── 3. Check the code before showing the next step (does not use it up) ───
router.post('/check-code', async (req, res) => {
  try {
    const phone = usPhone(req.body.phone);
    if (!phone) return fail(res, 400, 'NOT_US', 'Enter your 10-digit US phone number.');
    if (!(await requireCode(res, phone, PURPOSE, req.body.code))) return;
    res.json({ success: true });
  } catch (err) {
    logger.error(`PIN reset check-code failed: ${err.message}`);
    fail(res, 500, 'ERROR', 'Something went wrong. Please try again.');
  }
});

// ── 4a. New PIN ────────────────────────────────────────────────────────────
router.post('/set-pin', async (req, res) => {
  try {
    const phone = usPhone(req.body.phone);
    if (!phone) return fail(res, 400, 'NOT_US', 'Enter your 10-digit US phone number.');
    const pin = String(req.body.pin || '');
    if (!/^\d{4}$/.test(pin)) return fail(res, 400, 'PIN_FORMAT', 'Your PIN must be exactly 4 digits.');
    if (WEAK_PINS.has(pin)) return fail(res, 400, 'WEAK_PIN', 'Choose a PIN that is harder to guess.');
    if (!ivrConfigured()) return fail(res, 503, 'UNAVAILABLE', 'The phone line is not available right now. Please try again later.');

    const check = await requireCode(res, phone, PURPOSE, req.body.code);
    if (!check) return;
    const acc = await findAccount(phone);
    if (!acc) return fail(res, 404, 'NO_ACCOUNT', 'We could not find a SureTalk account for that number.');

    const key = process.env.IVR_REQUEST_KEY;
    let created = false;
    if (acc.phoneLine) {
      const r = await axios.post(`${process.env.IVR_API_URL}/UpdateuserloginsNew`,
        { key, oldUserId: phone, newPin: pin }, { timeout: 10000, validateStatus: () => true });
      if (r.status !== 200) {
        logger.error(`UpdateuserloginsNew returned ${r.status}: ${JSON.stringify(r.data).slice(0, 200)}`);
        return fail(res, 502, 'PHONE_LINE_FAILED', 'The phone line could not save your PIN. Please try again in a moment.');
      }
      // They just proved they own this number, so phone sign-in is switched on
      if (acc.phoneLine.verified !== true) syncAccountToIvr(phone, { verified: true });
    } else {
      // App account without phone access yet: create it (same as Settings -> Phone line)
      const r = await axios.post(`${process.env.IVR_API_URL}/saveUserDataNew`,
        { key, userId: phone.slice(2), userPin: pin, subscription_tier: ivrTierName(acc.app.subscription_tier) },
        { timeout: 10000, validateStatus: () => true });
      if (r.status !== 201 && r.status !== 200) {
        logger.error(`saveUserDataNew returned ${r.status}: ${JSON.stringify(r.data).slice(0, 200)}`);
        return fail(res, 502, 'PHONE_LINE_FAILED', 'The phone line could not save your PIN. Please try again in a moment.');
      }
      created = r.status === 201;
      if (created) {
        require('../utils/phoneLineContent').pushAllToPhoneLine(acc.app.id)
          .catch(err => logger.error(`Copying recordings after PIN reset failed: ${err.message}`));
      }
    }
    await markCodeUsed(check.id);
    audit(acc.app?.id, created ? 'Phone line account created (reset page)' : 'Phone PIN changed (reset page)', { phoneEnding: last4(phone) });
    notify(phone, 'Your SureTalk PIN was just changed. If this was not you, contact contact@suretalknow.com right away.');
    res.json({ success: true, data: { created } });
  } catch (err) {
    logger.error(`PIN reset set-pin failed: ${err.message}`);
    fail(res, 502, 'ERROR', 'Something went wrong. Please try again.');
  }
});

// The new number must be free on both sides
async function newNumberProblem(phone, newPhone) {
  if (!newPhone) return ['NOT_US', 'Enter the new 10-digit US phone number.'];
  if (newPhone === phone) return ['SAME_NUMBER', 'That is already your number.'];
  const taken = await findAccount(newPhone);
  if (taken) return ['NUMBER_TAKEN', 'That number already has a SureTalk account.'];
  return null;
}

// ── 4b. Change number: first prove the new number is theirs ────────────────
router.post('/send-new-number-code', async (req, res) => {
  try {
    const phone = usPhone(req.body.phone);
    const newPhone = usPhone(req.body.newPhone);
    if (!phone) return fail(res, 400, 'NOT_US', 'Enter your 10-digit US phone number.');
    if (!(await requireCode(res, phone, PURPOSE, req.body.code))) return;
    const problem = await newNumberProblem(phone, newPhone);
    if (problem) return fail(res, problem[0] === 'NUMBER_TAKEN' ? 409 : 400, ...problem);

    const issued = await issueCode(newPhone, NEW_NUMBER);
    if (!issued.ok) return fail(res, 429, 'TOO_MANY_CODES', 'Too many codes sent. Wait 10 minutes and try again.');
    await sendSms(newPhone, `Your SureTalk code to move your account to this number is ${issued.code}. It expires in 10 minutes. Do not share it with anyone.`);
    res.json({ success: true, data: { to: `the number ending ${last4(newPhone)}` } });
  } catch (err) {
    logger.error(`PIN reset send-new-number-code failed: ${err.message}`);
    fail(res, 502, 'SEND_FAILED', 'We could not send the code. Please try again.');
  }
});

router.post('/change-number', async (req, res) => {
  try {
    const phone = usPhone(req.body.phone);
    const newPhone = usPhone(req.body.newPhone);
    if (!phone) return fail(res, 400, 'NOT_US', 'Enter your 10-digit US phone number.');
    const problem = await newNumberProblem(phone, newPhone);
    if (problem) return fail(res, problem[0] === 'NUMBER_TAKEN' ? 409 : 400, ...problem);

    const oldCheck = await requireCode(res, phone, PURPOSE, req.body.code);
    if (!oldCheck) return;
    const newCheck = await requireCode(res, newPhone, NEW_NUMBER, req.body.newCode);
    if (!newCheck) return;
    const acc = await findAccount(phone);
    if (!acc) return fail(res, 404, 'NO_ACCOUNT', 'We could not find a SureTalk account for that number.');

    // Phone line first (PIN, recordings, wills and plan move in one step), then the app
    const moveLine = async (from, to) => axios.post(`${process.env.IVR_API_URL}/sync-user`,
      { userId: from, source: 'app', action: 'change_phone', newUserId: to },
      { headers: { Authorization: `Bearer ${process.env.IVR_SYNC_TOKEN}` }, timeout: 10000, validateStatus: () => true });

    if (acc.phoneLine) {
      if (!process.env.IVR_API_URL) return fail(res, 503, 'UNAVAILABLE', 'The phone line is not available right now. Please try again later.');
      const r = await moveLine(phone, newPhone);
      if (r.status === 409) return fail(res, 409, 'NUMBER_TAKEN', 'That number already has a SureTalk account.');
      if (r.status !== 200) {
        logger.error(`change_phone returned ${r.status}: ${JSON.stringify(r.data).slice(0, 200)}`);
        return fail(res, 502, 'PHONE_LINE_FAILED', 'The phone line could not move your account. Please try again in a moment.');
      }
    }
    if (acc.app) {
      try {
        await pool.query('UPDATE users SET phone = $1, updated_at = NOW() WHERE id = $2', [newPhone, acc.app.id]);
      } catch (err) {
        // Put the phone line back so both sides still agree
        if (acc.phoneLine) await moveLine(newPhone, phone).catch(() => {});
        throw err;
      }
    }
    await Promise.all([markCodeUsed(oldCheck.id), markCodeUsed(newCheck.id)]);
    audit(acc.app?.id, 'Phone number changed (reset page)', { from: last4(phone), to: last4(newPhone) });
    notify(phone, `Your SureTalk account was moved to the number ending ${last4(newPhone)}. If this was not you, contact contact@suretalknow.com right away.`);
    notify(newPhone, 'Your SureTalk account now uses this number. Call in with this number as your ID and your usual PIN.');
    res.json({ success: true, data: { newPhone } });
  } catch (err) {
    logger.error(`PIN reset change-number failed: ${err.message}`);
    fail(res, 502, 'ERROR', 'Something went wrong. Please try again.');
  }
});

module.exports = router;
module.exports._test = { usPhone, maskEmail };
