// C:\Users\SMC\Documents\GitHub\AWS-Suretalk-2.0-fRONTEND\surechat-backend\routes\scheduled.js
const express = require('express');
const router = express.Router();
const { body, validationResult } = require('express-validator');
const { authenticate } = require('../middleware/auth');
const { pool } = require('../config/database');
const { generateDownloadUrl } = require('../utils/s3Storage');
const Twilio = require('twilio');

// Initialize Twilio client
const twilioClient = process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN
  ? new Twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN)
  : null;

// Get all scheduled messages
router.get('/', authenticate, async (req, res) => {
  try {
    const { page = 1, limit = 20, status, search } = req.query;
    const offset = (page - 1) * limit;

    let query = `
      SELECT sm.*, 
             vn.title as voice_note_title,
             c.name as recipient_name,
             c.phone as recipient_contact_phone,
             c.email as recipient_contact_email,
             (SELECT COUNT(*) FROM scheduled_messages WHERE user_id = $1) as total_count
      FROM scheduled_messages sm
      LEFT JOIN voice_notes vn ON sm.voice_note_id = vn.id
      LEFT JOIN contacts c ON sm.recipient_contact_id = c.id
      WHERE sm.user_id = $1
    `;

    const queryParams = [req.user.id];
    let paramCount = 2;

    // Apply status filter
    if (status && status !== 'all') {
      query += ` AND sm.delivery_status = $${paramCount}`;
      queryParams.push(status);
      paramCount++;
    }

    // Apply search
    if (search) {
      query += ` AND (vn.title ILIKE $${paramCount} OR c.name ILIKE $${paramCount})`;
      queryParams.push(`%${search}%`);
      paramCount++;
    }

    // Order and pagination
    query += ` ORDER BY sm.scheduled_for ASC LIMIT $${paramCount} OFFSET $${paramCount + 1}`;
    queryParams.push(parseInt(limit), offset);

    const result = await pool.query(query, queryParams);

    // Generate download URLs for voice notes
    const messagesWithUrls = await Promise.all(
      result.rows.map(async (message) => {
        if (message.voice_note_id) {
          const downloadUrl = await generateDownloadUrl(
            message.s3_key,
            message.s3_bucket,
            3600
          );
          return {
            ...message,
            voiceNoteDownloadUrl: downloadUrl
          };
        }
        return message;
      })
    );

    res.json({
      success: true,
      data: {
        messages: messagesWithUrls,
        pagination: {
          page: parseInt(page),
          limit: parseInt(limit),
          total: result.rows[0]?.total_count || 0,
          totalPages: Math.ceil((result.rows[0]?.total_count || 0) / limit)
        }
      }
    });

  } catch (error) {
    console.error('Get scheduled messages error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch scheduled messages'
    });
  }
});

// Get single scheduled message
router.get('/:id', authenticate, async (req, res) => {
  try {
    const { id } = req.params;

    const result = await pool.query(
      `SELECT sm.*, 
              vn.title as voice_note_title,
              vn.s3_key,
              vn.s3_bucket,
              c.name as recipient_name,
              c.phone as recipient_contact_phone,
              c.email as recipient_contact_email
       FROM scheduled_messages sm
       LEFT JOIN voice_notes vn ON sm.voice_note_id = vn.id
       LEFT JOIN contacts c ON sm.recipient_contact_id = c.id
       WHERE sm.id = $1 AND sm.user_id = $2`,
      [id, req.user.id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'Scheduled message not found'
      });
    }

    const message = result.rows[0];

    // Generate download URL if voice note exists
    if (message.s3_key && message.s3_bucket) {
      const downloadUrl = await generateDownloadUrl(
        message.s3_key,
        message.s3_bucket,
        3600
      );
      message.voiceNoteDownloadUrl = downloadUrl;
    }

    res.json({
      success: true,
      data: message
    });

  } catch (error) {
    console.error('Get scheduled message error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch scheduled message'
    });
  }
});

