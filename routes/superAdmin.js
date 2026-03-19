const express = require('express');
const router = express.Router();
const { pool } = require('../config/database');
const { generateDownloadUrl } = require('../utils/s3Storage');

// Super admin authentication middleware
const authenticateSuperAdmin = async (req, res, next) => {
  try {
    const jwt = require('jsonwebtoken');
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ success: false, error: 'Unauthorized' });
    }
    const token = authHeader.split(' ')[1];
    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    const userResult = await pool.query(
      'SELECT id, email, full_name, is_admin, is_super_admin FROM users WHERE id = $1',
      [decoded.userId]
    );

    if (userResult.rows.length === 0 ||
        !userResult.rows[0].is_admin ||
        !userResult.rows[0].is_super_admin) {
      return res.status(403).json({ success: false, error: 'Super admin access required' });
    }

    req.user = userResult.rows[0];
    next();
  } catch (err) {
    return res.status(401).json({ success: false, error: 'Invalid token' });
  }
};

// ── GET /api/super-admin/users ────────────────────────────────────────────────
// Paginated user list with stats
router.get('/users', authenticateSuperAdmin, async (req, res) => {
  try {
    const {
      page = 1,
      limit = 20,
      search = '',
      tier = '',
      status = '',
      sort = 'created_at',
      order = 'desc'
    } = req.query;

    const offset = (page - 1) * limit;
    const params = [];
    let whereClause = 'WHERE 1=1';
    let paramCount = 1;

    if (search) {
      whereClause += ` AND (u.email ILIKE $${paramCount} OR u.full_name ILIKE $${paramCount} OR u.phone ILIKE $${paramCount})`;
      params.push(`%${search}%`);
      paramCount++;
    }

    if (tier) {
      whereClause += ` AND u.subscription_tier = $${paramCount}`;
      params.push(tier);
      paramCount++;
    }

    if (status === 'suspended') {
      whereClause += ` AND u.is_suspended = true`;
    } else if (status === 'active') {
      whereClause += ` AND (u.is_suspended = false OR u.is_suspended IS NULL)`;
    }

    const validSorts = ['created_at', 'full_name', 'email', 'subscription_tier', 'last_login'];
    const sortColumn = validSorts.includes(sort) ? sort : 'created_at';
    const sortOrder = order === 'asc' ? 'ASC' : 'DESC';

    const query = `
      SELECT
        u.id, u.full_name, u.email, u.phone,
        u.subscription_tier, u.is_admin, u.is_super_admin,
        u.is_suspended, u.email_verified, u.created_at,
        u.last_login, u.source,
        COUNT(DISTINCT vn.id) as voice_note_count,
        COUNT(DISTINCT c.id) as contact_count,
        COALESCE(SUM(vn.file_size_bytes), 0) as storage_used_bytes,
        COUNT(*) OVER() as total_count
      FROM users u
      LEFT JOIN voice_notes vn ON vn.user_id = u.id AND vn.deleted_at IS NULL
      LEFT JOIN contacts c ON c.user_id = u.id
      ${whereClause}
      GROUP BY u.id
      ORDER BY u.${sortColumn} ${sortOrder}
      LIMIT $${paramCount} OFFSET $${paramCount + 1}
    `;

    params.push(parseInt(limit), offset);
    const result = await pool.query(query, params);

    const total = result.rows[0]?.total_count || 0;

    res.json({
      success: true,
      data: {
        users: result.rows,
        pagination: {
          page: parseInt(page),
          limit: parseInt(limit),
          total: parseInt(total),
          totalPages: Math.ceil(total / limit)
        }
      }
    });
  } catch (err) {
    console.error('Super admin get users error:', err);
    res.status(500).json({ success: false, error: 'Failed to fetch users' });
  }
});

