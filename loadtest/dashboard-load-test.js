// SureTalk load test (k6 — https://k6.io). Simulates signed-in users using the dashboard.
//
// RUN AGAINST A STAGING COPY, NOT PRODUCTION. Give the staging backend high limits so you measure
// capacity rather than the rate limiter:
//   GENERAL_RATE_LIMIT=1000000   PER_USER_RATE_LIMIT=1000000
//
// Usage (PowerShell):
//   $env:BASE_URL="https://staging-api.example.com/api"
//   $env:ACCOUNTS="test1@example.com:Password1,test2@example.com:Password2"   # verified test accounts
//   $env:PROFILE="100"            # smoke | 100 | 500 | 1000  (peak simultaneous users)
//   k6 run loadtest/dashboard-load-test.js
//
// Reading the result: watch `http_req_failed` (should stay under 1%) and
// `http_req_duration p(95)` (95% of requests faster than 1.5 s). The run is marked failed if either
// threshold is broken. The profile where that first happens is roughly your current limit.
import http from 'k6/http';
import { check, group, sleep } from 'k6';

const BASE_URL = __ENV.BASE_URL;
const ACCOUNTS = (__ENV.ACCOUNTS || '').split(',').filter(Boolean).map((pair) => {
  const i = pair.indexOf(':');
  return { email: pair.slice(0, i), password: pair.slice(i + 1) };
});

// Peak simultaneous users per profile. ~1,000 registered users usually means ~50–100 online at once.
const PROFILES = {
  smoke: [{ duration: '1m', target: 5 }],
  100: [{ duration: '2m', target: 100 }, { duration: '5m', target: 100 }, { duration: '1m', target: 0 }],
  500: [{ duration: '3m', target: 500 }, { duration: '5m', target: 500 }, { duration: '2m', target: 0 }],
  1000: [{ duration: '5m', target: 1000 }, { duration: '5m', target: 1000 }, { duration: '2m', target: 0 }],
};

export const options = {
  stages: PROFILES[__ENV.PROFILE || 'smoke'],
  thresholds: {
    http_req_failed: ['rate<0.01'],
    http_req_duration: ['p(95)<1500'],
  },
};

// Log in once per test account before the test starts (avoids tripping the login lockout)
export function setup() {
  if (!BASE_URL || ACCOUNTS.length === 0) {
    throw new Error('Set BASE_URL and ACCOUNTS (see the top of this file).');
  }
  const tokens = ACCOUNTS.map(({ email, password }) => {
    const res = http.post(`${BASE_URL}/auth/login`, JSON.stringify({ email, password }), {
      headers: { 'Content-Type': 'application/json' },
    });
    const token = res.json('data.token');
    if (!token) throw new Error(`Login failed for ${email} (status ${res.status}). Use verified accounts without 2FA.`);
    return token;
  });
  return { tokens };
}

const ok = (res) => check(res, { 'status is 2xx': (r) => r.status >= 200 && r.status < 300 });

export default function (data) {
  const token = data.tokens[(__VU - 1) % data.tokens.length];
  const params = { headers: { Authorization: `Bearer ${token}` } };

  // Same requests the dashboard home page makes on load
  group('dashboard', () => {
    const responses = http.batch([
      ['GET', `${BASE_URL}/users/stats`, null, params],
      ['GET', `${BASE_URL}/users/activity?period=week&timezone=UTC`, null, params],
      ['GET', `${BASE_URL}/voice-notes?page=1&limit=4`, null, params],
      ['GET', `${BASE_URL}/billing/subscription`, null, params],
      ['GET', `${BASE_URL}/notifications?limit=10`, null, params],
    ]);
    responses.forEach(ok);
  });
  sleep(3 + Math.random() * 5); // reading the dashboard

  group('browse', () => {
    ok(http.get(`${BASE_URL}/voice-notes?page=1&limit=12`, params));
    sleep(2 + Math.random() * 4);
    ok(http.get(`${BASE_URL}/contacts?page=1&limit=9`, params));
    sleep(2 + Math.random() * 4);
    ok(http.get(`${BASE_URL}/scheduled?page=1&limit=20`, params));
  });
  sleep(5 + Math.random() * 10); // idle before the next visit
}
