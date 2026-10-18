// C:\Users\SMC\Documents\GitHub\AWS-Suretalk-2.0-bACKEND\utils\syncIvr.js
const axios = require('axios');
const { pool } = require('../config/database');
const logger = require('./logger');

/**
 * Durably sync an event to the IVR backend.
 * 1. Inserts a record into sync_outbox (durable).
 * 2. Immediately attempts the HTTP call to the IVR API.
 * 3. On success: marks the record sent.
 * 4. On failure: leaves it pending for the outbox worker to retry.
 * Never throws — always safe to call fire-and-forget.
 *
 * @param {Object} payload      - Data to send to IVR
 * @param {string} endpointPath - IVR endpoint path (e.g. 'sync-user')
 * @param {Object} [client]     - Optional pg client (pass when inside a transaction)
 */
const SYNC_ENABLED = process.env.IVR_SYNC_ENABLED !== 'false';

const syncToIvr = async (payload, endpointPath, client) => {
  if (!SYNC_ENABLED) {
    logger.info('IVR sync disabled via IVR_SYNC_ENABLED=false');
    return;
  }
  const db = client || pool;
  let outboxId;

  try {
    const result = await db.query(
      `INSERT INTO sync_outbox (event_type, payload, status)
       VALUES ($1, $2, 'pending')
       RETURNING id`,
      [endpointPath, JSON.stringify(payload)]
    );
    outboxId = result.rows[0].id;
  } catch (insertErr) {
    logger.error(`sync_outbox INSERT failed (sync lost): ${insertErr.message}`);
    return; // Nothing more we can do
  }

  try {
    await axios.post(
      `${process.env.IVR_API_URL}/${endpointPath}`,
      payload,
      {
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${process.env.IVR_SYNC_TOKEN}`
        },
        timeout: 3000
      }
    );

    // Mark sent — use pool directly (not client) to avoid coupling to caller's transaction
    await pool.query(
      `UPDATE sync_outbox SET status = 'sent', sent_at = NOW() WHERE id = $1`,
      [outboxId]
    );
    logger.info(`Synced to IVR: ${endpointPath} (outbox id=${outboxId})`);
  } catch (err) {
    if (isNothingToUpdate(err)) {
      await markSkipped(outboxId, err);
      return;
    }
    // Leave as 'pending' — outbox worker will retry
    logger.warn(`Sync to IVR failed (will retry via outbox): ${err.message}`);
  }
};

/**
 * The phone line answered 404 "User not found" / "Slot not found": there is nothing there to update
 * (e.g. a website-only customer who has no phone-line account). Retrying can't help, so the item is
 * marked 'skipped' instead of failing 5 times and raising an alert.
 */
const isNothingToUpdate = (err) =>
  err?.response?.status === 404 && /not found/i.test(String(err.response?.data?.error || err.response?.data || ''));

const markSkipped = async (outboxId, err) => {
  const reason = String(err?.response?.data?.error || 'Not found on the phone line');
  await pool.query(
    `UPDATE sync_outbox SET status = 'skipped', error_message = $2, last_attempt_at = NOW() WHERE id = $1`,
    [outboxId, `${reason} (nothing to update on the phone line)`]
  ).catch(e => logger.error(`sync_outbox skip update failed: ${e.message}`));
  logger.info(`Sync skipped (${reason}), outbox id=${outboxId}`);
};

/**
 * Account changes for the phone line's sync-user function. It finds the account by PHONE NUMBER
 * (never the app's user id) and only reads: subscription_tier ('LITE' | 'ESSENTIAL' | 'PREMIUM' —
 * use ivrTierName), verified (false = phone sign-in off), and action 'delete' or
 * 'change_phone' (+ newUserId). Users without a phone number have no phone-line account.
 */
const syncAccountToIvr = (phone, fields) => {
  if (!phone) return;
  return syncToIvr({ userId: phone, source: 'app', ...fields }, 'sync-user');
};

module.exports = { syncToIvr, syncAccountToIvr, isNothingToUpdate, markSkipped };
