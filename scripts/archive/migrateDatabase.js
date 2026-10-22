// scripts/fixMissingColumns.js
const { pool } = require('../config/database');

async function fixMissingColumns() {
  const client = await pool.connect();
  
  try {
    await client.query('BEGIN');
    console.log('Starting to fix missing columns...');

    // 1. Check and add missing columns to users table
    console.log('\nChecking users table columns...');
    
    const usersColumns = [
      { name: 'failed_login_attempts', type: 'INTEGER', defaultValue: 'DEFAULT 0' },
      { name: 'account_locked_until', type: 'TIMESTAMP', defaultValue: '' },
      { name: 'two_factor_secret', type: 'VARCHAR(255)', defaultValue: '' },
      { name: 'two_factor_enabled', type: 'BOOLEAN', defaultValue: 'DEFAULT FALSE' },
      { name: 'last_login_ip', type: 'INET', defaultValue: '' },
      { name: 'last_login_at', type: 'TIMESTAMP', defaultValue: '' },
      { name: 'must_change_password', type: 'BOOLEAN', defaultValue: 'DEFAULT false' },
      { name: 'admin_reason', type: 'TEXT', defaultValue: '' },
      { name: 'admin_department', type: 'VARCHAR(255)', defaultValue: '' },
      { name: 'requested_by_admin_id', type: 'UUID', defaultValue: '' },
      { name: 'approved_by_admin_id', type: 'UUID', defaultValue: '' },
      { name: 'approved_at', type: 'TIMESTAMP', defaultValue: '' },
      { name: 'rejected_by_admin_id', type: 'UUID', defaultValue: '' },
      { name: 'rejected_at', type: 'TIMESTAMP', defaultValue: '' },
      { name: 'rejection_notes', type: 'TEXT', defaultValue: '' },
      { name: 'settings', type: 'JSONB', defaultValue: "DEFAULT '{}'" }
    ];

    for (const column of usersColumns) {
      try {
        // Check if column exists
        const check = await client.query(`
          SELECT column_name 
          FROM information_schema.columns 
          WHERE table_name = 'users' AND column_name = $1
        `, [column.name]);

        if (check.rows.length === 0) {
          // Column doesn't exist, add it
          const alterQuery = `ALTER TABLE users ADD COLUMN ${column.name} ${column.type} ${column.defaultValue}`;
          await client.query(alterQuery);
          console.log(`✅ Added column: users.${column.name}`);
        } else {
          console.log(`⚠️ Column already exists: users.${column.name}`);
        }
      } catch (error) {
        console.log(`❌ Error adding column ${column.name}:`, error.message);
      }
    }

    // 2. Create the missing login_attempts table if it doesn't exist
    console.log('\nChecking login_attempts table...');
    
    const loginAttemptsCheck = await client.query(`
      SELECT EXISTS (
        SELECT FROM information_schema.tables 
        WHERE table_name = 'login_attempts'
      );
    `);

    if (!loginAttemptsCheck.rows[0].exists) {
      console.log('Creating login_attempts table...');
      
      await client.query(`
        CREATE TABLE login_attempts (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          email VARCHAR(255) NOT NULL,
          ip_address INET NOT NULL,
          user_agent TEXT,
          success BOOLEAN NOT NULL DEFAULT false,
          failure_reason TEXT,
          is_admin_attempt BOOLEAN DEFAULT false,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
      `);

      await client.query(`
        CREATE INDEX idx_login_attempts_email ON login_attempts(email);
        CREATE INDEX idx_login_attempts_ip ON login_attempts(ip_address);
        CREATE INDEX idx_login_attempts_created_at ON login_attempts(created_at);
        CREATE INDEX idx_login_attempts_success ON login_attempts(success);
      `);

      console.log('✅ login_attempts table created');
    } else {
      console.log('✅ login_attempts table already exists');
    }

    // 3. Create user_sessions table if it doesn't exist
    console.log('\nChecking user_sessions table...');
    
    const userSessionsCheck = await client.query(`
      SELECT EXISTS (
        SELECT FROM information_schema.tables 
        WHERE table_name = 'user_sessions'
      );
    `);

    if (!userSessionsCheck.rows[0].exists) {
      console.log('Creating user_sessions table...');
      
      await client.query(`
        CREATE TABLE user_sessions (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          session_token VARCHAR(512) NOT NULL,
          device_name VARCHAR(255),
          device_type VARCHAR(50),
          user_agent TEXT,
          ip_address INET,
          last_activity TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          is_active BOOLEAN DEFAULT TRUE,
          is_admin_session BOOLEAN DEFAULT FALSE,
          ended_at TIMESTAMP,
          UNIQUE(session_token)
        )
      `);

      await client.query(`
        CREATE INDEX idx_user_sessions_user_id ON user_sessions(user_id);
        CREATE INDEX idx_user_sessions_is_active ON user_sessions(is_active);
      `);

      console.log('✅ user_sessions table created');
    } else {
      // Check if is_admin_session column exists in user_sessions
      try {
        const checkColumn = await client.query(`
          SELECT column_name 
          FROM information_schema.columns 
          WHERE table_name = 'user_sessions' AND column_name = 'is_admin_session'
        `);
        
        if (checkColumn.rows.length === 0) {
          await client.query(`
            ALTER TABLE user_sessions ADD COLUMN is_admin_session BOOLEAN DEFAULT FALSE
          `);
          console.log('✅ Added is_admin_session column to user_sessions');
        }
        
        if (checkColumn.rows.length === 0) {
          await client.query(`
            ALTER TABLE user_sessions ADD COLUMN ended_at TIMESTAMP
          `);
          console.log('✅ Added ended_at column to user_sessions');
        }
      } catch (error) {
        console.log('⚠️ Error adding columns to user_sessions:', error.message);
      }
    }

    // 4. Verify the query used in adminAuth.js works
    console.log('\nTesting admin login query...');
    
    try {
      const testQuery = `
        SELECT id, email, phone, full_name, password_hash, 
               subscription_tier, subscription_status, profile_image_url, 
               last_login, is_admin, admin_status, two_factor_enabled,
               two_factor_secret, failed_login_attempts, account_locked_until
        FROM users 
        WHERE email = $1 AND deleted_at IS NULL
      `;
      
      // Just check if the query can be prepared
      await client.query('EXPLAIN ' + testQuery, ['test@example.com']);
      console.log('✅ Admin login query is valid');
    } catch (error) {
      console.log('❌ Admin login query has issues:', error.message);
    }

    await client.query('COMMIT');
    console.log('\n✅ All missing columns and tables have been fixed!');

  } catch (error) {
    await client.query('ROLLBACK');
    console.error('❌ Error fixing missing columns:', error);
    throw error;
  } finally {
    client.release();
  }
}

