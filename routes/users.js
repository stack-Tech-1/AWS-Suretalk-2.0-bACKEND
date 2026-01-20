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


// ==================== USER SUPPORT ROUTES ====================

// User creates a support ticket
router.post('/support/tickets', authenticate, [
  body('subject').notEmpty().trim().isLength({ min: 5, max: 255 }),
  body('description').notEmpty().trim().isLength({ min: 10 }),
  body('category').optional().isIn(['billing', 'technical', 'account', 'feature_request', 'bug', 'general']),
  body('priority').optional().isIn(['low', 'medium', 'high', 'critical'])
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({
        success: false,
        errors: errors.array()
      });
    }

    const { subject, description, category = 'general', priority = 'medium' } = req.body;

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

    const ticketNumber = await generateTicketNumber();

    const ticket = await pool.query(
      `INSERT INTO support_tickets (
        user_id, ticket_number, subject, description, category, priority
      ) VALUES ($1, $2, $3, $4, $5, $6)
      RETURNING *`,
      [req.user.id, ticketNumber, subject, description, category, priority]
    );

    res.status(201).json({
      success: true,
      message: 'Support ticket created successfully',
      data: {
        ticket: ticket.rows[0],
        note: 'Our support team will respond within 24 hours'
      }
    });

  } catch (error) {
    console.error('Create support ticket error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to create support ticket'
    });
  }
});

