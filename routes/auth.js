// C:\Users\SMC\Documents\GitHub\AWS-Suretalk-2.0-fRONTEND\surechat-backend\routes\auth.js
const express = require('express');
const router = express.Router();
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const { body, validationResult } = require('express-validator');
const { pool } = require('../config/database');
const { authenticate } = require('../middleware/auth');
const tokenService = require('../utils/tokens');
const emailService = require('../utils/emailService');
const twilio = require('twilio');
const { syncToIvr } = require('../utils/syncIvr');
const { normalizeTier, TIERS } = require('../utils/tierMapping');
const axios = require('axios');

const twilioClient = process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN
  ? twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN)
  : null;

// Validation middleware
const validateRegister = [
  body('email').isEmail().normalizeEmail(),
  body('phone').notEmpty().isLength({ min: 10 }),
  body('password').isLength({ min: 8 }),
  body('fullName').notEmpty().trim(),
  body('subscriptionTier').optional().isIn(['LITE', 'ESSENTIAL', 'PREMIUM', 'LEGACY_VAULT_PREMIUM'])
];

const validateLogin = [
  body('email').isEmail().normalizeEmail(),
  body('password').notEmpty()
];

// Register new user - UPDATED VERSION
router.post('/register', validateRegister, async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({
        success: false,
        errors: errors.array()
      });
    }

    const { email, phone, password, fullName, subscriptionTier } = req.body;

    // Check if user already exists
    const existingUser = await pool.query(
      'SELECT id FROM users WHERE email = $1 OR phone = $2',
      [email, phone]
    );

    if (existingUser.rows.length > 0) {
      return res.status(400).json({
        success: false,
        error: 'User with this email or phone already exists'
      });
    }

    // Hash password
    const saltRounds = 10;
    const passwordHash = await bcrypt.hash(password, saltRounds);

    // Set default limits based on tier
    let storageLimitGb, contactsLimit, voiceNotesLimit;
    const normalizedTier = normalizeTier(subscriptionTier || 'ESSENTIAL');
    switch (normalizedTier) {
      case TIERS.LITE:
        storageLimitGb = 1;
        contactsLimit = 3;
        voiceNotesLimit = 3;
        break;
      case TIERS.ESSENTIAL:
        storageLimitGb = 5;
        contactsLimit = 9;
        voiceNotesLimit = 100;
        break;
      case TIERS.PREMIUM:
        storageLimitGb = 50;
        contactsLimit = 50;
        voiceNotesLimit = 1000;
        break;
      default:
        storageLimitGb = 5;
        contactsLimit = 9;
        voiceNotesLimit = 100;
    }

    // Create user with email_verified = false
    const newUser = await pool.query(
      `INSERT INTO users (
        email, phone, password_hash, full_name, 
        subscription_tier, storage_limit_gb, contacts_limit, voice_notes_limit,
        subscription_status, email_verified
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'active', false)
      RETURNING id, email, phone, full_name, subscription_tier, 
                storage_limit_gb, contacts_limit, voice_notes_limit,
                created_at, email_verified`,
      [
        email,
        phone,
        passwordHash,
        fullName,
        normalizedTier,
        storageLimitGb,
        contactsLimit,
        voiceNotesLimit
      ]
    );

    const createdUser = newUser.rows[0];

    // Generate email verification token
    const verificationToken = tokenService.generateEmailVerificationToken(
      createdUser.id,
      createdUser.email
    );

    // Send verification email
    try {
      await emailService.sendVerificationEmail(
        createdUser.email,
        verificationToken,
        createdUser.full_name
      );
    } catch (emailError) {
      console.error('Failed to send verification email:', emailError);
      // Don't fail registration if email fails, but log it
      console.error('Email sending failed:', emailError);
    }

    // IMPORTANT: DO NOT AUTO-LOGIN
    // DO NOT generate JWT token here
    // User must verify email first

    res.status(201).json({
      success: true,
      message: 'Account created successfully. Please check your email to verify your account.',
      data: {
        user: {
          id: createdUser.id,
          email: createdUser.email,
          full_name: createdUser.full_name,
          email_verified: createdUser.email_verified
        },
        // Include verification token for production/testing
        ...(process.env.NODE_ENV === 'production' && { 
          verificationToken 
        })
      }
    });

  } catch (error) {
    console.error('Registration error:', error);
    res.status(500).json({
      success: false,
      error: 'Registration failed. Please try again.'
    });
  }
});




