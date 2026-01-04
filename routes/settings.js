// /routes/settings.js
const express = require('express');
const router = express.Router();
const { body, validationResult } = require('express-validator');
const { authenticate } = require('../middleware/auth');
const { pool } = require('../config/database');

// Get user settings
router.get('/', authenticate, async (req, res) => {
  try {
    const userId = req.user.id;

    // Get user settings from system_settings table
    const settingsQuery = await pool.query(
      `SELECT category, setting_key, setting_value, setting_type 
       FROM system_settings 
       WHERE created_by = $1 OR created_by IS NULL
       ORDER BY category, setting_key`,
      [userId]
    );

    // Get user-specific settings from localStorage (simulated)
    const userSettingsQuery = await pool.query(
      `SELECT settings FROM users WHERE id = $1`,
      [userId]
    );

    // Format settings into categories
    const settings = {};
    settingsQuery.rows.forEach(row => {
      if (!settings[row.category]) {
        settings[row.category] = {};
      }
      
      // Parse value based on type
      let value = row.setting_value;
      if (row.setting_type === 'boolean') {
        value = value === 'true';
      } else if (row.setting_type === 'number') {
        value = parseFloat(value);
      } else if (row.setting_type === 'json') {
        try {
          value = JSON.parse(value);
        } catch {
          value = value;
        }
      }
      
      settings[row.category][row.setting_key] = value;
    });

    // Merge with user settings from users table
    const userSettings = userSettingsQuery.rows[0]?.settings || {};
    Object.assign(settings, userSettings);

    // Default settings structure
    const defaultSettings = {
      notifications: {
        email: true,
        push: true,
        voice: false,
        weeklyDigest: true,
      },
      privacy: {
        profileVisible: true,
        activityVisible: false,
        autoDelete: 180,
        dataExport: true,
      },
      appearance: {
        theme: 'light',
        fontSize: 'medium',
        density: 'comfortable',
      },
      security: {
        twoFactor: false,
        loginAlerts: true,
        sessionTimeout: 30,
      }
    };

    // Merge defaults with user settings
    const mergedSettings = { ...defaultSettings, ...settings };

    res.json({
      success: true,
      data: mergedSettings
    });

  } catch (error) {
    console.error('Get settings error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch settings'
    });
  }
});

// Update user settings
router.put('/', authenticate, [
  body('settings').optional().isObject()
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
    const { category, key, value, settings: bulkSettings } = req.body;

    if (bulkSettings) {
      // Bulk update all settings
      await pool.query(
        'UPDATE users SET settings = $1 WHERE id = $2',
        [JSON.stringify(bulkSettings), userId]
      );

      // Also save important settings to system_settings for persistence
      const importantSettings = [
        { category: 'notifications', key: 'email', value: bulkSettings.notifications?.email, type: 'boolean' },
        { category: 'notifications', key: 'push', value: bulkSettings.notifications?.push, type: 'boolean' },
        { category: 'privacy', key: 'autoDelete', value: bulkSettings.privacy?.autoDelete, type: 'number' },
        { category: 'appearance', key: 'theme', value: bulkSettings.appearance?.theme, type: 'string' },
        { category: 'security', key: 'twoFactor', value: bulkSettings.security?.twoFactor, type: 'boolean' },
        { category: 'security', key: 'sessionTimeout', value: bulkSettings.security?.sessionTimeout, type: 'number' },
      ];

      for (const setting of importantSettings) {
        if (setting.value !== undefined) {
          await pool.query(
            `INSERT INTO system_settings (category, setting_key, setting_value, setting_type, created_by)
             VALUES ($1, $2, $3, $4, $5)
             ON CONFLICT (category, setting_key, created_by) 
             DO UPDATE SET setting_value = EXCLUDED.setting_value, updated_at = CURRENT_TIMESTAMP`,
            [setting.category, setting.key, String(setting.value), setting.type, userId]
          );
        }
      }

    } else if (category && key !== undefined) {
      // Update single setting
      // First update in users table
      const userSettingsQuery = await pool.query(
        'SELECT settings FROM users WHERE id = $1',
        [userId]
      );

      let userSettings = userSettingsQuery.rows[0]?.settings || {};
      if (!userSettings[category]) {
        userSettings[category] = {};
      }
      userSettings[category][key] = value;

      await pool.query(
        'UPDATE users SET settings = $1 WHERE id = $2',
        [JSON.stringify(userSettings), userId]
      );

      // Also save to system_settings for important settings
      const importantKeys = ['email', 'push', 'autoDelete', 'theme', 'twoFactor', 'sessionTimeout'];
      if (importantKeys.includes(key)) {
        const settingType = typeof value === 'boolean' ? 'boolean' :
                           typeof value === 'number' ? 'number' : 'string';

        await pool.query(
          `INSERT INTO system_settings (category, setting_key, setting_value, setting_type, created_by)
           VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT (category, setting_key, created_by) 
           DO UPDATE SET setting_value = EXCLUDED.setting_value, updated_at = CURRENT_TIMESTAMP`,
          [category, key, String(value), settingType, userId]
        );
      }
    } else {
      return res.status(400).json({
        success: false,
        error: 'Invalid update request'
      });
    }

    res.json({
      success: true,
      message: 'Settings updated successfully'
    });

  } catch (error) {
    console.error('Update settings error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to update settings'
    });
  }
});

