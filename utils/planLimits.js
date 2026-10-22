// utils/planLimits.js — the ONE place plan limits live. Every route, the Stripe webhook and the
// phone-line sync read from here, and the phone line (Lambdas) uses the same numbers.
//
// A "slot" is one keypad position on the phone line (press 1–9): a contact plus their voice note.
// Voice notes = slots, so every note in the app also has a home on the phone line.
// Voice wills (Premium) have their own keypad positions: 3, each recording up to WILL_MAX_SECONDS long.
//
// Over the limit (e.g. after a downgrade): nothing is deleted. Existing items can still be played,
// edited and deleted, but nothing new can be added until the person is back under the limit.
const { TIERS, normalizeTier } = require('./tierMapping');

const PLAN_LIMITS = {
  [TIERS.LITE]:      { slots: 3, contacts: 3, voiceNotes: 3, wills: 0, storageGb: 1,  price: 0 },
  [TIERS.ESSENTIAL]: { slots: 9, contacts: 9, voiceNotes: 9, wills: 0, storageGb: 5,  price: 6.99 },
  [TIERS.PREMIUM]:   { slots: 9, contacts: 9, voiceNotes: 9, wills: 3, storageGb: 50, price: 12.99 },
};

const limitsFor = (tier) => PLAN_LIMITS[normalizeTier(tier)];

// What an account may hold: the stored per-account value (admins can set it lower), never above the plan
const effectiveLimit = (tier, kind, stored) => {
  const plan = limitsFor(tier)[kind];
  const n = Number(stored);
  return stored === null || stored === undefined || !Number.isFinite(n) ? plan : Math.min(n, plan);
};

// Voice wills: message to show when the person can't add another, or null when there's room
async function willLimitError(pool, userId, tier) {
  const max = limitsFor(tier).wills;
  const n = (await pool.query(
    'SELECT COUNT(*)::int AS n FROM voice_wills WHERE user_id = $1 AND deleted_at IS NULL AND admin_removed_at IS NULL',
    [userId]
  )).rows[0].n;
  if (n < max) return null;
  if (max === 0) return 'Voice wills are part of Legacy Vault Premium.';
  return n > max
    ? `You have ${n} voice wills and your plan allows ${max}. They are kept, but delete ${n - max + 1} to add a new one.`
    : `Voice will limit reached (${max} on your plan). Delete one to add another.`;
}

// A voice will recording can be up to 5 minutes long (the phone line stops will recordings at 5 minutes too)
const WILL_MAX_SECONDS = 300;

module.exports = { PLAN_LIMITS, limitsFor, effectiveLimit, willLimitError, WILL_MAX_SECONDS };
