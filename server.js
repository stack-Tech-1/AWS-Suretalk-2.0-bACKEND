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
const { v4: uuidv4 } = require('uuid');
const { normalizeTier } = require('./utils/tierMapping');
const axios = require('axios');
const { authenticate } = require('./middleware/auth');
const EC2_STREAM_URL = process.env.EC2_STREAM_URL || 'https://test-api.suretalknow.com';

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

// Attach a unique request ID to every request for tracing
app.use((req, res, next) => {
  req.requestId = uuidv4();
  res.setHeader('X-Request-ID', req.requestId);
  next();
});

app.use((req, res, next) => {
  if (req.method === 'OPTIONS') return next();
  next();
});

// CORS configuration
const corsOptions = {
  origin: process.env.NODE_ENV === 'production'
    ? ['https://suretalk.com', 'https://www.suretalk.com', 'https://test-api.suretalknow.com', 'https://admin.suretalk.com', process.env.FRONTEND_URL].filter(Boolean)
    : ['http://localhost:3000', 'http://localhost:3001'],
  credentials: true,
  optionsSuccessStatus: 200,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With'],
  exposedHeaders: ['Content-Length', 'X-Request-Id', 'X-Request-ID']
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

// Auth route slow-down: 500ms fixed delay after 50 requests per 15 minutes
const authSlowDown = slowDown({
  windowMs: 15 * 60 * 1000,
  delayAfter: 50,
  delayMs: () => 500
});

// IMPORTANT: Custom body parser that excludes webhook routes
app.use((req, res, next) => {
  if (req.originalUrl === '/api/billing/webhook') {
    // Don't parse webhook requests as JSON - Stripe needs raw body
    next();
  } else {
    // Parse all other requests as JSON
    express.json({ limit: '10mb' })(req, res, next);
  }
});

app.use(express.urlencoded({ extended: true, limit: '10mb' }));

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
// Dedicated Stripe webhook handler — registered before billing router so it takes priority
app.use('/api/billing/webhook', express.raw({ type: 'application/json' }), require('./routes/stripeWebhook'));
app.use('/api/billing', require('./routes/billing'));

// Other API Routes
app.use('/api/admin/login', adminSlowDown, adminRateLimit);
app.use('/api/auth', authSlowDown, require('./routes/auth'));
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
  const {
    userId,
    subscription_tier,
    status,
    createdAt,
    action,
    stripeCustomerId,
    stripeSubscriptionId,
    subscriptionStatus
  } = req.body;
  const normalizedTier = normalizeTier(subscription_tier);

  try {
    // Audit log — record every incoming sync regardless of outcome
    await pool.query(
      `INSERT INTO sync_received_log (source, event_type, payload)
       VALUES ('ivr', $1, $2)`,
      [action || 'unknown', JSON.stringify(req.body)]
    );

    if (action === 'unsubscribe') {
      await pool.query(
        `UPDATE users SET subscription_status = $1, updated_at = NOW() WHERE phone = $2`,
        ['inactive', userId]
      );
    } else if (action === 'create' || action === 'update') {
      // Check if user already exists and is claimed (has password_hash set)
      const existing = await pool.query(
        `SELECT id, password_hash FROM users WHERE phone = $1`,
        [userId]
      );

      if (existing.rows.length > 0 && existing.rows[0].password_hash) {
        // Claimed account — only update subscription fields, never touch name/email/password
        await pool.query(
          `UPDATE users
           SET subscription_tier          = $1,
               subscription_status        = $2,
               stripe_customer_id         = COALESCE($3, stripe_customer_id),
               stripe_subscription_id     = COALESCE($4, stripe_subscription_id),
               stripe_subscription_status = COALESCE($5, stripe_subscription_status),
               updated_at                 = NOW()
           WHERE phone = $6`,
          [
            normalizedTier,
            status || 'active',
            stripeCustomerId,
            stripeSubscriptionId,
            subscriptionStatus,
            userId
          ]
        );
      } else {
        // New or unclaimed user — full upsert
        await pool.query(
          `INSERT INTO users (
              phone, subscription_tier, status, created_at,
              source, stripe_customer_id, stripe_subscription_id, stripe_subscription_status
           )
           VALUES ($1, $2, $3, $4, 'ivr', $5, $6, $7)
           ON CONFLICT (phone) DO UPDATE SET
             subscription_tier          = EXCLUDED.subscription_tier,
             status                     = EXCLUDED.status,
             stripe_customer_id         = EXCLUDED.stripe_customer_id,
             stripe_subscription_id     = EXCLUDED.stripe_subscription_id,
             stripe_subscription_status = EXCLUDED.stripe_subscription_status,
             updated_at                 = NOW()`,
          [
            userId,
            normalizedTier,
            status || 'active',
            createdAt || new Date(),
            stripeCustomerId,
            stripeSubscriptionId,
            subscriptionStatus
          ]
        );
      }
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
    source = 'ivr' 
  } = req.body;

  try {
    // Audit log — record every incoming sync regardless of outcome
    await pool.query(
      `INSERT INTO sync_received_log (source, event_type, payload)
       VALUES ('ivr', $1, $2)`,
      [action || 'unknown', JSON.stringify(req.body)]
    );

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
      // Idempotency check: skip INSERT if a note with the same s3_key already exists
      const existingNote = await pool.query(
        `SELECT id FROM voice_notes WHERE user_id = $1 AND s3_key = $2`,
        [dbUserId, voiceMessage]
      );

      if (existingNote.rows.length > 0) {
        console.log(`Duplicate sync-slot ignored: user ${userId}, s3_key ${voiceMessage}`);
      } else {
        await pool.query(
          `INSERT INTO voice_notes (
             user_id, slot_number, title, description,
             s3_key, s3_bucket, recording_url,
             file_size_bytes, duration_seconds, created_at, source
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
           ON CONFLICT (user_id, slot_number) DO UPDATE SET
             title         = EXCLUDED.title,
             description   = EXCLUDED.description,
             s3_key        = EXCLUDED.s3_key,
             recording_url = EXCLUDED.recording_url,
             source        = EXCLUDED.source,
             updated_at    = NOW()`,
          [
            dbUserId,
            slotNumber,
            `Voice Note ${slotNumber || '(imported)'}`,
            null,
            voiceMessage,
            'suretalk-voicenotes-prod',
            voiceMessage,
            0,
            0,
            createdAt || new Date(),
            source
          ]
        );
      }
    } else {
      return res.status(400).json({ success: false, error: 'Invalid action' });
    }

    res.status(200).json({ success: true });
  } catch (err) {
    console.error('Sync slot error:', err);
    res.status(500).json({ success: false });
  }
});

