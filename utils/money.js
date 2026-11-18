// utils/money.js — Stripe and billing_history hold amounts in cents (1299 = $12.99).
// Anything shown to a person goes through here, so a cents figure is never displayed as dollars.
const formatCents = (cents, currency = 'USD') =>
  new Intl.NumberFormat('en-US', { style: 'currency', currency: String(currency).toUpperCase() }).format((cents || 0) / 100);

module.exports = { formatCents };
