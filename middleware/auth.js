const jwt = require('jsonwebtoken');
const { pool } = require('../config/database');

// Authentication middleware
const authenticate = async (req, res, next) => {
  try {
    const token = req.header('Authorization')?.replace('Bearer ', '');
    
    if (!token) {
      throw new Error('Authentication required');
    }

    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    
    // Check if user exists and is active
    const userQuery = await pool.query(
        `SELECT id, email, phone, full_name, subscription_tier, subscription_status, profile_image_url, is_admin FROM users WHERE id = $1 AND deleted_at IS NULL`,
        [decoded.userId]
      );
      
    if (userQuery.rows.length === 0) {
      throw new Error('User not found');
    }

    const user = userQuery.rows[0];
    
    // Check subscription status
    if (user.subscription_status !== 'active') {
      throw new Error('Subscription not active');
    }

    req.user = user;
    req.token = token;
    next();
  } catch (error) {
    res.status(401).json({
      success: false,
      error: 'Please authenticate'
    });
  }
};

// Admin authentication middleware
const authenticateAdmin = async (req, res, next) => {
    try {
      await authenticate(req, res, async () => {
        const adminCheck = await pool.query(
          'SELECT is_admin, admin_status FROM users WHERE id = $1',
          [req.user.id]
        );
  
        if (adminCheck.rows.length === 0) {
          return res.status(403).json({
            success: false,
            error: 'Admin access required'
          });
        }
  
        const admin = adminCheck.rows[0];
  
        if (!admin.is_admin || admin.admin_status !== 'approved') {
          return res.status(403).json({
            success: false,
            error: 'Admin access required'
          });
        }
  
        next();
      });
    } catch (error) {
      res.status(401).json({
        success: false,
        error: 'Please authenticate'
      });
    }
  };
  

// Tier validation middleware
const validateTier = (requiredTier) => async (req, res, next) => {
  try {
    const userTier = req.user.subscription_tier;
    
    // Define tier hierarchy
    const tierHierarchy = {
      'LITE': 1,
      'ESSENTIAL': 2,
      'PREMIUM': 3,
      'LEGACY_VAULT_PREMIUM': 4
    };

    if (tierHierarchy[userTier] < tierHierarchy[requiredTier]) {
      throw new Error(`Feature requires ${requiredTier} tier or higher`);
    }

    next();
  } catch (error) {
    res.status(403).json({
      success: false,
      error: error.message
    });
  }
};

// Rate limiting per user
const userRateLimit = () => {
  const userLimits = new Map();
  
  return async (req, res, next) => {
    if (!req.user) return next();
    
    const userId = req.user.id;
    const now = Date.now();
    const windowMs = 15 * 60 * 1000; // 15 minutes
    const maxRequests = 100; // Adjust based on tier
    
    let userData = userLimits.get(userId);
    
    if (!userData) {
      userData = { count: 0, resetTime: now + windowMs };
      userLimits.set(userId, userData);
    }
    
    if (now > userData.resetTime) {
      userData.count = 0;
      userData.resetTime = now + windowMs;
    }
    
    if (userData.count >= maxRequests) {
      return res.status(429).json({
        success: false,
        error: 'Rate limit exceeded. Please try again later.'
      });
    }
    
    userData.count++;
    next();
  };
};

// Analytics recording middleware
const recordAnalyticsEvent = async (req, eventType, data = {}) => {
  try {
    await pool.query(
      `INSERT INTO analytics_events (
        user_id, event_type, event_data,
        ip_address, user_agent, metadata
      ) VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        req.user?.id,
        eventType,
        JSON.stringify(data),
        req.ip,
        req.get('user-agent'),
        JSON.stringify({
          url: req.originalUrl,
          method: req.method,
          timestamp: new Date().toISOString()
        })
      ]
    );
  } catch (error) {
    console.warn('Analytics recording failed:', error);
  }
};

module.exports = {
  authenticate,
  authenticateAdmin,
  validateTier,
  userRateLimit,
  recordAnalyticsEvent
};