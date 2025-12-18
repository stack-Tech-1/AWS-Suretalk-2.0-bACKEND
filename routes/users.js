// C:\Users\SMC\Documents\GitHub\AWS-Suretalk-2.0-bACKEND\routes\users.js
const express = require('express');
const router = express.Router();
const { body, validationResult } = require('express-validator');
const { authenticate, authenticateAdmin } = require('../middleware/auth');
const { pool } = require('../config/database');

// Get user profile
router.get('/profile', authenticate, async (req, res) => {
  try {
    const userQuery = await pool.query(
      `SELECT id, email, phone, full_name, subscription_tier, subscription_status,
              profile_image_url, storage_limit_gb, contacts_limit, voice_notes_limit,
              created_at, last_login, is_admin
       FROM users WHERE id = $1`,
      [req.user.id]
    );

    if (userQuery.rows.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'User not found'
      });
    }

    // Get usage statistics
    const usageQuery = await pool.query(
      `SELECT 
        COUNT(*) as voice_notes_count,
        COALESCE(SUM(file_size_bytes), 0) as storage_bytes,
        COUNT(CASE WHEN is_permanent THEN 1 END) as permanent_notes_count
       FROM voice_notes 
       WHERE user_id = $1 AND deleted_at IS NULL`,
      [req.user.id]
    );

    const contactsQuery = await pool.query(
      'SELECT COUNT(*) as contacts_count FROM contacts WHERE user_id = $1',
      [req.user.id]
    );

    res.json({
      success: true,
      data: {
        ...userQuery.rows[0],
        usage: {
          ...usageQuery.rows[0],
          ...contactsQuery.rows[0]
        }
      }
    });

  } catch (error) {
    console.error('Get profile error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch profile'
    });
  }
});

// Update user profile
router.put('/profile', authenticate, [
  body('fullName').optional().notEmpty(),
  body('phone').optional().isMobilePhone(),
  body('profileImageUrl').optional().isURL()
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({
        success: false,
        errors: errors.array()
      });
    }

    const { fullName, phone, profileImageUrl } = req.body;
    const updates = [];
    const values = [];
    let paramCount = 1;

    if (fullName) {
      updates.push(`full_name = $${paramCount}`);
      values.push(fullName);
      paramCount++;
    }

    if (phone) {
      // Check if phone is already in use
      const phoneCheck = await pool.query(
        'SELECT id FROM users WHERE phone = $1 AND id != $2',
        [phone, req.user.id]
      );

      if (phoneCheck.rows.length > 0) {
        return res.status(400).json({
          success: false,
          error: 'Phone number already in use'
        });
      }

      updates.push(`phone = $${paramCount}`);
      values.push(phone);
      paramCount++;
    }

    if (profileImageUrl) {
      updates.push(`profile_image_url = $${paramCount}`);
      values.push(profileImageUrl);
      paramCount++;
    }

    if (updates.length === 0) {
      return res.status(400).json({
        success: false,
        error: 'No updates provided'
      });
    }

    values.push(req.user.id);

    const query = `
      UPDATE users 
      SET ${updates.join(', ')}, updated_at = CURRENT_TIMESTAMP
      WHERE id = $${paramCount}
      RETURNING id, email, phone, full_name, profile_image_url, updated_at
    `;

    const result = await pool.query(query, values);

    res.json({
      success: true,
      message: 'Profile updated successfully',
      data: result.rows[0]
    });

  } catch (error) {
    console.error('Update profile error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to update profile'
    });
  }
});

