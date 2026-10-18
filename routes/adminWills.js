// Admin voice wills — list, stats, details, release (delivers private links to beneficiaries),
// listen (released wills only), remove from service (recording kept) and restore.
// Needs migration 012_will_release.sql. Mounted at /api/admin before routes/admin.js.
const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const axios = require('axios');
const AWS = require('aws-sdk');
const { body, validationResult } = require('express-validator');
const { authenticateAdmin } = require('../middleware/auth');
const { pool } = require('../config/database');
const { syncToIvr } = require('../utils/syncIvr');
const { generateDownloadUrl, BUCKETS } = require('../utils/s3Storage');
const { resolveAudioUrl, resolveIvrPlaybackUrl } = require('../utils/resolveAudioUrl');
const emailService = require('../utils/emailService');

const twilioClient = process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN
  ? require('twilio')(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN)
  : null;
const s3 = new AWS.S3({
  region: process.env.AWS_REGION || 'eu-central-1',
  signatureVersion: 'v4',
  accessKeyId: process.env.AWS_ACCESS_KEY_ID,
  secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY
});

const LINK_DAYS = 30;
const isUuid = (v) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(v));
const DUE_SQL = `(vw.release_condition = 'date' AND vw.release_date IS NOT NULL AND vw.release_date <= NOW() AND COALESCE(vw.is_released, false) = false)`;

