const { Pool } = require('pg');

// Function to parse DB_SECRET safely
function parseDBSecret() {
  try {
    if (!process.env.DB_SECRET) {
      console.log('⚠️ DB_SECRET environment variable is not set');
      return {};
    }
    return JSON.parse(process.env.DB_SECRET);
  } catch (error) {
    console.error('❌ Failed to parse DB_SECRET:', error.message);
    console.error('DB_SECRET value (first 50 chars):', process.env.DB_SECRET?.substring(0, 50));
    return {};
  }
}

// Function to get database configuration
function getDBConfig() {
  const dbSecret = parseDBSecret();
  
  console.log('RDS Secret keys available:', Object.keys(dbSecret));
  
  // Default values that might work for Aurora
  // IMPORTANT: You need to replace these with your actual values!
  const defaultConfig = {
    host: process.env.DB_HOST || 'suretalk-database-1.cbw8msgksr4u.eu-central-1.rds.amazonaws.com', 
    port: Number(process.env.DB_PORT) || 5432,
    database: process.env.DB_NAME || 'suretalk-database-1', 
    user: dbSecret.username || process.env.DB_USER || 'postgres',
    password: dbSecret.password || process.env.DB_PASSWORD || 'X:bQC<Oad6Ji[sveDaM1-NJ1Km)v',
  };
  
  // Convert password to string if it exists
  if (defaultConfig.password !== undefined && defaultConfig.password !== null) {
    defaultConfig.password = String(defaultConfig.password);
  }
  
  console.log('Database configuration:', {
    host: defaultConfig.host,
    port: defaultConfig.port,
    database: defaultConfig.database,
    user: defaultConfig.user,
    password: defaultConfig.password ? '[HIDDEN]' : 'MISSING'
  });
  
  return defaultConfig;
}

const dbConfig = getDBConfig();

// Log warnings but don't crash
const required = ['host', 'database', 'user', 'password'];
const missing = required.filter(field => !dbConfig[field]);

if (missing.length > 0) {
  console.error(`⚠️ WARNING: Missing database configuration: ${missing.join(', ')}`);
  console.error('The application will start but database connections will fail.');
  console.error('');
  console.error('TO FIX THIS:');
  console.error('1. Get your RDS endpoint from AWS RDS Console');
  console.error('2. Update the "host" default in this file');
  console.error('3. Update the "database" default in this file');
  console.error('Or add these environment variables to App Runner:');
  console.error('  - DB_HOST: your-rds-endpoint.cluster-xxx.region.rds.amazonaws.com');
  console.error('  - DB_NAME: your_database_name');
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
  connectionAttempts = 0; // Reset on successful connection
});

pool.on('error', (err) => {
  connectionAttempts++;
  console.error(`❌ Database connection error (attempt ${connectionAttempts}/${maxConnectionAttempts}):`, err.message);
  console.error('   Current host:', dbConfig.host);
  
  if (connectionAttempts >= maxConnectionAttempts) {
    console.error('💀 Too many database connection failures. Please check:');
    console.error('   1. Is DB_HOST correct? Current:', dbConfig.host);
    console.error('   2. Is App Runner in same VPC as RDS?');
    console.error('   3. Do security groups allow port 5432?');
    console.error('   4. Is the database name correct? Current:', dbConfig.database);
  }
});

// Add a test query function that won't crash the app
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

// Export both pool and test function
module.exports = { pool, testDatabaseConnection };