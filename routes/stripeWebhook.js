const express = require('express');
const router = express.Router();
const Stripe = require('stripe');
const { pool } = require('../config/database');
const { syncToIvr } = require('../utils/syncIvr');
const { ivrTierName } = require('../utils/tierMapping');

const stripe = process.env.STRIPE_SECRET_KEY
  ? new Stripe(process.env.STRIPE_SECRET_KEY)
  : null;

// Map Stripe price IDs to internal tier names
function getTierFromPriceId(priceId) {
  const priceMap = {
    [process.env.NEXT_PUBLIC_STRIPE_LITE_PRICE_ID]: 'LITE',
    [process.env.NEXT_PUBLIC_STRIPE_ESSENTIAL_PRICE_ID]: 'ESSENTIAL',
    [process.env.NEXT_PUBLIC_STRIPE_PREMIUM_PRICE_ID]: 'LEGACY_VAULT_PREMIUM'
  };
  return priceMap[priceId] || 'LITE';
}

// Update contacts_limit and voice_notes_limit for a user based on tier
async function updateUserLimits(userId, tier) {
  const limits = {
    LITE: { contacts: 3, voiceNotes: 3 },
    ESSENTIAL: { contacts: 9, voiceNotes: 100 },
    LEGACY_VAULT_PREMIUM: { contacts: 25, voiceNotes: 500 }
  };
  const { contacts, voiceNotes } = limits[tier] || limits.LITE;
  await pool.query(
    'UPDATE users SET contacts_limit = $1, voice_notes_limit = $2 WHERE id = $3',
    [contacts, voiceNotes, userId]
  );
}

// Resolve internal user ID from a Stripe subscription object
// Tries metadata.userId first, then falls back to stripe_customer_id lookup
async function getUserIdFromSubscription(subscription) {
  if (subscription.metadata?.userId) return subscription.metadata.userId;
  const result = await pool.query(
    'SELECT id FROM users WHERE stripe_customer_id = $1 AND deleted_at IS NULL',
    [subscription.customer]
  );
  return result.rows[0]?.id || null;
}

// POST /api/billing/webhook
// express.raw() is applied at the app level (server.js) before this router
router.post('/', async (req, res) => {
  if (!stripe || !process.env.STRIPE_WEBHOOK_SECRET) {
    return res.status(503).json({ error: 'Stripe not configured' });
  }

  const sig = req.headers['stripe-signature'];
  let event;

  try {
    event = stripe.webhooks.constructEvent(
      req.body,
      sig,
      process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  try {
    const subscription = event.data.object;

    switch (event.type) {
      case 'customer.subscription.created':
      case 'customer.subscription.updated': {
        const userId = await getUserIdFromSubscription(subscription);
        if (!userId) break;

        const priceId = subscription.items.data[0]?.price.id;
        const tier = getTierFromPriceId(priceId);

        await pool.query(
          `UPDATE users
           SET subscription_tier = $1,
               subscription_status = $2,
               stripe_subscription_id = $3,
               updated_at = NOW()
           WHERE id = $4`,
          [tier, subscription.status, subscription.id, userId]
        );

        await updateUserLimits(userId, tier);

        syncToIvr(
          { userId, tier: ivrTierName(tier), subscriptionStatus: subscription.status },
          'sync-user'
        );
        break;
      }

      case 'customer.subscription.deleted': {
        const result = await pool.query(
          'SELECT id FROM users WHERE stripe_subscription_id = $1 AND deleted_at IS NULL',
          [subscription.id]
        );
        const userId = result.rows[0]?.id;
        if (!userId) break;

        await pool.query(
          `UPDATE users
           SET subscription_status = 'inactive',
               updated_at = NOW()
           WHERE id = $1`,
          [userId]
        );

        syncToIvr({ userId, subscriptionStatus: 'inactive' }, 'sync-user');
        break;
      }

      default:
        // Unhandled event types — acknowledge receipt silently
        break;
    }

    res.json({ received: true });
  } catch (err) {
    res.status(500).json({ error: 'Webhook handler failed' });
  }
});

module.exports = router;
