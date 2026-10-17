// Revenue for the admin dashboard, read from Stripe (the source of truth for payments).
// Falls back to the billing_history table if Stripe isn't configured or can't be reached.
const { pool } = require('../config/database');

const CACHE_MS = 5 * 60 * 1000;
const MONTHS = 6;
let cached = null;

// Last 6 calendar months (UTC), oldest first: [{ key: '2026-05', label: 'May', start: Date }]
function monthBuckets(now = new Date()) {
  const buckets = [];
  for (let i = MONTHS - 1; i >= 0; i--) {
    const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
    buckets.push({
      key: start.toISOString().slice(0, 7),
      label: start.toLocaleString('en-US', { month: 'short', timeZone: 'UTC' }),
      start
    });
  }
  return buckets;
}

// payments: [{ amountCents, date }] → monthly totals + month-to-date comparison
function summarize(payments, source, now = new Date()) {
  const buckets = monthBuckets(now);
  const byMonth = Object.fromEntries(buckets.map(b => [b.key, { cents: 0, count: 0 }]));
  const thisMonthStart = buckets[buckets.length - 1].start;
  const lastMonthStart = buckets[buckets.length - 2].start;
  // Same point in last month (e.g. the 1st–16th) so the comparison is fair mid-month
  const lastMonthSamePoint = new Date(lastMonthStart.getTime() + (now - thisMonthStart));
  let lastMonthToDateCents = 0;

  for (const p of payments) {
    const key = p.date.toISOString().slice(0, 7);
    if (byMonth[key]) {
      byMonth[key].cents += p.amountCents;
      byMonth[key].count += 1;
    }
    if (p.date >= lastMonthStart && p.date < lastMonthSamePoint) lastMonthToDateCents += p.amountCents;
  }

  const current = byMonth[buckets[buckets.length - 1].key];
  const lastMonth = byMonth[buckets[buckets.length - 2].key];
  return {
    source,
    current_month_revenue: current.cents / 100,
    transaction_count: current.count,
    last_month_revenue: lastMonth.cents / 100,
    last_month_to_date_revenue: lastMonthToDateCents / 100,
    monthly: buckets.map(b => ({
      key: b.key,
      month: b.label,
      revenue: byMonth[b.key].cents / 100,
      transactions: byMonth[b.key].count
    }))
  };
}

async function fromStripe(since) {
  const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
  const payments = [];
  const otherCurrencies = new Set();
  for await (const invoice of stripe.invoices.list({
    status: 'paid',
    created: { gte: Math.floor(since.getTime() / 1000) },
    limit: 100
  })) {
    if (!invoice.amount_paid) continue;
    if (invoice.currency !== 'usd') { otherCurrencies.add(invoice.currency.toUpperCase()); continue; }
    const paidAt = invoice.status_transitions?.paid_at || invoice.created;
    payments.push({ amountCents: invoice.amount_paid, date: new Date(paidAt * 1000) });
  }
  return { payments, otherCurrencies: [...otherCurrencies] };
}

async function fromDatabase(since) {
  const result = await pool.query(
    `SELECT amount_cents, created_at FROM billing_history
     WHERE status IN ('paid', 'succeeded') AND amount_cents > 0
       AND UPPER(COALESCE(currency, 'USD')) = 'USD' AND created_at >= $1`,
    [since]
  );
  return result.rows.map(r => ({ amountCents: Number(r.amount_cents), date: new Date(r.created_at) }));
}

async function getRevenueStats() {
  if (cached && Date.now() - cached.at < CACHE_MS) return cached.data;
  const since = monthBuckets()[0].start;
  let data;
  if (process.env.STRIPE_SECRET_KEY) {
    try {
      const { payments, otherCurrencies } = await fromStripe(since);
      data = { ...summarize(payments, 'stripe'), other_currencies: otherCurrencies };
    } catch (error) {
      console.error('Stripe revenue fetch failed, using billing_history:', error.message);
    }
  }
  if (!data) data = { ...summarize(await fromDatabase(since), 'database'), other_currencies: [] };
  cached = { at: Date.now(), data };
  return data;
}

module.exports = { getRevenueStats, summarize, monthBuckets };
