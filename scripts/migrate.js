// C:\Users\SMC\Documents\GitHub\AWS-Suretalk-2.0-fRONTEND\surechat-backend\scripts\migrate.js
const { pool } = require('../config/database');
const fs = require('fs').promises;
const path = require('path');

async function runMigrations() {
  const client = await pool.connect();
  
  try {
    await client.query('BEGIN');
    
    // Create users table
    await client.query(`
      CREATE TABLE IF NOT EXISTS users (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        email VARCHAR(255) UNIQUE NOT NULL,
        phone VARCHAR(20) UNIQUE NOT NULL,
        password_hash VARCHAR(255) NOT NULL,
        full_name VARCHAR(255) NOT NULL,
        subscription_tier VARCHAR(30) DEFAULT 'ESSENTIAL',
        subscription_status VARCHAR(20) DEFAULT 'active',
        stripe_customer_id VARCHAR(255),
        stripe_subscription_id VARCHAR(255),
        storage_limit_gb INTEGER DEFAULT 5,
        contacts_limit INTEGER DEFAULT 9,
        voice_notes_limit INTEGER DEFAULT 100,
        last_login TIMESTAMP,
        email_verified BOOLEAN DEFAULT FALSE,
        phone_verified BOOLEAN DEFAULT FALSE,
        two_factor_enabled BOOLEAN DEFAULT FALSE,
        profile_image_url TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        deleted_at TIMESTAMP
      )
    `);

    // Create contacts table
    await client.query(`
      CREATE TABLE IF NOT EXISTS contacts (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        name VARCHAR(255) NOT NULL,
        phone VARCHAR(20) NOT NULL,
        email VARCHAR(255),
        relationship VARCHAR(50),
        is_beneficiary BOOLEAN DEFAULT FALSE,
        can_receive_messages BOOLEAN DEFAULT TRUE,
        notes TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(user_id, phone)
      )
    `);

    // Create voice_notes table
    await client.query(`
      CREATE TABLE IF NOT EXISTS voice_notes (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        title VARCHAR(255) NOT NULL,
        description TEXT,
        s3_key VARCHAR(500) NOT NULL,
        s3_bucket VARCHAR(255) NOT NULL,
        file_size_bytes BIGINT NOT NULL,
        duration_seconds INTEGER NOT NULL,
        file_format VARCHAR(10) DEFAULT 'mp3',
        is_permanent BOOLEAN DEFAULT FALSE,
        storage_class VARCHAR(50) DEFAULT 'STANDARD',
        retention_policy VARCHAR(50) DEFAULT 'standard',
        is_favorite BOOLEAN DEFAULT FALSE,
        tags TEXT[] DEFAULT '{}',
        is_public BOOLEAN DEFAULT FALSE,
        play_count INTEGER DEFAULT 0,
        last_played TIMESTAMP,
        scheduled_for TIMESTAMP,
        status VARCHAR(20) DEFAULT 'active',
        metadata JSONB DEFAULT '{}',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        deleted_at TIMESTAMP
      )
    `);

    // Create voice_wills table
    await client.query(`
      CREATE TABLE IF NOT EXISTS voice_wills (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        title VARCHAR(255) NOT NULL,
        description TEXT,
        s3_key VARCHAR(500) NOT NULL,
        s3_bucket VARCHAR(255) NOT NULL,
        release_condition VARCHAR(50) NOT NULL,
        release_date TIMESTAMP,
        beneficiaries UUID[] DEFAULT '{}',
        executors UUID[] DEFAULT '{}',
        verification_required BOOLEAN DEFAULT TRUE,
        is_released BOOLEAN DEFAULT FALSE,
        released_at TIMESTAMP,
        released_by UUID REFERENCES users(id),
        release_notes TEXT,
        metadata JSONB DEFAULT '{}',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Create scheduled_messages table
    await client.query(`
      CREATE TABLE IF NOT EXISTS scheduled_messages (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        voice_note_id UUID REFERENCES voice_notes(id) ON DELETE CASCADE,
        recipient_contact_id UUID REFERENCES contacts(id) ON DELETE CASCADE,
        recipient_phone VARCHAR(20),
        recipient_email VARCHAR(255),
        delivery_method VARCHAR(20) NOT NULL,
        scheduled_for TIMESTAMP NOT NULL,
        delivered_at TIMESTAMP,
        delivery_status VARCHAR(20) DEFAULT 'scheduled',
        delivery_attempts INTEGER DEFAULT 0,
        last_attempt_at TIMESTAMP,
        error_message TEXT,
        metadata JSONB DEFAULT '{}',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Create billing_history table
    await client.query(`
      CREATE TABLE IF NOT EXISTS billing_history (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        stripe_invoice_id VARCHAR(255),
        stripe_payment_intent_id VARCHAR(255),
        amount_cents INTEGER NOT NULL,
        currency VARCHAR(3) DEFAULT 'USD',
        description TEXT,
        status VARCHAR(20) DEFAULT 'pending',
        tier_before VARCHAR(30),
        tier_after VARCHAR(30),
        metadata JSONB DEFAULT '{}',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Create system_logs table
    await client.query(`
      CREATE TABLE IF NOT EXISTS system_logs (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        level VARCHAR(20) NOT NULL,
        service VARCHAR(100) NOT NULL,
        message TEXT NOT NULL,
        user_id UUID REFERENCES users(id),
        ip_address INET,
        user_agent TEXT,
        metadata JSONB DEFAULT '{}',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Create indexes
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
      CREATE INDEX IF NOT EXISTS idx_users_phone ON users(phone);
      CREATE INDEX IF NOT EXISTS idx_users_subscription_tier ON users(subscription_tier);
      CREATE INDEX IF NOT EXISTS idx_voice_notes_user_id ON voice_notes(user_id);
      CREATE INDEX IF NOT EXISTS idx_voice_notes_scheduled_for ON voice_notes(scheduled_for);
      CREATE INDEX IF NOT EXISTS idx_voice_notes_is_permanent ON voice_notes(is_permanent);
      CREATE INDEX IF NOT EXISTS idx_voice_wills_user_id ON voice_wills(user_id);
      CREATE INDEX IF NOT EXISTS idx_voice_wills_is_released ON voice_wills(is_released);
      CREATE INDEX IF NOT EXISTS idx_scheduled_messages_scheduled_for ON scheduled_messages(scheduled_for);
      CREATE INDEX IF NOT EXISTS idx_scheduled_messages_delivery_status ON scheduled_messages(delivery_status);
      CREATE INDEX IF NOT EXISTS idx_contacts_user_id ON contacts(user_id);
      CREATE INDEX IF NOT EXISTS idx_system_logs_created_at ON system_logs(created_at);
      CREATE INDEX IF NOT EXISTS idx_system_logs_level ON system_logs(level);
    `);

    // Create triggers for updated_at
    await client.query(`
      CREATE OR REPLACE FUNCTION update_updated_at_column()
      RETURNS TRIGGER AS $$
      BEGIN
        NEW.updated_at = CURRENT_TIMESTAMP;
        RETURN NEW;
      END;
      $$ language 'plpgsql';
    `);

    // Apply triggers to all tables
    const tables = ['users', 'contacts', 'voice_notes', 'voice_wills', 'scheduled_messages'];
    for (const table of tables) {
      await client.query(`
        DROP TRIGGER IF EXISTS update_${table}_updated_at ON ${table};
        CREATE TRIGGER update_${table}_updated_at
        BEFORE UPDATE ON ${table}
        FOR EACH ROW
        EXECUTE FUNCTION update_updated_at_column();
      `);
    }

    await client.query('COMMIT');
    console.log('✅ Database migrations completed successfully');
    
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('❌ Migration failed:', error);
    process.exit(1);
  } finally {
    client.release();
    process.exit(0);
  }
}

runMigrations().catch(console.error);