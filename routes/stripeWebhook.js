// routes/stripeWebhook.js
// express.raw() is applied at the app level before this router (server.js)
//
// Handles every subscription on the Stripe account: ones bought in the app AND ones bought on a
// phone-line call (see utils/stripePlans.js for how the owner is found). For each change it:
//   - updates the app account (if there is one, and it isn't run by a different subscription)
//   - updates the phone line by phone number (also for phone-only customers with no app account)
//   - emails the customer (app email, else the email on their phone-line account)
// Reliability:
//   - Stripe is only told "received" AFTER the work is done; on any failure it gets a 500 and
//     retries (for up to 3 days), so a database blip can't lose an update.
//   - Events already handled are skipped (Stripe can send the same one twice).
//   - Subscriptions are re-read from Stripe, so an old or delayed event can't undo a newer change.
const express = require('express');
const router  = express.Router();
const { pool } = require('../config/database');
const { syncAccountToIvr } = require('../utils/syncIvr');
const { ivrTierName, normalizeTier, TIERS } = require('../utils/tierMapping');
const { PLAN_LIMITS } = require('../utils/planLimits');
const emailService = require('../utils/emailService');
const logger       = require('../utils/logger');
const {
  getStripe, PAID_STATUSES, tierOfSubscription, ownerOfSubscription, phoneLineAccount, hasOtherBillingSubscription,
} = require('../utils/stripePlans');

// ── Helpers ─────────────────────────────────────────────────────────────────

async function setUserLimits(userId, tier) {
  const l = PLAN_LIMITS[tier] || PLAN_LIMITS[TIERS.LITE];
  await pool.query(
    'UPDATE users SET contacts_limit = $1, voice_notes_limit = $2, storage_limit_gb = $3 WHERE id = $4',
    [l.contacts, l.voiceNotes, l.storageGb, userId]
  );
}

function formatDate(unixTs) {
  if (!unixTs) return null;
  return new Date(unixTs * 1000).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
}

// Invoices name their subscription here (older Stripe versions) or under parent (2025+ versions)
const subscriptionIdOf = (inv) => inv.subscription || inv.parent?.subscription_details?.subscription || null;
const customerIdOf = (obj) => (typeof obj.customer === 'string' ? obj.customer : obj.customer?.id) || null;

// Who to email: the app account, else the email on their phone-line account. null = nobody to email.
async function contactFor(owner) {
  if (owner.appUser?.email) return { email: owner.appUser.email, name: owner.appUser.full_name, phoneOnly: false };
  if (owner.viaPhone && owner.phoneLineId) {
    try {
      const acct = await phoneLineAccount(owner.phoneLineId);
      if (acct?.email) return { email: acct.email, name: acct.firstName || null, phoneOnly: !owner.appUser };
    } catch (e) {
      logger.warn(`Stripe webhook: could not read phone-line email for ${owner.phoneLineId}: ${e.message}`);
    }
  }
  return null;
}

const sendQuietly = (what, promise) => promise.catch(e => logger.error(`Failed to send ${what} email: ${e.message}`));

// The current state of a subscription in Stripe (falls back to the event's copy if it's gone)
async function freshSubscription(stripe, idOrObj) {
  const id = typeof idOrObj === 'string' ? idOrObj : idOrObj.id;
  try {
    return await stripe.subscriptions.retrieve(id);
  } catch (e) {
    if (e.code === 'resource_missing' && typeof idOrObj === 'object') return idOrObj;
    throw e;
  }
}

/**
 * Bring the app account and the phone line in line with a subscription's current state.
 * Returns { owner, tier, applied } — applied=false when a different subscription runs this account.
 */
