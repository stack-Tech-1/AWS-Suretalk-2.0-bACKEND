const { pool } = require('./config/database');

async function masterFix() {
  try {
    console.log('--- Starting Master Database Sync ---');

    // 1. Fix Users table: Convert all admin-related IDs to UUID
    console.log('Syncing "users" table columns...');
    await pool.query(`
      ALTER TABLE users 
      ALTER COLUMN requested_by_admin_id TYPE UUID USING requested_by_admin_id::text::uuid,
      ALTER COLUMN approved_by_admin_id TYPE UUID USING approved_by_admin_id::text::uuid,
      ALTER COLUMN rejected_by_admin_id TYPE UUID USING rejected_by_admin_id::text::uuid;
    `);

    // 2. Fix System Logs: Ensure user_id is a UUID to allow JOINs
    console.log('Syncing "system_logs" table columns...');
    await pool.query(`
      ALTER TABLE system_logs 
      ALTER COLUMN user_id TYPE UUID USING user_id::text::uuid;
    `);

    // 3. Optional: Ensure indexes exist for performance on these joins
    console.log('Creating performance indexes...');
    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_users_requested_by ON users(requested_by_admin_id);
      CREATE INDEX IF NOT EXISTS idx_system_logs_user_id ON system_logs(user_id);
    `);

    console.log('✅ Success! All data types are now synchronized as UUID.');
    process.exit(0);
  } catch (err) {
    console.error('❌ Master Sync Failed:', err);
    console.error('Note: If columns were already empty or didn\'t exist, you may need to run your "fix-db.js" first.');
    process.exit(1);
  }
}

masterFix();