// ── GET /api/super-admin/users/export ────────────────────────────────────────
// IMPORTANT: This route must be defined BEFORE the /users/:id/full route
// to prevent Express from treating 'export' as an :id param
router.get('/users/export', authenticateSuperAdmin, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT
        u.id,
        u.full_name,
        u.email,
        u.phone,
        u.subscription_tier,
        u.email_verified,
        u.is_suspended,
        u.source,
        u.created_at,
        u.last_login,
        COUNT(DISTINCT vn.id) as voice_note_count,
        COUNT(DISTINCT c.id) as contact_count,
        COALESCE(SUM(vn.file_size_bytes), 0) as storage_used_bytes
      FROM users u
      LEFT JOIN voice_notes vn ON vn.user_id = u.id AND vn.deleted_at IS NULL
      LEFT JOIN contacts c ON c.user_id = u.id
      WHERE u.is_admin = false OR u.is_admin IS NULL
      GROUP BY u.id
      ORDER BY u.created_at DESC
    `);

    // Build CSV
    const headers = [
      'ID', 'Full Name', 'Email', 'Phone', 'Tier',
      'Email Verified', 'Suspended', 'Source',
      'Joined', 'Last Login', 'Voice Notes', 'Contacts', 'Storage (MB)'
    ];

    const rows = result.rows.map(user => [
      user.id,
      `"${(user.full_name || '').replace(/"/g, '""')}"`,
      user.email,
      user.phone || '',
      user.subscription_tier,
      user.email_verified ? 'Yes' : 'No',
      user.is_suspended ? 'Yes' : 'No',
      user.source || 'app',
      user.created_at ? new Date(user.created_at).toISOString().split('T')[0] : '',
      user.last_login ? new Date(user.last_login).toISOString().split('T')[0] : 'Never',
      user.voice_note_count,
      user.contact_count,
      (parseInt(user.storage_used_bytes) / (1024 * 1024)).toFixed(2)
    ].join(','));

    const csv = [headers.join(','), ...rows].join('\n');

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename=suretalk-users-${new Date().toISOString().split('T')[0]}.csv`);
    res.send(csv);

  } catch (err) {
    console.error('Export users error:', { message: err.message });
    res.status(500).json({ success: false, error: 'Failed to export users' });
  }
});

// ── GET /api/super-admin/users/:id/full ──────────────────────────────────────
// Complete user profile with all their data
router.get('/users/:id/full', authenticateSuperAdmin, async (req, res) => {
  try {
    const { id } = req.params;

    // User profile
    const userResult = await pool.query(
      `SELECT u.*,
              COUNT(DISTINCT vn.id) as voice_note_count,
              COUNT(DISTINCT sm.id) as scheduled_count,
              COALESCE(SUM(vn.file_size_bytes), 0) as storage_used_bytes
       FROM users u
       LEFT JOIN voice_notes vn ON vn.user_id = u.id AND vn.deleted_at IS NULL
       LEFT JOIN scheduled_messages sm ON sm.user_id = u.id
       WHERE u.id = $1
       GROUP BY u.id`,
      [id]
    );

    if (userResult.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'User not found' });
    }

    // Voice notes (metadata only, no download URLs)
    const voiceNotesResult = await pool.query(
      `SELECT id, title, description, duration_seconds, file_size_bytes,
              is_favorite, is_permanent, play_count, last_played,
              source, created_at, tags, s3_bucket
       FROM voice_notes
       WHERE user_id = $1 AND deleted_at IS NULL
       ORDER BY created_at DESC
       LIMIT 50`,
      [id]
    );

    // Contacts
    const contactsResult = await pool.query(
      `SELECT id, name, phone, email, relationship,
              is_beneficiary, can_receive_messages, created_at
       FROM contacts
       WHERE user_id = $1
       ORDER BY created_at DESC`,
      [id]
    );

    // Scheduled messages
    const scheduledResult = await pool.query(
      `SELECT sm.id, sm.delivery_method, sm.delivery_status,
              sm.scheduled_for, sm.delivered_at, sm.error_message,
              sm.recipient_email, sm.recipient_phone, sm.created_at,
              sm.metadata, vn.title as voice_note_title
       FROM scheduled_messages sm
       LEFT JOIN voice_notes vn ON sm.voice_note_id = vn.id
       WHERE sm.user_id = $1
       ORDER BY sm.created_at DESC
       LIMIT 50`,
      [id]
    );

    // Vault/wills
    let vaultResult = { rows: [] };
    try {
      vaultResult = await pool.query(
        `SELECT
          id, title, description,
          s3_key, s3_bucket,
          release_condition, release_date,
          is_released, released_at,
          beneficiaries, executors,
          verification_required,
          created_at
         FROM voice_wills
         WHERE user_id = $1
         ORDER BY created_at DESC`,
        [id]
      );
    } catch (vaultErr) {
      console.warn('voice_wills query error:', vaultErr.message);
    }

    res.json({
      success: true,
      data: {
        user: userResult.rows[0],
        voiceNotes: voiceNotesResult.rows,
        contacts: contactsResult.rows,
        scheduled: scheduledResult.rows,
        vault: vaultResult.rows
      }
    });
  } catch (err) {
    console.error('Super admin get user full error:', {
      message: err.message,
      code: err.code,
      detail: err.detail,
      table: err.table
    });
    res.status(500).json({ success: false, error: 'Failed to fetch user data' });
  }
});

// ── GET /api/super-admin/users/:id/footprint ─────────────────────────────────
// Digital footprint — last 90 days of activity
router.get('/users/:id/footprint', authenticateSuperAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const ninetyDaysAgo = new Date();
    ninetyDaysAgo.setDate(ninetyDaysAgo.getDate() - 90);

    // All analytics events
    const eventsResult = await pool.query(
      `SELECT event_type, event_data, created_at,
              voice_note_id, contact_id
       FROM analytics_events
       WHERE user_id = $1 AND created_at >= $2
       ORDER BY created_at DESC
       LIMIT 500`,
      [id, ninetyDaysAgo]
    );

    // Login history (from users table last_login + audit log if exists)
    const loginResult = await pool.query(
      `SELECT event_type, event_data, created_at
       FROM analytics_events
       WHERE user_id = $1
         AND event_type IN ('login', 'logout', 'login_failed', 'token_refresh')
         AND created_at >= $2
       ORDER BY created_at DESC`,
      [id, ninetyDaysAgo]
    );

    // Activity summary by day
    const dailySummaryResult = await pool.query(
      `SELECT
         DATE(created_at) as date,
         COUNT(*) as total_events,
         COUNT(CASE WHEN event_type = 'voice_note_played' THEN 1 END) as plays,
         COUNT(CASE WHEN event_type = 'voice_note_created' THEN 1 END) as recordings,
         COUNT(CASE WHEN event_type = 'voice_note_downloaded' THEN 1 END) as downloads,
         COUNT(CASE WHEN event_type = 'scheduled_message_created' THEN 1 END) as schedules
       FROM analytics_events
       WHERE user_id = $1 AND created_at >= $2
       GROUP BY DATE(created_at)
       ORDER BY date DESC`,
      [id, ninetyDaysAgo]
    );

    // Event type breakdown
    const breakdownResult = await pool.query(
      `SELECT event_type, COUNT(*) as count
       FROM analytics_events
       WHERE user_id = $1 AND created_at >= $2
       GROUP BY event_type
       ORDER BY count DESC`,
      [id, ninetyDaysAgo]
    );

    // Most played voice notes
    const topPlayedResult = await pool.query(
      `SELECT vn.id, vn.title, vn.play_count, vn.last_played,
              vn.duration_seconds, vn.created_at
       FROM voice_notes vn
       WHERE vn.user_id = $1 AND vn.deleted_at IS NULL
       ORDER BY vn.play_count DESC
       LIMIT 10`,
      [id]
    );

    res.json({
      success: true,
      data: {
        events: eventsResult.rows,
        loginHistory: loginResult.rows,
        dailySummary: dailySummaryResult.rows,
        eventBreakdown: breakdownResult.rows,
        topPlayed: topPlayedResult.rows,
        period: '90 days'
      }
    });
  } catch (err) {
    console.error('Super admin footprint error:', err);
    res.status(500).json({ success: false, error: 'Failed to fetch footprint' });
  }
});

// ── PUT /api/super-admin/users/:id/tier ──────────────────────────────────────
router.put('/users/:id/tier', authenticateSuperAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const { tier, reason } = req.body;

    const validTiers = ['LITE', 'ESSENTIAL', 'LEGACY_VAULT_PREMIUM'];
    if (!validTiers.includes(tier)) {
      return res.status(400).json({ success: false, error: 'Invalid tier' });
    }

    await pool.query(
      `UPDATE users SET subscription_tier = $1, updated_at = NOW() WHERE id = $2`,
      [tier, id]
    );

    // Log the admin action
    await pool.query(
      `INSERT INTO analytics_events (user_id, event_type, event_data)
       VALUES ($1, 'admin_tier_change', $2)`,
      [id, JSON.stringify({
        newTier: tier,
        reason,
        changedBy: req.user.id,
        changedAt: new Date().toISOString()
      })]
    );

    res.json({ success: true, message: `Tier updated to ${tier}` });
  } catch (err) {
    console.error('Super admin tier change error:', err);
    res.status(500).json({ success: false, error: 'Failed to update tier' });
  }
});

// ── PUT /api/super-admin/users/:id/suspend ───────────────────────────────────
router.put('/users/:id/suspend', authenticateSuperAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const { suspend, reason } = req.body;

    await pool.query(
      `UPDATE users SET is_suspended = $1, updated_at = NOW() WHERE id = $2`,
      [suspend, id]
    );

    await pool.query(
      `INSERT INTO analytics_events (user_id, event_type, event_data)
       VALUES ($1, $2, $3)`,
      [id,
       suspend ? 'admin_account_suspended' : 'admin_account_reactivated',
       JSON.stringify({ reason, actionBy: req.user.id })
      ]
    );

    res.json({
      success: true,
      message: suspend ? 'Account suspended' : 'Account reactivated'
    });
  } catch (err) {
    console.error('Super admin suspend error:', err);
    res.status(500).json({ success: false, error: 'Failed to update account status' });
  }
});

// ── GET /api/super-admin/sync/dead-letters ───────────────────────────────────
// Dead sync items from both App→IVR (PostgreSQL) and IVR→App (reported via API)
router.get('/sync/dead-letters', authenticateSuperAdmin, async (req, res) => {
  try {
    const deadLetters = await pool.query(
      `SELECT id, event_type, payload, attempts,
              last_attempt_at, error_message, created_at,
              'app_to_ivr' as direction
       FROM sync_outbox
       WHERE status = 'dead'
       ORDER BY created_at DESC
       LIMIT 100`
    );

    res.json({
      success: true,
      data: {
        deadLetters: deadLetters.rows,
        total: deadLetters.rows.length
      }
    });
  } catch (err) {
    console.error('Super admin dead letters error:', err);
    res.status(500).json({ success: false, error: 'Failed to fetch dead letters' });
  }
});

// ── POST /api/super-admin/sync/:id/retry ─────────────────────────────────────
// Manually retry a dead sync item
router.post('/sync/:id/retry', authenticateSuperAdmin, async (req, res) => {
  try {
    const { id } = req.params;

    await pool.query(
      `UPDATE sync_outbox
       SET status = 'pending', attempts = 0, error_message = NULL,
           last_attempt_at = NULL
       WHERE id = $1 AND status = 'dead'`,
      [id]
    );

    res.json({ success: true, message: 'Sync item queued for retry' });
  } catch (err) {
    console.error('Super admin retry sync error:', {
      message: err.message,
      code: err.code,
      detail: err.detail
    });
    res.status(500).json({ success: false, error: 'Failed to retry sync item' });
  }
});

// ── PUT /api/super-admin/sync/:id/edit-retry ─────────────────────────────────
// Edit payload fields and retry a dead sync item
router.put('/sync/:id/edit-retry', authenticateSuperAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const { userId, slotNumber, contact, voiceMessage } = req.body;

    // Validate required fields
    if (!userId || !slotNumber || !voiceMessage) {
      return res.status(400).json({
        success: false,
        error: 'userId, slotNumber, and voiceMessage are required'
      });
    }

    // Validate slotNumber is 1-15
    const slotNum = parseInt(slotNumber);
    if (isNaN(slotNum) || slotNum < 1 || slotNum > 15) {
      return res.status(400).json({
        success: false,
        error: 'slotNumber must be between 1 and 15'
      });
    }

    // Get current item to preserve eventType and other fields
    const currentItem = await pool.query(
      'SELECT * FROM sync_outbox WHERE id = $1',
      [id]
    );

    if (currentItem.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Sync item not found' });
    }

    // Build updated payload preserving existing fields
    const existingPayload = currentItem.rows[0].payload || {};
    const updatedPayload = {
      ...existingPayload,
      userId,
      slotNumber: slotNum.toString(),
      contact: contact || '',
      voiceMessage,
      action: existingPayload.action || 'create',
      source: existingPayload.source || 'app',
      _editedBySuperAdmin: true,
      _editedAt: new Date().toISOString(),
      _editedBy: req.user.id
    };

    // Update payload and reset for retry
    await pool.query(
      `UPDATE sync_outbox
       SET payload = $1,
           status = 'pending',
           attempts = 0,
           error_message = NULL,
           last_attempt_at = NULL
       WHERE id = $2`,
      [JSON.stringify(updatedPayload), id]
    );

    // Log the admin action
    await pool.query(
      `INSERT INTO analytics_events (user_id, event_type, event_data)
       VALUES ($1, 'super_admin_edit_retry_sync', $2)`,
      [req.user.id, JSON.stringify({ syncId: id, changes: { userId, slotNumber: slotNum, contact, voiceMessage } })]
    );

    res.json({
      success: true,
      message: 'Sync item updated and queued for retry',
      data: { updatedPayload }
    });

  } catch (err) {
    console.error('Super admin edit retry error:', {
      message: err.message,
      code: err.code,
      detail: err.detail
    });
    res.status(500).json({ success: false, error: 'Failed to update sync item' });
  }
});

// ── GET /api/super-admin/overview ────────────────────────────────────────────
// System-wide overview stats
router.get('/overview', authenticateSuperAdmin, async (req, res) => {
  try {
    const [
      userStats,
      contentStats,
      syncStats,
      recentActivity
    ] = await Promise.all([
      pool.query(`
        SELECT
          COUNT(*) as total_users,
          COUNT(CASE WHEN subscription_tier = 'LITE' THEN 1 END) as lite_users,
          COUNT(CASE WHEN subscription_tier = 'ESSENTIAL' THEN 1 END) as essential_users,
          COUNT(CASE WHEN subscription_tier = 'LEGACY_VAULT_PREMIUM' THEN 1 END) as premium_users,
          COUNT(CASE WHEN is_suspended = true THEN 1 END) as suspended_users,
          COUNT(CASE WHEN created_at >= NOW() - INTERVAL '7 days' THEN 1 END) as new_this_week,
          COUNT(CASE WHEN last_login >= NOW() - INTERVAL '24 hours' THEN 1 END) as active_today
        FROM users WHERE is_admin = false OR is_admin IS NULL
      `),
      pool.query(`
        SELECT
          COUNT(DISTINCT vn.id) as total_voice_notes,
          COALESCE(SUM(vn.file_size_bytes), 0) as total_storage_bytes,
          COUNT(DISTINCT sm.id) as total_scheduled,
          COUNT(DISTINCT CASE WHEN sm.delivery_status = 'delivered' THEN sm.id END) as total_delivered,
          COUNT(DISTINCT CASE WHEN sm.delivery_status = 'failed' THEN sm.id END) as total_failed
        FROM voice_notes vn
        FULL OUTER JOIN scheduled_messages sm ON true
        WHERE vn.deleted_at IS NULL OR vn.id IS NULL
      `),
      pool.query(`
        SELECT
          COUNT(CASE WHEN status = 'dead' THEN 1 END) as dead_count,
          COUNT(CASE WHEN status = 'pending' THEN 1 END) as pending_count,
          COUNT(CASE WHEN status = 'sent' THEN 1 END) as sent_count
        FROM sync_outbox
      `),
      pool.query(`
        SELECT ae.event_type, ae.created_at,
               u.full_name, u.email
        FROM analytics_events ae
        JOIN users u ON ae.user_id = u.id
        ORDER BY ae.created_at DESC
        LIMIT 20
      `)
    ]);

    res.json({
      success: true,
      data: {
        users: userStats.rows[0],
        content: contentStats.rows[0],
        sync: syncStats.rows[0],
        recentActivity: recentActivity.rows
      }
    });
  } catch (err) {
    console.error('Super admin overview error:', err);
    res.status(500).json({ success: false, error: 'Failed to fetch overview' });
  }
});

// ── GET /api/super-admin/revenue ─────────────────────────────────────────────
router.get('/revenue', authenticateSuperAdmin, async (req, res) => {
  try {
    const [tierStats, billingHistory, recentTransactions] = await Promise.all([

      // Users per tier with estimated MRR
      pool.query(`
        SELECT
          subscription_tier,
          COUNT(*) as user_count,
          COUNT(CASE WHEN is_suspended = false OR is_suspended IS NULL THEN 1 END) as active_count,
          COUNT(CASE WHEN created_at >= NOW() - INTERVAL '30 days' THEN 1 END) as new_this_month
        FROM users
        WHERE is_admin = false OR is_admin IS NULL
        GROUP BY subscription_tier
        ORDER BY user_count DESC
      `),

      // Billing totals
      pool.query(`
        SELECT
          COUNT(*) as total_transactions,
          COALESCE(SUM(CASE WHEN status = 'succeeded' THEN amount_cents ELSE 0 END), 0) as total_revenue_cents,
          COALESCE(SUM(CASE WHEN status = 'succeeded' AND created_at >= NOW() - INTERVAL '30 days' THEN amount_cents ELSE 0 END), 0) as revenue_last_30_days_cents,
          COUNT(CASE WHEN status = 'failed' THEN 1 END) as failed_transactions
        FROM billing_history
      `),

      // Recent transactions
      pool.query(`
        SELECT
          bh.id, bh.amount_cents, bh.currency, bh.status,
          bh.description, bh.tier_before, bh.tier_after,
          bh.created_at,
          u.full_name, u.email
        FROM billing_history bh
        JOIN users u ON bh.user_id = u.id
        ORDER BY bh.created_at DESC
        LIMIT 20
      `)
    ]);

    // Tier pricing for MRR estimate (adjust to your actual prices)
    const TIER_PRICE_USD = {
      'LITE': 0,
      'ESSENTIAL': 9.99,
      'LEGACY_VAULT_PREMIUM': 19.99
    };

    const tierBreakdown = tierStats.rows.map(row => ({
      ...row,
      estimatedMonthlyRevenue: (parseInt(row.active_count) * (TIER_PRICE_USD[row.subscription_tier] || 0)).toFixed(2)
    }));

    const estimatedMRR = tierBreakdown.reduce((sum, tier) =>
      sum + parseFloat(tier.estimatedMonthlyRevenue), 0
    ).toFixed(2);

    res.json({
      success: true,
      data: {
        tierBreakdown,
        estimatedMRR,
        billing: billingHistory.rows[0],
        recentTransactions: recentTransactions.rows
      }
    });
  } catch (err) {
    console.error('Revenue endpoint error:', { message: err.message, code: err.code });
    res.status(500).json({ success: false, error: 'Failed to fetch revenue data' });
  }
});

// ── GET /api/super-admin/sync-health ─────────────────────────────────────────
router.get('/sync-health', authenticateSuperAdmin, async (req, res) => {
  try {
    const sevenDaysAgo = new Date();
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);

    // App → IVR outbox stats
    const outboxStats = await pool.query(`
      SELECT status, COUNT(*) as count, AVG(attempts) as avg_attempts
      FROM sync_outbox
      GROUP BY status
    `);

    const recentFailures = await pool.query(`
      SELECT id, event_type, attempts, error_message,
             last_attempt_at, created_at
      FROM sync_outbox
      WHERE status IN ('failed', 'dead')
      ORDER BY last_attempt_at DESC NULLS LAST
      LIMIT 10
    `);

    const recentSuccess = await pool.query(`
      SELECT
        MAX(CASE WHEN status = 'sent' THEN sent_at END) as last_app_to_ivr_success,
        MAX(CASE WHEN status = 'dead' THEN last_attempt_at END) as last_dead_at
      FROM sync_outbox
    `);

    // IVR → App received log — handle missing table gracefully
    let receivedBreakdown = [];
    let lastIvrReceived = null;

    try {
      const receivedLog = await pool.query(`
        SELECT
          event_type,
          COUNT(*) as total,
          COUNT(CASE WHEN created_at >= $1 THEN 1 END) as last_7_days
        FROM sync_received_log
        GROUP BY event_type
        ORDER BY total DESC
      `, [sevenDaysAgo]);
      receivedBreakdown = receivedLog.rows;

      const lastReceived = await pool.query(`
        SELECT created_at FROM sync_received_log
        ORDER BY created_at DESC LIMIT 1
      `);
      lastIvrReceived = lastReceived.rows[0]?.created_at || null;
    } catch (logErr) {
      console.warn('sync_received_log query failed (table may not exist):', logErr.message);
    }

    // Calculate success rate
    const outboxMap = {};
    outboxStats.rows.forEach(row => { outboxMap[row.status] = parseInt(row.count); });
    const totalSyncs = Object.values(outboxMap).reduce((a, b) => a + b, 0);
    const successfulSyncs = outboxMap['sent'] || 0;
    const successRate = totalSyncs > 0 ? ((successfulSyncs / totalSyncs) * 100).toFixed(1) : '0.0';

    res.json({
      success: true,
      data: {
        appToIvr: {
          stats: outboxMap,
          totalSyncs,
          successRate: parseFloat(successRate),
          recentFailures: recentFailures.rows,
          lastSuccess: recentSuccess.rows[0]?.last_app_to_ivr_success || null,
          lastDeadAt: recentSuccess.rows[0]?.last_dead_at || null
        },
        ivrToApp: {
          breakdown: receivedBreakdown,
          lastReceived: lastIvrReceived
        }
      }
    });
  } catch (err) {
    console.error('Sync health endpoint error:', { message: err.message, code: err.code, detail: err.detail });
    res.status(500).json({ success: false, error: 'Failed to fetch sync health' });
  }
});

// ── GET /api/super-admin/system-health ───────────────────────────────────────
router.get('/system-health', authenticateSuperAdmin, async (req, res) => {
  try {
    const startTime = Date.now();

    // 1. Database health — ping and get stats
    const dbStart = Date.now();
    const [dbPing, dbStats, storageStats, schedulerStats] = await Promise.all([
      pool.query('SELECT NOW() as time, version() as version'),
      pool.query(`
        SELECT
          COUNT(*) as total_users,
          COUNT(CASE WHEN last_login >= NOW() - INTERVAL '24 hours' THEN 1 END) as active_24h,
          COUNT(CASE WHEN last_login >= NOW() - INTERVAL '7 days' THEN 1 END) as active_7d
        FROM users
      `),
      pool.query(`
        SELECT
          s3_bucket,
          COUNT(*) as file_count,
          COALESCE(SUM(file_size_bytes), 0) as total_bytes
        FROM voice_notes
        WHERE deleted_at IS NULL
        GROUP BY s3_bucket
        ORDER BY total_bytes DESC
      `),
      pool.query(`
        SELECT
          COUNT(*) as total_scheduled,
          COUNT(CASE WHEN delivery_status = 'scheduled' AND scheduled_for > NOW() THEN 1 END) as upcoming,
          COUNT(CASE WHEN delivery_status = 'delivered' AND delivered_at >= NOW() - INTERVAL '24 hours' THEN 1 END) as delivered_today,
          COUNT(CASE WHEN delivery_status = 'failed' THEN 1 END) as total_failed
        FROM scheduled_messages
      `)
    ]);
    const dbResponseTime = Date.now() - dbStart;

    // 2. S3 storage summary
    const totalStorageBytes = storageStats.rows.reduce((sum, row) =>
      sum + parseInt(row.total_bytes || 0), 0
    );

    // 3. Sync outbox health
    const syncStats = await pool.query(`
      SELECT status, COUNT(*) as count
      FROM sync_outbox
      GROUP BY status
    `);
    const syncMap = {};
    syncStats.rows.forEach(r => { syncMap[r.status] = parseInt(r.count); });

    res.json({
      success: true,
      data: {
        timestamp: new Date().toISOString(),
        responseTime: Date.now() - startTime,
        database: {
          status: 'healthy',
          responseTimeMs: dbResponseTime,
          version: dbPing.rows[0] ? dbPing.rows[0].version.split(' ')[0] + ' ' + dbPing.rows[0].version.split(' ')[1] : 'unknown',
          serverTime: dbPing.rows[0]?.time,
          users: dbStats.rows[0]
        },
        storage: {
          buckets: storageStats.rows.map(row => ({
            bucket: row.s3_bucket,
            files: parseInt(row.file_count),
            bytes: parseInt(row.total_bytes),
            gb: (parseInt(row.total_bytes) / (1024 * 1024 * 1024)).toFixed(3)
          })),
          totalBytes: totalStorageBytes,
          totalGb: (totalStorageBytes / (1024 * 1024 * 1024)).toFixed(3)
        },
        scheduler: schedulerStats.rows[0],
        sync: {
          outbox: syncMap,
          deadCount: syncMap['dead'] || 0,
          pendingCount: syncMap['pending'] || 0,
          sentCount: syncMap['sent'] || 0
        }
      }
    });
  } catch (err) {
    console.error('System health endpoint error:', { message: err.message, code: err.code });
    res.status(500).json({ success: false, error: 'Failed to fetch system health' });
  }
});

module.exports = router;
