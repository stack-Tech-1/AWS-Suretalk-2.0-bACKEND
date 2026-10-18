// Super admin console — users (plan, suspend, impersonate, IVR re-sync, exports), sync dead letters,
// activity, sync monitor, system health and revenue.
// Deleting accounts is soft-only (admin Users page); there is no permanent-erase route by design.
const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
const { body, validationResult } = require('express-validator');
const { pool } = require('../config/database');
const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, GetCommand } = require('@aws-sdk/lib-dynamodb');
const { NodeHttpHandler } = require('@smithy/node-http-handler');
const { applyPlan, setActive, STRIPE_MANAGED, TIER_LIMITS, TIERS } = require('./adminUsers');
const phoneLineQueue = require('../utils/phoneLineQueue');
const { phoneKey } = require('../workers/syncReconciler');

const dynamoClient = new DynamoDBClient({
  region: process.env.AWS_REGION || 'eu-central-1',
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY
  },
  requestHandler: new NodeHttpHandler({ requestTimeout: 10000, connectionTimeout: 5000 }),
  maxAttempts: 2
});
const dynamodb = DynamoDBDocumentClient.from(dynamoClient);

const isUuid = (v) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(v));

// Super admin authentication middleware
const authenticateSuperAdmin = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ success: false, error: 'Unauthorized' });
    }
    const decoded = jwt.verify(authHeader.split(' ')[1], process.env.JWT_SECRET);
    if (decoded.impersonation) return res.status(403).json({ success: false, error: 'Super admin access required' });

    const userResult = await pool.query(
      `SELECT id, email, full_name, is_admin, is_super_admin, admin_status, last_logout_at
       FROM users WHERE id = $1 AND deleted_at IS NULL`,
      [decoded.userId]
    );
    const u = userResult.rows[0];
    if (!u || !u.is_admin || !u.is_super_admin || u.admin_status !== 'approved') {
      return res.status(403).json({ success: false, error: 'Super admin access required' });
    }
    if (u.last_logout_at && decoded.iat && decoded.iat * 1000 < new Date(u.last_logout_at).getTime()) {
      return res.status(401).json({ success: false, error: 'Session expired. Please log in again.' });
    }
    req.user = u;
    next();
  } catch (err) {
    return res.status(401).json({ success: false, error: 'Invalid token' });
  }
};

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

const csvCell = (value) => {
  let text = value === null || value === undefined ? '' : (typeof value === 'object' ? JSON.stringify(value) : String(value));
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
};
const sendCsv = (res, filename, headers, rows) => {
  const csv = [headers.map(csvCell).join(','), ...rows.map(r => r.map(csvCell).join(','))].join('\r\n');
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send('﻿' + csv);
};
const safeName = (s) => String(s || '').replace(/[^\w.-]+/g, '-').slice(0, 60) || 'user';
const day = (d) => (d ? new Date(d).toISOString().slice(0, 10) : '');

// sync_received_log's timestamp is processed_at (migration 005); older copies used created_at
let receivedTimeCol;
async function receivedTs() {
  if (receivedTimeCol) return receivedTimeCol;
  const r = await pool.query(`SELECT column_name FROM information_schema.columns
                              WHERE table_name = 'sync_received_log' AND column_name IN ('processed_at', 'created_at')`);
  const cols = r.rows.map(x => x.column_name);
  receivedTimeCol = cols.includes('processed_at') ? 'processed_at' : (cols[0] || null);
  return receivedTimeCol;
}

// Per-user storage/counts as subqueries — joining notes and contacts together multiplied the sums
const USER_COUNTS = `
  (SELECT COUNT(*)::int FROM voice_notes vn WHERE vn.user_id = u.id AND vn.deleted_at IS NULL) AS voice_note_count,
  (SELECT COUNT(*)::int FROM contacts c WHERE c.user_id = u.id) AS contact_count,
  (SELECT COALESCE(SUM(vn.file_size_bytes), 0)::bigint FROM voice_notes vn WHERE vn.user_id = u.id AND vn.deleted_at IS NULL) AS storage_used_bytes`;

// ── Users ────────────────────────────────────────────────────────────────────
router.get('/users', authenticateSuperAdmin, async (req, res) => {
  try {
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 20, 1), 100);
    const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
    const params = [];
    const where = [];
    const status = req.query.status || '';
    where.push(status === 'deleted' ? 'u.deleted_at IS NOT NULL' : 'u.deleted_at IS NULL');
    if (status === 'suspended') where.push('COALESCE(u.is_suspended, false) = true');
    if (status === 'active') where.push('COALESCE(u.is_suspended, false) = false');
    if (status === 'admins') where.push('COALESCE(u.is_admin, false) = true');
    if (req.query.search) {
      params.push(`%${String(req.query.search).trim()}%`);
      where.push(`(u.email ILIKE $${params.length} OR u.full_name ILIKE $${params.length} OR u.phone ILIKE $${params.length})`);
    }
    if (TIERS.includes(req.query.tier)) {
      params.push(req.query.tier);
      where.push(`u.subscription_tier = $${params.length}`);
    }
    const sorts = { created_at: 'u.created_at', full_name: 'u.full_name', email: 'u.email', last_active: 'last_active', storage: 'storage_used_bytes' };
    const sortCol = sorts[req.query.sort] || 'u.created_at';
    const order = req.query.order === 'asc' ? 'ASC' : 'DESC';

    const result = await pool.query(
      `SELECT u.id, u.full_name, u.email, u.phone, u.subscription_tier, u.subscription_status,
              COALESCE(u.is_admin, false) AS is_admin, COALESCE(u.is_super_admin, false) AS is_super_admin,
              COALESCE(u.is_suspended, false) AS is_suspended, u.email_verified, u.created_at, u.deleted_at,
              u.last_login, COALESCE(u.last_active_at, u.last_login) AS last_active, u.source,
              ${STRIPE_MANAGED} AS stripe_managed,
              ${USER_COUNTS},
              COUNT(*) OVER()::int AS total_count
       FROM users u
       WHERE ${where.join(' AND ')}
       ORDER BY ${sortCol} ${order} NULLS LAST
       LIMIT ${limit} OFFSET ${(page - 1) * limit}`,
      params
    );
    const total = result.rows[0]?.total_count || 0;
    res.json({
      success: true,
      data: {
        users: result.rows.map(({ total_count, ...u }) => ({ ...u, storage_used_bytes: Number(u.storage_used_bytes) })),
        pagination: { page, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)) }
      }
    });
  } catch (err) {
    console.error('Super admin get users error:', err);
    res.status(500).json({ success: false, error: 'Failed to fetch users' });
  }
});