// Create new scheduled message
router.post('/', authenticate, [
  body('voiceNoteId').notEmpty().isUUID(),
  body('recipientContactId').optional().isUUID(),
  body('recipientPhone').optional().isMobilePhone(),
  body('recipientEmail').optional().isEmail(),
  body('deliveryMethod').isIn(['phone', 'email', 'both']),
  body('scheduledFor').isISO8601()
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
      voiceNoteId,
      recipientContactId,
      recipientPhone,
      recipientEmail,
      deliveryMethod,
      scheduledFor,
      metadata
    } = req.body;

    // Verify voice note belongs to user
    const noteQuery = await pool.query(
      'SELECT id, title FROM voice_notes WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL',
      [voiceNoteId, req.user.id]
    );

    if (noteQuery.rows.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'Voice note not found'
      });
    }

    // Verify recipient contact if provided
    let finalRecipientPhone = recipientPhone;
    let finalRecipientEmail = recipientEmail;

    if (recipientContactId) {
      const contactQuery = await pool.query(
        'SELECT phone, email FROM contacts WHERE id = $1 AND user_id = $2',
        [recipientContactId, req.user.id]
      );

      if (contactQuery.rows.length === 0) {
        return res.status(404).json({
          success: false,
          error: 'Recipient contact not found'
        });
      }

      const contact = contactQuery.rows[0];
      if (!finalRecipientPhone && contact.phone) {
        finalRecipientPhone = contact.phone;
      }
      if (!finalRecipientEmail && contact.email) {
        finalRecipientEmail = contact.email;
      }
    }

    // Validate at least one recipient method is provided
    if (deliveryMethod.includes('phone') && !finalRecipientPhone) {
      return res.status(400).json({
        success: false,
        error: 'Phone number required for phone delivery'
      });
    }

    if (deliveryMethod.includes('email') && !finalRecipientEmail) {
      return res.status(400).json({
        success: false,
        error: 'Email required for email delivery'
      });
    }

    // Create scheduled message
    const result = await pool.query(
      `INSERT INTO scheduled_messages (
        user_id, voice_note_id, recipient_contact_id,
        recipient_phone, recipient_email, delivery_method, scheduled_for, metadata
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      RETURNING *`,
      [
        req.user.id,
        voiceNoteId,
        recipientContactId || null,
        finalRecipientPhone,
        finalRecipientEmail,
        deliveryMethod,
        new Date(scheduledFor),
        metadata || {}
      ]
    );

    res.status(201).json({
      success: true,
      message: 'Message scheduled successfully',
      data: result.rows[0]
    });

  } catch (error) {
    console.error('Schedule message error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to schedule message'
    });
  }
});

// Update scheduled message
router.put('/:id', authenticate, async (req, res) => {
  try {
    const { id } = req.params;
    const { scheduledFor, deliveryMethod, status } = req.body;

    // Check ownership
    const ownershipCheck = await pool.query(
      'SELECT id FROM scheduled_messages WHERE id = $1 AND user_id = $2',
      [id, req.user.id]
    );

    if (ownershipCheck.rows.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'Scheduled message not found'
      });
    }

    const updates = [];
    const values = [];
    let paramCount = 1;

    if (scheduledFor) {
      updates.push(`scheduled_for = $${paramCount}`);
      values.push(new Date(scheduledFor));
      paramCount++;
    }

    if (deliveryMethod) {
      updates.push(`delivery_method = $${paramCount}`);
      values.push(deliveryMethod);
      paramCount++;
    }

    if (status) {
      updates.push(`delivery_status = $${paramCount}`);
      values.push(status);
      paramCount++;
    }

    if (updates.length === 0) {
      return res.status(400).json({
        success: false,
        error: 'No updates provided'
      });
    }

    values.push(id);
    values.push(req.user.id);

    const query = `
      UPDATE scheduled_messages 
      SET ${updates.join(', ')}, updated_at = CURRENT_TIMESTAMP
      WHERE id = $${paramCount} AND user_id = $${paramCount + 1}
      RETURNING *
    `;

    const result = await pool.query(query, values);

    res.json({
      success: true,
      message: 'Scheduled message updated successfully',
      data: result.rows[0]
    });

  } catch (error) {
    console.error('Update scheduled message error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to update scheduled message'
    });
  }
});