async function logAdminAudit({ userId, action, targetId = null, oldValue = null, newValue = null, ipAddress = null }) {
  try {
    await pool.query(
      `INSERT INTO admin_audit_log (admin_user_id, action, target_id, old_value, new_value, ip_address)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [userId, action, targetId, oldValue ? JSON.stringify(oldValue) : null, newValue ? JSON.stringify(newValue) : null, ipAddress]
    );
  } catch (err) {
    console.warn('Admin audit log failed (non-fatal):', err.message);
  }
}

const logSystem = (adminId, level, message, metadata) => pool.query(
  `INSERT INTO system_logs (user_id, level, service, message, metadata) VALUES ($1, $2, 'wills', $3, $4)`,
  [adminId, level, message, JSON.stringify(metadata)]
).catch(err => console.error('system_log write failed:', err.message));

const twilioSidOf = (w) => w.twilio_recording_sid ||
  (w.s3_key?.startsWith('RE') && w.s3_key.length > 30 && !w.s3_key.includes('/') ? w.s3_key : null);

// Fresh, short-lived audio URL for a will — app recordings from S3, phone recordings via the EC2 proxy
async function willAudioUrl(will) {
  // A backup copy (made when an admin removed the will) is the one copy guaranteed to still exist
  const backupKey = will.metadata?.backup_s3_key;
  if (backupKey) return generateDownloadUrl(backupKey, BUCKETS.WILLS, 3600);
  if (will.source === 'ivr') {
    const viaIvr = resolveAudioUrl(will);
    if (viaIvr) return viaIvr;
  }
  if (will.s3_key?.startsWith('http')) return will.s3_key;
  if (will.s3_key && will.s3_bucket) return generateDownloadUrl(will.s3_key, will.s3_bucket, 3600);
  if (backupKey) return generateDownloadUrl(backupKey, BUCKETS.WILLS, 3600);
  return null;
}

async function loadWill(id) {
  if (!isUuid(id)) return null;
  const result = await pool.query(
    `SELECT vw.*, u.full_name AS owner_name, u.email AS owner_email, u.phone AS owner_phone, u.deleted_at AS owner_deleted_at
     FROM voice_wills vw JOIN users u ON u.id = vw.user_id
     WHERE vw.id = $1 AND vw.deleted_at IS NULL`,
    [id]
  );
  return result.rows[0] || null;
}

// Who gets the will on release: named beneficiaries (owner's contacts) plus, for wills recorded by
// phone, the recipient number chosen on the call. De-duplicated by phone/email.
async function buildRecipients(will) {
  const recipients = [];
  const seen = new Set();
  const norm = (p) => String(p || '').replace(/[^\d+]/g, '');
  const add = (r) => {
    const keys = [r.phone && `p:${norm(r.phone)}`, r.email && `e:${r.email.toLowerCase()}`].filter(Boolean);
    if (keys.some(k => seen.has(k))) return;
    keys.forEach(k => seen.add(k));
    recipients.push(r);
  };

  if (Array.isArray(will.beneficiaries) && will.beneficiaries.length) {
    const contacts = await pool.query(
      'SELECT id, name, phone, email, relationship FROM contacts WHERE id = ANY($1::uuid[]) AND user_id = $2',
      [will.beneficiaries, will.user_id]
    );
    contacts.rows.forEach(c => add({ contactId: c.id, name: c.name, phone: c.phone || null, email: c.email || null, relationship: c.relationship || null }));
  }
  // Phone wills: the number chosen on the call (may be saved with spaces/dashes)
  if (will.contact_phone && norm(will.contact_phone).replace(/\D/g, '').length >= 7) {
    const match = await pool.query(
      `SELECT id, name, email, relationship FROM contacts
       WHERE user_id = $1 AND regexp_replace(phone, '[^0-9+]', '', 'g') = $2 LIMIT 1`,
      [will.user_id, norm(will.contact_phone)]
    );
    const c = match.rows[0];
    add({ contactId: c?.id || null, name: c?.name || 'Recipient chosen on the call', phone: will.contact_phone, email: c?.email || null, relationship: c?.relationship || null });
  }
  return recipients.map(r => ({ ...r, reachable: !!(r.phone || r.email) }));
}

const willTitle = (w) => w.title || (w.source === 'ivr' ? `Phone voice will${w.will_slot_number ? ` (slot ${w.will_slot_number})` : ''}` : 'Untitled will');

// ── Stats ────────────────────────────────────────────────────────────────────
router.get('/wills/stats', authenticateAdmin, async (req, res) => {
  try {
    const r = await pool.query(`
      SELECT
        COUNT(*) FILTER (WHERE vw.admin_removed_at IS NULL)::int AS total,
        COUNT(*) FILTER (WHERE vw.admin_removed_at IS NULL AND ${DUE_SQL})::int AS due,
        COUNT(*) FILTER (WHERE vw.admin_removed_at IS NULL AND COALESCE(vw.is_released, false) = false AND NOT ${DUE_SQL})::int AS awaiting,
        COUNT(*) FILTER (WHERE vw.admin_removed_at IS NULL AND vw.is_released = true)::int AS released,
        COUNT(*) FILTER (WHERE vw.admin_removed_at IS NOT NULL)::int AS removed
      FROM voice_wills vw
      WHERE vw.deleted_at IS NULL`);
    res.json({ success: true, data: r.rows[0] });
  } catch (error) {
    console.error('Will stats error:', error);
    res.status(500).json({ success: false, error: 'Failed to load will stats' });
  }
});

// ── List ─────────────────────────────────────────────────────────────────────
router.get('/wills', authenticateAdmin, async (req, res) => {
  try {
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 12, 1), 100);
    const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
    const where = ['vw.deleted_at IS NULL'];
    const params = [];
    const status = req.query.status || 'all';
    if (status === 'removed') where.push('vw.admin_removed_at IS NOT NULL');
    else where.push('vw.admin_removed_at IS NULL');
    if (status === 'due') where.push(DUE_SQL);
    if (status === 'pending') where.push('COALESCE(vw.is_released, false) = false');
    if (status === 'released') where.push('vw.is_released = true');
    if (req.query.search && String(req.query.search).trim()) {
      params.push(`%${String(req.query.search).trim()}%`);
      where.push(`(u.email ILIKE $1 OR u.full_name ILIKE $1 OR vw.title ILIKE $1 OR vw.contact_phone ILIKE $1)`);
    }

    const result = await pool.query(
      `SELECT vw.id, vw.title, vw.source, vw.will_slot_number, vw.release_condition, vw.release_date,
              vw.is_released, vw.released_at, vw.created_at, vw.contact_phone, vw.admin_removed_at,
              ${DUE_SQL} AS is_due,
              u.full_name AS owner_name, u.email AS owner_email,
              COALESCE(array_length(vw.beneficiaries, 1), 0) AS beneficiary_count,
              (SELECT COALESCE(array_agg(c.name ORDER BY c.name), '{}') FROM contacts c
                 WHERE c.id = ANY(vw.beneficiaries) AND c.user_id = vw.user_id) AS beneficiary_names,
              (SELECT COUNT(*)::int FROM will_release_links l WHERE l.will_id = vw.id) AS link_count,
              (SELECT COUNT(*)::int FROM will_release_links l WHERE l.will_id = vw.id AND l.play_count > 0) AS opened_count,
              COUNT(*) OVER()::int AS total_count
       FROM voice_wills vw
       JOIN users u ON u.id = vw.user_id
       WHERE ${where.join(' AND ')}
       ORDER BY ${DUE_SQL} DESC, vw.created_at DESC
       LIMIT ${limit} OFFSET ${(page - 1) * limit}`,
      params
    );

    let total = result.rows[0]?.total_count;
    if (total === undefined) {
      total = (await pool.query(
        `SELECT COUNT(*)::int AS count FROM voice_wills vw JOIN users u ON u.id = vw.user_id WHERE ${where.join(' AND ')}`, params
      )).rows[0].count;
    }

    res.json({
      success: true,
      data: {
        wills: result.rows.map(({ total_count, ...w }) => ({ ...w, title: willTitle(w) })),
        pagination: { page, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)) }
      }
    });
  } catch (error) {
    console.error('Get admin wills error:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch voice wills' });
  }
});

// ── Details ──────────────────────────────────────────────────────────────────
router.get('/wills/:id', authenticateAdmin, async (req, res) => {
  try {
    const will = await loadWill(req.params.id);
    if (!will) return res.status(404).json({ success: false, error: 'Voice will not found' });

    const [recipients, links, people] = await Promise.all([
      buildRecipients(will),
      pool.query(
        `SELECT id, recipient_name, recipient_phone, recipient_email, sms_status, email_status,
                expires_at, play_count, first_played_at, last_played_at, revoked_at, created_at
         FROM will_release_links WHERE will_id = $1 ORDER BY created_at`, [will.id]),
      pool.query(
        `SELECT id, full_name, email FROM users WHERE id = ANY($1::uuid[])`,
        [[will.released_by, will.admin_removed_by].filter(Boolean)]
      ),
    ]);
    const person = (pid) => { const p = people.rows.find(x => x.id === pid); return p ? (p.full_name || p.email) : null; };

    res.json({
      success: true,
      data: {
        will: {
          id: will.id,
          title: willTitle(will),
          description: will.description || null,
          source: will.source || 'app',
          will_slot_number: will.will_slot_number || null,
          release_condition: will.release_condition,
          release_date: will.release_date,
          is_due: will.release_condition === 'date' && will.release_date && new Date(will.release_date) <= new Date() && !will.is_released,
          is_released: !!will.is_released,
          released_at: will.released_at,
          released_by_name: person(will.released_by),
          release_notes: will.release_notes,
          admin_removed_at: will.admin_removed_at,
          admin_removed_by_name: person(will.admin_removed_by),
          admin_removed_reason: will.admin_removed_reason,
          created_at: will.created_at,
          has_audio: !!(twilioSidOf(will) || will.s3_key || will.metadata?.backup_s3_key),
        },
        owner: { id: will.user_id, name: will.owner_name, email: will.owner_email, phone: will.owner_phone, account_deleted: !!will.owner_deleted_at },
        recipients,
        links: links.rows,
      }
    });
  } catch (error) {
    console.error('Get will details error:', error);
    res.status(500).json({ success: false, error: 'Failed to load voice will' });
  }
});

// ── Release: mark released and deliver a private link to each recipient ──────
router.post('/wills/:id/release', authenticateAdmin, [
  body('notes').optional({ nullable: true }).isString().isLength({ max: 2000 }),
  body('deliver').optional().isBoolean()
], async (req, res) => {
  try {
    if (!validationResult(req).isEmpty()) return res.status(400).json({ success: false, error: 'Release notes are too long' });
    const will = await loadWill(req.params.id);
    if (!will) return res.status(404).json({ success: false, error: 'Voice will not found' });
    if (will.admin_removed_at) return res.status(400).json({ success: false, error: 'This will was removed from service. Restore it before releasing.' });
    if (will.is_released) return res.status(400).json({ success: false, error: 'This will has already been released' });

    // Claim the release atomically so two admins can't release (and send links) twice
    const claimed = await pool.query(
      `UPDATE voice_wills SET is_released = true, released_at = CURRENT_TIMESTAMP, released_by = $1,
              release_notes = $2, updated_at = CURRENT_TIMESTAMP
       WHERE id = $3 AND COALESCE(is_released, false) = false AND admin_removed_at IS NULL AND deleted_at IS NULL
       RETURNING id`,
      [req.user.id, req.body.notes?.trim() || null, will.id]
    );
    if (!claimed.rowCount) return res.status(409).json({ success: false, error: 'This will was just released by someone else' });

    const deliver = req.body.deliver !== false;
    const recipients = deliver ? (await buildRecipients(will)).filter(r => r.reachable) : [];
    const expiresAt = new Date(Date.now() + LINK_DAYS * 24 * 60 * 60 * 1000);
    const expiresDate = expiresAt.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
    const ownerName = will.owner_name || 'Someone';
    const results = [];

    for (const r of recipients) {
      const token = crypto.randomUUID();
      const listenUrl = `${process.env.FRONTEND_URL}/will/${token}`;
      let smsStatus = 'not_sent';
      let emailStatus = 'not_sent';

      if (r.phone && twilioClient && process.env.TWILIO_PHONE_NUMBER) {
        try {
          await twilioClient.messages.create({
            to: r.phone,
            from: process.env.TWILIO_PHONE_NUMBER,
            body: `${ownerName} left a voice will for you on SureTalk. Listen privately here (link works until ${expiresDate}): ${listenUrl}`
          });
          smsStatus = 'sent';
        } catch (err) {
          console.error(`Will release SMS failed for will ${will.id}: ${err.message}`);
          smsStatus = 'failed';
        }
      }
      if (r.email) {
        try {
          await emailService.sendWillReleasedEmail(r.email, r.name, { ownerName, listenUrl, expiresDate });
          emailStatus = 'sent';
        } catch (err) {
          console.error(`Will release email failed for will ${will.id}: ${err.message}`);
          emailStatus = 'failed';
        }
      }

      await pool.query(
        `INSERT INTO will_release_links (token, will_id, contact_id, recipient_name, recipient_phone, recipient_email,
                                         sms_status, email_status, expires_at, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [token, will.id, r.contactId, r.name, r.phone, r.email, smsStatus, emailStatus, expiresAt, req.user.id]
      );
      results.push({ name: r.name, phone: r.phone, email: r.email, sms: smsStatus, email_status: emailStatus });
    }

    const delivered = results.filter(r => r.sms === 'sent' || r.email_status === 'sent').length;
    logSystem(req.user.id, 'warning', 'Voice will released', { willId: will.id, ownerId: will.user_id, recipients: results.length, delivered });
    logAdminAudit({
      userId: req.user.id, action: 'RELEASE_WILL', targetId: will.id,
      oldValue: { is_released: false },
      newValue: { is_released: true, notes: req.body.notes || null, recipients: results.map(r => ({ name: r.name, sms: r.sms, email: r.email_status })) },
      ipAddress: req.ip
    });

    res.json({ success: true, data: { recipients: results, delivered, expiresAt } });
  } catch (error) {
    console.error('Release will error:', error);
    res.status(500).json({ success: false, error: 'Failed to release voice will' });
  }
});