// Must stay before /users/:id routes
router.get('/users/export', authenticateSuperAdmin, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT u.id, u.full_name, u.email, u.phone, u.subscription_tier, u.email_verified,
              COALESCE(u.is_suspended, false) AS is_suspended, u.source, u.created_at,
              COALESCE(u.last_active_at, u.last_login) AS last_active, ${USER_COUNTS}
       FROM users u
       WHERE u.deleted_at IS NULL AND COALESCE(u.is_admin, false) = false
       ORDER BY u.created_at DESC`
    );
    logAdminAudit({ userId: req.user.id, action: 'SUPER_EXPORT_USERS', newValue: { count: result.rows.length }, ipAddress: req.ip });
    sendCsv(res, `suretalk-users-${day(new Date())}.csv`,
      ['ID', 'Full name', 'Email', 'Phone', 'Plan', 'Email verified', 'Suspended', 'Source', 'Joined', 'Last active', 'Voice notes', 'Contacts', 'Storage (MB)'],
      result.rows.map(u => [u.id, u.full_name, u.email, u.phone, u.subscription_tier, u.email_verified ? 'Yes' : 'No',
        u.is_suspended ? 'Yes' : 'No', u.source || 'app', day(u.created_at), day(u.last_active) || 'Never',
        u.voice_note_count, u.contact_count, (Number(u.storage_used_bytes) / (1024 * 1024)).toFixed(2)]));
  } catch (err) {
    console.error('Export users error:', err.message);
    res.status(500).json({ success: false, error: 'Failed to export users' });
  }
});

// ── Impersonation (5 minutes, audited) ───────────────────────────────────────
router.post('/users/:id/impersonate', authenticateSuperAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    if (!isUuid(id)) return res.status(404).json({ success: false, error: 'User not found' });
    if (id === req.user.id) return res.status(400).json({ success: false, error: 'Cannot impersonate yourself' });

    const target = (await pool.query(
      `SELECT id, full_name, email, COALESCE(is_admin, false) AS is_admin, COALESCE(is_super_admin, false) AS is_super_admin,
              COALESCE(is_suspended, false) AS is_suspended, deleted_at
       FROM users WHERE id = $1`, [id])).rows[0];
    if (!target || target.deleted_at) return res.status(404).json({ success: false, error: 'User not found' });
    if (target.is_admin || target.is_super_admin) return res.status(403).json({ success: false, error: 'Cannot impersonate admin accounts' });
    if (target.is_suspended) return res.status(403).json({ success: false, error: 'Cannot impersonate a suspended account' });

    const expiresAt = new Date(Date.now() + 5 * 60 * 1000);
    const token = jwt.sign({ userId: target.id, impersonation: true, adminId: req.user.id, exp: Math.floor(expiresAt.getTime() / 1000) }, process.env.JWT_SECRET);
    await pool.query(
      `INSERT INTO impersonation_tokens (token, admin_id, target_user_id, expires_at) VALUES ($1, $2, $3, $4)`,
      [token, req.user.id, id, expiresAt]
    );
    logAdminAudit({ userId: req.user.id, action: 'IMPERSONATE_USER', targetId: id, newValue: { email: target.email, expiresAt }, ipAddress: req.ip });

    res.json({
      success: true,
      data: { token, expiresAt: expiresAt.toISOString(), targetUser: { id: target.id, fullName: target.full_name, email: target.email }, durationMinutes: 5 }
    });
  } catch (err) {
    console.error('Impersonation error:', err.message);
    res.status(500).json({ success: false, error: 'Failed to start impersonation' });
  }
});

router.post('/impersonate/exit', async (req, res) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) return res.status(401).json({ success: false, error: 'Unauthorized' });
    const token = authHeader.split(' ')[1];
    let decoded;
    try { decoded = jwt.verify(token, process.env.JWT_SECRET); } catch { decoded = jwt.decode(token); }
    if (decoded?.impersonation && decoded?.userId) {
      await pool.query(`UPDATE impersonation_tokens SET is_active = FALSE, exited_at = NOW() WHERE token = $1`, [token]);
      if (decoded.adminId) logAdminAudit({ userId: decoded.adminId, action: 'IMPERSONATE_EXIT', targetId: decoded.userId });
    }
    res.json({ success: true, message: 'Impersonation ended' });
  } catch (err) {
    console.error('Impersonation exit error:', err.message);
    res.status(500).json({ success: false, error: 'Failed to exit impersonation' });
  }
});

// ── Per-user exports ─────────────────────────────────────────────────────────
router.get('/users/:id/export/full', authenticateSuperAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    if (!isUuid(id)) return res.status(404).json({ success: false, error: 'User not found' });
    const [userResult, voiceNotes, contacts, scheduled, vault, activity] = await Promise.all([
      pool.query(`SELECT id, full_name, email, phone, subscription_tier, subscription_status, email_verified, source,
                         created_at, last_login, COALESCE(is_suspended, false) AS is_suspended, deleted_at
                  FROM users WHERE id = $1`, [id]),
      pool.query(`SELECT id, title, description, duration_seconds, file_size_bytes, is_favorite, is_permanent, play_count, source, created_at
                  FROM voice_notes WHERE user_id = $1 AND deleted_at IS NULL ORDER BY created_at DESC`, [id]),
      pool.query(`SELECT id, name, phone, email, relationship, created_at FROM contacts WHERE user_id = $1 ORDER BY created_at DESC`, [id]),
      pool.query(`SELECT id, delivery_method, delivery_status, scheduled_for, delivered_at, recipient_phone, recipient_email, created_at
                  FROM scheduled_messages WHERE user_id = $1 ORDER BY created_at DESC`, [id]),
      pool.query(`SELECT id, title, release_condition, release_date, is_released, created_at
                  FROM voice_wills WHERE user_id = $1 AND deleted_at IS NULL ORDER BY created_at DESC`, [id]),
      pool.query(`SELECT event_type, event_data, created_at FROM analytics_events
                  WHERE user_id = $1 AND created_at >= NOW() - INTERVAL '90 days' ORDER BY created_at DESC LIMIT 1000`, [id])
    ]);
    if (!userResult.rows.length) return res.status(404).json({ success: false, error: 'User not found' });
    logAdminAudit({ userId: req.user.id, action: 'SUPER_EXPORT_USER_DATA', targetId: id, ipAddress: req.ip });
    const u = userResult.rows[0];
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', `attachment; filename="suretalk-user-${safeName(u.full_name || id)}-${day(new Date())}.json"`);
    res.send(JSON.stringify({
      exportedAt: new Date().toISOString(), exportedBy: req.user.email, user: u,
      voiceNotes: voiceNotes.rows, contacts: contacts.rows, scheduledMessages: scheduled.rows, vault: vault.rows, activityLog: activity.rows
    }, null, 2));
  } catch (err) {
    console.error('Export full user error:', err.message);
    res.status(500).json({ success: false, error: 'Export failed' });
  }
});

router.get('/users/:id/export/billing', authenticateSuperAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    if (!isUuid(id)) return res.status(404).json({ success: false, error: 'User not found' });
    const [userResult, billing] = await Promise.all([
      pool.query('SELECT full_name FROM users WHERE id = $1', [id]),
      pool.query(`SELECT stripe_invoice_id, amount_cents, currency, description, status, tier_before, tier_after, created_at
                  FROM billing_history WHERE user_id = $1 ORDER BY created_at DESC`, [id])
    ]);
    if (!userResult.rows.length) return res.status(404).json({ success: false, error: 'User not found' });
    sendCsv(res, `suretalk-billing-${safeName(userResult.rows[0].full_name || id)}-${day(new Date())}.csv`,
      ['Invoice ID', 'Amount', 'Currency', 'Description', 'Status', 'Plan before', 'Plan after', 'Date'],
      billing.rows.map(b => [b.stripe_invoice_id, (b.amount_cents / 100).toFixed(2), (b.currency || 'USD').toUpperCase(), b.description, b.status, b.tier_before, b.tier_after, day(b.created_at)]));
  } catch (err) {
    console.error('Export billing error:', err.message);
    res.status(500).json({ success: false, error: 'Export failed' });
  }
});

router.get('/users/:id/export/voice-notes', authenticateSuperAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    if (!isUuid(id)) return res.status(404).json({ success: false, error: 'User not found' });
    const [userResult, notes] = await Promise.all([
      pool.query('SELECT full_name FROM users WHERE id = $1', [id]),
      pool.query(`SELECT id, title, description, duration_seconds, file_size_bytes, file_format, is_favorite, is_permanent,
                         play_count, last_played, source, created_at
                  FROM voice_notes WHERE user_id = $1 AND deleted_at IS NULL ORDER BY created_at DESC`, [id])
    ]);
    if (!userResult.rows.length) return res.status(404).json({ success: false, error: 'User not found' });
    sendCsv(res, `suretalk-voice-notes-${safeName(userResult.rows[0].full_name || id)}-${day(new Date())}.csv`,
      ['ID', 'Title', 'Description', 'Duration (s)', 'Size (bytes)', 'Format', 'Favorite', 'Permanent', 'Plays', 'Last played', 'Source', 'Created'],
      notes.rows.map(n => [n.id, n.title, n.description, n.duration_seconds || 0, n.file_size_bytes || 0, n.file_format || 'mp3',
        n.is_favorite ? 'Yes' : 'No', n.is_permanent ? 'Yes' : 'No', n.play_count || 0, n.last_played ? new Date(n.last_played).toISOString() : '',
        n.source || 'app', n.created_at ? new Date(n.created_at).toISOString() : '']));
  } catch (err) {
    console.error('Export voice notes error:', err.message);
    res.status(500).json({ success: false, error: 'Export failed' });
  }
});

router.get('/export/sync-logs', authenticateSuperAdmin, async (req, res) => {
  try {
    const days = Math.min(Math.max(parseInt(req.query.days, 10) || 30, 1), 365);
    const ts = await receivedTs();
    const [outbox, received] = await Promise.all([
      pool.query(`SELECT id, event_type, status, attempts, error_message, created_at, last_attempt_at
                  FROM sync_outbox WHERE created_at >= NOW() - make_interval(days => $1) ORDER BY created_at DESC LIMIT 5000`, [days]),
      ts ? pool.query(`SELECT id, source, event_type, ${ts} AS created_at
                  FROM sync_received_log WHERE ${ts} >= NOW() - make_interval(days => $1) ORDER BY ${ts} DESC LIMIT 5000`, [days]) : { rows: [] }
    ]);
    const rows = [
      ...outbox.rows.map(r => ['App → phone line', r.id, r.event_type, r.status, r.attempts, r.error_message, r.created_at && new Date(r.created_at).toISOString(), r.last_attempt_at && new Date(r.last_attempt_at).toISOString()]),
      ...received.rows.map(r => ['Phone line → app', r.id, r.event_type, 'received', '', '', r.created_at && new Date(r.created_at).toISOString(), '']),
    ];
    sendCsv(res, `suretalk-sync-logs-${day(new Date())}.csv`, ['Direction', 'ID', 'Event', 'Status', 'Attempts', 'Error', 'Created', 'Last attempt'], rows);
  } catch (err) {
    console.error('Export sync logs error:', err.message);
    res.status(500).json({ success: false, error: 'Export failed' });
  }
});

// ── User profile (explicit columns — never password hashes, 2FA secrets or tokens) ──
router.get('/users/:id/full', authenticateSuperAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    if (!isUuid(id)) return res.status(404).json({ success: false, error: 'User not found' });
    const userResult = await pool.query(
      `SELECT u.id, u.full_name, u.email, u.phone, u.subscription_tier, u.subscription_status, u.source,
              u.email_verified, u.created_at, u.updated_at, u.deleted_at, u.last_login,
              COALESCE(u.last_active_at, u.last_login) AS last_active,
              COALESCE(u.is_admin, false) AS is_admin, COALESCE(u.is_super_admin, false) AS is_super_admin, u.admin_status,
              COALESCE(u.is_suspended, false) AS is_suspended, u.suspended_at, u.suspended_reason,
              COALESCE(u.two_factor_enabled, false) AS two_factor_enabled,
              u.storage_limit_gb, u.contacts_limit, u.voice_notes_limit,
              u.stripe_customer_id, u.stripe_subscription_id, ${STRIPE_MANAGED} AS stripe_managed,
              ${USER_COUNTS},
              (SELECT COUNT(*)::int FROM scheduled_messages sm WHERE sm.user_id = u.id) AS scheduled_count
       FROM users u WHERE u.id = $1`,
      [id]
    );
    if (!userResult.rows.length) return res.status(404).json({ success: false, error: 'User not found' });

    const [voiceNotes, contacts, scheduled, vault, billing] = await Promise.all([
      pool.query(`SELECT id, title, description, duration_seconds, file_size_bytes, is_favorite, is_permanent, play_count, last_played, source, created_at
                  FROM voice_notes WHERE user_id = $1 AND deleted_at IS NULL ORDER BY created_at DESC LIMIT 50`, [id]),
      pool.query(`SELECT id, name, phone, email, relationship, created_at FROM contacts WHERE user_id = $1 ORDER BY created_at DESC`, [id]),
      pool.query(`SELECT sm.id, sm.delivery_method, sm.delivery_status, sm.scheduled_for, sm.delivered_at, sm.error_message,
                         sm.recipient_email, sm.recipient_phone, sm.created_at, COALESCE(sm.metadata->>'source', 'app') AS source,
                         vn.title AS voice_note_title
                  FROM scheduled_messages sm LEFT JOIN voice_notes vn ON sm.voice_note_id = vn.id
                  WHERE sm.user_id = $1 ORDER BY sm.created_at DESC LIMIT 50`, [id]),
      pool.query(`SELECT id, title, release_condition, release_date, is_released, released_at, COALESCE(source, 'app') AS source,
                         admin_removed_at, created_at
                  FROM voice_wills WHERE user_id = $1 AND deleted_at IS NULL ORDER BY created_at DESC`, [id]).catch(() => ({ rows: [] })),
      pool.query(`SELECT amount_cents, currency, status, description, created_at FROM billing_history
                  WHERE user_id = $1 ORDER BY created_at DESC LIMIT 20`, [id]),
    ]);
    const u = userResult.rows[0];
    res.json({
      success: true,
      data: {
        user: { ...u, storage_used_bytes: Number(u.storage_used_bytes) },
        voiceNotes: voiceNotes.rows, contacts: contacts.rows, scheduled: scheduled.rows, vault: vault.rows,
        billing: billing.rows, planLimits: TIER_LIMITS
      }
    });
  } catch (err) {
    console.error('Super admin get user full error:', { message: err.message, code: err.code });
    res.status(500).json({ success: false, error: 'Failed to fetch user data' });
  }
});

router.get('/users/:id/footprint', authenticateSuperAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    if (!isUuid(id)) return res.status(404).json({ success: false, error: 'User not found' });
    const since = new Date(Date.now() - 90 * 86400e3);
    const [events, logins, daily, breakdown, topPlayed] = await Promise.all([
      pool.query(`SELECT event_type, event_data, created_at, voice_note_id, contact_id FROM analytics_events
                  WHERE user_id = $1 AND created_at >= $2 ORDER BY created_at DESC LIMIT 500`, [id, since]),
      // Sign-ins and failed sign-ins are recorded in system_logs
      pool.query(`SELECT message AS event_type, ip_address::text AS ip_address, user_agent, created_at FROM system_logs
                  WHERE user_id = $1 AND service = 'auth' AND created_at >= $2 ORDER BY created_at DESC LIMIT 200`, [id, since]),
      pool.query(`SELECT DATE(created_at) AS date, COUNT(*)::int AS total_events,
                         COUNT(*) FILTER (WHERE event_type = 'voice_note_played')::int AS plays,
                         COUNT(*) FILTER (WHERE event_type = 'voice_note_created')::int AS recordings,
                         COUNT(*) FILTER (WHERE event_type = 'voice_note_downloaded')::int AS downloads,
                         COUNT(*) FILTER (WHERE event_type = 'scheduled_message_created')::int AS schedules
                  FROM analytics_events WHERE user_id = $1 AND created_at >= $2 GROUP BY DATE(created_at) ORDER BY date DESC`, [id, since]),
      pool.query(`SELECT event_type, COUNT(*)::int AS count FROM analytics_events WHERE user_id = $1 AND created_at >= $2
                  GROUP BY event_type ORDER BY count DESC`, [id, since]),
      pool.query(`SELECT id, title, play_count, last_played, duration_seconds, created_at FROM voice_notes
                  WHERE user_id = $1 AND deleted_at IS NULL ORDER BY play_count DESC NULLS LAST LIMIT 10`, [id]),
    ]);
    res.json({
      success: true,
      data: { events: events.rows, loginHistory: logins.rows, dailySummary: daily.rows, eventBreakdown: breakdown.rows, topPlayed: topPlayed.rows, period: '90 days' }
    });
  } catch (err) {
    console.error('Super admin footprint error:', err);
    res.status(500).json({ success: false, error: 'Failed to fetch footprint' });
  }
});

async function loadTarget(req, res) {
  if (!isUuid(req.params.id)) { res.status(404).json({ success: false, error: 'User not found' }); return null; }
  const r = await pool.query(
    `SELECT u.id, u.email, u.full_name, u.subscription_tier, u.subscription_status, u.stripe_subscription_id,
            COALESCE(u.is_admin, false) AS is_admin, COALESCE(u.is_super_admin, false) AS is_super_admin,
            COALESCE(u.is_suspended, false) AS is_suspended, ${STRIPE_MANAGED} AS stripe_managed
     FROM users u WHERE u.id = $1 AND u.deleted_at IS NULL`,
    [req.params.id]
  );
  if (!r.rows.length) { res.status(404).json({ success: false, error: 'User not found' }); return null; }
  return r.rows[0];
}

// ── Plan change (same rules as the admin Users page) ─────────────────────────
router.put('/users/:id/tier', authenticateSuperAdmin, [
  body('tier').isIn(TIERS),
  body('reason').isString().trim().isLength({ min: 3, max: 1000 })
], async (req, res) => {
  try {
    if (!validationResult(req).isEmpty()) return res.status(400).json({ success: false, error: 'Choose a plan and give a reason' });
    const user = await loadTarget(req, res);
    if (!user) return;
    if (user.stripe_managed) {
      return res.status(409).json({ success: false, code: 'STRIPE_MANAGED', error: 'This user pays through Stripe, so their plan follows their subscription. Change it in Stripe instead.' });
    }
    if (user.subscription_tier === req.body.tier) return res.status(400).json({ success: false, error: 'They\'re already on that plan' });
    const limits = await applyPlan(user.id, req.body.tier);
    logAdminAudit({
      userId: req.user.id, action: 'SUPER_CHANGE_PLAN', targetId: user.id,
      oldValue: { subscription_tier: user.subscription_tier }, newValue: { subscription_tier: req.body.tier, limits, reason: req.body.reason.trim() }, ipAddress: req.ip
    });
    res.json({ success: true, message: `Plan changed to ${req.body.tier}` });
  } catch (err) {
    console.error('Super admin tier change error:', err);
    res.status(500).json({ success: false, error: 'Failed to update plan' });
  }
});

// ── Suspend / reactivate (blocks app, admin console and phone line) ─────────
router.put('/users/:id/suspend', authenticateSuperAdmin, [
  body('suspend').isBoolean(),
  body('reason').optional({ nullable: true }).isString().isLength({ max: 1000 })
], async (req, res) => {
  try {
    if (!validationResult(req).isEmpty()) return res.status(400).json({ success: false, error: 'Invalid request' });
    const user = await loadTarget(req, res);
    if (!user) return;
    const suspend = req.body.suspend === true || req.body.suspend === 'true';
    const reason = req.body.reason?.trim() || null;
    if (user.id === req.user.id) return res.status(400).json({ success: false, error: 'You can\'t suspend your own account' });
    if (user.is_super_admin) return res.status(403).json({ success: false, error: 'Super admin accounts can\'t be suspended' });
    if (suspend && !reason) return res.status(400).json({ success: false, error: 'Give a reason for suspending this account' });
    if (suspend === user.is_suspended) return res.status(400).json({ success: false, error: suspend ? 'Already suspended' : 'Not suspended' });

    await setActive(user, !suspend, { adminId: req.user.id, reason });
    pool.query(`INSERT INTO system_logs (user_id, level, service, message, metadata) VALUES ($1, $2, 'admin', $3, $4)`,
      [req.user.id, suspend ? 'warning' : 'info', suspend ? 'Account suspended' : 'Account reactivated', JSON.stringify({ targetUserId: user.id, email: user.email, reason })]).catch(() => {});
    logAdminAudit({
      userId: req.user.id, action: suspend ? 'SUSPEND_USER' : 'REACTIVATE_USER', targetId: user.id,
      oldValue: { is_suspended: user.is_suspended }, newValue: { is_suspended: suspend, reason }, ipAddress: req.ip
    });
    res.json({ success: true, message: suspend ? 'Account suspended' : 'Account reactivated' });
  } catch (err) {
    console.error('Super admin suspend error:', err);
    res.status(500).json({ success: false, error: 'Failed to update account status' });
  }
});

// ── Re-sync a user's plan/Stripe IDs from the phone line (DynamoDB) ──────────
router.post('/users/:id/resync', authenticateSuperAdmin, async (req, res) => {
  try {
    const user = await loadTarget(req, res);
    if (!user) return;
    const full = (await pool.query('SELECT phone, stripe_customer_id, stripe_subscription_id FROM users WHERE id = $1', [user.id])).rows[0];
    if (!full.phone) return res.status(400).json({ success: false, error: 'User has no phone number — cannot look up in IVR system' });

    const digits = full.phone.replace(/[^\d]/g, '');
    const normalizedPhone = digits.length === 10 ? `+1${digits}`
      : (digits.length === 11 && digits.startsWith('1')) || (digits.startsWith('234') && (digits.length === 12 || digits.length === 13)) ? `+${digits}`
      : (full.phone.startsWith('+') ? full.phone : `+${digits}`);

    let dynamoUser;
    try {
      dynamoUser = (await dynamodb.send(new GetCommand({ TableName: process.env.DYNAMO_USERS_TABLE || 'Users', Key: { userId: normalizedPhone } }))).Item;
    } catch (dynamoErr) {
      const isTimeout = dynamoErr.name === 'TimeoutError' || dynamoErr.message?.includes('timeout') || dynamoErr.code === 'ETIMEDOUT';
      console.error('DynamoDB lookup failed:', dynamoErr.message);
      return res.status(isTimeout ? 504 : 502).json({ success: false, error: isTimeout ? 'Phone line lookup timed out — try again in a moment' : 'Phone line lookup failed' });
    }
    if (!dynamoUser) return res.status(404).json({ success: false, error: `Not found in the phone line system for ${normalizedPhone}` });

    const tierMap = { LITE: 'LITE', ESSENTIAL: 'ESSENTIAL', PREMIUM: 'LEGACY_VAULT_PREMIUM', LEGACY_VAULT_PREMIUM: 'LEGACY_VAULT_PREMIUM' };
    const updates = { subscription_tier: tierMap[dynamoUser.subscription_tier] || user.subscription_tier || 'LITE' };
    if (dynamoUser.stripeCustomerId) updates.stripe_customer_id = dynamoUser.stripeCustomerId;
    if (dynamoUser.stripeSubscriptionId && dynamoUser.stripeSubscriptionId !== 'unsubscribed') updates.stripe_subscription_id = dynamoUser.stripeSubscriptionId;
    // The phone line's "verified" only controls phone sign-in, so it isn't copied. A lapsed Stripe
    // status becomes 'active' (on Lite) — any other value would lock them out of the app.
    if (dynamoUser.subscriptionStatus) {
      updates.subscription_status = ['active', 'trialing', 'past_due'].includes(dynamoUser.subscriptionStatus) ? dynamoUser.subscriptionStatus : 'active';
    }

    const keys = Object.keys(updates);
    await pool.query(
      `UPDATE users SET ${keys.map((k, i) => `${k} = $${i + 1}`).join(', ')}, updated_at = NOW() WHERE id = $${keys.length + 1}`,
      [...Object.values(updates), user.id]
    );
    const before = { tier: user.subscription_tier, stripeCustomerId: full.stripe_customer_id, stripeSubscriptionId: full.stripe_subscription_id };
    logAdminAudit({ userId: req.user.id, action: 'SUPER_RESYNC_USER', targetId: user.id, oldValue: before, newValue: updates, ipAddress: req.ip });
    res.json({ success: true, message: 'User synced from the phone line system', data: { syncedFields: keys, before, after: updates } });
  } catch (err) {
    console.error('Re-sync error:', { message: err.message, code: err.code, userId: req.params.id });
    res.status(500).json({ success: false, error: 'Re-sync failed' });
  }
});

// ── Sync dead letters (App → phone line items that failed every attempt) ─────
const EVENT_LABELS = {
  'sync-user': 'Account update', 'sync-slot': 'Memory slot', 'sync-will': 'Voice will',
  'delete-user': 'Account deletion', 'sync-credential': 'Login details',
};

router.get('/sync/dead-letters', authenticateSuperAdmin, async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT so.id, so.event_type, so.payload, so.attempts, so.last_attempt_at, so.error_message, so.created_at,
              u.id AS user_id, u.full_name AS user_name, u.email AS user_email
       FROM sync_outbox so
       LEFT JOIN users u ON u.id::text = so.payload->>'userId' OR u.phone = so.payload->>'userId'
       WHERE so.status = 'dead'
       ORDER BY so.created_at DESC
       LIMIT 200`
    );
    // The phone line's own failures (changes made on a call that never reached the app)
    let phoneLine = { items: [], error: null };
    try {
      const items = await phoneLineQueue.listDead();
      const phones = [...new Set(items.map(i => phoneKey(i.phone)).filter(Boolean))];
      const owners = phones.length ? (await pool.query(
        `SELECT id, full_name, email, phone FROM users WHERE deleted_at IS NULL AND phone IS NOT NULL`
      )).rows.filter(u => phones.includes(phoneKey(u.phone))) : [];
      phoneLine.items = items.map(i => {
        const owner = owners.find(u => phoneKey(u.phone) === phoneKey(i.phone));
        return { ...i, user_id: owner?.id || null, user_name: owner?.full_name || null, user_email: owner?.email || null };
      });
    } catch (err) {
      console.error('Phone-line queue read failed:', err.message);
      phoneLine.error = 'Could not read the phone line\'s failed items right now.';
    }
    res.json({
      success: true,
      data: {
        deadLetters: r.rows.map(d => ({ ...d, label: EVENT_LABELS[d.event_type] || d.event_type, editable: d.event_type === 'sync-slot' })),
        total: r.rows.length,
        phoneLine
      }
    });
  } catch (err) {
    console.error('Super admin dead letters error:', err);
    res.status(500).json({ success: false, error: 'Failed to fetch dead letters' });
  }
});

