// Automatic voice will release: everything people use to see or change a release date.
//   /call/*            key presses on a warning call (Twilio only, signature checked)
//   /link/:token*      the postpone page opened from a warning text (owner: PIN, trusted contact: code)
//   /wills/:id*        the owner's own will page on the website (logged in)
// Rules live in utils/willRelease.js. All of this only matters for wills with release_flow = 'auto'.

const express = require('express');
const twilio = require('twilio');
const { pool } = require('../config/database');
const { authenticate } = require('../middleware/auth');
const logger = require('../utils/logger');
const wr = require('../utils/willRelease');
const { issueCode, checkCode, markCodeUsed } = require('../utils/phoneCodes');

const router = express.Router();
const urlencoded = express.urlencoded({ extended: false });
const isUuid = (v) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(v));
const digits = (p) => String(p || '').replace(/\D/g, '').slice(-10);
const fail = (res, status, code, error) => res.status(status).json({ success: false, code, error });

async function loadWill(id) {
  if (!isUuid(id)) return null;
  const r = await pool.query(
    `SELECT vw.*, u.full_name AS owner_name, u.email AS owner_email, u.phone AS owner_phone, u.will_test_account
     FROM voice_wills vw JOIN users u ON u.id = vw.user_id WHERE vw.id = $1 AND vw.deleted_at IS NULL`, [id]);
  return r.rows[0] || null;
}

const CHANGE_ERRORS = {
  NOT_FOUND: 'This voice will could not be found.',
  ADMIN_FLOW: 'This voice will is released by our team, not on a date. Contact us to change it.',
  ALREADY_RELEASED: 'This voice will has already been released.',
  TRUSTED_LIMIT: 'This voice will has been postponed by a trusted contact 3 times in a row. The owner needs to respond, or contact us.',
  TRUSTED_POSTPONE_ONLY: 'A trusted contact can postpone by 30 days only.',
  BAD_DATE: 'Choose a valid date.',
  TOO_SOON: 'Choose a date at least 4 days from today, so there is time for the reminders.',
  TOO_FAR: 'Choose a date within the next 10 years.',
  ERROR: 'Something went wrong. Please try again.',
};

const publicInfo = (will) => ({
  releaseDate: will.release_date,
  releaseDateText: wr.dateText(will.release_date, wr.tzOf(will)),
  state: will.release_state,
});

// ═══ 1. Warning calls (Twilio) ════════════════════════════════════════════════════════════════
const verifyTwilio = (req, res, next) => {
  const token = process.env.TWILIO_AUTH_TOKEN;
  if (!token) return res.status(503).type('text/xml').send('<Response><Hangup/></Response>');
  const url = `${wr.apiBaseUrl() || `https://${req.get('host')}`}${req.originalUrl}`;
  if (!twilio.validateRequest(token, req.get('X-Twilio-Signature') || '', url, req.body || {})) {
    logger.warn(`Rejected will-release call webhook with a bad signature: ${req.path}`);
    return res.status(403).send('Forbidden');
  }
  next();
};

const VR = () => new twilio.twiml.VoiceResponse();
const say = (vr, text) => vr.say({ voice: 'Polly.Joanna', language: 'en-US' }, text);
const send = (res, vr) => res.type('text/xml').send(vr.toString());
const callUrl = (path, params) => `${wr.apiBaseUrl() || ''}/api/will-release/call/${path}?${new URLSearchParams(params)}`;
const spoken = (date, tz) => new Date(date).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric', timeZone: tz });

// The call must be to the person the warning was for, about a will that can still change
async function callContext(req) {
  const will = await loadWill(req.query.w);
  const audience = req.query.a === 'trusted' ? 'trusted' : 'owner';
  if (!will || will.release_flow !== 'auto' || will.release_state !== 'scheduled') return { will: null };
  const expected = audience === 'owner' ? will.owner_phone : will.trusted_phone;
  if (!expected || digits(expected) !== digits(req.body.To)) return { will: null };
  return { will, audience };
}

const sayChanged = (vr, will, result) => {
  if (result.ok) say(vr, `Done. Your voice will is now set to be released on ${spoken(result.will.release_date, wr.tzOf(will))}. We will remind you again before then. Goodbye.`);
  else say(vr, `${CHANGE_ERRORS[result.error] || CHANGE_ERRORS.ERROR} Goodbye.`);
};