// routes/auth.js - Update login endpoint
router.post('/login', validateLogin, async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({
        success: false,
        errors: errors.array()
      });
    }

    const { email, password } = req.body;

    // Find user with email_verified field
    const userQuery = await pool.query(
      `SELECT id, email, phone, full_name, password_hash, subscription_tier, subscription_status, 
        profile_image_url, last_login, is_admin, admin_status, email_verified
        FROM users WHERE email = $1 AND deleted_at IS NULL`,
      [email]
    );

    if (userQuery.rows.length === 0) {
      return res.status(401).json({
        success: false,
        error: 'Invalid credentials'
      });
    }

    const user = userQuery.rows[0];

    // Check password
    const isPasswordValid = await bcrypt.compare(password, user.password_hash);
    if (!isPasswordValid) {
      return res.status(401).json({
        success: false,
        error: 'Invalid credentials'
      });
    }

    // IMPORTANT: Check if user is admin - admins bypass email verification
    if (user.is_admin && user.admin_status !== 'approved') {
      return res.status(403).json({
        success: false,
        error: 'Admin access pending approval'
      });
    }

    // Check email verification for regular users
    // Admins should not be blocked by email verification
    if (!user.is_admin && !user.email_verified) {
      return res.status(403).json({
        success: false,
        error: 'Please verify your email address before logging in.',
        requiresVerification: true,
        email: user.email
      });
    }

    // Check subscription status
    const validStatuses = ['active', 'trialing', 'past_due'];
    if (user.subscription_status && !validStatuses.includes(user.subscription_status)) {
      return res.status(403).json({
        success: false,
        error: 'Account is not active'
      });
    }

    // Update last login
    await pool.query(
      'UPDATE users SET last_login = CURRENT_TIMESTAMP WHERE id = $1',
      [user.id]
    );

    const token = jwt.sign(
      { 
        userId: user.id,
        email: user.email,    
        tier: user.subscription_tier,
        isAdmin: user.is_admin || false
      },
      process.env.JWT_SECRET,
      { expiresIn: process.env.JWT_EXPIRES_IN || '7d' }
    );

    const refreshToken = jwt.sign(
      { userId: user.id },
      process.env.JWT_REFRESH_SECRET,
      { expiresIn: process.env.JWT_REFRESH_EXPIRES_IN || '30d' }
    );

    // Remove password hash from response
    const { password_hash, ...userWithoutPassword } = user;
    userWithoutPassword.subscription_tier = normalizeTier(userWithoutPassword.subscription_tier);

    res.json({
      success: true,
      message: 'Login successful',
      data: {
        user: userWithoutPassword,
        token,
        refreshToken
      }
    });

  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({
      success: false,
      error: 'Login failed'
    });
  }
});

// Verify email address
router.get('/verify-email', async (req, res) => {
  try {
    const { token } = req.query;

    if (!token) {
      return res.status(400).json({
        success: false,
        error: 'Verification token is required'
      });
    }

    // Verify the token
    const decoded = tokenService.verifyEmailVerificationToken(token);
    
    // Update user's email_verified status
    const result = await pool.query(
      `UPDATE users 
       SET email_verified = true, updated_at = CURRENT_TIMESTAMP
       WHERE id = $1 AND email = $2 AND email_verified = false
       RETURNING id, email, full_name, email_verified`,
      [decoded.userId, decoded.email]
    );

    if (result.rows.length === 0) {
      return res.status(400).json({
        success: false,
        error: 'Invalid verification token or email already verified'
      });
    }

    const user = result.rows[0];

    // Send welcome email
    try {
      await emailService.sendWelcomeEmail(user.email, user.full_name);
    } catch (emailError) {
      console.error('Failed to send welcome email:', emailError);
      // Don't fail verification if welcome email fails
    }

    res.json({
      success: true,
      message: 'Email verified successfully! You can now log in to your account.',
      data: {
        user: {
          id: user.id,
          email: user.email,
          email_verified: user.email_verified
        }
      }
    });

  } catch (error) {
    console.error('Email verification error:', error);
    res.status(400).json({
      success: false,
      error: error.message || 'Invalid or expired verification token'
    });
  }
});

