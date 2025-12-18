// C:\Users\SMC\Documents\GitHub\AWS-Suretalk-2.0-fRONTEND\surechat-backend\routes\vault.js
const express = require('express');
const router = express.Router();
const { body, validationResult } = require('express-validator');
const { authenticate, validateTier } = require('../middleware/auth');
const { pool } = require('../config/database');
const { 
  generateUploadUrl, 
  generateDownloadUrl,
  BUCKETS 
} = require('../utils/s3Storage');

// Get all vault items (permanent voice notes)
router.get('/', authenticate, validateTier('LEGACY_VAULT_PREMIUM'), async (req, res) => {
  try {
    const { page = 1, limit = 20, filter, search } = req.query;
    const offset = (page - 1) * limit;

    let query = `
      SELECT vn.*, 
             (SELECT COUNT(*) FROM voice_notes WHERE user_id = $1 AND is_permanent = true AND deleted_at IS NULL) as total_count
      FROM voice_notes vn
      WHERE vn.user_id = $1 AND vn.is_permanent = true AND vn.deleted_at IS NULL
    `;

    const queryParams = [req.user.id];
    let paramCount = 2;

    // Apply filters
    if (filter === 'wills') {
      query += ` AND vn.s3_bucket = $${paramCount}`;
      queryParams.push(BUCKETS.WILLS);
      paramCount++;
    }

    // Apply search
    if (search) {
      query += ` AND (vn.title ILIKE $${paramCount} OR vn.description ILIKE $${paramCount})`;
      queryParams.push(`%${search}%`);
      paramCount++;
    }

    // Order and pagination
    query += ` ORDER BY vn.created_at DESC LIMIT $${paramCount} OFFSET $${paramCount + 1}`;
    queryParams.push(parseInt(limit), offset);

    const result = await pool.query(query, queryParams);

    // Generate download URLs for each item
    const itemsWithUrls = await Promise.all(
      result.rows.map(async (item) => {
        const downloadUrl = await generateDownloadUrl(
          item.s3_key,
          item.s3_bucket,
          3600
        );
        
        return {
          ...item,
          downloadUrl,
          canDownload: true,
          isEncrypted: item.s3_bucket === BUCKETS.LEGACY_VAULT || item.s3_bucket === BUCKETS.WILLS
        };
      })
    );

    res.json({
      success: true,
      data: {
        items: itemsWithUrls,
        pagination: {
          page: parseInt(page),
          limit: parseInt(limit),
          total: result.rows[0]?.total_count || 0,
          totalPages: Math.ceil((result.rows[0]?.total_count || 0) / limit)
        }
      }
    });

  } catch (error) {
    console.error('Get vault items error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch vault items'
    });
  }
});

// Get voice wills
router.get('/wills', authenticate, validateTier('LEGACY_VAULT_PREMIUM'), async (req, res) => {
  try {
    const { page = 1, limit = 20 } = req.query;
    const offset = (page - 1) * limit;

    const result = await pool.query(
      `SELECT vw.*, 
              (SELECT COUNT(*) FROM voice_wills WHERE user_id = $1) as total_count
       FROM voice_wills vw
       WHERE vw.user_id = $1
       ORDER BY vw.created_at DESC
       LIMIT $2 OFFSET $3`,
      [req.user.id, parseInt(limit), offset]
    );

    // Generate download URLs and get beneficiary names
    const willsWithDetails = await Promise.all(
      result.rows.map(async (will) => {
        const downloadUrl = await generateDownloadUrl(
          will.s3_key,
          will.s3_bucket,
          3600
        );

        // Get beneficiary names
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
          downloadUrl,
          canDownload: !will.is_released,
          beneficiaryNames,
          isEncrypted: true
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
    console.error('Get voice wills error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch voice wills'
    });
  }
});

// Create voice will
router.post('/wills', authenticate, validateTier('LEGACY_VAULT_PREMIUM'), [
  body('title').notEmpty().trim(),
  body('description').optional().trim(),
  body('s3Key').notEmpty(),
  body('s3Bucket').notEmpty(),
  body('releaseCondition').isIn(['date', 'manual', 'event']),
  body('releaseDate').optional().isISO8601(),
  body('beneficiaries').optional().isArray(),
  body('executors').optional().isArray()
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
      title,
      description,
      s3Key,
      s3Bucket,
      releaseCondition,
      releaseDate,
      beneficiaries,
      executors,
      verificationRequired
    } = req.body;

    // Create voice will record
    const result = await pool.query(
      `INSERT INTO voice_wills (
        user_id, title, description, s3_key, s3_bucket,
        release_condition, release_date, beneficiaries, executors, verification_required
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
      RETURNING *`,
      [
        req.user.id,
        title,
        description || '',
        s3Key,
        s3Bucket,
        releaseCondition,
        releaseDate || null,
        beneficiaries || [],
        executors || [],
        verificationRequired !== false // Default to true
      ]
    );

    const will = result.rows[0];
    const downloadUrl = await generateDownloadUrl(will.s3_key, will.s3_bucket, 3600);

    res.status(201).json({
      success: true,
      message: 'Voice will created successfully',
      data: {
        ...will,
        downloadUrl,
        canDownload: false // Wills cannot be downloaded by creator
      }
    });

  } catch (error) {
    console.error('Create voice will error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to create voice will'
    });
  }
});