async function applySubscription(sub) {
  const owner = await ownerOfSubscription(sub);
  const tier  = tierOfSubscription(sub);
  const paid  = PAID_STATUSES.includes(sub.status);

  if (owner.appUser && await hasOtherBillingSubscription(owner.appUser, sub)) {
    // An older subscription ending, or a second one: the account's own active subscription decides
    logger.warn(`Stripe: subscription ${sub.id} (${sub.status}) ignored for user ${owner.appUser.id}; their subscription ${owner.appUser.stripe_subscription_id} is still billing`);
    await pool.query(
      `INSERT INTO system_logs (user_id, level, service, message, metadata) VALUES ($1, 'warning', 'billing', $2, $3)`,
      [owner.appUser.id, 'Second subscription on this account', JSON.stringify({ ignored: sub.id, status: sub.status, kept: owner.appUser.stripe_subscription_id })]
    ).catch(() => {});
    return { owner, tier, applied: false };
  }

  if (owner.appUser) {
    // Ended -> free Lite with the account still usable ('inactive' would lock them out of the app)
    const ended = sub.status === 'canceled' || sub.status === 'incomplete_expired';
    await pool.query(
      `UPDATE users
          SET subscription_tier      = $1,
              subscription_status    = $2,
              stripe_subscription_id = $3,
              stripe_customer_id     = COALESCE(stripe_customer_id, $4),
              updated_at             = NOW()
        WHERE id = $5`,
      [tier, paid ? sub.status : 'active', ended ? null : sub.id, customerIdOf(sub), owner.appUser.id]
    );
    await setUserLimits(owner.appUser.id, tier);
  }

  if (owner.phoneLineId) {
    // Plan only: Stripe never changes phone sign-in (that's suspension, set by admins)
    const queued = await syncAccountToIvr(owner.phoneLineId, {
      subscription_tier: ivrTierName(tier),
      action: paid ? 'stripe_update' : 'stripe_cancelled',
    });
    if (queued === false) throw new Error('could not save the phone-line update for retrying');
  }

  if (!owner.appUser && !owner.phoneLineId) logger.warn(`Stripe: no app or phone-line account found for subscription ${sub.id}`);
  logger.info(`Stripe: subscription ${sub.id} (${sub.status}) -> ${tier}` +
    `${owner.appUser ? `, app user ${owner.appUser.id}` : ''}${owner.phoneLineId ? `, phone line ${owner.phoneLineId}` : ''}`);
  return { owner, tier, applied: true };
}

// ── Already-handled events (migration 023) ──────────────────────────────────

async function alreadyHandled(eventId) {
  try {
    return (await pool.query('SELECT 1 FROM stripe_events WHERE id = $1', [eventId])).rowCount > 0;
  } catch (e) {
    logger.warn(`stripe_events lookup failed (is migration 023 run?): ${e.message}`);
    return false;
  }
}
async function markHandled(event) {
  await pool.query('INSERT INTO stripe_events (id, type) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING', [event.id, event.type])
    .catch(e => logger.warn(`stripe_events insert failed (is migration 023 run?): ${e.message}`));
}

// ── Webhook ─────────────────────────────────────────────────────────────────

router.post('/', async (req, res) => {
  const stripe = getStripe();
  if (!stripe || !process.env.STRIPE_WEBHOOK_SECRET) {
    return res.status(503).json({ error: 'Stripe not configured' });
  }

  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, req.headers['stripe-signature'], process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    logger.warn(`Stripe webhook signature failed: ${err.message}`);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  try {
    if (await alreadyHandled(event.id)) return res.json({ received: true, duplicate: true });
    await handleEvent(stripe, event);
    await markHandled(event);
    res.json({ received: true });
  } catch (err) {
    // Not done: Stripe will send it again
    logger.error(`Stripe webhook ${event.type} failed, Stripe will retry: ${err.message}`, { eventId: event.id });
    res.status(500).json({ error: 'Processing failed' });
  }
});

