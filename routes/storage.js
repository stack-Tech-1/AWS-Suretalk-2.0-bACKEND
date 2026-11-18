// C:\Users\SMC\Documents\GitHub\AWS-Suretalk-2.0-bACKEND\routes\storage.js (COMPLETE)
const express = require('express');
const router = express.Router();
const { body, validationResult } = require('express-validator');
const { authenticate, validateTier } = require('../middleware/auth');
const { pool } = require('../config/database');
const {
  generateUploadUrl,
  generateDownloadUrl,
  isOwnS3Key,
  BUCKETS
} = require('../utils/s3Storage');

// A file belongs to the person when it is in their own folder or on one of their own recordings
const ownsFile = async (key, userId) => {
  if (isOwnS3Key(key, userId)) return true;
  const r = await pool.query(
    `SELECT 1 FROM voice_notes WHERE s3_key = $1 AND user_id = $2
     UNION ALL SELECT 1 FROM voice_wills WHERE s3_key = $1 AND user_id = $2 LIMIT 1`,
    [key, userId]
  );
  return r.rows.length > 0;
};

// Generate upload URL for voice note
router.post('/upload-url/voice-note', authenticate, [
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

    const uploadData = await generateUploadUrl(
      req.user.id,
      fileName,
      fileType,
      'VOICE_NOTES'
    );

    res.json({
      success: true,
      data: uploadData
    });

  } catch (error) {
    console.error('Generate voice note upload URL error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to generate upload URL'
    });
  }
});

// Generate upload URL for legacy vault
router.post('/upload-url/vault', authenticate, validateTier('LEGACY_VAULT_PREMIUM'), [
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

    const bucketType = isWill ? 'WILLS' : 'LEGACY_VAULT';
    const uploadData = await generateUploadUrl(
      req.user.id,
      fileName,
      fileType,
      bucketType
    );

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

// Generate download URL
router.post('/download-url', authenticate, [
  body('key').notEmpty(),
  body('bucket').notEmpty(),
  body('expiresIn').optional().isInt({ min: 60, max: 86400 })
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({
        success: false,
        errors: errors.array()
      });
    }

    const { key, bucket, expiresIn = 3600 } = req.body;

    // Validate bucket access
    const allowedBuckets = Object.values(BUCKETS);
    if (!allowedBuckets.includes(bucket)) {
      return res.status(403).json({
        success: false,
        error: 'Access to this bucket is not allowed'
      });
    }

    // For legacy vault and wills, verify premium tier
    if ((bucket === BUCKETS.LEGACY_VAULT || bucket === BUCKETS.WILLS) && 
        req.user.subscription_tier !== 'LEGACY_VAULT_PREMIUM') {
      return res.status(403).json({
        success: false,
        error: 'Premium tier required for vault access'
      });
    }

    if (!(await ownsFile(key, req.user.id))) {
      return res.status(403).json({
        success: false,
        error: 'You do not have access to this file'
      });
    }

    const downloadUrl = await generateDownloadUrl(key, bucket, parseInt(expiresIn));

    res.json({
      success: true,
      data: {
        downloadUrl,
        expiresIn: parseInt(expiresIn)
      }
    });

  } catch (error) {
    console.error('Generate download URL error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to generate download URL'
    });
  }
});

// Get storage usage by user
router.get('/usage', authenticate, async (req, res) => {
  try {
    const { pool } = require('../config/database');
    
    const usageQuery = await pool.query(
      `SELECT 
        COALESCE(SUM(file_size_bytes), 0) as total_bytes,
        COUNT(*) as file_count,
        COUNT(CASE WHEN s3_bucket = $2 THEN 1 END) as voice_notes_count,
        COUNT(CASE WHEN s3_bucket = $3 THEN 1 END) as vault_items_count,
        COUNT(CASE WHEN s3_bucket = $4 THEN 1 END) as wills_count
       FROM voice_notes 
       WHERE user_id = $1 AND deleted_at IS NULL`,
      [
        req.user.id,
        BUCKETS.VOICE_NOTES,
        BUCKETS.LEGACY_VAULT,
        BUCKETS.WILLS
      ]
    );

    // Get user's storage limit
    const userQuery = await pool.query(
      'SELECT storage_limit_gb FROM users WHERE id = $1',
      [req.user.id]
    );

    const usage = usageQuery.rows[0];
    const storageLimitBytes = (userQuery.rows[0]?.storage_limit_gb || 5) * 1024 * 1024 * 1024;
    const usagePercentage = storageLimitBytes > 0 ? (usage.total_bytes / storageLimitBytes) * 100 : 0;

    res.json({
      success: true,
      data: {
        ...usage,
        storage_limit_bytes: storageLimitBytes,
        usage_percentage: usagePercentage.toFixed(2),
        remaining_bytes: Math.max(0, storageLimitBytes - usage.total_bytes)
      }
    });

  } catch (error) {
    console.error('Get storage usage error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to get storage usage'
    });
  }
});

module.exports = router;