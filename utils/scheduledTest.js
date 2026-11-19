// utils/scheduledTest.js — "Send Test" on a scheduled message. The test goes only to the signed-in customer,
// never to the message's recipient, and the scheduled message itself is left exactly as it was.
const Twilio = require('twilio');
const { generateDownloadUrl } = require('./s3Storage');
const { signedEc2RecordingUrl, signedEc2S3Url, TTL } = require('./audioSigning');
const emailService = require('./emailService');

const MAX_TESTS_PER_HOUR = 5;
const HOUR_MS = 60 * 60 * 1000;
const recentTests = new Map();

const streamBase = () => process.env.EC2_STREAM_URL || 'https://test-api.suretalknow.com';

// A phone recording can be saved as a Twilio id, a stream link or a storage link
function linkFromValue(value) {
  const text = String(value || '').trim();
  if (!text) return null;
  const sid = text.match(/(?:^|\/)(RE[0-9a-zA-Z]{32})(?=$|[/?.])/)?.[1];
  if (sid) return signedEc2RecordingUrl(streamBase(), sid, TTL.call);
  const key = text.match(/\/api\/stream-s3-recording\/([^?]+)/)?.[1] || text.match(/amazonaws\.com\/([^?]+)/)?.[1];
  return key ? signedEc2S3Url(streamBase(), decodeURIComponent(key), TTL.call) : null;
}

// A listening link valid for 1 hour, or null when the message has no recording
async function listenLink(message) {
  if (message.twilio_recording_sid) return linkFromValue(message.twilio_recording_sid);
  if (message.s3_key) {
    const saved = linkFromValue(message.s3_key);
    if (saved) return saved;
    if (message.s3_bucket) return generateDownloadUrl(message.s3_key, message.s3_bucket, 3600);
    return signedEc2S3Url(streamBase(), message.s3_key, TTL.call);
  }
  return linkFromValue(message.metadata?.recordingSid);
}

const phoneForSms = (phone) => {
  const digits = String(phone || '').replace(/\D/g, '');
  if (digits.length < 10) return null;
  return digits.length === 10 ? `+1${digits}` : `+${digits}`;
};

function underHourlyLimit(userId) {
  const now = Date.now();
  const recent = (recentTests.get(userId) || []).filter(at => now - at < HOUR_MS);
  if (recent.length >= MAX_TESTS_PER_HOUR) {
    recentTests.set(userId, recent);
    return false;
  }
  recent.push(now);
  recentTests.set(userId, recent);
  return true;
}

async function textTest(to, title, url) {
  const client = new Twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
  await client.messages.create({
    from: process.env.TWILIO_PHONE_NUMBER,
    to,
    body: `SureTalk test of your scheduled message "${title}". Only you received this. Listen: ${url}\nThis link expires in 1 hour.`,
  });
}

/** Sends the test and returns the HTTP status and answer for the customer's browser. */
async function sendTestToSelf(message, user) {
  const refuse = (status, code, error) => ({ status, body: { success: false, code, error } });

  const phone = phoneForSms(user.phone);
  const email = user.email || null;
  if (!phone && !email) {
    return refuse(400, 'NO_TEST_DESTINATION', 'Add a phone number or email to your account to receive a test.');
  }

  const url = await listenLink(message);
  if (!url) return refuse(422, 'NO_RECORDING', 'This message has no recording to test.');

  if (!underHourlyLimit(user.id)) {
    return refuse(429, 'TOO_MANY_TESTS', 'You have sent several tests recently. Try again in an hour.');
  }

  const title = message.voice_note_title || 'Voice message';
  const sentTo = [];
  const failed = [];

  if (phone) {
    try {
      await textTest(phone, title, url);
      sentTo.push('phone');
    } catch (err) {
      console.error('Scheduled test text failed:', err.message);
      failed.push('phone');
    }
  }
  if (email) {
    try {
      await emailService.sendVoiceMessageEmail(email, {
        subject: `Test: ${title}`,
        title,
        message: 'This is a test of your scheduled message. Only you received it.',
        listenUrl: url,
        senderName: user.full_name || 'SureTalk',
        expiresText: 'This test link expires in 1 hour.',
      });
      sentTo.push('email');
    } catch (err) {
      console.error('Scheduled test email failed:', err.message);
      failed.push('email');
    }
  }

  if (sentTo.length === 0) return refuse(502, 'TEST_NOT_SENT', 'The test could not be sent. Try again in a moment.');
  return { status: 200, body: { success: true, message: 'Test sent', data: { sentTo, failed } } };
}

module.exports = { sendTestToSelf };
