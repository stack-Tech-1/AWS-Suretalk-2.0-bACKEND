const jwt = require('jsonwebtoken');
const { pool } = require('../config/database');
const { normalizeTier } = require('../utils/tierMapping');

// Module-level store for per-user rate limiting (200 req / 15 min)
const _perUserLimits = new Map();

// Authentication middleware
const authenticate = async (req, res, next) => {
  try {
    const token = req.header('Authorization')?.replace('Bearer ', '');
    
    if (!token) {
      throw new Error('Authentication required');
    }

    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    // Check if this is an impersonation token
    if (decoded.impersonation === true) {
      const impResult = await pool.query(
        `SELECT id, is_active, expires_at FROM impersonation_tokens WHERE token = $1`,
        [token]
      );

      if (impResult.rows.length === 0 || !impResult.rows[0].is_active) {
        return res.status(401).json({ success: false, error: 'Impersonation session has ended' });
      }

      if (new Date() > new Date(impResult.rows[0].expires_at)) {
        await pool.query(
          'UPDATE impersonation_tokens SET is_active = FALSE WHERE id = $1',
          [impResult.rows[0].id]
        );
        return res.status(401).json({ success: false, error: 'Impersonation session has expired' });
      }

      req.isImpersonating = true;
      req.impersonatingAdminId = decoded.adminId;
    }

    // Check if user exists and is active
    const userQuery = await pool.query(
        `SELECT id, email, phone, full_name, subscription_tier, subscription_status, profile_image_url, is_admin FROM users WHERE id = $1 AND deleted_at IS NULL`,
        [decoded.userId]
      );
      
    if (userQuery.rows.length === 0) {
      throw new Error('User not found');
    }

    const user = userQuery.rows[0];
    user.subscription_tier = normalizeTier(user.subscription_tier);

    // Check subscription status
    if (user.subscription_status !== 'active') {
      throw new Error('Subscription not active');
    }

    req.user = user;
    req.token = token;

    // Per-user rate limit: 200 requests per 15 minutes
    const _now = Date.now();
    const _window = 15 * 60 * 1000;
    let _entry = _perUserLimits.get(user.id);
    if (!_entry || _now > _entry.resetTime) {
      _entry = { count: 0, resetTime: _now + _window };
      _perUserLimits.set(user.id, _entry);
    }
    if (_entry.count >= 200) {
      return res.status(429).json({ success: false, error: 'Rate limit exceeded. Please try again later.' });
    }
    _entry.count++;

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
      'LEGACY_VAULT_PREMIUM': 3
    };

    // If user tier doesn't exist in hierarchy, deny access
    if (!tierHierarchy[userTier]) {
      return res.status(403).json({
        success: false,
        error: `LEGACY_VAULT_PREMIUM subscription required`
      });
    }

    if (tierHierarchy[userTier] < tierHierarchy[requiredTier]) {
      return res.status(403).json({
        success: false,
        error: `LEGACY_VAULT_PREMIUM subscription required`
      });
    }

    next();
  } catch (error) {
    res.status(403).json({
      success: false,
      error: `LEGACY_VAULT_PREMIUM subscription required`
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
    const maxRequests = 200;
    
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