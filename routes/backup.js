// /routes/backup.js - Complete updated version
const express = require('express');
const router = express.Router();
const { body, validationResult } = require('express-validator');
const { authenticate, authenticateAdmin } = require('../middleware/auth');
const { pool } = require('../config/database');
const AWS = require('aws-sdk');
const archiver = require('archiver');
const { Readable } = require('stream');
const encryptionService = require('../utils/encryption');

// Initialize S3
const s3 = new AWS.S3({
  region: process.env.AWS_REGION,
  accessKeyId: process.env.AWS_ACCESS_KEY_ID,
  secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY
});

// Backup bucket
const BACKUP_BUCKET = process.env.AWS_S3_BUCKET_BACKUP || 'suertalk-backups';

// Create backup
router.post('/create', authenticate, [
  body('type').optional().isIn(['full', 'incremental', 'partial']),
  body('include').optional().isArray(),
  body('encrypt').optional().isBoolean()
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({
        success: false,
        errors: errors.array()
      });
    }

    const userId = req.user.id;
    const { type = 'full', include = ['all'], encrypt = true } = req.body;

    // Get user info for backup naming
    const userQuery = await pool.query(
      'SELECT email, subscription_tier FROM users WHERE id = $1',
      [userId]
    );

    if (userQuery.rows.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'User not found'
      });
    }

    const user = userQuery.rows[0];
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backupId = `${user.email.replace(/[^a-zA-Z0-9]/g, '-')}-${timestamp}`;
    const backupKey = `backups/${user.email}/${timestamp}/backup.zip`;

    // Start backup process in background
    setTimeout(async () => {
      try {
        await performBackup(userId, backupId, backupKey, type, include, encrypt);
      } catch (error) {
        console.error('Background backup failed:', error);
        
        // Update backup status to failed
        await pool.query(
          `UPDATE system_settings 
           SET setting_value = $1
           WHERE category = 'backup' 
             AND setting_key = 'lastBackup' 
             AND created_by = $2`,
          [JSON.stringify({
            backupId,
            type,
            status: 'failed',
            error: error.message,
            completedAt: new Date().toISOString()
          }), userId]
        );
        
        // Log backup failure
        await pool.query(
          `INSERT INTO system_logs (user_id, level, service, message, metadata)
           VALUES ($1, 'error', 'backup', 'Backup failed', $2)`,
          [userId, JSON.stringify({ 
            backupId, 
            error: error.message,
            timestamp: new Date().toISOString()
          })]
        );
      }
    }, 100);

    // Log backup initiation
    await pool.query(
      `INSERT INTO system_logs (user_id, level, service, message, metadata)
       VALUES ($1, 'info', 'backup', 'Backup initiated', $2)`,
      [userId, JSON.stringify({ 
        backupId, 
        type, 
        include, 
        encrypt,
        timestamp: new Date().toISOString()
      })]
    );

    // Store backup metadata
    await pool.query(
      `INSERT INTO system_settings (category, setting_key, setting_value, setting_type, created_by)
       VALUES ('backup', 'lastBackup', $1, 'json', $2)`,
      [JSON.stringify({
        backupId,
        type,
        status: 'processing',
        startedAt: new Date().toISOString(),
        size: 0,
        location: backupKey,
        encrypt,
        include
      }), userId]
    );

    res.json({
      success: true,
      message: 'Backup initiated successfully',
      data: {
        backupId,
        status: 'processing',
        estimatedCompletion: 'A few minutes',
        downloadUrl: `/api/users/backup/download/${backupId}`
      }
    });

  } catch (error) {
    console.error('Create backup error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to initiate backup'
    });
  }
});

