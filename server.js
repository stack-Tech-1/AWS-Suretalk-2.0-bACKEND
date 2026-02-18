// C:\Users\SMC\Documents\GitHub\AWS-Suretalk-2.0-bACKEND\server.js
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const slowDown = require('express-slow-down');
const { createLogger, format, transports } = require('winston');
const AWS = require('aws-sdk');
const WebSocket = require('ws');
const logger = require('./utils/logger');

const settingsRoutes = require('./routes/settings');
const devicesRoutes = require('./routes/devices');
const backupRoutes = require('./routes/backup');



// Initialize AWS SDK
AWS.config.update({
  region: process.env.AWS_REGION || 'us-east-1',
  accessKeyId: process.env.AWS_ACCESS_KEY_ID,
  secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY
});



// Initialize Express
const app = express();

// Security middleware
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      scriptSrc: ["'self'"],
      imgSrc: ["'self'", "data:", "https:"]
    }
  }
}));

app.set('trust proxy', 1);

app.use((req, res, next) => {
  if (req.method === 'OPTIONS') return next();
  next();
});

// CORS configuration
const corsOptions = {
  origin: process.env.NODE_ENV === 'production'
    ? ['https://suretalk.com', 'https://www.suretalk.com', 'https://admin.suretalk.com', process.env.FRONTEND_URL].filter(Boolean)
    : ['http://localhost:3000', 'http://localhost:3001'],
  credentials: true,
  optionsSuccessStatus: 200,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With'],
  exposedHeaders: ['Content-Length', 'X-Request-Id']
};

// Handle preflight requests explicitly
app.options('*', cors(corsOptions));
app.use(cors(corsOptions));

// Rate limiting
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: process.env.NODE_ENV === 'development' ? 1000 : 300,
  message: 'Too many requests from this IP, please try again later.',
  standardHeaders: true,
  legacyHeaders: false,
  skipSuccessfulRequests: false
});
app.use('/api/', limiter);

const adminRateLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  skipSuccessfulRequests: true,
  message: 'Too many login attempts. Please try again later.',
  standardHeaders: true,
  legacyHeaders: false
});

const adminSlowDown = slowDown({
  windowMs: 15 * 60 * 1000,
  delayAfter: 3,
  delayMs: (used, req) => (used - req.slowDown.limit) * 1000,
  maxDelayMs: 10000
});

// IMPORTANT: Custom body parser that excludes webhook routes
app.use((req, res, next) => {
  if (req.originalUrl === '/api/billing/webhook') {
    // Don't parse webhook requests as JSON - Stripe needs raw body
    next();
  } else {
    // Parse all other requests as JSON
    express.json({ limit: '50mb' })(req, res, next);
  }
});

app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// Request logging
app.use((req, res, next) => {
  logger.info({
    method: req.method,
    url: req.url,
    ip: req.ip,
    userAgent: req.get('user-agent')
  });
  next();
});

// Health check endpoint
app.get('/health', (req, res) => {
  res.status(200).json({
    status: 'healthy',
    timestamp: new Date().toISOString(),
    service: 'SureTalk API',
    version: '2.0.0'
  });
});

// API Routes - IMPORTANT: Webhook route must be defined BEFORE routes that need JSON
app.use('/api/billing', require('./routes/billing')); // This includes the webhook

// Other API Routes
app.use('/api/admin/login', adminSlowDown, adminRateLimit);
app.use('/api/auth', require('./routes/auth'));
app.use('/api/users', require('./routes/users'));
app.use('/api/voice-notes', require('./routes/voiceNotes'));
app.use('/api/contacts', require('./routes/contacts'));
app.use('/api/vault', require('./routes/vault'));
app.use('/api/scheduled', require('./routes/scheduled'));
app.use('/api/admin', require('./routes/admin'));
app.use('/api/settings', settingsRoutes);
app.use('/api/devices', devicesRoutes);
app.use('/api/backup', backupRoutes);
app.use('/api/notifications', require('./routes/notifications').router);
app.use('/api/storage', require('./routes/storage'));
app.use('/api/auth', require('./routes/adminAuth'));





// ==================== Sync Routes - Handle incoming payloads from IVR Lambdas ====================
const axios = require('axios');  // Ensure axios is available

/**
 * Fire-and-forget sync to IVR backend via API Gateway
 * @param {Object} payload - Data to send
 * @param {string} endpointPath - API endpoint path (e.g., 'sync-slot')
 */
