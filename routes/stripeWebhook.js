// routes/stripeWebhook.js
// express.raw() is applied at the app level before this router (server.js)
const express  = require('express');
const router   = express.Router();
const Stripe   = require('stripe');
const https    = require('https');
const { pool } = require('../config/database');
const { syncToIvr }   = require('../utils/syncIvr');
const { ivrTierName } = require('../utils/tierMapping');
const emailService    = require('../utils/emailService');
const logger          = require('../utils/logger');

const _agent = new https.Agent({ keepAlive: true, keepAliveMsecs: 60_000, freeSocketTimeout: 45_000 });
const stripe = process.env.STRIPE_SECRET_KEY
  ? new Stripe(process.env.STRIPE_SECRET_KEY, { httpAgent: _agent })
  : null;

// ── Helpers ─────────────────────────────────────────────────────────────────

function getTierFromPriceId(priceId) {
  const map = {
    [process.env.NEXT_PUBLIC_STRIPE_LITE_PRICE_ID]:      'LITE',
    [process.env.NEXT_PUBLIC_STRIPE_ESSENTIAL_PRICE_ID]: 'ESSENTIAL',
    [process.env.NEXT_PUBLIC_STRIPE_PREMIUM_PRICE_ID]:   'LEGACY_VAULT_PREMIUM'
  };
  return map[priceId] || 'LITE';
}

const TIER_LIMITS = {
  LITE:                 { contacts: 3,  voiceNotes: 3,   storageGb: 1  },
  ESSENTIAL:            { contacts: 9,  voiceNotes: 100, storageGb: 5  },
  LEGACY_VAULT_PREMIUM: { contacts: 25, voiceNotes: 500, storageGb: 50 }
};

async function setUserLimits(userId, tier) {
  const l = TIER_LIMITS[tier] || TIER_LIMITS.LITE;
  await pool.query(
    'UPDATE users SET contacts_limit = $1, voice_notes_limit = $2, storage_limit_gb = $3 WHERE id = $4',
    [l.contacts, l.voiceNotes, l.storageGb, userId]
  );
}

// Returns { id, email, full_name } for the user linked to a Stripe subscription object
async function getUserFromSubscription(subscription) {
  if (subscription.metadata?.userId) {
    const r = await pool.query(
      'SELECT id, email, full_name FROM users WHERE id = $1 AND deleted_at IS NULL',
      [subscription.metadata.userId]
    );
    return r.rows[0] || null;
  }
  const r = await pool.query(
    'SELECT id, email, full_name FROM users WHERE stripe_customer_id = $1 AND deleted_at IS NULL',
    [subscription.customer]
  );
  return r.rows[0] || null;
}

// Returns { id, email, full_name } for the user linked to a Stripe invoice object
async function getUserFromInvoice(invoice) {
  if (invoice.subscription) {
    // Try subscription metadata first
    try {
      const sub = await stripe.subscriptions.retrieve(invoice.subscription);
      if (sub.metadata?.userId) {
        const r = await pool.query(
          'SELECT id, email, full_name FROM users WHERE id = $1 AND deleted_at IS NULL',
          [sub.metadata.userId]
        );
        if (r.rows[0]) return r.rows[0];
      }
    } catch (_) { /* fall through to customer lookup */ }
  }
  const r = await pool.query(
    'SELECT id, email, full_name FROM users WHERE stripe_customer_id = $1 AND deleted_at IS NULL',
    [invoice.customer]
  );
  return r.rows[0] || null;
}

function formatDate(unixTs) {
  if (!unixTs) return null;
  return new Date(unixTs * 1000).toLocaleDateString('en-US', {
    year: 'numeric', month: 'long', day: 'numeric'
  });
}

// ── Webhook handler ──────────────────────────────────────────────────────────