// Get user statistics (for dashboard)
router.get('/stats', authenticate, async (req, res) => {
  try {
    const statsQuery = await pool.query(
      `SELECT 
        (SELECT COUNT(*) FROM voice_notes WHERE user_id = $1 AND deleted_at IS NULL) as voice_notes_total,
        (SELECT COALESCE(SUM(file_size_bytes), 0) FROM voice_notes WHERE user_id = $1 AND deleted_at IS NULL) as storage_bytes,
        (SELECT COUNT(*) FROM contacts WHERE user_id = $1) as contacts_total,
        (SELECT COUNT(*) FROM scheduled_messages WHERE user_id = $1) as scheduled_messages_total,
        (SELECT COUNT(*) FROM voice_wills WHERE user_id = $1) as wills_total
      `,
      [req.user.id]
    );

    // Get recent activity
    const recentNotes = await pool.query(
      `SELECT id, title, created_at 
       FROM voice_notes 
       WHERE user_id = $1 AND deleted_at IS NULL
       ORDER BY created_at DESC 
       LIMIT 5`,
      [req.user.id]
    );

    const recentScheduled = await pool.query(
      `SELECT sm.id, vn.title, sm.scheduled_for, sm.delivery_status
       FROM scheduled_messages sm
       LEFT JOIN voice_notes vn ON sm.voice_note_id = vn.id
       WHERE sm.user_id = $1
       ORDER BY sm.scheduled_for ASC
       LIMIT 5`,
      [req.user.id]
    );

    res.json({
      success: true,
      data: {
        stats: statsQuery.rows[0],
        recentActivity: {
          voiceNotes: recentNotes.rows,
          scheduledMessages: recentScheduled.rows
        }
      }
    });

  } catch (error) {
    console.error('Get user stats error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch statistics'
    });
  }
});

// Get user usage limits
router.get('/limits', authenticate, async (req, res) => {
  try {
    const userQuery = await pool.query(
      `SELECT 
        subscription_tier,
        storage_limit_gb,
        contacts_limit,
        voice_notes_limit
       FROM users WHERE id = $1`,
      [req.user.id]
    );

    const user = userQuery.rows[0];

    // Get current usage
    const usageQuery = await pool.query(
      `SELECT 
        COUNT(*) as voice_notes_count,
        (SELECT COUNT(*) FROM contacts WHERE user_id = $1) as contacts_count,
        COALESCE(SUM(file_size_bytes), 0) as storage_bytes
       FROM voice_notes 
       WHERE user_id = $1 AND deleted_at IS NULL`,
      [req.user.id]
    );

    const usage = usageQuery.rows[0];

    res.json({
      success: true,
      data: {
        tier: user.subscription_tier,
        limits: {
          storage: {
            current: usage.storage_bytes,
            max: user.storage_limit_gb * 1024 * 1024 * 1024,
            maxGb: user.storage_limit_gb
          },
          contacts: {
            current: usage.contacts_count,
            max: user.contacts_limit
          },
          voiceNotes: {
            current: usage.voice_notes_count,
            max: user.voice_notes_limit
          }
        }
      }
    });

  } catch (error) {
    console.error('Get limits error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch usage limits'
    });
  }
});

// Admin: Get all users
router.get('/', authenticateAdmin, async (req, res) => {
  try {
    const { page = 1, limit = 50, search, tier, status } = req.query;
    const offset = (page - 1) * limit;

    let query = `
      SELECT 
        id, email, phone, full_name, subscription_tier, 
        subscription_status, created_at, last_login,
        (SELECT COUNT(*) FROM users WHERE deleted_at IS NULL) as total_count
      FROM users 
      WHERE deleted_at IS NULL
    `;

    const queryParams = [];
    let paramCount = 1;

    if (search) {
      query += ` AND (email ILIKE $${paramCount} OR phone ILIKE $${paramCount} OR full_name ILIKE $${paramCount})`;
      queryParams.push(`%${search}%`);
      paramCount++;
    }

    if (tier && tier !== 'all') {
      query += ` AND subscription_tier = $${paramCount}`;
      queryParams.push(tier);
      paramCount++;
    }

    if (status && status !== 'all') {
      query += ` AND subscription_status = $${paramCount}`;
      queryParams.push(status);
      paramCount++;
    }

    query += ` ORDER BY created_at DESC LIMIT $${paramCount} OFFSET $${paramCount + 1}`;
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
    console.error('Get users error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch users'
    });
  }
});

module.exports = router;