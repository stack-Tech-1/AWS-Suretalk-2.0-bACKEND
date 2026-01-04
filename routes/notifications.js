// C:\Users\SMC\Documents\GitHub\AWS-Suretalk-2.0-bACKEND\routes\notifications.js
const express = require('express');
const router = express.Router();
const { authenticate, authenticateAdmin } = require('../middleware/auth');
const { pool } = require('../config/database');
const webpush = require('web-push');

// VAPID keys configuration
const vapidKeys = {
  publicKey: process.env.VAPID_PUBLIC_KEY,
  privateKey: process.env.VAPID_PRIVATE_KEY
};

webpush.setVapidDetails(
  'mailto:' + (process.env.VAPID_EMAIL || 'contact@suretalk.com'),
  vapidKeys.publicKey,
  vapidKeys.privateKey
);

// Get notifications for user
router.get('/', authenticate, async (req, res) => {
  try {
    const { limit = 20, offset = 0, unreadOnly = false } = req.query;
    const userId = req.user.id;

    let query = `
      SELECT n.*,
        COUNT(*) OVER() as total_count,
        COUNT(*) FILTER (WHERE NOT n.is_read) OVER() as unread_count
      FROM notifications n
      WHERE n.user_id = $1
      ${unreadOnly === 'true' ? 'AND n.is_read = false' : ''}
      ORDER BY 
        CASE 
          WHEN priority = 'urgent' THEN 1
          WHEN priority = 'high' THEN 2
          WHEN priority = 'normal' THEN 3
          ELSE 4
        END,
        n.created_at DESC
      LIMIT $2 OFFSET $3
    `;

    const result = await pool.query(query, [userId, parseInt(limit), parseInt(offset)]);

    // Format response to match your frontend
    const notifications = result.rows.map(notif => ({
      id: notif.id,
      title: notif.title,
      message: notif.message,
      type: notif.type,
      icon: notif.icon || getIconForType(notif.type),
      priority: notif.priority,
      is_read: notif.is_read,
      created_at: notif.created_at,
      time: formatTimeAgo(notif.created_at),
      data: notif.data || {}
    }));

    res.json({
      success: true,
      data: {
        notifications,
        unread_count: result.rows[0]?.unread_count || 0,
        pagination: {
          limit: parseInt(limit),
          offset: parseInt(offset),
          total: result.rows[0]?.total_count || 0
        }
      }
    });

  } catch (error) {
    console.error('Get notifications error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch notifications'
    });
  }
});

// Mark notification as read
router.post('/:id/read', authenticate, async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user.id;

    const result = await pool.query(
      `UPDATE notifications 
       SET is_read = true, read_at = CURRENT_TIMESTAMP 
       WHERE id = $1 AND user_id = $2 AND is_read = false
       RETURNING id, title, is_read`,
      [id, userId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'Notification not found or already read'
      });
    }

    res.json({
      success: true,
      message: 'Notification marked as read',
      data: result.rows[0]
    });

  } catch (error) {
    console.error('Mark notification as read error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to mark notification as read'
    });
  }
});

// Mark all notifications as read
router.post('/mark-all-read', authenticate, async (req, res) => {
  try {
    const userId = req.user.id;

    const result = await pool.query(
      `UPDATE notifications 
       SET is_read = true, read_at = CURRENT_TIMESTAMP 
       WHERE user_id = $1 AND is_read = false
       RETURNING COUNT(*) as marked_count`,
      [userId]
    );

    res.json({
      success: true,
      message: `${result.rows[0].marked_count} notifications marked as read`,
      data: {
        marked_count: parseInt(result.rows[0].marked_count)
      }
    });

  } catch (error) {
    console.error('Mark all as read error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to mark notifications as read'
    });
  }
});

// Delete notification
router.delete('/:id', authenticate, async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user.id;

    const result = await pool.query(
      `DELETE FROM notifications WHERE id = $1 AND user_id = $2 RETURNING id`,
      [id, userId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'Notification not found'
      });
    }

    res.json({
      success: true,
      message: 'Notification deleted'
    });

  } catch (error) {
    console.error('Delete notification error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to delete notification'
    });
  }
});

