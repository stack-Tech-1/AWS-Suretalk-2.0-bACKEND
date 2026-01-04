// C:\Users\SMC\Documents\GitHub\AWS-Suretalk-2.0-fRONTEND\surechat-backend\routes\voiceNotes.js
const express = require('express');
const router = express.Router();
const { body, validationResult } = require('express-validator');
const { authenticate, validateTier, recordAnalyticsEvent } = require('../middleware/auth');
const { pool } = require('../config/database');
const { generateUploadUrl, generateDownloadUrl, uploadToS3, BUCKETS } = require('../utils/s3Storage');
const { v4: uuidv4 } = require('uuid');
const { createNotification } = require('./notifications');

// Get all voice notes for user
router.get('/', authenticate, async (req, res) => {
  try {
    const { page = 1, limit = 20, filter, search } = req.query;
    const offset = (page - 1) * limit;

    let query = `
      SELECT vn.*, 
             (SELECT COUNT(*) FROM voice_notes WHERE user_id = $1 AND deleted_at IS NULL) as total_count
      FROM voice_notes vn
      WHERE vn.user_id = $1 AND vn.deleted_at IS NULL
    `;

    const queryParams = [req.user.id];
    let paramCount = 2;

    // Apply filters
    if (filter === 'favorites') {
      query += ` AND vn.is_favorite = true`;
    } else if (filter === 'permanent') {
      query += ` AND vn.is_permanent = true`;
    } else if (filter === 'scheduled') {
      query += ` AND vn.scheduled_for IS NOT NULL AND vn.scheduled_for > CURRENT_TIMESTAMP`;
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

    // Generate download URLs for each note
    const notesWithUrls = await Promise.all(
      result.rows.map(async (note) => {
        const downloadUrl = await generateDownloadUrl(
          note.s3_key,
          note.s3_bucket,
          3600 // 1 hour expiry
        );
        
        return {
          ...note,
          downloadUrl,
          canDownload: true
        };
      })
    );

    res.json({
      success: true,
      data: {
        notes: notesWithUrls,
        pagination: {
          page: parseInt(page),
          limit: parseInt(limit),
          total: result.rows[0]?.total_count || 0,
          totalPages: Math.ceil((result.rows[0]?.total_count || 0) / limit)
        }
      }
    });

  } catch (error) {
    console.error('Get voice notes error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch voice notes'
    });
  }
});

// Get single voice note
router.get('/:id', authenticate, async (req, res) => {
  try {
    const { id } = req.params;

    const result = await pool.query(
      `SELECT vn.*, 
              u.full_name as user_name
       FROM voice_notes vn
       LEFT JOIN users u ON vn.user_id = u.id
       WHERE vn.id = $1 AND vn.user_id = $2 AND vn.deleted_at IS NULL`,
      [id, req.user.id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'Voice note not found'
      });
    }

    const note = result.rows[0];
    
    // Generate download URL
    const downloadUrl = await generateDownloadUrl(
      note.s3_key,
      note.s3_bucket,
      3600
    );

    // Increment play count
    await pool.query(
      `UPDATE voice_notes 
       SET play_count = play_count + 1, 
           last_played = CURRENT_TIMESTAMP 
       WHERE id = $1`,
      [id]
    );

    // Record analytics event for play
    try {
      await pool.query(
        `INSERT INTO analytics_events (user_id, event_type, voice_note_id)
        VALUES ($1, 'voice_note_played', $2)`,
        [req.user.id, id]
      );
    } catch (analyticsError) {
      console.warn('Failed to record play analytics event:', analyticsError);
    }

    res.json({
      success: true,
      data: {
        ...note,
        downloadUrl,
        canDownload: true
      }
    });

  } catch (error) {
    console.error('Get voice note error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch voice note'
    });
  }
});

// Generate upload URL for new voice note
router.post('/upload-url', authenticate, [
  body('fileName').notEmpty(),
  body('fileType').notEmpty()
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({
        success: false,
        errors: errors.array()
      });
    }

    const { fileName, fileType } = req.body;

    // Check user's storage limits
    const userQuery = await pool.query(
      `SELECT subscription_tier, 
              (SELECT COUNT(*) FROM voice_notes WHERE user_id = $1 AND deleted_at IS NULL) as note_count
       FROM users WHERE id = $1`,
      [req.user.id]
    );

    const user = userQuery.rows[0];
    const tier = user.subscription_tier;

    // Apply limits based on tier
    if (tier === 'LITE' && user.note_count >= 3) {
      return res.status(403).json({
        success: false,
        error: 'LITE tier limit reached (3 notes max). Upgrade to add more notes.'
      });
    }

    // Generate upload URL
    const uploadData = await generateUploadUrl(req.user.id, fileName, fileType, 'VOICE_NOTES');

    res.json({
      success: true,
      data: uploadData
    });

  } catch (error) {
    console.error('Generate upload URL error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to generate upload URL'
    });
  }
});

