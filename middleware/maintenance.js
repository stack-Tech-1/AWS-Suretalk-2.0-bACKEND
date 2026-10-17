// Maintenance mode: while switched on (admin Settings page), the app's user-facing API answers 503
// so the website/app shows its maintenance screen. Admins keep full access, and everything that
// serves people outside the app keeps running.
const jwt = require('jsonwebtoken');
const { getPlatformSettings } = require('../utils/platformSettings');

// Always allowed, even during maintenance
const ALWAYS_OPEN = [
  '/api/status',            // the maintenance screen polls this
  '/api/billing/webhook',   // Stripe
  '/api/webhooks/',         // Twilio delivery callbacks
  '/api/sync/',             // IVR (phone line) sync from the Lambdas
  '/api/audio/',            // audio links in calls/SMS
  '/api/play',              // message links opened by recipients
  '/api/admin',             // admin console (routes still require an admin token)
  '/api/super-admin',
  '/api/auth/admin-login',  // admin sign-in
  '/api/auth/admin/',
];

// A valid token that says the user is an admin. Admin routes still check the database themselves.
const isAdminRequest = (req) => {
  const token = req.header('Authorization')?.replace('Bearer ', '');
  if (!token) return false;
  try {
    return jwt.verify(token, process.env.JWT_SECRET).isAdmin === true;
  } catch {
    return false;
  }
};

const maintenanceGate = async (req, res, next) => {
  if (!req.path.startsWith('/api/') || ALWAYS_OPEN.some(prefix => req.path.startsWith(prefix))) return next();

  const settings = await getPlatformSettings();
  if (!settings.maintenanceMode || isAdminRequest(req)) return next();

  res.set('Retry-After', '300');
  return res.status(503).json({
    success: false,
    maintenance: true,
    error: settings.maintenanceMessage || "We're doing some maintenance and will be back shortly."
  });
};

// Public status endpoint for the maintenance screen
const maintenanceStatus = async (req, res) => {
  const settings = await getPlatformSettings();
  res.set('Cache-Control', 'no-store');
  res.json({
    success: true,
    data: {
      maintenance: !!settings.maintenanceMode,
      message: settings.maintenanceMode ? settings.maintenanceMessage : null
    }
  });
};

module.exports = { maintenanceGate, maintenanceStatus };
