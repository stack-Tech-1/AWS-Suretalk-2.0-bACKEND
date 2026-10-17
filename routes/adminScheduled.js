// Admin scheduled messages — stats, list, export, details, pause/resume, cancel, retry.
// Phone-line (IVR) schedules are delivered by the executeScheduledCall Lambda, so they're view-only here.
// Needs migration 013_scheduled_message_states.sql. Mounted at /api/admin before routes/admin.js.
const express = require('express');
const router = express.Router();
const { body, validationResult } = require('express-validator');
const { authenticateAdmin } = require('../middleware/auth');
const { pool } = require('../config/database');

const isUuid = (v) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(v));
const IS_IVR = `(COALESCE(sm.metadata->>'source', 'app') = 'ivr')`;

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
  `INSERT INTO system_logs (user_id, level, service, message, metadata) VALUES ($1, $2, 'scheduled', $3, $4)`,
  [adminId, level, message, JSON.stringify(metadata)]
).catch(err => console.error('system_log write failed:', err.message));

// Shared SELECT + filters for the list and export
const BASE_SELECT = `
  SELECT sm.id, sm.delivery_status, sm.delivery_method, sm.scheduled_for, sm.delivered_at, sm.failed_at,
         sm.cancelled_at, sm.paused_at, sm.delivery_attempts, sm.last_attempt_at, sm.error_message,
         sm.custom_message, sm.created_at, sm.recipient_phone, sm.recipient_email, sm.user_id,
         ${IS_IVR} AS is_ivr,
         u.full_name AS sender_name, u.email AS sender_email,
         vn.title AS voice_note_title,
         c.name AS recipient_name, c.phone AS contact_phone, c.email AS contact_email,
         (SELECT COALESCE(SUM(pt.play_count), 0)::int FROM play_tokens pt WHERE pt.scheduled_message_id = sm.id) AS link_opens
  FROM scheduled_messages sm
  LEFT JOIN users u ON u.id = sm.user_id
  LEFT JOIN voice_notes vn ON vn.id = sm.voice_note_id
  LEFT JOIN contacts c ON c.id = sm.recipient_contact_id`;

function buildFilters(query) {
  const where = ['1=1'];
  const params = [];
  const status = query.status || 'all';
  if (['scheduled', 'paused', 'delivered', 'failed', 'cancelled'].includes(status)) {
    params.push(status);
    where.push(`sm.delivery_status = $${params.length}`);
    if (status === 'scheduled') where.push(`NOT ${IS_IVR}`);
  }
  if (status === 'phone') where.push(IS_IVR);
  if (query.search && String(query.search).trim()) {
    params.push(`%${String(query.search).trim()}%`);
    const n = params.length;
    where.push(`(u.email ILIKE $${n} OR u.full_name ILIKE $${n} OR vn.title ILIKE $${n} OR c.name ILIKE $${n}
                 OR sm.recipient_phone ILIKE $${n} OR sm.recipient_email ILIKE $${n})`);
  }
  return { whereSql: `WHERE ${where.join(' AND ')}`, params };
}

const shape = (m) => ({
  id: m.id,
  status: m.delivery_status,
  method: m.delivery_method,
  source: m.is_ivr ? 'ivr' : 'app',
  title: m.voice_note_title || (m.is_ivr ? 'Phone recording' : 'Voice message'),
  sender: m.sender_name || m.sender_email || 'Unknown',
  senderEmail: m.sender_email,
  userId: m.user_id,
  recipient: m.recipient_name || m.recipient_phone || m.contact_phone || m.recipient_email || m.contact_email || 'Unknown',
  recipientPhone: m.recipient_phone || m.contact_phone || null,
  recipientEmail: m.recipient_email || m.contact_email || null,
  scheduledFor: m.scheduled_for,
  deliveredAt: m.delivered_at,
  failedAt: m.failed_at,
  cancelledAt: m.cancelled_at,
  pausedAt: m.paused_at,
  attempts: m.delivery_attempts || 0,
  lastAttemptAt: m.last_attempt_at,
  error: m.error_message,
  customMessage: m.custom_message,
  createdAt: m.created_at,
  linkOpens: m.link_opens || 0,
});

