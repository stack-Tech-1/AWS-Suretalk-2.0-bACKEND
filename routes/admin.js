// C:\Users\SMC\Documents\GitHub\AWS-Suretalk-2.0-fRONTEND\surechat-backend\routes\admin.js
const express = require('express');
const router = express.Router();
const { authenticate, authenticateAdmin } = require('../middleware/auth');
const { pool } = require('../config/database');
const { body, validationResult } = require('express-validator'); 
const bcrypt = require('bcrypt'); 
const { uploadToS3 } = require('../utils/s3Storage');
const multer = require('multer');
//const upload = multer({ storage: multer.memoryStorage() });

// Non-blocking admin audit log helper
async function logAdminAudit({ userId, action, targetId = null, oldValue = null, newValue = null, ipAddress = null }) {
  try {
    await pool.query(
      `INSERT INTO admin_audit_log (admin_user_id, action, target_id, old_value, new_value, ip_address)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        userId,
        action,
        targetId,
        oldValue  ? JSON.stringify(oldValue)  : null,
        newValue  ? JSON.stringify(newValue)  : null,
        ipAddress
      ]
    );
  } catch (err) {
    console.warn('Admin audit log failed (non-fatal):', err.message);
  }
}


// Get system overview stats
router.get('/overview', authenticateAdmin, async (req, res) => {
  try {
    // Get user statistics
    const userStats = await pool.query(`
      SELECT 
        COUNT(*) as total_users,
        COUNT(CASE WHEN subscription_tier = 'LITE' THEN 1 END) as lite_users,
        COUNT(CASE WHEN subscription_tier = 'ESSENTIAL' THEN 1 END) as essential_users,
        COUNT(CASE WHEN subscription_tier = 'LEGACY_VAULT_PREMIUM' THEN 1 END) as premium_users,
        COUNT(CASE WHEN subscription_status = 'active' THEN 1 END) as active_users,
        COUNT(CASE WHEN created_at >= CURRENT_DATE - INTERVAL '7 days' THEN 1 END) as new_users_7d,
        COUNT(CASE WHEN last_login >= CURRENT_DATE - INTERVAL '1 day' THEN 1 END) as active_today
      FROM users
      WHERE deleted_at IS NULL
    `);

    // Get voice note statistics
    const voiceStats = await pool.query(`
      SELECT 
        COUNT(*) as total_notes,
        COUNT(CASE WHEN is_permanent THEN 1 END) as permanent_notes,
        COUNT(CASE WHEN scheduled_for IS NOT NULL THEN 1 END) as scheduled_notes,
        COALESCE(SUM(file_size_bytes), 0) as total_storage_bytes,
        COUNT(CASE WHEN created_at >= CURRENT_DATE - INTERVAL '7 days' THEN 1 END) as new_notes_7d
      FROM voice_notes
      WHERE deleted_at IS NULL
    `);

    // Get scheduled message statistics
    const scheduledStats = await pool.query(`
      SELECT 
        COUNT(*) as total_messages,
        COUNT(CASE WHEN delivery_status = 'scheduled' THEN 1 END) as pending_messages,
        COUNT(CASE WHEN delivery_status = 'delivered' THEN 1 END) as delivered_messages,
        COUNT(CASE WHEN delivery_status = 'failed' THEN 1 END) as failed_messages
      FROM scheduled_messages
    `);

    // Get revenue statistics (monthly)
    const revenueStats = await pool.query(`
      SELECT 
        EXTRACT(MONTH FROM created_at) as month,
        COUNT(*) as transactions,
        SUM(amount_cents) / 100 as revenue
      FROM billing_history
      WHERE status = 'paid'
        AND created_at >= CURRENT_DATE - INTERVAL '6 months'
      GROUP BY EXTRACT(MONTH FROM created_at)
      ORDER BY month DESC
    `);

    // Get system logs statistics
    const logStats = await pool.query(`
      SELECT 
        level,
        COUNT(*) as count
      FROM system_logs
      WHERE created_at >= CURRENT_DATE - INTERVAL '1 day'
      GROUP BY level
      ORDER BY count DESC
    `);

    res.json({
      success: true,
      data: {
        users: userStats.rows[0],
        voiceNotes: voiceStats.rows[0],
        scheduledMessages: scheduledStats.rows[0],
        revenue: revenueStats.rows,
        logs: logStats.rows,
        timestamp: new Date().toISOString()
      }
    });

  } catch (error) {
    console.error('Get admin overview error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch admin overview'
    });
  }
});

// User management routes (list, details, edit, delete, export, bulk) live in routes/adminUsers.js

// Get voice wills (admin view)
router.get('/wills', authenticateAdmin, async (req, res) => {
  try {
    const { page = 1, limit = 50, status, search } = req.query;
    const offset = (page - 1) * limit;

    let query = `
      SELECT 
        vw.*,
        u.email as user_email,
        u.full_name as user_name,
        (SELECT COUNT(*) FROM voice_wills) as total_count
      FROM voice_wills vw
      JOIN users u ON vw.user_id = u.id
      WHERE 1=1
    `;

    const queryParams = [];
    let paramCount = 1;

    // Apply filters
    if (status && status !== 'all') {
      if (status === 'pending') {
        query += ` AND vw.is_released = false`;
      } else if (status === 'released') {
        query += ` AND vw.is_released = true`;
      }
    }

    if (search) {
      query += ` AND (u.email ILIKE $${paramCount} OR u.full_name ILIKE $${paramCount} OR vw.title ILIKE $${paramCount})`;
      queryParams.push(`%${search}%`);
      paramCount++;
    }

    // Order and pagination
    query += ` ORDER BY vw.created_at DESC LIMIT $${paramCount} OFFSET $${paramCount + 1}`;
    queryParams.push(parseInt(limit), offset);

    const result = await pool.query(query, queryParams);

    // Get beneficiary names
    const willsWithDetails = await Promise.all(
      result.rows.map(async (will) => {
        let beneficiaryNames = [];
        if (will.beneficiaries && will.beneficiaries.length > 0) {
          const beneficiaryQuery = await pool.query(
            'SELECT name FROM contacts WHERE id = ANY($1)',
            [will.beneficiaries]
          );
          beneficiaryNames = beneficiaryQuery.rows.map(b => b.name);
        }

        return {
          ...will,
          beneficiaryNames
        };
      })
    );

    res.json({
      success: true,
      data: {
        wills: willsWithDetails,
        pagination: {
          page: parseInt(page),
          limit: parseInt(limit),
          total: result.rows[0]?.total_count || 0,
          totalPages: Math.ceil((result.rows[0]?.total_count || 0) / limit)
        }
      }
    });

  } catch (error) {
    console.error('Get admin wills error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch voice wills'
    });
  }
});

// Release voice will (admin)
router.post('/wills/:id/release', authenticateAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const { releaseNotes } = req.body;

    // Get will details
    const willQuery = await pool.query(
      `SELECT vw.*, u.email as user_email, u.full_name as user_name
       FROM voice_wills vw
       JOIN users u ON vw.user_id = u.id
       WHERE vw.id = $1`,
      [id]
    );

    if (willQuery.rows.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'Voice will not found'
      });
    }

    const will = willQuery.rows[0];

    if (will.is_released) {
      return res.status(400).json({
        success: false,
        error: 'Voice will is already released'
      });
    }

    // Update will as released
    await pool.query(
      `UPDATE voice_wills 
       SET is_released = true, 
           released_at = CURRENT_TIMESTAMP,
           released_by = $1,
           release_notes = $2
       WHERE id = $3`,
      [req.user.id, releaseNotes || null, id]
    );

    // TODO: Send notifications to beneficiaries/executors
    // TODO: Provide access to the voice recording

    logAdminAudit({ userId: req.user.id, action: 'RELEASE_WILL', targetId: id, oldValue: { is_released: false }, newValue: { is_released: true, releaseNotes }, ipAddress: req.ip });

    res.json({
      success: true,
      message: 'Voice will released successfully',
      data: {
        willId: id,
        releasedAt: new Date().toISOString(),
        releasedBy: req.user.id
      }
    });

  } catch (error) {
    console.error('Release voice will error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to release voice will'
    });
  }
});

// Delete voice will (admin)
router.delete('/wills/:id', authenticateAdmin, async (req, res) => {
  try {
    const { id } = req.params;

    const willQuery = await pool.query(
      `SELECT id, title, user_id FROM voice_wills WHERE id = $1`,
      [id]
    );

    if (willQuery.rows.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'Voice will not found'
      });
    }

    await pool.query(`DELETE FROM voice_wills WHERE id = $1`, [id]);

    logAdminAudit({ userId: req.user.id, action: 'DELETE_WILL', targetId: id, oldValue: willQuery.rows[0], newValue: null, ipAddress: req.ip });

    res.json({
      success: true,
      message: 'Voice will deleted successfully'
    });

  } catch (error) {
    console.error('Delete voice will error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to delete voice will'
    });
  }
});

// Get system logs
router.get('/logs', authenticateAdmin, async (req, res) => {
  try {
    const { page = 1, limit = 100, level, service, startDate, endDate, search } = req.query;
    const offset = (page - 1) * limit;

    let baseWhere = `WHERE 1=1`;
    const queryParams = [];
    let paramCount = 1;

    if (level && level !== 'all') {
      baseWhere += ` AND sl.level = $${paramCount}`;
      queryParams.push(level);
      paramCount++;
    }

    if (service && service !== 'all') {
      baseWhere += ` AND sl.service = $${paramCount}`;
      queryParams.push(service);
      paramCount++;
    }

    if (startDate) {
      baseWhere += ` AND sl.created_at >= $${paramCount}`;
      queryParams.push(new Date(startDate));
      paramCount++;
    }

    if (endDate) {
      baseWhere += ` AND sl.created_at <= $${paramCount}`;
      queryParams.push(new Date(endDate));
      paramCount++;
    }

    if (search) {
      baseWhere += ` AND (sl.message ILIKE $${paramCount} OR u.email ILIKE $${paramCount} OR sl.ip_address ILIKE $${paramCount})`;
      queryParams.push(`%${search}%`);
      paramCount++;
    }

    const countQuery = `
      SELECT COUNT(*) as total
      FROM system_logs sl
      LEFT JOIN users u ON sl.user_id = u.id
      ${baseWhere}
    `;

    const dataQuery = `
      SELECT sl.*, u.email as user_email
      FROM system_logs sl
      LEFT JOIN users u ON sl.user_id = u.id
      ${baseWhere}
      ORDER BY sl.created_at DESC
      LIMIT $${paramCount} OFFSET $${paramCount + 1}
    `;

    const countParams = [...queryParams];
    queryParams.push(parseInt(limit), parseInt(offset));

    const [countResult, dataResult] = await Promise.all([
      pool.query(countQuery, countParams),
      pool.query(dataQuery, queryParams)
    ]);

    const total = parseInt(countResult.rows[0].total);

    res.json({
      success: true,
      data: {
        logs: dataResult.rows,
        pagination: {
          page: parseInt(page),
          limit: parseInt(limit),
          total,
          totalPages: Math.ceil(total / parseInt(limit))
        }
      }
    });

  } catch (error) {
    console.error('Get system logs error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch system logs'
    });
  }
});

// Get system storage statistics
router.get('/storage', authenticateAdmin, async (req, res) => {
  try {
    // Get storage by bucket
    const storageByBucket = await pool.query(`
      SELECT 
        s3_bucket,
        COUNT(*) as file_count,
        COALESCE(SUM(file_size_bytes), 0) as total_bytes
      FROM voice_notes
      WHERE deleted_at IS NULL
      GROUP BY s3_bucket
      ORDER BY total_bytes DESC
    `);

    // Get storage by tier
    const storageByTier = await pool.query(`
      SELECT 
        u.subscription_tier,
        COUNT(DISTINCT u.id) as user_count,
        COUNT(vn.id) as note_count,
        COALESCE(SUM(vn.file_size_bytes), 0) as total_bytes
      FROM users u
      LEFT JOIN voice_notes vn ON u.id = vn.user_id AND vn.deleted_at IS NULL
      WHERE u.deleted_at IS NULL
      GROUP BY u.subscription_tier
      ORDER BY total_bytes DESC
    `);

    // Get storage growth (last 30 days)
    const storageGrowth = await pool.query(`
      SELECT 
        DATE(created_at) as date,
        COUNT(*) as new_files,
        COALESCE(SUM(file_size_bytes), 0) as new_storage_bytes
      FROM voice_notes
      WHERE created_at >= CURRENT_DATE - INTERVAL '30 days'
        AND deleted_at IS NULL
      GROUP BY DATE(created_at)
      ORDER BY date ASC
    `);

    // Get top users by storage
    const topUsers = await pool.query(`
      SELECT 
        u.email,
        u.full_name,
        u.subscription_tier,
        COUNT(vn.id) as note_count,
        COALESCE(SUM(vn.file_size_bytes), 0) as total_bytes
      FROM users u
      LEFT JOIN voice_notes vn ON u.id = vn.user_id AND vn.deleted_at IS NULL
      WHERE u.deleted_at IS NULL
      GROUP BY u.id, u.email, u.full_name, u.subscription_tier
      ORDER BY total_bytes DESC
      LIMIT 10
    `);

    res.json({
      success: true,
      data: {
        byBucket: storageByBucket.rows,
        byTier: storageByTier.rows,
        growth: storageGrowth.rows,
        topUsers: topUsers.rows,
        timestamp: new Date().toISOString()
      }
    });

  } catch (error) {
    console.error('Get storage stats error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch storage statistics'
    });
  }
});


// Get admin dashboard statistics (for sidebar counts)
router.get('/dashboard/stats', authenticateAdmin, async (req, res) => {
  try {
    // Get counts needed for admin sidebar
    const [
      usersCount,
      willsCount,
      scheduledMessagesCount,
      pendingRequestsCount,
      systemLogsCount,
      storageStats
    ] = await Promise.all([
      // Total users
      pool.query('SELECT COUNT(*) as count FROM users WHERE deleted_at IS NULL'),
      
      // Voice wills (total and pending release)
      pool.query(`
        SELECT 
          COUNT(*) as total,
          COUNT(CASE WHEN is_released = false THEN 1 END) as pending_release
        FROM voice_wills
      `),
      
      // Scheduled messages (total and scheduled)
      pool.query(`
        SELECT 
          COUNT(*) as total,
          COUNT(CASE WHEN delivery_status = 'scheduled' THEN 1 END) as scheduled
        FROM scheduled_messages
      `),
      
      // Pending admin requests
      pool.query(`SELECT COUNT(*) as count FROM users WHERE admin_status = 'pending'`),
      
      // Recent system logs (last 24 hours)
      pool.query(`
        SELECT COUNT(*) as count 
        FROM system_logs 
        WHERE created_at >= CURRENT_DATE - INTERVAL '1 day'
      `),
      
      // Storage usage summary
      pool.query(`
        SELECT 
          COUNT(*) as total_files,
          COALESCE(SUM(file_size_bytes), 0) as total_bytes
        FROM voice_notes
        WHERE deleted_at IS NULL
      `)
    ]);

    res.json({
      success: true,
      data: {
        // For admin sidebar counts
        users: parseInt(usersCount.rows[0].count),
        wills: {
          total: parseInt(willsCount.rows[0].total),
          pending: parseInt(willsCount.rows[0].pending_release)
        },
        scheduledMessages: {
          total: parseInt(scheduledMessagesCount.rows[0].total),
          scheduled: parseInt(scheduledMessagesCount.rows[0].scheduled)
        },
        pendingRequests: parseInt(pendingRequestsCount.rows[0].count),
        systemLogs: parseInt(systemLogsCount.rows[0].count),
        storage: {
          files: parseInt(storageStats.rows[0].total_files),
          bytes: parseInt(storageStats.rows[0].total_bytes),
          gb: Math.round(parseInt(storageStats.rows[0].total_bytes) / (1024 * 1024 * 1024) * 100) / 100
        },
        timestamp: new Date().toISOString()
      }
    });

  } catch (error) {
    console.error('Get admin dashboard stats error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch admin dashboard statistics'
    });
  }
});


// Get comprehensive admin dashboard data
// Counts cover customers only — admin accounts and admin-access applicants are left out.
const CUSTOMERS_CTE = `
  customers AS (
    SELECT * FROM users
    WHERE deleted_at IS NULL
      AND COALESCE(is_admin, false) = false
      AND COALESCE(admin_status, 'none') NOT IN ('pending', 'rejected')
  )`;

const userStatsSql = (activityColumn) => `
  WITH ${CUSTOMERS_CTE}
  SELECT
    COUNT(*)::int AS total_users,
    COUNT(*) FILTER (WHERE COALESCE(subscription_tier, 'LITE') = 'LITE')::int AS lite_users,
    COUNT(*) FILTER (WHERE subscription_tier = 'ESSENTIAL')::int AS essential_users,
    COUNT(*) FILTER (WHERE subscription_tier IN ('LEGACY_VAULT_PREMIUM', 'PREMIUM'))::int AS premium_users,
    COUNT(*) FILTER (WHERE subscription_status IN ('active', 'trialing'))::int AS active_users,
    COUNT(*) FILTER (WHERE ${activityColumn} >= NOW() - INTERVAL '15 minutes')::int AS active_now,
    COUNT(*) FILTER (WHERE ${activityColumn} >= NOW() - INTERVAL '24 hours')::int AS active_today,
    COUNT(*) FILTER (WHERE created_at >= NOW() - INTERVAL '7 days')::int AS new_users_7d,
    COUNT(*) FILTER (WHERE created_at >= NOW() - INTERVAL '30 days')::int AS new_users_30d,
    COUNT(*) FILTER (WHERE subscription_tier IN ('LEGACY_VAULT_PREMIUM', 'PREMIUM')
                       AND created_at < NOW() - INTERVAL '30 days')::int AS premium_users_30d_ago
  FROM customers`;

// Runs an optional dashboard query; one broken table shouldn't blank the whole dashboard
const safeQuery = async (sql, params, fallback) => {
  try {
    return (await pool.query(sql, params)).rows;
  } catch (error) {
    console.error('Dashboard query failed:', error.message);
    return fallback;
  }
};

router.get('/dashboard/overview', authenticateAdmin, async (req, res) => {
  try {
    const { getRevenueStats, monthBuckets } = require('../utils/revenueStats');
    const { getSystemHealth } = require('../utils/systemHealth');
    const chartStart = monthBuckets()[0].start;

    // last_active_at comes from migration 011; fall back to last_login until it's applied
    let userStats;
    try {
      userStats = (await pool.query(userStatsSql('last_active_at'))).rows[0];
      userStats.activity_source = 'last_active_at';
    } catch (error) {
      if (error.code !== '42703') throw error;
      userStats = (await pool.query(userStatsSql('last_login'))).rows[0];
      userStats.activity_source = 'last_login';
    }

    const [revenue, signups, recentActivity, platform, health] = await Promise.all([
      getRevenueStats(),
      safeQuery(
        `WITH ${CUSTOMERS_CTE}
         SELECT TO_CHAR(DATE_TRUNC('month', created_at), 'YYYY-MM') AS key, COUNT(*)::int AS count
         FROM customers WHERE created_at >= $1 GROUP BY 1`,
        [chartStart], []
      ),
      safeQuery(
        `SELECT sl.id, sl.message AS action, sl.service, sl.created_at AS time,
                CASE WHEN sl.level IN ('warn', 'warning') THEN 'warning' ELSE sl.level END AS status,
                u.full_name AS user_name, u.email AS user_email
         FROM system_logs sl
         LEFT JOIN users u ON sl.user_id = u.id
         WHERE sl.created_at >= NOW() - INTERVAL '7 days'
           AND sl.level IN ('info', 'warn', 'warning', 'error')
         ORDER BY sl.created_at DESC
         LIMIT 10`,
        [], []
      ),
      safeQuery(
        `SELECT
           (SELECT COALESCE(SUM(file_size_bytes), 0)::bigint FROM voice_notes WHERE deleted_at IS NULL) AS storage_bytes,
           (SELECT COUNT(*)::int FROM voice_notes WHERE deleted_at IS NULL) AS voice_notes,
           (SELECT COUNT(*)::int FROM scheduled_messages WHERE delivery_status = 'scheduled') AS scheduled_pending,
           (SELECT COUNT(*)::int FROM scheduled_messages
             WHERE delivery_status <> 'delivered' AND error_message IS NOT NULL
               AND updated_at >= NOW() - INTERVAL '24 hours') AS delivery_problems_24h,
           (SELECT COUNT(*)::int FROM system_logs
             WHERE message IN ('Failed login attempt', 'Failed 2FA attempt')
               AND created_at >= NOW() - INTERVAL '24 hours')
           + (SELECT COUNT(*)::int FROM login_attempts
             WHERE success = false AND is_admin_attempt = true
               AND created_at >= NOW() - INTERVAL '24 hours') AS failed_logins_24h`,
        [], [{}]
      ),
      getSystemHealth({ force: req.query.refresh === '1' })
    ]);

    const signupsByMonth = Object.fromEntries(signups.map(r => [r.key, r.count]));
    const monthly = revenue.monthly.map(m => ({ ...m, new_users: signupsByMonth[m.key] || 0 }));

    res.json({
      success: true,
      data: {
        userStats,
        revenue: {
          source: revenue.source,
          current_month_revenue: revenue.current_month_revenue,
          transaction_count: revenue.transaction_count,
          last_month_revenue: revenue.last_month_revenue,
          last_month_to_date_revenue: revenue.last_month_to_date_revenue,
          other_currencies: revenue.other_currencies
        },
        monthlyRevenue: monthly,
        recentActivity,
        systemHealth: health.services,
        healthCheckedAt: health.checkedAt,
        systemStatus: health.overall,
        platform: platform[0] || {},
        lastUpdated: new Date().toISOString()
      }
    });

  } catch (error) {
    console.error('Get admin dashboard overview error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch dashboard overview'
    });
  }
});


// Audit log — every admin action recorded by logAdminAudit, newest first
router.get('/audit-log', authenticateAdmin, async (req, res) => {
  try {
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 25, 1), 100);
    const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
    const params = [];
    const where = [];
    if (req.query.action) {
      params.push(req.query.action);
      where.push(`a.action = $${params.length}`);
    }
    if (req.query.search) {
      params.push(`%${req.query.search}%`);
      where.push(`(u.email ILIKE $${params.length} OR u.full_name ILIKE $${params.length} OR a.target_id ILIKE $${params.length})`);
    }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

    const [rows, total, actions] = await Promise.all([
      pool.query(
        `SELECT a.id, a.action, a.target_id, a.old_value, a.new_value, a.ip_address::text AS ip_address, a.created_at,
                u.full_name AS admin_name, u.email AS admin_email
         FROM admin_audit_log a
         LEFT JOIN users u ON u.id = a.admin_user_id
         ${whereSql}
         ORDER BY a.created_at DESC
         LIMIT ${limit} OFFSET ${(page - 1) * limit}`,
        params
      ),
      pool.query(`SELECT COUNT(*)::int AS count FROM admin_audit_log a LEFT JOIN users u ON u.id = a.admin_user_id ${whereSql}`, params),
      pool.query('SELECT DISTINCT action FROM admin_audit_log ORDER BY action')
    ]);

    res.json({
      success: true,
      data: {
        entries: rows.rows,
        actions: actions.rows.map(r => r.action),
        pagination: { page, limit, total: total.rows[0].count, pages: Math.max(1, Math.ceil(total.rows[0].count / limit)) }
      }
    });
  } catch (error) {
    console.error('Get audit log error:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch audit log' });
  }
});

// Admin console sign-in attempts (successful and failed), newest first
router.get('/admin-login-attempts', authenticateAdmin, async (req, res) => {
  try {
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 25, 1), 100);
    const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
    const params = [];
    let whereSql = 'WHERE is_admin_attempt = true';
    if (req.query.result === 'failed') whereSql += ' AND success = false';
    if (req.query.result === 'success') whereSql += ' AND success = true';
    if (req.query.search) {
      params.push(`%${req.query.search}%`);
      whereSql += ` AND (email ILIKE $1 OR ip_address::text ILIKE $1)`;
    }

    const [rows, total] = await Promise.all([
      pool.query(
        `SELECT id, email, ip_address::text AS ip_address, user_agent, success, failure_reason, created_at
         FROM login_attempts ${whereSql}
         ORDER BY created_at DESC
         LIMIT ${limit} OFFSET ${(page - 1) * limit}`,
        params
      ),
      pool.query(`SELECT COUNT(*)::int AS count FROM login_attempts ${whereSql}`, params)
    ]);

    res.json({
      success: true,
      data: {
        attempts: rows.rows,
        pagination: { page, limit, total: total.rows[0].count, pages: Math.max(1, Math.ceil(total.rows[0].count / limit)) }
      }
    });
  } catch (error) {
    console.error('Get admin login attempts error:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch sign-in attempts' });
  }
});

// Request admin access
router.post('/register-request', authenticate, [
    body('email').isEmail().normalizeEmail(),
    body('phone').isMobilePhone(),
    body('fullName').notEmpty().trim(),
    body('password').isLength({ min: 12 }),
    body('reason').notEmpty().trim(),
    body('department').optional().trim(),
    body('requestedBy').optional().trim()
  ], async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({
          success: false,
          errors: errors.array()
        });
      }
  
      const { 
        email, phone, fullName, password, reason, department, requestedBy 
      } = req.body;
  
      // Check if user already exists
      const existingUser = await pool.query(
        'SELECT id FROM users WHERE email = $1',
        [email]
      );
  
      if (existingUser.rows.length > 0) {
        return res.status(400).json({
          success: false,
          error: 'User with this email already exists'
        });
      }
  
      // Hash password
      const saltRounds = 10;
      const passwordHash = await bcrypt.hash(password, saltRounds);
  
      // Create user with pending admin status
      const newUser = await pool.query(
        `INSERT INTO users (
          email, phone, full_name, password_hash, 
          subscription_tier, is_admin, admin_status, admin_reason, admin_department,
          requested_by_admin_id, subscription_status
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
        RETURNING id, email, full_name, admin_status, created_at`,
        [
          email,
          phone,
          fullName,
          passwordHash,
          'ESSENTIAL', // Default tier
          false, // Not admin yet
          'pending', // Admin status: pending, approved, rejected
          reason,
          department || null,
          requestedBy || req.user?.id || null,
          'inactive' // Wait for admin approval
        ]
      );
  
      // Log the admin request
      await pool.query(
        `INSERT INTO system_logs (user_id, level, service, message, metadata)
         VALUES ($1, 'info', 'admin', 'Admin access requested', $2)`,
        [
          newUser.rows[0].id,
          JSON.stringify({
            requestedBy: requestedBy || 'self',
            reason: reason,
            department: department
          })
        ]
      );
  
      // TODO: Send notification to existing admins
      // TODO: Send email confirmation to requester
  
      res.status(201).json({
        success: true,
        message: 'Admin access request submitted successfully',
        data: {
          requestId: newUser.rows[0].id,
          status: 'pending',
          estimatedReviewTime: '24-48 hours'
        }
      });
  
    } catch (error) {
      console.error('Admin registration request error:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to submit admin request'
      });
    }
  });
  
  // Get pending admin requests (for existing admins)
  router.get('/pending-requests', authenticateAdmin, async (req, res) => {
    try {
      const { page = 1, limit = 20, status } = req.query;
      const offset = (page - 1) * limit;

      const queryParams = [];
      let whereClause = `WHERE u.admin_status IN ('pending', 'approved', 'rejected')`;

      if (status && status !== 'all') {
        queryParams.push(status);
        whereClause = `WHERE u.admin_status = $${queryParams.length}`;
      }

      queryParams.push(parseInt(limit), offset);
      const limitParam = queryParams.length - 1;
      const offsetParam = queryParams.length;

      const result = await pool.query(
        `SELECT
            u.id,
            u.email,
            u.phone,
            u.full_name,
            u.admin_reason,
            u.admin_department,
            u.admin_status,
            u.requested_by_admin_id,
            u.created_at,
            ru.full_name AS requested_by_name,
            COUNT(*) OVER() AS total_count
            FROM users u
            LEFT JOIN users ru ON u.requested_by_admin_id = ru.id
            ${whereClause}
            ORDER BY u.created_at DESC
            LIMIT $${limitParam} OFFSET $${offsetParam}
            `,
        queryParams
      );

      res.json({
        success: true,
        data: {
          requests: result.rows.map(r => ({
            ...r,
            status: r.admin_status,
            reason: r.admin_reason
          })),
          pagination: {
            page: parseInt(page),
            limit: parseInt(limit),
            total: parseInt(result.rows[0]?.total_count || 0),
            totalPages: Math.ceil((result.rows[0]?.total_count || 0) / limit)
          }
        }
      });

    } catch (error) {
      console.error('Get pending requests error:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to fetch pending requests'
      });
    }
  });
  
  // Approve/Reject admin request
  router.post('/requests/:id/action', authenticateAdmin, [
    body('action').isIn(['approve', 'reject']),
    body('notes').optional().trim()
  ], async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({
          success: false,
          errors: errors.array()
        });
      }
  
      const { id } = req.params;
      const { action, notes } = req.body;
  
      // Get the request
      const requestQuery = await pool.query(
        `SELECT id, email, admin_status FROM users WHERE id = $1`,
        [id]
      );
  
      if (requestQuery.rows.length === 0) {
        return res.status(404).json({
          success: false,
          error: 'Request not found'
        });
      }
  
      const request = requestQuery.rows[0];
  
      if (request.admin_status !== 'pending') {
        return res.status(400).json({
          success: false,
          error: `Request is already ${request.admin_status}`
        });
      }
  
      // Update user based on action
      if (action === 'approve') {
        await pool.query(
          `UPDATE users 
           SET is_admin = true, 
               admin_status = 'approved',
               approved_by_admin_id = $1,
               approved_at = CURRENT_TIMESTAMP,
               subscription_status = 'active',
               updated_at = CURRENT_TIMESTAMP
           WHERE id = $2`,
          [req.user.id, id]
        );
  
        // TODO: Send approval email
        // TODO: Log approval
  
      } else if (action === 'reject') {
        await pool.query(
          `UPDATE users 
           SET admin_status = 'rejected',
               rejected_by_admin_id = $1,
               rejected_at = CURRENT_TIMESTAMP,
               rejection_notes = $2,
               updated_at = CURRENT_TIMESTAMP
           WHERE id = $3`,
          [req.user.id, notes || null, id]
        );
  
        // TODO: Send rejection email
      }
  
      res.json({
        success: true,
        message: `Admin request ${action}d successfully`
      });
  
    } catch (error) {
      console.error('Process admin request error:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to process admin request'
      });
    }
  });  

  router.post('/admin/request', async (req, res) => {
    try {
      const { email, phone, password, fullName, department, reason } = req.body;
  
      const passwordHash = await bcrypt.hash(password, 10);
  
      await pool.query(
        `INSERT INTO users (
          email, phone, password_hash, full_name,
          is_admin, admin_status
        ) VALUES ($1, $2, $3, $4, false, 'pending')`,
        [email, phone, passwordHash, fullName]
      );
  
      res.status(201).json({
        success: true,
        message: 'Admin request submitted and pending approval'
      });
  
    } catch (error) {
      res.status(500).json({
        success: false,
        error: 'Failed to submit admin request'
      });
    }
  });

  router.post('/admin/approve', authenticateAdmin, async (req, res) => {
    const { userId } = req.body;
  
    await pool.query(
      `UPDATE users 
       SET is_admin = true, admin_status = 'approved'
       WHERE id = $1`,
      [userId]
    );
  
    res.json({ success: true, message: 'Admin approved' });
  });

  router.get('/admin/pending', authenticateAdmin, async (req, res) => {
    const result = await pool.query(
      `SELECT id, email, full_name, created_at 
       FROM users WHERE admin_status = 'pending'`
    );
  
    res.json({ success: true, data: result.rows });
  });
  
  router.post('/admin/reject', authenticateAdmin, async (req, res) => {
    const { userId } = req.body;
  
    await pool.query(
      `UPDATE users 
       SET admin_status = 'rejected'
       WHERE id = $1`,
      [userId]
    );
  
    res.json({ success: true, message: 'Admin rejected' });
  });

  // Add this to your admin.js file, before the module.exports = router;

// Get all scheduled messages (admin view)
router.get('/scheduled-messages', authenticateAdmin, async (req, res) => {
  try {
    const { page = 1, limit = 50, status, search, deliveryMethod, startDate, endDate } = req.query;
    const offset = (page - 1) * limit;

    let query = `
      SELECT 
        sm.*,
        u.email as user_email,
        u.full_name as user_name,
        vn.title as voice_note_title,
        c.name as recipient_name,
        c.phone as recipient_contact_phone,
        c.email as recipient_contact_email,
        (SELECT COUNT(*) FROM scheduled_messages sm2
         LEFT JOIN users u2 ON sm2.user_id = u2.id
         LEFT JOIN voice_notes vn2 ON sm2.voice_note_id = vn2.id
         WHERE 1=1) as total_count
      FROM scheduled_messages sm
      LEFT JOIN users u ON sm.user_id = u.id
      LEFT JOIN voice_notes vn ON sm.voice_note_id = vn.id
      LEFT JOIN contacts c ON sm.recipient_contact_id = c.id
      WHERE 1=1
    `;

    const queryParams = [];
    let paramCount = 1;

    // Apply status filter
    if (status && status !== 'all') {
      query += ` AND sm.delivery_status = $${paramCount}`;
      queryParams.push(status);
      paramCount++;
    }

    // Apply delivery method filter
    if (deliveryMethod && deliveryMethod !== 'all') {
      query += ` AND sm.delivery_method = $${paramCount}`;
      queryParams.push(deliveryMethod);
      paramCount++;
    }

    // Apply search filter
    if (search) {
      query += ` AND (
        u.email ILIKE $${paramCount} OR 
        u.full_name ILIKE $${paramCount} OR 
        vn.title ILIKE $${paramCount} OR
        c.name ILIKE $${paramCount}
      )`;
      queryParams.push(`%${search}%`);
      paramCount++;
    }

    // Apply date range filter
    if (startDate) {
      query += ` AND sm.scheduled_for >= $${paramCount}`;
      queryParams.push(new Date(startDate));
      paramCount++;
    }

    if (endDate) {
      query += ` AND sm.scheduled_for <= $${paramCount}`;
      queryParams.push(new Date(endDate));
      paramCount++;
    }

    // Order and pagination
    query += ` ORDER BY sm.scheduled_for DESC LIMIT $${paramCount} OFFSET $${paramCount + 1}`;
    queryParams.push(parseInt(limit), offset);

    const result = await pool.query(query, queryParams);

    // Format the data
    const formattedMessages = result.rows.map(message => ({
      id: message.id,
      title: message.voice_note_title || 'Untitled Message',
      user: message.user_name || message.user_email,
      recipient: message.recipient_name || message.recipient_phone || message.recipient_contact_email || 'Unknown',
      scheduledFor: message.scheduled_for,
      status: message.delivery_status,
      method: message.delivery_method,
      attempts: message.delivery_attempts || 0,
      priority: message.metadata?.priority || 'medium',
      createdAt: message.created_at,
      scheduledAt: message.scheduled_for,
      deliveredAt: message.delivered_at,
      failedAt: message.failed_at,
      errorMessage: message.error_message,
      userId: message.user_id,
      voiceNoteId: message.voice_note_id,
      recipientContactId: message.recipient_contact_id
    }));

    res.json({
      success: true,
      data: {
        messages: formattedMessages,
        pagination: {
          page: parseInt(page),
          limit: parseInt(limit),
          total: result.rows[0]?.total_count || 0,
          totalPages: Math.ceil((result.rows[0]?.total_count || 0) / limit)
        }
      }
    });

  } catch (error) {
    console.error('Get admin scheduled messages error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch scheduled messages'
    });
  }
});

// Get scheduled message statistics for admin dashboard
router.get('/scheduled-messages/stats', authenticateAdmin, async (req, res) => {
  try {
    const { period = 'today' } = req.query; // today, week, month, year
    
    let dateFilter = '';
    switch (period) {
      case 'today':
        dateFilter = "AND DATE(sm.created_at) = CURRENT_DATE";
        break;
      case 'week':
        dateFilter = "AND sm.created_at >= CURRENT_DATE - INTERVAL '7 days'";
        break;
      case 'month':
        dateFilter = "AND sm.created_at >= CURRENT_DATE - INTERVAL '30 days'";
        break;
      case 'year':
        dateFilter = "AND sm.created_at >= CURRENT_DATE - INTERVAL '365 days'";
        break;
      default:
        dateFilter = "";
    }

    const statsQuery = await pool.query(`
      SELECT 
        COUNT(*) as total_messages,
        COUNT(CASE WHEN sm.delivery_status = 'scheduled' THEN 1 END) as scheduled,
        COUNT(CASE WHEN sm.delivery_status = 'delivered' THEN 1 END) as delivered,
        COUNT(CASE WHEN sm.delivery_status = 'failed' THEN 1 END) as failed,
        COUNT(CASE WHEN sm.delivery_status = 'cancelled' THEN 1 END) as cancelled,
        COUNT(CASE WHEN sm.delivery_method = 'phone' THEN 1 END) as phone_messages,
        COUNT(CASE WHEN sm.delivery_method = 'email' THEN 1 END) as email_messages,
        COUNT(CASE WHEN sm.delivery_method = 'both' THEN 1 END) as both_messages,
        COALESCE(SUM(CASE WHEN sm.delivery_status = 'delivered' THEN 1 ELSE 0 END) * 100.0 / NULLIF(COUNT(*), 0), 100) as success_rate
      FROM scheduled_messages sm
      WHERE 1=1 ${dateFilter}
    `);

    // Get hourly delivery data for chart
    const hourlyDataQuery = await pool.query(`
      SELECT 
        EXTRACT(HOUR FROM COALESCE(sm.delivered_at, sm.created_at)) as hour,
        COUNT(CASE WHEN sm.delivery_status = 'delivered' THEN 1 END) as sent,
        COUNT(CASE WHEN sm.delivery_status = 'failed' THEN 1 END) as failed
      FROM scheduled_messages sm
      WHERE DATE(COALESCE(sm.delivered_at, sm.created_at)) = CURRENT_DATE
        AND (sm.delivery_status = 'delivered' OR sm.delivery_status = 'failed')
      GROUP BY EXTRACT(HOUR FROM COALESCE(sm.delivered_at, sm.created_at))
      ORDER BY hour
    `);

    // Format hourly data
    const deliveryData = Array.from({ length: 24 }, (_, i) => {
      const hourData = hourlyDataQuery.rows.find(row => parseInt(row.hour) === i);
      return {
        hour: `${i.toString().padStart(2, '0')}:00`,
        sent: hourData ? parseInt(hourData.sent) : 0,
        failed: hourData ? parseInt(hourData.failed) : 0
      };
    }).filter((_, i) => i % 4 === 0 || i === 23); // Show every 4 hours plus last hour

    res.json({
      success: true,
      data: {
        ...statsQuery.rows[0],
        deliveryData,
        period,
        timestamp: new Date().toISOString()
      }
    });

  } catch (error) {
    console.error('Get scheduled messages stats error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch scheduled messages statistics'
    });
  }
});

// Update scheduled message status (admin)
router.put('/scheduled-messages/:id/status', authenticateAdmin, [
  body('status').isIn(['scheduled', 'cancelled', 'paused', 'delivered']),
  body('notes').optional().trim()
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({
        success: false,
        errors: errors.array()
      });
    }

    const { id } = req.params;
    const { status, notes } = req.body;

    // Check if message exists
    const messageCheck = await pool.query(
      'SELECT id FROM scheduled_messages WHERE id = $1',
      [id]
    );

    if (messageCheck.rows.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'Scheduled message not found'
      });
    }

    let updateQuery = '';
    let updateParams = [status, id];
    
    if (status === 'delivered') {
      updateQuery = `
        UPDATE scheduled_messages 
        SET delivery_status = $1,
            delivered_at = CURRENT_TIMESTAMP,
            updated_at = CURRENT_TIMESTAMP,
            metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object('admin_notes', $3)
        WHERE id = $2
        RETURNING *
      `;
      updateParams.push(notes || 'Delivered by admin');
    } else if (status === 'cancelled') {
      updateQuery = `
        UPDATE scheduled_messages 
        SET delivery_status = $1,
            cancelled_at = CURRENT_TIMESTAMP,
            updated_at = CURRENT_TIMESTAMP,
            metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object('admin_notes', $3)
        WHERE id = $2
        RETURNING *
      `;
      updateParams.push(notes || 'Cancelled by admin');
    } else {
      updateQuery = `
        UPDATE scheduled_messages 
        SET delivery_status = $1,
            updated_at = CURRENT_TIMESTAMP,
            metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object('admin_notes', $3)
        WHERE id = $2
        RETURNING *
      `;
      updateParams.push(notes || 'Status updated by admin');
    }

    const result = await pool.query(updateQuery, updateParams);

    // Log the action
    await pool.query(
      `INSERT INTO system_logs (user_id, level, service, message, metadata)
       VALUES ($1, 'info', 'admin', 'Scheduled message status updated', $2)`,
      [req.user.id, JSON.stringify({
        messageId: id,
        newStatus: status,
        notes: notes
      })]
    );

    logAdminAudit({ userId: req.user.id, action: 'UPDATE_SCHEDULED_MSG_STATUS', targetId: id, newValue: { status, notes }, ipAddress: req.ip });

    res.json({
      success: true,
      message: `Message status updated to ${status}`,
      data: result.rows[0]
    });

  } catch (error) {
    console.error('Update scheduled message status error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to update message status'
    });
  }
});

// Cancel scheduled message (admin)
router.delete('/scheduled-messages/:id', authenticateAdmin, async (req, res) => {
  try {
    const { id } = req.params;

    // Check if message exists
    const messageCheck = await pool.query(
      'SELECT id, delivery_status FROM scheduled_messages WHERE id = $1',
      [id]
    );

    if (messageCheck.rows.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'Scheduled message not found'
      });
    }

    const message = messageCheck.rows[0];

    // Don't allow cancellation of already delivered messages
    if (message.delivery_status === 'delivered') {
      return res.status(400).json({
        success: false,
        error: 'Cannot cancel already delivered message'
      });
    }

    // Update status to cancelled
    await pool.query(
      `UPDATE scheduled_messages 
       SET delivery_status = 'cancelled',
           cancelled_at = CURRENT_TIMESTAMP,
           updated_at = CURRENT_TIMESTAMP,
           metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object('admin_notes', 'Cancelled by admin')
       WHERE id = $1`,
      [id]
    );

    // Log the action
    await pool.query(
      `INSERT INTO system_logs (user_id, level, service, message, metadata)
       VALUES ($1, 'warn', 'admin', 'Scheduled message cancelled', $2)`,
      [req.user.id, JSON.stringify({ messageId: id })]
    );

    logAdminAudit({ userId: req.user.id, action: 'DELETE_SCHEDULED_MSG', targetId: id, ipAddress: req.ip });

    res.json({
      success: true,
      message: 'Scheduled message cancelled successfully'
    });

  } catch (error) {
    console.error('Cancel scheduled message error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to cancel scheduled message'
    });
  }
});

// Export logs (CSV/Excel)
router.get('/logs/export', authenticateAdmin, async (req, res) => {
  try {
    const { format = 'csv', level, service, startDate, endDate, search } = req.query;

    // Build query based on filters
    let query = `
      SELECT 
        sl.id,
        sl.level,
        sl.service,
        sl.message,
        sl.metadata,
        sl.ip,
        sl.user_agent,
        sl.created_at,
        u.email as user_email,
        u.full_name as user_name
      FROM system_logs sl
      LEFT JOIN users u ON sl.user_id = u.id
      WHERE 1=1
    `;

    const queryParams = [];
    let paramCount = 1;

    // Apply filters
    if (level && level !== 'all') {
      query += ` AND sl.level = $${paramCount}`;
      queryParams.push(level);
      paramCount++;
    }

    if (service && service !== 'all') {
      query += ` AND sl.service = $${paramCount}`;
      queryParams.push(service);
      paramCount++;
    }

    if (startDate) {
      query += ` AND sl.created_at >= $${paramCount}`;
      queryParams.push(new Date(startDate));
      paramCount++;
    }

    if (endDate) {
      query += ` AND sl.created_at <= $${paramCount}`;
      queryParams.push(new Date(endDate));
      paramCount++;
    }

    if (search) {
      query += ` AND (
        sl.message ILIKE $${paramCount} OR 
        sl.service ILIKE $${paramCount} OR 
        u.email ILIKE $${paramCount}
      )`;
      queryParams.push(`%${search}%`);
      paramCount++;
    }

    query += ' ORDER BY sl.created_at DESC';

    const result = await pool.query(query, queryParams);

    // Format the data for export
    const logs = result.rows.map(log => ({
      'ID': log.id,
      'Level': log.level,
      'Service': log.service,
      'Message': log.message,
      'User Email': log.user_email || 'System',
      'User Name': log.user_name || 'System',
      'IP Address': log.ip || '',
      'User Agent': log.user_agent || '',
      'Metadata': log.metadata ? JSON.stringify(log.metadata) : '',
      'Timestamp': new Date(log.created_at).toISOString(),
      'Date': new Date(log.created_at).toLocaleDateString(),
      'Time': new Date(log.created_at).toLocaleTimeString()
    }));

    if (format === 'csv') {
      // Convert to CSV
      const headers = Object.keys(logs[0] || {});
      const csvRows = [headers.join(',')];
      
      for (const log of logs) {
        const row = headers.map(header => {
          const value = log[header];
          // Escape quotes and wrap in quotes if contains comma
          const escaped = String(value).replace(/"/g, '""');
          return escaped.includes(',') || escaped.includes('"') || escaped.includes('\n') 
            ? `"${escaped}"` 
            : escaped;
        });
        csvRows.push(row.join(','));
      }

      const csvContent = csvRows.join('\n');
      
      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', `attachment; filename=system_logs_export_${Date.now()}.csv`);
      res.send(csvContent);

    } else if (format === 'json') {
      // Return as JSON
      res.json({
        success: true,
        data: logs,
        metadata: {
          total: logs.length,
          exportedAt: new Date().toISOString(),
          exportedBy: req.user.id,
          filters: { level, service, startDate, endDate }
        }
      });

    } else {
      res.status(400).json({
        success: false,
        error: 'Unsupported export format. Use csv or json'
      });
    }

  } catch (error) {
    console.error('Export logs error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to export logs'
    });
  }
});


// Get bucket details
router.get('/storage/bucket/:bucketName', authenticateAdmin, async (req, res) => {
  try {
    const { bucketName } = req.params;
    
    // Get bucket statistics
    const bucketStats = await pool.query(`
      SELECT 
        s3_bucket,
        COUNT(*) as file_count,
        COALESCE(SUM(file_size_bytes), 0) as total_bytes,
        COUNT(CASE WHEN storage_class = 'STANDARD' THEN 1 END) as standard_files,
        COUNT(CASE WHEN storage_class = 'GLACIER' THEN 1 END) as glacier_files,
        COUNT(CASE WHEN storage_class = 'STANDARD_IA' THEN 1 END) as ia_files,
        MIN(created_at) as oldest_file,
        MAX(created_at) as newest_file
      FROM voice_notes
      WHERE s3_bucket = $1 AND deleted_at IS NULL
      GROUP BY s3_bucket
    `, [bucketName]);

    if (bucketStats.rows.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'Bucket not found or empty'
      });
    }

    const stats = bucketStats.rows[0];
    const totalGB = Math.round(stats.total_bytes / (1024 * 1024 * 1024));
    const monthlyCost = Math.round(totalGB * 0.023); // AWS pricing estimate

    // Get recent files
    const recentFiles = await pool.query(`
      SELECT 
        s3_key as key,
        file_size_bytes as size_bytes,
        storage_class,
        created_at,
        updated_at
      FROM voice_notes
      WHERE s3_bucket = $1 AND deleted_at IS NULL
      ORDER BY updated_at DESC
      LIMIT 20
    `, [bucketName]);

    // Get activity logs for this bucket
    const activityLogs = await pool.query(`
      SELECT 
        action,
        resource_key,
        user_id,
        created_at,
        status
      FROM system_logs
      WHERE service = 'storage' 
        AND metadata->>'bucket' = $1
      ORDER BY created_at DESC
      LIMIT 10
    `, [bucketName]);

    // Get metrics for last 7 days
    const metrics = await pool.query(`
      SELECT 
        DATE(created_at) as date,
        COUNT(*) as file_count,
        COALESCE(SUM(file_size_bytes), 0) as size_bytes
      FROM voice_notes
      WHERE s3_bucket = $1 
        AND created_at >= CURRENT_DATE - INTERVAL '7 days'
        AND deleted_at IS NULL
      GROUP BY DATE(created_at)
      ORDER BY date
    `, [bucketName]);

    res.json({
      success: true,
      data: {
        name: stats.s3_bucket,
        size: `${totalGB} GB`,
        objects: stats.file_count.toLocaleString(),
        cost: `$${monthlyCost}/month`,
        status: 'healthy',
        storageClasses: {
          standard: stats.standard_files,
          glacier: stats.glacier_files,
          standard_ia: stats.ia_files
        },
        timeline: {
          oldest: stats.oldest_file,
          newest: stats.newest_file
        },
        files: recentFiles.rows.map(file => ({
          key: file.key,
          size: `${Math.round(file.size_bytes / (1024 * 1024))} MB`,
          storageClass: file.storage_class,
          lastModified: file.updated_at || file.created_at
        })),
        activity: activityLogs.rows.map(log => ({
          action: log.action,
          key: log.resource_key,
          user: log.user_id,
          time: log.created_at,
          status: log.status
        })),
        metrics: metrics.rows.map(metric => ({
          date: metric.date,
          files: metric.file_count,
          size: Math.round(metric.size_bytes / (1024 * 1024 * 1024)),
          cost: Math.round(metric.size_bytes / (1024 * 1024 * 1024) * 0.023)
        }))
      }
    });

  } catch (error) {
    console.error('Get bucket details error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch bucket details'
    });
  }
});

// Add lifecycle rule
router.post('/storage/lifecycle-rules', authenticateAdmin, [
  body('name').notEmpty().trim(),
  body('bucket').optional().trim(),
  body('actionType').isIn(['transition', 'expire', 'abort']),
  body('days').isInt({ min: 1 }),
  body('storageClass').optional().isIn(['STANDARD', 'STANDARD_IA', 'GLACIER', 'DEEP_ARCHIVE']),
  body('description').optional().trim(),
  body('status').optional().isIn(['active', 'paused'])
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({
        success: false,
        errors: errors.array()
      });
    }

    const {
      name,
      bucket,
      actionType,
      days,
      storageClass,
      description,
      status = 'active'
    } = req.body;

    // Create lifecycle rule
    const result = await pool.query(
      `INSERT INTO lifecycle_rules (
        name, bucket, action_type, days, storage_class,
        description, status, created_by
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      RETURNING *`,
      [
        name,
        bucket || null,
        actionType,
        days,
        storageClass || null,
        description || '',
        status,
        req.user.id
      ]
    );

    // Log the action
    await pool.query(
      `INSERT INTO system_logs (user_id, level, service, message, metadata)
       VALUES ($1, 'info', 'storage', 'Lifecycle rule created', $2)`,
      [req.user.id, JSON.stringify({
        ruleId: result.rows[0].id,
        ruleName: name,
        bucket: bucket || 'all'
      })]
    );

    logAdminAudit({ userId: req.user.id, action: 'CREATE_LIFECYCLE_RULE', targetId: result.rows[0].id, newValue: req.body, ipAddress: req.ip });

    res.status(201).json({
      success: true,
      message: 'Lifecycle rule created successfully',
      data: result.rows[0]
    });

  } catch (error) {
    console.error('Create lifecycle rule error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to create lifecycle rule'
    });
  }
});

// Get lifecycle rules
router.get('/storage/lifecycle-rules', authenticateAdmin, async (req, res) => {
  try {
    const { bucket, status } = req.query;

    let query = `
      SELECT lr.*, u.email as created_by_email
      FROM lifecycle_rules lr
      LEFT JOIN users u ON lr.created_by = u.id
      WHERE 1=1
    `;
    
    const params = [];
    let paramCount = 1;

    if (bucket) {
      query += ` AND (lr.bucket = $${paramCount} OR lr.bucket IS NULL)`;
      params.push(bucket);
      paramCount++;
    }

    if (status && status !== 'all') {
      query += ` AND lr.status = $${paramCount}`;
      params.push(status);
      paramCount++;
    }

    query += ' ORDER BY lr.created_at DESC';

    const result = await pool.query(query, params);

    // Get execution history for each rule
    const rulesWithHistory = await Promise.all(
      result.rows.map(async (rule) => {
        const history = await pool.query(
          `SELECT * FROM rule_executions 
           WHERE rule_id = $1 
           ORDER BY executed_at DESC 
           LIMIT 5`,
          [rule.id]
        );

        const lastRun = await pool.query(
          `SELECT executed_at, status 
           FROM rule_executions 
           WHERE rule_id = $1 
           ORDER BY executed_at DESC 
           LIMIT 1`,
          [rule.id]
        );

        return {
          ...rule,
          executionHistory: history.rows,
          lastRun: lastRun.rows[0]?.executed_at || null,
          lastStatus: lastRun.rows[0]?.status || 'never'
        };
      })
    );

    res.json({
      success: true,
      data: rulesWithHistory
    });

  } catch (error) {
    console.error('Get lifecycle rules error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch lifecycle rules'
    });
  }
});

// Update storage configuration
router.put('/storage/config', authenticateAdmin, [
  body('defaultStorageClass').optional().isIn(['STANDARD', 'STANDARD_IA', 'GLACIER']),
  body('encryptionEnabled').optional().isBoolean(),
  body('versioningEnabled').optional().isBoolean(),
  body('intelligentTiering').optional().isBoolean(),
  body('costAlerts').optional().isBoolean(),
  body('costThreshold').optional().isInt({ min: 1 }),
  body('autoBackupEnabled').optional().isBoolean(),
  body('backupFrequency').optional().isIn(['daily', 'weekly', 'monthly']),
  body('crossRegionReplication').optional().isBoolean()
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({
        success: false,
        errors: errors.array()
      });
    }

    const updates = [];
    const values = [];
    let paramCount = 1;

    // Build dynamic update query
    Object.entries(req.body).forEach(([key, value]) => {
      updates.push(`${key} = $${paramCount}`);
      values.push(value);
      paramCount++;
    });

    if (updates.length === 0) {
      return res.status(400).json({
        success: false,
        error: 'No updates provided'
      });
    }

    values.push(req.user.id);
    paramCount++;

    // Update or insert configuration
    const query = `
      INSERT INTO storage_config (${Object.keys(req.body).join(', ')}, updated_by, updated_at)
      VALUES (${values.map((_, i) => `$${i + 1}`).join(', ')})
      ON CONFLICT (id) DO UPDATE SET
        ${updates.join(', ')},
        updated_by = $${paramCount - 1},
        updated_at = CURRENT_TIMESTAMP
      RETURNING *
    `;

    const result = await pool.query(query, values);

    // Log the configuration change
    await pool.query(
      `INSERT INTO system_logs (user_id, level, service, message, metadata)
       VALUES ($1, 'info', 'storage', 'Storage configuration updated', $2)`,
      [req.user.id, JSON.stringify(req.body)]
    );

    logAdminAudit({ userId: req.user.id, action: 'UPDATE_STORAGE_CONFIG', newValue: req.body, ipAddress: req.ip });

    res.json({
      success: true,
      message: 'Storage configuration updated successfully',
      data: result.rows[0]
    });

  } catch (error) {
    console.error('Update storage config error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to update storage configuration'
    });
  }
});

// Process uploaded storage report
router.post('/storage/upload-report', authenticateAdmin, async (req, res) => {
  try {
    // Since reports might not be audio files, you need a custom upload handler
    // Create a separate multer configuration for reports
    const reportUpload = multer({
      storage: multer.memoryStorage(),
      limits: {
        fileSize: 100 * 1024 * 1024, // 100MB
        files: 1
      },
      fileFilter: (req, file, cb) => {
        const allowedTypes = [
          'text/csv',
          'application/vnd.ms-excel',
          'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
          'application/json'
        ];
        
        if (allowedTypes.includes(file.mimetype)) {
          cb(null, true);
        } else {
          cb(new Error('Invalid file type. Only CSV, Excel, and JSON files are allowed.'));
        }
      }
    }).single('report');

    // Use the multer middleware
    reportUpload(req, res, async (err) => {
      if (err) {
        return res.status(400).json({
          success: false,
          error: err.message
        });
      }

      if (!req.file) {
        return res.status(400).json({
          success: false,
          error: 'No file uploaded'
        });
      }

      const { originalname, mimetype, size, buffer } = req.file;

      // Validate file size (100MB max)
      if (size > 100 * 1024 * 1024) {
        return res.status(400).json({
          success: false,
          error: 'File too large. Maximum size is 100MB.'
        });
      }

      // Save report to database
      const report = await pool.query(
        `INSERT INTO storage_reports (
          filename, mimetype, size, uploaded_by, status
        ) VALUES ($1, $2, $3, $4, 'pending')
        RETURNING id, filename, uploaded_at`,
        [originalname, mimetype, size, req.user.id]
      );

      // Process the report asynchronously
      setTimeout(async () => {
        try {
          // Process based on file type
          let processedData;
          if (mimetype === 'application/json') {
            processedData = JSON.parse(buffer.toString());
          } else if (mimetype.includes('csv')) {
            // Parse CSV
            const csvText = buffer.toString();
            const lines = csvText.split('\n');
            const headers = lines[0].split(',');
            processedData = lines.slice(1).map(line => {
              const values = line.split(',');
              return headers.reduce((obj, header, index) => {
                obj[header.trim()] = values[index]?.trim();
                return obj;
              }, {});
            });
          }

          // Update report status
          await pool.query(
            `UPDATE storage_reports 
             SET status = 'processed', processed_at = CURRENT_TIMESTAMP
             WHERE id = $1`,
            [report.rows[0].id]
          );

          // Extract insights from report
          // ... process the data ...

          // Log the processing
          await pool.query(
            `INSERT INTO system_logs (user_id, level, service, message, metadata)
             VALUES ($1, 'info', 'storage', 'Storage report processed', $2)`,
            [req.user.id, JSON.stringify({
              reportId: report.rows[0].id,
              filename: originalname,
              records: processedData?.length || 0
            })]
          );

        } catch (processingError) {
          console.error('Report processing error:', processingError);
          await pool.query(
            `UPDATE storage_reports 
             SET status = 'failed', error_message = $1
             WHERE id = $2`,
            [processingError.message, report.rows[0].id]
          );
        }
      }, 1000); // Simulate async processing

      logAdminAudit({ userId: req.user.id, action: 'UPLOAD_STORAGE_REPORT', targetId: report.rows[0].id, newValue: { filename: originalname, mimetype, size }, ipAddress: req.ip });

      res.json({
        success: true,
        message: 'Report uploaded and processing started',
        data: {
          reportId: report.rows[0].id,
          filename: originalname,
          uploadedAt: report.rows[0].uploaded_at
        }
      });
    });

  } catch (error) {
    console.error('Upload report error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to upload report'
    });
  }
});


// Add these routes before module.exports = router;

// Get admin request statistics
router.get('/requests/stats', authenticateAdmin, async (req, res) => {
  try {
    // Calculate average response time
    const responseTimeQuery = await pool.query(`
      SELECT 
        AVG(EXTRACT(EPOCH FROM (COALESCE(approved_at, rejected_at) - created_at))) / 3600 as avg_response_hours,
        COUNT(*) as total_requests,
        COUNT(CASE WHEN admin_status = 'approved' THEN 1 END) as approved_count,
        COUNT(CASE WHEN admin_status = 'rejected' THEN 1 END) as rejected_count,
        COUNT(CASE WHEN admin_status = 'pending' THEN 1 END) as pending_count
      FROM users
      WHERE admin_status IN ('pending', 'approved', 'rejected')
        AND (admin_status != 'none')
    `);

    const stats = responseTimeQuery.rows[0];
    const approvalRate = stats.total_requests > 0 
      ? Math.round((stats.approved_count / (stats.approved_count + stats.rejected_count)) * 100)
      : 0;

    res.json({
      success: true,
      data: {
        avgResponseHours: Math.round(stats.avg_response_hours * 10) / 10,
        totalRequests: parseInt(stats.total_requests),
        approved: parseInt(stats.approved_count),
        rejected: parseInt(stats.rejected_count),
        pending: parseInt(stats.pending_count),
        approvalRate: approvalRate
      }
    });

  } catch (error) {
    console.error('Get request stats error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch request statistics'
    });
  }
});

// Bulk approve all pending requests
router.post('/requests/bulk-approve', authenticateAdmin, async (req, res) => {
  try {
    const result = await pool.query(`
      UPDATE users 
      SET admin_status = 'approved',
          approved_by_admin_id = $1,
          approved_at = CURRENT_TIMESTAMP,
          subscription_status = 'active',
          updated_at = CURRENT_TIMESTAMP
      WHERE admin_status = 'pending'
      RETURNING id, email, full_name
    `, [req.user.id]);

    // Log the action
    await pool.query(
      `INSERT INTO system_logs (user_id, level, service, message, metadata)
       VALUES ($1, 'info', 'admin', 'Bulk approved all pending admin requests', $2)`,
      [req.user.id, JSON.stringify({
        approvedCount: result.rowCount,
        approvedBy: req.user.id
      })]
    );

    logAdminAudit({ userId: req.user.id, action: 'BULK_APPROVE_REQUESTS', newValue: { approvedCount: result.rowCount }, ipAddress: req.ip });

    res.json({
      success: true,
      message: `Approved ${result.rowCount} pending requests`,
      data: {
        approvedCount: result.rowCount,
        approvedUsers: result.rows
      }
    });

  } catch (error) {
    console.error('Bulk approve error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to bulk approve requests'
    });
  }
});


// Get log statistics
router.get('/logs/stats', authenticateAdmin, async (req, res) => {
  try {
    // Get storage used by logs
    const storageQuery = await pool.query(`
      SELECT 
        pg_database_size(current_database()) as db_size_bytes,
        (SELECT COUNT(*) FROM system_logs) as total_logs,
        (SELECT COUNT(*) FROM system_logs WHERE created_at >= NOW() - INTERVAL '1 second') as logs_per_second_estimate,
        (SELECT COUNT(*) FROM system_logs WHERE level = 'error' AND created_at >= NOW() - INTERVAL '90 days') as error_logs_90d,
        (SELECT COUNT(*) FROM system_logs WHERE level = 'info' AND created_at >= NOW() - INTERVAL '30 days') as info_logs_30d,
        (SELECT COUNT(*) FROM system_logs WHERE level = 'debug' AND created_at >= NOW() - INTERVAL '7 days') as debug_logs_7d
    `);

    const stats = storageQuery.rows[0];
    const dbSizeGB = Math.round((parseInt(stats.db_size_bytes) / (1024 * 1024 * 1024)) * 100) / 100;

    // Calculate retention percentages
    const errorLogsCount = parseInt(stats.error_logs_90d);
    const infoLogsCount = parseInt(stats.info_logs_30d);
    const debugLogsCount = parseInt(stats.debug_logs_7d);
    
    // Estimate percentages based on typical patterns
    const errorRetention = Math.min(100, Math.round((errorLogsCount / 10000) * 100)); // Assuming 10k max
    const infoRetention = Math.min(100, Math.round((infoLogsCount / 50000) * 100)); // Assuming 50k max
    const debugRetention = Math.min(100, Math.round((debugLogsCount / 100000) * 100)); // Assuming 100k max

    res.json({
      success: true,
      data: {
        storageUsedGB: dbSizeGB,
        logsPerSecond: parseInt(stats.logs_per_second_estimate) || 0,
        totalLogs: parseInt(stats.total_logs) || 0,
        retention: {
          error: errorRetention,
          info: infoRetention,
          debug: debugRetention
        },
        counts: {
          error90d: errorLogsCount,
          info30d: infoLogsCount,
          debug7d: debugLogsCount
        }
      }
    });

  } catch (error) {
    console.error('Get log stats error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch log statistics'
    });
  }
});

// Clear old logs
router.post('/logs/clear-old', authenticateAdmin, [
  body('days').optional().isInt({ min: 1, max: 365 })
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({
        success: false,
        errors: errors.array()
      });
    }

    const days = req.body.days || 30;
    
    const result = await pool.query(
      `DELETE FROM system_logs 
       WHERE created_at < NOW() - INTERVAL '${days} days'
       RETURNING COUNT(*) as deleted_count`
    );

    const deletedCount = result.rows[0]?.deleted_count || 0;

    // Log the action
    await pool.query(
      `INSERT INTO system_logs (user_id, level, service, message, metadata)
       VALUES ($1, 'info', 'admin', 'Cleared old logs', $2)`,
      [req.user.id, JSON.stringify({
        days: days,
        deletedCount: deletedCount
      })]
    );

    logAdminAudit({ userId: req.user.id, action: 'CLEAR_OLD_LOGS', newValue: { days, deletedCount }, ipAddress: req.ip });

    res.json({
      success: true,
      message: `Cleared ${deletedCount} logs older than ${days} days`,
      data: {
        deletedCount: deletedCount,
        days: days
      }
    });

  } catch (error) {
    console.error('Clear logs error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to clear old logs'
    });
  }
});

// ==================== PLATFORM SETTINGS ====================
// Only settings the app actually enforces live here (see utils/platformSettings.js).
// Rate limits and upload size are set in the server environment and shown read-only.

// Mirrors the limits configured in server.js / middleware/auth.js / utils/s3Storage.js
const currentLimits = () => ({
  generalPerIp: Number(process.env.GENERAL_RATE_LIMIT) || (process.env.NODE_ENV === 'development' ? 5000 : 1500),
  perUser: Number(process.env.PER_USER_RATE_LIMIT) || 1000,
  windowMinutes: 15,
  failedLoginsPerIp: 20,
  messageSendsPerHour: 10,
  uploadMaxMb: 100,
  generalOverridden: !!process.env.GENERAL_RATE_LIMIT,
  perUserOverridden: !!process.env.PER_USER_RATE_LIMIT
});

router.get('/settings', authenticateAdmin, async (req, res) => {
  try {
    const { getPlatformSettings } = require('../utils/platformSettings');
    const [settings, admins] = await Promise.all([
      getPlatformSettings(),
      pool.query(
        `SELECT COUNT(*)::int AS total,
                COUNT(*) FILTER (WHERE COALESCE(two_factor_enabled, false) = false)::int AS without_2fa
         FROM users
         WHERE is_admin = true AND admin_status = 'approved' AND deleted_at IS NULL`
      )
    ]);

    res.json({
      success: true,
      data: {
        settings,
        limits: currentLimits(),
        admins: admins.rows[0]
      }
    });
  } catch (error) {
    console.error('Get settings error:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch settings' });
  }
});

router.put('/settings', authenticateAdmin, [
  body('key').isIn(['maintenanceMode', 'maintenanceMessage', 'require2FA']),
  body('value').exists()
], async (req, res) => {
  try {
    if (!validationResult(req).isEmpty()) {
      return res.status(400).json({ success: false, error: 'Unknown setting' });
    }
    const { getPlatformSettings, saveSetting } = require('../utils/platformSettings');
    const { key, value } = req.body;

    if (key === 'maintenanceMessage' && !String(value).trim()) {
      return res.status(400).json({ success: false, error: 'The maintenance message cannot be empty' });
    }

    // Don't let an admin require 2FA while their own account would be locked out by it
    if (key === 'require2FA' && value === true) {
      const me = await pool.query('SELECT two_factor_enabled FROM users WHERE id = $1', [req.user.id]);
      if (!me.rows[0]?.two_factor_enabled) {
        return res.status(400).json({
          success: false,
          code: 'OWN_2FA_REQUIRED',
          error: 'Turn on two-step verification for your own account first (Security & audit page).'
        });
      }
    }

    const before = (await getPlatformSettings())[key];
    const saved = await saveSetting(key, value);

    const label = { maintenanceMode: 'Maintenance mode', maintenanceMessage: 'Maintenance message', require2FA: 'Require 2FA for admins' }[key];
    pool.query(
      `INSERT INTO system_logs (user_id, level, service, message, metadata)
       VALUES ($1, $2, 'settings', $3, $4)`,
      [
        req.user.id,
        key === 'maintenanceMode' && saved ? 'warning' : 'info',
        typeof saved === 'boolean' ? `${label} turned ${saved ? 'on' : 'off'}` : `${label} updated`,
        JSON.stringify({ key, value: saved })
      ]
    ).catch(err => console.error('system_log write failed:', err));
    logAdminAudit({ userId: req.user.id, action: 'UPDATE_SETTINGS', targetId: key, oldValue: { [key]: before }, newValue: { [key]: saved }, ipAddress: req.ip });

    res.json({ success: true, data: { key, value: saved } });
  } catch (error) {
    console.error('Update setting error:', error);
    res.status(500).json({ success: false, error: 'Failed to update setting' });
  }
});

// Live service checks (same as the dashboard's System health)
router.get('/settings/service-status', authenticateAdmin, async (req, res) => {
  try {
    const { getSystemHealth } = require('../utils/systemHealth');
    const health = await getSystemHealth({ force: req.query.refresh === '1' });
    res.json({ success: true, data: health });
  } catch (error) {
    console.error('Get service status error:', error);
    res.status(500).json({ success: false, error: 'Failed to check services' });
  }
});


// ==================== SUPPORT ROUTES ====================

// Helper function to generate unique ticket number
const generateTicketNumber = async () => {
  const year = new Date().getFullYear();
  let isUnique = false;
  let ticketNumber;
  
  while (!isUnique) {
    const random = Math.floor(Math.random() * 90000) + 10000;
    ticketNumber = `ST-${year}-${random}`;
    
    const check = await pool.query(
      'SELECT id FROM support_tickets WHERE ticket_number = $1',
      [ticketNumber]
    );
    
    if (check.rows.length === 0) {
      isUnique = true;
    }
  }
  
  return ticketNumber;
};

// Get all support tickets with filters
router.get('/support/tickets', authenticateAdmin, async (req, res) => {
  try {
    const { page = 1, limit = 50, status, priority, category, assignedTo, search } = req.query;
    const offset = (page - 1) * limit;

    let query = `
      SELECT 
        st.*,
        u.email as user_email,
        u.full_name as user_name,
        a.email as assigned_to_email,
        a.full_name as assigned_to_name,
        (SELECT COUNT(*) FROM support_tickets st2
         LEFT JOIN users u2 ON st2.user_id = u2.id
         WHERE 1=1) as total_count
      FROM support_tickets st
      LEFT JOIN users u ON st.user_id = u.id
      LEFT JOIN users a ON st.assigned_to = a.id
      WHERE 1=1
    `;

    const queryParams = [];
    let paramCount = 1;

    if (status && status !== 'all') {
      query += ` AND st.status = $${paramCount}`;
      queryParams.push(status);
      paramCount++;
    }

    if (priority && priority !== 'all') {
      query += ` AND st.priority = $${paramCount}`;
      queryParams.push(priority);
      paramCount++;
    }

    if (category && category !== 'all') {
      query += ` AND st.category = $${paramCount}`;
      queryParams.push(category);
      paramCount++;
    }

    if (assignedTo && assignedTo !== 'all') {
      if (assignedTo === 'unassigned') {
        query += ` AND st.assigned_to IS NULL`;
      } else if (assignedTo === 'me') {
        query += ` AND st.assigned_to = $${paramCount}`;
        queryParams.push(req.user.id);
        paramCount++;
      } else {
        query += ` AND st.assigned_to = $${paramCount}`;
        queryParams.push(assignedTo);
        paramCount++;
      }
    }

    if (search) {
      query += ` AND (
        st.subject ILIKE $${paramCount} OR 
        st.description ILIKE $${paramCount} OR
        st.ticket_number ILIKE $${paramCount} OR
        u.email ILIKE $${paramCount} OR
        u.full_name ILIKE $${paramCount}
      )`;
      queryParams.push(`%${search}%`);
      paramCount++;
    }

    query += ` ORDER BY 
      CASE 
        WHEN st.priority = 'critical' THEN 1
        WHEN st.priority = 'high' THEN 2
        WHEN st.priority = 'medium' THEN 3
        WHEN st.priority = 'low' THEN 4
        ELSE 5
      END,
      st.created_at DESC
      LIMIT $${paramCount} OFFSET $${paramCount + 1}`;
    
    queryParams.push(parseInt(limit), offset);

    const result = await pool.query(query, queryParams);

    const ticketsWithResponses = await Promise.all(
      result.rows.map(async (ticket) => {
        const responseCount = await pool.query(
          'SELECT COUNT(*) as count FROM ticket_responses WHERE ticket_id = $1',
          [ticket.id]
        );
        
        return {
          ...ticket,
          response_count: parseInt(responseCount.rows[0].count)
        };
      })
    );

    res.json({
      success: true,
      data: {
        tickets: ticketsWithResponses,
        pagination: {
          page: parseInt(page),
          limit: parseInt(limit),
          total: result.rows[0]?.total_count || 0,
          totalPages: Math.ceil((result.rows[0]?.total_count || 0) / limit)
        }
      }
    });

  } catch (error) {
    console.error('Get support tickets error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch support tickets'
    });
  }
});

// Get ticket details with responses
router.get('/support/tickets/:id', authenticateAdmin, async (req, res) => {
  try {
    const { id } = req.params;

    const ticketQuery = await pool.query(`
      SELECT 
        st.*,
        u.email as user_email,
        u.full_name as user_name,
        u.phone as user_phone,
        a.email as assigned_to_email,
        a.full_name as assigned_to_name,
        r.email as resolved_by_email,
        r.full_name as resolved_by_name
      FROM support_tickets st
      LEFT JOIN users u ON st.user_id = u.id
      LEFT JOIN users a ON st.assigned_to = a.id
      LEFT JOIN users r ON st.resolved_by = r.id
      WHERE st.id = $1
    `, [id]);

    if (ticketQuery.rows.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'Ticket not found'
      });
    }

    const responsesQuery = await pool.query(`
      SELECT 
        tr.*,
        u.email as user_email,
        u.full_name as user_name
      FROM ticket_responses tr
      LEFT JOIN users u ON tr.user_id = u.id
      WHERE tr.ticket_id = $1
      ORDER BY tr.created_at ASC
    `, [id]);

    const publicResponses = responsesQuery.rows.filter(r => !r.is_internal);
    const internalResponses = responsesQuery.rows.filter(r => r.is_internal);

    res.json({
      success: true,
      data: {
        ticket: ticketQuery.rows[0],
        responses: publicResponses,
        internal_responses: internalResponses
      }
    });

  } catch (error) {
    console.error('Get ticket details error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch ticket details'
    });
  }
});

// Respond to ticket (admin)
router.post('/support/tickets/:id/respond', authenticateAdmin, [
  body('message').notEmpty().trim(),
  body('isInternal').optional().isBoolean()
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({
        success: false,
        errors: errors.array()
      });
    }

    const { id } = req.params;
    const { message, isInternal = false } = req.body;

    const ticketCheck = await pool.query(
      'SELECT id, status FROM support_tickets WHERE id = $1',
      [id]
    );

    if (ticketCheck.rows.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'Ticket not found'
      });
    }

    const response = await pool.query(
      `INSERT INTO ticket_responses (ticket_id, user_id, message, is_internal)
       VALUES ($1, $2, $3, $4)
       RETURNING *`,
      [id, req.user.id, message, isInternal]
    );

    await pool.query(
      'UPDATE support_tickets SET updated_at = CURRENT_TIMESTAMP WHERE id = $1',
      [id]
    );

    logAdminAudit({ userId: req.user.id, action: 'RESPOND_TICKET', targetId: id, newValue: { message, isInternal }, ipAddress: req.ip });

    res.status(201).json({
      success: true,
      message: 'Response added successfully',
      data: response.rows[0]
    });

  } catch (error) {
    console.error('Respond to ticket error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to add response'
    });
  }
});

// Update ticket status
router.put('/support/tickets/:id/status', authenticateAdmin, [
  body('status').isIn(['open', 'in_progress', 'resolved', 'closed'])
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({
        success: false,
        errors: errors.array()
      });
    }

    const { id } = req.params;
    const { status } = req.body;

    const updates = ['status = $1'];
    const values = [status];
    let paramCount = 2;

    if (status === 'resolved') {
      updates.push('resolved_by = $' + paramCount);
      updates.push('resolved_at = CURRENT_TIMESTAMP');
      values.push(req.user.id);
      paramCount++;
    } else if (status === 'closed') {
      updates.push('closed_at = CURRENT_TIMESTAMP');
    }

    values.push(id);

    const query = `
      UPDATE support_tickets 
      SET ${updates.join(', ')}
      WHERE id = $${paramCount}
      RETURNING *
    `;

    const result = await pool.query(query, values);

    logAdminAudit({ userId: req.user.id, action: 'UPDATE_TICKET_STATUS', targetId: id, newValue: { status }, ipAddress: req.ip });

    res.json({
      success: true,
      message: `Ticket status updated to ${status}`,
      data: result.rows[0]
    });

  } catch (error) {
    console.error('Update ticket status error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to update ticket status'
    });
  }
});

// Assign ticket to admin
router.put('/support/tickets/:id/assign', authenticateAdmin, [
  body('adminId').optional().isUUID()
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({
        success: false,
        errors: errors.array()
      });
    }

    const { id } = req.params;
    const { adminId } = req.body;

    const assignValue = adminId || null;

    const result = await pool.query(
      `UPDATE support_tickets 
       SET assigned_to = $1, updated_at = CURRENT_TIMESTAMP
       WHERE id = $2
       RETURNING *`,
      [assignValue, id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'Ticket not found'
      });
    }

    const message = adminId ? 'Ticket assigned successfully' : 'Ticket unassigned successfully';

    logAdminAudit({ userId: req.user.id, action: 'ASSIGN_TICKET', targetId: id, newValue: { adminId: assignValue }, ipAddress: req.ip });

    res.json({
      success: true,
      message: message,
      data: result.rows[0]
    });

  } catch (error) {
    console.error('Assign ticket error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to assign ticket'
    });
  }
});

// Update ticket internal notes
router.put('/support/tickets/:id/notes', authenticateAdmin, [
  body('notes').optional().trim()
], async (req, res) => {
  try {
    const { id } = req.params;
    const { notes } = req.body;

    const result = await pool.query(
      `UPDATE support_tickets 
       SET internal_notes = $1, updated_at = CURRENT_TIMESTAMP
       WHERE id = $2
       RETURNING *`,
      [notes || null, id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'Ticket not found'
      });
    }

    logAdminAudit({ userId: req.user.id, action: 'UPDATE_TICKET_NOTES', targetId: id, newValue: { notes }, ipAddress: req.ip });

    res.json({
      success: true,
      message: 'Internal notes updated',
      data: result.rows[0]
    });

  } catch (error) {
    console.error('Update ticket notes error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to update internal notes'
    });
  }
});

// Get support statistics
router.get('/support/stats', authenticateAdmin, async (req, res) => {
  try {
    const stats = await pool.query(`
      SELECT 
        COUNT(*) as total_tickets,
        COUNT(CASE WHEN status = 'open' THEN 1 END) as open_tickets,
        COUNT(CASE WHEN status = 'in_progress' THEN 1 END) as in_progress_tickets,
        COUNT(CASE WHEN status = 'resolved' THEN 1 END) as resolved_tickets,
        COUNT(CASE WHEN status = 'closed' THEN 1 END) as closed_tickets,
        COUNT(CASE WHEN priority = 'critical' THEN 1 END) as critical_tickets,
        COUNT(CASE WHEN priority = 'high' THEN 1 END) as high_tickets,
        COUNT(CASE WHEN assigned_to IS NULL THEN 1 END) as unassigned_tickets,
        AVG(CASE WHEN resolved_at IS NOT NULL THEN EXTRACT(EPOCH FROM (resolved_at - created_at)) END) as avg_resolution_seconds,
        COUNT(CASE WHEN DATE(created_at) = CURRENT_DATE THEN 1 END) as today_tickets
      FROM support_tickets
    `);

    const categoryStats = await pool.query(`
      SELECT 
        category,
        COUNT(*) as count
      FROM support_tickets
      GROUP BY category
      ORDER BY count DESC
    `);

    res.json({
      success: true,
      data: {
        ...stats.rows[0],
        categories: categoryStats.rows,
        timestamp: new Date().toISOString()
      }
    });

  } catch (error) {
    console.error('Get support stats error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch support statistics'
    });
  }
});

// Get all knowledge base articles
router.get('/support/knowledge-base', authenticateAdmin, async (req, res) => {
  try {
    const { page = 1, limit = 50, category, search, published } = req.query;
    const offset = (page - 1) * limit;

    let query = `
      SELECT 
        kba.*,
        cb.email as created_by_email,
        cb.full_name as created_by_name,
        ub.email as updated_by_email,
        ub.full_name as updated_by_name,
        pb.email as published_by_email,
        pb.full_name as published_by_name,
        (SELECT COUNT(*) FROM knowledge_base_articles) as total_count
      FROM knowledge_base_articles kba
      LEFT JOIN users cb ON kba.created_by = cb.id
      LEFT JOIN users ub ON kba.updated_by = ub.id
      LEFT JOIN users pb ON kba.published_by = pb.id
      WHERE 1=1
    `;

    const queryParams = [];
    let paramCount = 1;

    if (category && category !== 'all') {
      query += ` AND kba.category = $${paramCount}`;
      queryParams.push(category);
      paramCount++;
    }

    if (search) {
      query += ` AND (
        kba.title ILIKE $${paramCount} OR 
        kba.content ILIKE $${paramCount} OR
        kba.tags::text ILIKE $${paramCount}
      )`;
      queryParams.push(`%${search}%`);
      paramCount++;
    }

    if (published && published !== 'all') {
      query += ` AND kba.published = $${paramCount}`;
      queryParams.push(published === 'true');
      paramCount++;
    }

    query += ` ORDER BY kba.updated_at DESC LIMIT $${paramCount} OFFSET $${paramCount + 1}`;
    queryParams.push(parseInt(limit), offset);

    const result = await pool.query(query, queryParams);

    res.json({
      success: true,
      data: {
        articles: result.rows,
        pagination: {
          page: parseInt(page),
          limit: parseInt(limit),
          total: result.rows[0]?.total_count || 0,
          totalPages: Math.ceil((result.rows[0]?.total_count || 0) / limit)
        }
      }
    });

  } catch (error) {
    console.error('Get knowledge base error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch knowledge base articles'
    });
  }
});

// Create knowledge base article
router.post('/support/knowledge-base', authenticateAdmin, [
  body('title').notEmpty().trim(),
  body('content').notEmpty().trim(),
  body('category').notEmpty().trim(),
  body('tags').optional().isArray(),
  body('published').optional().isBoolean()
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({
        success: false,
        errors: errors.array()
      });
    }

    const { title, content, category, tags = [], published = true } = req.body;

    const article = await pool.query(
      `INSERT INTO knowledge_base_articles (
        title, content, category, tags, published, 
        created_by, updated_by, published_by
      ) VALUES ($1, $2, $3, $4, $5, $6, $6, $6)
      RETURNING *`,
      [title, content, category, tags, published, req.user.id]
    );

    logAdminAudit({ userId: req.user.id, action: 'CREATE_KB_ARTICLE', targetId: article.rows[0].id, newValue: { title, category, published }, ipAddress: req.ip });

    res.status(201).json({
      success: true,
      message: 'Article created successfully',
      data: article.rows[0]
    });

  } catch (error) {
    console.error('Create article error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to create article'
    });
  }
});

// Update knowledge base article
router.put('/support/knowledge-base/:id', authenticateAdmin, [
  body('title').optional().notEmpty().trim(),
  body('content').optional().notEmpty().trim(),
  body('category').optional().notEmpty().trim(),
  body('tags').optional().isArray(),
  body('published').optional().isBoolean()
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({
        success: false,
        errors: errors.array()
      });
    }

    const { id } = req.params;
    const { title, content, category, tags, published } = req.body;

    const updates = [];
    const values = [];
    let paramCount = 1;

    if (title) {
      updates.push(`title = $${paramCount}`);
      values.push(title);
      paramCount++;
    }

    if (content) {
      updates.push(`content = $${paramCount}`);
      values.push(content);
      paramCount++;
    }

    if (category) {
      updates.push(`category = $${paramCount}`);
      values.push(category);
      paramCount++;
    }

    if (tags) {
      updates.push(`tags = $${paramCount}`);
      values.push(tags);
      paramCount++;
    }

    if (published !== undefined) {
      updates.push(`published = $${paramCount}`);
      values.push(published);
      if (published) {
        updates.push(`published_by = $${paramCount + 1}, published_at = CURRENT_TIMESTAMP`);
        values.push(req.user.id);
        paramCount++;
      }
      paramCount++;
    }

    if (updates.length === 0) {
      return res.status(400).json({
        success: false,
        error: 'No updates provided'
      });
    }

    updates.push(`updated_by = $${paramCount}`);
    values.push(req.user.id);
    paramCount++;

    values.push(id);

    const query = `
      UPDATE knowledge_base_articles 
      SET ${updates.join(', ')}
      WHERE id = $${paramCount}
      RETURNING *
    `;

    const result = await pool.query(query, values);

    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'Article not found'
      });
    }

    logAdminAudit({ userId: req.user.id, action: 'UPDATE_KB_ARTICLE', targetId: id, newValue: req.body, ipAddress: req.ip });

    res.json({
      success: true,
      message: 'Article updated successfully',
      data: result.rows[0]
    });

  } catch (error) {
    console.error('Update article error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to update article'
    });
  }
});

// Delete knowledge base article
router.delete('/support/knowledge-base/:id', authenticateAdmin, async (req, res) => {
  try {
    const { id } = req.params;

    const result = await pool.query(
      'DELETE FROM knowledge_base_articles WHERE id = $1 RETURNING id',
      [id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'Article not found'
      });
    }

    logAdminAudit({ userId: req.user.id, action: 'DELETE_KB_ARTICLE', targetId: id, ipAddress: req.ip });

    res.json({
      success: true,
      message: 'Article deleted successfully'
    });

  } catch (error) {
    console.error('Delete article error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to delete article'
    });
  }
});

// Get knowledge base statistics
router.get('/support/knowledge-base/stats', authenticateAdmin, async (req, res) => {
  try {
    const stats = await pool.query(`
      SELECT 
        COUNT(*) as total_articles,
        COUNT(CASE WHEN published = true THEN 1 END) as published_articles,
        COUNT(CASE WHEN published = false THEN 1 END) as draft_articles,
        COALESCE(SUM(views), 0) as total_views,
        COALESCE(SUM(helpful_votes), 0) as total_helpful_votes,
        COALESCE(SUM(not_helpful_votes), 0) as total_not_helpful_votes,
        (
          SELECT category 
          FROM knowledge_base_articles 
          GROUP BY category 
          ORDER BY COUNT(*) DESC 
          LIMIT 1
        ) as most_common_category
      FROM knowledge_base_articles
    `);

    const categoryStats = await pool.query(`
      SELECT 
        category,
        COUNT(*) as article_count,
        COALESCE(SUM(views), 0) as total_views
      FROM knowledge_base_articles
      WHERE published = true
      GROUP BY category
      ORDER BY article_count DESC
    `);

    res.json({
      success: true,
      data: {
        ...stats.rows[0],
        categories: categoryStats.rows
      }
    });

  } catch (error) {
    console.error('Get KB stats error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch knowledge base statistics'
    });
  }
});

module.exports = router;