// ── Listen (released wills only; every listen is audited) ───────────────────
router.post('/wills/:id/listen', authenticateAdmin, async (req, res) => {
  try {
    const will = await loadWill(req.params.id);
    if (!will) return res.status(404).json({ success: false, error: 'Voice will not found' });
    if (!will.is_released) {
      return res.status(403).json({ success: false, error: 'Voice wills stay private until they are released.' });
    }
    const audioUrl = await willAudioUrl(will);
    if (!audioUrl) return res.status(404).json({ success: false, error: 'No recording found for this will' });
    logAdminAudit({ userId: req.user.id, action: 'LISTEN_WILL', targetId: will.id, ipAddress: req.ip });
    res.json({ success: true, data: { audioUrl } });
  } catch (error) {
    console.error('Listen will error:', error);
    res.status(500).json({ success: false, error: 'Failed to load the recording' });
  }
});

// Copies a phone-line (Twilio) recording into S3 so removing the will from the phone line can never
// lose the audio. Returns the S3 key; throws if the copy fails.
async function backupTwilioRecording(will) {
  const sid = twilioSidOf(will);
  if (!sid) return null;
  const response = await axios.get(
    `https://api.twilio.com/2010-04-01/Accounts/${process.env.TWILIO_ACCOUNT_SID}/Recordings/${sid}.mp3`,
    { responseType: 'arraybuffer', timeout: 30000, auth: { username: process.env.TWILIO_ACCOUNT_SID, password: process.env.TWILIO_AUTH_TOKEN } }
  );
  const key = `wills/${will.user_id}/backup-${will.id}.mp3`;
  await s3.putObject({
    Bucket: BUCKETS.WILLS, Key: key, Body: Buffer.from(response.data),
    ContentType: 'audio/mpeg', ServerSideEncryption: 'AES256'
  }).promise();
  await pool.query(
    `UPDATE voice_wills SET metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object('backup_s3_key', $1::text) WHERE id = $2`,
    [key, will.id]
  );
  return key;
}

