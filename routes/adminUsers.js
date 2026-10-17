// Admin user management — list, stats, export, details, activity, edit, deactivate/reactivate,
// password reset, delete (soft, same as self-delete) and bulk actions.
// Mounted at /api/admin before routes/admin.js.
const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const { body, validationResult } = require('express-validator');
const { authenticateAdmin } = require('../middleware/auth');
const { pool } = require('../config/database');
const { syncToIvr } = require('../utils/syncIvr');
const { ivrTierName } = require('../utils/tierMapping');
const emailService = require('../utils/emailService');

const stripe = process.env.STRIPE_SECRET_KEY ? require('stripe')(process.env.STRIPE_SECRET_KEY) : null;

const TIERS = ['LITE', 'ESSENTIAL', 'LEGACY_VAULT_PREMIUM'];
// Same limits Stripe checkout and the webhook apply (routes/billing.js, routes/stripeWebhook.js)
const TIER_LIMITS = {
  LITE:                 { storageGb: 1,  contacts: 3,  voiceNotes: 3,   price: 0 },
  ESSENTIAL:            { storageGb: 5,  contacts: 9,  voiceNotes: 100, price: 4.99 },
  LEGACY_VAULT_PREMIUM: { storageGb: 50, contacts: 25, voiceNotes: 500, price: 9.99 },
};
const ACTIVE_STATUSES = ['active', 'trialing', 'past_due']; // statuses middleware/auth.js lets in

// Paying through Stripe — plan changes must go through Stripe or the next renewal undoes them
const STRIPE_MANAGED = `(u.stripe_subscription_id IS NOT NULL AND u.subscription_status IN ('active', 'trialing', 'past_due'))`;

// Customers only by default: admin accounts and admin-access applicants are listed under "Admins"
const CUSTOMER_FILTER = `COALESCE(u.is_admin, false) = false AND COALESCE(u.admin_status, 'none') NOT IN ('pending', 'rejected')`;

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
  `INSERT INTO system_logs (user_id, level, service, message, metadata) VALUES ($1, $2, 'admin', $3, $4)`,
  [adminId, level, message, JSON.stringify(metadata)]
).catch(err => console.error('system_log write failed:', err.message));

const isUuid = (v) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(v));

// WHERE clause shared by the list and the export
function buildUserFilters(query) {
  const where = ['u.deleted_at IS NULL'];
  const params = [];
  const add = (sql, value) => { params.push(value); where.push(sql.replace('?', `$${params.length}`)); };

  if (query.type === 'admins') where.push(`(COALESCE(u.is_admin, false) = true OR u.admin_status IN ('pending', 'rejected'))`);
  else where.push(CUSTOMER_FILTER);

  if (query.search && String(query.search).trim()) {
    const term = `%${String(query.search).trim()}%`;
    params.push(term);
    where.push(`(u.email ILIKE $${params.length} OR u.phone ILIKE $${params.length} OR u.full_name ILIKE $${params.length})`);
  }
  if (TIERS.includes(query.tier)) add('u.subscription_tier = ?', query.tier);
  if (query.tier === 'LEGACY_VAULT_PREMIUM') {
    // older rows may store 'PREMIUM'
    where[where.length - 1] = `u.subscription_tier IN ($${params.length}, 'PREMIUM')`;
  }
  if (query.status === 'active') where.push(`u.subscription_status IN ('active', 'trialing', 'past_due')`);
  if (query.status === 'inactive') where.push(`COALESCE(u.subscription_status, 'inactive') NOT IN ('active', 'trialing', 'past_due')`);
  if (query.status === 'paying') where.push(STRIPE_MANAGED);

  return { whereSql: `WHERE ${where.join(' AND ')}`, params };
}