// Get user's own tickets
router.get('/support/tickets', authenticate, async (req, res) => {
  try {
    const { page = 1, limit = 20, status } = req.query;
    const offset = (page - 1) * limit;

    let query = `
      SELECT 
        st.*,
        (SELECT COUNT(*) FROM support_tickets WHERE user_id = $1) as total_count
      FROM support_tickets st
      WHERE st.user_id = $1
    `;

    const queryParams = [req.user.id];
    let paramCount = 2;

    if (status && status !== 'all') {
      query += ` AND st.status = $${paramCount}`;
      queryParams.push(status);
      paramCount++;
    }

    query += ` ORDER BY st.created_at DESC LIMIT $${paramCount} OFFSET $${paramCount + 1}`;
    queryParams.push(parseInt(limit), offset);

    const result = await pool.query(query, queryParams);

    const ticketsWithResponses = await Promise.all(
      result.rows.map(async (ticket) => {
        const responseCount = await pool.query(
          'SELECT COUNT(*) as count FROM ticket_responses WHERE ticket_id = $1 AND is_internal = false',
          [ticket.id]
        );
        
        const lastResponse = await pool.query(
          `SELECT created_at FROM ticket_responses 
           WHERE ticket_id = $1 AND is_internal = false 
           ORDER BY created_at DESC LIMIT 1`,
          [ticket.id]
        );

        return {
          ...ticket,
          response_count: parseInt(responseCount.rows[0].count),
          last_response: lastResponse.rows[0]?.created_at || null
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
    console.error('Get user tickets error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch support tickets'
    });
  }
});

// Get specific ticket with responses (user view)
router.get('/support/tickets/:id', authenticate, async (req, res) => {
  try {
    const { id } = req.params;

    const ticketQuery = await pool.query(`
      SELECT 
        st.*,
        u.email as user_email,
        u.full_name as user_name
      FROM support_tickets st
      LEFT JOIN users u ON st.user_id = u.id
      WHERE st.id = $1 AND st.user_id = $2
    `, [id, req.user.id]);

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
      WHERE tr.ticket_id = $1 AND tr.is_internal = false
      ORDER BY tr.created_at ASC
    `, [id]);

    res.json({
      success: true,
      data: {
        ticket: ticketQuery.rows[0],
        responses: responsesQuery.rows
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

// User adds response to their ticket
router.post('/support/tickets/:id/respond', authenticate, [
  body('message').notEmpty().trim()
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
    const { message } = req.body;

    const ticketCheck = await pool.query(
      'SELECT id FROM support_tickets WHERE id = $1 AND user_id = $2',
      [id, req.user.id]
    );

    if (ticketCheck.rows.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'Ticket not found'
      });
    }

    const response = await pool.query(
      `INSERT INTO ticket_responses (ticket_id, user_id, message, is_internal)
       VALUES ($1, $2, $3, false)
       RETURNING *`,
      [id, req.user.id, message]
    );

    await pool.query(
      `UPDATE support_tickets 
       SET status = 'in_progress', updated_at = CURRENT_TIMESTAMP
       WHERE id = $1 AND status = 'open'`,
      [id]
    );

    res.status(201).json({
      success: true,
      message: 'Response added successfully',
      data: response.rows[0]
    });

  } catch (error) {
    console.error('Add response error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to add response'
    });
  }
});

// Get knowledge base articles for users
router.get('/support/knowledge-base', async (req, res) => {
  try {
    const { page = 1, limit = 20, category, search } = req.query;
    const offset = (page - 1) * limit;

    let query = `
      SELECT 
        kba.id, kba.title, kba.content, kba.category, kba.tags,
        kba.views, kba.helpful_votes, kba.not_helpful_votes,
        kba.created_at, kba.updated_at,
        (SELECT COUNT(*) FROM knowledge_base_articles WHERE published = true) as total_count
      FROM knowledge_base_articles kba
      WHERE kba.published = true
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

    query += ` ORDER BY kba.updated_at DESC LIMIT $${paramCount} OFFSET $${paramCount + 1}`;
    queryParams.push(parseInt(limit), offset);

    const result = await pool.query(query, queryParams);

    result.rows.forEach(article => {
      pool.query(
        'UPDATE knowledge_base_articles SET views = views + 1 WHERE id = $1',
        [article.id]
      ).catch(console.error);
    });

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

// Vote on article helpfulness
router.post('/support/knowledge-base/:id/vote', authenticate, [
  body('helpful').isBoolean()
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
    const { helpful } = req.body;

    const articleCheck = await pool.query(
      'SELECT id FROM knowledge_base_articles WHERE id = $1 AND published = true',
      [id]
    );

    if (articleCheck.rows.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'Article not found'
      });
    }

    const column = helpful ? 'helpful_votes' : 'not_helpful_votes';
    
    await pool.query(
      `UPDATE knowledge_base_articles 
       SET ${column} = ${column} + 1
       WHERE id = $1`,
      [id]
    );

    res.json({
      success: true,
      message: `Vote recorded as ${helpful ? 'helpful' : 'not helpful'}`
    });

  } catch (error) {
    console.error('Vote error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to record vote'
    });
  }
});


// Get user activity analytics
router.get('/activity', authenticate, async (req, res) => {
  try {
    const { period = 'week', timezone = 'UTC' } = req.query;
    
    let dateRange;
    const now = new Date();
    
    switch (period) {
      case 'day':
        dateRange = `DATE(created_at AT TIME ZONE '${timezone}') = CURRENT_DATE AT TIME ZONE '${timezone}'`;
        break;
      case 'week':
        dateRange = `created_at >= NOW() - INTERVAL '7 days'`;
        break;
      case 'month':
        dateRange = `created_at >= NOW() - INTERVAL '30 days'`;
        break;
      default:
        dateRange = `created_at >= NOW() - INTERVAL '7 days'`;
    }

    // Get daily activity for the period
    const dailyQuery = await pool.query(
      `WITH daily_stats AS (
        SELECT 
          DATE(created_at AT TIME ZONE $2) as date,
          COUNT(*) FILTER (WHERE event_type = 'voice_note_created') as notes_created,
          COUNT(*) FILTER (WHERE event_type = 'voice_note_played') as notes_played,
          COUNT(*) FILTER (WHERE event_type = 'voice_note_shared') as notes_shared,
          COUNT(*) FILTER (WHERE event_type = 'voice_note_downloaded') as notes_downloaded,
          COUNT(*) FILTER (WHERE event_type = 'contact_added') as contacts_added
        FROM analytics_events
        WHERE user_id = $1 AND ${dateRange}
        GROUP BY DATE(created_at AT TIME ZONE $2)
        ORDER BY date
      )
      SELECT * FROM daily_stats`,
      [req.user.id, timezone]
    );

    // Get weekly summary
    const weeklyQuery = await pool.query(
      `SELECT 
        EXTRACT(DOW FROM created_at) as day_of_week,
        COUNT(*) FILTER (WHERE event_type = 'voice_note_created') as notes_created,
        COUNT(*) FILTER (WHERE event_type = 'voice_note_played') as notes_played
      FROM analytics_events
      WHERE user_id = $1 AND created_at >= NOW() - INTERVAL '7 days'
      GROUP BY EXTRACT(DOW FROM created_at)
      ORDER BY day_of_week`,
      [req.user.id]
    );

    // Get voice note play statistics
    const playStatsQuery = await pool.query(
      `SELECT 
        vn.id,
        vn.title,
        vn.play_count,
        vn.last_played,
        COUNT(ae.id) as recent_plays
      FROM voice_notes vn
      LEFT JOIN analytics_events ae ON vn.id = ae.voice_note_id 
        AND ae.event_type = 'voice_note_played'
        AND ae.created_at >= NOW() - INTERVAL '7 days'
      WHERE vn.user_id = $1 AND vn.deleted_at IS NULL
      GROUP BY vn.id, vn.title, vn.play_count, vn.last_played
      ORDER BY vn.play_count DESC
      LIMIT 10`,
      [req.user.id]
    );

    // Format the data for the chart
    const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    const weeklyData = days.map((dayName, index) => {
      const dayStats = weeklyQuery.rows.find(row => parseInt(row.day_of_week) === index);
      return {
        day: dayName,
        notes: dayStats ? parseInt(dayStats.notes_created) : 0,
        listens: dayStats ? parseInt(dayStats.notes_played) : 0
      };
    });

    // Get total statistics
    const totalsQuery = await pool.query(
      `SELECT 
        COUNT(*) FILTER (WHERE event_type = 'voice_note_created') as total_notes_created,
        COUNT(*) FILTER (WHERE event_type = 'voice_note_played') as total_notes_played,
        COUNT(*) FILTER (WHERE event_type = 'voice_note_shared') as total_notes_shared,
        COUNT(*) FILTER (WHERE event_type = 'contact_added') as total_contacts_added
      FROM analytics_events
      WHERE user_id = $1`,
      [req.user.id]
    );

    res.json({
      success: true,
      data: {
        daily: dailyQuery.rows,
        weekly: weeklyData,
        playStats: playStatsQuery.rows,
        totals: totalsQuery.rows[0] || {},
        period,
        timezone
      }
    });

  } catch (error) {
    console.error('Get analytics error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch analytics data'
    });
  }
});

// Record analytics event
router.post('/event', authenticate, [
  body('eventType').notEmpty().isIn([
    'voice_note_created',
    'voice_note_played',
    'voice_note_shared',
    'voice_note_viewed',
    'voice_note_downloaded',
    'voice_note_favorited',
    'voice_note_deleted',
    'contact_added',
    'contact_updated',
    'contact_deleted',
    'scheduled_message_created',
    'scheduled_message_sent',
    'scheduled_message_cancelled',
    'vault_item_created',
    'vault_item_accessed',
    'login',
    'logout',
    'page_view',
    'error',
    'push_notifications_initialized', // Add this
    'recording_started', // Add this
    'recording_stopped', // Add this
    'recording_error', // Add this
    'recording_reset', // Add this
    'audio_file_selected', // Add this
    'voice_note_creation_failed', // Add this
    'cta_click' // Add this
  ]),
  body('eventData').optional().isObject(),
  body('voiceNoteId').optional().isUUID(),
  body('contactId').optional().isUUID(),
  body('scheduledMessageId').optional().isUUID()
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
      eventType,
      eventData = {},
      voiceNoteId,
      contactId,
      scheduledMessageId
    } = req.body;

    // Record the event
    const result = await pool.query(
      `INSERT INTO analytics_events (
        user_id, event_type, event_data,
        voice_note_id, contact_id, scheduled_message_id,
        ip_address, user_agent, metadata
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      RETURNING id, created_at`,
      [
        req.user.id,
        eventType,
        JSON.stringify(eventData),
        voiceNoteId || null,
        contactId || null,
        scheduledMessageId || null,
        req.ip,
        req.get('user-agent'),
        JSON.stringify({
          url: req.get('referer') || req.originalUrl,
          method: req.method
        })
      ]
    );

    // If it's a voice note play event, update the play_count
    if (eventType === 'voice_note_played' && voiceNoteId) {
      await pool.query(
        `UPDATE voice_notes 
         SET play_count = play_count + 1, 
             last_played = CURRENT_TIMESTAMP
         WHERE id = $1 AND user_id = $2`,
        [voiceNoteId, req.user.id]
      );
    }

    // Update daily analytics (this could also be done with a scheduled job)
    const today = new Date().toISOString().split('T')[0];
    
    // Determine which counter to increment based on event type
    let counterField;
    switch (eventType) {
      case 'voice_note_created':
        counterField = 'voice_notes_created';
        break;
      case 'voice_note_played':
        counterField = 'voice_notes_played';
        break;
      case 'voice_note_shared':
        counterField = 'voice_notes_shared';
        break;
      case 'voice_note_downloaded':
        counterField = 'voice_notes_downloaded';
        break;
      case 'contact_added':
        counterField = 'contacts_added';
        break;
      case 'scheduled_message_created':
        counterField = 'scheduled_messages_created';
        break;
      case 'scheduled_message_sent':
        counterField = 'scheduled_messages_sent';
        break;
      default:
        counterField = null;
    }

    if (counterField) {
      await pool.query(
        `INSERT INTO daily_analytics (user_id, date, ${counterField})
         VALUES ($1, $2, 1)
         ON CONFLICT (user_id, date) 
         DO UPDATE SET ${counterField} = daily_analytics.${counterField} + 1`,
        [req.user.id, today]
      );
    }

    res.status(201).json({
      success: true,
      data: result.rows[0]
    });

  } catch (error) {
    console.error('Record analytics event error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to record analytics event'
    });
  }
});