router.post('/call/menu', urlencoded, verifyTwilio, async (req, res) => {
  const vr = VR();
  try {
    const { will, audience } = await callContext(req);
    if (!will) { say(vr, 'This reminder is no longer active. Goodbye.'); return send(res, vr); }
    const choice = String(req.body.Digits || '');

    if (audience === 'trusted') {
      // The call reached the trusted contact's own phone, so pressing 1 is their confirmation
      if (choice !== '1') { say(vr, 'Goodbye.'); return send(res, vr); }
      const result = await wr.changeReleaseDate(will.id, { postponeDays: wr.POSTPONE_DAYS, by: 'trusted', channel: 'warning_call' });
      if (result.ok) say(vr, `Thank you. The voice will is postponed until ${spoken(result.will.release_date, wr.tzOf(will))}. Goodbye.`);
      else say(vr, `${CHANGE_ERRORS[result.error] || CHANGE_ERRORS.ERROR} Goodbye.`);
      return send(res, vr);
    }

    if (choice === '1') {
      const g = vr.gather({ numDigits: 4, timeout: 10, action: callUrl('pin', { w: will.id, a: 'owner', c: 'p30', n: 0 }), method: 'POST' });
      say(g, 'To postpone by 30 days, enter your 4 digit SureTalk PIN.');
    } else if (choice === '2') {
      const g = vr.gather({ numDigits: 8, timeout: 15, action: callUrl('date', { w: will.id, a: 'owner' }), method: 'POST' });
      say(g, 'Enter the new date as 8 digits: two for the month, two for the day, and four for the year. For example, for March 5th, 2027, enter 0 3 0 5 2 0 2 7.');
    } else {
      say(vr, 'Your voice will stays on its current date. Goodbye.');
      return send(res, vr);
    }
    say(vr, 'We did not get an answer. Goodbye.');
    send(res, vr);
  } catch (err) {
    logger.error(`Will call menu failed: ${err.message}`);
    say(vr, 'Sorry, something went wrong. Please use the link in the text we sent you. Goodbye.');
    send(res, vr);
  }
});

// Noon on that day in the owner's time zone, so the date never shifts across midnight
function noonIn(tz, y, m, d) {
  const guess = Date.UTC(y, m - 1, d, 12);
  const hourThere = Number(new Intl.DateTimeFormat('en-US', { hour: 'numeric', hourCycle: 'h23', timeZone: tz }).format(new Date(guess)));
  return new Date(guess + (12 - hourThere) * 3600 * 1000);
}

router.post('/call/date', urlencoded, verifyTwilio, async (req, res) => {
  const vr = VR();
  try {
    const { will } = await callContext(req);
    if (!will || req.query.a !== 'owner') { say(vr, 'This reminder is no longer active. Goodbye.'); return send(res, vr); }
    const m = String(req.body.Digits || '').match(/^(\d{2})(\d{2})(\d{4})$/);
    const date = m && noonIn(wr.tzOf(will), +m[3], +m[1], +m[2]);
    const valid = date && !isNaN(date) && date.getUTCMonth() + 1 === +m[1];
    if (!valid) {
      const g = vr.gather({ numDigits: 8, timeout: 15, action: callUrl('date', { w: will.id, a: 'owner' }), method: 'POST' });
      say(g, 'That is not a valid date. Enter 2 digits for the month, 2 for the day, and 4 for the year.');
      say(vr, 'Goodbye.');
      return send(res, vr);
    }
    const g = vr.gather({ numDigits: 4, timeout: 10, action: callUrl('pin', { w: will.id, a: 'owner', c: `d${m[3]}${m[1]}${m[2]}`, n: 0 }), method: 'POST' });
    say(g, `You chose ${spoken(date, wr.tzOf(will))}. To confirm, enter your 4 digit SureTalk PIN.`);
    say(vr, 'We did not get your PIN. Goodbye.');
    send(res, vr);
  } catch (err) {
    logger.error(`Will call date failed: ${err.message}`);
    say(vr, 'Sorry, something went wrong. Goodbye.');
    send(res, vr);
  }
});

