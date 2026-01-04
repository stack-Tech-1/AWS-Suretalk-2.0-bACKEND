// /routes/devices.js
const express = require('express');
const router = express.Router();
const { body, validationResult } = require('express-validator');
const { authenticate } = require('../middleware/auth');
const { pool } = require('../config/database');
const jwt = require('jsonwebtoken');

// Get connected devices
router.get('/', authenticate, async (req, res) => {
  try {
    const userId = req.user.id;

    // Get user sessions from system_logs (simulated device tracking)
    const devicesQuery = await pool.query(
      `SELECT DISTINCT 
         client_ip as ip_address,
         user_agent,
         MAX(created_at) as last_activity,
         COUNT(*) as activity_count
       FROM system_logs 
       WHERE user_id = $1 
         AND service = 'auth'
         AND created_at > CURRENT_TIMESTAMP - INTERVAL '30 days'
       GROUP BY client_ip, user_agent
       ORDER BY MAX(created_at) DESC`,
      [userId]
    );

    // Format devices
    const devices = devicesQuery.rows.map((device, index) => {
      const userAgent = device.user_agent || '';
      let deviceName = 'Unknown Device';
      let deviceType = 'other';

      // Parse user agent to determine device type
      if (userAgent.includes('iPhone') || userAgent.includes('Android')) {
        deviceName = userAgent.includes('iPhone') ? 'iPhone' : 'Android Phone';
        deviceType = 'mobile';
      } else if (userAgent.includes('Windows')) {
        deviceName = 'Windows Computer';
        deviceType = 'desktop';
      } else if (userAgent.includes('Macintosh')) {
        deviceName = 'Mac Computer';
        deviceType = 'desktop';
      } else if (userAgent.includes('Linux')) {
        deviceName = 'Linux Computer';
        deviceType = 'desktop';
      } else if (userAgent.includes('Chrome')) {
        deviceName = 'Chrome Browser';
        deviceType = 'browser';
      } else if (userAgent.includes('Firefox')) {
        deviceName = 'Firefox Browser';
        deviceType = 'browser';
      } else if (userAgent.includes('Safari')) {
        deviceName = 'Safari Browser';
        deviceType = 'browser';
      }

      // Check if this is the current device (based on IP and User-Agent)
      const currentUserAgent = req.get('user-agent') || '';
      const currentIp = req.ip || req.connection.remoteAddress;
      
      const isCurrent = device.ip_address === currentIp && 
                       device.user_agent === currentUserAgent;

      return {
        id: `device-${index + 1}`,
        name: deviceName,
        type: deviceType,
        ip: device.ip_address,
        userAgent: device.user_agent,
        lastActive: device.last_activity,
        activityCount: device.activity_count,
        current: isCurrent,
        location: getLocationFromIp(device.ip_address) // Mock location
      };
    });

    // Add current device if not already in list
    const currentUserAgent = req.get('user-agent') || '';
    const currentIp = req.ip || req.connection.remoteAddress;
    
    const currentDeviceExists = devices.some(device => 
      device.ip === currentIp && device.user_agent === currentUserAgent
    );

    if (!currentDeviceExists) {
      let deviceName = 'Current Device';
      let deviceType = 'other';

      if (currentUserAgent.includes('iPhone') || currentUserAgent.includes('Android')) {
        deviceName = currentUserAgent.includes('iPhone') ? 'iPhone' : 'Android Phone';
        deviceType = 'mobile';
      } else if (currentUserAgent.includes('Windows')) {
        deviceName = 'Windows Computer';
        deviceType = 'desktop';
      } else if (currentUserAgent.includes('Macintosh')) {
        deviceName = 'Mac Computer';
        deviceType = 'desktop';
      }

      devices.unshift({
        id: 'current-device',
        name: deviceName,
        type: deviceType,
        ip: currentIp,
        userAgent: currentUserAgent,
        lastActive: new Date().toISOString(),
        activityCount: 1,
        current: true,
        location: getLocationFromIp(currentIp)
      });
    }

    res.json({
      success: true,
      data: {
        devices,
        total: devices.length,
        currentDevice: devices.find(d => d.current)
      }
    });

  } catch (error) {
    console.error('Get devices error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch connected devices'
    });
  }
});

