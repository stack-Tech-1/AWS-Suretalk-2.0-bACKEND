// C:\Users\SMC\Documents\GitHub\AWS-Suretalk-2.0-fRONTEND\surechat-backend\routes\billing.js
const express = require('express');
const router = express.Router();
const { body, validationResult } = require('express-validator');
const { authenticate } = require('../middleware/auth');
const { pool } = require('../config/database');
const Stripe = require('stripe');
const https = require('https');
const { normalizeTier } = require('../utils/tierMapping');
const { limitsFor } = require('../utils/planLimits');
const pick = ({ voiceNotes, contacts, slots, wills, storageGb }) => ({ voiceNotes, contacts, slots, wills, storageGb });

const _stripeAgent = new https.Agent({ keepAlive: true, keepAliveMsecs: 60_000, freeSocketTimeout: 45_000 });
const stripe = process.env.STRIPE_SECRET_KEY
  ? new Stripe(process.env.STRIPE_SECRET_KEY, { httpAgent: _stripeAgent })
  : null;

// Get billing plans
router.get('/plans', authenticate, async (req, res) => {
  try {
    const plans = [
      {
        id: 'lite',
        name: 'SureTalk LITE',
        price: 0,
        currency: 'usd',
        interval: 'month',
        features: [
          '3 slots (a contact and their voice note each)',
          '180-day retention',
          'Basic IVR access',
          'Phone-only access'
        ],
        limits: {
          ...pick(limitsFor('LITE')),
          retentionDays: 180
        }
      },
      {
        id: 'essential',
        name: 'SureTalk Essential',
        price: 6.99,
        currency: 'usd',
        interval: 'month',
        features: [
          '9 slots (a contact and their voice note each)',
          '1-year retention',
          'Advanced IVR features',
          'Web dashboard access',
          'Export capabilities'
        ],
        limits: {
          ...pick(limitsFor('ESSENTIAL')),
          retentionDays: 365
        }
      },
      {
        id: 'premium',
        name: 'Legacy Vault Premium',
        price: 12.99,
        currency: 'usd',
        interval: 'month',
        features: [
          'All Essential features',
          '9 slots plus 3 voice wills (5 minutes each)',
          'Permanent storage',
          'Scheduled legacy messages',
          'Bank-level encryption',
          'Priority support'
        ],
        limits: {
          ...pick(limitsFor('LEGACY_VAULT_PREMIUM')),
          retentionDays: 99999 // Permanent
        }
      }
    ];

    res.json({
      success: true,
      data: plans
    });

  } catch (error) {
    console.error('Get plans error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch plans'
    });
  }
});

// Get current subscription
router.get('/subscription', authenticate, async (req, res) => {
  try {
    const userQuery = await pool.query(
      `SELECT 
        subscription_tier,
        subscription_status,
        stripe_customer_id,
        stripe_subscription_id,
        storage_limit_gb,
        contacts_limit,
        voice_notes_limit
       FROM users 
       WHERE id = $1`,
      [req.user.id]
    );

    const user = userQuery.rows[0];

    // Get billing history
    const billingHistory = await pool.query(
      `SELECT *
       FROM billing_history
       WHERE user_id = $1
       ORDER BY created_at DESC
       LIMIT 10`,
      [req.user.id]
    );

    // If Stripe is configured, get subscription details
    let stripeSubscription = null;
    if (stripe && user.stripe_subscription_id) {
      try {
        // Race against an 8 second timeout
        const stripePromise = stripe.subscriptions.retrieve(
          user.stripe_subscription_id,
          { expand: ['latest_invoice.payment_intent'] }
        );

        const timeoutPromise = new Promise((_, reject) =>
          setTimeout(() => reject(new Error('Stripe request timed out after 8s')), 8000)
        );

        stripeSubscription = await Promise.race([stripePromise, timeoutPromise]);

      } catch (stripeError) {
        console.warn('Failed to fetch Stripe subscription:', stripeError.message);

        // If subscription ID is invalid or not found, clear it from DB
        // so future requests don't waste time trying to fetch it
        if (
          stripeError.type === 'StripeInvalidRequestError' ||
          stripeError.message?.includes('No such subscription') ||
          stripeError.message?.includes('resource_missing') ||
          stripeError.message?.includes('timed out')
        ) {
          try {
            await pool.query(
              `UPDATE users
               SET stripe_subscription_id = NULL, updated_at = NOW()
               WHERE id = $1 AND stripe_subscription_id = $2`,
              [req.user.id, user.stripe_subscription_id]
            );
            console.log(`Cleared invalid stripe_subscription_id for user ${req.user.id}`);
          } catch (clearErr) {
            console.warn('Failed to clear invalid stripe_subscription_id:', clearErr.message);
          }
        }
      }
    }

    res.json({
      success: true,
      data: {
        currentTier: normalizeTier(user.subscription_tier),
        status: user.subscription_status,
        limits: {
          storageGb: user.storage_limit_gb,
          contacts: user.contacts_limit,
          voiceNotes: user.voice_notes_limit
        },
        billingHistory: billingHistory.rows,
        stripeSubscription
      }
    });

  } catch (error) {
    console.error('Get subscription error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch subscription'
    });
  }
});

