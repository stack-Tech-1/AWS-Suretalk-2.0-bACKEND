// Cloudflare Turnstile bot check for abuse-prone public endpoints (signup, password reset, SMS codes).
// The frontend sends the widget token as `turnstileToken` in the JSON body.
// Disabled until TURNSTILE_SECRET_KEY is set, so deploying before Cloudflare is configured is safe.
const axios = require('axios');

const VERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

const requireTurnstile = async (req, res, next) => {
  const secret = process.env.TURNSTILE_SECRET_KEY;
  if (!secret) return next();

  const token = req.body?.turnstileToken;
  if (!token) {
    return res.status(400).json({ success: false, error: 'Please complete the security check and try again.', code: 'TURNSTILE_REQUIRED' });
  }

  try {
    const params = new URLSearchParams({ secret, response: token, remoteip: req.ip || '' });
    const { data } = await axios.post(VERIFY_URL, params, { timeout: 5000 });
    if (data?.success) return next();
    return res.status(400).json({ success: false, error: 'Security check failed. Please try again.', code: 'TURNSTILE_FAILED' });
  } catch (err) {
    // If Cloudflare is unreachable, let the request through rather than locking real users out;
    // the per-IP rate limits still apply.
    console.error('Turnstile verification unavailable:', err.message);
    return next();
  }
};

module.exports = { requireTurnstile };
