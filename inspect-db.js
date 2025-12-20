// check-users-data.js
const { pool } = require('./config/database');

async function checkUsersData() {
  try {
    console.log('\x1b[36m%s\x1b[0m', '=== SURETALK 2.0 USER & ADMIN AUDIT ===\n');

    // 1. See all users and their admin status
    console.log('--- All Registered Users ---');
    const users = await pool.query(`
      SELECT 
        id, 
        full_name, 
        email, 
        is_admin, 
        admin_status, 
        subscription_tier 
      FROM users 
      ORDER BY created_at DESC;
    `);
    console.table(users.rows);

    // 2. See specifically who is "Pending" admin approval
    // Based on your columns, this is your "Admin Requests" data
    console.log('\n--- Pending Admin Requests (Users with admin_status) ---');
    const pending = await pool.query(`
      SELECT 
        id, 
        full_name, 
        email, 
        admin_status, 
        admin_department, 
        admin_reason 
      FROM users 
      WHERE admin_status IS NOT NULL AND admin_status != 'approved';
    `);
    
    if (pending.rows.length === 0) {
      console.log('No pending admin requests found in the users table.');
    } else {
      console.table(pending.rows);
    }

    process.exit(0);
  } catch (err) {
    console.error('❌ Error reading data:', err.message);
    process.exit(1);
  }
}

checkUsersData();