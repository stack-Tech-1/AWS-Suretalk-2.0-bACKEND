// utils/emailService.js
const AWS = require('aws-sdk');
const logger = require('./logger');

class EmailService {
  constructor() {
    // AWS SES configuration
    this.ses = new AWS.SES({
      region: process.env.AWS_REGION || 'us-east-1',
      accessKeyId: process.env.AWS_ACCESS_KEY_ID,
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY
    });
    
    this.fromEmail = process.env.SES_FROM_EMAIL;
    this.siteUrl = process.env.FRONTEND_URL || 'http://localhost:3000';
  }

  async sendVerificationEmail(toEmail, verificationToken, userName) {
    try {
      const verificationLink = `${this.siteUrl}/verify-email?token=${verificationToken}`;
      
      const params = {
        Destination: {
          ToAddresses: [toEmail]
        },
        Message: {
          Body: {
            Html: {
              Charset: 'UTF-8',
              Data: this.getVerificationEmailHtml(userName, verificationLink, toEmail)
            },
            Text: {
              Charset: 'UTF-8',
              Data: this.getVerificationEmailText(userName, verificationLink)
            }
          },
          Subject: {
            Charset: 'UTF-8',
            Data: 'Verify Your SureTalk Account'
          }
        },
        Source: this.fromEmail
      };

      const result = await this.ses.sendEmail(params).promise();
      logger.info(`Verification email sent to ${toEmail}: ${result.MessageId}`);
      return result;
    } catch (error) {
      logger.error('Failed to send verification email:', error);
      throw error;
    }
  }

  getVerificationEmailHtml(userName, verificationLink, toEmail) {
    return `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="UTF-8">
        <style>
          body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; }
          .container { max-width: 600px; margin: 0 auto; padding: 20px; }
          .header { background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); padding: 30px; text-align: center; color: white; }
          .content { padding: 30px; background: #f9f9f9; }
          .button { display: inline-block; padding: 12px 30px; background: #667eea; color: white; text-decoration: none; border-radius: 5px; font-weight: bold; }
          .footer { text-align: center; padding: 20px; color: #666; font-size: 12px; }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="header">
            <h1>Welcome to SureTalk!</h1>
          </div>
          <div class="content">
            <h2>Hi ${userName},</h2>
            <p>Thank you for creating an account with SureTalk. To start using your account, please verify your email address by clicking the button below:</p>
            <p style="text-align: center; margin: 30px 0;">
              <a href="${verificationLink}" class="button">Verify Email Address</a>
            </p>
            <p>Or copy and paste this link into your browser:</p>
            <p style="word-break: break-all; color: #666;">${verificationLink}</p>
            <p>This link will expire in 24 hours.</p>
            <p>If you didn't create this account, you can safely ignore this email.</p>
          </div>
          <div class="footer">
            <p>© ${new Date().getFullYear()} SureTalk. All rights reserved.</p>
            <p>This email was sent to ${toEmail}</p>
          </div>
        </div>
      </body>
      </html>
    `;
  }

  getVerificationEmailText(userName, verificationLink) {
    return `
      Welcome to SureTalk!
      
      Hi ${userName},
      
      Thank you for creating an account with SureTalk. To start using your account, please verify your email address by clicking the link below:
      
      ${verificationLink}
      
      This link will expire in 24 hours.
      
      If you didn't create this account, you can safely ignore this email.
      
      © ${new Date().getFullYear()} SureTalk. All rights reserved.
    `;
  }

  async sendWelcomeEmail(toEmail, userName) {
    // Optional: Send welcome email after verification
    try {
      const params = {
        Destination: {
          ToAddresses: [toEmail]
        },
        Message: {
          Body: {
            Html: {
              Charset: 'UTF-8',
              Data: `
                <h1>Welcome to SureTalk, ${userName}!</h1>
                <p>Your email has been verified successfully.</p>
                <p>You can now log in and start using all the features of SureTalk.</p>
              `
            }
          },
          Subject: {
            Charset: 'UTF-8',
            Data: 'Welcome to SureTalk!'
          }
        },
        Source: this.fromEmail
      };

      await this.ses.sendEmail(params).promise();
      logger.info(`Welcome email sent to ${toEmail}`);
    } catch (error) {
      logger.error('Failed to send welcome email:', error);
      // Don't throw error for welcome email - it's not critical
    }
  }
}

module.exports = new EmailService();