// Resend verification email
router.post('/resend-verification', [
  body('email').isEmail().normalizeEmail()
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({
        success: false,
        errors: errors.array()
      });
    }

    const { email } = req.body;

    // Check if user exists and email is not verified
    const userQuery = await pool.query(
      `SELECT id, email, full_name, email_verified
       FROM users WHERE email = $1 AND deleted_at IS NULL`,
      [email]
    );

    if (userQuery.rows.length === 0) {
      // Don't reveal if user exists for security
      return res.json({
        success: true,
        message: 'If an account exists with this email, a verification link has been sent'
      });
    }

    const user = userQuery.rows[0];

    // Check if already verified
    if (user.email_verified) {
      return res.status(400).json({
        success: false,
        error: 'Email is already verified'
      });
    }

    // Generate new verification token
    const verificationToken = tokenService.generateEmailVerificationToken(
      user.id,
      user.email
    );

    // Send verification email
    await emailService.sendVerificationEmail(
      user.email,
      verificationToken,
      user.full_name
    );

    res.json({
      success: true,
      message: 'Verification email sent successfully',
      data: {
        email: user.email
      }
    });

  } catch (error) {
    console.error('Resend verification error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to resend verification email'
    });
  }
});

// Refresh token
router.post('/refresh', async (req, res) => {
  try {
    const { refreshToken } = req.body;

    if (!refreshToken) {
      return res.status(400).json({
        success: false,
        error: 'Refresh token required'
      });
    }

    // Verify refresh token
    const decoded = jwt.verify(refreshToken, process.env.JWT_REFRESH_SECRET);

    // Check if user exists
    const userQuery = await pool.query(
      'SELECT id, subscription_status FROM users WHERE id = $1 AND deleted_at IS NULL',
      [decoded.userId]
    );

    if (userQuery.rows.length === 0) {
      return res.status(401).json({
        success: false,
        error: 'Invalid refresh token'
      });
    }

    // Generate new access token
    const newToken = jwt.sign(
      { userId: decoded.userId },
      process.env.JWT_SECRET,
      { expiresIn: process.env.JWT_EXPIRES_IN || '7d' }
    );

    res.json({
      success: true,
      data: {
        token: newToken
      }
    });

  } catch (error) {
    res.status(401).json({
      success: false,
      error: 'Invalid refresh token'
    });
  }
});


// Update user profile
router.put('/profile', authenticate, async (req, res) => {
  try {
    const { fullName, phone } = req.body;
    const updates = [];
    const values = [];
    let paramCount = 1;

    if (fullName) {
      updates.push(`full_name = $${paramCount}`);
      values.push(fullName);
      paramCount++;
    }

    if (phone) {
      // Check if phone is already taken
      const phoneCheck = await pool.query(
        'SELECT id FROM users WHERE phone = $1 AND id != $2',
        [phone, req.user.id]
      );

      if (phoneCheck.rows.length > 0) {
        return res.status(400).json({
          success: false,
          error: 'Phone number already in use'
        });
      }

      updates.push(`phone = $${paramCount}`);
      values.push(phone);
      paramCount++;
    }

    if (updates.length === 0) {
      return res.status(400).json({
        success: false,
        error: 'No updates provided'
      });
    }

    values.push(req.user.id);

    const query = `
      UPDATE users 
      SET ${updates.join(', ')}
      WHERE id = $${paramCount}
      RETURNING id, email, phone, full_name, subscription_tier, profile_image_url
    `;

    const result = await pool.query(query, values);

    res.json({
      success: true,
      message: 'Profile updated successfully',
      data: result.rows[0]
    });

  } catch (error) {
    console.error('Update profile error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to update profile'
    });
  }
});

// Change password
router.post('/change-password', authenticate, [
  body('currentPassword').notEmpty(),
  body('newPassword').isLength({ min: 8 })
], async (req, res) => {
  try {
    if (req.isImpersonating) {
      return res.status(403).json({ success: false, error: 'This action is not allowed during impersonation' });
    }

    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({
        success: false,
        errors: errors.array()
      });
    }

    const { currentPassword, newPassword } = req.body;

    // Get current password hash
    const userQuery = await pool.query(
      'SELECT password_hash FROM users WHERE id = $1',
      [req.user.id]
    );

    const user = userQuery.rows[0];

    // Verify current password
    const isPasswordValid = await bcrypt.compare(currentPassword, user.password_hash);
    if (!isPasswordValid) {
      return res.status(400).json({
        success: false,
        error: 'Current password is incorrect'
      });
    }

    // Hash new password
    const saltRounds = 10;
    const newPasswordHash = await bcrypt.hash(newPassword, saltRounds);

    // Update password
    await pool.query(
      'UPDATE users SET password_hash = $1 WHERE id = $2',
      [newPasswordHash, req.user.id]
    );

    res.json({
      success: true,
      message: 'Password changed successfully'
    });

  } catch (error) {
    console.error('Change password error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to change password'
    });
  }
});