// Direct upload (alternative to pre-signed URL)
router.post('/upload', authenticate, uploadToS3('VOICE_NOTES').single('audio'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({
        success: false,
        error: 'No file uploaded'
      });
    }

    const { title, description, duration, tags, isPermanent } = req.body;
    const file = req.file;

    // Validate tier for permanent storage
    if (isPermanent === 'true' && req.user.subscription_tier !== 'LEGACY_VAULT_PREMIUM') {
      return res.status(403).json({
        success: false,
        error: 'Permanent storage requires LEGACY_VAULT_PREMIUM tier'
      });
    }

    // Create voice note record
    const result = await pool.query(
      `INSERT INTO voice_notes (
        user_id, title, description, s3_key, s3_bucket,
        file_size_bytes, duration_seconds, is_permanent, tags
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      RETURNING *`,
      [
        req.user.id,
        title || 'Untitled Recording',
        description || '',
        file.key,
        file.bucket,
        file.size,
        parseInt(duration) || 0,
        isPermanent === 'true',
        tags ? tags.split(',').map(tag => tag.trim()) : []
      ]
    );

    // If permanent, also copy to legacy vault
    if (isPermanent === 'true') {
      // This would be done via S3 lifecycle rules or Lambda
      // For now, we just mark it as permanent
    }

    const note = result.rows[0];
    const downloadUrl = await generateDownloadUrl(note.s3_key, note.s3_bucket, 3600);

    res.status(201).json({
      success: true,
      message: 'Voice note uploaded successfully',
      data: {
        ...note,
        downloadUrl
      }
    });

  } catch (error) {
    console.error('Upload error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to upload voice note'
    });
  }
});

// Create voice note after upload (with pre-signed URL)
router.post('/', authenticate, [
  body('title').notEmpty().trim(),
  body('s3Key').notEmpty(),
  body('s3Bucket').notEmpty(),
  body('fileSize').isInt({ min: 1 }),
  body('duration').isInt({ min: 1 })
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
      fileSize, 
      duration,
      tags,
      isPermanent,
      scheduledFor 
    } = req.body;

    // Validate tier for permanent storage
    if (isPermanent && req.user.subscription_tier !== 'LEGACY_VAULT_PREMIUM') {
      return res.status(403).json({
        success: false,
        error: 'Permanent storage requires LEGACY_VAULT_PREMIUM tier'
      });
    }

    // Create voice note record
    const result = await pool.query(
      `INSERT INTO voice_notes (
        user_id, title, description, s3_key, s3_bucket,
        file_size_bytes, duration_seconds, is_permanent, tags, scheduled_for
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
      RETURNING *`,
      [
        req.user.id,
        title,
        description || '',
        s3Key,
        s3Bucket,
        parseInt(fileSize),
        parseInt(duration),
        isPermanent || false,
        tags ? tags.split(',').map(tag => tag.trim()) : [],
        scheduledFor || null
      ]
    );

    // Add analytics event
      try {
        await pool.query(
          `INSERT INTO analytics_events (user_id, event_type, voice_note_id, event_data)
          VALUES ($1, 'voice_note_created', $2, $3)`,
          [req.user.id, note.id, JSON.stringify({
            title: note.title,
            duration: note.duration_seconds,
            size: note.file_size_bytes,
            is_permanent: note.is_permanent
          })]
        );
      } catch (analyticsError) {
        console.warn('Failed to record analytics event:', analyticsError);
        // Don't fail the main request if analytics fails
      }


    const note = result.rows[0];
    const downloadUrl = await generateDownloadUrl(note.s3_key, note.s3_bucket, 3600);
    // Create notification
  await createNotification(req.user.id, 'voice_note', 
    'Voice Note Created', 
    `"${voiceNote.title}" has been successfully recorded`,
    {
      voiceNoteId: voiceNote.id,
      title: voiceNote.title,
      duration: voiceNote.duration_seconds,
      url: `/usersDashboard/voice-notes/${voiceNote.id}`
    },
    '/icons/voice-note.png'
  );

    res.status(201).json({
      success: true,
      message: 'Voice note created successfully',
      data: {
        ...note,
        downloadUrl
      }
    });

  } catch (error) {
    console.error('Create voice note error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to create voice note'
    });
  }
});