// ── KPIs for the users page ──────────────────────────────────────────────────
router.get('/users/stats', authenticateAdmin, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT
        COUNT(*)::int AS total_users,
        COUNT(*) FILTER (WHERE u.created_at >= NOW() - INTERVAL '30 days')::int AS new_users_30d,
        COUNT(*) FILTER (WHERE u.subscription_tier IN ('LEGACY_VAULT_PREMIUM', 'PREMIUM'))::int AS premium_users,
        COUNT(*) FILTER (WHERE ${STRIPE_MANAGED} AND u.subscription_tier = 'ESSENTIAL')::int AS paying_essential,
        COUNT(*) FILTER (WHERE ${STRIPE_MANAGED} AND u.subscription_tier IN ('LEGACY_VAULT_PREMIUM', 'PREMIUM'))::int AS paying_premium,
        COUNT(*) FILTER (WHERE COALESCE(u.last_active_at, u.last_login) >= NOW() - INTERVAL '24 hours')::int AS active_today,
        COUNT(*) FILTER (WHERE COALESCE(u.subscription_status, 'inactive') NOT IN ('active', 'trialing', 'past_due'))::int AS inactive_users
      FROM users u
      WHERE u.deleted_at IS NULL AND ${CUSTOMER_FILTER}
    `);
    const s = result.rows[0];
    res.json({
      success: true,
      data: {
        ...s,
        paying_users: s.paying_essential + s.paying_premium,
        // Estimate at list prices — discounts, trials and annual plans aren't reflected
        estimated_mrr: Math.round((s.paying_essential * TIER_LIMITS.ESSENTIAL.price + s.paying_premium * TIER_LIMITS.LEGACY_VAULT_PREMIUM.price) * 100) / 100
      }
    });
  } catch (error) {
    console.error('Get user stats error:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch user stats' });
  }
});

// ── List ─────────────────────────────────────────────────────────────────────
router.get('/users', authenticateAdmin, async (req, res) => {
  try {
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 25, 1), 100);
    const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
    const { whereSql, params } = buildUserFilters(req.query);

    const result = await pool.query(
      `SELECT u.id, u.email, u.phone, u.full_name, u.subscription_tier, u.subscription_status,
              u.created_at, u.last_login, COALESCE(u.last_active_at, u.last_login) AS last_active,
              u.is_admin, u.admin_status, ${STRIPE_MANAGED} AS stripe_managed,
              (SELECT COUNT(*)::int FROM voice_notes vn WHERE vn.user_id = u.id AND vn.deleted_at IS NULL) AS note_count,
              (SELECT COUNT(*)::int FROM contacts c WHERE c.user_id = u.id) AS contact_count,
              COUNT(*) OVER()::int AS total_count
       FROM users u
       ${whereSql}
       ORDER BY u.created_at DESC
       LIMIT ${limit} OFFSET ${(page - 1) * limit}`,
      params
    );

    let total = result.rows[0]?.total_count;
    if (total === undefined) {
      // Past the last page: still report the real total
      total = (await pool.query(`SELECT COUNT(*)::int AS count FROM users u ${whereSql}`, params)).rows[0].count;
    }

    res.json({
      success: true,
      data: {
        users: result.rows.map(({ total_count, ...u }) => u),
        pagination: { page, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)) }
      }
    });
  } catch (error) {
    console.error('Get admin users error:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch users' });
  }
});

// ── Export (registered before /users/:id so "export" isn't read as an ID) ──────
const csvCell = (value) => {
  let text = value === null || value === undefined ? '' : String(value);
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`; // stop spreadsheets running it as a formula
  return `"${text.replace(/"/g, '""')}"`;
};