router.post('/', async (req, res) => {
  if (!stripe || !process.env.STRIPE_WEBHOOK_SECRET) {
    return res.status(503).json({ error: 'Stripe not configured' });
  }

  const sig = req.headers['stripe-signature'];
  let event;

  try {
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    logger.warn(`Stripe webhook signature failed: ${err.message}`);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  // Acknowledge Stripe immediately — all processing is async
  res.json({ received: true });

  // Process in background so slow DB/email calls don't delay the 200 response
  setImmediate(() => handleEvent(event).catch(err =>
    logger.error(`Stripe webhook handler failed for ${event.type}: ${err.message}`, { eventId: event.id })
  ));
});

async function handleEvent(event) {
  const obj = event.data.object;

  switch (event.type) {

    // ── Subscription created or updated (tier change, status change, renewal)
    case 'customer.subscription.created':
    case 'customer.subscription.updated': {
      const user = await getUserFromSubscription(obj);
      if (!user) { logger.warn(`No user found for subscription ${obj.id}`); break; }

      const priceId = obj.items.data[0]?.price.id;
      const tier    = getTierFromPriceId(priceId);

      await pool.query(
        `UPDATE users
         SET subscription_tier      = $1,
             subscription_status    = $2,
             stripe_subscription_id = $3,
             updated_at             = NOW()
         WHERE id = $4`,
        [tier, obj.status, obj.id, user.id]
      );
      await setUserLimits(user.id, tier);

      syncToIvr(
        { userId: user.id, tier: ivrTierName(tier), subscriptionStatus: obj.status },
        'sync-user'
      );

      logger.info(`Subscription ${event.type}: user ${user.id} → tier ${tier}, status ${obj.status}`);
      break;
    }

    // ── Subscription cancelled (user cancelled or Stripe gave up after failed payments)
    case 'customer.subscription.deleted': {
      const r = await pool.query(
        'SELECT id, email, full_name, subscription_tier FROM users WHERE stripe_subscription_id = $1 AND deleted_at IS NULL',
        [obj.id]
      );
      const user = r.rows[0];
      if (!user) { logger.warn(`No user found for deleted subscription ${obj.id}`); break; }

      const previousTier = user.subscription_tier;

      // Downgrade to LITE — keep all data, reset limits and tier
      await pool.query(
        `UPDATE users
         SET subscription_status    = 'inactive',
             subscription_tier      = 'LITE',
             stripe_subscription_id = NULL,
             updated_at             = NOW()
         WHERE id = $1`,
        [user.id]
      );
      await setUserLimits(user.id, 'LITE');

      syncToIvr({ userId: user.id, subscriptionStatus: 'inactive', tier: 'lite' }, 'sync-user');

      // Was this a voluntary cancellation or payment failure suspension?
      // Stripe sets cancel_at_period_end=true for voluntary, then fires deleted when period ends.
      // For failed-payment suspension, cancel_reason may be set.
      const isPaymentSuspension = obj.cancellation_details?.reason === 'payment_failed';

      if (isPaymentSuspension) {
        await emailService.sendAccountSuspendedEmail(user.email, user.full_name).catch(e =>
          logger.error('Failed to send suspension email:', e)
        );
      } else {
        await emailService.sendSubscriptionCancelledEmail(user.email, user.full_name, {
          tier: previousTier,
          accessUntilDate: formatDate(obj.current_period_end)
        }).catch(e => logger.error('Failed to send cancellation email:', e));
      }

      logger.info(`Subscription deleted: user ${user.id} downgraded to LITE (was ${previousTier})`);
      break;
    }

    // ── Invoice payment succeeded (renewal or new subscription)
    case 'invoice.payment_succeeded': {
      // Skip $0 invoices (trial activations, LITE plan)
      if (obj.amount_paid === 0) break;

      const user = await getUserFromInvoice(obj);
      if (!user) break;

      // Fetch subscription to get next billing date
      let nextBillingDate = null;
      if (obj.subscription) {
        try {
          const sub = await stripe.subscriptions.retrieve(obj.subscription);
          nextBillingDate = formatDate(sub.current_period_end);
          // Ensure status is active in DB (may have been past_due)
          await pool.query(
            'UPDATE users SET subscription_status = $1, updated_at = NOW() WHERE id = $2',
            [sub.status, user.id]
          );
        } catch (_) { /* non-critical */ }
      }

      // Get current tier from DB
      const tierRow = await pool.query('SELECT subscription_tier FROM users WHERE id = $1', [user.id]);
      const tier = tierRow.rows[0]?.subscription_tier || 'ESSENTIAL';

      await emailService.sendPaymentSuccessEmail(user.email, user.full_name, {
        amountPaid: obj.amount_paid,
        currency:   obj.currency,
        tier,
        nextBillingDate
      }).catch(e => logger.error('Failed to send payment success email:', e));

      logger.info(`Invoice paid: user ${user.id}, amount ${obj.amount_paid} ${obj.currency}`);
      break;
    }

    // ── Invoice payment failed (Stripe will retry automatically)
    case 'invoice.payment_failed': {
      const user = await getUserFromInvoice(obj);
      if (!user) break;

      // next_payment_attempt is null on the final attempt
      const nextRetry    = obj.next_payment_attempt ? formatDate(obj.next_payment_attempt) : null;
      const attemptCount = obj.attempt_count || 1;

      await emailService.sendPaymentFailedEmail(user.email, user.full_name, {
        amountDue:    obj.amount_due,
        currency:     obj.currency,
        nextRetryDate: nextRetry,
        attemptCount
      }).catch(e => logger.error('Failed to send payment failed email:', e));

      // Log the failure for admin visibility
      await pool.query(
        `INSERT INTO system_logs (user_id, level, service, message, metadata)
         VALUES ($1, 'warning', 'billing', 'Invoice payment failed', $2)`,
        [user.id, JSON.stringify({ invoiceId: obj.id, amount: obj.amount_due, attempt: attemptCount })]
      ).catch(() => {});

      logger.warn(`Invoice payment failed: user ${user.id}, attempt ${attemptCount}, amount ${obj.amount_due}`);
      break;
    }

    // ── Trial ending in 3 days
    case 'customer.subscription.trial_will_end': {
      const user = await getUserFromSubscription(obj);
      if (!user) break;

      const priceId   = obj.items.data[0]?.price.id;
      const tier      = getTierFromPriceId(priceId);
      const trialEnd  = formatDate(obj.trial_end);

      await emailService.sendTrialEndingEmail(user.email, user.full_name, {
        trialEndDate: trialEnd,
        tier
      }).catch(e => logger.error('Failed to send trial ending email:', e));

      logger.info(`Trial ending soon: user ${user.id}, ends ${trialEnd}`);
      break;
    }

    default:
      // Acknowledge all other events silently
      break;
  }
}

module.exports = router;