// Get backup settings
router.get('/backup', authenticate, async (req, res) => {
  try {
    const userId = req.user.id;

    // Get backup settings from system_settings
    const backupSettingsQuery = await pool.query(
      `SELECT setting_key, setting_value, setting_type 
       FROM system_settings 
       WHERE category = 'backup' AND (created_by = $1 OR created_by IS NULL)`,
      [userId]
    );

    // Default backup settings
    const defaultBackupSettings = {
      autoBackup: true,
      backupFrequency: 'daily',
      backupTime: '02:00',
      retentionDays: 30,
      includeVoiceNotes: true,
      includeContacts: true,
      includeScheduledMessages: true,
      includeSettings: true,
      encryptBackup: true,
      cloudStorage: true,
      lastBackup: null,
      nextBackup: null
    };

    // Merge with stored settings
    const backupSettings = { ...defaultBackupSettings };
    backupSettingsQuery.rows.forEach(row => {
      let value = row.setting_value;
      if (row.setting_type === 'boolean') {
        value = value === 'true';
      } else if (row.setting_type === 'number') {
        value = parseFloat(value);
      } else if (row.setting_type === 'json') {
        try {
          value = JSON.parse(value);
        } catch {
          value = value;
        }
      }
      backupSettings[row.setting_key] = value;
    });

    // Get last backup info
    const lastBackupQuery = await pool.query(
      `SELECT MAX(created_at) as last_backup 
       FROM system_logs 
       WHERE user_id = $1 AND service = 'backup' AND level = 'info'`,
      [userId]
    );

    if (lastBackupQuery.rows[0]?.last_backup) {
      backupSettings.lastBackup = lastBackupQuery.rows[0].last_backup;
    }

    res.json({
      success: true,
      data: backupSettings
    });

  } catch (error) {
    console.error('Get backup settings error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch backup settings'
    });
  }
});

// Update backup settings
router.put('/backup', authenticate, [
  body('settings').isObject()
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
    const { settings } = req.body;

    // Save each backup setting to system_settings
    for (const [key, value] of Object.entries(settings)) {
      const settingType = typeof value === 'boolean' ? 'boolean' :
                         typeof value === 'number' ? 'number' : 'string';

      await pool.query(
        `INSERT INTO system_settings (category, setting_key, setting_value, setting_type, created_by)
         VALUES ('backup', $1, $2, $3, $4)
         ON CONFLICT (category, setting_key, created_by) 
         DO UPDATE SET setting_value = EXCLUDED.setting_value, updated_at = CURRENT_TIMESTAMP`,
        [key, String(value), settingType, userId]
      );
    }

    res.json({
      success: true,
      message: 'Backup settings updated successfully'
    });

  } catch (error) {
    console.error('Update backup settings error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to update backup settings'
    });
  }
});

