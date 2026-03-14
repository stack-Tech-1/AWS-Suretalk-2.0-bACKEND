const axios = require('axios');
const { pool } = require('../config/database');
const logger = require('../utils/logger');

const MAX_ATTEMPTS = 5;
const POLL_INTERVAL_MS = 2 * 60 * 1000; // 2 minutes
const TWILIO_RETRY_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
const TWILIO_MAX_ATTEMPTS = 5;

const processOutbox = async () => {
  // Hold the client only long enough to atomically SELECT the rows.
  // Releasing before HTTP calls avoids tying up a DB connection during I/O.
  let rows;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await client.query(
      `SELECT id, event_type, payload, attempts
       FROM sync_outbox
       WHERE status IN ('pending', 'failed')
         AND attempts < $1
         AND (last_attempt_at IS NULL OR last_attempt_at < NOW() - INTERVAL '2 minutes')
       FOR UPDATE SKIP LOCKED
       LIMIT 20`,
      [MAX_ATTEMPTS]
    );
    rows = result.rows;
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    logger.error('sync_outbox worker error:', err.message);
    return;
  } finally {
    client.release();
  }

  for (const row of rows) {
    try {
      await axios.post(
        `${process.env.IVR_API_URL}/${row.event_type}`,
        row.payload,
        {
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${process.env.IVR_SYNC_TOKEN}`
          },
          timeout: 5000
        }
      );

      await pool.query(
        `UPDATE sync_outbox
         SET status = 'sent', sent_at = NOW()
         WHERE id = $1`,
        [row.id]
      );
      logger.info(`sync_outbox: sent ${row.event_type} (id=${row.id})`);

    } catch (err) {
      const newAttempts = (row.attempts || 0) + 1;
      const newStatus = newAttempts >= MAX_ATTEMPTS ? 'dead' : 'failed';

      await pool.query(
        `UPDATE sync_outbox
         SET status = $1,
             attempts = $2,
             last_attempt_at = NOW(),
             error_message = $3
         WHERE id = $4`,
        [newStatus, newAttempts, err.message, row.id]
      );

      if (newStatus === 'dead') {
        logger.error(`CRITICAL: sync_outbox record ${row.id} (${row.event_type}) dead after ${MAX_ATTEMPTS} attempts. Manual intervention required.`);
      } else {
        logger.warn(`sync_outbox: attempt ${newAttempts}/${MAX_ATTEMPTS} failed for ${row.event_type} (id=${row.id}): ${err.message}`);
      }
    }
  }

  if (rows.length > 0) {
    logger.info(`sync_outbox: processed ${rows.length} record(s)`);
  }
};

const processTwilioSync = async () => {
  // Disabled: app recordings use S3 directly, no Twilio SID needed
  return;
};

const startSyncOutboxWorker = () => {
  logger.info('Sync outbox worker started');
  setInterval(processOutbox, POLL_INTERVAL_MS);
  processOutbox(); // run immediately on startup

  // Twilio SID retry worker — runs every 5 minutes
  setInterval(processTwilioSync, TWILIO_RETRY_INTERVAL_MS);
  processTwilioSync(); // run immediately on startup
  logger.info('Twilio SID sync worker started (5-minute interval)');
};

module.exports = { startSyncOutboxWorker, processOutbox, processTwilioSync };