// Create checkout session for upgrade
router.post('/create-checkout', authenticate, [
  body('priceId').notEmpty().withMessage('Price ID is required'),
  body('successUrl').notEmpty().withMessage('Success URL is required'),
  body('cancelUrl').notEmpty().withMessage('Cancel URL is required')
], async (req, res) => {
  try {
    if (req.isImpersonating) {
      return res.status(403).json({ success: false, error: 'This action is not allowed during impersonation' });
    }

    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      console.log('Validation errors:', errors.array()); // Add this for debugging
      return res.status(400).json({
        success: false,
        errors: errors.array()
      });
    }

    if (!stripe) {
      return res.status(500).json({
        success: false,
        error: 'Billing system not configured'
      });
    }

    const { priceId, successUrl, cancelUrl } = req.body;

    // Get or create Stripe customer
    let stripeCustomerId = null;
    const user = await pool.query(
      'SELECT stripe_customer_id FROM users WHERE id = $1',
      [req.user.id]
    );

    if (user.rows[0]?.stripe_customer_id) {
      stripeCustomerId = user.rows[0].stripe_customer_id;
    } else {
      const customer = await stripe.customers.create({
        email: req.user.email,
        name: req.user.full_name,
        metadata: {
          userId: req.user.id
        }
      });
      
      stripeCustomerId = customer.id;
      
      // Save customer ID to database
      await pool.query(
        'UPDATE users SET stripe_customer_id = $1 WHERE id = $2',
        [stripeCustomerId, req.user.id]
      );
    }

    // Create checkout session
    const session = await stripe.checkout.sessions.create({
      customer: stripeCustomerId,
      payment_method_types: ['card'],
      line_items: [{
        price: priceId,
        quantity: 1,
      }],
      mode: 'subscription',
      success_url: successUrl,
      cancel_url: cancelUrl,
      metadata: {
        userId: req.user.id
      },
      subscription_data: {
        metadata: {
          userId: req.user.id,
          userEmail: req.user.email
        }
      }
    });

    res.json({
      success: true,
      data: {
        sessionId: session.id,
        url: session.url
      }
    });

  } catch (error) {
    console.error('Create checkout error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to create checkout session'
    });
  }
});

// Create portal session for subscription management
router.post('/create-portal-session', authenticate, async (req, res) => {
  try {
    if (!stripe) {
      return res.status(500).json({
        success: false,
        error: 'Billing system not configured'
      });
    }

    const { returnUrl } = req.body;

    const userResult = await pool.query(
      `SELECT stripe_customer_id, stripe_subscription_id,
              subscription_tier, full_name, email, source
       FROM users WHERE id = $1`,
      [req.user.id]
    );

    const user = userResult.rows[0];

    // No Stripe customer ID — distinguish free web users from IVR subscribers
    if (!user?.stripe_customer_id) {
      console.warn(`create-portal-session: no stripe_customer_id for user ${req.user.id} (source=${user?.source})`);
      const isIvr = user?.source === 'ivr';
      return res.status(400).json({
        success: false,
        error: isIvr
          ? 'No billing account found. If you subscribed via phone, please contact support to link your account.'
          : 'You are on the free LITE plan. Upgrade your subscription to access billing management.',
        code: isIvr ? 'NO_STRIPE_CUSTOMER' : 'FREE_PLAN'
      });
    }

    // Verify the customer still exists in Stripe before creating portal
    try {
      const customerPromise = stripe.customers.retrieve(user.stripe_customer_id);
      const timeoutPromise = new Promise((_, reject) =>
        setTimeout(() => reject(new Error('customer_lookup_timeout')), 8000)
      );
      await Promise.race([customerPromise, timeoutPromise]);
    } catch (stripeErr) {
      // Only clear customer ID if Stripe definitively says it doesn't exist
      // Never clear on timeouts or connection errors
      const isDefinitelyGone =
        stripeErr.type === 'StripeInvalidRequestError' &&
        (stripeErr.code === 'resource_missing' ||
         stripeErr.message?.includes('No such customer'));

      if (isDefinitelyGone) {
        await pool.query(
          'UPDATE users SET stripe_customer_id = NULL WHERE id = $1',
          [req.user.id]
        );
        return res.status(400).json({
          success: false,
          error: 'Billing account not found. Please contact support.',
          code: 'STRIPE_CUSTOMER_NOT_FOUND'
        });
      }

      // For timeouts or connection errors — keep the customer ID, just proceed
      // The portal session creation will also have its own timeout
      console.warn('Customer verification failed (non-fatal, proceeding):', stripeErr.message);
    }

    const portalPromise = stripe.billingPortal.sessions.create({
      customer: user.stripe_customer_id,
      return_url: returnUrl || `${process.env.FRONTEND_URL}/usersDashboard/billing`
    });

    const timeoutPromise = new Promise((_, reject) =>
      setTimeout(() => reject(new Error('Portal session request timed out after 8s')), 8000)
    );

    const session = await Promise.race([portalPromise, timeoutPromise]);

    res.json({
      success: true,
      data: { url: session.url }
    });

  } catch (error) {
    console.error('Create portal session error:', {
      message: error.message,
      type: error.type,
      code: error.code,
      param: error.param,
      userId: req.user?.id
    });
    res.status(500).json({
      success: false,
      error: 'Failed to create portal session'
    });
  }
});