// For the phone line's sync-slot function (wills use kind: 'will'; slotNumber = the will slot 1–9)
const ivrWillPayload = (will, action) => ({
  userId: will.owner_phone,
  kind: 'will',
  slotNumber: String(will.will_slot_number),
  ...(action === 'create' ? {
    contact: will.contact_phone || will.title || 'Unknown',
    // Prefer the S3 backup: the phone line may have deleted the original Twilio recording on removal
    voiceMessage: will.metadata?.backup_s3_key
      ? resolveIvrPlaybackUrl({ source: 'app', s3_key: will.metadata.backup_s3_key })
      : will.source === 'ivr' ? (twilioSidOf(will) || will.s3_key) : resolveIvrPlaybackUrl(will)
  } : {}),
  action,
  source: 'admin'
});

// ── Remove from service (recording kept) ─────────────────────────────────────
router.post('/wills/:id/remove', authenticateAdmin, [
  body('reason').isString().trim().isLength({ min: 5, max: 1000 })
], async (req, res) => {
  try {
    if (!validationResult(req).isEmpty()) return res.status(400).json({ success: false, error: 'Give a reason (at least 5 characters)' });
    const will = await loadWill(req.params.id);
    if (!will) return res.status(404).json({ success: false, error: 'Voice will not found' });
    if (will.admin_removed_at) return res.status(400).json({ success: false, error: 'This will is already removed' });

    // Phone-line recordings only exist in Twilio — back them up first. If that fails, change nothing.
    let backupKey = will.metadata?.backup_s3_key || null;
    if (will.source === 'ivr' && !backupKey && twilioSidOf(will)) {
      try {
        backupKey = await backupTwilioRecording(will);
      } catch (err) {
        console.error(`Will backup failed for ${will.id}: ${err.message}`);
        return res.status(502).json({ success: false, error: 'Couldn\'t make a backup copy of the phone recording, so nothing was changed. Try again later.' });
      }
    }

    await pool.query(
      `UPDATE voice_wills SET admin_removed_at = CURRENT_TIMESTAMP, admin_removed_by = $1, admin_removed_reason = $2,
              updated_at = CURRENT_TIMESTAMP WHERE id = $3`,
      [req.user.id, req.body.reason.trim(), will.id]
    );
    // Recipients' links stop working while the will is removed
    await pool.query('UPDATE will_release_links SET revoked_at = CURRENT_TIMESTAMP WHERE will_id = $1 AND revoked_at IS NULL', [will.id]);
    if (will.owner_phone && will.will_slot_number) syncToIvr(ivrWillPayload(will, 'delete'), 'sync-slot');

    logSystem(req.user.id, 'warning', 'Voice will removed from service', { willId: will.id, reason: req.body.reason.trim(), backupKey });
    logAdminAudit({ userId: req.user.id, action: 'REMOVE_WILL', targetId: will.id, newValue: { reason: req.body.reason.trim(), recordingKept: true, backupKey }, ipAddress: req.ip });
    res.json({ success: true });
  } catch (error) {
    console.error('Remove will error:', error);
    res.status(500).json({ success: false, error: 'Failed to remove voice will' });
  }
});