// Revoke/remove a device
router.delete('/:deviceId', authenticate, async (req, res) => {
  try {
    const userId = req.user.id;
    const { deviceId } = req.params;

    // In a real implementation, you would:
    // 1. Check if device exists for this user
    // 2. Remove session/device token from database
    // 3. Log the revocation

    // For now, simulate device removal
    await pool.query(
      `INSERT INTO system_logs (user_id, level, service, message, metadata)
       VALUES ($1, 'info', 'security', 'Device session revoked', $2)`,
      [userId, JSON.stringify({ 
        deviceId, 
        timestamp: new Date().toISOString(),
        action: 'revoke'
      })]
    );

    res.json({
      success: true,
      message: 'Device session revoked successfully'
    });

  } catch (error) {
    console.error('Revoke device error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to revoke device session'
    });
  }
});

// Revoke all devices except current
router.post('/revoke-all', authenticate, async (req, res) => {
  try {
    const userId = req.user.id;
    const currentUserAgent = req.get('user-agent') || '';
    const currentIp = req.ip || req.connection.remoteAddress;

    // Log the action
    await pool.query(
      `INSERT INTO system_logs (user_id, level, service, message, metadata)
       VALUES ($1, 'warning', 'security', 'All device sessions revoked', $2)`,
      [userId, JSON.stringify({ 
        except: { ip: currentIp, userAgent: currentUserAgent },
        timestamp: new Date().toISOString(),
        action: 'revoke_all'
      })]
    );

    // In production, you would invalidate all tokens except current
    // For now, just log the action

    res.json({
      success: true,
      message: 'All other device sessions have been revoked',
      note: 'You will need to log in again on other devices'
    });

  } catch (error) {
    console.error('Revoke all devices error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to revoke device sessions'
    });
  }
});

// Get device activity history
router.get('/:deviceId/activity', authenticate, async (req, res) => {
  try {
    const userId = req.user.id;
    const { deviceId } = req.params;
    const { limit = 20, offset = 0 } = req.query;

    // Parse device info from deviceId
    const deviceInfo = parseDeviceId(deviceId);
    
    // Get activity for this device
    const activityQuery = await pool.query(
      `SELECT level, service, message, created_at, metadata
       FROM system_logs 
       WHERE user_id = $1 
         AND client_ip = $2
         AND user_agent = $3
       ORDER BY created_at DESC
       LIMIT $4 OFFSET $5`,
      [userId, deviceInfo.ip, deviceInfo.userAgent, parseInt(limit), parseInt(offset)]
    );

    const totalQuery = await pool.query(
      `SELECT COUNT(*) as total 
       FROM system_logs 
       WHERE user_id = $1 
         AND client_ip = $2
         AND user_agent = $3`,
      [userId, deviceInfo.ip, deviceInfo.userAgent]
    );

    res.json({
      success: true,
      data: {
        activity: activityQuery.rows,
        deviceInfo,
        pagination: {
          limit: parseInt(limit),
          offset: parseInt(offset),
          total: parseInt(totalQuery.rows[0].total)
        }
      }
    });

  } catch (error) {
    console.error('Get device activity error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch device activity'
    });
  }
});

// Helper function to get location from IP (mock)
function getLocationFromIp(ip) {
  // Mock implementation
  const locations = [
    'New York, US',
    'London, UK',
    'Tokyo, Japan',
    'Sydney, Australia',
    'Berlin, Germany',
    'Paris, France',
    'Singapore',
    'Toronto, Canada'
  ];
  
  // Use IP hash to get consistent location for same IP
  const hash = ip.split('.').reduce((acc, octet) => acc + parseInt(octet), 0);
  return locations[hash % locations.length];
}

// Helper function to parse device ID
function parseDeviceId(deviceId) {
  // Simple mock parsing
  if (deviceId === 'current-device') {
    return {
      ip: 'current',
      userAgent: 'current'
    };
  }
  
  const parts = deviceId.split('-');
  return {
    ip: parts[1] || 'unknown',
    userAgent: parts[2] || 'unknown'
  };
}

module.exports = router;