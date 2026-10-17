const express = require('express');
const router = express.Router();
const { pool } = require('../config/database');
const { generateDownloadUrl } = require('../utils/s3Storage');
const { signedEc2RecordingUrl, TTL: AUDIO_TTL } = require('../utils/audioSigning');

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
      // Signed link, regenerated on every visit to the play page
      audioUrl = signedEc2RecordingUrl(EC2_URL, data.twilio_recording_sid, AUDIO_TTL.app);
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

// PUBLIC — a released voice will, opened from the private link an admin's release sent to a beneficiary.
// The token is the credential; each opening is counted.
router.get('/will/:token', async (req, res) => {
  try {
    const { token } = req.params;
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(token)) {
      return res.status(404).json({ success: false, error: 'This link is invalid' });
    }

    const result = await pool.query(
      `SELECT l.id AS link_id, l.recipient_name, l.expires_at, l.revoked_at,
              vw.*, u.full_name AS owner_name
       FROM will_release_links l
       JOIN voice_wills vw ON vw.id = l.will_id
       JOIN users u ON u.id = vw.user_id
       WHERE l.token = $1`,
      [token]
    );
    const row = result.rows[0];
    if (!row || row.revoked_at || row.deleted_at || row.admin_removed_at || !row.is_released) {
      return res.status(404).json({ success: false, error: 'This link is no longer available' });
    }
    if (new Date() > new Date(row.expires_at)) {
      return res.status(410).json({ success: false, error: 'This link has expired', expiredAt: row.expires_at });
    }

    const { willAudioUrl } = require('./adminWills');
    let audioUrl = null;
    try {
      audioUrl = await willAudioUrl(row);
    } catch (err) {
      console.warn('Could not resolve will audio for link', row.link_id, err.message);
    }

    pool.query(
      `UPDATE will_release_links SET play_count = play_count + 1,
              first_played_at = COALESCE(first_played_at, NOW()), last_played_at = NOW()
       WHERE id = $1`,
      [row.link_id]
    ).catch(err => console.warn('Will link count failed:', err.message));

    res.set('Cache-Control', 'no-store');
    res.json({
      success: true,
      data: {
        ownerName: row.owner_name || 'Someone',
        recipientName: row.recipient_name || null,
        title: row.title || null,
        releasedAt: row.released_at,
        expiresAt: row.expires_at,
        audioUrl,
        canPlay: !!audioUrl
      }
    });
  } catch (error) {
    console.error('Will link error:', error);
    res.status(500).json({ success: false, error: 'Failed to load this voice will' });
  }
});

module.exports = router;
