// utils/phoneCodes.js
// One-time codes sent by text message (table phone_otps). Codes are stored hashed, expire after
// 10 minutes, at most 3 can be sent to a number per 10 minutes, and a code is thrown away after
// 5 wrong guesses. `purpose` keeps a code for one flow from being used in another.
// Works before migration 017 too (no attempts/purpose columns): then guesses aren't counted.
const crypto = require('crypto');
const bcrypt = require('bcrypt');
const { pool } = require('../config/database');

const MAX_GUESSES = 5;
const MAX_SENDS_PER_10_MIN = 3;
let extraColumns = true; // phone_otps.attempts + purpose (migration 017)

const missingColumn = (err) => err && err.code === '42703';

async function issueCode(phone, purpose) {
  const recent = await pool.query(
    `SELECT COUNT(*)::int AS n FROM phone_otps WHERE phone = $1 AND created_at > NOW() - INTERVAL '10 minutes'`,
    [phone]
  );
  if (recent.rows[0].n >= MAX_SENDS_PER_10_MIN) return { ok: false, reason: 'TOO_MANY_CODES' };

  const code = String(crypto.randomInt(100000, 1000000));
  const hash = await bcrypt.hash(code, 10);
  if (extraColumns) {
    try {
      await pool.query(
        `INSERT INTO phone_otps (phone, otp_hash, expires_at, purpose) VALUES ($1, $2, NOW() + INTERVAL '10 minutes', $3)`,
        [phone, hash, purpose]
      );
      return { ok: true, code };
    } catch (err) {
      if (!missingColumn(err)) throw err;
      extraColumns = false;
    }
  }
  await pool.query(`INSERT INTO phone_otps (phone, otp_hash, expires_at) VALUES ($1, $2, NOW() + INTERVAL '10 minutes')`, [phone, hash]);
  return { ok: true, code };
}

// → { ok: true, id } | { ok: false, reason: 'NO_CODE' | 'TOO_MANY_GUESSES' | 'WRONG_CODE' }
async function checkCode(phone, purpose, code) {
  let row;
  if (extraColumns) {
    try {
      row = (await pool.query(
        `SELECT id, otp_hash, COALESCE(attempts, 0) AS attempts FROM phone_otps
         WHERE phone = $1 AND COALESCE(purpose, 'claim_account') = $2 AND expires_at > NOW() AND used_at IS NULL
         ORDER BY created_at DESC LIMIT 1`,
        [phone, purpose]
      )).rows[0];
    } catch (err) {
      if (!missingColumn(err)) throw err;
      extraColumns = false;
    }
  }
  if (!extraColumns) {
    row = (await pool.query(
      `SELECT id, otp_hash, 0 AS attempts FROM phone_otps
       WHERE phone = $1 AND expires_at > NOW() AND used_at IS NULL ORDER BY created_at DESC LIMIT 1`,
      [phone]
    )).rows[0];
  }
  if (!row) return { ok: false, reason: 'NO_CODE' };
  if (row.attempts >= MAX_GUESSES) return { ok: false, reason: 'TOO_MANY_GUESSES' };

  const valid = /^\d{6}$/.test(String(code || '')) && await bcrypt.compare(String(code), row.otp_hash);
  if (valid) return { ok: true, id: row.id };

  if (extraColumns) {
    const n = row.attempts + 1;
    await pool.query(
      `UPDATE phone_otps SET attempts = $2::int, used_at = CASE WHEN $2::int >= $3::int THEN NOW() ELSE used_at END WHERE id = $1`,
      [row.id, n, MAX_GUESSES]
    );
    if (n >= MAX_GUESSES) return { ok: false, reason: 'TOO_MANY_GUESSES' };
  }
  return { ok: false, reason: 'WRONG_CODE' };
}

const markCodeUsed = (id) => pool.query('UPDATE phone_otps SET used_at = NOW() WHERE id = $1', [id]);

module.exports = { issueCode, checkCode, markCodeUsed, MAX_GUESSES };
