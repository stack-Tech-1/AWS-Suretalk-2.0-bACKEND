// scripts/updateUserLimits.js
// Re-applies each account's plan limits from utils/planLimits.js (same as migration 019).
const { pool } = require('../config/database');
const { PLAN_LIMITS } = require('../utils/planLimits');

async function updateUserLimits() {
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    console.log('Updating user limits based on subscription tier...');

    for (const [tier, l] of Object.entries(PLAN_LIMITS)) {
      const tiers = tier === 'LEGACY_VAULT_PREMIUM' ? ['LEGACY_VAULT_PREMIUM', 'PREMIUM'] : [tier];
      const where = tier === 'LITE'
        ? `COALESCE(subscription_tier, 'LITE') NOT IN ('ESSENTIAL', 'LEGACY_VAULT_PREMIUM', 'PREMIUM')`
        : 'subscription_tier = ANY($3::text[])';
      await client.query(
        `UPDATE users SET contacts_limit = $1, voice_notes_limit = $2 WHERE ${where}`,
        tier === 'LITE' ? [l.contacts, l.voiceNotes] : [l.contacts, l.voiceNotes, tiers]
      );
      console.log(`✓ Updated ${tier} users (${l.contacts} contacts, ${l.voiceNotes} voice notes)`);
    }

    await client.query('COMMIT');
    console.log('✅ User limits updated successfully');

  } catch (error) {
    await client.query('ROLLBACK');
    console.error('❌ Failed to update user limits:', error);
    throw error;
  } finally {
    client.release();
  }
}

// Run if called directly
if (require.main === module) {
  updateUserLimits()
    .then(() => {
      console.log('User limits migration complete!');
      process.exit(0);
    })
    .catch((error) => {
      console.error('Failed to migrate user limits:', error);
      process.exit(1);
    });
}

module.exports = { updateUserLimits };
