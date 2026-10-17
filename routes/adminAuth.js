const express = require('express');
const router = express.Router();
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const { body, validationResult } = require('express-validator');
const { pool } = require('../config/database');
const crypto = require('crypto');
const { authenticate, authenticateAdmin, isAccountSuspended } = require('../middleware/auth');

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
           WHEN failed_login_attempts >= 10 THEN CURRENT_TIMESTAMP + INTERVAL '24 hours'
           WHEN failed_login_attempts >= 7 THEN CURRENT_TIMESTAMP + INTERVAL '2 hours'
           WHEN failed_login_attempts >= 4 THEN CURRENT_TIMESTAMP + INTERVAL '30 minutes'
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
  body('captchaToken').optional().notEmpty()
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

    const { email, password } = req.body;
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

    // Check if account is locked
    if (await isAccountLocked(user.id)) {
      await logLoginAttempt(email, clientIP, userAgent, false, 'Account locked', true);
      return res.status(403).json({
        success: false,
        error: 'Account temporarily locked due to multiple failed attempts',
        lockedUntil: user.account_locked_until
      });
    }

    // Check password before revealing anything about the account's admin status
    const isPasswordValid = await bcrypt.compare(password, user.password_hash);
    if (!isPasswordValid) {
      await incrementFailedAttempts(user.id);
      await logLoginAttempt(email, clientIP, userAgent, false, 'Invalid password', true);
      return res.status(401).json({
        success: false,
        error: 'Invalid credentials'
      });
    }

    if (await isAccountSuspended(user.id)) {
      await logLoginAttempt(email, clientIP, userAgent, false, 'Account suspended', true);
      return res.status(403).json({ success: false, code: 'ACCOUNT_SUSPENDED', error: 'This account has been suspended.' });
    }

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

    // If 2FA is enabled, issue a short-lived temp token for the code step (/admin-login/2fa)
    if (user.two_factor_enabled) {
      const tempToken = jwt.sign(
        { userId: user.id, step: 'admin_2fa_required' },
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

    await issueAdminSession(user, clientIP, userAgent, res);

  } catch (error) {
    console.error('Admin login error:', error);
    await logLoginAttempt(req.body.email, getClientIP(req), req.get('user-agent'), false, error.message, true);
    res.status(500).json({
      success: false,
      error: 'Login failed'
    });
  }
});

// Admin login step 2 — exchanges the temp token + authenticator code (or a backup code) for the admin session
router.post('/admin-login/2fa', [
  body('tempToken').notEmpty(),
  body('code').isString().trim().notEmpty()
], async (req, res) => {
  const clientIP = getClientIP(req);
  const userAgent = req.get('user-agent');
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, error: 'Enter your 6-digit code' });
    }

    let payload;
    try {
      payload = jwt.verify(req.body.tempToken, process.env.JWT_SECRET);
    } catch {
      return res.status(401).json({ success: false, error: 'Session expired. Please sign in again.' });
    }
    if (payload.step !== 'admin_2fa_required') {
      return res.status(401).json({ success: false, error: 'Session expired. Please sign in again.' });
    }

    const userQuery = await pool.query(
      `SELECT id, email, phone, full_name, password_hash,
              subscription_tier, subscription_status, profile_image_url,
              last_login, is_admin, admin_status, two_factor_enabled,
              two_factor_secret, two_factor_backup_codes, failed_login_attempts, account_locked_until
       FROM users
       WHERE id = $1 AND deleted_at IS NULL`,
      [payload.userId]
    );
    const user = userQuery.rows[0];
    if (!user || !user.is_admin || user.admin_status !== 'approved' || !user.two_factor_enabled) {
      return res.status(403).json({ success: false, error: 'Admin access required' });
    }

    if (await isAccountLocked(user.id)) {
      await logLoginAttempt(user.email, clientIP, userAgent, false, 'Account locked', true);
      return res.status(403).json({
        success: false,
        error: 'Account temporarily locked due to multiple failed attempts',
        lockedUntil: user.account_locked_until
      });
    }

    const code = req.body.code.replace(/\s+/g, '');
    let verified = false;

    if (/^\d{6}$/.test(code)) {
      const speakeasy = require('speakeasy');
      verified = speakeasy.totp.verify({
        secret: user.two_factor_secret,
        encoding: 'base32',
        token: code,
        window: 1
      });
    } else {
      // Backup code — each one works once
      let storedCodes = user.two_factor_backup_codes || [];
      if (typeof storedCodes === 'string') {
        try { storedCodes = JSON.parse(storedCodes); } catch { storedCodes = []; }
      }
      const hashed = crypto.createHash('sha256').update(code.toUpperCase()).digest('hex');
      if (Array.isArray(storedCodes) && storedCodes.includes(hashed)) {
        verified = true;
        await pool.query(
          'UPDATE users SET two_factor_backup_codes = $1 WHERE id = $2',
          [JSON.stringify(storedCodes.filter(c => c !== hashed)), user.id]
        );
      }
    }

    if (!verified) {
      await incrementFailedAttempts(user.id);
      await logLoginAttempt(user.email, clientIP, userAgent, false, 'Invalid 2FA token', true);
      return res.status(401).json({ success: false, error: 'Invalid code' });
    }

    await issueAdminSession(user, clientIP, userAgent, res);

  } catch (error) {
    console.error('Admin 2FA login error:', error);
    res.status(500).json({ success: false, error: 'Verification failed' });
  }
});

