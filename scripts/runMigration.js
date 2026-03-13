require('dotenv').config();
const fs   = require('fs');
const path = require('path');
const { pool } = require('../config/database');

const MIGRATION_FILE = path.join(__dirname, 'migrations', '002_phone_otps_table.sql');

async function runMigration() {
  const sql = fs.readFileSync(MIGRATION_FILE, 'utf8');
  const client = await pool.connect();

  try {
    await client.query('BEGIN');
    console.log(`Running migration: ${path.basename(MIGRATION_FILE)}`);
    await client.query(sql);
    await client.query('COMMIT');
    console.log('✅ Migration complete');
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('❌ Migration failed:', error);
    throw error;
  } finally {
    client.release();
  }
}

runMigration()
  .then(() => process.exit(0))
  .catch(() => process.exit(1));
