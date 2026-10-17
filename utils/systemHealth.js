// Live health checks for the admin dashboard — each check calls the real service and times it.
// Results are cached for a minute so dashboard refreshes don't hammer Twilio/Stripe/S3.
const https = require('https');
const http = require('http');
const AWS = require('aws-sdk');
const { pool } = require('../config/database');

const CACHE_MS = 60 * 1000;
const MIN_FORCED_REFRESH_MS = 10 * 1000;
const TIMEOUT_MS = 5000;
const SLOW_MS = 1500;

let cached = null;
let inFlight = null;

const s3 = new AWS.S3({
  region: process.env.AWS_REGION || 'eu-central-1',
  accessKeyId: process.env.AWS_ACCESS_KEY_ID,
  secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY
});

const withTimeout = (promise) => Promise.race([
  promise,
  new Promise((_, reject) => setTimeout(() => reject(new Error('Timed out after 5s')), TIMEOUT_MS))
]);

// Any HTTP answer below 500 means the server is up (the root path normally returns 404)
const pingUrl = (url) => new Promise((resolve, reject) => {
  const lib = url.startsWith('https') ? https : http;
  const req = lib.get(url, (res) => {
    res.resume();
    if (res.statusCode < 500) resolve();
    else reject(new Error(`HTTP ${res.statusCode}`));
  });
  req.on('error', reject);
  req.setTimeout(TIMEOUT_MS, () => req.destroy(new Error('Timed out after 5s')));
});

const CHECKS = [
  {
    service: 'Database',
    run: () => pool.query('SELECT 1')
  },
  {
    service: 'File storage (S3)',
    run: () => s3.headBucket({ Bucket: process.env.AWS_S3_BUCKET_VOICE_NOTES || 'suertalk-voice-notes' }).promise()
  },
  {
    service: 'Audio streaming (EC2)',
    run: () => pingUrl(process.env.EC2_STREAM_URL || 'https://test-api.suretalknow.com')
  },
  {
    service: 'Calls & SMS (Twilio)',
    configured: () => !!(process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN),
    run: async () => {
      const twilio = require('twilio')(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
      const account = await twilio.api.v2010.accounts(process.env.TWILIO_ACCOUNT_SID).fetch();
      if (account.status !== 'active') throw new Error(`Account ${account.status}`);
    }
  },
  {
    service: 'Payments (Stripe)',
    configured: () => !!process.env.STRIPE_SECRET_KEY,
    run: async () => {
      const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
      await stripe.balance.retrieve();
    }
  }
];

async function runChecks() {
  const results = await Promise.all(CHECKS.map(async (check) => {
    if (check.configured && !check.configured()) {
      return { service: check.service, status: 'down', latency_ms: null, error: 'Not configured' };
    }
    const started = Date.now();
    try {
      await withTimeout(check.run());
      const latency = Date.now() - started;
      return { service: check.service, status: latency > SLOW_MS ? 'slow' : 'ok', latency_ms: latency, error: null };
    } catch (error) {
      return { service: check.service, status: 'down', latency_ms: Date.now() - started, error: error.message || 'Check failed' };
    }
  }));

  const overall = results.some(r => r.status === 'down')
    ? 'issues'
    : results.some(r => r.status === 'slow') ? 'degraded' : 'operational';

  return { services: results, overall, checkedAt: new Date().toISOString() };
}

// force = the admin pressed "Run system check" (still limited to once per 10s)
async function getSystemHealth({ force = false } = {}) {
  const age = cached ? Date.now() - new Date(cached.checkedAt).getTime() : Infinity;
  if (cached && (age < (force ? MIN_FORCED_REFRESH_MS : CACHE_MS))) return cached;
  if (!inFlight) {
    inFlight = runChecks()
      .then(result => { cached = result; return result; })
      .finally(() => { inFlight = null; });
  }
  return inFlight;
}

module.exports = { getSystemHealth };