// Update voice note
router.put('/:id', authenticate, async (req, res) => {
  try {
    const { id } = req.params;
    const { title, description, isFavorite, tags } = req.body;

    // Check ownership
    const ownershipCheck = await pool.query(
      'SELECT id FROM voice_notes WHERE id = $1 AND user_id = $2',
      [id, req.user.id]
    );

    if (ownershipCheck.rows.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'Voice note not found'
      });
    }

    const updates = [];
    const values = [];
    let paramCount = 1;

    if (title !== undefined) {
      updates.push(`title = $${paramCount}`);
      values.push(title);
      paramCount++;
    }

    if (description !== undefined) {
      updates.push(`description = $${paramCount}`);
      values.push(description);
      paramCount++;
    }

    if (isFavorite !== undefined) {
      updates.push(`is_favorite = $${paramCount}`);
      values.push(isFavorite);
      paramCount++;
    }

    if (tags !== undefined) {
      updates.push(`tags = $${paramCount}`);
      values.push(tags.split(',').map(tag => tag.trim()));
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
      UPDATE voice_notes 
      SET ${updates.join(', ')}
      WHERE id = $${paramCount} AND user_id = $${paramCount + 1}
      RETURNING *
    `;

    const result = await pool.query(query, values);
    const note = result.rows[0];
    
    const downloadUrl = await generateDownloadUrl(note.s3_key, note.s3_bucket, 3600);

    res.json({
      success: true,
      message: 'Voice note updated successfully',
      data: {
        ...note,
        downloadUrl
      }
    });

  } catch (error) {
    console.error('Update voice note error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to update voice note'
    });
  }
});

// Mark as permanent (requires premium tier)
router.post('/:id/mark-permanent', authenticate, validateTier('LEGACY_VAULT_PREMIUM'), async (req, res) => {
  try {
    const { id } = req.params;

    // Check ownership and current status
    const noteCheck = await pool.query(
      'SELECT id, is_permanent, s3_key, s3_bucket FROM voice_notes WHERE id = $1 AND user_id = $2',
      [id, req.user.id]
    );

    if (noteCheck.rows.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'Voice note not found'
      });
    }

    const note = noteCheck.rows[0];

    if (note.is_permanent) {
      return res.status(400).json({
        success: false,
        error: 'Voice note is already marked as permanent'
      });
    }

    // Update to permanent
    await pool.query(
      `UPDATE voice_notes 
       SET is_permanent = true, 
           storage_class = 'STANDARD',
           retention_policy = 'permanent'
       WHERE id = $1`,
      [id]
    );

    // In production: Copy file to legacy vault bucket with KMS encryption
    // For now, we just update the metadata

    res.json({
      success: true,
      message: 'Voice note marked as permanent'
    });

  } catch (error) {
    console.error('Mark permanent error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to mark as permanent'
    });
  }
});

// Delete voice note (soft delete)
router.delete('/:id', authenticate, async (req, res) => {
  try {
    const { id } = req.params;

    // Check ownership
    const ownershipCheck = await pool.query(
      'SELECT id, s3_key, s3_bucket FROM voice_notes WHERE id = $1 AND user_id = $2',
      [id, req.user.id]
    );

    if (ownershipCheck.rows.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'Voice note not found'
      });
    }

    // Soft delete
    await pool.query(
      'UPDATE voice_notes SET deleted_at = CURRENT_TIMESTAMP WHERE id = $1',
      [id]
    );

    // Note: In production, you might want to schedule actual S3 deletion
    // based on retention policies

    res.json({
      success: true,
      message: 'Voice note deleted successfully'
    });

  } catch (error) {
    console.error('Delete voice note error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to delete voice note'
    });
  }
});

// Get download URL for voice note
router.get('/:id/download', authenticate, async (req, res) => {
  try {
    const { id } = req.params;

    const result = await pool.query(
      'SELECT s3_key, s3_bucket FROM voice_notes WHERE id = $1 AND user_id = $2',
      [id, req.user.id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'Voice note not found'
      });
    }

    const { s3_key, s3_bucket } = result.rows[0];
    const downloadUrl = await generateDownloadUrl(s3_key, s3_bucket, 3600);

    res.json({
      success: true,
      data: {
        downloadUrl
      }
    });

    // Record analytics event for download
      try {
        await pool.query(
          `INSERT INTO analytics_events (user_id, event_type, voice_note_id)
          VALUES ($1, 'voice_note_downloaded', $2)`,
          [req.user.id, id]
        );
      } catch (analyticsError) {
        console.warn('Failed to record download analytics event:', analyticsError);
      }

  } catch (error) {
    console.error('Get download URL error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to generate download URL'
    });
  }
});

// Get voice note statistics
router.get('/stats', authenticate, async (req, res) => {
  try {
    const statsQuery = await pool.query(
      `SELECT 
        COUNT(*) as total_notes,
        COUNT(CASE WHEN is_favorite THEN 1 END) as favorite_notes,
        COUNT(CASE WHEN is_permanent THEN 1 END) as permanent_notes,
        COUNT(CASE WHEN scheduled_for IS NOT NULL AND scheduled_for > CURRENT_TIMESTAMP THEN 1 END) as scheduled_notes,
        COALESCE(SUM(file_size_bytes), 0) as total_storage_bytes,
        COALESCE(SUM(duration_seconds), 0) as total_duration_seconds
       FROM voice_notes 
       WHERE user_id = $1 AND deleted_at IS NULL`,
      [req.user.id]
    );

    res.json({
      success: true,
      data: statsQuery.rows[0]
    });

  } catch (error) {
    console.error('Get stats error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch statistics'
    });
  }
});

module.exports = router;