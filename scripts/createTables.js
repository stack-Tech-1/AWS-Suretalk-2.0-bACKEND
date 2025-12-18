// C:\Users\SMC\Documents\GitHub\AWS-Suretalk-2.0-bACKEND\scripts\createTables.js
const { pool } = require('../config/database');

async function createTables() {
  try {
    console.log('Creating database tables...');

    // 1. Create users table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS users (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        email VARCHAR(255) UNIQUE NOT NULL,
        phone VARCHAR(50) UNIQUE NOT NULL,
        full_name VARCHAR(255) NOT NULL,
        password_hash VARCHAR(255) NOT NULL,

        subscription_tier VARCHAR(50) DEFAULT 'ESSENTIAL',
        subscription_status VARCHAR(50) DEFAULT 'active',

        storage_limit_gb INTEGER DEFAULT 5,
        contacts_limit INTEGER DEFAULT 9,
        voice_notes_limit INTEGER DEFAULT 100,

        stripe_customer_id VARCHAR(255),
        stripe_subscription_id VARCHAR(255),

        profile_image_url TEXT,
        is_admin BOOLEAN DEFAULT FALSE,

        last_login TIMESTAMP,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        deleted_at TIMESTAMP
      )
    `);

    // 2. Create contacts table (FIXED: Removed the UNIQUE...WHERE line)
    await pool.query(`
      CREATE TABLE IF NOT EXISTS contacts (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,

        name VARCHAR(255) NOT NULL,
        phone VARCHAR(50) NOT NULL,
        email VARCHAR(255),

        relationship VARCHAR(100),
        is_beneficiary BOOLEAN DEFAULT FALSE,
        can_receive_messages BOOLEAN DEFAULT TRUE,
        notes TEXT,

        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(user_id, phone)
      )
    `);

    // Create voice_notes table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS voice_notes (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        
        title VARCHAR(255) NOT NULL,
        description TEXT,
        
        s3_key VARCHAR(500) NOT NULL,
        s3_bucket VARCHAR(255) NOT NULL,
        file_size_bytes BIGINT NOT NULL,
        duration_seconds INTEGER NOT NULL,
        
        is_favorite BOOLEAN DEFAULT FALSE,
        is_permanent BOOLEAN DEFAULT FALSE,
        storage_class VARCHAR(50) DEFAULT 'STANDARD',
        retention_policy VARCHAR(50) DEFAULT 'standard',
        
        play_count INTEGER DEFAULT 0,
        last_played TIMESTAMP,
        
        tags TEXT[],
        scheduled_for TIMESTAMP,
        
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        deleted_at TIMESTAMP
      )
    `);

    // Create voice_wills table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS voice_wills (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        
        title VARCHAR(255) NOT NULL,
        description TEXT,
        
        s3_key VARCHAR(500) NOT NULL,
        s3_bucket VARCHAR(255) NOT NULL,
        
        release_condition VARCHAR(50) DEFAULT 'manual',
        release_date TIMESTAMP,
        is_released BOOLEAN DEFAULT FALSE,
        released_at TIMESTAMP,
        released_by UUID REFERENCES users(id),
        release_notes TEXT,
        
        beneficiaries UUID[],
        executors UUID[],
        verification_required BOOLEAN DEFAULT TRUE,
        
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Create scheduled_messages table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS scheduled_messages (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        voice_note_id UUID REFERENCES voice_notes(id),
        recipient_contact_id UUID REFERENCES contacts(id),
        
        recipient_phone VARCHAR(50),
        recipient_email VARCHAR(255),
        delivery_method VARCHAR(50) NOT NULL,
        delivery_status VARCHAR(50) DEFAULT 'scheduled',
        
        scheduled_for TIMESTAMP NOT NULL,
        delivered_at TIMESTAMP,
        
        metadata JSONB DEFAULT '{}',
        error_message TEXT,
        
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Create billing_history table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS billing_history (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        
        stripe_invoice_id VARCHAR(255),
        stripe_payment_intent_id VARCHAR(255),
        
        amount_cents INTEGER NOT NULL,
        currency VARCHAR(10) DEFAULT 'USD',
        description TEXT,
        
        status VARCHAR(50) NOT NULL,
        tier_before VARCHAR(50),
        tier_after VARCHAR(50),
        
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Create system_logs table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS system_logs (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id UUID REFERENCES users(id),
        
        level VARCHAR(20) NOT NULL,
        service VARCHAR(100) NOT NULL,
        message TEXT NOT NULL,
        metadata JSONB DEFAULT '{}',
        
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Create indexes and Special Constraints    
    await pool.query('CREATE UNIQUE INDEX IF NOT EXISTS idx_unique_user_email_not_null ON contacts (user_id, email) WHERE email IS NOT NULL');
    
    await pool.query('CREATE INDEX IF NOT EXISTS idx_users_email ON users(email)');
    await pool.query('CREATE INDEX IF NOT EXISTS idx_users_phone ON users(phone)');
    await pool.query('CREATE INDEX IF NOT EXISTS idx_users_subscription ON users(subscription_tier, subscription_status)');
    await pool.query('CREATE INDEX IF NOT EXISTS idx_voice_notes_user ON voice_notes(user_id)');
    await pool.query('CREATE INDEX IF NOT EXISTS idx_voice_notes_permanent ON voice_notes(is_permanent)');
    await pool.query('CREATE INDEX IF NOT EXISTS idx_contacts_user ON contacts(user_id)');
    await pool.query('CREATE INDEX IF NOT EXISTS idx_scheduled_messages_user ON scheduled_messages(user_id)');
    await pool.query('CREATE INDEX IF NOT EXISTS idx_scheduled_messages_status ON scheduled_messages(delivery_status, scheduled_for)');
    await pool.query('CREATE INDEX IF NOT EXISTS idx_voice_wills_user ON voice_wills(user_id)');
    await pool.query('CREATE INDEX IF NOT EXISTS idx_voice_wills_released ON voice_wills(is_released)');
    await pool.query('CREATE INDEX IF NOT EXISTS idx_billing_user ON billing_history(user_id)');
    await pool.query('CREATE INDEX IF NOT EXISTS idx_system_logs_created ON system_logs(created_at)');

    console.log('Database tables created successfully!');

  } catch (error) {
    console.error('Error creating tables:', error);
    process.exit(1);
  }
}

// Run if called directly
if (require.main === module) {
  createTables()
    .then(() => {
      console.log('Database setup complete!');
      process.exit(0);
    })
    .catch((error) => {
      console.error('Failed to setup database:', error);
      process.exit(1);
    });
}

module.exports = { createTables };