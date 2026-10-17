// Admin system logs — list, summary, details, export and retention-based cleanup.
// Individual log entries can't be deleted: logs are the record of what happened.
// Mounted at /api/admin before routes/admin.js.
const express = require('express');
const router = express.Router();
const { authenticateAdmin } = require('../middleware/auth');
const { pool } = require('../config/database');

// Retention policy for "Clear old logs" — change here if the policy changes
const RETENTION = {
  routineDays: 365,        // info/debug logs from non-security services
  importantDays: 3 * 365,  // warnings, errors and every security-related event
};
// Services whose events count as security-related (kept for importantDays whatever their level)
const SECURITY_SERVICES = ['auth', 'security', 'admin', 'settings', 'wills', 'account'];

const isUuid = (v) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(v));

async function logAdminAudit({ userId, action, newValue = null, ipAddress = null }) {
  try {
    await pool.query(
      `INSERT INTO admin_audit_log (admin_user_id, action, new_value, ip_address) VALUES ($1, $2, $3, $4)`,
      [userId, action, newValue ? JSON.stringify(newValue) : null, ipAddress]
    );
  } catch (err) {
    console.warn('Admin audit log failed (non-fatal):', err.message);
  }
}

// Filters shared by list, summary and export. skipLevel: the summary counts every level itself.
function buildFilters(query, { skipLevel = false } = {}) {
  const where = ['1=1'];
  const params = [];
  const add = (sql, value) => { params.push(value); where.push(sql.replace(/\?/g, `$${params.length}`)); };

  const start = query.startDate ? new Date(query.startDate) : null;
  const end = query.endDate ? new Date(query.endDate) : null;
  if (start && !isNaN(start)) add('sl.created_at >= ?', start);
  if (end && !isNaN(end)) add('sl.created_at <= ?', end);

  if (!skipLevel) {
    // 'warning' and 'warn' are both used across the app
    if (query.level === 'warning') where.push(`sl.level IN ('warn', 'warning')`);
    else if (['error', 'info', 'debug'].includes(query.level)) add('sl.level = ?', query.level);
  }
  if (query.category === 'security') add('sl.service = ANY(?::text[])', SECURITY_SERVICES);
  if (query.service && query.service !== 'all') add('sl.service = ?', String(query.service));
  if (query.search && String(query.search).trim()) {
    add(`(sl.message ILIKE ? OR sl.service ILIKE ? OR u.email ILIKE ? OR sl.ip_address::text ILIKE ?)`, `%${String(query.search).trim()}%`);
  }
  return { whereSql: `WHERE ${where.join(' AND ')}`, params };
}

const FROM = `FROM system_logs sl LEFT JOIN users u ON u.id = sl.user_id`;
const COLUMNS = `sl.id, CASE WHEN sl.level = 'warn' THEN 'warning' ELSE sl.level END AS level, sl.service, sl.message,
                 sl.metadata, sl.ip_address::text AS ip_address, sl.user_agent, sl.created_at,
                 sl.user_id, u.email AS user_email, u.full_name AS user_name`;

// ── Summary: counts for the whole filtered range + table size + retention ──
router.get('/logs/summary', authenticateAdmin, async (req, res) => {
  try {
    const { whereSql, params } = buildFilters(req.query, { skipLevel: true });
    const [counts, table, clearable] = await Promise.all([
      pool.query(
        `SELECT COUNT(*)::int AS total,
                COUNT(*) FILTER (WHERE sl.level = 'error')::int AS error,
                COUNT(*) FILTER (WHERE sl.level IN ('warn', 'warning'))::int AS warning,
                COUNT(*) FILTER (WHERE sl.level = 'info')::int AS info,
                COUNT(*) FILTER (WHERE sl.service = ANY($${params.length + 1}::text[]))::int AS security
         ${FROM} ${whereSql}`,
        [...params, SECURITY_SERVICES]
      ),
      pool.query(`SELECT pg_total_relation_size('system_logs')::bigint AS bytes,
                         (SELECT COUNT(*)::int FROM system_logs) AS rows,
                         (SELECT MIN(created_at) FROM system_logs) AS oldest`),
      pool.query(clearableSql('COUNT(*)::int AS count'), [RETENTION.routineDays, RETENTION.importantDays, SECURITY_SERVICES]),
    ]);
    res.json({
      success: true,
      data: {
        counts: counts.rows[0],
        table: { bytes: Number(table.rows[0].bytes), rows: table.rows[0].rows, oldest: table.rows[0].oldest },
        retention: { ...RETENTION, securityServices: SECURITY_SERVICES, clearableNow: clearable.rows[0].count },
      }
    });
  } catch (error) {
    console.error('Log summary error:', error);
    res.status(500).json({ success: false, error: 'Failed to load log summary' });
  }
});

// Logs past the retention policy: routine logs older than routineDays, anything older than importantDays
function clearableSql(select) {
  return `SELECT ${select} FROM system_logs
          WHERE (created_at < NOW() - make_interval(days => $1::int)
                 AND level IN ('info', 'debug') AND NOT (service = ANY($3::text[])))
             OR created_at < NOW() - make_interval(days => $2::int)`;
}