// Clear all notifications
router.delete('/', authenticate, async (req, res) => {
  try {
    const userId = req.user.id;

    const result = await pool.query(
      `DELETE FROM notifications WHERE user_id = $1 RETURNING COUNT(*) as deleted_count`,
      [userId]
    );

    res.json({
      success: true,
      message: `${result.rows[0].deleted_count} notifications cleared`,
      data: {
        deleted_count: parseInt(result.rows[0].deleted_count)
      }
    });

  } catch (error) {
    console.error('Clear all notifications error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to clear notifications'
    });
  }
});

// Subscribe to push notifications
router.post('/subscribe', authenticate, async (req, res) => {
  try {
    const { subscription, userAgent } = req.body;
    const userId = req.user.id;

    // Validate subscription
    if (!subscription || !subscription.endpoint || !subscription.keys) {
      return res.status(400).json({
        success: false,
        error: 'Invalid subscription data'
      });
    }

    // Check if subscription already exists
    const existing = await pool.query(
      'SELECT id FROM push_subscriptions WHERE endpoint = $1',
      [subscription.endpoint]
    );

    if (existing.rows.length > 0) {
      // Update existing subscription
      await pool.query(
        `UPDATE push_subscriptions 
         SET updated_at = CURRENT_TIMESTAMP, user_id = $1
         WHERE endpoint = $2`,
        [userId, subscription.endpoint]
      );
    } else {
      // Insert new subscription
      await pool.query(
        `INSERT INTO push_subscriptions 
         (user_id, endpoint, expiration_time, p256dh, auth, user_agent, ip_address)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          userId,
          subscription.endpoint,
          subscription.expirationTime || null,
          subscription.keys.p256dh,
          subscription.keys.auth,
          userAgent || req.get('user-agent'),
          req.ip
        ]
      );
    }

    res.json({
      success: true,
      message: 'Push notification subscription saved'
    });

  } catch (error) {
    console.error('Subscribe to push notifications error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to save push subscription'
    });
  }
});

// Unsubscribe from push notifications
router.post('/unsubscribe', authenticate, async (req, res) => {
  try {
    const { endpoint } = req.body;
    const userId = req.user.id;

    if (!endpoint) {
      return res.status(400).json({
        success: false,
        error: 'Endpoint is required'
      });
    }

    await pool.query(
      `DELETE FROM push_subscriptions 
       WHERE endpoint = $1 AND user_id = $2`,
      [endpoint, userId]
    );

    res.json({
      success: true,
      message: 'Push notification subscription removed'
    });

  } catch (error) {
    console.error('Unsubscribe from push notifications error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to remove push subscription'
    });
  }
});

// Get notification statistics
router.get('/stats', authenticate, async (req, res) => {
  try {
    const userId = req.user.id;

    const stats = await pool.query(`
      SELECT 
        COUNT(*) as total,
        COUNT(CASE WHEN is_read = false THEN 1 END) as unread,
        COUNT(CASE WHEN type = 'voice_note' THEN 1 END) as voice_notes,
        COUNT(CASE WHEN type = 'message' THEN 1 END) as messages,
        COUNT(CASE WHEN type = 'legacy_vault' THEN 1 END) as vault,
        COUNT(CASE WHEN priority = 'urgent' THEN 1 END) as urgent,
        COUNT(CASE WHEN created_at >= NOW() - INTERVAL '24 hours' THEN 1 END) as today
      FROM notifications
      WHERE user_id = $1
    `, [userId]);

    res.json({
      success: true,
      data: stats.rows[0]
    });

  } catch (error) {
    console.error('Get notification stats error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch notification statistics'
    });
  }
});

// Subscribe to push notifications
router.post('/subscribe', authenticate, async (req, res) => {
    try {
      const { subscription, userAgent } = req.body;
      const userId = req.user.id;
  
      // Validate subscription
      if (!subscription || !subscription.endpoint || !subscription.keys) {
        return res.status(400).json({
          success: false,
          error: 'Invalid subscription data'
        });
      }
  
      // Check if subscription already exists
      const existing = await pool.query(
        'SELECT id FROM push_subscriptions WHERE endpoint = $1',
        [subscription.endpoint]
      );
  
      if (existing.rows.length > 0) {
        // Update existing subscription
        await pool.query(
          `UPDATE push_subscriptions 
           SET updated_at = CURRENT_TIMESTAMP, user_id = $1
           WHERE endpoint = $2`,
          [userId, subscription.endpoint]
        );
      } else {
        // Insert new subscription
        await pool.query(
          `INSERT INTO push_subscriptions 
           (user_id, endpoint, expiration_time, p256dh, auth, user_agent, ip_address)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [
            userId,
            subscription.endpoint,
            subscription.expirationTime || null,
            subscription.keys.p256dh,
            subscription.keys.auth,
            userAgent || req.get('user-agent'),
            req.ip
          ]
        );
      }
  
      res.json({
        success: true,
        message: 'Push notification subscription saved'
      });
  
    } catch (error) {
      console.error('Subscribe to push notifications error:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to save push subscription'
      });
    }
  });
  
  // Unsubscribe from push notifications
  router.post('/unsubscribe', authenticate, async (req, res) => {
    try {
      const { endpoint } = req.body;
      const userId = req.user.id;
  
      if (!endpoint) {
        return res.status(400).json({
          success: false,
          error: 'Endpoint is required'
        });
      }
  
      await pool.query(
        `DELETE FROM push_subscriptions 
         WHERE endpoint = $1 AND user_id = $2`,
        [endpoint, userId]
      );
  
      res.json({
        success: true,
        message: 'Push notification subscription removed'
      });
  
    } catch (error) {
      console.error('Unsubscribe from push notifications error:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to remove push subscription'
      });
    }
  });

