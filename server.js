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


// Rate limiting
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  message: 'Too many requests from this IP, please try again later.'
});
app.use('/api/', limiter);

const adminRateLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10 ,
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

// CORS configuration
const corsOptions = {
  origin: process.env.NODE_ENV === 'production'
    ? ['https://suretalk.com', 'https://www.suretalk.com', 'https://admin.suretalk.com', process.env.FRONTEND_URL].filter(Boolean)
    : ['http://localhost:3000', 'http://localhost:3001'],
  credentials: true,
  optionsSuccessStatus: 200
};
app.use(cors(corsOptions));

// Body parsing
app.use(express.json({ limit: '50mb' }));
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

// API Routes

app.use('/api/admin/login', adminSlowDown, adminRateLimit);
app.use('/api/auth', require('./routes/auth'));
app.use('/api/users', require('./routes/users'));
app.use('/api/voice-notes', require('./routes/voiceNotes'));
app.use('/api/contacts', require('./routes/contacts'));
app.use('/api/vault', require('./routes/vault'));
app.use('/api/scheduled', require('./routes/scheduled'));
app.use('/api/admin', require('./routes/admin'));
app.use('/api/billing', require('./routes/billing'));
app.use('/api/settings', settingsRoutes);
app.use('/api/devices', devicesRoutes);
app.use('/api/backup', backupRoutes);
app.use('/api/notifications', require('./routes/notifications').router);
app.use('/api/storage', require('./routes/storage'));
app.use('/api/auth', require('./routes/adminAuth'));

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
  logger.info('Database connected successfully');
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