// ── Restore ──────────────────────────────────────────────────────────────────
router.post('/wills/:id/restore', authenticateAdmin, async (req, res) => {
  try {
    const will = await loadWill(req.params.id);
    if (!will) return res.status(404).json({ success: false, error: 'Voice will not found' });
    if (!will.admin_removed_at) return res.status(400).json({ success: false, error: 'This will is not removed' });

    await pool.query(
      `UPDATE voice_wills SET admin_removed_at = NULL, admin_removed_by = NULL, admin_removed_reason = NULL,
              updated_at = CURRENT_TIMESTAMP WHERE id = $1`,
      [will.id]
    );
    // Links that haven't expired work again
    await pool.query('UPDATE will_release_links SET revoked_at = NULL WHERE will_id = $1 AND expires_at > NOW()', [will.id]);
    if (will.owner_phone && will.will_slot_number) syncToIvr(ivrWillPayload(will, 'create'), 'sync-slot');

    logSystem(req.user.id, 'info', 'Voice will restored', { willId: will.id });
    logAdminAudit({ userId: req.user.id, action: 'RESTORE_WILL', targetId: will.id, oldValue: { reason: will.admin_removed_reason }, ipAddress: req.ip });
    res.json({ success: true });
  } catch (error) {
    console.error('Restore will error:', error);
    res.status(500).json({ success: false, error: 'Failed to restore voice will' });
  }
});

module.exports = router;
module.exports.willAudioUrl = willAudioUrl;