// Cancel/delete scheduled message
router.delete('/:id', authenticate, async (req, res) => {
  try {
    const { id } = req.params;

    // Check ownership
    const ownershipCheck = await pool.query(
      'SELECT id FROM scheduled_messages WHERE id = $1 AND user_id = $2',
      [id, req.user.id]
    );

    if (ownershipCheck.rows.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'Scheduled message not found'
      });
    }

    // Only allow cancellation if not already delivered
    const statusCheck = await pool.query(
      'SELECT delivery_status FROM scheduled_messages WHERE id = $1',
      [id]
    );

    const currentStatus = statusCheck.rows[0].delivery_status;
    if (currentStatus === 'delivered' || currentStatus === 'failed') {
      return res.status(400).json({
        success: false,
        error: `Cannot cancel message with status: ${currentStatus}`
      });
    }

    // Update status to cancelled
    await pool.query(
      `UPDATE scheduled_messages 
       SET delivery_status = 'cancelled', updated_at = CURRENT_TIMESTAMP
       WHERE id = $1`,
      [id]
    );

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

// Send test message (immediate delivery)
router.post('/:id/send-test', authenticate, async (req, res) => {
  try {
    const { id } = req.params;

    // Check ownership
    const messageQuery = await pool.query(
      `SELECT sm.*, vn.s3_key, vn.s3_bucket
       FROM scheduled_messages sm
       LEFT JOIN voice_notes vn ON sm.voice_note_id = vn.id
       WHERE sm.id = $1 AND sm.user_id = $2`,
      [id, req.user.id]
    );

    if (messageQuery.rows.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'Scheduled message not found'
      });
    }

    const message = messageQuery.rows[0];

    // Generate download URL for voice note
    const downloadUrl = await generateDownloadUrl(
      message.s3_key,
      message.s3_bucket,
      3600 // 1 hour expiry for test
    );

    // Update status to testing
    await pool.query(
      `UPDATE scheduled_messages 
       SET delivery_status = 'testing', updated_at = CURRENT_TIMESTAMP
       WHERE id = $1`,
      [id]
    );

    // In production: Actually send via Twilio or email service
    // For now, return the download URL for manual testing
    res.json({
      success: true,
      message: 'Test initiated',
      data: {
        downloadUrl,
        recipientPhone: message.recipient_phone,
        recipientEmail: message.recipient_email,
        deliveryMethod: message.delivery_method
      }
    });

  } catch (error) {
    console.error('Send test error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to send test message'
    });
  }
});

// Get scheduled message statistics
router.get('/stats', authenticate, async (req, res) => {
  try {
    const statsQuery = await pool.query(
      `SELECT 
        COUNT(*) as total_messages,
        COUNT(CASE WHEN delivery_status = 'scheduled' THEN 1 END) as scheduled,
        COUNT(CASE WHEN delivery_status = 'delivered' THEN 1 END) as delivered,
        COUNT(CASE WHEN delivery_status = 'failed' THEN 1 END) as failed,
        COUNT(CASE WHEN delivery_status = 'cancelled' THEN 1 END) as cancelled,
        COUNT(CASE WHEN delivery_method = 'phone' THEN 1 END) as phone_messages,
        COUNT(CASE WHEN delivery_method = 'email' THEN 1 END) as email_messages
       FROM scheduled_messages 
       WHERE user_id = $1`,
      [req.user.id]
    );

    // Get upcoming messages count
    const upcomingQuery = await pool.query(
      `SELECT COUNT(*) as upcoming
       FROM scheduled_messages 
       WHERE user_id = $1 
         AND delivery_status = 'scheduled' 
         AND scheduled_for > CURRENT_TIMESTAMP`,
      [req.user.id]
    );

    res.json({
      success: true,
      data: {
        ...statsQuery.rows[0],
        ...upcomingQuery.rows[0]
      }
    });

  } catch (error) {
    console.error('Get scheduled stats error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch scheduled message statistics'
    });
  }
});

module.exports = router;