const express = require('express');
const twilio = require('twilio');
const router = express.Router();
const { pool } = require('../config/database');

const urlencodedParser = express.urlencoded({ extended: false });

// Rejects requests that were not signed by Twilio (X-Twilio-Signature), so nobody can fake
// delivery statuses. Twilio signs the exact URL it called, so the configured callback URL is used
// when set; otherwise the URL is rebuilt from the request.
const verifyTwilioSignature = (configuredUrlEnv) => (req, res, next) => {
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  if (!authToken) {
    console.warn('TWILIO_AUTH_TOKEN not set — Twilio webhook signature NOT verified');
    return next();
  }
  const url = process.env[configuredUrlEnv] || `https://${req.get('host')}${req.originalUrl}`;
  const signature = req.get('X-Twilio-Signature') || '';
  if (!twilio.validateRequest(authToken, signature, url, req.body || {})) {
    console.warn(`Rejected Twilio webhook with invalid signature: ${req.originalUrl} ip=${req.ip}`);
    return res.status(403).send('Forbidden');
  }
  next();
};

// Twilio call status webhook — fires when a call completes, fails, goes to no-answer, or busy
// Twilio CallStatus values: queued, ringing, in-progress, completed, busy, failed, no-answer, canceled
router.post('/call-status', urlencodedParser, verifyTwilioSignature('TWILIO_STATUS_CALLBACK_URL'), async (req, res) => {
  const { CallSid, CallStatus, CallDuration } = req.body;
  if (!CallSid || !CallStatus) return res.status(200).send('<Response/>');
  try {
    await pool.query(
      `UPDATE scheduled_messages
          SET call_status   = $1,
              call_duration = $2,
              updated_at    = NOW()
        WHERE twilio_call_sid = $3`,
      [CallStatus, parseInt(CallDuration) || null, CallSid]
    );
  } catch (err) {
    console.error('Twilio call webhook DB error:', err.message);
  }
  res.status(200).send('<Response/>');
});

// Twilio SMS status webhook — fires when a message is sent, delivered, undelivered, or failed
// Twilio MessageStatus values: queued, sending, sent, delivered, undelivered, failed
router.post('/sms-status', urlencodedParser, verifyTwilioSignature('TWILIO_SMS_STATUS_CALLBACK_URL'), async (req, res) => {
  const { MessageSid, MessageStatus } = req.body;
  if (!MessageSid || !MessageStatus) return res.status(200).send('');
  try {
    await pool.query(
      `UPDATE scheduled_messages
          SET sms_status = $1,
              updated_at = NOW()
        WHERE twilio_message_sid = $2`,
      [MessageStatus, MessageSid]
    );
  } catch (err) {
    console.error('Twilio SMS webhook DB error:', err.message);
  }
  res.status(200).send('');
});

module.exports = router;