router.post('/call/pin', urlencoded, verifyTwilio, async (req, res) => {
  const vr = VR();
  try {
    const { will } = await callContext(req);
    if (!will || req.query.a !== 'owner') { say(vr, 'This reminder is no longer active. Goodbye.'); return send(res, vr); }
    const c = String(req.query.c || '');
    const tries = Math.min(Number(req.query.n) || 0, 3);
    const pin = await wr.checkOwnerPin(will, String(req.body.Digits || ''), 'warning_call');
    if (!pin.ok) {
      if (pin.reason === 'LOCKED') say(vr, 'Too many wrong PINs. For your security, please try again in 30 minutes. Goodbye.');
      else if (pin.reason === 'NO_PHONE_ACCOUNT') say(vr, 'We could not check your PIN. Please use the link in the text we sent you, or call 1 8 5 5 6 8 0 4 5 2 2. Goodbye.');
      else if (tries < 2) {
        const g = vr.gather({ numDigits: 4, timeout: 10, action: callUrl('pin', { w: will.id, a: 'owner', c, n: tries + 1 }), method: 'POST' });
        say(g, 'That PIN is not right. Please enter your 4 digit PIN again.');
        say(vr, 'Goodbye.');
      } else say(vr, 'That PIN is not right. Nothing was changed. Goodbye.');
      return send(res, vr);
    }
    let result;
    if (c === 'p30') result = await wr.changeReleaseDate(will.id, { postponeDays: wr.POSTPONE_DAYS, by: 'owner', channel: 'warning_call' });
    else {
      const m = c.match(/^d(\d{4})(\d{2})(\d{2})$/);
      result = m ? await wr.changeReleaseDate(will.id, { newDate: noonIn(wr.tzOf(will), +m[1], +m[2], +m[3]), by: 'owner', channel: 'warning_call' })
                 : { ok: false, error: 'BAD_DATE' };
    }
    sayChanged(vr, will, result);
    send(res, vr);
  } catch (err) {
    logger.error(`Will call PIN failed: ${err.message}`);
    say(vr, 'Sorry, something went wrong. Nothing was changed. Goodbye.');
    send(res, vr);
  }
});

// ═══ 2. Postpone page from a warning text ══════════════════════════════════════════════════════
const LINK_ERRORS = {
  NOT_FOUND: 'This link is not valid.',
  USED: 'This link has already been used. The release date was updated.',
  EXPIRED: 'This link has expired.',
  RELEASED: 'This voice will has already been released.',
  DATE_CHANGED: 'The release date has already been changed, so this link no longer works.',
  LOCKED: 'Too many wrong attempts. This link no longer works. Call 1-855-680-4522 or sign in to change the date.',
};

async function linkWill(req, res) {
  const found = await wr.findActionLink(req.params.token);
  if (!found.ok) { fail(res, found.reason === 'NOT_FOUND' ? 404 : 410, found.reason, LINK_ERRORS[found.reason]); return null; }
  const will = await loadWill(found.link.will_id);
  if (!will || will.release_flow !== 'auto') { fail(res, 404, 'NOT_FOUND', LINK_ERRORS.NOT_FOUND); return null; }
  if (will.release_state === 'paused') { fail(res, 409, 'PAUSED', 'This voice will is on hold while our team looks into it. Nothing is released until then.'); return null; }
  return { link: found.link, will };
}

const maskPhone = (p) => `(***) ***-${digits(p).slice(-4)}`;

router.get('/link/:token', async (req, res) => {
  try {
    const ctx = await linkWill(req, res);
    if (!ctx) return;
    const { link, will } = ctx;
    res.json({ success: true, data: {
      audience: link.audience,
      ...publicInfo(will),
      ownerFirstName: link.audience === 'trusted' ? String(will.owner_name || '').split(' ')[0] || null : null,
      trustedPhone: link.audience === 'trusted' ? maskPhone(will.trusted_phone) : null,
      canPickDate: link.audience === 'owner',
      trustedLimitReached: link.audience === 'trusted' && will.trusted_postpones_in_row >= wr.TRUSTED_POSTPONE_LIMIT,
      postponeDays: wr.POSTPONE_DAYS,
    } });
  } catch (err) {
    logger.error(`Will link lookup failed: ${err.message}`);
    fail(res, 500, 'ERROR', CHANGE_ERRORS.ERROR);
  }
});