// Get backup status
router.get('/status/:backupId', authenticate, async (req, res) => {
  try {
    const userId = req.user.id;
    const { backupId } = req.params;

    // Get backup metadata
    const backupQuery = await pool.query(
      `SELECT setting_value 
       FROM system_settings 
       WHERE category = 'backup' 
         AND setting_key = 'lastBackup' 
         AND created_by = $1`,
      [userId]
    );

    if (backupQuery.rows.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'Backup not found'
      });
    }

    const backupData = JSON.parse(backupQuery.rows[0].setting_value);

    // Check S3 for backup file
    let s3Status = 'unknown';
    let s3Metadata = {};
    try {
      const head = await s3.headObject({
        Bucket: BACKUP_BUCKET,
        Key: backupData.location
      }).promise();
      s3Status = 'exists';
      s3Metadata = head.Metadata || {};
    } catch (s3Error) {
      s3Status = 'not-found';
    }

    // Get backup logs
    const logsQuery = await pool.query(
      `SELECT level, message, created_at 
       FROM system_logs 
       WHERE user_id = $1 
         AND service = 'backup'
         AND metadata->>'backupId' = $2
       ORDER BY created_at DESC
       LIMIT 10`,
      [userId, backupId]
    );

    // Get encryption key info if encrypted
    let encryptionInfo = null;
    if (backupData.encrypt) {
      const keyQuery = await pool.query(
        `SELECT setting_value 
         FROM system_settings 
         WHERE category = 'backup_encryption' 
           AND setting_key = $1 
           AND created_by = $2`,
        [backupId, userId]
      );
      
      if (keyQuery.rows.length > 0) {
        encryptionInfo = JSON.parse(keyQuery.rows[0].setting_value);
      }
    }

    res.json({
      success: true,
      data: {
        ...backupData,
        s3Status,
        s3Metadata,
        logs: logsQuery.rows,
        encryptionInfo,
        canDownload: s3Status === 'exists' && backupData.status === 'completed'
      }
    });

  } catch (error) {
    console.error('Get backup status error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to get backup status'
    });
  }
});

