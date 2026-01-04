// C:\Users\SMC\Documents\GitHub\AWS-Suretalk-2.0-fRONTEND\surechat-backend\routes\scheduled.js
const express = require('express');
const router = express.Router();
const { body, validationResult } = require('express-validator');
const { authenticate } = require('../middleware/auth');
const { pool } = require('../config/database');
const { generateDownloadUrl } = require('../utils/s3Storage');
const Twilio = require('twilio');
const nodemailer = require('nodemailer');
const { createNotification } = require('./notifications');

// Initialize Twilio client
const twilioClient = process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN
  ? new Twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN)
  : null;


  // Initialize email transporter
const emailTransporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: process.env.SMTP_PORT,
  secure: process.env.SMTP_SECURE === 'true',
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS
  }
});



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

     // Create notification
  await createNotification(req.user.id, 'message', 
    'scheduled message created', 
    `"${Message.title}" has been successfully recorded`,
    {
      messageId: message.id,
      title: message.title,      
      url: `/usersDashboard/scheduled/${message.id}`
    },
    '/icons/message-sent.png'
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


// Add this new endpoint for scheduling with contacts
router.post('/schedule-with-contacts', authenticate, [
  body('voiceNoteId').notEmpty().isUUID(),
  body('contactIds').isArray().notEmpty(),
  body('deliveryMethod').isIn(['email', 'sms', 'both']),
  body('scheduledFor').isISO8601(),
  body('message').optional().trim()
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
      contactIds,
      deliveryMethod,
      scheduledFor,
      message,
      customSubject,
      customMessage
    } = req.body;

    // Verify voice note belongs to user
    const noteQuery = await pool.query(
      `SELECT vn.*, u.email as user_email, u.full_name as user_name
       FROM voice_notes vn
       JOIN users u ON vn.user_id = u.id
       WHERE vn.id = $1 AND vn.user_id = $2 AND vn.deleted_at IS NULL`,
      [voiceNoteId, req.user.id]
    );

    if (noteQuery.rows.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'Voice note not found'
      });
    }

    const voiceNote = noteQuery.rows[0];

    // Get contacts
    const contactsQuery = await pool.query(
      `SELECT id, name, email, phone, can_receive_messages
       FROM contacts 
       WHERE id = ANY($1) AND user_id = $2`,
      [contactIds, req.user.id]
    );

    if (contactsQuery.rows.length === 0) {
      return res.status(400).json({
        success: false,
        error: 'No valid contacts found'
      });
    }

    const contacts = contactsQuery.rows;
    const scheduledMessages = [];

    // Generate download URL for voice note
    const downloadUrl = await generateDownloadUrl(
      voiceNote.s3_key,
      voiceNote.s3_bucket,
      7 * 24 * 3600 // 7 days expiry for scheduled messages
    );

    // Create scheduled message for each contact
    for (const contact of contacts) {
      if (!contact.can_receive_messages) {
        continue; // Skip contacts who can't receive messages
      }

      let recipientEmail = null;
      let recipientPhone = null;

      if (deliveryMethod.includes('email') && contact.email) {
        recipientEmail = contact.email;
      }

      if (deliveryMethod.includes('sms') && contact.phone) {
        recipientPhone = contact.phone;
      }

      if (!recipientEmail && !recipientPhone) {
        continue; // Skip if no valid delivery method for this contact
      }

      // Create scheduled message record
      const scheduledMessage = await pool.query(
        `INSERT INTO scheduled_messages (
          user_id, voice_note_id, recipient_contact_id,
          recipient_email, recipient_phone, delivery_method,
          scheduled_for, custom_message, metadata
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
        RETURNING *`,
        [
          req.user.id,
          voiceNoteId,
          contact.id,
          recipientEmail,
          recipientPhone,
          deliveryMethod,
          new Date(scheduledFor),
          customMessage || message || `Voice note from ${voiceNote.user_name}`,
          JSON.stringify({
            voiceNoteTitle: voiceNote.title,
            contactName: contact.name,
            downloadUrl,
            deliveryAttempts: 0,
            scheduledBy: req.user.id
          })
        ]
      );

      scheduledMessages.push(scheduledMessage.rows[0]);

      // Record analytics event
      await pool.query(
        `INSERT INTO analytics_events (
          user_id, event_type, voice_note_id, contact_id, event_data
        ) VALUES ($1, 'scheduled_message_created', $2, $3, $4)`,
        [
          req.user.id,
          voiceNoteId,
          contact.id,
          JSON.stringify({
            scheduledFor,
            deliveryMethod,
            noteTitle: voiceNote.title,
            contactName: contact.name
          })
        ]
      );
    }

    res.status(201).json({
      success: true,
      message: `Scheduled ${scheduledMessages.length} message(s) successfully`,
      data: {
        scheduledMessages,
        totalScheduled: scheduledMessages.length,
        skippedContacts: contacts.length - scheduledMessages.length
      }
    });

  } catch (error) {
    console.error('Schedule with contacts error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to schedule messages'
    });
  }
});

