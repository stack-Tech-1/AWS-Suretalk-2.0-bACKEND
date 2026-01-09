// utils/tokens.js
const jwt = require('jsonwebtoken');

class TokenService {
  generateEmailVerificationToken(userId, email) {
    return jwt.sign(
      {
        userId,
        email,
        purpose: 'email_verification'
      },
      process.env.JWT_SECRET,
      { expiresIn: '24h' } // 24 hour expiry
    );
  }

  verifyEmailVerificationToken(token) {
    try {
      const decoded = jwt.verify(token, process.env.JWT_SECRET);
      if (decoded.purpose !== 'email_verification') {
        throw new Error('Invalid token purpose');
      }
      return decoded;
    } catch (error) {
      throw new Error('Invalid or expired verification token');
    }
  }

  generatePasswordResetToken(userId) {
    return jwt.sign(
      {
        userId,
        purpose: 'password_reset'
      },
      process.env.JWT_SECRET,
      { expiresIn: '1h' }
    );
  }
}

module.exports = new TokenService();