router.get('/users/export', authenticateAdmin, async (req, res) => {
  try {
    const format = req.query.format === 'json' ? 'json' : 'csv';
    const { whereSql, params } = buildUserFilters(req.query);
    const result = await pool.query(
      `SELECT u.id, u.email, u.phone, u.full_name, u.subscription_tier, u.subscription_status,
              u.storage_limit_gb, u.contacts_limit, u.voice_notes_limit, u.created_at,
              COALESCE(u.last_active_at, u.last_login) AS last_active, ${STRIPE_MANAGED} AS stripe_managed,
              (SELECT COUNT(*)::int FROM voice_notes vn WHERE vn.user_id = u.id AND vn.deleted_at IS NULL) AS voice_notes,
              (SELECT COUNT(*)::int FROM contacts c WHERE c.user_id = u.id) AS contacts,
              (SELECT COALESCE(SUM(file_size_bytes), 0)::bigint FROM voice_notes vn WHERE vn.user_id = u.id AND vn.deleted_at IS NULL) AS storage_bytes
       FROM users u ${whereSql}
       ORDER BY u.created_at DESC
       LIMIT 50000`,
      params
    );

    const rows = result.rows.map(u => ({
      'User ID': u.id,
      'Name': u.full_name || '',
      'Email': u.email,
      'Phone': u.phone || '',
      'Plan': u.subscription_tier,
      'Status': u.subscription_status,
      'Pays via Stripe': u.stripe_managed ? 'Yes' : 'No',
      'Voice notes': u.voice_notes,
      'Contacts': u.contacts,
      'Storage used (MB)': Math.round(Number(u.storage_bytes) / (1024 * 1024) * 10) / 10,
      'Storage limit (GB)': u.storage_limit_gb,
      'Contacts limit': u.contacts_limit,
      'Voice notes limit': u.voice_notes_limit,
      'Joined': u.created_at ? new Date(u.created_at).toISOString().slice(0, 10) : '',
      'Last active': u.last_active ? new Date(u.last_active).toISOString().slice(0, 10) : 'Never',
    }));

    logAdminAudit({ userId: req.user.id, action: 'EXPORT_USERS', newValue: { format, count: rows.length, filters: req.query }, ipAddress: req.ip });

    const stamp = new Date().toISOString().slice(0, 10);
    if (format === 'json') {
      res.setHeader('Content-Disposition', `attachment; filename="suretalk-users-${stamp}.json"`);
      return res.json({ exportedAt: new Date().toISOString(), count: rows.length, users: rows });
    }
    const headers = Object.keys(rows[0] || { 'User ID': '' });
    const csv = [headers.map(csvCell).join(','), ...rows.map(r => headers.map(h => csvCell(r[h])).join(','))].join('\r\n');
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="suretalk-users-${stamp}.csv"`);
    res.send('\uFEFF' + csv); // BOM so Excel reads names with accents correctly
  } catch (error) {
    console.error('Export users error:', error);
    res.status(500).json({ success: false, error: 'Failed to export users' });
  }
});

// ── Bulk actions ─────────────────────────────────────────────────────────────
router.post('/users/bulk', authenticateAdmin, [
  body('userIds').isArray({ min: 1, max: 100 }),
  body('action').isIn(['change-plan', 'deactivate', 'reactivate', 'delete']),
  body('tier').optional().isIn(TIERS)
], async (req, res) => {
  try {
    if (!validationResult(req).isEmpty()) {
      return res.status(400).json({ success: false, error: 'Choose up to 100 users and a valid action' });
    }
    const { action, tier } = req.body;
    if (action === 'change-plan' && !tier) return res.status(400).json({ success: false, error: 'Choose a plan' });

    const ids = req.body.userIds.filter(isUuid);
    const users = (await pool.query(
      `SELECT u.id, u.email, u.full_name, u.is_admin, u.subscription_status, u.subscription_tier,
              u.stripe_subscription_id, ${STRIPE_MANAGED} AS stripe_managed
       FROM users u WHERE u.id = ANY($1) AND u.deleted_at IS NULL`,
      [ids]
    )).rows;

    const done = [];
    const skipped = [];
    for (const user of users) {
      if (user.id === req.user.id) { skipped.push({ id: user.id, email: user.email, reason: 'Your own account' }); continue; }
      if (user.is_admin) { skipped.push({ id: user.id, email: user.email, reason: 'Admin account' }); continue; }
      if (action === 'change-plan') {
        if (user.stripe_managed) { skipped.push({ id: user.id, email: user.email, reason: 'Plan managed by Stripe' }); continue; }
        await applyPlan(user.id, tier);
      } else if (action === 'deactivate') {
        await setActive(user, false);
      } else if (action === 'reactivate') {
        await setActive(user, true);
      } else if (action === 'delete') {
        await softDeleteUser(user, { notifyUser: false });
      }
      done.push(user.id);
    }

    logSystem(req.user.id, action === 'delete' ? 'warning' : 'info', 'Bulk user action', { action, tier, affected: done.length, skipped: skipped.length });
    logAdminAudit({ userId: req.user.id, action: 'BULK_UPDATE_USERS', newValue: { action, tier, userIds: done, skipped }, ipAddress: req.ip });

    res.json({ success: true, data: { affected: done.length, skipped } });
  } catch (error) {
    console.error('Bulk user action error:', error);
    res.status(500).json({ success: false, error: 'Failed to perform bulk action' });
  }
});

// ── Create ───────────────────────────────────────────────────────────────────
router.post('/users', authenticateAdmin, [
  body('email').isEmail().normalizeEmail(),
  body('fullName').trim().isLength({ min: 1, max: 255 }),
  body('phone').optional({ checkFalsy: true }).matches(/^\+[1-9]\d{7,14}$/),
  body('subscriptionTier').optional().isIn(TIERS),
  body('sendSetupEmail').optional().isBoolean()
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      const field = errors.array()[0].path;
      const messages = {
        email: 'Enter a valid email address',
        fullName: 'Enter the person\'s name',
        phone: 'Phone must be in international format, e.g. +2348012345678',
      };
      return res.status(400).json({ success: false, error: messages[field] || 'Check the form and try again' });
    }

    const { email, fullName, phone, subscriptionTier = 'LITE', sendSetupEmail = true } = req.body;
    const existing = await pool.query(
      'SELECT id FROM users WHERE LOWER(email) = LOWER($1) OR ($2::text IS NOT NULL AND phone = $2)',
      [email, phone || null]
    );
    if (existing.rows.length) {
      return res.status(409).json({ success: false, error: 'A user with this email or phone number already exists' });
    }

    const limits = TIER_LIMITS[subscriptionTier];
    // Random password nobody knows — the person sets their own through the setup link
    const passwordHash = await bcrypt.hash(crypto.randomBytes(32).toString('hex'), 10);
    const created = (await pool.query(
      `INSERT INTO users (email, phone, full_name, password_hash, subscription_tier, subscription_status,
                          storage_limit_gb, contacts_limit, voice_notes_limit, email_verified, source)
       VALUES ($1, $2, $3, $4, $5, 'active', $6, $7, $8, true, 'admin')
       RETURNING id, email, phone, full_name, subscription_tier, subscription_status, created_at`,
      [email, phone || null, fullName, passwordHash, subscriptionTier, limits.storageGb, limits.contacts, limits.voiceNotes]
    )).rows[0];

    if (phone) syncToIvr({ userId: created.id, email, fullName, phone, source: 'app' }, 'sync-user');

    // "Set your password" link — same mechanism as Forgot password, valid for 7 days
    const token = jwt.sign({ userId: created.id, purpose: 'password_reset' }, process.env.JWT_SECRET, { expiresIn: '7d' });
    const setupLink = `${process.env.FRONTEND_URL}/reset-password?token=${token}`;
    let emailSent = false;
    if (sendSetupEmail) {
      try {
        await emailService.sendPasswordResetEmail(created.email, setupLink, created.full_name);
        emailSent = true;
      } catch (err) {
        console.error('Failed to send account setup email:', err.message);
      }
    }

    logSystem(req.user.id, 'info', 'User created by admin', { createdUserId: created.id, email });
    logAdminAudit({ userId: req.user.id, action: 'CREATE_USER', targetId: created.id, newValue: { email, fullName, phone: phone || null, subscriptionTier }, ipAddress: req.ip });

    res.status(201).json({
      success: true,
      data: {
        user: created,
        emailSent,
        // Only returned when no email went out, so the admin can pass it on themselves
        setupLink: emailSent ? null : setupLink
      }
    });
  } catch (error) {
    if (error.code === '23505') return res.status(409).json({ success: false, error: 'A user with this email or phone number already exists' });
    console.error('Create user error:', error);
    res.status(500).json({ success: false, error: 'Failed to create user' });
  }
});

// ── Details ──────────────────────────────────────────────────────────────────
// Explicit columns — never send password hashes, 2FA secrets or tokens to the browser
const USER_DETAIL_COLUMNS = `
  u.id, u.email, u.phone, u.full_name, u.subscription_tier, u.subscription_status,
  u.storage_limit_gb, u.contacts_limit, u.voice_notes_limit, u.created_at, u.updated_at,
  u.last_login, COALESCE(u.last_active_at, u.last_login) AS last_active, u.email_verified,
  u.is_admin, u.admin_status, COALESCE(u.two_factor_enabled, false) AS two_factor_enabled,
  u.source, u.stripe_customer_id IS NOT NULL AS has_stripe_customer, ${STRIPE_MANAGED} AS stripe_managed`;

router.get('/users/:id', authenticateAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    if (!isUuid(id)) return res.status(404).json({ success: false, error: 'User not found' });

    const userResult = await pool.query(
      `SELECT ${USER_DETAIL_COLUMNS},
        (SELECT COUNT(*)::int FROM voice_notes WHERE user_id = u.id AND deleted_at IS NULL) AS note_count,
        (SELECT COALESCE(SUM(file_size_bytes), 0)::bigint FROM voice_notes WHERE user_id = u.id AND deleted_at IS NULL) AS storage_bytes,
        (SELECT COUNT(*)::int FROM contacts WHERE user_id = u.id) AS contact_count,
        (SELECT COUNT(*)::int FROM voice_wills WHERE user_id = u.id) AS will_count,
        (SELECT COUNT(*)::int FROM scheduled_messages WHERE user_id = u.id) AS scheduled_count
       FROM users u
       WHERE u.id = $1 AND u.deleted_at IS NULL`,
      [id]
    );
    if (!userResult.rows.length) return res.status(404).json({ success: false, error: 'User not found' });

    const [voiceNotes, contacts, billingHistory] = await Promise.all([
      pool.query(
        `SELECT id, title, duration_seconds, file_size_bytes, created_at
         FROM voice_notes WHERE user_id = $1 AND deleted_at IS NULL
         ORDER BY created_at DESC LIMIT 20`, [id]),
      pool.query(
        `SELECT id, name, phone, email, relationship, created_at
         FROM contacts WHERE user_id = $1 ORDER BY created_at DESC LIMIT 50`, [id]),
      pool.query(
        `SELECT id, amount_cents, currency, description, status, created_at
         FROM billing_history WHERE user_id = $1 ORDER BY created_at DESC LIMIT 50`, [id]),
    ]);

    res.json({
      success: true,
      data: {
        user: userResult.rows[0],
        voiceNotes: voiceNotes.rows,
        contacts: contacts.rows,
        billingHistory: billingHistory.rows,
        planLimits: TIER_LIMITS
      }
    });
  } catch (error) {
    console.error('Get user details error:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch user details' });
  }
});

// ── Activity: the user's own events plus admin actions taken on their account ──
router.get('/users/:id/activity', authenticateAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    if (!isUuid(id)) return res.status(404).json({ success: false, error: 'User not found' });
    const [events, adminActions] = await Promise.all([
      pool.query(
        `SELECT id, level, service, message, ip_address::text AS ip_address, created_at
         FROM system_logs WHERE user_id = $1
         ORDER BY created_at DESC LIMIT 100`, [id]),
      pool.query(
        `SELECT a.id, a.action, a.old_value, a.new_value, a.created_at, u.full_name AS admin_name, u.email AS admin_email
         FROM admin_audit_log a LEFT JOIN users u ON u.id = a.admin_user_id
         WHERE a.target_id = $1
         ORDER BY a.created_at DESC LIMIT 50`, [id]),
    ]);
    const logins = events.rows.filter(e => e.message === 'User logged in').length;
    res.json({ success: true, data: { events: events.rows, adminActions: adminActions.rows, recentLogins: logins } });
  } catch (error) {
    console.error('Get user activity error:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch activity' });
  }
});

// ── Shared account operations ────────────────────────────────────────────────
async function applyPlan(userId, tier, customLimits = null) {
  const defaults = TIER_LIMITS[tier];
  const limits = {
    storageGb: customLimits?.storageGb ?? defaults.storageGb,
    contacts: customLimits?.contacts ?? defaults.contacts,
    voiceNotes: customLimits?.voiceNotes ?? defaults.voiceNotes,
  };
  const updated = (await pool.query(
    `UPDATE users SET subscription_tier = $1, storage_limit_gb = $2, contacts_limit = $3, voice_notes_limit = $4,
                      updated_at = CURRENT_TIMESTAMP
     WHERE id = $5 RETURNING subscription_status`,
    [tier, limits.storageGb, limits.contacts, limits.voiceNotes, userId]
  )).rows[0];
  syncToIvr({ userId, tier: ivrTierName(tier), subscriptionStatus: updated?.subscription_status || 'active' }, 'sync-user');
  return limits;
}

async function setActive(user, active) {
  const status = active ? 'active' : 'suspended';
  await pool.query('UPDATE users SET subscription_status = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2', [status, user.id]);
  syncToIvr({ userId: user.id, tier: ivrTierName(user.subscription_tier), subscriptionStatus: status }, 'sync-user');
}

// Same steps as a user deleting their own account (routes/settings.js DELETE /account)
async function softDeleteUser(user, { notifyUser }) {
  let stripeCancelled = null;
  if (stripe && user.stripe_subscription_id) {
    try {
      await stripe.subscriptions.cancel(user.stripe_subscription_id);
      stripeCancelled = true;
    } catch (err) {
      console.error(`Failed to cancel Stripe subscription for deleted user ${user.id}: ${err.message}`);
      stripeCancelled = false;
    }
  }
  await pool.query(
    `UPDATE users SET deleted_at = CURRENT_TIMESTAMP, subscription_status = 'cancelled',
                      stripe_subscription_id = NULL, updated_at = CURRENT_TIMESTAMP
     WHERE id = $1`,
    [user.id]
  );
  syncToIvr({ userId: user.id, subscriptionStatus: 'cancelled' }, 'delete-user');
  if (notifyUser) {
    emailService.sendAccountDeletedEmail(user.email, user.full_name)
      .catch(err => console.error(`Failed to send account deletion email: ${err.message}`));
  }
  return { stripeCancelled };
}

async function loadTarget(req, res) {
  const { id } = req.params;
  if (!isUuid(id)) { res.status(404).json({ success: false, error: 'User not found' }); return null; }
  const result = await pool.query(
    `SELECT u.id, u.email, u.full_name, u.is_admin, u.subscription_tier, u.subscription_status,
            u.storage_limit_gb, u.contacts_limit, u.voice_notes_limit, u.stripe_subscription_id,
            ${STRIPE_MANAGED} AS stripe_managed
     FROM users u WHERE u.id = $1 AND u.deleted_at IS NULL`,
    [id]
  );
  if (!result.rows.length) { res.status(404).json({ success: false, error: 'User not found' }); return null; }
  return result.rows[0];
}

const protectAccount = (req, res, user) => {
  if (user.id === req.user.id) { res.status(400).json({ success: false, error: 'You can\'t do this to your own account' }); return false; }
  if (user.is_admin) { res.status(400).json({ success: false, error: 'This is an admin account. Manage admins from the Admin requests page.' }); return false; }
  return true;
};

// ── Edit: name, plan and limits ──────────────────────────────────────────────
router.put('/users/:id', authenticateAdmin, [
  body('fullName').optional().trim().isLength({ min: 1, max: 255 }),
  body('subscriptionTier').optional().isIn(TIERS),
  body(['storageLimitGb', 'contactsLimit', 'voiceNotesLimit']).optional().isInt({ min: 0, max: 100000 })
], async (req, res) => {
  try {
    if (!validationResult(req).isEmpty()) {
      return res.status(400).json({ success: false, error: 'Check the values and try again' });
    }
    const user = await loadTarget(req, res);
    if (!user) return;

    const { fullName, subscriptionTier, storageLimitGb, contactsLimit, voiceNotesLimit } = req.body;
    const before = {
      full_name: user.full_name, subscription_tier: user.subscription_tier,
      storage_limit_gb: user.storage_limit_gb, contacts_limit: user.contacts_limit, voice_notes_limit: user.voice_notes_limit
    };
    const limitsGiven = [storageLimitGb, contactsLimit, voiceNotesLimit].some(v => v !== undefined);
    const tierChanged = subscriptionTier && subscriptionTier !== user.subscription_tier;

    if ((tierChanged || limitsGiven) && user.stripe_managed) {
      return res.status(409).json({
        success: false,
        code: 'STRIPE_MANAGED',
        error: 'This user pays through Stripe, so their plan and limits follow their subscription. Change it in Stripe instead.'
      });
    }

    if (fullName !== undefined) {
      await pool.query('UPDATE users SET full_name = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2', [fullName, user.id]);
    }
    if (tierChanged || limitsGiven) {
      await applyPlan(user.id, subscriptionTier || user.subscription_tier, limitsGiven ? {
        storageGb: storageLimitGb !== undefined ? parseInt(storageLimitGb, 10) : undefined,
        contacts: contactsLimit !== undefined ? parseInt(contactsLimit, 10) : undefined,
        voiceNotes: voiceNotesLimit !== undefined ? parseInt(voiceNotesLimit, 10) : undefined,
      } : null);
    }

    const after = (await pool.query(
      `SELECT full_name, subscription_tier, storage_limit_gb, contacts_limit, voice_notes_limit FROM users WHERE id = $1`, [user.id]
    )).rows[0];
    logAdminAudit({ userId: req.user.id, action: 'UPDATE_USER', targetId: user.id, oldValue: before, newValue: after, ipAddress: req.ip });

    res.json({ success: true, data: after });
  } catch (error) {
    console.error('Update user error:', error);
    res.status(500).json({ success: false, error: 'Failed to update user' });
  }
});

// ── Deactivate / reactivate ──────────────────────────────────────────────────
for (const [path, active] of [['deactivate', false], ['reactivate', true]]) {
  router.post(`/users/:id/${path}`, authenticateAdmin, async (req, res) => {
    try {
      const user = await loadTarget(req, res);
      if (!user || !protectAccount(req, res, user)) return;
      await setActive(user, active);
      logSystem(req.user.id, active ? 'info' : 'warning', active ? 'User reactivated by admin' : 'User deactivated by admin', { targetUserId: user.id, email: user.email });
      logAdminAudit({
        userId: req.user.id, action: active ? 'REACTIVATE_USER' : 'DEACTIVATE_USER', targetId: user.id,
        oldValue: { subscription_status: user.subscription_status }, newValue: { subscription_status: active ? 'active' : 'suspended' }, ipAddress: req.ip
      });
      res.json({ success: true, data: { subscription_status: active ? 'active' : 'suspended' } });
    } catch (error) {
      console.error(`User ${path} error:`, error);
      res.status(500).json({ success: false, error: `Failed to ${path} user` });
    }
  });
}

// ── Send a password reset email ──────────────────────────────────────────────
router.post('/users/:id/send-password-reset', authenticateAdmin, async (req, res) => {
  try {
    const user = await loadTarget(req, res);
    if (!user) return;
    const token = jwt.sign({ userId: user.id, purpose: 'password_reset' }, process.env.JWT_SECRET, { expiresIn: '1h' });
    await emailService.sendPasswordResetEmail(user.email, `${process.env.FRONTEND_URL}/reset-password?token=${token}`, user.full_name);
    logAdminAudit({ userId: req.user.id, action: 'SEND_PASSWORD_RESET', targetId: user.id, ipAddress: req.ip });
    res.json({ success: true, message: `Password reset email sent to ${user.email}` });
  } catch (error) {
    console.error('Admin password reset error:', error);
    res.status(500).json({ success: false, error: 'Failed to send the password reset email' });
  }
});

// ── Delete (soft — data kept; Stripe cancelled; same as self-delete) ───────────
router.delete('/users/:id', authenticateAdmin, async (req, res) => {
  try {
    const user = await loadTarget(req, res);
    if (!user || !protectAccount(req, res, user)) return;
    const notifyUser = req.query.notify !== '0';
    const { stripeCancelled } = await softDeleteUser(user, { notifyUser });

    logSystem(req.user.id, 'warning', 'User deleted by admin', { deletedUserId: user.id, email: user.email, stripeCancelled });
    logAdminAudit({
      userId: req.user.id, action: 'DELETE_USER', targetId: user.id,
      oldValue: { email: user.email, subscription_tier: user.subscription_tier, subscription_status: user.subscription_status },
      newValue: { deleted: true, stripeCancelled, notifiedUser: notifyUser }, ipAddress: req.ip
    });

    res.json({
      success: true,
      data: { stripeCancelled },
      message: stripeCancelled === false
        ? 'User deleted, but their Stripe subscription could not be cancelled — cancel it in Stripe.'
        : 'User deleted'
    });
  } catch (error) {
    console.error('Delete user error:', error);
    res.status(500).json({ success: false, error: 'Failed to delete user' });
  }
});

module.exports = router;
