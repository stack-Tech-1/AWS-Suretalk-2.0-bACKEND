// Admin access requests — any admin can view; only super admins can approve, reject or delete.
// Needs migration 015_admin_requests.sql. Mounted at /api/admin before routes/admin.js.
const express = require('express');
const router = express.Router();
const { body, validationResult } = require('express-validator');
const { authenticateAdmin } = require('../middleware/auth');
const { pool } = require('../config/database');
const emailService = require('../utils/emailService');

const isUuid = (v) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(v));
// People who applied through /admin/register (current flow) or the old flow
const APPLICANT = `u.admin_status IN ('pending', 'approved', 'rejected') AND u.deleted_at IS NULL`;

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

const isSuperAdmin = async (userId) =>
  !!(await pool.query('SELECT is_super_admin FROM users WHERE id = $1', [userId])).rows[0]?.is_super_admin;

const requireSuperAdmin = async (req, res, next) => {
  try {
    if (await isSuperAdmin(req.user.id)) return next();
    return res.status(403).json({ success: false, code: 'SUPER_ADMIN_REQUIRED', error: 'Only super admins can approve or reject admin requests.' });
  } catch (err) {
    return res.status(500).json({ success: false, error: 'Could not check your permissions' });
  }
};

// ── Stats ────────────────────────────────────────────────────────────────────
router.get('/requests/stats', authenticateAdmin, async (req, res) => {
  try {
    const r = await pool.query(`
      SELECT COUNT(*)::int AS total,
             COUNT(*) FILTER (WHERE u.admin_status = 'pending')::int AS pending,
             COUNT(*) FILTER (WHERE u.admin_status = 'approved')::int AS approved,
             COUNT(*) FILTER (WHERE u.admin_status = 'rejected')::int AS rejected,
             AVG(EXTRACT(EPOCH FROM (COALESCE(u.approved_at, u.rejected_at) - u.created_at)) / 3600)
               FILTER (WHERE COALESCE(u.approved_at, u.rejected_at) IS NOT NULL) AS avg_hours
      FROM users u WHERE ${APPLICANT}`);
    const s = r.rows[0];
    const decided = s.approved + s.rejected;
    res.json({
      success: true,
      data: {
        total: s.total, pending: s.pending, approved: s.approved, rejected: s.rejected,
        approvalRate: decided ? Math.round((s.approved / decided) * 100) : null,
        avgResponseHours: s.avg_hours === null ? null : Math.round(Number(s.avg_hours) * 10) / 10,
        canDecide: await isSuperAdmin(req.user.id),
      }
    });
  } catch (error) {
    console.error('Admin request stats error:', error);
    res.status(500).json({ success: false, error: 'Failed to load request stats' });
  }
});

// ── List ─────────────────────────────────────────────────────────────────────
router.get('/requests', authenticateAdmin, async (req, res) => {
  try {
    const params = [];
    const where = [APPLICANT];
    if (['pending', 'approved', 'rejected'].includes(req.query.status)) {
      params.push(req.query.status);
      where.push(`u.admin_status = $${params.length}`);
    }
    if (req.query.search && String(req.query.search).trim()) {
      params.push(`%${String(req.query.search).trim()}%`);
      where.push(`(u.full_name ILIKE $${params.length} OR u.email ILIKE $${params.length} OR u.phone ILIKE $${params.length} OR u.admin_department ILIKE $${params.length})`);
    }
    const r = await pool.query(
      `SELECT u.id, u.full_name, u.email, u.phone, u.admin_status AS status, u.admin_reason AS reason,
              u.admin_department AS department, u.created_at, u.approved_at, u.rejected_at, u.rejection_notes,
              COALESCE(u.is_super_admin, false) AS is_super_admin,
              a.full_name AS approved_by_name, a.email AS approved_by_email,
              rj.full_name AS rejected_by_name, rj.email AS rejected_by_email
       FROM users u
       LEFT JOIN users a ON a.id = u.approved_by_admin_id
       LEFT JOIN users rj ON rj.id = u.rejected_by_admin_id
       WHERE ${where.join(' AND ')}
       ORDER BY (u.admin_status = 'pending') DESC, u.created_at DESC
       LIMIT 500`,
      params
    );
    res.json({ success: true, data: { requests: r.rows } });
  } catch (error) {
    console.error('Get admin requests error:', error);
    res.status(500).json({ success: false, error: 'Failed to load admin requests' });
  }
});

async function loadApplicant(req, res) {
  if (!isUuid(req.params.id)) { res.status(404).json({ success: false, error: 'Request not found' }); return null; }
  const r = await pool.query(`SELECT u.id, u.email, u.full_name, u.admin_status, COALESCE(u.is_super_admin, false) AS is_super_admin FROM users u WHERE u.id = $1 AND ${APPLICANT}`, [req.params.id]);
  if (!r.rows.length) { res.status(404).json({ success: false, error: 'Request not found' }); return null; }
  return r.rows[0];
}

