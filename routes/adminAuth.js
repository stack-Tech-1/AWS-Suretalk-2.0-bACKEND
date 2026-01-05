const express = require('express');
const router = express.Router();
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const { body, validationResult } = require('express-validator');
const { pool } = require('../config/database');
const crypto = require('crypto');
const { authenticate, authenticateAdmin } = require('../middleware/auth');

// Helper function to get client IP
const getClientIP = (req) => {
  return req.ip || 
         req.headers['x-forwarded-for']?.split(',')[0] || 
         req.connection.remoteAddress;
};

// Helper to log login attempts
const logLoginAttempt = async (email, ip, userAgent, success, failureReason = null, isAdmin = false) => {
  try {
    await pool.query(
      `INSERT INTO login_attempts 
       (email, ip_address, user_agent, success, failure_reason, is_admin_attempt)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [email, ip, userAgent, success, failureReason, isAdmin]
    );
  } catch (error) {
    console.error('Failed to log login attempt:', error);
  }
};

const isIPAllowed = (ip) => {

  // 🔓 TEMPORARY BYPASS
  if (process.env.DISABLE_ADMIN_IP_CHECK === 'true') {
    return true;
  }

  if (process.env.NODE_ENV === 'development') {
    return true;
  }

  const allowedIPs = [
    '127.0.0.1',
    '192.168.1.0/24'
  ];

  return allowedIPs.some(allowed => {
    if (allowed.includes('/')) {
      const [network, prefix] = allowed.split('/');
      return ip.startsWith(
        network.split('.').slice(0, parseInt(prefix) / 8).join('.')
      );
    }
    return ip === allowed;
  });
};


// Check if account is locked
const isAccountLocked = async (userId) => {
  const result = await pool.query(
    'SELECT account_locked_until FROM users WHERE id = $1',
    [userId]
  );
  
  if (result.rows.length === 0) return true;
  
  const lockedUntil = result.rows[0].account_locked_until;
  if (!lockedUntil) return false;
  
  return new Date(lockedUntil) > new Date();
};

// Increment failed login attempts
const incrementFailedAttempts = async (userId) => {
  await pool.query(
    `UPDATE users 
     SET failed_login_attempts = failed_login_attempts + 1,
         account_locked_until = CASE 
           WHEN failed_login_attempts >= 4 THEN CURRENT_TIMESTAMP + INTERVAL '30 minutes'
           WHEN failed_login_attempts >= 7 THEN CURRENT_TIMESTAMP + INTERVAL '2 hours'
           WHEN failed_login_attempts >= 10 THEN CURRENT_TIMESTAMP + INTERVAL '24 hours'
           ELSE account_locked_until
         END
     WHERE id = $1`,
    [userId]
  );
};

// Reset failed attempts on successful login
const resetFailedAttempts = async (userId) => {
  await pool.query(
    'UPDATE users SET failed_login_attempts = 0, account_locked_until = NULL WHERE id = $1',
    [userId]
  );
};

// Enhanced admin login with security features
router.post('/admin-login', [
  body('email').isEmail().normalizeEmail(),
  body('password').notEmpty(),
  body('captchaToken').optional().notEmpty(),
  body('twoFactorToken').optional().notEmpty()
], async (req, res) => {
  try {
    const errors = validationResult(req);
if (!errors.isEmpty()) {
  console.log('Validation errors:', errors.array()); // Add this line
  return res.status(400).json({
    success: false,
    errors: errors.array()
  });
}

    const { email, password, captchaToken, twoFactorToken } = req.body;
    const clientIP = getClientIP(req);
    const userAgent = req.get('user-agent');

    // Check IP whitelist for admin access
    if (!isIPAllowed(clientIP)) {
      await logLoginAttempt(email, clientIP, userAgent, false, 'IP not whitelisted', true);
      return res.status(403).json({
        success: false,
        error: 'Access denied from this IP'
      });
    }

    // Check recent failed attempts from this IP
    const recentFailedAttempts = await pool.query(
      `SELECT COUNT(*) as count 
       FROM login_attempts 
       WHERE ip_address = $1 AND success = false 
         AND created_at > NOW() - INTERVAL '15 minutes'
         AND is_admin_attempt = true`,
      [clientIP]
    );

    if (parseInt(recentFailedAttempts.rows[0].count) > 10) {
      return res.status(429).json({
        success: false,
        error: 'Too many failed attempts from this IP. Try again later.'
      });
    }

    // Find user
    const userQuery = await pool.query(
      `SELECT id, email, phone, full_name, password_hash, 
              subscription_tier, subscription_status, profile_image_url, 
              last_login, is_admin, admin_status, two_factor_enabled,
              two_factor_secret, failed_login_attempts, account_locked_until
       FROM users 
       WHERE email = $1 AND deleted_at IS NULL`,
      [email]
    );

    if (userQuery.rows.length === 0) {
      await logLoginAttempt(email, clientIP, userAgent, false, 'User not found', true);
      return res.status(401).json({
        success: false,
        error: 'Invalid credentials'
      });
    }

    const user = userQuery.rows[0];

    // Check if admin
    if (!user.is_admin) {
      await logLoginAttempt(email, clientIP, userAgent, false, 'Not an admin account', true);
      return res.status(403).json({
        success: false,
        error: 'Admin access required'
      });
    }

    // Check admin status
    if (user.admin_status !== 'approved') {
      await logLoginAttempt(email, clientIP, userAgent, false, 'Admin not approved', true);
      return res.status(403).json({
        success: false,
        error: user.admin_status === 'pending' 
          ? 'Admin access pending approval' 
          : 'Admin access not approved'
      });
    }

    // Check if account is locked
    if (await isAccountLocked(user.id)) {
      await logLoginAttempt(email, clientIP, userAgent, false, 'Account locked', true);
      return res.status(403).json({
        success: false,
        error: 'Account temporarily locked due to multiple failed attempts'
      });
    }

    // Check password
    const isPasswordValid = await bcrypt.compare(password, user.password_hash);
    if (!isPasswordValid) {
      await incrementFailedAttempts(user.id);
      await logLoginAttempt(email, clientIP, userAgent, false, 'Invalid password', true);
      return res.status(401).json({
        success: false,
        error: 'Invalid credentials'
      });
    }

    // If 2FA is enabled, verify token
    if (user.two_factor_enabled) {
      if (!twoFactorToken) {
        // Return temp token for 2FA step
        const tempToken = jwt.sign(
          { userId: user.id, step: '2fa_required' },
          process.env.JWT_SECRET,
          { expiresIn: '5m' }
        );
        
        return res.json({
          success: true,
          requiresTwoFactor: true,
          tempToken,
          message: '2FA token required'
        });
      }

      // Verify 2FA token
      const speakeasy = require('speakeasy');
      const verified = speakeasy.totp.verify({
        secret: user.two_factor_secret,
        encoding: 'base32',
        token: twoFactorToken
      });

      if (!verified) {
        await logLoginAttempt(email, clientIP, userAgent, false, 'Invalid 2FA token', true);
        return res.status(401).json({
          success: false,
          error: 'Invalid 2FA token'
        });
      }
    }

    // Reset failed attempts
    await resetFailedAttempts(user.id);

    // Update last login info
    await pool.query(
      `UPDATE users 
       SET last_login = CURRENT_TIMESTAMP, 
           last_login_ip = $1,
           last_login_at = CURRENT_TIMESTAMP
       WHERE id = $2`,
      [clientIP, user.id]
    );

    // Generate JWT token
    const token = jwt.sign(
      { 
        userId: user.id,
        email: user.email,
        isAdmin: true,
        tier: user.subscription_tier,
        loginIp: clientIP
      },
      process.env.JWT_SECRET,
      { expiresIn: process.env.JWT_EXPIRES_IN || '12h' } // Shorter for admin
    );

    const refreshToken = jwt.sign(
      { 
        userId: user.id,
        purpose: 'admin_refresh',
        loginIp: clientIP
      },
      process.env.JWT_REFRESH_SECRET,
      { expiresIn: '7d' }
    );

    // Remove sensitive data
    const { password_hash, two_factor_secret, ...userWithoutSensitive } = user;

    // Log successful attempt
    await logLoginAttempt(email, clientIP, userAgent, true, null, true);

    // Create admin session
    const sessionToken = crypto.randomBytes(32).toString('hex');
    await pool.query(
      `INSERT INTO user_sessions 
       (user_id, session_token, device_type, user_agent, ip_address, is_admin_session)
       VALUES ($1, $2, 'admin_console', $3, $4, true)`,
      [user.id, sessionToken, userAgent, clientIP]
    );

    res.json({
      success: true,
      message: 'Admin login successful',
      data: {
        user: userWithoutSensitive,
        token,
        refreshToken,
        sessionToken,
        sessionInfo: {
          ip: clientIP,
          device: 'Admin Console',
          timestamp: new Date().toISOString()
        }
      }
    });

  } catch (error) {
    console.error('Admin login error:', error);
    await logLoginAttempt(req.body.email, getClientIP(req), req.get('user-agent'), false, error.message, true);
    res.status(500).json({
      success: false,
      error: 'Login failed'
    });
  }
});

// 2FA setup endpoint
router.post('/admin/2fa/setup', async (req, res) => {
  try {
    const { userId } = req.body;
    
    const speakeasy = require('speakeasy');
    const qrcode = require('qrcode');
    
    const secret = speakeasy.generateSecret({
      name: `SureTalk Admin (${userId})`
    });
    
    // Save secret to user
    await pool.query(
      'UPDATE users SET two_factor_secret = $1 WHERE id = $2',
      [secret.base32, userId]
    );
    
    // Generate QR code
    const qrCodeUrl = await qrcode.toDataURL(secret.otpauth_url);
    
    res.json({
      success: true,
      data: {
        secret: secret.base32,
        qrCode: qrCodeUrl,
        backupCodes: generateBackupCodes()
      }
    });
    
  } catch (error) {
    console.error('2FA setup error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to setup 2FA'
    });
  }
});

// Generate backup codes
function generateBackupCodes() {
  const codes = [];
  for (let i = 0; i < 10; i++) {
    codes.push(crypto.randomBytes(4).toString('hex').toUpperCase());
  }
  return codes;
}


router.get('/admin-profile', authenticateAdmin, async (req, res) => {
  try {
    const userQuery = await pool.query(
      `SELECT id, email, phone, full_name, subscription_tier, subscription_status,
              profile_image_url, storage_limit_gb, contacts_limit, voice_notes_limit,
              created_at, last_login, is_admin, admin_status,
              two_factor_enabled, failed_login_attempts, account_locked_until
       FROM users WHERE id = $1`,
      [req.user.id]
    );

    if (userQuery.rows.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'User not found'
      });
    }

    // Check if user is admin
    if (!userQuery.rows[0].is_admin) {
      return res.status(403).json({
        success: false,
        error: 'Admin access required'
      });
    }

    res.json({
      success: true,
      data: userQuery.rows[0]
    });

  } catch (error) {
    console.error('Get admin profile error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch admin profile'
    });
  }
});

// Admin logout with session cleanup
router.post('/admin/logout', async (req, res) => {
  try {
    const { sessionToken } = req.body;
    
    if (sessionToken) {
      await pool.query(
        'UPDATE user_sessions SET is_active = false, ended_at = CURRENT_TIMESTAMP WHERE session_token = $1',
        [sessionToken]
      );
    }
    
    res.json({
      success: true,
      message: 'Admin session terminated'
    });
    
  } catch (error) {
    console.error('Admin logout error:', error);
    res.status(500).json({
      success: false,
      error: 'Logout failed'
    });
  }
});

module.exports = router;