// Get aggregated statistics
router.get('/stats', authenticate, async (req, res) => {
  try {
    const { startDate, endDate } = req.query;
    
    let dateCondition = '';
    const queryParams = [req.user.id];
    let paramCount = 2;

    if (startDate) {
      dateCondition += ` AND date >= $${paramCount}`;
      queryParams.push(startDate);
      paramCount++;
    }

    if (endDate) {
      dateCondition += ` AND date <= $${paramCount}`;
      queryParams.push(endDate);
      paramCount++;
    }

    const statsQuery = await pool.query(
      `SELECT 
        COALESCE(SUM(voice_notes_created), 0) as total_notes_created,
        COALESCE(SUM(voice_notes_played), 0) as total_notes_played,
        COALESCE(SUM(voice_notes_shared), 0) as total_notes_shared,
        COALESCE(SUM(voice_notes_downloaded), 0) as total_notes_downloaded,
        COALESCE(SUM(contacts_added), 0) as total_contacts_added,
        COALESCE(SUM(scheduled_messages_created), 0) as total_scheduled_created,
        COALESCE(SUM(scheduled_messages_sent), 0) as total_scheduled_sent,
        COALESCE(SUM(total_recording_seconds), 0) as total_recording_seconds,
        COALESCE(SUM(total_playback_seconds), 0) as total_playback_seconds,
        COUNT(DISTINCT date) as active_days
       FROM daily_analytics 
       WHERE user_id = $1 ${dateCondition}`,
      queryParams
    );

    // Get most active day
    const mostActiveQuery = await pool.query(
      `SELECT date, 
              (voice_notes_created + voice_notes_played + contacts_added) as activity_score
       FROM daily_analytics 
       WHERE user_id = $1 ${dateCondition}
       ORDER BY activity_score DESC 
       LIMIT 1`,
      queryParams
    );

    // Get recent activity streak
    const streakQuery = await pool.query(
      `WITH RECURSIVE dates AS (
        SELECT CURRENT_DATE as date
        UNION ALL
        SELECT date - 1
        FROM dates
        WHERE date > CURRENT_DATE - 30
      ),
      active_days AS (
        SELECT DISTINCT date 
        FROM daily_analytics 
        WHERE user_id = $1 
          AND (voice_notes_created > 0 OR voice_notes_played > 0 OR contacts_added > 0)
          ${dateCondition.replace(/date/g, 'daily_analytics.date')}
      )
      SELECT MAX(streak) as current_streak
      FROM (
        SELECT date, 
               ROW_NUMBER() OVER (ORDER BY date DESC) - 
               ROW_NUMBER() OVER (PARTITION BY active_days.date IS NOT NULL ORDER BY dates.date DESC) as streak_group
        FROM dates
        LEFT JOIN active_days ON dates.date = active_days.date
        ORDER BY dates.date DESC
      ) streaks
      WHERE date = CURRENT_DATE`,
      queryParams
    );

    res.json({
      success: true,
      data: {
        ...statsQuery.rows[0],
        most_active_day: mostActiveQuery.rows[0] || null,
        current_streak: streakQuery.rows[0]?.current_streak || 0
      }
    });

  } catch (error) {
    console.error('Get analytics stats error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch analytics statistics'
    });
  }
});

module.exports = router;