// ── Approve ──────────────────────────────────────────────────────────────────
router.post('/requests/:id/approve', authenticateAdmin, requireSuperAdmin, async (req, res) => {
  try {
    const a = await loadApplicant(req, res);
    if (!a) return;
    const updated = await pool.query(
      `UPDATE users SET is_admin = true, admin_status = 'approved', approved_by_admin_id = $1, approved_at = NOW(),
              rejected_by_admin_id = NULL, rejected_at = NULL, rejection_notes = NULL,
              subscription_status = 'active', updated_at = NOW()
       WHERE id = $2 AND admin_status = 'pending' RETURNING id`,
      [req.user.id, a.id]
    );
    if (!updated.rowCount) return res.status(409).json({ success: false, error: `This request is already ${a.admin_status}` });

    emailService.sendAdminRequestDecision(a.email, a.full_name, { approved: true })
      .catch(err => console.error('Admin approval email failed:', err.message));
    pool.query(`INSERT INTO system_logs (user_id, level, service, message, metadata) VALUES ($1, 'warning', 'admin', 'Admin access approved', $2)`,
      [req.user.id, JSON.stringify({ approvedUserId: a.id, email: a.email })]).catch(() => {});
    logAdminAudit({ userId: req.user.id, action: 'APPROVE_ADMIN_REQUEST', targetId: a.id, oldValue: { admin_status: 'pending' }, newValue: { admin_status: 'approved', email: a.email }, ipAddress: req.ip });
    res.json({ success: true });
  } catch (error) {
    console.error('Approve admin request error:', error);
    res.status(500).json({ success: false, error: 'Failed to approve request' });
  }
});

// ── Reject ───────────────────────────────────────────────────────────────────
router.post('/requests/:id/reject', authenticateAdmin, requireSuperAdmin, [
  body('reason').optional({ nullable: true }).isString().isLength({ max: 1000 })
], async (req, res) => {
  try {
    if (!validationResult(req).isEmpty()) return res.status(400).json({ success: false, error: 'Reason is too long' });
    const a = await loadApplicant(req, res);
    if (!a) return;
    const reason = req.body.reason?.trim() || null;
    const updated = await pool.query(
      `UPDATE users SET admin_status = 'rejected', rejected_by_admin_id = $1, rejected_at = NOW(), rejection_notes = $2, updated_at = NOW()
       WHERE id = $3 AND admin_status = 'pending' RETURNING id`,
      [req.user.id, reason, a.id]
    );
    if (!updated.rowCount) return res.status(409).json({ success: false, error: `This request is already ${a.admin_status}` });

    emailService.sendAdminRequestDecision(a.email, a.full_name, { approved: false, reason })
      .catch(err => console.error('Admin rejection email failed:', err.message));
    logAdminAudit({ userId: req.user.id, action: 'REJECT_ADMIN_REQUEST', targetId: a.id, oldValue: { admin_status: 'pending' }, newValue: { admin_status: 'rejected', reason, email: a.email }, ipAddress: req.ip });
    res.json({ success: true });
  } catch (error) {
    console.error('Reject admin request error:', error);
    res.status(500).json({ success: false, error: 'Failed to reject request' });
  }
});

// ── Delete an application (pending or rejected only) so the email can be used again ──
router.delete('/requests/:id', authenticateAdmin, requireSuperAdmin, async (req, res) => {
  const client = await pool.connect();
  try {
    const a = await loadApplicant(req, res);
    if (!a) return;
    if (a.admin_status === 'approved') return res.status(400).json({ success: false, error: 'Approved admins can\'t be deleted here.' });
    await client.query('BEGIN');
    // Detach log/audit references so the applicant row can go; the audit entry below keeps the record
    await client.query('UPDATE system_logs SET user_id = NULL WHERE user_id = $1', [a.id]);
    const del = await client.query(`DELETE FROM users WHERE id = $1 AND admin_status IN ('pending', 'rejected') AND COALESCE(is_super_admin, false) = false`, [a.id]);
    await client.query('COMMIT');
    if (!del.rowCount) return res.status(409).json({ success: false, error: 'This application changed. Refresh and try again.' });
    logAdminAudit({ userId: req.user.id, action: 'DELETE_ADMIN_REQUEST', targetId: a.id, oldValue: { email: a.email, admin_status: a.admin_status }, ipAddress: req.ip });
    res.json({ success: true });
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('Delete admin request error:', error);
    res.status(500).json({ success: false, error: 'Failed to delete application' });
  } finally {
    client.release();
  }
});

module.exports = router;