// Add email/SMS sending functionality
const sendEmailNotification = async (to, subject, message, downloadUrl, voiceNoteTitle, senderName) => {
  try {
    const emailHtml = `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>${subject}</title>
        <style>
          body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: 0 auto; padding: 20px; }
          .header { background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; padding: 30px; text-align: center; border-radius: 10px 10px 0 0; }
          .content { background: #f9f9f9; padding: 30px; border-radius: 0 0 10px 10px; }
          .button { display: inline-block; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; padding: 12px 30px; text-decoration: none; border-radius: 5px; margin: 20px 0; }
          .footer { margin-top: 30px; padding-top: 20px; border-top: 1px solid #eee; color: #666; font-size: 12px; }
        </style>
      </head>
      <body>
        <div class="header">
          <h1>${voiceNoteTitle}</h1>
          <p>A voice message from ${senderName}</p>
        </div>
        <div class="content">
          <p>${message}</p>
          <p>Click the button below to listen to the voice note:</p>
          <a href="${downloadUrl}" class="button">Listen to Voice Note</a>
          <p><small>This link will expire in 7 days.</small></p>
          <div class="footer">
            <p>Sent via SureTalk - Your Voice, Preserved Forever</p>
            <p>If you didn't expect this message, please ignore it.</p>
          </div>
        </div>
      </body>
      </html>
    `;

    const mailOptions = {
      from: `"SureTalk" <${process.env.SMTP_FROM || 'noreply@suretalk.com'}>`,
      to,
      subject,
      html: emailHtml,
      text: `${message}\n\nListen to voice note: ${downloadUrl}\n\nThis link will expire in 7 days.`
    };

    await emailTransporter.sendMail(mailOptions);
    return true;
  } catch (error) {
    console.error('Email sending error:', error);
    throw error;
  }
};

const sendSMSNotification = async (to, message, downloadUrl, voiceNoteTitle, senderName) => {
  try {
    const smsMessage = `
${message}

Voice note "${voiceNoteTitle}" from ${senderName}
Listen here: ${downloadUrl}

Link expires in 7 days.
Sent via SureTalk
    `.trim();

    await twilioClient.messages.create({
      body: smsMessage,
      from: process.env.TWILIO_PHONE_NUMBER,
      to
    });

    return true;
  } catch (error) {
    console.error('SMS sending error:', error);
    throw error;
  }
};

// Add endpoint to send test message
router.post('/send-test', authenticate, [
  body('voiceNoteId').notEmpty().isUUID(),
  body('recipientEmail').optional().isEmail(),
  body('recipientPhone').optional().isMobilePhone(),
  body('deliveryMethod').isIn(['email', 'sms', 'both'])
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({
        success: false,
        errors: errors.array()
      });
    }

    const { voiceNoteId, recipientEmail, recipientPhone, deliveryMethod } = req.body;

    // Verify voice note
    const noteQuery = await pool.query(
      `SELECT vn.*, u.email as user_email, u.full_name as user_name
       FROM voice_notes vn
       JOIN users u ON vn.user_id = u.id
       WHERE vn.id = $1 AND vn.user_id = $2`,
      [voiceNoteId, req.user.id]
    );

    if (noteQuery.rows.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'Voice note not found'
      });
    }

    const voiceNote = noteQuery.rows[0];
    const downloadUrl = await generateDownloadUrl(
      voiceNote.s3_key,
      voiceNote.s3_bucket,
      3600 // 1 hour for test
    );

    const testResults = [];

    // Send test email
    if (deliveryMethod.includes('email') && recipientEmail) {
      try {
        await sendEmailNotification(
          recipientEmail,
          `Test: ${voiceNote.title}`,
          'This is a test message from SureTalk',
          downloadUrl,
          voiceNote.title,
          voiceNote.user_name
        );
        testResults.push({
          method: 'email',
          recipient: recipientEmail,
          status: 'sent'
        });
      } catch (emailError) {
        testResults.push({
          method: 'email',
          recipient: recipientEmail,
          status: 'failed',
          error: emailError.message
        });
      }
    }

    // Send test SMS
    if (deliveryMethod.includes('sms') && recipientPhone) {
      try {
        await sendSMSNotification(
          recipientPhone,
          'Test message from SureTalk',
          downloadUrl,
          voiceNote.title,
          voiceNote.user_name
        );
        testResults.push({
          method: 'sms',
          recipient: recipientPhone,
          status: 'sent'
        });
      } catch (smsError) {
        testResults.push({
          method: 'sms',
          recipient: recipientPhone,
          status: 'failed',
          error: smsError.message
        });
      }
    }

    res.json({
      success: true,
      message: 'Test completed',
      data: {
        testResults,
        downloadUrl
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

module.exports = router;