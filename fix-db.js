// fix-db.js
const { pool } = require('./config/database'); 

async function addColumn() {
  try {
    console.log('Adding admin_status column...');
    await pool.query(`
      ALTER TABLE users 
      ADD COLUMN IF NOT EXISTS admin_status VARCHAR(20) DEFAULT 'none';
    `);
    console.log('✅ Success! Column added.');
    
    // Optional: Set your existing admin to 'approved'
    console.log('Setting existing admins to approved...');
    await pool.query(`
      UPDATE users SET admin_status = 'approved' WHERE is_admin = true;
    `);
    console.log('✅ Success! Existing admins updated.');
    
    process.exit(0);
  } catch (err) {
    console.error('❌ Error updating database:', err);
    process.exit(1);
  }
}

addColumn();