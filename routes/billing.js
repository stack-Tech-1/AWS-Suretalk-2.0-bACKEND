// C:\Users\SMC\Documents\GitHub\AWS-Suretalk-2.0-fRONTEND\surechat-backend\routes\billing.js
const express = require('express');
const router = express.Router();
const { body, validationResult } = require('express-validator');
const { authenticate } = require('../middleware/auth');
const { pool } = require('../config/database');
const Stripe = require('stripe');
const { normalizeTier } = require('../utils/tierMapping');

// Initialize Stripe
const stripe = process.env.STRIPE_SECRET_KEY 
  ? new Stripe(process.env.STRIPE_SECRET_KEY)
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
          '3 voice notes max',
          '3 contacts max',
          '180-day retention',
          'Basic IVR access',
          'Phone-only access'
        ],
        limits: {
          voiceNotes: 3,
          contacts: 3,
          storageGb: 1,
          retentionDays: 180
        }
      },
      {
        id: 'essential',
        name: 'SureTalk Essential',
        price: 4.99,
        currency: 'usd',
        interval: 'month',
        features: [
          'Unlimited voice notes',
          '9 contacts',
          '1-year retention',
          'Advanced IVR features',
          'Web dashboard access',
          'Export capabilities'
        ],
        limits: {
          voiceNotes: 100,
          contacts: 9,
          storageGb: 5,
          retentionDays: 365
        }
      },
      {
        id: 'premium',
        name: 'Legacy Vault Premium',
        price: 9.99,
        currency: 'usd',
        interval: 'month',
        features: [
          'All Essential features',
          'Permanent storage',
          'Voice Wills',
          'Scheduled legacy messages',
          'Bank-level encryption',
          'Priority support'
        ],
        limits: {
          voiceNotes: 500,
          contacts: 25,
          storageGb: 50,
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
      userId: req.user.id
    });
    res.status(500).json({
      success: false,
      error: 'Failed to create portal session'
    });
  }
});

