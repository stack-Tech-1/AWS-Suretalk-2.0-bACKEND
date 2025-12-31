// scripts/initDatabase.js
const { pool } = require('../config/database');

async function initDatabase() {
  const client = await pool.connect();
  
  try {
    await client.query('BEGIN');
    console.log('Initializing database...');

    // 1. Create users table (merged version)
    await client.query(`
      CREATE TABLE IF NOT EXISTS users (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        email VARCHAR(255) UNIQUE NOT NULL,
        phone VARCHAR(50) UNIQUE NOT NULL,
        password_hash VARCHAR(255) NOT NULL,
        full_name VARCHAR(255) NOT NULL,
        
        subscription_tier VARCHAR(50) DEFAULT 'ESSENTIAL',
        subscription_status VARCHAR(50) DEFAULT 'active',
        
        storage_limit_gb INTEGER DEFAULT 5,
        contacts_limit INTEGER DEFAULT 9,
        voice_notes_limit INTEGER DEFAULT 100,
        
        stripe_customer_id VARCHAR(255),
        stripe_subscription_id VARCHAR(255),
        
        profile_image_url TEXT,
        is_admin BOOLEAN DEFAULT FALSE,
        admin_status VARCHAR(20) DEFAULT 'none',
        
        email_verified BOOLEAN DEFAULT FALSE,
        phone_verified BOOLEAN DEFAULT FALSE,
        two_factor_enabled BOOLEAN DEFAULT FALSE,
        
        last_login TIMESTAMP,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        deleted_at TIMESTAMP
      )
    `);

    // 2. Create contacts table
    await client.query(`
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

    // 3. Create voice_notes table (merged version)
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
        
        is_favorite BOOLEAN DEFAULT FALSE,
        is_permanent BOOLEAN DEFAULT FALSE,
        is_public BOOLEAN DEFAULT FALSE,
        
        storage_class VARCHAR(50) DEFAULT 'STANDARD',
        retention_policy VARCHAR(50) DEFAULT 'standard',
        
        play_count INTEGER DEFAULT 0,
        last_played TIMESTAMP,
        
        tags TEXT[] DEFAULT '{}',
        scheduled_for TIMESTAMP,
        status VARCHAR(20) DEFAULT 'active',
        metadata JSONB DEFAULT '{}',
        
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        deleted_at TIMESTAMP
      )
    `);

    // 4. Create voice_wills table (merged version)
    await client.query(`
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
        
        beneficiaries UUID[] DEFAULT '{}',
        executors UUID[] DEFAULT '{}',
        verification_required BOOLEAN DEFAULT TRUE,
        metadata JSONB DEFAULT '{}',
        
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // 5. Create scheduled_messages table (merged version)
    await client.query(`
      CREATE TABLE IF NOT EXISTS scheduled_messages (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        voice_note_id UUID REFERENCES voice_notes(id) ON DELETE CASCADE,
        recipient_contact_id UUID REFERENCES contacts(id) ON DELETE CASCADE,
        
        recipient_phone VARCHAR(50),
        recipient_email VARCHAR(255),
        delivery_method VARCHAR(50) NOT NULL,
        
        scheduled_for TIMESTAMP NOT NULL,
        delivered_at TIMESTAMP,
        delivery_status VARCHAR(50) DEFAULT 'scheduled',
        delivery_attempts INTEGER DEFAULT 0,
        last_attempt_at TIMESTAMP,
        
        error_message TEXT,
        metadata JSONB DEFAULT '{}',
        
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // 6. Create billing_history table (merged version)
    await client.query(`
      CREATE TABLE IF NOT EXISTS billing_history (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        
        stripe_invoice_id VARCHAR(255),
        stripe_payment_intent_id VARCHAR(255),
        
        amount_cents INTEGER NOT NULL,
        currency VARCHAR(10) DEFAULT 'USD',
        description TEXT,
        
        status VARCHAR(50) DEFAULT 'pending',
        tier_before VARCHAR(50),
        tier_after VARCHAR(50),
        metadata JSONB DEFAULT '{}',
        
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // 7. Create system_logs table (merged version)
    await client.query(`
      CREATE TABLE IF NOT EXISTS system_logs (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id UUID REFERENCES users(id),
        level VARCHAR(20) NOT NULL,
        service VARCHAR(100) NOT NULL,
        message TEXT NOT NULL,
        
        ip_address INET,
        user_agent TEXT,
        metadata JSONB DEFAULT '{}',
        
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // 8. Create lifecycle_rules table (from second file)
    await client.query(`
      CREATE TABLE IF NOT EXISTS lifecycle_rules (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        name VARCHAR(255) NOT NULL,
        bucket VARCHAR(255),
        action_type VARCHAR(50) NOT NULL CHECK (action_type IN ('transition', 'expire', 'abort')),
        days INTEGER NOT NULL,
        storage_class VARCHAR(50) CHECK (storage_class IN ('STANDARD', 'STANDARD_IA', 'GLACIER', 'DEEP_ARCHIVE')),
        description TEXT,
        status VARCHAR(20) DEFAULT 'active' CHECK (status IN ('active', 'paused')),
        created_by UUID REFERENCES users(id),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // 9. Create rule_executions table (from second file)
    await client.query(`
      CREATE TABLE IF NOT EXISTS rule_executions (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        rule_id UUID REFERENCES lifecycle_rules(id) ON DELETE CASCADE,
        status VARCHAR(20) NOT NULL CHECK (status IN ('success', 'failed', 'partial')),
        files_processed INTEGER DEFAULT 0,
        files_transitioned INTEGER DEFAULT 0,
        files_deleted INTEGER DEFAULT 0,
        error_message TEXT,
        executed_by UUID REFERENCES users(id),
        executed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // 10. Create storage_config table (from second file)
    await client.query(`
      CREATE TABLE IF NOT EXISTS storage_config (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        default_storage_class VARCHAR(50) DEFAULT 'STANDARD',
        encryption_enabled BOOLEAN DEFAULT true,
        versioning_enabled BOOLEAN DEFAULT true,
        intelligent_tiering BOOLEAN DEFAULT false,
        cost_alerts BOOLEAN DEFAULT true,
        cost_threshold INTEGER DEFAULT 500,
        auto_backup_enabled BOOLEAN DEFAULT true,
        backup_frequency VARCHAR(20) DEFAULT 'daily',
        cross_region_replication BOOLEAN DEFAULT false,
        updated_by UUID REFERENCES users(id),
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // 11. Create storage_reports table (from second file)
    await client.query(`
      CREATE TABLE IF NOT EXISTS storage_reports (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        filename VARCHAR(255) NOT NULL,
        mimetype VARCHAR(100),
        size BIGINT,
        uploaded_by UUID REFERENCES users(id),
        status VARCHAR(20) DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'processed', 'failed')),
        processed_at TIMESTAMP,
        error_message TEXT,
        uploaded_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // 12. Create system_settings table (from second file)
    await client.query(`
      CREATE TABLE IF NOT EXISTS system_settings (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        category VARCHAR(50) NOT NULL,
        setting_key VARCHAR(100) NOT NULL,
        setting_value TEXT,
        setting_type VARCHAR(20) DEFAULT 'string',
        description TEXT,
        is_encrypted BOOLEAN DEFAULT FALSE,
        requires_restart BOOLEAN DEFAULT FALSE,
        created_by UUID REFERENCES users(id),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(category, setting_key)
          )
      `);

    // 13. Create support_tickets table
await client.query(`
  CREATE TABLE IF NOT EXISTS support_tickets (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    ticket_number VARCHAR(20) UNIQUE NOT NULL,
    subject VARCHAR(255) NOT NULL,
    description TEXT NOT NULL,
    category VARCHAR(50) DEFAULT 'general',
    priority VARCHAR(20) DEFAULT 'medium',
    status VARCHAR(20) DEFAULT 'open',
    
    -- Admin fields
    assigned_to UUID REFERENCES users(id),
    resolved_by UUID REFERENCES users(id),
    
    -- Internal notes (only visible to admins)
    internal_notes TEXT,
    
    -- Timestamps
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    resolved_at TIMESTAMP,
    closed_at TIMESTAMP
  )
`);

// 14. Create ticket_responses table
await client.query(`
  CREATE TABLE IF NOT EXISTS ticket_responses (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    ticket_id UUID NOT NULL REFERENCES support_tickets(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    message TEXT NOT NULL,
    is_internal BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  )
`);

// 15. Create knowledge_base_articles table
await client.query(`
  CREATE TABLE IF NOT EXISTS knowledge_base_articles (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    title VARCHAR(255) NOT NULL,
    content TEXT NOT NULL,
    category VARCHAR(50) NOT NULL,
    tags TEXT[] DEFAULT '{}',
    views INTEGER DEFAULT 0,
    helpful_votes INTEGER DEFAULT 0,
    not_helpful_votes INTEGER DEFAULT 0,
    
    -- Publishing
    published BOOLEAN DEFAULT TRUE,
    published_by UUID REFERENCES users(id),
    published_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    
    -- Auditing
    created_by UUID REFERENCES users(id),
    updated_by UUID REFERENCES users(id),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  )
`);

    // Create all indexes (combined from both files)
    await client.query(`
      -- Users indexes
      CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
      CREATE INDEX IF NOT EXISTS idx_users_phone ON users(phone);
      CREATE INDEX IF NOT EXISTS idx_users_subscription ON users(subscription_tier, subscription_status);
      CREATE INDEX IF NOT EXISTS idx_users_subscription_tier ON users(subscription_tier);
      
      -- Contacts indexes
      CREATE INDEX IF NOT EXISTS idx_contacts_user ON contacts(user_id);
      CREATE INDEX IF NOT EXISTS idx_contacts_user_id ON contacts(user_id);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_unique_user_email_not_null ON contacts (user_id, email) WHERE email IS NOT NULL;
      
      -- Voice notes indexes
      CREATE INDEX IF NOT EXISTS idx_voice_notes_user ON voice_notes(user_id);
      CREATE INDEX IF NOT EXISTS idx_voice_notes_user_id ON voice_notes(user_id);
      CREATE INDEX IF NOT EXISTS idx_voice_notes_permanent ON voice_notes(is_permanent);
      CREATE INDEX IF NOT EXISTS idx_voice_notes_is_permanent ON voice_notes(is_permanent);
      CREATE INDEX IF NOT EXISTS idx_voice_notes_scheduled_for ON voice_notes(scheduled_for);
      
      -- Voice wills indexes
      CREATE INDEX IF NOT EXISTS idx_voice_wills_user ON voice_wills(user_id);
      CREATE INDEX IF NOT EXISTS idx_voice_wills_user_id ON voice_wills(user_id);
      CREATE INDEX IF NOT EXISTS idx_voice_wills_released ON voice_wills(is_released);
      CREATE INDEX IF NOT EXISTS idx_voice_wills_is_released ON voice_wills(is_released);
      
      -- Scheduled messages indexes
      CREATE INDEX IF NOT EXISTS idx_scheduled_messages_user ON scheduled_messages(user_id);
      CREATE INDEX IF NOT EXISTS idx_scheduled_messages_status ON scheduled_messages(delivery_status, scheduled_for);
      CREATE INDEX IF NOT EXISTS idx_scheduled_messages_scheduled_for ON scheduled_messages(scheduled_for);
      CREATE INDEX IF NOT EXISTS idx_scheduled_messages_delivery_status ON scheduled_messages(delivery_status);
      
      -- Billing indexes
      CREATE INDEX IF NOT EXISTS idx_billing_user ON billing_history(user_id);
      
      -- System logs indexes
      CREATE INDEX IF NOT EXISTS idx_system_logs_created ON system_logs(created_at);
      CREATE INDEX IF NOT EXISTS idx_system_logs_created_at ON system_logs(created_at);
      CREATE INDEX IF NOT EXISTS idx_system_logs_level ON system_logs(level);
      
      -- New storage management indexes
      CREATE INDEX IF NOT EXISTS idx_lifecycle_rules_bucket ON lifecycle_rules(bucket);
      CREATE INDEX IF NOT EXISTS idx_lifecycle_rules_status ON lifecycle_rules(status);
      CREATE INDEX IF NOT EXISTS idx_lifecycle_rules_created_by ON lifecycle_rules(created_by);
      CREATE INDEX IF NOT EXISTS idx_rule_executions_rule_id ON rule_executions(rule_id);
      CREATE INDEX IF NOT EXISTS idx_rule_executions_executed_at ON rule_executions(executed_at);
      CREATE INDEX IF NOT EXISTS idx_storage_reports_uploaded_by ON storage_reports(uploaded_by);
      CREATE INDEX IF NOT EXISTS idx_storage_reports_status ON storage_reports(status);
      CREATE INDEX IF NOT EXISTS idx_storage_reports_uploaded_at ON storage_reports(uploaded_at);

      -- Support tickets indexes
      CREATE INDEX IF NOT EXISTS idx_support_tickets_user_id ON support_tickets(user_id);
      CREATE INDEX IF NOT EXISTS idx_support_tickets_status ON support_tickets(status);
      CREATE INDEX IF NOT EXISTS idx_support_tickets_priority ON support_tickets(priority);
      CREATE INDEX IF NOT EXISTS idx_support_tickets_assigned_to ON support_tickets(assigned_to);
      CREATE INDEX IF NOT EXISTS idx_support_tickets_category ON support_tickets(category);
      
      -- Ticket responses indexes
      CREATE INDEX IF NOT EXISTS idx_ticket_responses_ticket_id ON ticket_responses(ticket_id);
      CREATE INDEX IF NOT EXISTS idx_ticket_responses_user_id ON ticket_responses(user_id);
      
      -- Knowledge base indexes
      CREATE INDEX IF NOT EXISTS idx_knowledge_base_articles_category ON knowledge_base_articles(category);
      CREATE INDEX IF NOT EXISTS idx_knowledge_base_articles_published ON knowledge_base_articles(published);
      CREATE INDEX IF NOT EXISTS idx_knowledge_base_articles_created_by ON knowledge_base_articles(created_by);
    `);

    // Add trigger for support_tickets
await client.query(`
  DROP TRIGGER IF EXISTS update_support_tickets_updated_at ON support_tickets;
  CREATE TRIGGER update_support_tickets_updated_at
  BEFORE UPDATE ON support_tickets
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();
`);

// Add trigger for knowledge_base_articles
await client.query(`
  DROP TRIGGER IF EXISTS update_knowledge_base_articles_updated_at ON knowledge_base_articles;
  CREATE TRIGGER update_knowledge_base_articles_updated_at
  BEFORE UPDATE ON knowledge_base_articles
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();
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

    // Add these tables to the triggers array:
      const tables = [
        'users', 'contacts', 'voice_notes', 'voice_wills', 
        'scheduled_messages', 'lifecycle_rules', 'storage_config',
        'support_tickets', 'knowledge_base_articles'  
      ];
    
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
    console.log('✅ Database initialization completed successfully');
    console.log('✅ All tables, indexes, and triggers created');

  } catch (error) {
    await client.query('ROLLBACK');
    console.error('❌ Database initialization failed:', error);
    throw error;
  } finally {
    client.release();
  }
}

// Run if called directly
if (require.main === module) {
  initDatabase()
    .then(() => {
      console.log('Database setup complete!');
      process.exit(0);
    })
    .catch((error) => {
      console.error('Failed to setup database:', error);
      process.exit(1);
    });
}

module.exports = { initDatabase };