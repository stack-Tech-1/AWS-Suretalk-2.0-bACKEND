// scripts/addEmailVerifiedColumn.js
const { pool } = require('../config/database');

async function addEmailVerifiedColumn() {
  const client = await pool.connect();
  
  try {
    await client.query('BEGIN');
    
    console.log('Adding email_verified column to users table...');
    
    // Add the column
    await client.query(`
      ALTER TABLE users 
      ADD COLUMN IF NOT EXISTS email_verified BOOLEAN DEFAULT FALSE,
      ADD COLUMN IF NOT EXISTS phone_verified BOOLEAN DEFAULT FALSE,
      ADD COLUMN IF NOT EXISTS two_factor_enabled BOOLEAN DEFAULT FALSE;
    `);
    
    // Update existing users to have email_verified = true (for testing)
    await client.query(`
      UPDATE users 
      SET email_verified = true 
      WHERE email_verified IS NULL;
    `);
    
    await client.query('COMMIT');
    console.log('✅ Successfully added email_verified column!');
    
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('❌ Failed to add column:', error.message);
    throw error;
  } finally {
    client.release();
  }
}

// Run if called directly
if (require.main === module) {
  addEmailVerifiedColumn()
    .then(() => {
      console.log('Migration complete!');
      process.exit(0);
    })
    .catch(error => {
      console.error('Migration failed:', error);
      process.exit(1);
    });
}

module.exports = { addEmailVerifiedColumn };