// Handle Stripe webhook
router.post('/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  if (!stripe) {
    return res.status(503).json({ error: 'Stripe not configured' });
  }

  const sig = req.headers['stripe-signature'];
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

  if (!sig || !webhookSecret) {
    console.error('Missing stripe signature or webhook secret');
    return res.status(400).json({ error: 'Missing signature or webhook secret' });
  }

  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, webhookSecret);
    console.log(`✅ Stripe webhook received: ${event.type}`);
  } catch (err) {
    console.error('Stripe webhook verification failed:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  // Always respond to Stripe immediately — process asynchronously
  res.status(200).json({ received: true });

  // Process event after responding
  try {
    const object = event.data.object;

    // Helper: find user in PostgreSQL by Stripe customer metadata or ID
    const findUser = async (stripeObject) => {
      // 1. Try metadata.userId (phone number stored when customer was created on EC2)
      const metaUserId = stripeObject.metadata?.userId ||
                         stripeObject.customer_details?.phone;

      if (metaUserId) {
        const byPhone = await pool.query(
          `SELECT id, phone, email, subscription_tier, stripe_customer_id
           FROM users
           WHERE phone = $1 AND deleted_at IS NULL
           LIMIT 1`,
          [metaUserId]
        );
        if (byPhone.rows.length > 0) {
          console.log(`Found user via metadata.userId phone: ${metaUserId}`);
          return byPhone.rows[0];
        }
      }

      // 2. Try stripe_customer_id
      const customerId = stripeObject.customer || stripeObject.id;
      if (customerId) {
        const byCustomer = await pool.query(
          `SELECT id, phone, email, subscription_tier, stripe_customer_id
           FROM users
           WHERE stripe_customer_id = $1 AND deleted_at IS NULL
           LIMIT 1`,
          [customerId]
        );
        if (byCustomer.rows.length > 0) {
          console.log(`Found user via stripe_customer_id: ${customerId}`);
          return byCustomer.rows[0];
        }
      }

      // 3. Try customer email via Stripe API
      try {
        if (customerId && customerId.startsWith('cus_')) {
          const customer = await stripe.customers.retrieve(customerId);
          if (customer.email) {
            const byEmail = await pool.query(
              `SELECT id, phone, email, subscription_tier, stripe_customer_id
               FROM users
               WHERE email = $1 AND deleted_at IS NULL
               LIMIT 1`,
              [customer.email]
            );
            if (byEmail.rows.length > 0) {
              console.log(`Found user via Stripe customer email: ${customer.email}`);
              return byEmail.rows[0];
            }
          }
        }
      } catch (stripeErr) {
        console.warn('Could not retrieve Stripe customer for email lookup:', stripeErr.message);
      }

      console.warn('No user found for Stripe event:', {
        type: event.type,
        customerId,
        metadata: stripeObject.metadata
      });
      return null;
    };

    // Helper: map Stripe price ID to tier
    const getTierFromPriceId = (priceId) => {
      const priceMap = {
        [process.env.STRIPE_PRICE_LITE]: 'LITE',
        [process.env.STRIPE_PRICE_ESSENTIAL]: 'ESSENTIAL',
        [process.env.STRIPE_PRICE_PREMIUM]: 'LEGACY_VAULT_PREMIUM',
        [process.env.NEXT_PUBLIC_STRIPE_LITE_PRICE_ID]: 'LITE',
        [process.env.NEXT_PUBLIC_STRIPE_ESSENTIAL_PRICE_ID]: 'ESSENTIAL',
        [process.env.NEXT_PUBLIC_STRIPE_PREMIUM_PRICE_ID]: 'LEGACY_VAULT_PREMIUM',
        [process.env.STRIPE_TEST_PRICE_LITE]: 'LITE',
        [process.env.STRIPE_TEST_PRICE_ESSENTIAL]: 'ESSENTIAL',
        [process.env.STRIPE_TEST_PRICE_PREMIUM]: 'LEGACY_VAULT_PREMIUM'
      };
      return priceMap[priceId] || null;
    };

    // Helper: update PostgreSQL and sync to DynamoDB/IVR
    const updateUserSubscription = async (userId, userPhone, updates) => {
      const setParts = [];
      const values = [];
      let paramCount = 1;

      for (const [key, value] of Object.entries(updates)) {
        setParts.push(`${key} = $${paramCount}`);
        values.push(value);
        paramCount++;
      }

      setParts.push(`updated_at = NOW()`);
      values.push(userId);

      await pool.query(
        `UPDATE users SET ${setParts.join(', ')} WHERE id = $${paramCount}`,
        values
      );

      console.log(`✅ PostgreSQL updated for user ${userId}:`, updates);

      // Sync tier change to DynamoDB/IVR if tier or status changed
      if (updates.subscription_tier || updates.subscription_status) {
        try {
          const { syncToIvr } = require('../utils/syncIvr');
          syncToIvr({
            userId: userPhone,
            subscription_tier: updates.subscription_tier,
            verified: updates.subscription_status === 'active' ||
                      updates.subscription_status === 'trialing',
            action: 'update',
            source: 'stripe_webhook'
          }, 'sync-user');
          console.log(`✅ IVR sync triggered for user ${userId}`);
        } catch (syncErr) {
          console.error('IVR sync failed after webhook (non-fatal):', syncErr.message);
        }
      }
    };

    // Process each event type
    switch (event.type) {

      case 'customer.subscription.created':
      case 'customer.subscription.updated': {
        const subscription = object;
        const user = await findUser(subscription);
        if (!user) break;

        const priceId = subscription.items?.data[0]?.price?.id;
        const tier = getTierFromPriceId(priceId) || user.subscription_tier;

        await updateUserSubscription(user.id, user.phone, {
          subscription_tier: tier,
          subscription_status: subscription.status,
          stripe_subscription_id: subscription.id,
          stripe_customer_id: subscription.customer
        });

        console.log(`✅ Subscription ${event.type} processed for user ${user.id} — tier: ${tier}`);
        break;
      }

      case 'customer.subscription.deleted': {
        const subscription = object;
        const user = await findUser(subscription);
        if (!user) break;

        await updateUserSubscription(user.id, user.phone, {
          subscription_tier: 'LITE',
          subscription_status: 'inactive',
          stripe_subscription_id: null
        });

        console.log(`✅ Subscription deleted — user ${user.id} downgraded to LITE`);
        break;
      }

      case 'invoice.paid': {
        const invoice = object;
        const user = await findUser(invoice);
        if (!user) break;

        await updateUserSubscription(user.id, user.phone, {
          subscription_status: 'active',
          stripe_customer_id: invoice.customer
        });

        // Log billing history
        try {
          await pool.query(
            `INSERT INTO billing_history
              (user_id, stripe_invoice_id, amount_cents, currency, description, status)
             VALUES ($1, $2, $3, $4, $5, 'succeeded')
             ON CONFLICT DO NOTHING`,
            [
              user.id,
              invoice.id,
              invoice.amount_paid || 0,
              invoice.currency || 'usd',
              'Subscription payment'
            ]
          );
        } catch (billingErr) {
          console.warn('Failed to log billing history:', billingErr.message);
        }

        console.log(`✅ Invoice paid for user ${user.id} — $${(invoice.amount_paid / 100).toFixed(2)}`);
        break;
      }

      case 'invoice.payment_failed': {
        const invoice = object;
        const user = await findUser(invoice);
        if (!user) break;

        await updateUserSubscription(user.id, user.phone, {
          subscription_status: 'past_due'
        });

        // Log failed billing
        try {
          await pool.query(
            `INSERT INTO billing_history
              (user_id, stripe_invoice_id, amount_cents, currency, description, status)
             VALUES ($1, $2, $3, $4, $5, 'failed')
             ON CONFLICT DO NOTHING`,
            [
              user.id,
              invoice.id,
              invoice.amount_due || 0,
              invoice.currency || 'usd',
              'Payment failed'
            ]
          );
        } catch (billingErr) {
          console.warn('Failed to log billing history:', billingErr.message);
        }

        console.log(`⚠️ Payment failed for user ${user.id}`);
        break;
      }

      default:
        console.log(`ℹ️ Unhandled Stripe event type: ${event.type}`);
    }

  } catch (processingError) {
    // Don't throw — we already sent 200 to Stripe
    // Log for debugging but don't cause Stripe to retry
    console.error('Webhook processing error (non-fatal after 200 response):', {
      message: processingError.message,
      eventType: event.type,
      stack: processingError.stack
    });
  }
});

