// scripts/updateUserLimits.js
const { pool } = require('../config/database');

async function updateUserLimits() {
  const client = await pool.connect();
  
  try {
    await client.query('BEGIN');
    
    console.log('Updating user limits based on subscription tier...');
    
    // Update Lite users
    await client.query(`
      UPDATE users 
      SET contacts_limit = 3
      WHERE subscription_tier = 'LITE' 
        AND (contacts_limit IS NULL OR contacts_limit != 3)
    `);
    console.log('✓ Updated LITE users');
    
    // Update Essential users
    await client.query(`
      UPDATE users 
      SET contacts_limit = 9
      WHERE subscription_tier = 'ESSENTIAL' 
        AND (contacts_limit IS NULL OR contacts_limit != 9)
    `);
    console.log('✓ Updated ESSENTIAL users');
    
    // Update Premium users
    await client.query(`
      UPDATE users 
      SET contacts_limit = 15
      WHERE subscription_tier = 'PREMIUM' 
        AND (contacts_limit IS NULL OR contacts_limit != 15)
    `);
    console.log('✓ Updated PREMIUM users');
    
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