// Creates the admin session after all checks pass and sends the tokens
async function issueAdminSession(user, clientIP, userAgent, res) {
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
  const { password_hash, two_factor_secret, two_factor_backup_codes, ...userWithoutSensitive } = user;

  // Log successful attempt
  await logLoginAttempt(user.email, clientIP, userAgent, true, null, true);

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

// Counts the unused backup codes stored for a user (stored as a JSON array of hashes)
const countBackupCodes = (stored) => {
  let codes = stored || [];
  if (typeof codes === 'string') {
    try { codes = JSON.parse(codes); } catch { codes = []; }
  }
  return Array.isArray(codes) ? codes.length : 0;
};

// The signed-in admin's 2FA status (setup / turning off use the shared /auth/2fa routes)
router.get('/admin/2fa/status', authenticateAdmin, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT two_factor_enabled, two_factor_backup_codes FROM users WHERE id = $1',
      [req.user.id]
    );
    const row = result.rows[0] || {};
    res.json({
      success: true,
      data: {
        enabled: !!row.two_factor_enabled,
        backupCodesRemaining: row.two_factor_enabled ? countBackupCodes(row.two_factor_backup_codes) : 0
      }
    });
  } catch (error) {
    console.error('Admin 2FA status error:', error);
    res.status(500).json({ success: false, error: 'Failed to load 2FA status' });
  }
});

// Replace the signed-in admin's backup codes (needs a current authenticator code)
router.post('/admin/2fa/backup-codes', authenticateAdmin, [
  body('token').matches(/^\d{6}$/)
], async (req, res) => {
  try {
    if (!validationResult(req).isEmpty()) {
      return res.status(400).json({ success: false, error: 'Enter the 6-digit code from your authenticator app' });
    }
    const result = await pool.query(
      'SELECT two_factor_enabled, two_factor_secret FROM users WHERE id = $1',
      [req.user.id]
    );
    const row = result.rows[0];
    if (!row?.two_factor_enabled || !row.two_factor_secret) {
      return res.status(400).json({ success: false, error: '2FA is not turned on' });
    }

    const speakeasy = require('speakeasy');
    const valid = speakeasy.totp.verify({ secret: row.two_factor_secret, encoding: 'base32', token: req.body.token, window: 1 });
    if (!valid) return res.status(400).json({ success: false, error: 'Invalid code' });

    const backupCodes = Array.from({ length: 10 }, () => crypto.randomBytes(4).toString('hex').toUpperCase());
    await pool.query(
      'UPDATE users SET two_factor_backup_codes = $1 WHERE id = $2',
      [JSON.stringify(backupCodes.map(c => crypto.createHash('sha256').update(c).digest('hex'))), req.user.id]
    );

    res.json({ success: true, data: { backupCodes } });
  } catch (error) {
    console.error('Admin backup codes error:', error);
    res.status(500).json({ success: false, error: 'Failed to create new backup codes' });
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