// ── Stats (last 7 days) ──────────────────────────────────────────────────────
router.get('/scheduled-messages/stats', authenticateAdmin, async (req, res) => {
  try {
    const [counts, daily] = await Promise.all([
      pool.query(`
        SELECT
          COUNT(*) FILTER (WHERE sm.delivery_status = 'scheduled' AND NOT ${IS_IVR})::int AS waiting,
          COUNT(*) FILTER (WHERE sm.delivery_status = 'scheduled' AND NOT ${IS_IVR} AND sm.scheduled_for <= NOW())::int AS overdue,
          COUNT(*) FILTER (WHERE sm.delivery_status = 'paused')::int AS paused,
          COUNT(*) FILTER (WHERE sm.delivery_status = 'failed')::int AS failed_total,
          COUNT(*) FILTER (WHERE sm.delivery_status = 'delivered' AND sm.delivered_at >= NOW() - INTERVAL '7 days')::int AS delivered_7d,
          COUNT(*) FILTER (WHERE sm.delivery_status = 'failed' AND COALESCE(sm.failed_at, sm.updated_at) >= NOW() - INTERVAL '7 days')::int AS failed_7d,
          COUNT(*) FILTER (WHERE ${IS_IVR})::int AS phone_line
        FROM scheduled_messages sm`),
      pool.query(`
        SELECT d::date AS day,
          (SELECT COUNT(*)::int FROM scheduled_messages WHERE delivery_status = 'delivered' AND delivered_at::date = d::date) AS delivered,
          (SELECT COUNT(*)::int FROM scheduled_messages WHERE delivery_status = 'failed' AND COALESCE(failed_at, updated_at)::date = d::date) AS failed
        FROM generate_series(CURRENT_DATE - INTERVAL '6 days', CURRENT_DATE, INTERVAL '1 day') AS d
        ORDER BY d`),
    ]);
    const s = counts.rows[0];
    const attempted = s.delivered_7d + s.failed_7d;
    res.json({
      success: true,
      data: {
        ...s,
        success_rate_7d: attempted ? Math.round((s.delivered_7d / attempted) * 1000) / 10 : null,
        daily: daily.rows.map(r => ({ day: r.day, delivered: r.delivered, failed: r.failed }))
      }
    });
  } catch (error) {
    console.error('Scheduled stats error:', error);
    res.status(500).json({ success: false, error: 'Failed to load scheduled message stats' });
  }
});

// ── List ─────────────────────────────────────────────────────────────────────
router.get('/scheduled-messages', authenticateAdmin, async (req, res) => {
  try {
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 25, 1), 100);
    const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
    const { whereSql, params } = buildFilters(req.query);
    // Waiting messages: soonest first. Everything else: newest first.
    const order = req.query.status === 'scheduled' || req.query.status === 'paused' ? 'sm.scheduled_for ASC' : 'sm.scheduled_for DESC';
    const result = await pool.query(
      `SELECT * , COUNT(*) OVER()::int AS total_count FROM (${BASE_SELECT} ${whereSql}) sm
       ORDER BY ${order.replace('sm.', '')} LIMIT ${limit} OFFSET ${(page - 1) * limit}`,
      params
    );
    let total = result.rows[0]?.total_count;
    if (total === undefined) {
      total = (await pool.query(`SELECT COUNT(*)::int AS count FROM (${BASE_SELECT} ${whereSql}) x`, params)).rows[0].count;
    }
    res.json({
      success: true,
      data: { messages: result.rows.map(shape), pagination: { page, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)) } }
    });
  } catch (error) {
    console.error('Get admin scheduled messages error:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch scheduled messages' });
  }
});

// ── Export (before /:id) ─────────────────────────────────────────────────────
const csvCell = (value) => {
  let text = value === null || value === undefined ? '' : String(value);
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
};