router.post('/sync/:id/retry', authenticateSuperAdmin, async (req, res) => {
  try {
    const r = await pool.query(
      `UPDATE sync_outbox SET status = 'pending', attempts = 0, error_message = NULL, last_attempt_at = NULL
       WHERE id::text = $1 AND status = 'dead' RETURNING id, event_type`,
      [req.params.id]
    );
    if (!r.rowCount) return res.status(404).json({ success: false, error: 'Not found, or no longer dead' });
    logAdminAudit({ userId: req.user.id, action: 'SYNC_RETRY', targetId: String(req.params.id), newValue: { event: r.rows[0].event_type }, ipAddress: req.ip });
    res.json({ success: true, message: 'Queued for retry' });
  } catch (err) {
    console.error('Super admin retry sync error:', err.message);
    res.status(500).json({ success: false, error: 'Failed to retry sync item' });
  }
});

// Edit is only offered for memory-slot items, whose payload shape is known
router.put('/sync/:id/edit-retry', authenticateSuperAdmin, async (req, res) => {
  try {
    const { userId, slotNumber, contact, voiceMessage } = req.body;
    if (!userId || !slotNumber || !voiceMessage) {
      return res.status(400).json({ success: false, error: 'Phone number, slot number and recording are required' });
    }
    const slotNum = parseInt(slotNumber, 10);
    if (isNaN(slotNum) || slotNum < 1 || slotNum > 15) return res.status(400).json({ success: false, error: 'Slot number must be between 1 and 15' });

    const current = (await pool.query('SELECT * FROM sync_outbox WHERE id::text = $1', [req.params.id])).rows[0];
    if (!current) return res.status(404).json({ success: false, error: 'Sync item not found' });
    if (current.event_type !== 'sync-slot') return res.status(400).json({ success: false, error: 'Only memory-slot items can be edited. Use Retry or Dismiss.' });
    if (current.status !== 'dead') return res.status(409).json({ success: false, error: 'This item is no longer dead' });

    const before = current.payload || {};
    const updatedPayload = {
      ...before, userId, slotNumber: String(slotNum), contact: contact || '', voiceMessage,
      action: before.action || 'create', source: before.source || 'app',
      _editedBySuperAdmin: true, _editedAt: new Date().toISOString(), _editedBy: req.user.id
    };
    await pool.query(
      `UPDATE sync_outbox SET payload = $1, status = 'pending', attempts = 0, error_message = NULL, last_attempt_at = NULL WHERE id = $2`,
      [JSON.stringify(updatedPayload), current.id]
    );
    logAdminAudit({ userId: req.user.id, action: 'SYNC_EDIT_RETRY', targetId: String(current.id), oldValue: before, newValue: updatedPayload, ipAddress: req.ip });
    res.json({ success: true, message: 'Updated and queued for retry', data: { updatedPayload } });
  } catch (err) {
    console.error('Super admin edit retry error:', err.message);
    res.status(500).json({ success: false, error: 'Failed to update sync item' });
  }
});