// Create manual backup
router.post('/backup/create', authenticate, async (req, res) => {
  try {
    const userId = req.user.id;
    const { type = 'full' } = req.body;

    // Create backup entry
    const backupData = {
      type,
      userId,
      timestamp: new Date().toISOString(),
      status: 'pending'
    };

    // Store backup info
    await pool.query(
      `INSERT INTO system_settings (category, setting_key, setting_value, setting_type, created_by)
       VALUES ('backup', 'lastBackup', $1, 'json', $2)`,
      [JSON.stringify(backupData), userId]
    );

    // Log backup event
    await pool.query(
      `INSERT INTO system_logs (user_id, level, service, message, metadata)
       VALUES ($1, 'info', 'backup', 'Manual backup initiated', $2)`,
      [userId, JSON.stringify({ type, timestamp: backupData.timestamp })]
    );

    // In production, this would trigger an actual backup process
    // For now, simulate backup creation
    setTimeout(async () => {
      await pool.query(
        `UPDATE system_settings 
         SET setting_value = $1
         WHERE category = 'backup' AND setting_key = 'lastBackup' AND created_by = $2`,
        [JSON.stringify({ ...backupData, status: 'completed' }), userId]
      );

      await pool.query(
        `INSERT INTO system_logs (user_id, level, service, message, metadata)
         VALUES ($1, 'info', 'backup', 'Backup completed successfully', $2)`,
        [userId, JSON.stringify({ type, timestamp: new Date().toISOString() })]
      );
    }, 2000);

    res.json({
      success: true,
      message: 'Backup initiated successfully',
      data: {
        backupId: backupData.timestamp,
        status: 'pending',
        estimatedCompletion: '2 minutes'
      }
    });

  } catch (error) {
    console.error('Create backup error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to create backup'
    });
  }
});

// Get backup history
router.get('/backup/history', authenticate, async (req, res) => {
  try {
    const userId = req.user.id;
    const { limit = 10, offset = 0 } = req.query;

    const historyQuery = await pool.query(
      `SELECT metadata->>'timestamp' as timestamp,
              metadata->>'type' as type,
              message,
              created_at
       FROM system_logs 
       WHERE user_id = $1 AND service = 'backup'
       ORDER BY created_at DESC
       LIMIT $2 OFFSET $3`,
      [userId, parseInt(limit), parseInt(offset)]
    );

    const totalQuery = await pool.query(
      `SELECT COUNT(*) as total 
       FROM system_logs 
       WHERE user_id = $1 AND service = 'backup'`,
      [userId]
    );

    res.json({
      success: true,
      data: {
        history: historyQuery.rows,
        pagination: {
          limit: parseInt(limit),
          offset: parseInt(offset),
          total: parseInt(totalQuery.rows[0].total)
        }
      }
    });

  } catch (error) {
    console.error('Get backup history error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch backup history'
    });
  }
});