// Logout (client-side token invalidation)
router.post('/logout', authenticate, async (req, res) => {
  // Note: For true logout functionality, implement token blacklist
  // This is a client-side logout (clear tokens from client)
  res.json({
    success: true,
    message: 'Logged out successfully'
  });
});

// Request password reset
router.post('/forgot-password', [
  body('email').isEmail().normalizeEmail()
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({
        success: false,
        errors: errors.array()
      });
    }

    const { email } = req.body;

    // Check if user exists
    const userQuery = await pool.query(
      'SELECT id, email, full_name FROM users WHERE email = $1 AND deleted_at IS NULL',
      [email]
    );

    if (userQuery.rows.length === 0) {
      // Don't reveal if user exists for security
      return res.json({
        success: true,
        message: 'If an account exists with this email, a reset link has been sent'
      });
    }

    const user = userQuery.rows[0];

    // Generate reset token (expires in 1 hour)
    const resetToken = jwt.sign(
      { userId: user.id, purpose: 'password_reset' },
      process.env.JWT_SECRET,
      { expiresIn: '1h' }
    );

    const resetLink = `${process.env.FRONTEND_URL}/reset-password?token=${resetToken}`;

    try {
      await emailService.sendPasswordResetEmail(user.email, resetLink, user.full_name);
    } catch (emailErr) {
      console.error('Failed to send password reset email:', emailErr);
      return res.status(500).json({
        success: false,
        error: 'Failed to send password reset email'
      });
    }

    res.json({
      success: true,
      message: 'If an account exists with this email, a reset link has been sent'
    });

  } catch (error) {
    console.error('Forgot password error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to process request'
    });
  }
});

// Reset password with token
router.post('/reset-password', [
  body('token').notEmpty(),
  body('newPassword').isLength({ min: 8 })
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({
        success: false,
        errors: errors.array()
      });
    }

    const { token, newPassword } = req.body;

    // Verify token
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    
    if (decoded.purpose !== 'password_reset') {
      return res.status(400).json({
        success: false,
        error: 'Invalid token'
      });
    }

    // Hash new password
    const saltRounds = 10;
    const newPasswordHash = await bcrypt.hash(newPassword, saltRounds);

    // Update password
    await pool.query(
      'UPDATE users SET password_hash = $1 WHERE id = $2',
      [newPasswordHash, decoded.userId]
    );

    res.json({
      success: true,
      message: 'Password reset successfully'
    });

  } catch (error) {
    if (error.name === 'TokenExpiredError') {
      return res.status(400).json({
        success: false,
        error: 'Reset token has expired'
      });
    }
    
    res.status(400).json({
      success: false,
      error: 'Invalid or expired token'
    });
  }
});

router.get('/profile', authenticate, async (req, res) => {
    try {
      const userQuery = await pool.query(
        `SELECT id, email, phone, full_name, subscription_tier, subscription_status,
                profile_image_url, storage_limit_gb, contacts_limit, voice_notes_limit,
                created_at, last_login, is_admin, admin_status  
         FROM users WHERE id = $1`,
        [req.user.id]
      );
  
      if (userQuery.rows.length === 0) {
        return res.status(404).json({
          success: false,
          error: 'User not found'
        });
      }
  
      const userData = userQuery.rows[0];
      userData.subscription_tier = normalizeTier(userData.subscription_tier);
      res.json({
        success: true,
        data: userData
      });

    } catch (error) {
      console.error('Profile error:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to fetch profile'
      });
    }
  }); 

  
  // Request admin access
