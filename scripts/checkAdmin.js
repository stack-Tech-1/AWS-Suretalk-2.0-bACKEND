// C:\Users\SMC\Documents\GitHub\AWS-Suretalk-2.0-bACKEND\scripts\checkAdmin.js
const { pool } = require('../config/database');

async function checkAdmin() {
  try {
    console.log('Checking admin user...');
    
    // Check if admin exists
    const result = await pool.query(
      "SELECT id, email, is_admin, subscription_tier FROM users WHERE email = 'admin@suretalk.com'"
    );
    
    if (result.rows.length === 0) {
      console.log('❌ Admin user not found');
      return;
    }
    
    const admin = result.rows[0];
    console.log('✅ Admin user found:');
    console.log('  Email:', admin.email);
    console.log('  ID:', admin.id);
    console.log('  is_admin:', admin.is_admin);
    console.log('  Tier:', admin.subscription_tier);
    
    // Check if is_admin column exists
    const columns = await pool.query(`
      SELECT column_name 
      FROM information_schema.columns 
      WHERE table_name = 'users' 
      AND column_name = 'is_admin'
    `);
    
    if (columns.rows.length === 0) {
      console.log('❌ is_admin column does not exist in users table');
    } else {
      console.log('✅ is_admin column exists');
    }
    
  } catch (error) {
    console.error('Error:', error);
  }
}

checkAdmin().then(() => process.exit(0));