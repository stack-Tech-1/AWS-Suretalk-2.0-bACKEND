const jwt = require('jsonwebtoken');
const { pool } = require('../config/database');

const adminSecurity = {
  // Check admin session
  checkAdminSession: async (req, res, next) => {
    try {
      const sessionToken = req.headers['x-admin-session'];
      
      if (!sessionToken) {
        return res.status(401).json({
          success: false,
          error: 'Admin session required'
        });
      }

      // Verify session exists and is active
      const session = await pool.query(
        `SELECT us.*, u.is_admin, u.admin_status 
         FROM user_sessions us
         JOIN users u ON us.user_id = u.id
         WHERE us.session_token = $1 AND us.is_active = true 
           AND u.is_admin = true AND u.admin_status = 'approved'`,
        [sessionToken]
      );

      if (session.rows.length === 0) {
        return res.status(401).json({
          success: false,
          error: 'Invalid or expired admin session'
        });
      }

      req.adminSession = session.rows[0];
      next();
    } catch (error) {
      res.status(401).json({
        success: false,
        error: 'Session verification failed'
      });
    }
  },

  // Check admin IP
  checkAdminIP: (allowedIPs = []) => {
    return (req, res, next) => {
      const clientIP = req.ip || 
                      req.headers['x-forwarded-for']?.split(',')[0] || 
                      req.connection.remoteAddress;

      if (allowedIPs.length === 0) {
        // No IP restrictions
        return next();
      }

      const isAllowed = allowedIPs.some(allowed => {
        if (allowed.includes('/')) {
          // CIDR notation
          const [network, prefix] = allowed.split('/');
          return clientIP.startsWith(network.split('.').slice(0, parseInt(prefix)/8).join('.'));
        }
        return clientIP === allowed;
      });

      if (!isAllowed) {
        return res.status(403).json({
          success: false,
          error: 'Access denied from this IP'
        });
      }

      next();
    };
  },

  // Require re-authentication for sensitive operations
  requireReAuth: async (req, res, next) => {
    try {
      const { reauthToken } = req.body;
      
      if (!reauthToken) {
        return res.status(400).json({
          success: false,
          error: 'Re-authentication required'
        });
      }

      // Verify re-auth token (short-lived)
      const decoded = jwt.verify(reauthToken, process.env.JWT_REAUTH_SECRET || process.env.JWT_SECRET, {
        maxAge: '5m' // 5 minutes
      });

      if (decoded.userId !== req.user.id) {
        return res.status(401).json({
          success: false,
          error: 'Invalid re-authentication'
        });
      }

      next();
    } catch (error) {
      res.status(401).json({
        success: false,
        error: 'Re-authentication failed or expired'
      });
    }
  }
};

module.exports = adminSecurity;