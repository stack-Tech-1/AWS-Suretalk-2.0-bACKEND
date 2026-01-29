// C:\Users\SMC\Documents\GitHub\AWS-Suretalk-2.0-fRONTEND\surechat-backend\routes\billing.js
const express = require('express');
const router = express.Router();
const { body, validationResult } = require('express-validator');
const { authenticate } = require('../middleware/auth');
const { pool } = require('../config/database');
const Stripe = require('stripe');

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
        stripeSubscription = await stripe.subscriptions.retrieve(
          user.stripe_subscription_id,
          {
            expand: ['latest_invoice.payment_intent']
          }
        );
      } catch (stripeError) {
        console.warn('Failed to fetch Stripe subscription:', stripeError.message);
      }
    }

    res.json({
      success: true,
      data: {
        currentTier: user.subscription_tier,
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

    // Get Stripe customer ID
    const user = await pool.query(
      'SELECT stripe_customer_id FROM users WHERE id = $1',
      [req.user.id]
    );

    if (!user.rows[0]?.stripe_customer_id) {
      return res.status(400).json({
        success: false,
        error: 'No subscription found'
      });
    }

    // Create portal session
    const session = await stripe.billingPortal.sessions.create({
      customer: user.rows[0].stripe_customer_id,
      return_url: returnUrl || `${process.env.FRONTEND_URL}/dashboard/settings`
    });

    res.json({
      success: true,
      data: {
        url: session.url
      }
    });

  } catch (error) {
    console.error('Create portal session error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to create portal session'
    });
  }
});

// Handle Stripe webhook
router.post('/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  console.log('📥 Webhook received');
  
  let event;
  
  try {
    const signature = req.headers['stripe-signature'];
    const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
    
    console.log('Signature exists:', !!signature);
    console.log('Webhook secret exists:', !!webhookSecret);

    if (signature && webhookSecret) {
      // Verify webhook signature (production or CLI with secret)
      try {
        event = stripe.webhooks.constructEvent(
          req.body,
          signature,
          webhookSecret
        );
        console.log('✅ Webhook signature verified');
      } catch (err) {
        console.error('❌ Webhook signature verification failed:', err.message);
        console.log('⚠️ Attempting to parse as JSON for CLI testing...');
        
        // Try to parse as JSON for CLI testing
        try {
          event = JSON.parse(req.body.toString());
          console.log('✅ Parsed webhook from CLI');
        } catch (parseErr) {
          console.error('❌ Failed to parse webhook:', parseErr.message);
          return res.status(400).send(`Webhook Error: ${err.message}`);
        }
      }
    } else {
      // No signature - parse as JSON (for CLI without secret)
      console.log('⚠️ No signature, parsing as JSON');
      event = JSON.parse(req.body.toString());
    }
    
    console.log('✅ Webhook event type:', event.type);
    
    // Handle the event
    switch (event.type) {
      case 'checkout.session.completed':
        console.log('💰 Checkout completed:', event.data.object.id);
        await handleCheckoutSessionCompleted(event.data.object);
        break;
      
      case 'customer.subscription.updated':
        console.log('🔄 Subscription updated:', event.data.object.id);
        await handleSubscriptionUpdated(event.data.object);
        break;
      
      case 'customer.subscription.deleted':
        console.log('🗑️ Subscription deleted:', event.data.object.id);
        await handleSubscriptionDeleted(event.data.object);
        break;
      
      case 'invoice.payment_succeeded':
        console.log('✅ Invoice payment succeeded:', event.data.object.id);
        await handleInvoicePaymentSucceeded(event.data.object);
        break;
      
      case 'invoice.payment_failed':
        console.log('❌ Invoice payment failed:', event.data.object.id);
        await handleInvoicePaymentFailed(event.data.object);
        break;
      
      default:
        console.log(`⚡ Unhandled event type: ${event.type}`);
    }
    
    res.json({ received: true });
    
  } catch (error) {
    console.error('❌ Webhook error:', error);
    console.error('Error stack:', error.stack);
    res.status(500).json({
      success: false,
      error: 'Webhook handler failed'
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