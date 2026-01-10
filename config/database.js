const { Pool } = require('pg');

let dbConfig;

try {
  // Parse the RDS secret for rotating credentials
  const dbSecret = JSON.parse(process.env.DB_SECRET || '{}');
  
  console.log('RDS Secret keys available:', Object.keys(dbSecret));
  
  // Use static env vars for connection details + RDS secret for credentials
  dbConfig = {
    // Static connection details from environment variables
    host: process.env.DB_HOST,  
    port: Number(process.env.DB_PORT) || 5432,
    database: process.env.DB_NAME,  
    
    // Rotating credentials from RDS secret
    user: dbSecret.username || process.env.DB_USER || 'postgres',
    password: dbSecret.password || process.env.DB_PASSWORD,
  };
  
  // Log for debugging (remove in production)
  console.log('Database configuration:', {
    host: dbConfig.host,
    port: dbConfig.port,
    database: dbConfig.database,
    user: dbConfig.user,
    password: dbConfig.password ? '[HIDDEN]' : 'MISSING'
  });
  
} catch (error) {
  console.error('❌ Error setting up database config:', error);
  console.error('DB_SECRET value:', process.env.DB_SECRET);
  
  // Fallback to all static env vars
  dbConfig = {
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT) || 5432,
    database: process.env.DB_NAME,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
  };
  
  console.log('⚠️ Using fallback configuration (no RDS secret)');
}

// Validate configuration
const required = ['host', 'database', 'user', 'password'];
const missing = required.filter(field => !dbConfig[field]);

if (missing.length > 0) {
  console.error(`❌ Missing required database configuration: ${missing.join(', ')}`);
  console.error('Current config (password hidden):', {
    ...dbConfig,
    password: dbConfig.password ? '[HIDDEN]' : 'MISSING'
  });
  process.exit(1);
}

const pool = new Pool({
  ...dbConfig,
  ssl: {
    rejectUnauthorized: false
  },
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 30000,
  keepAlive: true,
  keepAliveInitialDelayMillis: 20000
});

// Test connection
pool.on('connect', () => {
  console.log('✅ Database connected successfully');
});

pool.on('error', (err) => {
  console.error('Unexpected database error:', err);
  // Don't exit immediately - might be temporary
});

module.exports = { pool };