// Generate upload URL for legacy vault (with encryption)
router.post('/upload-url', authenticate, validateTier('LEGACY_VAULT_PREMIUM'), [
  body('fileName').notEmpty(),
  body('fileType').notEmpty(),
  body('isWill').optional().isBoolean()
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({
        success: false,
        errors: errors.array()
      });
    }

    const { fileName, fileType, isWill } = req.body;

    // Determine bucket type
    const bucketType = isWill ? 'WILLS' : 'LEGACY_VAULT';

    // Generate upload URL with encryption
    const uploadData = await generateUploadUrl(req.user.id, fileName, fileType, bucketType);

    res.json({
      success: true,
      data: {
        ...uploadData,
        isEncrypted: true,
        isWill: bucketType === 'WILLS'
      }
    });

  } catch (error) {
    console.error('Generate vault upload URL error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to generate upload URL'
    });
  }
});

// Mark existing voice note as permanent and move to vault
router.post('/:voiceNoteId/mark-permanent', authenticate, validateTier('LEGACY_VAULT_PREMIUM'), async (req, res) => {
  try {
    const { voiceNoteId } = req.params;

    // Get the voice note
    const noteQuery = await pool.query(
      `SELECT vn.*, u.subscription_tier
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

    if (voiceNote.is_permanent) {
      return res.status(400).json({
        success: false,
        error: 'Voice note is already permanent'
      });
    }

    // In production: Copy file to legacy vault bucket with KMS encryption
    // For now, we update the record to mark as permanent
    await pool.query(
      `UPDATE voice_notes 
       SET is_permanent = true, 
           storage_class = 'STANDARD',
           retention_policy = 'permanent',
           s3_bucket = $1
       WHERE id = $2`,
      [BUCKETS.LEGACY_VAULT, voiceNoteId]
    );

    res.json({
      success: true,
      message: 'Voice note moved to legacy vault successfully'
    });

  } catch (error) {
    console.error('Mark permanent error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to move to legacy vault'
    });
  }
});

// Get vault statistics
router.get('/stats', authenticate, validateTier('LEGACY_VAULT_PREMIUM'), async (req, res) => {
  try {
    const statsQuery = await pool.query(
      `SELECT 
        COUNT(*) as total_items,
        COUNT(CASE WHEN s3_bucket = $2 THEN 1 END) as vault_items,
        COUNT(CASE WHEN s3_bucket = $3 THEN 1 END) as wills,
        COALESCE(SUM(file_size_bytes), 0) as total_storage_bytes
       FROM voice_notes 
       WHERE user_id = $1 AND is_permanent = true AND deleted_at IS NULL`,
      [req.user.id, BUCKETS.LEGACY_VAULT, BUCKETS.WILLS]
    );

    // Add voice wills count
    const willsQuery = await pool.query(
      'SELECT COUNT(*) as total_wills FROM voice_wills WHERE user_id = $1',
      [req.user.id]
    );

    res.json({
      success: true,
      data: {
        ...statsQuery.rows[0],
        total_wills: willsQuery.rows[0].total_wills
      }
    });

  } catch (error) {
    console.error('Get vault stats error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch vault statistics'
    });
  }
});

// Schedule legacy message (for future delivery)
router.post('/schedule-message', authenticate, validateTier('LEGACY_VAULT_PREMIUM'), [
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
      scheduledFor
    } = req.body;

    // Verify voice note belongs to user and is permanent
    const noteQuery = await pool.query(
      'SELECT id FROM voice_notes WHERE id = $1 AND user_id = $2 AND is_permanent = true',
      [voiceNoteId, req.user.id]
    );

    if (noteQuery.rows.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'Voice note not found or not eligible for legacy messaging'
      });
    }

    // Verify recipient contact if provided
    if (recipientContactId) {
      const contactQuery = await pool.query(
        'SELECT id FROM contacts WHERE id = $1 AND user_id = $2',
        [recipientContactId, req.user.id]
      );

      if (contactQuery.rows.length === 0) {
        return res.status(404).json({
          success: false,
          error: 'Recipient contact not found'
        });
      }
    }

    // Create scheduled message
    const result = await pool.query(
      `INSERT INTO scheduled_messages (
        user_id, voice_note_id, recipient_contact_id,
        recipient_phone, recipient_email, delivery_method, scheduled_for
      ) VALUES ($1, $2, $3, $4, $5, $6, $7)
      RETURNING *`,
      [
        req.user.id,
        voiceNoteId,
        recipientContactId || null,
        recipientPhone || null,
        recipientEmail || null,
        deliveryMethod,
        new Date(scheduledFor)
      ]
    );

    res.status(201).json({
      success: true,
      message: 'Legacy message scheduled successfully',
      data: result.rows[0]
    });

  } catch (error) {
    console.error('Schedule legacy message error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to schedule legacy message'
    });
  }
});

// Get scheduled legacy messages
router.get('/scheduled-messages', authenticate, validateTier('LEGACY_VAULT_PREMIUM'), async (req, res) => {
  try {
    const { status = 'scheduled' } = req.query;

    const query = `
      SELECT sm.*, vn.title as voice_note_title, c.name as recipient_name
      FROM scheduled_messages sm
      LEFT JOIN voice_notes vn ON sm.voice_note_id = vn.id
      LEFT JOIN contacts c ON sm.recipient_contact_id = c.id
      WHERE sm.user_id = $1 AND sm.delivery_status = $2
      ORDER BY sm.scheduled_for ASC
    `;

    const result = await pool.query(query, [req.user.id, status]);

    res.json({
      success: true,
      data: result.rows
    });

  } catch (error) {
    console.error('Get scheduled messages error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch scheduled messages'
    });
  }
});

module.exports = router;