// Webhook handlers
async function handleCheckoutSessionCompleted(session) {
  try {
    console.log('💰 Handling checkout session completed:', session.id);
    console.log('📋 Session metadata:', session.metadata);
    
    const userId = session.metadata?.userId;
    if (!userId) {
      console.log('⚠️ No userId in session metadata');
      return;
    }

    console.log('👤 User ID from metadata:', userId);
    
    // Validate userId is a valid UUID
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!uuidRegex.test(userId)) {
      console.error('❌ Invalid userId format:', userId);
      return;
    }
    
    const subscription = await stripe.subscriptions.retrieve(
      session.subscription
    );
    
    console.log('📊 Subscription details:', {
      id: subscription.id,
      status: subscription.status,
      priceId: subscription.items.data[0]?.price.id,
      customer: subscription.customer
    });
    
    if (!subscription.items.data[0]?.price.id) {
      console.error('❌ No price ID found in subscription');
      return;
    }
    
    const priceId = subscription.items.data[0].price.id;
    const tier = getTierFromPriceId(priceId);
    
    console.log('🎯 Updating user to tier:', tier);
    
    // Validate all parameters before database query
    if (!tier || !subscription.id || !session.customer) {
      console.error('❌ Missing required parameters:', { tier, subscriptionId: subscription.id, customerId: session.customer });
      return;
    }
    
    // FIXED QUERY: Explicitly cast parameters
    const result = await pool.query(
      `UPDATE users 
       SET subscription_tier = $1::VARCHAR,
           subscription_status = 'active',
           stripe_subscription_id = $2::VARCHAR,
           stripe_customer_id = $3::VARCHAR,
           contacts_limit = CASE $1::VARCHAR
             WHEN 'ESSENTIAL' THEN 9 
             WHEN 'LEGACY_VAULT_PREMIUM' THEN 25 
             ELSE 3 
           END,
           storage_limit_gb = CASE $1::VARCHAR
             WHEN 'ESSENTIAL' THEN 5 
             WHEN 'LEGACY_VAULT_PREMIUM' THEN 50 
             ELSE 1 
           END,
           voice_notes_limit = CASE $1::VARCHAR
             WHEN 'ESSENTIAL' THEN 100 
             WHEN 'LEGACY_VAULT_PREMIUM' THEN 500 
             ELSE 3 
           END
       WHERE id = $4::UUID
       RETURNING *`,
      [tier, subscription.id, session.customer, userId]
    );
    
    if (result.rowCount === 0) {
      console.error('❌ User not found:', userId);
      return;
    }
    
    console.log('✅ User updated successfully:', result.rows[0].email);

    // FIXED: Check if session.invoice exists before creating billing record
    if (session.invoice) {
      await pool.query(
        `INSERT INTO billing_history (
          user_id, stripe_invoice_id, amount_cents, currency, description, status
        ) VALUES ($1::UUID, $2::VARCHAR, $3::INTEGER, $4::VARCHAR, $5::TEXT, 'paid')`,
        [
          userId,
          session.invoice,
          session.amount_total || 0,
          session.currency || 'USD',
          `Initial ${tier} subscription payment`
        ]
      );
      console.log('✅ Billing record created');
    } else {
      console.log('⚠️ No invoice in session, skipping billing record');
    }

  } catch (error) {
    console.error('❌ Handle checkout session completed error:', error);
    console.error('Error stack:', error.stack);
    console.error('Error details:', {
      message: error.message,
      code: error.code,
      detail: error.detail,
      hint: error.hint,
      position: error.position
    });
  }
}