router.post('/sync/:id/dismiss', authenticateSuperAdmin, [
  body('reason').isString().trim().isLength({ min: 3, max: 1000 })
], async (req, res) => {
  try {
    if (!validationResult(req).isEmpty()) return res.status(400).json({ success: false, error: 'Give a reason for dismissing it' });
    const r = await pool.query(
      `UPDATE sync_outbox SET status = 'dismissed', resolved_note = $2, resolved_at = NOW(), resolved_by = $3
       WHERE id::text = $1 AND status = 'dead' RETURNING id, event_type`,
      [req.params.id, req.body.reason.trim(), req.user.id]
    );
    if (!r.rowCount) return res.status(404).json({ success: false, error: 'Not found, or no longer dead' });
    logAdminAudit({ userId: req.user.id, action: 'SYNC_DISMISS', targetId: String(req.params.id), newValue: { event: r.rows[0].event_type, reason: req.body.reason.trim() }, ipAddress: req.ip });
    res.json({ success: true, message: 'Dismissed' });
  } catch (err) {
    console.error('Super admin dismiss sync error:', err.message);
    res.status(500).json({ success: false, error: 'Failed to dismiss sync item' });
  }
});

// ── Phone line → app failures: retry / dismiss (needs dynamodb:UpdateItem on SyncOutbox) ──
const phoneLineAction = (fn, auditAction) => async (req, res) => {
  try {
    const reason = req.body?.reason?.trim();
    if (auditAction === 'PHONE_SYNC_DISMISS' && (!reason || reason.length < 3)) {
      return res.status(400).json({ success: false, error: 'Give a reason for dismissing it' });
    }
    await fn(req.params.id, reason, req.user.id);
    logAdminAudit({ userId: req.user.id, action: auditAction, targetId: String(req.params.id), newValue: reason ? { reason } : null, ipAddress: req.ip });
    res.json({ success: true, message: auditAction === 'PHONE_SYNC_RETRY' ? 'Queued: the phone line will send it again within about 2 minutes' : 'Dismissed' });
  } catch (err) {
    if (err.name === 'ConditionalCheckFailedException') return res.status(404).json({ success: false, error: 'Not found, or no longer failed' });
    if (phoneLineQueue.isAccessDenied(err)) {
      return res.status(403).json({ success: false, code: 'NEEDS_PERMISSION', error: 'The backend is not yet allowed to change the phone line\'s queue. Run the phase 5 permission script, then try again.' });
    }
    console.error('Phone-line queue action failed:', err.message);
    res.status(500).json({ success: false, error: 'Failed to update the phone line\'s queue' });
  }
};
router.post('/sync/phone-line/:id/retry', authenticateSuperAdmin,
  phoneLineAction((id, _reason, adminId) => phoneLineQueue.retry(id, adminId), 'PHONE_SYNC_RETRY'));
