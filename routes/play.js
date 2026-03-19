const express = require('express');
const router = express.Router();
const { pool } = require('../config/database');
const { generateDownloadUrl } = require('../utils/s3Storage');

// PUBLIC endpoint — no authentication required
// Token acts as the access credential
router.get('/public/:token', async (req, res) => {
  try {
    const { token } = req.params;

    const tokenResult = await pool.query(
      `SELECT pt.*,
              vn.title, vn.s3_key, vn.s3_bucket, vn.duration_seconds,
              vn.twilio_recording_sid,
              u.full_name as sender_name,
              sm.custom_message,
              sm.recipient_email, sm.recipient_phone
       FROM play_tokens pt
       JOIN voice_notes vn ON pt.voice_note_id = vn.id
       JOIN users u ON pt.user_id = u.id
       JOIN scheduled_messages sm ON pt.scheduled_message_id = sm.id
       WHERE pt.token = $1`,
      [token]
    );

    if (tokenResult.rows.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'This link is invalid or has been removed'
      });
    }

    const data = tokenResult.rows[0];

    if (new Date() > new Date(data.expires_at)) {
      return res.status(410).json({
        success: false,
        error: 'This voice message link has expired',
        expiredAt: data.expires_at
      });
    }

    // Generate fresh 1-hour audio URL
    let audioUrl = null;
    if (data.s3_key && data.s3_bucket &&
        !data.s3_key.startsWith('http') &&
        !data.s3_key.startsWith('RE')) {
      try {
        audioUrl = await generateDownloadUrl(data.s3_key, data.s3_bucket, 3600);
      } catch (err) {
        console.warn('Could not generate audio URL for play token', token, err.message);
      }
    } else if (data.twilio_recording_sid) {
      const EC2_URL = process.env.EC2_STREAM_URL || 'https://test-api.suretalknow.com';
      audioUrl = `${EC2_URL}/api/stream-recording/${data.twilio_recording_sid}`;
    }

    // Track play count (fire-and-forget)
    pool.query(
      `UPDATE play_tokens SET play_count = COALESCE(play_count, 0) + 1, last_played = NOW() WHERE token = $1`,
      [token]
    ).catch(err => console.warn('play_count update failed', err.message));

    res.json({
      success: true,
      data: {
        title: data.title,
        senderName: data.sender_name,
        customMessage: data.custom_message,
        duration: data.duration_seconds,
        audioUrl,
        expiresAt: data.expires_at,
        canPlay: !!audioUrl
      }
    });

  } catch (error) {
    console.error('Play token error:', error);
    res.status(500).json({ success: false, error: 'Failed to load voice message' });
  }
});

module.exports = router;