// Download backup
router.get('/download/:backupId', authenticate, async (req, res) => {
  try {
    const userId = req.user.id;
    const { backupId } = req.params;

    // Get backup metadata
    const backupQuery = await pool.query(
      `SELECT setting_value 
       FROM system_settings 
       WHERE category = 'backup' 
         AND setting_key = 'lastBackup' 
         AND created_by = $1`,
      [userId]
    );

    if (backupQuery.rows.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'Backup not found'
      });
    }

    const backupData = JSON.parse(backupQuery.rows[0].setting_value);

    if (backupData.status !== 'completed') {
      return res.status(400).json({
        success: false,
        error: 'Backup is not ready for download'
      });
    }

    // Get backup from S3
    const s3Object = await s3.getObject({
      Bucket: BACKUP_BUCKET,
      Key: backupData.location
    }).promise();

    let backupBuffer = s3Object.Body;
    
    // Handle encrypted backups
    if (backupData.encrypt) {
      try {
        // Get encryption key
        const keyQuery = await pool.query(
          `SELECT setting_value 
           FROM system_settings 
           WHERE category = 'backup_encryption' 
             AND setting_key = $1 
             AND created_by = $2`,
          [backupId, userId]
        );

        if (keyQuery.rows.length === 0) {
          throw new Error('Encryption key not found');
        }

        const encryptionInfo = JSON.parse(keyQuery.rows[0].setting_value);
        
        // Decrypt the data key
        const dataKey = encryptionService.decryptDataKey(
          encryptionInfo.encryptedDataKey,
          encryptionInfo.iv
        );
        
        // Parse encrypted backup (stored as JSON)
        const encryptedData = JSON.parse(backupBuffer.toString());
        
        // Decrypt the backup
        backupBuffer = await encryptionService.decryptData(
          encryptedData.encrypted,
          dataKey,
          encryptedData.iv
        );
        
      } catch (decryptError) {
        console.error('Decryption error:', decryptError);
        return res.status(500).json({
          success: false,
          error: 'Failed to decrypt backup'
        });
      }
    }

    // Log download event
    await pool.query(
      `INSERT INTO system_logs (user_id, level, service, message, metadata)
       VALUES ($1, 'info', 'backup', 'Backup downloaded', $2)`,
      [userId, JSON.stringify({ 
        backupId, 
        timestamp: new Date().toISOString(),
        action: 'download'
      })]
    );

    // Set headers for download
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="backup-${backupId}.zip"`);
    res.setHeader('Content-Length', backupBuffer.length);
    
    // Send the backup file
    res.send(backupBuffer);

  } catch (error) {
    console.error('Download backup error:', error);
    
    if (error.code === 'NoSuchKey') {
      return res.status(404).json({
        success: false,
        error: 'Backup file not found in storage'
      });
    }
    
    res.status(500).json({
      success: false,
      error: 'Failed to download backup'
    });
  }
});

// List backups
router.get('/list', authenticate, async (req, res) => {
  try {
    const userId = req.user.id;
    const { limit = 10, offset = 0 } = req.query;

    // Get backup logs and metadata
    const backupsQuery = await pool.query(
      `SELECT 
         s.setting_value as backup_data,
         l.metadata->>'backupId' as backup_id,
         l.metadata->>'type' as type,
         l.message,
         l.level as status,
         l.created_at,
         l.metadata
       FROM system_logs l
       LEFT JOIN system_settings s ON 
         s.category = 'backup' 
         AND s.setting_key = 'lastBackup'
         AND s.created_by = $1
         AND s.setting_value::json->>'backupId' = l.metadata->>'backupId'
       WHERE l.user_id = $1 
         AND l.service = 'backup'
         AND l.message LIKE '%Backup%'
       ORDER BY l.created_at DESC
       LIMIT $2 OFFSET $3`,
      [userId, parseInt(limit), parseInt(offset)]
    );

    const totalQuery = await pool.query(
      `SELECT COUNT(*) as total 
       FROM system_logs 
       WHERE user_id = $1 
         AND service = 'backup'
         AND message LIKE '%Backup%'`,
      [userId]
    );

    // Get backup sizes from S3 and process data
    const backupsWithSizes = await Promise.all(
      backupsQuery.rows.map(async (backup) => {
        let size = 0;
        let s3Exists = false;
        
        try {
          const backupData = backup.backup_data ? JSON.parse(backup.backup_data) : {};
          
          if (backupData.location) {
            const head = await s3.headObject({
              Bucket: BACKUP_BUCKET,
              Key: backupData.location
            }).promise();
            
            size = head.ContentLength || 0;
            s3Exists = true;
          }
        } catch (error) {
          // Size unknown or file doesn't exist
        }

        return {
          id: backup.backup_id || backup.metadata?.backupId,
          type: backup.type || backup.metadata?.type,
          message: backup.message,
          status: backup.status,
          createdAt: backup.created_at,
          size,
          sizeFormatted: formatBytes(size),
          s3Exists,
          metadata: backup.metadata,
          backupData: backup.backup_data ? JSON.parse(backup.backup_data) : null
        };
      })
    );

    res.json({
      success: true,
      data: {
        backups: backupsWithSizes,
        pagination: {
          limit: parseInt(limit),
          offset: parseInt(offset),
          total: parseInt(totalQuery.rows[0].total)
        }
      }
    });

  } catch (error) {
    console.error('List backups error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to list backups'
    });
  }
});

// Helper function to perform actual backup WITH ENCRYPTION
async function performBackup(userId, backupId, backupKey, type, include, encrypt) {
  // Create a buffer for the backup
  const archive = archiver('zip', {
    zlib: { level: 9 }
  });

  const chunks = [];
  archive.on('data', (chunk) => chunks.push(chunk));
  archive.on('error', (err) => { throw err; });

  // Add user data based on include list
  if (include.includes('all') || include.includes('profile')) {
    const userQuery = await pool.query(
      `SELECT id, email, phone, full_name, subscription_tier, 
              profile_image_url, created_at, last_login
       FROM users WHERE id = $1`,
      [userId]
    );
    
    archive.append(JSON.stringify(userQuery.rows[0], null, 2), { 
      name: 'profile.json' 
    });
  }

  if (include.includes('all') || include.includes('voice_notes')) {
    const voiceNotesQuery = await pool.query(
      `SELECT id, title, description, file_size_bytes, duration_seconds,
              is_favorite, is_permanent, created_at, scheduled_for,
              s3_key, s3_bucket, mime_type
       FROM voice_notes 
       WHERE user_id = $1 AND deleted_at IS NULL`,
      [userId]
    );
    
    archive.append(JSON.stringify(voiceNotesQuery.rows, null, 2), { 
      name: 'voice_notes.json' 
    });

    // Include actual voice note files from S3
    for (const note of voiceNotesQuery.rows) {
      if (note.s3_key && note.s3_bucket) {
        try {
          const fileData = await s3.getObject({
            Bucket: note.s3_bucket,
            Key: note.s3_key
          }).promise();
          
          archive.append(fileData.Body, { 
            name: `voice_files/${note.id}.${getFileExtension(note.mime_type)}` 
          });
        } catch (error) {
          console.error(`Failed to backup voice note ${note.id}:`, error);
          archive.append(JSON.stringify({ 
            error: 'Failed to fetch file',
            noteId: note.id 
          }), { name: `voice_files/${note.id}.error.json` });
        }
      }
    }
  }

  // Add contacts if included
  if (include.includes('all') || include.includes('contacts')) {
    const contactsQuery = await pool.query(
      `SELECT id, name, phone, email, relationship, 
              is_beneficiary, can_receive_messages, notes, created_at
       FROM contacts 
       WHERE user_id = $1`,
      [userId]
    );
    
    archive.append(JSON.stringify(contactsQuery.rows, null, 2), { 
      name: 'contacts.json' 
    });
  }

  // Add scheduled messages if included
  if (include.includes('all') || include.includes('scheduled_messages')) {
    const scheduledQuery = await pool.query(
      `SELECT sm.id, sm.scheduled_for, sm.delivery_method, sm.delivery_status,
              sm.delivered_at, sm.error_message,
              vn.title as voice_note_title,
              c.name as recipient_name,
              sm.created_at
       FROM scheduled_messages sm
       LEFT JOIN voice_notes vn ON sm.voice_note_id = vn.id
       LEFT JOIN contacts c ON sm.recipient_contact_id = c.id
       WHERE sm.user_id = $1`,
      [userId]
    );
    
    archive.append(JSON.stringify(scheduledQuery.rows, null, 2), { 
      name: 'scheduled_messages.json' 
    });
  }

  // Add voice wills if included and user has PREMIUM
  if (include.includes('all') || include.includes('vault')) {
    const userTierQuery = await pool.query(
      'SELECT subscription_tier FROM users WHERE id = $1',
      [userId]
    );
    
    if (userTierQuery.rows[0]?.subscription_tier === 'PREMIUM') {
      const willsQuery = await pool.query(
        `SELECT id, title, description, s3_key, s3_bucket,
                release_condition, release_date, is_released,
                beneficiaries, executors, created_at
         FROM voice_wills 
         WHERE user_id = $1`,
        [userId]
      );
      
      archive.append(JSON.stringify(willsQuery.rows, null, 2), { 
        name: 'vault.json' 
      });
    }
  }

  // Add user settings
  if (include.includes('all') || include.includes('settings')) {
    const settingsQuery = await pool.query(
      `SELECT category, setting_key, setting_value, setting_type
       FROM system_settings 
       WHERE created_by = $1
         AND category != 'backup_encryption'`,
      [userId]
    );
    
    archive.append(JSON.stringify(settingsQuery.rows, null, 2), { 
      name: 'settings.json' 
    });
  }

  // Add metadata file
  const metadata = {
    backupId,
    userId,
    type,
    include,
    encrypt,
    createdAt: new Date().toISOString(),
    version: '1.0'
  };
  
  archive.append(JSON.stringify(metadata, null, 2), { 
    name: 'metadata.json' 
  });

  await archive.finalize();
  
  const backupBuffer = Buffer.concat(chunks);
  const backupSize = backupBuffer.length;
  
  // Handle encryption if requested
  let uploadBuffer = backupBuffer;
  let encryptionInfo = null;
  let contentType = 'application/zip';
  
  if (encrypt) {
    try {
      // Generate encryption key for this backup
      const { dataKey, iv } = encryptionService.generateDataKey();
      
      // Encrypt the backup
      const encryptedResult = await encryptionService.encryptData(backupBuffer, dataKey, iv);
      
      // Encrypt the data key for storage
      const encryptedDataKey = encryptionService.encryptDataKey(dataKey);
      
      // Store encryption info
      encryptionInfo = {
        encryptedDataKey: encryptedDataKey.encrypted || encryptedDataKey,
        iv: encryptedDataKey.iv || iv,
        algorithm: 'AES-256-CBC'
      };
      
      // Store encrypted data key in database
      await pool.query(
        `INSERT INTO system_settings (category, setting_key, setting_value, setting_type, created_by)
         VALUES ('backup_encryption', $1, $2, 'json', $3)
         ON CONFLICT (category, setting_key, created_by) 
         DO UPDATE SET setting_value = EXCLUDED.setting_value, updated_at = CURRENT_TIMESTAMP`,
        [backupId, JSON.stringify(encryptionInfo), userId]
      );
      
      // Prepare encrypted data for upload
      uploadBuffer = Buffer.from(JSON.stringify(encryptedResult));
      contentType = 'application/json';
      
    } catch (encryptError) {
      console.error('Encryption failed:', encryptError);
      throw new Error('Failed to encrypt backup');
    }
  }

  // Upload to S3
  await s3.putObject({
    Bucket: BACKUP_BUCKET,
    Key: backupKey,
    Body: uploadBuffer,
    ContentType: contentType,
    Metadata: {
      'user-id': userId,
      'backup-id': backupId,
      'backup-type': type,
      'encrypted': encrypt ? 'true' : 'false',
      'created-at': new Date().toISOString(),
      'size': backupSize.toString(),
      'content-type': contentType
    }
  }).promise();

  // Update backup metadata
  await pool.query(
    `UPDATE system_settings 
     SET setting_value = $1
     WHERE category = 'backup' 
       AND setting_key = 'lastBackup' 
       AND created_by = $2`,
    [JSON.stringify({
      backupId,
      type,
      status: 'completed',
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      size: backupSize,
      location: backupKey,
      include,
      encrypt,
      encryptionInfo
    }), userId]
  );

  // Log backup completion
  await pool.query(
    `INSERT INTO system_logs (user_id, level, service, message, metadata)
     VALUES ($1, 'info', 'backup', 'Backup completed successfully', $2)`,
    [userId, JSON.stringify({ 
      backupId, 
      type, 
      size: backupSize,
      encrypt,
      timestamp: new Date().toISOString()
    })]
  );
}

// Helper function to format bytes
function formatBytes(bytes, decimals = 2) {
  if (bytes === 0) return '0 Bytes';

  const k = 1024;
  const dm = decimals < 0 ? 0 : decimals;
  const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB', 'PB'];

  const i = Math.floor(Math.log(bytes) / Math.log(k));

  return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + ' ' + sizes[i];
}

// Helper function to get file extension
function getFileExtension(mimeType) {
  const mimeToExt = {
    'audio/mpeg': 'mp3',
    'audio/wav': 'wav',
    'audio/ogg': 'ogg',
    'audio/m4a': 'm4a',
    'audio/webm': 'webm'
  };
  
  return mimeToExt[mimeType] || 'bin';
}

module.exports = router;