router.post(
    '/admin/request',
    [
      body('email').isEmail().normalizeEmail(),
      body('phone').notEmpty().isLength({ min: 10 }),
      body('password').isLength({ min: 8 }),
      body('fullName').notEmpty().trim(),
      body('reason').notEmpty().trim(),
      body('department').optional().trim()
    ],
    async (req, res) => {
      try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
          return res.status(400).json({
            success: false,
            errors: errors.array()
          });
        }
  
        const {
          email,
          phone,
          password,
          fullName,
          subscriptionTier,
        } = req.body;
  
        // Check if user already exists
        const existingUser = await pool.query(
          'SELECT id FROM users WHERE email = $1 OR phone = $2',
          [email, phone]
        );
  
        if (existingUser.rows.length > 0) {
          return res.status(400).json({
            success: false,
            error: 'User with this email or phone already exists'
          });
        }
  
        // Hash password
        const passwordHash = await bcrypt.hash(password, 10);
  
        // Create pending admin user
        const result = await pool.query(
          `
          INSERT INTO users (
            email,
            phone,
            password_hash,
            full_name,
            is_admin,
            admin_status,
            subscription_tier
          )
          VALUES ($1, $2, $3, $4, true, 'pending', $5)
          RETURNING id, email, full_name, is_admin, admin_status, created_at
          `,
          [email, phone, passwordHash, fullName, subscriptionTier] 
        );
  
        res.status(201).json({
          success: true,
          message: 'Admin request submitted and pending approval',
          data: {
            user: result.rows[0]
          }
        });
  
      } catch (error) {
        console.error('Admin request error:', error);
        res.status(500).json({
          success: false,
          error: 'Failed to submit admin request'
        });
      }
    }
  );
  
  

// ─── IVR Account Claiming Flow ───────────────────────────────────────────────

const validateCheckPhone = [
  body('phone').notEmpty().isLength({ min: 10 })
];

const validateClaimAccount = [
  body('phone').notEmpty().isLength({ min: 10 }),
  body('otp').notEmpty().isLength({ min: 6, max: 6 }),
  body('fullName').notEmpty().trim(),
  body('email').isEmail().normalizeEmail(),
  body('password').isLength({ min: 8 })
];

// POST /api/auth/check-phone
// Check if a phone number belongs to an IVR-created (unclaimed) user
router.post('/check-phone', validateCheckPhone, async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, errors: errors.array() });
    }

    const { phone } = req.body;
    const result = await pool.query(
      'SELECT id FROM users WHERE phone = $1 AND password_hash IS NULL AND deleted_at IS NULL',
      [phone]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'No IVR account found for this phone number'
      });
    }

    return res.json({ success: true, exists: true, isIvrUser: true });
  } catch (err) {
    return res.status(500).json({ success: false, error: 'Server error' });
  }
});

// POST /api/auth/send-claim-otp
// Generate a 6-digit OTP, store hashed, send via Twilio SMS
router.post('/send-claim-otp', validateCheckPhone, async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, errors: errors.array() });
    }

    if (!twilioClient) {
      return res.status(503).json({ success: false, error: 'SMS service unavailable' });
    }

    const { phone } = req.body;

    // Verify account is IVR-created before sending OTP (prevents spam)
    const userResult = await pool.query(
      'SELECT id FROM users WHERE phone = $1 AND password_hash IS NULL AND deleted_at IS NULL',
      [phone]
    );
    if (userResult.rows.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'No IVR account found for this phone number'
      });
    }

    const otp = String(Math.floor(100000 + Math.random() * 900000));
    const otpHash = await bcrypt.hash(otp, 10);

    await pool.query(
      `INSERT INTO phone_otps (phone, otp_hash, expires_at)
       VALUES ($1, $2, NOW() + INTERVAL '10 minutes')`,
      [phone, otpHash]
    );

    // NOTE: If this times out in production, the App Runner service needs outbound internet access
    // — check VPC NAT Gateway or App Runner network settings.
    try {
      await twilioClient.messages.create({
        body: `Your SureTalk verification code is: ${otp}. Valid for 10 minutes.`,
        from: process.env.TWILIO_PHONE_NUMBER,
        to: phone
      });
    } catch (twilioErr) {
      console.error('Twilio error:', {
        code: twilioErr.code,
        message: twilioErr.message,
        status: twilioErr.status,
        moreInfo: twilioErr.moreInfo,
        stack: twilioErr.stack
      });
      const connectivityCodes = ['ECONNABORTED', 'ECONNREFUSED', 'ETIMEDOUT'];
      if (connectivityCodes.includes(twilioErr.code)) {
        console.error('Twilio connectivity error:', twilioErr.code, twilioErr.message);
        return res.status(503).json({ success: false, error: 'SMS gateway unreachable. Please contact support.' });
      }
      throw twilioErr;
    }

    return res.json({ success: true, message: 'OTP sent to your phone number' });
  } catch (err) {
    console.error('send-claim-otp error:', err);
    return res.status(500).json({ success: false, error: err.message, stack: process.env.NODE_ENV !== 'production' ? err.stack : undefined });
  }
});