async function handleSubscriptionUpdated(subscription) {
  try {
    const userId = subscription.metadata?.userId;
    if (!userId) return;

    // Update subscription status
    await pool.query(
      `UPDATE users 
       SET subscription_status = $1
       WHERE stripe_subscription_id = $2`,
      [subscription.status, subscription.id]
    );

  } catch (error) {
    console.error('Handle subscription updated error:', error);
  }
}

async function handleSubscriptionDeleted(subscription) {
  try {
    const userId = subscription.metadata?.userId;
    if (!userId) return;

    // Downgrade user to LITE tier
    await pool.query(
      `UPDATE users 
       SET subscription_tier = 'LITE',
           subscription_status = 'inactive',
           stripe_subscription_id = NULL
       WHERE stripe_subscription_id = $1`,
      [subscription.id]
    );

  } catch (error) {
    console.error('Handle subscription deleted error:', error);
  }
}

async function handleInvoicePaymentSucceeded(invoice) {
  try {
    const subscription = await stripe.subscriptions.retrieve(invoice.subscription);
    const userId = subscription.metadata?.userId;
    if (!userId) return;

    // FIXED: Explicitly cast parameters
    await pool.query(
      `INSERT INTO billing_history (
        user_id, stripe_invoice_id, amount_cents, currency, description, status
      ) VALUES ($1::UUID, $2::VARCHAR, $3::INTEGER, $4::VARCHAR, $5::TEXT, 'paid')`,
      [
        userId,
        invoice.id,
        invoice.amount_paid || 0,
        invoice.currency || 'USD',
        'Recurring subscription payment'
      ]
    );

  } catch (error) {
    console.error('Handle invoice payment succeeded error:', error);
  }
}

async function handleInvoicePaymentFailed(invoice) {
  try {
    const subscription = await stripe.subscriptions.retrieve(invoice.subscription);
    const userId = subscription.metadata?.userId;
    if (!userId) return;

    // Update subscription status
    await pool.query(
      `UPDATE users 
       SET subscription_status = 'past_due'
       WHERE stripe_subscription_id = $1`,
      [invoice.subscription]
    );

    // Create billing record
    await pool.query(
      `INSERT INTO billing_history (
        user_id, stripe_invoice_id, amount_cents, currency, description, status
      ) VALUES ($1, $2, $3, $4, $5, 'failed')`,
      [
        userId,
        invoice.id,
        invoice.amount_due,
        invoice.currency,
        'Payment failed'
      ]
    );

  } catch (error) {
    console.error('Handle invoice payment failed error:', error);
  }
}

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

// Manual upgrade/downgrade (for admin or manual handling)
router.post('/change-tier', authenticate, [
  body('tier').isIn(['LITE', 'ESSENTIAL', 'LEGACY_VAULT_PREMIUM'])
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({
        success: false,
        errors: errors.array()
      });
    }

    const { tier } = req.body;
    const userId = req.user.id;

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
  const limits = {
    LITE: { storageGb: 1, contacts: 3, voiceNotes: 3 },
    ESSENTIAL: { storageGb: 5, contacts: 9, voiceNotes: 100 },
    LEGACY_VAULT_PREMIUM: { storageGb: 50, contacts: 25, voiceNotes: 500 }
  };
  return limits[tier] || limits.LITE;
}

module.exports = router;