const { Pool } = require('pg');
//require('dotenv').config();

const dbSecret = JSON.parse(process.env.DB_SECRET);

const pool = new Pool({
  host: dbSecret.host,
  port: Number(dbSecret.port),
  database: dbSecret.dbname,
  user: dbSecret.username,
  password: dbSecret.password,
  ssl: {
    rejectUnauthorized: false
  },
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 30000
});

// Test connection
pool.on('connect', () => {
  console.log('✅ Database connected successfully');
});

pool.on('error', (err) => {
  console.error('Unexpected database error:', err);
  process.exit(-1);
});

module.exports = { pool };