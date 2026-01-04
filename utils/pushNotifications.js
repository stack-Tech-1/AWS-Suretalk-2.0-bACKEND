const webpush = require('web-push');
const { Pool } = require('pg');

// VAPID keys should be in environment variables
const vapidKeys = {
  publicKey: process.env.VAPID_PUBLIC_KEY,
  privateKey: process.env.VAPID_PRIVATE_KEY
};

// Configure webpush
webpush.setVapidDetails(
  'mailto:' + (process.env.VAPID_EMAIL || 'contact@suretalk.com'),
  vapidKeys.publicKey,
  vapidKeys.privateKey
);

// Database connection
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

class PushNotificationService {
  constructor() {
    this.subscriptions = new Map();
  }

  // Store subscription in database
  async saveSubscription(userId, subscription) {
    try {
      await pool.query(
        `INSERT INTO push_subscriptions (user_id, subscription_data, created_at, updated_at)
         VALUES ($1, $2, NOW(), NOW())
         ON CONFLICT (user_id) 
         DO UPDATE SET subscription_data = $2, updated_at = NOW()`,
        [userId, JSON.stringify(subscription)]
      );
      return true;
    } catch (error) {
      console.error('Error saving push subscription:', error);
      return false;
    }
  }

  // Get user's subscription
  async getSubscription(userId) {
    try {
      const result = await pool.query(
        `SELECT subscription_data FROM push_subscriptions WHERE user_id = $1`,
        [userId]
      );
      return result.rows[0]?.subscription_data;
    } catch (error) {
      console.error('Error getting push subscription:', error);
      return null;
    }
  }

  // Delete subscription
  async deleteSubscription(userId) {
    try {
      await pool.query(
        `DELETE FROM push_subscriptions WHERE user_id = $1`,
        [userId]
      );
      return true;
    } catch (error) {
      console.error('Error deleting push subscription:', error);
      return false;
    }
  }

  // Send notification to specific user
  async sendToUser(userId, notification) {
    try {
      const subscriptionData = await this.getSubscription(userId);
      if (!subscriptionData) {
        return { success: false, error: 'No subscription found' };
      }

      const subscription = JSON.parse(subscriptionData);
      return await this.sendNotification(subscription, notification);
    } catch (error) {
      console.error('Error sending notification to user:', error);
      return { success: false, error: error.message };
    }
  }

  // Send notification to multiple users
  async sendToUsers(userIds, notification) {
    const results = [];
    for (const userId of userIds) {
      const result = await this.sendToUser(userId, notification);
      results.push({ userId, ...result });
    }
    return results;
  }

  // Send notification
  async sendNotification(subscription, notification) {
    try {
      const payload = JSON.stringify({
        title: notification.title,
        body: notification.body,
        icon: notification.icon || '/icons/icon-192x192.png',
        badge: '/icons/badge-72x72.png',
        image: notification.image,
        data: {
          url: notification.url || '/usersDashboard',
          ...notification.data
        },
        actions: notification.actions || [
          {
            action: 'open',
            title: 'Open App'
          },
          {
            action: 'dismiss',
            title: 'Dismiss'
          }
        ],
        vibrate: [200, 100, 200],
        requireInteraction: notification.requireInteraction || false
      });

      await webpush.sendNotification(subscription, payload);
      return { success: true };
    } catch (error) {
      console.error('Error sending push notification:', error);
      
      // If subscription is invalid, remove it
      if (error.statusCode === 410) {
        await this.deleteSubscriptionByEndpoint(subscription.endpoint);
        return { success: false, error: 'Subscription expired', expired: true };
      }
      
      return { success: false, error: error.message };
    }
  }

  // Delete subscription by endpoint
  async deleteSubscriptionByEndpoint(endpoint) {
    try {
      await pool.query(
        `DELETE FROM push_subscriptions 
         WHERE subscription_data::jsonb->>'endpoint' = $1`,
        [endpoint]
      );
      return true;
    } catch (error) {
      console.error('Error deleting subscription by endpoint:', error);
      return false;
    }
  }

  // Send scheduled message notification
  async sendScheduledMessageNotification(userId, messageData) {
    const notification = {
      title: 'Message Scheduled Successfully',
      body: `"${messageData.voiceNoteTitle}" scheduled for ${messageData.scheduledFor}`,
      icon: '/icons/voice-note.png',
      data: {
        type: 'message_scheduled',
        messageId: messageData.messageId,
        voiceNoteId: messageData.voiceNoteId,
        scheduledFor: messageData.scheduledFor,
        url: `/usersDashboard/voice-notes/${messageData.voiceNoteId}`
      },
      requireInteraction: false
    };

    return await this.sendToUser(userId, notification);
  }

  // Send message sent notification
  async sendMessageSentNotification(userId, messageData) {
    const notification = {
      title: 'Message Sent',
      body: `"${messageData.voiceNoteTitle}" sent to ${messageData.recipientName}`,
      icon: '/icons/message-sent.png',
      data: {
        type: 'message_sent',
        messageId: messageData.messageId,
        voiceNoteId: messageData.voiceNoteId,
        recipientName: messageData.recipientName,
        url: `/usersDashboard/voice-notes/${messageData.voiceNoteId}`
      },
      requireInteraction: false
    };

    return await this.sendToUser(userId, notification);
  }

  // Send legacy vault notification
  async sendLegacyVaultNotification(userId, noteData) {
    const notification = {
      title: 'Voice Note Moved to Legacy Vault',
      body: `"${noteData.title}" is now permanently preserved`,
      icon: '/icons/vault.png',
      data: {
        type: 'legacy_vault',
        noteId: noteData.id,
        title: noteData.title,
        url: `/usersDashboard/voice-notes/${noteData.id}`
      },
      requireInteraction: true
    };

    return await this.sendToUser(userId, notification);
  }
}

module.exports = new PushNotificationService();