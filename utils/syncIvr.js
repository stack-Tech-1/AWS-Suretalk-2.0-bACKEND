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
const syncToIvr = async (payload, endpointPath, client) => {
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
    // Leave as 'pending' — outbox worker will retry
    logger.warn(`Sync to IVR failed (will retry via outbox): ${err.message}`);
  }
};

module.exports = { syncToIvr };