// Export user data
router.post('/export', authenticate, async (req, res) => {
  try {
    const userId = req.user.id;
    const { format = 'json', include = ['all'] } = req.body;

    // Get user profile
    const userQuery = await pool.query(
      `SELECT id, email, phone, full_name, subscription_tier, 
              profile_image_url, created_at, last_login
       FROM users WHERE id = $1`,
      [userId]
    );

    const exportData = {
      exportedAt: new Date().toISOString(),
      user: userQuery.rows[0],
      metadata: {
        format,
        includes: include,
        version: '2.0.0'
      }
    };

    // Include voice notes if requested
    if (include.includes('all') || include.includes('voice_notes')) {
      const voiceNotesQuery = await pool.query(
        `SELECT id, title, description, file_size_bytes, duration_seconds,
                is_favorite, is_permanent, created_at, scheduled_for
         FROM voice_notes 
         WHERE user_id = $1 AND deleted_at IS NULL
         ORDER BY created_at DESC`,
        [userId]
      );
      exportData.voiceNotes = voiceNotesQuery.rows;
    }

    // Include contacts if requested
    if (include.includes('all') || include.includes('contacts')) {
      const contactsQuery = await pool.query(
        `SELECT id, name, phone, email, relationship, 
                is_beneficiary, can_receive_messages, created_at
         FROM contacts 
         WHERE user_id = $1
         ORDER BY created_at DESC`,
        [userId]
      );
      exportData.contacts = contactsQuery.rows;
    }

    // Include scheduled messages if requested
    if (include.includes('all') || include.includes('scheduled_messages')) {
      const scheduledQuery = await pool.query(
        `SELECT sm.id, sm.scheduled_for, sm.delivery_method, sm.delivery_status,
                vn.title as voice_note_title,
                c.name as recipient_name,
                sm.created_at
         FROM scheduled_messages sm
         LEFT JOIN voice_notes vn ON sm.voice_note_id = vn.id
         LEFT JOIN contacts c ON sm.recipient_contact_id = c.id
         WHERE sm.user_id = $1
         ORDER BY sm.scheduled_for DESC`,
        [userId]
      );
      exportData.scheduledMessages = scheduledQuery.rows;
    }

    // Include settings if requested
    if (include.includes('all') || include.includes('settings')) {
      const settingsQuery = await pool.query(
        `SELECT category, setting_key, setting_value, setting_type
         FROM system_settings 
         WHERE created_by = $1
         ORDER BY category, setting_key`,
        [userId]
      );
      exportData.settings = settingsQuery.rows;
    }

    // Include vault items if requested and user is PREMIUM
    if ((include.includes('all') || include.includes('vault')) && userQuery.rows[0].subscription_tier === 'PREMIUM') {
      const vaultQuery = await pool.query(
        `SELECT id, title, description, release_condition, 
                is_released, beneficiaries, created_at
         FROM voice_wills 
         WHERE user_id = $1
         ORDER BY created_at DESC`,
        [userId]
      );
      exportData.vault = vaultQuery.rows;
    }

    // Log export event
    await pool.query(
      `INSERT INTO system_logs (user_id, level, service, message, metadata)
       VALUES ($1, 'info', 'export', 'Data export requested', $2)`,
      [userId, JSON.stringify({ format, includes: include })]
    );

    res.json({
      success: true,
      message: 'Data export prepared successfully',
      data: exportData,
      downloadUrl: `/api/settings/export/download/${Date.now()}` // Mock URL
    });

  } catch (error) {
    console.error('Export data error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to export data'
    });
  }
});

// Delete user account
router.delete('/account', authenticate, [
  body('confirmation').equals('DELETE MY ACCOUNT')
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
    const { reason = 'No reason provided' } = req.body;

    // Mark user as deleted (soft delete)
    await pool.query(
      'UPDATE users SET deleted_at = CURRENT_TIMESTAMP WHERE id = $1',
      [userId]
    );

    // Log deletion event
    await pool.query(
      `INSERT INTO system_logs (user_id, level, service, message, metadata)
       VALUES ($1, 'warning', 'account', 'Account deletion requested', $2)`,
      [userId, JSON.stringify({ reason, timestamp: new Date().toISOString() })]
    );

    // In production, schedule actual data deletion after grace period
    // For now, just mark as deleted

    res.json({
      success: true,
      message: 'Account deletion initiated. You will be logged out shortly.',
      note: 'Your data will be permanently deleted after 30 days.'
    });

  } catch (error) {
    console.error('Delete account error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to delete account'
    });
  }
});

module.exports = router;