// Trusted contact: text a one-time code to the phone the owner named
router.post('/link/:token/send-code', async (req, res) => {
  try {
    const ctx = await linkWill(req, res);
    if (!ctx) return;
    const { link, will } = ctx;
    if (link.audience !== 'trusted' || !will.trusted_phone) return fail(res, 400, 'NOT_TRUSTED', 'This link does not need a code.');
    const issued = await issueCode(will.trusted_phone, 'will_trusted');
    if (!issued.ok) return fail(res, 429, issued.reason, 'Too many codes were sent. Wait 10 minutes and try again.');
    await wr.sendSms(will.trusted_phone, `SureTalk: Your code to postpone the voice will is ${issued.code}. It expires in 10 minutes. Do not share it with anyone.`);
    res.json({ success: true, data: { sentTo: maskPhone(will.trusted_phone) } });
  } catch (err) {
    logger.error(`Will trusted code send failed: ${err.message}`);
    fail(res, 500, 'ERROR', 'We could not send the code. Please try again.');
  }
});

const bumpFailed = (linkId) => pool.query('UPDATE will_action_links SET failed_attempts = failed_attempts + 1 WHERE id = $1', [linkId]).catch(() => {});

// Body: { action: 'postpone' | 'date', date?: 'YYYY-MM-DD', pin? (owner), code? (trusted) }
router.post('/link/:token/postpone', async (req, res) => {
  try {
    const ctx = await linkWill(req, res);
    if (!ctx) return;
    const { link, will } = ctx;
    const action = req.body.action === 'date' ? 'date' : 'postpone';
    let codeId = null;

    if (link.audience === 'owner') {
      const pin = await wr.checkOwnerPin(will, req.body.pin, 'text_link');
      if (!pin.ok) {
        if (pin.reason === 'WRONG_PIN' || pin.reason === 'PIN_FORMAT') await bumpFailed(link.id);
        const msg = { PIN_FORMAT: 'Enter your 4-digit PIN.', WRONG_PIN: "That PIN isn't right.",
          LOCKED: 'Too many wrong PINs. Try again in 30 minutes.',
          NO_PHONE_ACCOUNT: "We couldn't check your PIN. Call 1-855-680-4522 or sign in to change the date." }[pin.reason];
        return fail(res, pin.reason === 'LOCKED' ? 429 : 400, pin.reason, msg);
      }
    } else {
      if (action !== 'postpone') return fail(res, 400, 'TRUSTED_POSTPONE_ONLY', CHANGE_ERRORS.TRUSTED_POSTPONE_ONLY);
      const check = await checkCode(will.trusted_phone, 'will_trusted', String(req.body.code || ''));
      if (!check.ok) {
        await bumpFailed(link.id);
        const msg = { NO_CODE: 'Your code has expired. Ask for a new one.', WRONG_CODE: "That code isn't right.", TOO_MANY_GUESSES: 'Too many wrong codes. Ask for a new one.' }[check.reason];
        return fail(res, 400, `CODE_${check.reason}`, msg);
      }
      codeId = check.id;
    }

    let newDate = null;
    if (action === 'date') {
      const m = String(req.body.date || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
      if (!m) return fail(res, 400, 'BAD_DATE', CHANGE_ERRORS.BAD_DATE);
      newDate = noonIn(wr.tzOf(will), +m[1], +m[2], +m[3]);
    }
    const result = await wr.changeReleaseDate(will.id, action === 'date'
      ? { newDate, by: 'owner', channel: 'text_link' }
      : { postponeDays: wr.POSTPONE_DAYS, by: link.audience, channel: 'text_link' });
    if (!result.ok) return fail(res, 400, result.error, CHANGE_ERRORS[result.error] || CHANGE_ERRORS.ERROR);

    if (codeId) await markCodeUsed(codeId);
    await pool.query('UPDATE will_action_links SET used_at = CURRENT_TIMESTAMP WHERE id = $1', [link.id]);
    res.json({ success: true, data: publicInfo({ ...will, ...result.will }) });
  } catch (err) {
    logger.error(`Will link postpone failed: ${err.message}`);
    fail(res, 500, 'ERROR', CHANGE_ERRORS.ERROR);
  }
});

// ═══ 3. Owner's will page on the website ═══════════════════════════════════════════════════════
// Whether this account's new wills get a release date (the website shows the new form only then)
router.get('/status', authenticate, async (req, res) => {
  try {
    res.json({ success: true, data: { automatic: await wr.autoReleaseFor(req.user.id), postponeDays: wr.POSTPONE_DAYS, defaultMonths: 6, minDaysAhead: 4 } });
  } catch (err) {
    logger.error(`Will release status failed: ${err.message}`);
    res.json({ success: true, data: { automatic: false } });
  }
});

async function ownWill(req, res) {
  const will = await loadWill(req.params.id);
  if (!will || will.user_id !== req.user.id) { fail(res, 404, 'NOT_FOUND', CHANGE_ERRORS.NOT_FOUND); return null; }
  return will;
}

router.get('/wills/:id', authenticate, async (req, res) => {
  try {
    const will = await ownWill(req, res);
    if (!will) return;
    const auto = will.release_flow === 'auto';
    const events = auto ? (await pool.query(
      `SELECT event, actor, channel, old_date, new_date, created_at FROM will_release_events
       WHERE will_id = $1 AND event <> 'pin_failed' ORDER BY created_at DESC LIMIT 20`, [will.id])).rows : [];
    res.json({ success: true, data: {
      flow: will.release_flow,
      ...(auto ? publicInfo(will) : { releaseDate: null, releaseDateText: null, state: null }),
      released: !!will.is_released,
      timezone: wr.tzOf(will),
      trustedContact: will.trusted_phone ? { name: will.trusted_name, phone: will.trusted_phone, email: will.trusted_email } : null,
      warningsSent: will.warning_stage,
      paused: will.release_state === 'paused',
      postponeDays: wr.POSTPONE_DAYS,
      history: events,
    } });
  } catch (err) {
    logger.error(`Will release info failed: ${err.message}`);
    fail(res, 500, 'ERROR', CHANGE_ERRORS.ERROR);
  }
});

// Body: { action: 'postpone' } or { action: 'date', date: 'YYYY-MM-DD' }. Signed in, so no PIN.
router.post('/wills/:id/release-date', authenticate, async (req, res) => {
  try {
    const will = await ownWill(req, res);
    if (!will) return;
    let result;
    if (req.body.action === 'date') {
      const m = String(req.body.date || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
      if (!m) return fail(res, 400, 'BAD_DATE', CHANGE_ERRORS.BAD_DATE);
      result = await wr.changeReleaseDate(will.id, { newDate: noonIn(wr.tzOf(will), +m[1], +m[2], +m[3]), by: 'owner', channel: 'web', userId: req.user.id });
    } else {
      result = await wr.changeReleaseDate(will.id, { postponeDays: wr.POSTPONE_DAYS, by: 'owner', channel: 'web', userId: req.user.id });
    }
    if (!result.ok) return fail(res, 400, result.error, CHANGE_ERRORS[result.error] || CHANGE_ERRORS.ERROR);
    res.json({ success: true, data: publicInfo({ ...will, ...result.will }) });
  } catch (err) {
    logger.error(`Will release date change failed: ${err.message}`);
    fail(res, 500, 'ERROR', CHANGE_ERRORS.ERROR);
  }
});

// Body: { name, phone, email } (phone empty = remove the trusted contact)
router.put('/wills/:id/trusted-contact', authenticate, async (req, res) => {
  try {
    const will = await ownWill(req, res);
    if (!will) return;
    if (will.release_flow !== 'auto') return fail(res, 400, 'ADMIN_FLOW', CHANGE_ERRORS.ADMIN_FLOW);
    const phone = String(req.body.phone || '').trim();
    const email = String(req.body.email || '').trim();
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return fail(res, 400, 'BAD_EMAIL', 'Enter a valid email address.');
    if (phone && digits(phone) === digits(will.owner_phone)) return fail(res, 400, 'OWN_PHONE', 'Your trusted contact must be someone else.');
    const result = await wr.setTrustedContact(will.id, { name: req.body.name, phone, email }, req.user.id);
    if (!result.ok) return fail(res, 400, result.error, result.error === 'BAD_PHONE' ? 'Enter a 10-digit US phone number.' : CHANGE_ERRORS.ERROR);
    res.json({ success: true });
  } catch (err) {
    logger.error(`Trusted contact change failed: ${err.message}`);
    fail(res, 500, 'ERROR', CHANGE_ERRORS.ERROR);
  }
});

module.exports = router;
module.exports.noonIn = noonIn;
