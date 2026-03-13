// Canonical internal tier names (stored in DB and used throughout the app)
const TIERS = {
  LITE:      'LITE',
  ESSENTIAL: 'ESSENTIAL',
  PREMIUM:   'LEGACY_VAULT_PREMIUM'
};

/**
 * Normalize any tier string variant to the canonical internal name.
 * 'PREMIUM', 'premium', 'Legacy_Vault_Premium', 'LEGACY_VAULT_PREMIUM' → 'LEGACY_VAULT_PREMIUM'
 * Pass-through for LITE and ESSENTIAL. Defaults to LITE on unknown input.
 */
function normalizeTier(tier) {
  if (!tier) return TIERS.LITE;
  const upper = tier.toUpperCase().replace(/-/g, '_');
  if (upper === 'LEGACY_VAULT_PREMIUM' || upper === 'PREMIUM') return TIERS.PREMIUM;
  if (upper === 'ESSENTIAL') return TIERS.ESSENTIAL;
  if (upper === 'LITE') return TIERS.LITE;
  return TIERS.LITE;
}

/**
 * Map internal tier name to what the IVR API expects.
 * IVR uses short names: 'LITE', 'ESSENTIAL', 'PREMIUM'
 */
function ivrTierName(internalTier) {
  if (internalTier === TIERS.PREMIUM) return 'PREMIUM';
  if (internalTier === TIERS.ESSENTIAL) return 'ESSENTIAL';
  return 'LITE';
}

module.exports = { TIERS, normalizeTier, ivrTierName };
