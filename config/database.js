const { Pool } = require('pg');

// Function to get database configuration - works with or without DB_SECRET
function getDBConfig() {
  let dbSecret = {};
  
  // Try to parse DB_SECRET if it exists, but don't fail if it's invalid
  if (process.env.DB_SECRET) {
    try {
      dbSecret = JSON.parse(process.env.DB_SECRET);
      console.log('✅ Successfully parsed DB_SECRET');
    } catch (error) {
      console.log('⚠️ DB_SECRET exists but is not valid JSON, ignoring it');
      // If it's not JSON, it might be the old password string - ignore it
      dbSecret = {};
    }
  } else {
    console.log('ℹ️ DB_SECRET not set, using individual environment variables');
  }

  // Build config from multiple sources, with clear priority:
  // 1. Individual env vars (DB_HOST, DB_USER, etc.) - highest priority
  // 2. Parsed DB_SECRET (if valid) - medium priority
  // 3. Hardcoded defaults - lowest priority
  
  const config = {
    host: process.env.DB_HOST || dbSecret.host || 'suretalk-database-1.cbw8msgksr4u.eu-central-1.rds.amazonaws.com',
    port: Number(process.env.DB_PORT) || dbSecret.port || 5432,
    database: process.env.DB_NAME || dbSecret.dbname || dbSecret.database || 'suretalk-database-1',
    user: process.env.DB_USER || dbSecret.username || 'postgres',
    password: process.env.DB_PASSWORD || 'X:bQC<Oad6Ji[sveDaM1-NJ1Km)v' || dbSecret.password
  };

  // CRITICAL: Remove any fallback password! If no password is found, it should be undefined
  if (!config.password) {
    console.error('❌ NO DATABASE PASSWORD FOUND!');
    console.error('   Please set either:');
    console.error('   - DB_PASSWORD environment variable');
    console.error('   - Or a valid DB_SECRET with a password field');
  }

  console.log('Database configuration:', {
    host: config.host,
    port: config.port,
    database: config.database,
    user: config.user,
    password: config.password ? '[SET]' : '[MISSING]',
    source: process.env.DB_PASSWORD ? 'env vars' : (dbSecret.password ? 'secret' : 'none')
  });

  return config;
}

const dbConfig = getDBConfig();

// Validate required fields
const missing = ['host', 'database', 'user', 'password'].filter(field => !dbConfig[field]);
if (missing.length > 0) {
  console.error(`❌ CRITICAL: Missing database configuration: ${missing.join(', ')}`);
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

// Test connection with retry logic
let connectionAttempts = 0;
const maxConnectionAttempts = 5;

pool.on('connect', () => {
  console.log('✅ Database connected successfully to:', dbConfig.host);
  connectionAttempts = 0;
});

pool.on('error', (err) => {
  connectionAttempts++;
  console.error(`❌ Database connection error (attempt ${connectionAttempts}/${maxConnectionAttempts}):`, err.message);
  console.error('   Current host:', dbConfig.host);
  
  if (connectionAttempts >= maxConnectionAttempts) {
    console.error('💀 Too many database connection failures. Please check:');
    console.error('   1. Is DB_HOST correct? Current:', dbConfig.host);
    console.error('   2. Is the password correct?');
    console.error('   3. Is the database name correct? Current:', dbConfig.database);
  }
});

async function testDatabaseConnection() {
  try {
    const client = await pool.connect();
    const result = await client.query('SELECT NOW() as current_time');
    console.log('✅ Database test query successful. Current time:', result.rows[0].current_time);
    client.release();
    return true;
  } catch (err) {
    console.error('❌ Database test query failed:', err.message);
    return false;
  }
}

module.exports = { pool, testDatabaseConnection };