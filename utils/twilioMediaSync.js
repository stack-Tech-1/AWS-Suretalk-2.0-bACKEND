const Twilio = require('twilio');
const { pool } = require('../config/database');
const logger = require('./logger');

const twilioClient = process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN
  ? new Twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN)
  : null;

/**
 * Register an S3 URL with Twilio to obtain a recording SID.
 * Updates the DB row on success.
 * On failure: increments twilio_sync_attempts, sets status='failed', returns { success: false }.
 * Never throws — safe for fire-and-forget callers.
 *
 * @param {string} recordId   - UUID of the DB row
 * @param {string} s3Url      - Full S3 HTTPS URL of the audio file
 * @param {string|null} userPhone - User's phone number (passed to Twilio for routing context)
 * @param {string} tableName  - DB table to update ('voice_notes' or 'voice_wills')
 */
async function syncRecordingToTwilio(recordId, s3Url, userPhone, tableName = 'voice_notes') {
  if (!twilioClient) {
    logger.warn('twilioMediaSync: Twilio not configured, marking as skipped');
    try {
      await pool.query(
        `UPDATE ${tableName} SET twilio_sync_status = 'skipped' WHERE id = $1`,
        [recordId]
      );
    } catch (dbErr) {
      logger.error(`twilioMediaSync: failed to mark skipped for ${recordId}: ${dbErr.message}`);
    }
    return { success: false, reason: 'twilio_not_configured' };
  }

  try {
    // Register external recording with Twilio to obtain a recording SID
    const recording = await twilioClient.recordings.create({
      recordingUrl: s3Url
    });

    await pool.query(
      `UPDATE ${tableName}
       SET twilio_recording_sid = $1,
           twilio_sync_status   = 'synced',
           twilio_synced_at     = NOW()
       WHERE id = $2`,
      [recording.sid, recordId]
    );

    logger.info(`twilioMediaSync: SID ${recording.sid} stored for ${tableName} ${recordId}`);
    return { success: true, sid: recording.sid };

  } catch (err) {
    logger.error(`twilioMediaSync: failed for ${tableName} ${recordId}: ${err.message}`);

    try {
      await pool.query(
        `UPDATE ${tableName}
         SET twilio_sync_attempts = twilio_sync_attempts + 1,
             twilio_sync_status   = 'failed'
         WHERE id = $1`,
        [recordId]
      );
    } catch (dbErr) {
      logger.error(`twilioMediaSync: failed to update attempt count for ${recordId}: ${dbErr.message}`);
    }

    return { success: false, error: err.message };
  }
}

/**
 * Build the Twilio recording MP3 URL from a SID.
 * Format used by IVR Lambda schedulers.
 *
 * @param {string} recordingSid - Twilio recording SID (e.g. 'RExxxxxx')
 * @returns {string} Full Twilio MP3 URL
 */
function getTwilioRecordingUrl(recordingSid) {
  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  return `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Recordings/${recordingSid}.mp3`;
}

module.exports = { syncRecordingToTwilio, getTwilioRecordingUrl };