router.get('/scheduled-messages/export', authenticateAdmin, async (req, res) => {
  try {
    const format = req.query.format === 'json' ? 'json' : 'csv';
    const { whereSql, params } = buildFilters(req.query);
    const result = await pool.query(`${BASE_SELECT} ${whereSql} ORDER BY sm.scheduled_for DESC LIMIT 50000`, params);
    const iso = (d) => (d ? new Date(d).toISOString().replace('T', ' ').slice(0, 16) + ' UTC' : '');
    const rows = result.rows.map(shape).map(m => ({
      'Message ID': m.id,
      'Status': m.status,
      'Scheduled from': m.source === 'ivr' ? 'Phone line' : 'App',
      'Method': m.method,
      'Sender': m.sender,
      'Sender email': m.senderEmail || '',
      'Recipient': m.recipient,
      'Recipient phone': m.recipientPhone || '',
      'Recipient email': m.recipientEmail || '',
      'Voice note': m.title,
      'Scheduled for': iso(m.scheduledFor),
      'Delivered at': iso(m.deliveredAt),
      'Failed at': iso(m.failedAt),
      'Attempts': m.attempts,
      'Error': m.error || '',
      'Link opens': m.linkOpens,
    }));
    logAdminAudit({ userId: req.user.id, action: 'EXPORT_SCHEDULED_MSGS', newValue: { format, count: rows.length, filters: req.query }, ipAddress: req.ip });
    const stamp = new Date().toISOString().slice(0, 10);
    if (format === 'json') {
      res.setHeader('Content-Disposition', `attachment; filename="suretalk-scheduled-${stamp}.json"`);
      return res.json({ exportedAt: new Date().toISOString(), count: rows.length, messages: rows });
    }
    const headers = Object.keys(rows[0] || { 'Message ID': '' });
    const csv = [headers.map(csvCell).join(','), ...rows.map(r => headers.map(h => csvCell(r[h])).join(','))].join('\r\n');
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="suretalk-scheduled-${stamp}.csv"`);
    res.send('﻿' + csv);
  } catch (error) {
    console.error('Export scheduled messages error:', error);
    res.status(500).json({ success: false, error: 'Failed to export scheduled messages' });
  }
});

// ── Details ──────────────────────────────────────────────────────────────────
router.get('/scheduled-messages/:id', authenticateAdmin, async (req, res) => {
  try {
    if (!isUuid(req.params.id)) return res.status(404).json({ success: false, error: 'Message not found' });
    const result = await pool.query(`${BASE_SELECT} WHERE sm.id = $1`, [req.params.id]);
    if (!result.rows.length) return res.status(404).json({ success: false, error: 'Message not found' });
    const extra = await pool.query(
      `SELECT sm.twilio_call_sid, sm.twilio_message_sid, sm.metadata,
              (SELECT MAX(pt.last_played) FROM play_tokens pt WHERE pt.scheduled_message_id = sm.id) AS last_opened,
              (SELECT MIN(pt.expires_at) FROM play_tokens pt WHERE pt.scheduled_message_id = sm.id) AS link_expires
       FROM scheduled_messages sm WHERE sm.id = $1`,
      [req.params.id]
    );
    const x = extra.rows[0] || {};
    const history = await pool.query(
      `SELECT a.action, a.new_value, a.created_at, u.full_name AS admin_name, u.email AS admin_email
       FROM admin_audit_log a LEFT JOIN users u ON u.id = a.admin_user_id
       WHERE a.target_id = $1 ORDER BY a.created_at DESC LIMIT 20`,
      [req.params.id]
    );
    res.json({
      success: true,
      data: {
        message: {
          ...shape(result.rows[0]),
          callSent: !!x.twilio_call_sid,
          smsSent: !!x.twilio_message_sid,
          lastOpened: x.last_opened || null,
          linkExpires: x.link_expires || null,
          ivrScheduleId: x.metadata?.ivrScheduleId || null,
        },
        adminHistory: history.rows
      }
    });
  } catch (error) {
    console.error('Get scheduled message error:', error);
    res.status(500).json({ success: false, error: 'Failed to load message' });
  }
});

// ── Actions ──────────────────────────────────────────────────────────────────
async function loadForAction(req, res) {
  if (!isUuid(req.params.id)) { res.status(404).json({ success: false, error: 'Message not found' }); return null; }
  const r = await pool.query(
    `SELECT sm.id, sm.delivery_status, sm.scheduled_for, sm.delivery_attempts, ${IS_IVR} AS is_ivr
     FROM scheduled_messages sm WHERE sm.id = $1`,
    [req.params.id]
  );
  const m = r.rows[0];
  if (!m) { res.status(404).json({ success: false, error: 'Message not found' }); return null; }
  if (m.is_ivr) {
    res.status(409).json({ success: false, code: 'PHONE_LINE', error: 'This message was scheduled by phone and is delivered by the phone line, so it can\'t be changed here.' });
    return null;
  }
  return m;
}

// from → to transitions each action allows
const ACTIONS = {
  pause:   { from: ['scheduled'], to: 'paused',    sql: `paused_at = NOW()`, audit: 'PAUSE_SCHEDULED_MSG' },
  resume:  { from: ['paused'],    to: 'scheduled', sql: `paused_at = NULL`, audit: 'RESUME_SCHEDULED_MSG' },
  cancel:  { from: ['scheduled', 'paused', 'failed'], to: 'cancelled', sql: `cancelled_at = NOW()`, audit: 'CANCEL_SCHEDULED_MSG' },
  // Retry: fresh attempts; goes out within a minute if its time has passed
  retry:   { from: ['failed'],    to: 'scheduled', sql: `delivery_attempts = 0, error_message = NULL, failed_at = NULL`, audit: 'RETRY_SCHEDULED_MSG' },
};

for (const [name, action] of Object.entries(ACTIONS)) {
  const validators = name === 'cancel' ? [body('reason').isString().trim().isLength({ min: 3, max: 1000 })] : [];
  router.post(`/scheduled-messages/:id/${name}`, authenticateAdmin, validators, async (req, res) => {
    try {
      if (!validationResult(req).isEmpty()) return res.status(400).json({ success: false, error: 'Give a reason for cancelling' });
      const m = await loadForAction(req, res);
      if (!m) return;
      if (!action.from.includes(m.delivery_status)) {
        return res.status(400).json({ success: false, error: `A ${m.delivery_status} message can't be ${name === 'retry' ? 'retried' : name + 'd'}` });
      }
      const note = name === 'cancel' ? req.body.reason.trim() : null;
      // Status in the WHERE so a message that changed meanwhile (e.g. just delivered) isn't overwritten
      const updated = await pool.query(
        `UPDATE scheduled_messages
         SET delivery_status = $1, ${action.sql}, updated_at = NOW(),
             metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object('last_admin_action', $2::text, 'admin_note', $3::text)
         WHERE id = $4 AND delivery_status = ANY($5::text[])
         RETURNING id`,
        [action.to, name, note, m.id, action.from]
      );
      if (!updated.rowCount) return res.status(409).json({ success: false, error: 'This message changed while you were looking at it. Refresh and try again.' });

      logSystem(req.user.id, name === 'cancel' ? 'warning' : 'info', `Scheduled message ${name === 'retry' ? 'retried' : name + 'd'} by admin`, { messageId: m.id, reason: note });
      logAdminAudit({ userId: req.user.id, action: action.audit, targetId: m.id, oldValue: { status: m.delivery_status }, newValue: { status: action.to, ...(note ? { reason: note } : {}) }, ipAddress: req.ip });

      const overdue = action.to === 'scheduled' && new Date(m.scheduled_for) <= new Date();
      res.json({ success: true, data: { status: action.to, sendsWithinAMinute: overdue } });
    } catch (error) {
      console.error(`Scheduled message ${name} error:`, error);
      res.status(500).json({ success: false, error: `Failed to ${name} message` });
    }
  });
}

module.exports = router;