// Receive voice will creation/deletion from IVR
app.post('/api/sync/will', syncAuth, async (req, res) => {
  const {
    userId,           // phone number from IVR
    willSlotNumber,   // will slot number
    voiceMessage,     // S3 key or recording SID
    contact,          // contact phone number
    action,           // 'create' or 'delete'
    createdAt,
    source = 'ivr'
  } = req.body;

  if (!userId || !action) {
    return res.status(400).json({ success: false, error: 'Missing userId or action' });
  }

  try {
    // 1. Find the user by phone number
    const userResult = await pool.query(
      'SELECT id FROM users WHERE phone = $1',
      [userId]
    );

    if (userResult.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'User not found' });
    }

    const dbUserId = userResult.rows[0].id;

    if (action === 'create' || action === 'update') {
      // Detect whether voiceMessage is a Twilio Recording SID or a URL/S3 key
      const isTwilioSid = voiceMessage &&
        typeof voiceMessage === 'string' &&
        voiceMessage.startsWith('RE') &&
        voiceMessage.length > 30 &&
        !voiceMessage.includes('/') &&
        !voiceMessage.includes('http');

      const s3KeyValue            = isTwilioSid ? null : (voiceMessage || null);
      const twilioRecordingSid    = isTwilioSid ? voiceMessage : null;
      const twilioSyncStatus      = isTwilioSid ? 'synced' : 'pending';

      // One-time self-heal: migrate any existing rows where SID was stored in s3_key
      pool.query(`
        UPDATE voice_wills
        SET twilio_recording_sid = s3_key,
            s3_key = null,
            twilio_sync_status = 'synced'
        WHERE s3_key LIKE 'RE%'
          AND length(s3_key) > 30
          AND s3_key NOT LIKE '%/%'
          AND s3_key NOT LIKE 'http%'
          AND twilio_recording_sid IS NULL
          AND deleted_at IS NULL
      `).catch(err => console.warn('SID migration:', err.message));

      // Check if will already exists (idempotency)
      const existing = await pool.query(
        `SELECT id FROM voice_wills
         WHERE user_id = $1 AND will_slot_number = $2 AND deleted_at IS NULL`,
        [dbUserId, willSlotNumber]
      );

      if (existing.rows.length > 0) {
        // Already exists — update it
        await pool.query(
          `UPDATE voice_wills
           SET s3_key = $1,
               twilio_recording_sid = $2,
               twilio_sync_status = $3,
               contact_phone = $4,
               updated_at = NOW()
           WHERE user_id = $5 AND will_slot_number = $6 AND deleted_at IS NULL`,
          [s3KeyValue, twilioRecordingSid, twilioSyncStatus, contact, dbUserId, willSlotNumber]
        );
      } else {
        // Insert new will
        await pool.query(
          `INSERT INTO voice_wills
            (user_id, will_slot_number, s3_key, twilio_recording_sid, twilio_sync_status,
             contact_phone, source, created_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
           ON CONFLICT DO NOTHING`,
          [dbUserId, willSlotNumber, s3KeyValue, twilioRecordingSid, twilioSyncStatus,
           contact, source, createdAt || new Date()]
        );
      }

    } else if (action === 'delete') {
      await pool.query(
        `UPDATE voice_wills 
         SET deleted_at = NOW() 
         WHERE user_id = $1 AND will_slot_number = $2`,
        [dbUserId, willSlotNumber]
      );

    } else {
      return res.status(400).json({ success: false, error: 'Invalid action' });
    }

    res.status(200).json({ success: true });

  } catch (err) {
    console.error('Sync will error:', err);
    res.status(500).json({ success: false, error: 'Internal error' });
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





// Proxy Twilio recording stream (for IVR recordings)
app.get('/api/audio/recording/:recordingSid', authenticate, async (req, res) => {
  const { recordingSid } = req.params;

  if (!recordingSid || !recordingSid.startsWith('RE')) {
    return res.status(400).json({ error: 'Invalid recording SID' });
  }

  try {
    const response = await axios({
      method: 'GET',
      url: `${EC2_STREAM_URL}/api/stream-recording/${recordingSid}`,
      responseType: 'stream',
      timeout: 30000
    });

    res.setHeader('Content-Type', 'audio/mpeg');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Accept-Ranges', 'bytes');
    response.data.pipe(res);

  } catch (error) {
    console.error('Audio proxy error:', error.message);
    res.status(500).json({ error: 'Failed to stream recording' });
  }
});

// Proxy S3 recording stream (for app recordings)
app.get('/api/audio/s3/:s3Key(*)', authenticate, async (req, res) => {
  const { s3Key } = req.params;

  if (!s3Key) {
    return res.status(400).json({ error: 'Missing S3 key' });
  }

  try {
    const response = await axios({
      method: 'GET',
      url: `${EC2_STREAM_URL}/api/stream-s3-recording/${s3Key}`,
      responseType: 'stream',
      timeout: 30000
    });

    res.setHeader('Content-Type', 'audio/mpeg');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Accept-Ranges', 'bytes');
    response.data.pipe(res);

  } catch (error) {
    console.error('S3 audio proxy error:', error.message);
    res.status(500).json({ error: 'Failed to stream recording' });
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

  const { startSyncOutboxWorker } = require('./workers/syncOutboxWorker');
  startSyncOutboxWorker();
  logger.info('Sync outbox worker started');
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