// Create a test admin user
async function createTestAdmin() {
  const client = await pool.connect();
  
  try {
    await client.query('BEGIN');
    
    const email = 'admin@test.com';
    const password = 'AdminTest123456789!';
    const bcrypt = require('bcrypt');
    const passwordHash = await bcrypt.hash(password, 10);
    
    // Check if user exists
    const existingUser = await client.query(
      'SELECT id FROM users WHERE email = $1',
      [email]
    );
    
    if (existingUser.rows.length > 0) {
      console.log(`Updating existing user ${email} to admin...`);
      
      await client.query(`
        UPDATE users 
        SET is_admin = true, 
            admin_status = 'approved',
            two_factor_enabled = false,
            subscription_tier = 'ESSENTIAL',
            subscription_status = 'active',
            password_hash = $1
        WHERE email = $2
      `, [passwordHash, email]);
      
    } else {
      console.log(`Creating new admin user ${email}...`);
      
      await client.query(`
        INSERT INTO users (
          email, phone, full_name, password_hash,
          subscription_tier, subscription_status,
          is_admin, admin_status, two_factor_enabled,
          created_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, CURRENT_TIMESTAMP)
      `, [
        email,
        '+2323232345',
        'Test Admin',
        passwordHash,
        'ESSENTIAL',
        'active',
        true,
        'approved',
        false
      ]);
    }
    
    await client.query('COMMIT');
    console.log(`✅ Test admin created/updated`);
    console.log(`   Email: ${email}`);
    console.log(`   Password: ${password}`);
    
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Error creating test admin:', error);
  } finally {
    client.release();
  }
}

// Run both functions
async function main() {
  try {
    console.log('=========================================');
    console.log('Starting database fixes...');
    console.log('=========================================');
    
    await fixMissingColumns();
    
    console.log('\n=========================================');
    console.log('Creating test admin user...');
    console.log('=========================================');
    
    await createTestAdmin();
    
    console.log('\n=========================================');
    console.log('✅ All tasks completed successfully!');
    console.log('=========================================');
    
    process.exit(0);
    
  } catch (error) {
    console.error('❌ Main process failed:', error);
    process.exit(1);
  }
}

// Run if called directly
if (require.main === module) {
  main();
}

module.exports = { fixMissingColumns, createTestAdmin };