router.post('/sync/phone-line/:id/dismiss', authenticateSuperAdmin,
  phoneLineAction((id, reason, adminId) => phoneLineQueue.dismiss(id, reason, adminId), 'PHONE_SYNC_DISMISS'));

// ── Nightly app ↔ phone line comparison ──────────────────────────────────────
router.get('/sync/reconcile', authenticateSuperAdmin, async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT rr.id, rr.trigger, rr.started_at, rr.finished_at, rr.summary, rr.fixes, rr.issues, rr.error, u.full_name AS run_by_name
       FROM sync_reconcile_reports rr LEFT JOIN users u ON u.id = rr.run_by
       ORDER BY rr.started_at DESC LIMIT 10`
    );
    const [latest, ...history] = r.rows;
    res.json({ success: true, data: { latest: latest || null, history: history.map(({ fixes, issues, ...h }) => h) } });
  } catch (err) {
    if (err.code === '42P01') return res.json({ success: true, data: { latest: null, history: [], needsMigration: true } });
    console.error('Reconcile report read failed:', err.message);
    res.status(500).json({ success: false, error: 'Failed to load the nightly check' });
  }
});

router.post('/sync/reconcile/run', authenticateSuperAdmin, async (req, res) => {
  try {
    const { runReconcile } = require('../workers/syncReconciler');
    const report = await runReconcile({ trigger: 'manual', runBy: req.user.id });
    logAdminAudit({ userId: req.user.id, action: 'SYNC_RECONCILE_RUN', newValue: report.summary, ipAddress: req.ip });
    res.json({ success: true, data: report });
  } catch (err) {
    if (err.code === '42P01') return res.status(409).json({ success: false, error: 'Run database update 018 first.' });
    console.error('Manual reconcile failed:', err.message);
    res.status(500).json({ success: false, error: 'The check could not finish. Try again in a moment.' });
  }
});

// ── Overview (KPI cards) + activity ──────────────────────────────────────────
router.get('/overview', authenticateSuperAdmin, async (req, res) => {
  try {
    const [userStats, contentStats, syncStats, adminActions, userActivity] = await Promise.all([
      pool.query(`
        SELECT COUNT(*)::int AS total_users,
               COUNT(*) FILTER (WHERE COALESCE(subscription_tier, 'LITE') = 'LITE')::int AS lite_users,
               COUNT(*) FILTER (WHERE subscription_tier = 'ESSENTIAL')::int AS essential_users,
               COUNT(*) FILTER (WHERE subscription_tier IN ('LEGACY_VAULT_PREMIUM', 'PREMIUM'))::int AS premium_users,
               COUNT(*) FILTER (WHERE COALESCE(is_suspended, false))::int AS suspended_users,
               COUNT(*) FILTER (WHERE created_at >= NOW() - INTERVAL '7 days')::int AS new_this_week,
               COUNT(*) FILTER (WHERE COALESCE(last_active_at, last_login) >= NOW() - INTERVAL '24 hours')::int AS active_today
        FROM users WHERE deleted_at IS NULL AND COALESCE(is_admin, false) = false`),
      // Separate subqueries — joining notes and messages multiplied every number
      pool.query(`
        SELECT (SELECT COUNT(*)::int FROM voice_notes WHERE deleted_at IS NULL) AS total_voice_notes,
               (SELECT COALESCE(SUM(file_size_bytes), 0)::bigint FROM voice_notes WHERE deleted_at IS NULL) AS total_storage_bytes,
               (SELECT COUNT(*)::int FROM scheduled_messages) AS total_scheduled,
               (SELECT COUNT(*)::int FROM scheduled_messages WHERE delivery_status = 'delivered') AS total_delivered,
               (SELECT COUNT(*)::int FROM scheduled_messages WHERE delivery_status = 'failed') AS total_failed`),
      pool.query(`SELECT COUNT(*) FILTER (WHERE status = 'dead')::int AS dead_count,
                         COUNT(*) FILTER (WHERE status IN ('pending', 'failed'))::int AS pending_count,
                         COUNT(*) FILTER (WHERE status = 'sent')::int AS sent_count
                  FROM sync_outbox`),
      pool.query(`SELECT a.id, a.action, a.target_id, a.new_value, a.created_at, u.full_name AS admin_name, u.email AS admin_email,
                         t.full_name AS target_name, t.email AS target_email
                  FROM admin_audit_log a
                  LEFT JOIN users u ON u.id = a.admin_user_id
                  LEFT JOIN users t ON t.id::text = a.target_id
                  ORDER BY a.created_at DESC LIMIT 30`),
      pool.query(`SELECT ae.event_type, ae.created_at, u.id AS user_id, u.full_name, u.email
                  FROM analytics_events ae JOIN users u ON ae.user_id = u.id
                  ORDER BY ae.created_at DESC LIMIT 30`),
    ]);
    let phoneLineDead = null;
    try { phoneLineDead = (await phoneLineQueue.counts()).byStatus.dead || 0; } catch { /* shown as unknown */ }
    res.json({
      success: true,
      data: {
        users: userStats.rows[0],
        content: { ...contentStats.rows[0], total_storage_bytes: Number(contentStats.rows[0].total_storage_bytes) },
        sync: { ...syncStats.rows[0], phone_line_dead: phoneLineDead },
        adminActions: adminActions.rows,
        recentActivity: userActivity.rows
      }
    });
  } catch (err) {
    console.error('Super admin overview error:', err);
    res.status(500).json({ success: false, error: 'Failed to fetch overview' });
  }
});

// ── Revenue (Stripe, like the dashboard) ─────────────────────────────────────
router.get('/revenue', authenticateSuperAdmin, async (req, res) => {
  try {
    const { getRevenueStats } = require('../utils/revenueStats');
    const [revenue, paying, totals, recent] = await Promise.all([
      getRevenueStats(),
      pool.query(`
        SELECT COALESCE(u.subscription_tier, 'LITE') AS tier,
               COUNT(*) FILTER (WHERE u.deleted_at IS NULL AND COALESCE(u.is_admin, false) = false)::int AS users,
               COUNT(*) FILTER (WHERE u.deleted_at IS NULL AND ${STRIPE_MANAGED})::int AS paying
        FROM users u GROUP BY 1`),
      pool.query(`
        SELECT COALESCE(SUM(amount_cents) FILTER (WHERE status IN ('paid', 'succeeded')), 0)::bigint AS total_cents,
               COUNT(*) FILTER (WHERE status IN ('paid', 'succeeded'))::int AS paid_count,
               COUNT(*) FILTER (WHERE status = 'failed' AND created_at >= NOW() - INTERVAL '30 days')::int AS failed_30d
        FROM billing_history`),
      pool.query(`
        SELECT bh.id, bh.amount_cents, bh.currency, bh.status, bh.description, bh.created_at, u.id AS user_id, u.full_name, u.email
        FROM billing_history bh JOIN users u ON bh.user_id = u.id
        WHERE bh.status IN ('paid', 'succeeded', 'failed')
        ORDER BY bh.created_at DESC LIMIT 20`),
    ]);
    const price = { LITE: TIER_LIMITS.LITE.price, ESSENTIAL: TIER_LIMITS.ESSENTIAL.price, LEGACY_VAULT_PREMIUM: TIER_LIMITS.LEGACY_VAULT_PREMIUM.price, PREMIUM: TIER_LIMITS.LEGACY_VAULT_PREMIUM.price };
    const byTier = paying.rows.map(t => ({ ...t, estimatedMrr: Math.round(t.paying * (price[t.tier] || 0) * 100) / 100 }));
    const mrr = Math.round(byTier.reduce((s, t) => s + t.estimatedMrr, 0) * 100) / 100;
    res.json({
      success: true,
      data: {
        source: revenue.source,
        thisMonth: revenue.current_month_revenue,
        lastMonth: revenue.last_month_revenue,
        monthly: revenue.monthly,
        estimatedMrr: mrr,
        estimatedArr: Math.round(mrr * 12 * 100) / 100,
        payingUsers: byTier.reduce((s, t) => s + t.paying, 0),
        byTier,
        recordedTotal: Number(totals.rows[0].total_cents) / 100,
        failedPayments30d: totals.rows[0].failed_30d,
        recentTransactions: recent.rows,
      }
    });
  } catch (err) {
    console.error('Revenue endpoint error:', { message: err.message, code: err.code });
    res.status(500).json({ success: false, error: 'Failed to fetch revenue data' });
  }
});

// ── Sync monitor ─────────────────────────────────────────────────────────────
router.get('/sync-health', authenticateSuperAdmin, async (req, res) => {
  try {
    const ts = await receivedTs();
    const [byStatus, byEvent, failures, last, received, lastReceived] = await Promise.all([
      pool.query(`SELECT status, COUNT(*)::int AS count FROM sync_outbox GROUP BY status`),
      pool.query(`SELECT event_type, status, COUNT(*)::int AS count FROM sync_outbox GROUP BY event_type, status`),
      pool.query(`SELECT id, event_type, status, attempts, error_message, last_attempt_at, created_at FROM sync_outbox
                  WHERE status IN ('failed', 'dead') ORDER BY last_attempt_at DESC NULLS LAST LIMIT 10`),
      pool.query(`SELECT MAX(sent_at) FILTER (WHERE status = 'sent') AS last_success,
                         COUNT(*) FILTER (WHERE status = 'sent' AND sent_at >= NOW() - INTERVAL '7 days')::int AS sent_7d
                  FROM sync_outbox`),
      ts ? pool.query(`SELECT event_type, COUNT(*)::int AS total, COUNT(*) FILTER (WHERE ${ts} >= NOW() - INTERVAL '7 days')::int AS last_7_days
                  FROM sync_received_log GROUP BY event_type ORDER BY total DESC`) : { rows: [] },
      ts ? pool.query(`SELECT MAX(${ts}) AS at FROM sync_received_log`) : { rows: [{}] },
    ]);
    const stats = Object.fromEntries(byStatus.rows.map(r => [r.status, r.count]));
    const events = {};
    for (const r of byEvent.rows) {
      events[r.event_type] = events[r.event_type] || { label: EVENT_LABELS[r.event_type] || r.event_type, sent: 0, pending: 0, dead: 0, dismissed: 0 };
      const key = r.status === 'failed' ? 'pending' : r.status;
      events[r.event_type][key] = (events[r.event_type][key] || 0) + r.count;
    }
    const delivered = stats.sent || 0;
    const finished = delivered + (stats.dead || 0);
    // The phone line's own queue (phone line → app); read-only, so a failure here doesn't break the page
    let queue = null;
    try {
      const c = await phoneLineQueue.counts();
      queue = { sent: c.byStatus.sent || 0, pending: (c.byStatus.pending || 0) + (c.byStatus.failed || 0), dead: c.byStatus.dead || 0, dismissed: c.byStatus.dismissed || 0, byEvent: c.byEvent };
    } catch (err) {
      console.warn('Phone-line queue counts failed:', err.message);
    }
    res.json({
      success: true,
      data: {
        appToIvr: {
          sent: delivered, pending: (stats.pending || 0) + (stats.failed || 0), dead: stats.dead || 0, dismissed: stats.dismissed || 0,
          // Nothing to update on the phone line (e.g. a website-only customer); not a failure
          skipped: stats.skipped || 0,
          successRate: finished ? Math.round((delivered / finished) * 1000) / 10 : null,
          sent7d: last.rows[0].sent_7d, lastSuccess: last.rows[0].last_success, byEvent: events, recentFailures: failures.rows
        },
        ivrToApp: {
          breakdown: received.rows.map(r => ({ ...r, label: r.event_type.replace(/_/g, ' ') })),
          lastReceived: lastReceived.rows[0]?.at || null,
          queue
        }
      }
    });
  } catch (err) {
    console.error('Sync health endpoint error:', { message: err.message, code: err.code });
    res.status(500).json({ success: false, error: 'Failed to fetch sync health' });
  }
});

// ── System health: live service checks + scheduler queue + sync backlog ──────
router.get('/system-health', authenticateSuperAdmin, async (req, res) => {
  try {
    const { getSystemHealth } = require('../utils/systemHealth');
    const [health, scheduler, sync, db] = await Promise.all([
      getSystemHealth({ force: req.query.refresh === '1' }),
      pool.query(`
        SELECT COUNT(*) FILTER (WHERE delivery_status = 'scheduled' AND COALESCE(metadata->>'source', 'app') <> 'ivr')::int AS waiting,
               COUNT(*) FILTER (WHERE delivery_status = 'scheduled' AND scheduled_for <= NOW() AND COALESCE(metadata->>'source', 'app') <> 'ivr')::int AS overdue,
               COUNT(*) FILTER (WHERE delivery_status = 'delivered' AND delivered_at >= NOW() - INTERVAL '24 hours')::int AS delivered_24h,
               COUNT(*) FILTER (WHERE delivery_status = 'failed')::int AS failed
        FROM scheduled_messages`),
      pool.query(`SELECT COUNT(*) FILTER (WHERE status IN ('pending', 'failed'))::int AS pending, COUNT(*) FILTER (WHERE status = 'dead')::int AS dead FROM sync_outbox`),
      pool.query(`SELECT version() AS version, pg_database_size(current_database())::bigint AS size_bytes`),
    ]);
    res.json({
      success: true,
      data: {
        services: health.services,
        overall: health.overall,
        checkedAt: health.checkedAt,
        scheduler: scheduler.rows[0],
        sync: sync.rows[0],
        database: { version: db.rows[0].version.split(' ').slice(0, 2).join(' '), sizeBytes: Number(db.rows[0].size_bytes) },
        uptimeSeconds: Math.round(process.uptime()),
      }
    });
  } catch (err) {
    console.error('System health endpoint error:', { message: err.message, code: err.code });
    res.status(500).json({ success: false, error: 'Failed to fetch system health' });
  }
});

module.exports = router;