async function handleEvent(stripe, event) {
  const obj = event.data.object;

  switch (event.type) {

    // ── Subscription started or changed (plan switch, status change, renewal) ─
    case 'customer.subscription.created':
    case 'customer.subscription.updated': {
      await applySubscription(await freshSubscription(stripe, obj));
      break;
    }

    // ── Subscription ended (cancelled by the customer, or Stripe gave up after failed payments) ─
    case 'customer.subscription.deleted': {
      const sub = await freshSubscription(stripe, obj);
      const before = await ownerOfSubscription(sub);
      let previousTier = before.appUser?.subscription_tier;
      if (!previousTier && before.viaPhone) {
        previousTier = normalizeTier((await phoneLineAccount(before.phoneLineId).catch(() => null))?.subscription_tier);
      }
      const { owner, applied } = await applySubscription({ ...sub, status: 'canceled' });
      if (!applied) break;

      const to = await contactFor(owner);
      if (to) {
        if (sub.cancellation_details?.reason === 'payment_failed') {
          await sendQuietly('plan ended', emailService.sendAccountSuspendedEmail(to.email, to.name, { phoneOnly: to.phoneOnly }));
        } else {
          await sendQuietly('cancellation', emailService.sendSubscriptionCancelledEmail(to.email, to.name, {
            tier: previousTier || tierOfSubscription(obj), accessUntilDate: formatDate(sub.current_period_end), phoneOnly: to.phoneOnly,
          }));
        }
      }
      break;
    }

    // ── Payment taken (first payment or monthly renewal) ─
    case 'invoice.payment_succeeded': {
      if (obj.amount_paid === 0) break;   // $0 invoices (trial starts)
      const sub = subscriptionIdOf(obj) ? await freshSubscription(stripe, subscriptionIdOf(obj)) : null;
      const owner = sub ? await ownerOfSubscription(sub) : await ownerOfSubscription({ id: null, customer: obj.customer, metadata: {} });
      if (sub && owner.appUser && await hasOtherBillingSubscription(owner.appUser, sub)) break;

      const tier = sub ? tierOfSubscription(sub) : (owner.appUser?.subscription_tier || TIERS.ESSENTIAL);
      if (owner.appUser && sub) {
        // Back to 'active' after a late payment
        await pool.query('UPDATE users SET subscription_status = $1, updated_at = NOW() WHERE id = $2',
          [PAID_STATUSES.includes(sub.status) ? sub.status : 'active', owner.appUser.id]);
      }
      if (owner.appUser) {
        // One local payment record per invoice, and a log line for admins
        await pool.query(
          `INSERT INTO billing_history (user_id, stripe_invoice_id, amount_cents, currency, description, status)
           SELECT $1, $2::VARCHAR, $3, $4, $5, 'paid'
           WHERE NOT EXISTS (SELECT 1 FROM billing_history WHERE stripe_invoice_id = $2::VARCHAR AND status = 'paid')`,
          [owner.appUser.id, obj.id, obj.amount_paid, (obj.currency || 'usd').toUpperCase(), `${tier} subscription payment`]
        );
        await pool.query(
          `INSERT INTO system_logs (user_id, level, service, message, metadata) VALUES ($1, 'info', 'billing', 'Payment received', $2)`,
          [owner.appUser.id, JSON.stringify({ invoiceId: obj.id, amount: obj.amount_paid, currency: obj.currency, tier })]
        ).catch(() => {});
      }

      const to = await contactFor(owner);
      if (to) {
        await sendQuietly('payment success', emailService.sendPaymentSuccessEmail(to.email, to.name, {
          amountPaid: obj.amount_paid, currency: obj.currency, tier,
          nextBillingDate: formatDate(sub?.current_period_end), phoneOnly: to.phoneOnly,
        }));
      }
      logger.info(`Invoice paid: ${obj.id}, ${obj.amount_paid} ${obj.currency}${owner.phoneLineId ? `, phone line ${owner.phoneLineId}` : ''}`);
      break;
    }

    // ── Payment failed (Stripe retries automatically; the plan is kept meanwhile) ─
    case 'invoice.payment_failed': {
      const sub = subscriptionIdOf(obj) ? await freshSubscription(stripe, subscriptionIdOf(obj)) : null;
      const owner = sub ? await ownerOfSubscription(sub) : await ownerOfSubscription({ id: null, customer: obj.customer, metadata: {} });
      if (sub && owner.appUser && await hasOtherBillingSubscription(owner.appUser, sub)) break;

      const nextRetry = obj.next_payment_attempt ? formatDate(obj.next_payment_attempt) : null;   // none = last try
      const attemptCount = obj.attempt_count || 1;

      if (owner.appUser) {
        await pool.query(
          `INSERT INTO system_logs (user_id, level, service, message, metadata) VALUES ($1, 'warning', 'billing', 'Invoice payment failed', $2)`,
          [owner.appUser.id, JSON.stringify({ invoiceId: obj.id, amount: obj.amount_due, attempt: attemptCount })]
        ).catch(() => {});
      }
      const to = await contactFor(owner);
      if (to) {
        await sendQuietly('payment failed', emailService.sendPaymentFailedEmail(to.email, to.name, {
          amountDue: obj.amount_due, currency: obj.currency, nextRetryDate: nextRetry, attemptCount,
          // No app account: Stripe's own page for this invoice, where they can pay with another card
          actionUrl: to.phoneOnly ? obj.hosted_invoice_url : undefined,
        }));
      }
      logger.warn(`Invoice payment failed: ${obj.id}, attempt ${attemptCount}${owner.phoneLineId ? `, phone line ${owner.phoneLineId}` : ''}`);
      break;
    }

    // ── Free trial ends in 3 days (phone-line Essential / Premium start with a trial) ─
    case 'customer.subscription.trial_will_end': {
      const sub = await freshSubscription(stripe, obj);
      if (!['trialing'].includes(sub.status)) break;
      const owner = await ownerOfSubscription(sub);
      if (owner.appUser && await hasOtherBillingSubscription(owner.appUser, sub)) break;
      const to = await contactFor(owner);
      if (!to) break;

      let cardOnFile = !!sub.default_payment_method;
      if (!cardOnFile && customerIdOf(sub)) {
        const customer = await stripe.customers.retrieve(customerIdOf(sub)).catch(() => null);
        cardOnFile = !!(customer?.invoice_settings?.default_payment_method || customer?.default_source);
      }
      await sendQuietly('trial ending', emailService.sendTrialEndingEmail(to.email, to.name, {
        trialEndDate: formatDate(sub.trial_end), tier: tierOfSubscription(sub), cardOnFile, phoneOnly: to.phoneOnly,
      }));
      break;
    }

    default:
      break;   // other events: acknowledged, nothing to do
  }
}

module.exports = router;
module.exports.handleEvent = handleEvent;   // for tests