// Helper function to create notifications
async function createNotification(userId, type, title, message, data = {}, icon = null, priority = 'normal') {
  try {
    const result = await pool.query(
      `INSERT INTO notifications 
       (user_id, type, title, message, data, icon, priority)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id, created_at`,
      [userId, type, title, message, JSON.stringify(data), icon, priority]
    );

    // Send push notification if user has subscription
    await sendPushNotification(userId, {
      title,
      body: message,
      icon: icon || getIconForType(type),
      data: { ...data, type, notificationId: result.rows[0].id }
    });

    return result.rows[0];
  } catch (error) {
    console.error('Create notification error:', error);
    return null;
  }
}

// Helper function to send push notification
async function sendPushNotification(userId, notification) {
  try {
    const subscriptions = await pool.query(
      'SELECT endpoint, p256dh, auth FROM push_subscriptions WHERE user_id = $1',
      [userId]
    );

    if (subscriptions.rows.length === 0) return;

    for (const sub of subscriptions.rows) {
      const subscription = {
        endpoint: sub.endpoint,
        keys: {
          p256dh: sub.p256dh,
          auth: sub.auth
        }
      };

      try {
        await webpush.sendNotification(
          subscription,
          JSON.stringify(notification)
        );

        // Mark as pushed in database
        await pool.query(
          'UPDATE notifications SET is_pushed = true, pushed_at = CURRENT_TIMESTAMP WHERE id = $1',
          [notification.data.notificationId]
        );
      } catch (error) {
        if (error.statusCode === 410) {
          // Subscription expired, delete it
          await pool.query('DELETE FROM push_subscriptions WHERE endpoint = $1', [sub.endpoint]);
        }
      }
    }
  } catch (error) {
    console.error('Send push notification error:', error);
  }
}

// Helper functions
function getIconForType(type) {
  const icons = {
    'voice_note': '/icons/voice-note.png',
    'message': '/icons/message-sent.png',
    'legacy_vault': '/icons/vault.png',
    'contact': '/icons/contact.png',
    'system': '/icons/system.png',
    'billing': '/icons/billing.png',
    'security': '/icons/security.png',
    'warning': '/icons/warning.png',
    'success': '/icons/success.png'
  };
  return icons[type] || '/icons/system.png';
}

function formatTimeAgo(date) {
  const seconds = Math.floor((new Date() - new Date(date)) / 1000);
  
  if (seconds < 60) return `${seconds} seconds ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)} minutes ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)} hours ago`;
  return `${Math.floor(seconds / 86400)} days ago`;
}

// Export the createNotification function
module.exports = {
  router,
  createNotification
};