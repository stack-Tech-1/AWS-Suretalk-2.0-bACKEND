// C:\Users\SMC\Documents\GitHub\AWS-Suretalk-2.0-fRONTEND\surechat-backend\routes\admin.js
const express = require('express');
const router = express.Router();
const { authenticate, authenticateAdmin } = require('../middleware/auth');
const { pool } = require('../config/database');

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

// Get all users with pagination
router.get('/users', authenticateAdmin, async (req, res) => {
  try {
    const { page = 1, limit = 50, search, tier, status } = req.query;
    const offset = (page - 1) * limit;

    let query = `
      SELECT 
        u.id, u.email, u.phone, u.full_name, u.subscription_tier, 
        u.subscription_status, u.created_at, u.last_login,
        (SELECT COUNT(*) FROM users WHERE deleted_at IS NULL) as total_count,
        (SELECT COUNT(*) FROM voice_notes WHERE user_id = u.id AND deleted_at IS NULL) as note_count,
        (SELECT COUNT(*) FROM contacts WHERE user_id = u.id) as contact_count
      FROM users u
      WHERE u.deleted_at IS NULL
    `;

    const queryParams = [];
    let paramCount = 1;

    // Apply filters
    if (search) {
      query += ` AND (u.email ILIKE $${paramCount} OR u.phone ILIKE $${paramCount} OR u.full_name ILIKE $${paramCount})`;
      queryParams.push(`%${search}%`);
      paramCount++;
    }

    if (tier && tier !== 'all') {
      query += ` AND u.subscription_tier = $${paramCount}`;
      queryParams.push(tier);
      paramCount++;
    }

    if (status && status !== 'all') {
      query += ` AND u.subscription_status = $${paramCount}`;
      queryParams.push(status);
      paramCount++;
    }

    // Order and pagination
    query += ` ORDER BY u.created_at DESC LIMIT $${paramCount} OFFSET $${paramCount + 1}`;
    queryParams.push(parseInt(limit), offset);

    const result = await pool.query(query, queryParams);

    res.json({
      success: true,
      data: {
        users: result.rows,
        pagination: {
          page: parseInt(page),
          limit: parseInt(limit),
          total: result.rows[0]?.total_count || 0,
          totalPages: Math.ceil((result.rows[0]?.total_count || 0) / limit)
        }
      }
    });

  } catch (error) {
    console.error('Get admin users error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch users'
    });
  }
});

// Get user details
router.get('/users/:id', authenticateAdmin, async (req, res) => {
  try {
    const { id } = req.params;

    const userQuery = await pool.query(
      `SELECT 
        u.*,
        (SELECT COUNT(*) FROM voice_notes WHERE user_id = u.id AND deleted_at IS NULL) as note_count,
        (SELECT COUNT(*) FROM contacts WHERE user_id = u.id) as contact_count,
        (SELECT COUNT(*) FROM voice_wills WHERE user_id = u.id) as will_count,
        (SELECT COUNT(*) FROM scheduled_messages WHERE user_id = u.id) as scheduled_count
       FROM users u
       WHERE u.id = $1 AND u.deleted_at IS NULL`,
      [id]
    );

    if (userQuery.rows.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'User not found'
      });
    }

    // Get user's voice notes
    const voiceNotes = await pool.query(
      `SELECT id, title, duration_seconds, file_size_bytes, is_permanent, created_at
       FROM voice_notes
       WHERE user_id = $1 AND deleted_at IS NULL
       ORDER BY created_at DESC
       LIMIT 10`,
      [id]
    );

    // Get user's contacts
    const contacts = await pool.query(
      `SELECT id, name, phone, email, relationship, created_at
       FROM contacts
       WHERE user_id = $1
       ORDER BY created_at DESC
       LIMIT 10`,
      [id]
    );

    // Get user's billing history
    const billingHistory = await pool.query(
      `SELECT id, amount_cents, currency, description, status, created_at
       FROM billing_history
       WHERE user_id = $1
       ORDER BY created_at DESC
       LIMIT 10`,
      [id]
    );

    const user = userQuery.rows[0];
    
    res.json({
      success: true,
      data: {
        user,
        voiceNotes: voiceNotes.rows,
        contacts: contacts.rows,
        billingHistory: billingHistory.rows
      }
    });

  } catch (error) {
    console.error('Get user details error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch user details'
    });
  }
});

// Update user (admin)
router.put('/users/:id', authenticateAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const { subscriptionTier, subscriptionStatus, storageLimitGb, contactsLimit, voiceNotesLimit } = req.body;

    // Check if user exists
    const userCheck = await pool.query(
      'SELECT id FROM users WHERE id = $1 AND deleted_at IS NULL',
      [id]
    );

    if (userCheck.rows.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'User not found'
      });
    }

    const updates = [];
    const values = [];
    let paramCount = 1;

    if (subscriptionTier) {
      updates.push(`subscription_tier = $${paramCount}`);
      values.push(subscriptionTier);
      paramCount++;
    }

    if (subscriptionStatus) {
      updates.push(`subscription_status = $${paramCount}`);
      values.push(subscriptionStatus);
      paramCount++;
    }

    if (storageLimitGb !== undefined) {
      updates.push(`storage_limit_gb = $${paramCount}`);
      values.push(parseInt(storageLimitGb));
      paramCount++;
    }

    if (contactsLimit !== undefined) {
      updates.push(`contacts_limit = $${paramCount}`);
      values.push(parseInt(contactsLimit));
      paramCount++;
    }

    if (voiceNotesLimit !== undefined) {
      updates.push(`voice_notes_limit = $${paramCount}`);
      values.push(parseInt(voiceNotesLimit));
      paramCount++;
    }

    if (updates.length === 0) {
      return res.status(400).json({
        success: false,
        error: 'No updates provided'
      });
    }

    values.push(id);

    const query = `
      UPDATE users 
      SET ${updates.join(', ')}, updated_at = CURRENT_TIMESTAMP
      WHERE id = $${paramCount}
      RETURNING id, email, subscription_tier, subscription_status, 
                storage_limit_gb, contacts_limit, voice_notes_limit, updated_at
    `;

    const result = await pool.query(query, values);

    res.json({
      success: true,
      message: 'User updated successfully',
      data: result.rows[0]
    });

  } catch (error) {
    console.error('Update user error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to update user'
    });
  }
});

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

// Get system logs
router.get('/logs', authenticateAdmin, async (req, res) => {
  try {
    const { page = 1, limit = 100, level, service, startDate, endDate } = req.query;
    const offset = (page - 1) * limit;

    let query = `
      SELECT 
        sl.*,
        u.email as user_email,
        (SELECT COUNT(*) FROM system_logs WHERE 1=1) as total_count
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

    // Order and pagination
    query += ` ORDER BY sl.created_at DESC LIMIT $${paramCount} OFFSET $${paramCount + 1}`;
    queryParams.push(parseInt(limit), offset);

    const result = await pool.query(query, queryParams);

    res.json({
      success: true,
      data: {
        logs: result.rows,
        pagination: {
          page: parseInt(page),
          limit: parseInt(limit),
          total: result.rows[0]?.total_count || 0,
          totalPages: Math.ceil((result.rows[0]?.total_count || 0) / limit)
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

module.exports = router;