const jwt = require('jsonwebtoken');
const { pool } = require('../config/database');
const { normalizeTier } = require('../utils/tierMapping');
const { getPlatformSettings } = require('../utils/platformSettings');

// Module-level store for per-user rate limiting (PER_USER_LIMIT req / 15 min).
// A normal session can make many requests (the dashboard loads ~7 at once, the voice notes list
// fetches a link per note), so this only stops runaway clients and scripted abuse.
// PER_USER_RATE_LIMIT lets a staging copy raise the limit for load tests
const PER_USER_LIMIT = Number(process.env.PER_USER_RATE_LIMIT) || 1000;
const _perUserLimits = new Map();

// Records users.last_active_at (migration 011) at most once per 5 minutes per user,
// for the admin dashboard's "Active now". Never blocks or fails the request.
const ACTIVITY_WRITE_MS = 5 * 60 * 1000;
const _lastActivityWrite = new Map();
const recordActivity = (userId) => {
  const now = Date.now();
  if (now - (_lastActivityWrite.get(userId) || 0) < ACTIVITY_WRITE_MS) return;
  _lastActivityWrite.set(userId, now);
  if (_lastActivityWrite.size > 50000) _lastActivityWrite.clear();
  pool.query('UPDATE users SET last_active_at = CURRENT_TIMESTAMP WHERE id = $1', [userId]).catch(() => {});
};

// Loads the signed-in user. Includes is_suspended (migration 016); if that column doesn't exist yet,
// falls back to the query without it so deploying before the migration can't lock everyone out.
let suspensionColumn = true;
const loadUserForAuth = async (userId) => {
  const base = `id, email, phone, full_name, subscription_tier, subscription_status, profile_image_url, is_admin, last_logout_at`;
  if (suspensionColumn) {
    try {
      return await pool.query(`SELECT ${base}, COALESCE(is_suspended, false) AS is_suspended FROM users WHERE id = $1 AND deleted_at IS NULL`, [userId]);
    } catch (err) {
      if (err.code !== '42703') throw err;
      suspensionColumn = false;
      console.warn('users.is_suspended missing — run migration 016 to enable account suspension');
    }
  }
  return pool.query(`SELECT ${base} FROM users WHERE id = $1 AND deleted_at IS NULL`, [userId]);
};

// True when an account is suspended (for sign-in routes). Missing column = not suspended.
const isAccountSuspended = async (userId) => {
  try {
    return !!(await pool.query('SELECT COALESCE(is_suspended, false) AS s FROM users WHERE id = $1', [userId])).rows[0]?.s;
  } catch (err) {
    if (err.code === '42703') return false;
    throw err;
  }
};

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
    const userQuery = await loadUserForAuth(decoded.userId);

    if (userQuery.rows.length === 0) {
      throw new Error('User not found');
    }

    const user = userQuery.rows[0];
    user.subscription_tier = normalizeTier(user.subscription_tier);

    // Reject tokens issued before the user's last logout (server-side invalidation)
    if (user.last_logout_at && decoded.iat) {
      const tokenIssuedAt = decoded.iat * 1000; // JWT iat is in seconds
      if (tokenIssuedAt < new Date(user.last_logout_at).getTime()) {
        return res.status(401).json({ success: false, error: 'Session expired. Please log in again.' });
      }
    }

    // Suspended by an admin (Users page "Deactivate" or super admin "Suspend") — blocked everywhere.
    // Impersonation sessions are already refused for suspended accounts when they start.
    if (user.is_suspended) {
      return res.status(403).json({
        success: false,
        code: 'ACCOUNT_SUSPENDED',
        error: 'This account has been suspended. Please contact SureTalk support.'
      });
    }

    // Check subscription status
    const validStatuses = ['active', 'trialing', 'past_due'];
    if (user.subscription_status && !validStatuses.includes(user.subscription_status)) {
      throw new Error('Subscription not active');
    }

    req.user = user;
    req.token = token;

    // Per-user rate limit: PER_USER_LIMIT requests per 15 minutes
    const _now = Date.now();
    const _window = 15 * 60 * 1000;
    let _entry = _perUserLimits.get(user.id);
    if (!_entry || _now > _entry.resetTime) {
      _entry = { count: 0, resetTime: _now + _window };
      _perUserLimits.set(user.id, _entry);
    }
    if (_entry.count >= PER_USER_LIMIT) {
      return res.status(429).json({ success: false, error: 'Rate limit exceeded. Please try again later.' });
    }
    _entry.count++;

    if (!req.isImpersonating) recordActivity(user.id);

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
          'SELECT is_admin, admin_status, two_factor_enabled FROM users WHERE id = $1',
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

        // "Require 2FA for all admins" (Settings page): until this admin turns 2FA on, only the
        // 2FA status check works; setting 2FA up uses /api/auth/2fa/*, which isn't admin-gated
        if (!admin.two_factor_enabled && !req.originalUrl.startsWith('/api/auth/admin/2fa/status')) {
          const { require2FA } = await getPlatformSettings();
          if (require2FA) {
            return res.status(403).json({
              success: false,
              code: 'ADMIN_2FA_REQUIRED',
              error: 'Two-step verification is required for admin accounts. Turn it on to continue.'
            });
          }
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
  isAccountSuspended,
  authenticate,
  authenticateAdmin,
  validateTier,
  userRateLimit,
  recordAnalyticsEvent
};