router.get('/logs/services', authenticateAdmin, async (req, res) => {
  try {
    const r = await pool.query(`SELECT DISTINCT service FROM system_logs WHERE service IS NOT NULL ORDER BY service`);
    res.json({ success: true, data: r.rows.map(x => x.service) });
  } catch (error) {
    res.status(500).json({ success: false, error: 'Failed to load services' });
  }
});

// ── List ─────────────────────────────────────────────────────────────────────
router.get('/logs', authenticateAdmin, async (req, res) => {
  try {
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 200);
    const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
    const { whereSql, params } = buildFilters(req.query);
    const [rows, count] = await Promise.all([
      pool.query(`SELECT ${COLUMNS} ${FROM} ${whereSql} ORDER BY sl.created_at DESC LIMIT ${limit} OFFSET ${(page - 1) * limit}`, params),
      pool.query(`SELECT COUNT(*)::int AS total ${FROM} ${whereSql}`, params),
    ]);
    const total = count.rows[0].total;
    res.json({
      success: true,
      data: { logs: rows.rows, pagination: { page, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)) } }
    });
  } catch (error) {
    console.error('Get system logs error:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch system logs' });
  }
});

// ── Export (before /logs/:id) ────────────────────────────────────────────────
const csvCell = (value) => {
  let text = value === null || value === undefined ? '' : (typeof value === 'object' ? JSON.stringify(value) : String(value));
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
};

router.get('/logs/export', authenticateAdmin, async (req, res) => {
  try {
    const format = req.query.format === 'json' ? 'json' : 'csv';
    const { whereSql, params } = buildFilters(req.query);
    const result = await pool.query(`SELECT ${COLUMNS} ${FROM} ${whereSql} ORDER BY sl.created_at DESC LIMIT 100000`, params);
    const rows = result.rows.map(l => ({
      'Time (UTC)': new Date(l.created_at).toISOString().replace('T', ' ').slice(0, 19),
      'Level': l.level,
      'Service': l.service,
      'Message': l.message,
      'User': l.user_email || '',
      'IP address': l.ip_address || '',
      'Device': l.user_agent || '',
      'Details': l.metadata && Object.keys(l.metadata).length ? l.metadata : '',
      'Log ID': l.id,
    }));
    logAdminAudit({ userId: req.user.id, action: 'EXPORT_LOGS', newValue: { format, count: rows.length, filters: req.query }, ipAddress: req.ip });
    const stamp = new Date().toISOString().slice(0, 10);
    if (format === 'json') {
      res.setHeader('Content-Disposition', `attachment; filename="suretalk-logs-${stamp}.json"`);
      return res.json({ exportedAt: new Date().toISOString(), count: rows.length, logs: rows });
    }
    const headers = Object.keys(rows[0] || { 'Time (UTC)': '' });
    const csv = [headers.map(csvCell).join(','), ...rows.map(r => headers.map(h => csvCell(r[h])).join(','))].join('\r\n');
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="suretalk-logs-${stamp}.csv"`);
    res.send('﻿' + csv);
  } catch (error) {
    console.error('Export logs error:', error);
    res.status(500).json({ success: false, error: 'Failed to export logs' });
  }
});

// ── Clear logs past the retention policy ─────────────────────────────────────
router.post('/logs/clear-old', authenticateAdmin, async (req, res) => {
  try {
    const result = await pool.query(
      `DELETE FROM system_logs WHERE id IN (${clearableSql('id')})`,
      [RETENTION.routineDays, RETENTION.importantDays, SECURITY_SERVICES]
    );
    const deleted = result.rowCount || 0;
    await pool.query(
      `INSERT INTO system_logs (user_id, level, service, message, metadata) VALUES ($1, 'warning', 'admin', 'Old logs cleared', $2)`,
      [req.user.id, JSON.stringify({ deleted, ...RETENTION })]
    ).catch(() => {});
    logAdminAudit({ userId: req.user.id, action: 'CLEAR_OLD_LOGS', newValue: { deleted, ...RETENTION }, ipAddress: req.ip });
    res.json({ success: true, data: { deleted } });
  } catch (error) {
    console.error('Clear logs error:', error);
    res.status(500).json({ success: false, error: 'Failed to clear old logs' });
  }
});

// ── Details ──────────────────────────────────────────────────────────────────
router.get('/logs/:id', authenticateAdmin, async (req, res) => {
  try {
    if (!isUuid(req.params.id)) return res.status(404).json({ success: false, error: 'Log not found' });
    const r = await pool.query(`SELECT ${COLUMNS} ${FROM} WHERE sl.id = $1`, [req.params.id]);
    if (!r.rows.length) return res.status(404).json({ success: false, error: 'Log not found' });
    res.json({ success: true, data: r.rows[0] });
  } catch (error) {
    console.error('Get log error:', error);
    res.status(500).json({ success: false, error: 'Failed to load log' });
  }
});

module.exports = router;
