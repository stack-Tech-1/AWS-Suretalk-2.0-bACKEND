// C:\Users\SMC\Documents\GitHub\AWS-Suretalk-2.0-fRONTEND\surechat-backend\routes\admin.js
const express = require('express');
const router = express.Router();
const { authenticate, authenticateAdmin } = require('../middleware/auth');
const { pool } = require('../config/database');
const { body, validationResult } = require('express-validator'); 
const bcrypt = require('bcrypt'); 

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



// Request admin access
router.post('/register-request', authenticate, [
    body('email').isEmail().normalizeEmail(),
    body('phone').isMobilePhone(),
    body('fullName').notEmpty().trim(),
    body('password').isLength({ min: 10 }),
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
      const { page = 1, limit = 20 } = req.query;
      const offset = (page - 1) * limit;
  
      const result = await pool.query(
        `SELECT 
          u.id, u.email, u.phone, u.full_name, u.admin_reason, u.admin_department,
          u.requested_by_admin_id, u.created_at,
          ru.full_name as requested_by_name,
          (SELECT COUNT(*) FROM users WHERE admin_status = 'pending') as total_count
         FROM users u
         LEFT JOIN users ru ON u.requested_by_admin_id = ru.id
         WHERE u.admin_status = 'pending'
         ORDER BY u.created_at DESC
         LIMIT $1 OFFSET $2`,
        [parseInt(limit), offset]
      );
  
      res.json({
        success: true,
        data: {
          requests: result.rows,
          pagination: {
            page: parseInt(page),
            limit: parseInt(limit),
            total: result.rows[0]?.total_count || 0,
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

module.exports = router;