// POST /api/auth/claim-account
// Verify OTP and complete account setup; returns JWT on success
router.post('/claim-account', validateClaimAccount, async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, errors: errors.array() });
    }

    const { phone, otp, fullName, email, password } = req.body;

    // 1. Verify user is IVR-created (unclaimed)
    const userResult = await pool.query(
      `SELECT id, subscription_tier, is_admin FROM users
       WHERE phone = $1 AND password_hash IS NULL AND deleted_at IS NULL`,
      [phone]
    );
    if (userResult.rows.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'No IVR account found for this phone number'
      });
    }
    const ivrUser = userResult.rows[0];

    // 2. Find latest valid, unused OTP
    const otpResult = await pool.query(
      `SELECT id, otp_hash FROM phone_otps
       WHERE phone = $1 AND expires_at > NOW() AND used_at IS NULL
       ORDER BY created_at DESC LIMIT 1`,
      [phone]
    );
    if (otpResult.rows.length === 0) {
      return res.status(400).json({ success: false, error: 'OTP expired or not found' });
    }
    const otpRow = otpResult.rows[0];

    // 3. Verify OTP
    const otpValid = await bcrypt.compare(otp, otpRow.otp_hash);
    if (!otpValid) {
      return res.status(400).json({ success: false, error: 'Invalid OTP' });
    }

    // 4. Mark OTP as used
    await pool.query('UPDATE phone_otps SET used_at = NOW() WHERE id = $1', [otpRow.id]);

    // 5. Check email uniqueness
    const emailCheck = await pool.query(
      'SELECT id FROM users WHERE email = $1 AND id != $2',
      [email, ivrUser.id]
    );
    if (emailCheck.rows.length > 0) {
      return res.status(409).json({ success: false, error: 'Email already in use' });
    }

    // 6. Hash password and update user record
    const passwordHash = await bcrypt.hash(password, 10);
    const updatedUser = await pool.query(
      `UPDATE users
       SET full_name = $1, email = $2, password_hash = $3,
           email_verified = TRUE, source = 'app', updated_at = NOW()
       WHERE id = $4
       RETURNING id, email, full_name, subscription_tier, is_admin`,
      [fullName, email, passwordHash, ivrUser.id]
    );
    const user = updatedUser.rows[0];

    // 7. Fire-and-forget sync to IVR DynamoDB
    syncToIvr({ userId: user.id, email, fullName, phone, source: 'app' }, 'sync-user');

    // 8. Generate JWT (same pattern as login)
    const token = jwt.sign(
      {
        userId: user.id,
        email: user.email,
        tier: user.subscription_tier,
        isAdmin: user.is_admin || false
      },
      process.env.JWT_SECRET,
      { expiresIn: process.env.JWT_EXPIRES_IN || '7d' }
    );
    const refreshToken = jwt.sign(
      { userId: user.id },
      process.env.JWT_REFRESH_SECRET,
      { expiresIn: process.env.JWT_REFRESH_EXPIRES_IN || '30d' }
    );

    return res.json({
      success: true,
      message: 'Account claimed successfully',
      data: {
        user: {
          id: user.id,
          email: user.email,
          fullName: user.full_name,
          subscriptionTier: user.subscription_tier,
          isAdmin: user.is_admin
        },
        token,
        refreshToken
      }
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: 'Server error' });
  }
});

router.get('/test-twilio-account', async (req, res) => {
  if (!twilioClient) {
    return res.status(500).json({ error: 'Twilio client not initialized' });
  }
  try {
    const account = await twilioClient.api.accounts(process.env.TWILIO_ACCOUNT_SID).fetch();
    res.json({ success: true, account: { status: account.status, friendlyName: account.friendlyName } });
  } catch (err) {
    res.status(500).json({ error: err.message, code: err.code });
  }
});



router.post('/test-twilio-messages', async (req, res) => {
  const auth = Buffer.from(`${process.env.TWILIO_ACCOUNT_SID}:${process.env.TWILIO_AUTH_TOKEN}`).toString('base64');
  const url = `https://api.twilio.com/2010-04-01/Accounts/${process.env.TWILIO_ACCOUNT_SID}/Messages.json`;
  const data = new URLSearchParams({
    To: '+1234567890', // dummy number
    From: process.env.TWILIO_PHONE_NUMBER,
    Body: 'Test'
  });
  try {
    const response = await axios.post(url, data, {
      headers: {
        'Authorization': `Basic ${auth}`,
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      timeout: 30000
    });
    res.json({ success: true, data: response.data });
  } catch (err) {
    res.status(500).json({ error: err.message, code: err.code });
  }
});

module.exports = router;