// Stripe webhooks are handled by routes/stripeWebhook.js (mounted before this router at /api/billing/webhook).

// Helper function to map Stripe price ID to tier
function getTierFromPriceId(priceId) {
  console.log('🔍 Looking up tier for price ID:', priceId);
  
  // This should match your Stripe price IDs from environment variables
  const priceMap = {
    [process.env.NEXT_PUBLIC_STRIPE_LITE_PRICE_ID]: 'LITE',
    [process.env.NEXT_PUBLIC_STRIPE_ESSENTIAL_PRICE_ID]: 'ESSENTIAL',
    [process.env.NEXT_PUBLIC_STRIPE_PREMIUM_PRICE_ID]: 'LEGACY_VAULT_PREMIUM'
  };
  
  console.log('Price map:', priceMap);
  
  const tier = priceMap[priceId] || 'LITE';
  console.log('Found tier:', tier);
  
  return tier;
}

// Tier change endpoint.
//
// Rules:
//   - Paid upgrades (ESSENTIAL / LEGACY_VAULT_PREMIUM) are always blocked for regular
//     users — they must go through Stripe Checkout so a real payment is collected.
//   - Downgrade to LITE for a user who has an active Stripe subscription: the frontend
//     must send the user to the Stripe Customer Portal to cancel. The subscription.deleted
//     webhook then resets them to LITE automatically. We return code:'USE_PORTAL' to
//     signal this to the frontend.
//   - Downgrade to LITE for a user with no Stripe subscription (e.g. IVR-only user):
//     allowed directly — there is no Stripe subscription to cancel.
//   - Admins bypass all of the above and can change any user to any tier.
router.post('/change-tier', authenticate, [
  body('tier').isIn(['LITE', 'ESSENTIAL', 'LEGACY_VAULT_PREMIUM'])
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, errors: errors.array() });
    }

    const { tier } = req.body;
    // Admins can target any user; regular users can only act on themselves.
    const userId = req.user.is_admin ? (req.body.userId || req.user.id) : req.user.id;

    // ── Regular user rules ──────────────────────────────────────────────────
    if (!req.user.is_admin) {
      // Block all paid-tier upgrades — must pay through Stripe Checkout
      if (tier !== 'LITE') {
        return res.status(403).json({
          success: false,
          code: 'USE_CHECKOUT',
          error: 'Please use the upgrade flow to switch to a paid plan.'
        });
      }

      // Downgrade to LITE: check whether the user has an active Stripe subscription
      const subRow = await pool.query(
        'SELECT stripe_subscription_id FROM users WHERE id = $1',
        [userId]
      );
      const stripeSubId = subRow.rows[0]?.stripe_subscription_id;

      if (stripeSubId) {
        // Has a Stripe subscription — must cancel it through the portal.
        // The subscription.deleted webhook will reset them to LITE automatically.
        return res.status(200).json({
          success: false,
          code: 'USE_PORTAL',
          error: 'Please cancel your subscription through the billing portal to downgrade to the free plan.'
        });
      }
      // No Stripe subscription (IVR user or already free) — fall through to direct change
    }

    // Get current tier
    const currentTierQuery = await pool.query(
      'SELECT subscription_tier FROM users WHERE id = $1',
      [userId]
    );

    const currentTier = currentTierQuery.rows[0].subscription_tier;

    // Update user tier
    await pool.query(
      `UPDATE users 
       SET subscription_tier = $1,
           subscription_status = 'active',
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $2`,
      [tier, userId]
    );

    // Create billing record for tier change
    await pool.query(
      `INSERT INTO billing_history (
        user_id, amount_cents, currency, description, status, tier_before, tier_after
      ) VALUES ($1, $2, $3, $4, 'manual_change', $5, $6)`,
      [
        userId,
        0, // Manual change, no charge
        'USD',
        `Tier changed from ${currentTier} to ${tier}`,
        currentTier,
        tier
      ]
    );

    // Update limits based on tier
    const limits = getLimitsForTier(tier);
    await pool.query(
      `UPDATE users
       SET storage_limit_gb = $1,
           contacts_limit = $2,
           voice_notes_limit = $3
       WHERE id = $4`,
      [limits.storageGb, limits.contacts, limits.voiceNotes, userId]
    );

    // Sync new tier to IVR/DynamoDB
    try {
      const { syncToIvr } = require('../utils/syncIvr');
      const { ivrTierName } = require('../utils/tierMapping');
      const changedUser = await pool.query('SELECT phone FROM users WHERE id = $1', [userId]);
      if (changedUser.rows[0]?.phone) {
        syncToIvr({
          userId: changedUser.rows[0].phone,
          subscription_tier: ivrTierName(tier),
          verified: true,
          action: 'update_tier',
          source: 'app'
        }, 'sync-user');
        console.log('✅ IVR sync triggered after tier change for user', userId);
      }
    } catch (syncErr) {
      console.error('IVR sync failed after tier change (non-fatal):', syncErr.message);
    }

    res.json({
      success: true,
      message: `Subscription tier changed to ${tier}`,
      data: {
        newTier: tier,
        newLimits: limits
      }
    });

  } catch (error) {
    console.error('Change tier error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to change subscription tier'
    });
  }
});