const syncToIvr = (payload, endpointPath) => {
  const url = `${process.env.IVR_API_URL}/${endpointPath}`;
  const headers = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${process.env.IVR_SYNC_TOKEN}`
  };

  axios.post(url, payload, { headers, timeout: 3000 })
    .then(() => {
      logger.info(`Synced to IVR: ${endpointPath}`);
    })
    .catch(err => {
      logger.error(`Sync to IVR failed (non-fatal): ${err.message}`);
    });
};

// Auth middleware for sync routes (use shared token, not user auth)
const syncAuth = (req, res, next) => {
  const auth = req.headers.authorization;
  if (!auth || auth !== `Bearer ${process.env.IVR_SYNC_TOKEN}`) {
    return res.status(401).json({ success: false, error: 'Unauthorized' });
  }
  next();
};

// Receive new/updated user from IVR
app.post('/api/sync/user', syncAuth, async (req, res) => {
  const { userId, subscription_tier, verified, status, createdAt, action } = req.body;

  try {
    if (action === 'unsubscribe') {
      await pool.query(
        `UPDATE users SET verified = $1, subscription_status = $2, updated_at = NOW() WHERE phone = $3`,
        [false, 'inactive', userId]
      );
    } else if (action === 'create' || action === 'update') {
      await pool.query(
        `INSERT INTO users (phone, subscription_tier, verified, status, created_at, source)
         VALUES ($1, $2, $3, $4, $5, 'ivr')
         ON CONFLICT (phone) DO UPDATE SET
           subscription_tier = EXCLUDED.subscription_tier,
           verified = EXCLUDED.verified,
           status = EXCLUDED.status,
           updated_at = NOW()`,
        [userId, subscription_tier || 'LITE', verified, status || 'active', createdAt || new Date()]
      );
    } else {
      return res.status(400).json({ success: false, error: 'Invalid action' });
    }

    res.status(200).json({ success: true });
  } catch (err) {
    console.error('Sync user error:', err);
    res.status(500).json({ success: false });
  }
});

// Receive new/updated slot from IVR
app.post('/api/sync/slot', syncAuth, async (req, res) => {
  const { 
    userId,           // phone number from IVR
    slotNumber,       // we can log it but won't use it for uniqueness     
    voiceMessage,     // this is the s3_key or full URL — use as unique identifier
    createdAt, 
    action, 
    source 
  } = req.body;

  try {
    // 1. Find internal user_id from phone
    const userResult = await pool.query(
      'SELECT id FROM users WHERE phone = $1',
      [userId]
    );

    if (userResult.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'User not found' });
    }

    const dbUserId = userResult.rows[0].id;

    if (action === 'delete') {
      // Delete by user_id + voiceMessage (s3_key)
      const deleteResult = await pool.query(
        `DELETE FROM voice_notes 
         WHERE user_id = $1 AND s3_key = $2
         RETURNING id`,
        [dbUserId, voiceMessage]
      );

      if (deleteResult.rowCount === 0) {
        console.warn(`No voice note found to delete for user ${userId}, s3_key ${voiceMessage}`);
      }
    } else if (action === 'create' || action === 'update') {
      // Insert or update using user_id + s3_key as conflict target
      await pool.query(
        `INSERT INTO voice_notes (
           user_id, 
           title,               -- if no title sent, use placeholder
           description,         -- optional
           s3_key, 
           s3_bucket,           -- hardcode or extract from voiceMessage if needed
           file_size_bytes,     -- optional: set to 0 or require in payload
           duration_seconds,    -- optional: set to 0            
           created_at, 
           source
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         ON CONFLICT (user_id, s3_key) DO UPDATE SET           
           updated_at = NOW()`,
        [
          dbUserId,
          `Voice Note ${slotNumber || 'Imported'}`,  // fallback title
          null,                                      // description
          voiceMessage,                              // s3_key
          'voice-notes-bucket',                      // adjust to your real bucket name
          0,                                         // file_size_bytes (update later if needed)
          0,                                         // duration_seconds          
          createdAt || new Date(),
          source || 'ivr'
        ]
      );
    } else {
      return res.status(400).json({ success: false, error: 'Invalid action' });
    }

    res.status(200).json({ success: true });
  } catch (err) {
    console.error('Sync slot error:', err);
    res.status(500).json({ success: false });
  }
});

// Receive credential update (PIN change or ID change) from IVR
app.post('/api/sync/credential', syncAuth, async (req, res) => {
  const { userId, oldUserId, requiresPinReset, action } = req.body;

  if (action !== 'update_credentials') {
    return res.status(400).json({ success: false, error: 'Invalid action' });
  }

  try {
    // If userId changed (oldUserId provided and different), update phone
    if (oldUserId && oldUserId !== userId) {
      await pool.query(
        `UPDATE users SET phone = $1, requires_pin_reset = $2, updated_at = NOW() WHERE phone = $3`,
        [userId, requiresPinReset || false, oldUserId]
      );
    } else {
      // Only updating PIN flag (requires_pin_reset)
      await pool.query(
        `UPDATE users SET requires_pin_reset = $1, updated_at = NOW() WHERE phone = $2`,
        [requiresPinReset || false, userId]
      );
    }

    res.status(200).json({ success: true });
  } catch (err) {
    console.error('Sync credential error:', err);
    res.status(500).json({ success: false });
  }
});





// Error handling middleware
app.use((err, req, res, next) => {
  logger.error({
    error: err.message,
    stack: err.stack,
    url: req.url,
    method: req.method
  });

  const statusCode = err.statusCode || 500;
  const message = process.env.NODE_ENV === 'production' && statusCode === 500
    ? 'Internal server error'
    : err.message;

  res.status(statusCode).json({
    success: false,
    error: message,
    ...(process.env.NODE_ENV === 'development' && { stack: err.stack })
  });
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({
    success: false,
    error: 'Endpoint not found'
  });
});

// Database connection
const { pool } = require('./config/database');
pool.connect((err, client, release) => {
  if (err) {
    logger.error('Database connection error:', err);
    process.exit(1);
  }
  logger.info('✅ Database connected successfully');
  release();
});

// Start message scheduler (after logger is ready)
if (process.env.NODE_ENV === 'production' || process.env.ENABLE_SCHEDULER === 'true') {
  const { startScheduler } = require('./workers/messageScheduler');
  startScheduler();
  logger.info('Message scheduler started');
}

// Start server
const PORT = process.env.PORT || 5000;
const server = app.listen(PORT, () => {
  logger.info(`Server running on port ${PORT}`);
  logger.info(`Environment: ${process.env.NODE_ENV || 'development'}`);
});

// WebSocket server
const wss = new WebSocket.Server({ server });

wss.on('connection', (ws) => {
  console.log('New WebSocket connection');

  ws.on('message', (message) => {
    try {
      const data = JSON.parse(message);

      if (data.type === 'subscribe') {
        ws.subscriptions = ws.subscriptions || new Set();
        ws.subscriptions.add(data.data.channel);

        if (data.data.channel === 'storage') {
          sendStorageUpdate(ws, data.data.bucket);
        }
      } else if (data.type === 'unsubscribe') {
        if (ws.subscriptions) ws.subscriptions.delete(data.data.channel);
      }
    } catch (error) {
      console.error('WebSocket message error:', error);
    }
  });

  ws.on('close', () => {
    console.log('WebSocket connection closed');
  });
});

// Send storage updates
async function sendStorageUpdate(ws, bucket = null) {
  try {
    const query = bucket
      ? `SELECT s3_bucket, COUNT(*) as file_count, COALESCE(SUM(file_size_bytes),0) as total_bytes
         FROM voice_notes WHERE s3_bucket = $1 AND deleted_at IS NULL GROUP BY s3_bucket`
      : `SELECT s3_bucket, COUNT(*) as file_count, COALESCE(SUM(file_size_bytes),0) as total_bytes
         FROM voice_notes WHERE deleted_at IS NULL GROUP BY s3_bucket`;

    const params = bucket ? [bucket] : [];
    const result = await pool.query(query, params);

    const update = {
      type: 'storage_update',
      data: {
        timestamp: new Date().toISOString(),
        metrics: result.rows.map(row => ({
          bucket: row.s3_bucket,
          files: row.file_count,
          size: row.total_bytes,
          sizeGB: Math.round(row.total_bytes / (1024 * 1024 * 1024))
        })),
        bucket
      }
    };

    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(update));
  } catch (error) {
    console.error('Storage update error:', error);
  }
}

// Broadcast updates every 30 seconds
setInterval(() => {
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN && client.subscriptions?.has('storage')) {
      sendStorageUpdate(client);
    }
  });
}, 30000);

// Graceful shutdown
process.on('SIGTERM', () => {
  logger.info('SIGTERM signal received: closing HTTP server');
  server.close(() => {
    logger.info('HTTP server closed');
    pool.end(() => {
      logger.info('Database pool closed');
      process.exit(0);
    });
  });
});

module.exports = app;