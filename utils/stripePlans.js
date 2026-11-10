// utils/stripePlans.js — who a Stripe subscription belongs to, and which plan it gives.
//
// Subscriptions come from two places, both on the same Stripe account:
//   - the app (Checkout): metadata.userId = the app's user id (uuid)
//   - the phone line (card taken on a call, by the phone server): metadata.userId = the caller's
//     phone-line id, which is their phone number (e.g. "+14045550123")
// A phone-line customer may or may not also have an app account.
const https = require('https');
const Stripe = require('stripe');
const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, GetCommand } = require('@aws-sdk/lib-dynamodb');
const { pool } = require('../config/database');
const { TIERS, normalizeTier } = require('./tierMapping');

let stripeClient;
const getStripe = () => {
  if (!stripeClient && process.env.STRIPE_SECRET_KEY) {
    stripeClient = new Stripe(process.env.STRIPE_SECRET_KEY, {
      httpAgent: new https.Agent({ keepAlive: true, keepAliveMsecs: 60_000 }),
    });
  }
  return stripeClient || null;
};

let doc;
const dynamo = () => {
  if (!doc) {
    doc = DynamoDBDocumentClient.from(new DynamoDBClient({
      region: process.env.IVR_AWS_REGION || 'eu-central-1',
      credentials: process.env.AWS_ACCESS_KEY_ID
        ? { accessKeyId: process.env.AWS_ACCESS_KEY_ID, secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY }
        : undefined,
      maxAttempts: 3,
    }));
  }
  return doc;
};

// Statuses that keep the paid plan. Anything else means the free Lite plan (account stays usable).
const PAID_STATUSES = ['active', 'trialing', 'past_due'];

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isAppUserId = (v) => UUID.test(String(v || ''));
const isPhoneLineId = (v) => /^\+?[0-9]{7,15}$/.test(String(v || '').trim());

// Same number written different ways (+1 or not, dashes) -> one key (matches the nightly check)
const phoneKey = (phone) => {
  let d = String(phone || '').replace(/[^0-9]/g, '');
  if (d.length === 11 && d.startsWith('1')) d = d.slice(1);
  return d;
};

const priceTiers = () => ({
  [process.env.NEXT_PUBLIC_STRIPE_LITE_PRICE_ID]:      TIERS.LITE,
  [process.env.NEXT_PUBLIC_STRIPE_ESSENTIAL_PRICE_ID]: TIERS.ESSENTIAL,
  [process.env.NEXT_PUBLIC_STRIPE_PREMIUM_PRICE_ID]:   TIERS.PREMIUM,
});

// The plan a subscription gives right now (app tier names). Price decides; the phone server's
// metadata.tier is only used for a price this backend doesn't know.
function tierOfSubscription(sub) {
  if (!sub || !PAID_STATUSES.includes(sub.status)) return TIERS.LITE;
  const price = sub.items?.data?.[0]?.price?.id;
  const known = priceTiers()[price];
  if (known) return known;
  return sub.metadata?.tier ? normalizeTier(String(sub.metadata.tier)) : TIERS.LITE;
}

const APP_USER_COLS = 'id, email, full_name, phone, subscription_tier, stripe_customer_id, stripe_subscription_id';

async function appUserById(id) {
  const r = await pool.query(`SELECT ${APP_USER_COLS} FROM users WHERE id = $1 AND deleted_at IS NULL`, [id]);
  return r.rows[0] || null;
}
async function appUserByCustomer(customerId) {
  if (!customerId) return null;
  const r = await pool.query(`SELECT ${APP_USER_COLS} FROM users WHERE stripe_customer_id = $1 AND deleted_at IS NULL LIMIT 1`, [customerId]);
  return r.rows[0] || null;
}
async function appUserByPhone(phone) {
  const key = phoneKey(phone);
  if (key.length < 7) return null;
  const r = await pool.query(
    `SELECT ${APP_USER_COLS} FROM users
     WHERE deleted_at IS NULL AND phone IS NOT NULL
       AND (CASE WHEN length(regexp_replace(phone, '[^0-9]', '', 'g')) = 11 AND regexp_replace(phone, '[^0-9]', '', 'g') LIKE '1%'
                 THEN substr(regexp_replace(phone, '[^0-9]', '', 'g'), 2)
                 ELSE regexp_replace(phone, '[^0-9]', '', 'g') END) = $1
     ORDER BY created_at LIMIT 1`,
    [key]
  );
  return r.rows[0] || null;
}

// The phone-line record for a phone-line id (exact key), or null
async function phoneLineAccount(phoneLineId) {
  if (!phoneLineId) return null;
  const r = await dynamo().send(new GetCommand({
    TableName: process.env.DYNAMO_USERS_TABLE || 'Users',
    Key: { userId: phoneLineId },
    ProjectionExpression: 'userId, email, firstName, subscription_tier, stripeSubscriptionId, verified',
  }));
  return r.Item || null;
}

/**
 * Who a subscription belongs to.
 * Returns { appUser, phoneLineId, viaPhone } (any part may be null):
 *   appUser     - the app account linked to it, or null (phone-only customer / unknown)
 *   phoneLineId - the phone-line id to update (a phone subscription's own id, else the app user's phone)
 *   viaPhone    - true when the subscription was taken on the phone line
 */
async function ownerOfSubscription(sub) {
  const stripe = getStripe();
  const customerId = typeof sub.customer === 'string' ? sub.customer : sub.customer?.id;
  let metaId = sub.metadata?.userId;

  if (!metaId && customerId && stripe) {
    try {
      const customer = typeof sub.customer === 'object' && sub.customer.metadata ? sub.customer : await stripe.customers.retrieve(customerId);
      metaId = customer?.metadata?.userId;
    } catch (e) {
      if (e.code !== 'resource_missing') throw e;
    }
  }

  if (isAppUserId(metaId)) {
    const appUser = await appUserById(metaId);
    return { appUser, phoneLineId: appUser?.phone || null, viaPhone: false };
  }
  if (isPhoneLineId(metaId)) {
    const phoneLineId = String(metaId).trim();
    return { appUser: await appUserByPhone(phoneLineId), phoneLineId, viaPhone: true };
  }
  const appUser = await appUserByCustomer(customerId);
  return { appUser, phoneLineId: appUser?.phone || null, viaPhone: false };
}

// Statuses where Stripe is still trying to charge (a second subscription would double-bill)
const BILLING_STATUSES = ['active', 'trialing', 'past_due', 'unpaid'];

// Does this app account have a DIFFERENT subscription that is still billing? Then that one is in
// charge of the account, and events for `sub` (an older one ending, or a second one) must not touch it.
async function hasOtherBillingSubscription(appUser, sub) {
  const other = appUser?.stripe_subscription_id;
  if (!other || other === sub.id) return false;
  try {
    const s = await getStripe().subscriptions.retrieve(other);
    return BILLING_STATUSES.includes(s.status);
  } catch (e) {
    if (e.code === 'resource_missing') return false;
    throw e;
  }
}

module.exports = {
  getStripe, PAID_STATUSES, BILLING_STATUSES, tierOfSubscription, ownerOfSubscription, phoneLineAccount,
  hasOtherBillingSubscription,
  isAppUserId, isPhoneLineId, phoneKey, appUserByPhone,
};
