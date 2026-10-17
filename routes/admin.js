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

// Voice will routes (list, details, release, listen, remove, restore) live in routes/adminWills.js

// System log routes live in routes/adminLogs.js; the storage overview in routes/adminStorage.js

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
        WHERE deleted_at IS NULL
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

// Admin access requests (list, stats, approve, reject, delete) live in routes/adminRequests.js.
// The old unauthenticated /admin/request and the unaudited /admin/approve|reject|pending routes were removed.

  // Add this to your admin.js file, before the module.exports = router;

// Scheduled message routes (stats, list, export, details, pause/resume/cancel/retry) live in routes/adminScheduled.js

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