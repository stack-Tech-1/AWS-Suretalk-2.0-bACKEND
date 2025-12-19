// C:\Users\SMC\Documents\GitHub\AWS-Suretalk-2.0-bACKEND\scripts\seed.js
const bcrypt = require('bcrypt');
const { pool } = require('../config/database');

async function seedAdmin() {
  try {
    console.log('Seeding admin user...');

    // Check if admin already exists
    const adminCheck = await pool.query(
      "SELECT id FROM users WHERE email = 'admin@suretalk.com'"
    );

    if (adminCheck.rows.length > 0) {
      console.log('Admin user already exists');
      return;
    }

    // Hash password
    const passwordHash = await bcrypt.hash('Admin123!', 10);

    // Create admin user
    await pool.query(
      `INSERT INTO users (
        email, phone, full_name, password_hash, 
        subscription_tier, is_admin, admin_status, storage_limit_gb
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        'admin@suretalk.com',
        '+1234567890',
        'System Admin',
        passwordHash,
        'LEGACY_VAULT_PREMIUM',
        true,
        'approved',
        1000
      ]
    );    


    console.log('Admin user created successfully!');
    console.log('Email: admin@suretalk.com');
    console.log('Password: Admin123!');

  } catch (error) {
    console.error('Error seeding admin:', error);
  }
}

// Run if called directly
if (require.main === module) {
  seedAdmin()
    .then(() => {
      console.log('Seed complete!');
      process.exit(0);
    })
    .catch((error) => {
      console.error('Failed to seed:', error);
      process.exit(1);
    });
}

module.exports = { seedAdmin };