// ── GET /api/billing/history ─────────────────────────────────────────────────
router.get('/history', authenticate, async (req, res) => {
  try {
    const localHistory = await pool.query(
      `SELECT stripe_invoice_id, amount_cents, currency,
              description, status, created_at
       FROM billing_history
       WHERE user_id = $1
       ORDER BY created_at DESC
       LIMIT 24`,
      [req.user.id]
    );

    const userResult = await pool.query(
      'SELECT stripe_customer_id FROM users WHERE id = $1',
      [req.user.id]
    );

    let stripeInvoices = [];
    if (stripe && userResult.rows[0]?.stripe_customer_id) {
      try {
        const invoicesPromise = stripe.invoices.list({
          customer: userResult.rows[0].stripe_customer_id,
          limit: 24
        });
        const timeoutPromise = new Promise((_, reject) =>
          setTimeout(() => reject(new Error('timeout')), 8000)
        );
        const invoices = await Promise.race([invoicesPromise, timeoutPromise]);
        stripeInvoices = invoices.data.map(inv => ({
          id: inv.id,
          amount: inv.amount_paid / 100,
          currency: inv.currency.toUpperCase(),
          status: inv.status,
          date: new Date(inv.created * 1000).toISOString(),
          description: inv.description || 'Subscription payment',
          pdfUrl: inv.invoice_pdf,
          hostedUrl: inv.hosted_invoice_url
        }));
      } catch (stripeErr) {
        console.error('Stripe invoice fetch failed:', stripeErr.message);
      }
    }

    res.json({
      success: true,
      data: { stripeInvoices, localHistory: localHistory.rows }
    });
  } catch (err) {
    console.error('Billing history error:', err.message);
    res.status(500).json({ success: false, error: 'Failed to fetch billing history' });
  }
});

// ── GET /api/billing/payment-methods ─────────────────────────────────────────
router.get('/payment-methods', authenticate, async (req, res) => {
  try {
    const userResult = await pool.query(
      'SELECT stripe_customer_id FROM users WHERE id = $1',
      [req.user.id]
    );

    if (!stripe || !userResult.rows[0]?.stripe_customer_id) {
      return res.json({
        success: true,
        data: { paymentMethods: [], hasStripeCustomer: false }
      });
    }

    const pmPromise = stripe.paymentMethods.list({
      customer: userResult.rows[0].stripe_customer_id,
      type: 'card'
    });
    const timeoutPromise = new Promise((_, reject) =>
      setTimeout(() => reject(new Error('timeout')), 8000)
    );
    const paymentMethods = await Promise.race([pmPromise, timeoutPromise]);

    const customerPromise = stripe.customers.retrieve(userResult.rows[0].stripe_customer_id);
    const customer = await Promise.race([
      customerPromise,
      new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 8000))
    ]);

    const defaultPmId = customer.invoice_settings?.default_payment_method;

    const cards = paymentMethods.data.map(pm => ({
      id: pm.id,
      brand: pm.card.brand,
      last4: pm.card.last4,
      expMonth: pm.card.exp_month,
      expYear: pm.card.exp_year,
      isDefault: pm.id === defaultPmId
    }));

    res.json({
      success: true,
      data: { paymentMethods: cards, hasStripeCustomer: true }
    });
  } catch (err) {
    console.error('Payment methods error:', err.message);
    res.status(500).json({ success: false, error: 'Failed to fetch payment methods' });
  }
});

// Helper function to get limits for tier
function getLimitsForTier(tier) {
  return limitsFor(tier);
}

module.exports = router;