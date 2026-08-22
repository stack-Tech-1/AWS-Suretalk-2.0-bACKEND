// utils/emailService.js
const AWS = require('aws-sdk');
const logger = require('./logger');

// ─── Brand tokens ────────────────────────────────────────────────────────────
const BRAND = {
  navy:    '#0C1128',
  blue:    '#5371FF',
  coral:   '#FF5758',
  bg:      '#FAF9F7',
  muted:   '#6B7280',
  surface: '#FFFFFF',
  year:    new Date().getFullYear()
};

class EmailService {
  constructor() {
    this.ses = new AWS.SES({
      region: process.env.AWS_SES_REGION || process.env.AWS_REGION,
      accessKeyId: process.env.AWS_ACCESS_KEY_ID,
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY
    });
    this.fromEmail = process.env.SES_FROM_EMAIL;
    this.siteUrl  = process.env.FRONTEND_URL || 'https://app.suretalknow.com';
  }

  // ── PRIVATE: shared HTML wrapper ─────────────────────────────────────────
  _wrap({ title, preheader, headerAccent = BRAND.blue, body, toEmail }) {
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${title}</title>
  <style>
    body,table,td,a{-webkit-text-size-adjust:100%;-ms-text-size-adjust:100%}
    body{margin:0;padding:0;background:${BRAND.bg};font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;color:#1A1F3A}
    table{border-spacing:0}
    img{border:0;display:block}
    .wrapper{width:100%;background:${BRAND.bg};padding:32px 0}
    .card{max-width:600px;margin:0 auto;background:${BRAND.surface};border-radius:12px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,.08)}
    .header{background:${headerAccent};padding:36px 40px;text-align:center}
    .logo-mark{display:inline-block;background:rgba(255,255,255,.15);border-radius:10px;padding:10px 18px;margin-bottom:16px}
    .logo-text{font-size:22px;font-weight:900;letter-spacing:-.02em;color:#fff;margin:0}
    .logo-dot{color:rgba(255,255,255,.6)}
    .header-title{font-size:26px;font-weight:800;color:#fff;margin:0;letter-spacing:-.02em;line-height:1.2}
    .content{padding:40px}
    .greeting{font-size:18px;font-weight:700;color:#0C1128;margin:0 0 16px}
    p{font-size:15px;line-height:1.75;color:#374151;margin:0 0 16px}
    .btn{display:inline-block;padding:14px 32px;background:${BRAND.blue};color:#fff!important;text-decoration:none;border-radius:8px;font-weight:700;font-size:15px;letter-spacing:.01em;margin:8px 0}
    .btn-coral{background:${BRAND.coral}}
    .divider{height:1px;background:#E8E4DC;margin:28px 0}
    .info-box{background:${BRAND.bg};border-left:3px solid ${BRAND.blue};border-radius:0 8px 8px 0;padding:16px 20px;margin:20px 0}
    .info-box.warn{border-left-color:${BRAND.coral};background:#FFF5F5}
    .detail-row{display:flex;justify-content:space-between;margin:0 0 8px;font-size:14px}
    .detail-label{color:${BRAND.muted}}
    .detail-value{font-weight:600;color:#0C1128}
    .footer{background:#F3F1EE;padding:28px 40px;text-align:center}
    .footer p{font-size:12px;color:${BRAND.muted};margin:0 0 6px;line-height:1.6}
    .footer a{color:${BRAND.blue};text-decoration:none}
    .social-row{margin:14px 0}
    @media(max-width:640px){
      .content{padding:28px 24px}
      .header{padding:28px 24px}
      .footer{padding:24px}
    }
  </style>
</head>
<body>
  ${preheader ? `<div style="display:none;max-height:0;overflow:hidden;mso-hide:all">${preheader}&nbsp;‌&nbsp;‌&nbsp;‌</div>` : ''}
  <div class="wrapper">
    <table class="card" width="100%" cellpadding="0" cellspacing="0" role="presentation">
      <!-- HEADER -->
      <tr><td class="header">
        <div class="logo-mark">
          <p class="logo-text">Sure<span class="logo-dot">Talk</span></p>
        </div>
        <h1 class="header-title">${title}</h1>
      </td></tr>
      <!-- BODY -->
      <tr><td class="content">
        ${body}
      </td></tr>
      <!-- FOOTER -->
      <tr><td class="footer">
        <p><strong style="color:#0C1128">SureTalk</strong> — Voice Messaging Without Internet</p>
        <p>
          <a href="${this.siteUrl}">Dashboard</a> &nbsp;·&nbsp;
          <a href="${this.siteUrl}/usersDashboard/billing">Billing</a> &nbsp;·&nbsp;
          <a href="${this.siteUrl}/usersDashboard/settings">Settings</a>
        </p>
        <p style="margin-top:12px">
          This email was sent to ${toEmail || 'you'} because you have a SureTalk account.<br>
          © ${BRAND.year} SureTalk. All rights reserved.
        </p>
      </td></tr>
    </table>
  </div>
</body>
</html>`;
  }

  // ── PRIVATE: plain-text fallback builder ──────────────────────────────────
  _text(title, lines) {
    return [
      `SureTalk — ${title}`,
      '='.repeat(50),
      '',
      ...lines,
      '',
      '─'.repeat(50),
      `© ${BRAND.year} SureTalk. All rights reserved.`,
      this.siteUrl
    ].join('\n');
  }

  // ── PRIVATE: SES send helper ──────────────────────────────────────────────
  async _send({ to, subject, html, text }) {
    const params = {
      Source: this.fromEmail,
      Destination: { ToAddresses: [to] },
      Message: {
        Subject: { Charset: 'UTF-8', Data: subject },
        Body: {
          Html: { Charset: 'UTF-8', Data: html },
          Text: { Charset: 'UTF-8', Data: text }
        }
      }
    };
    const result = await this.ses.sendEmail(params).promise();
    logger.info(`Email "${subject}" sent to ${to}: ${result.MessageId}`);
    return result;
  }

  // ══════════════════════════════════════════════════════════════════════════
  // 1. ACCOUNT VERIFICATION
  // ══════════════════════════════════════════════════════════════════════════
  async sendVerificationEmail(toEmail, verificationToken, userName) {
    const link = `${this.siteUrl}/verify-email?token=${verificationToken}`;
    const html = this._wrap({
      title: 'Verify Your Email',
      preheader: 'One click to activate your SureTalk account.',
      toEmail,
      body: `
        <p class="greeting">Hi ${userName},</p>
        <p>Thanks for signing up! Click the button below to verify your email address and activate your SureTalk account.</p>
        <p style="text-align:center;margin:32px 0">
          <a href="${link}" class="btn">Verify My Email</a>
        </p>
        <p>Or paste this link into your browser:</p>
        <p style="word-break:break-all;font-size:13px;color:${BRAND.muted}">${link}</p>
        <div class="divider"></div>
        <p style="font-size:13px;color:${BRAND.muted}">This link expires in 24 hours. If you didn't create a SureTalk account, you can safely ignore this email.</p>`
    });
    return this._send({
      to: toEmail,
      subject: 'Verify Your SureTalk Account',
      html,
      text: this._text('Verify Your Email', [
        `Hi ${userName},`,
        '',
        'Verify your email by visiting this link:',
        link,
        '',
        'This link expires in 24 hours.'
      ])
    });
  }

  // ══════════════════════════════════════════════════════════════════════════
  // 2. PASSWORD RESET
  // ══════════════════════════════════════════════════════════════════════════
  async sendPasswordResetEmail(toEmail, resetLink, userName) {
    const html = this._wrap({
      title: 'Reset Your Password',
      preheader: 'We received a request to reset your SureTalk password.',
      toEmail,
      body: `
        <p class="greeting">Hi ${userName},</p>
        <p>We received a request to reset your SureTalk password. Click the button below to choose a new one.</p>
        <p style="text-align:center;margin:32px 0">
          <a href="${resetLink}" class="btn">Reset My Password</a>
        </p>
        <p>Or paste this link into your browser:</p>
        <p style="word-break:break-all;font-size:13px;color:${BRAND.muted}">${resetLink}</p>
        <div class="divider"></div>
        <p style="font-size:13px;color:${BRAND.muted}">This link expires in 1 hour. If you didn't request a password reset, no action is needed — your password has not been changed.</p>`
    });
    return this._send({
      to: toEmail,
      subject: 'Reset Your SureTalk Password',
      html,
      text: this._text('Reset Your Password', [
        `Hi ${userName},`,
        '',
        'Reset your password by visiting:',
        resetLink,
        '',
        'This link expires in 1 hour.'
      ])
    });
  }

  // ══════════════════════════════════════════════════════════════════════════
  // 3. WELCOME (after email verified)
  // ══════════════════════════════════════════════════════════════════════════
  async sendWelcomeEmail(toEmail, userName) {
    try {
      const html = this._wrap({
        title: 'Welcome to SureTalk!',
        preheader: 'Your account is verified and ready to go.',
        toEmail,
        body: `
          <p class="greeting">Welcome, ${userName}! 🎉</p>
          <p>Your email is verified and your SureTalk account is ready. Here's what you can do right now:</p>
          <div class="info-box">
            <p style="margin:0 0 8px"><strong>📞 Record a voice note</strong><br>Call in or use the web dashboard to record your first message.</p>
          </div>
          <div class="info-box">
            <p style="margin:0 0 8px"><strong>👥 Add trusted contacts</strong><br>Add the people who can receive and play your voice notes.</p>
          </div>
          <div class="info-box">
            <p style="margin:0 0 8px"><strong>📅 Schedule a message</strong><br>Set a voice message to be delivered automatically at a future date.</p>
          </div>
          <p style="text-align:center;margin:32px 0">
            <a href="${this.siteUrl}/usersDashboard" class="btn">Go to My Dashboard</a>
          </p>`
      });
      return this._send({
        to: toEmail,
        subject: 'Welcome to SureTalk — You\'re all set!',
        html,
        text: this._text('Welcome to SureTalk!', [
          `Welcome, ${userName}!`,
          '',
          'Your account is verified and ready.',
          `Log in at: ${this.siteUrl}`
        ])
      });
    } catch (err) {
      logger.error('Failed to send welcome email:', err);
    }
  }

  // ══════════════════════════════════════════════════════════════════════════
  // 4. PAYMENT FAILED
  // ══════════════════════════════════════════════════════════════════════════
  async sendPaymentFailedEmail(toEmail, userName, { amountDue, currency = 'USD', nextRetryDate, attemptCount = 1 }) {
    const billingUrl = `${this.siteUrl}/usersDashboard/billing`;
    const isLastWarning = attemptCount >= 3;
    const formattedAmount = new Intl.NumberFormat('en-US', { style: 'currency', currency: currency.toUpperCase() }).format(amountDue / 100);

    const html = this._wrap({
      title: isLastWarning ? 'Action Required: Final Payment Attempt' : 'Payment Failed',
      preheader: `We couldn't process your ${formattedAmount} payment. Please update your card.`,
      headerAccent: BRAND.coral,
      toEmail,
      body: `
        <p class="greeting">Hi ${userName},</p>
        <p>We were unable to process your SureTalk subscription payment. Please update your payment method to keep your account active.</p>
        <div class="info-box warn">
          <table width="100%" cellpadding="0" cellspacing="0">
            <tr><td class="detail-label">Amount due</td><td align="right" class="detail-value">${formattedAmount}</td></tr>
            <tr><td class="detail-label">Attempt</td><td align="right" class="detail-value">${attemptCount} of 4</td></tr>
            ${nextRetryDate ? `<tr><td class="detail-label">Next retry</td><td align="right" class="detail-value">${nextRetryDate}</td></tr>` : ''}
          </table>
        </div>
        ${isLastWarning ? `
        <p><strong style="color:${BRAND.coral}">This is our final attempt.</strong> If payment is not resolved, your account will be suspended and you will lose access to your voice notes and contacts.</p>` : `
        <p>We'll automatically try again. To avoid any interruption to your service, please update your payment method now.</p>`}
        <p style="text-align:center;margin:32px 0">
          <a href="${billingUrl}" class="btn btn-coral">Update Payment Method</a>
        </p>
        <div class="divider"></div>
        <p style="font-size:13px;color:${BRAND.muted}">If you believe this is an error, please contact us. Your data is safe — we won't delete anything.</p>`
    });

    return this._send({
      to: toEmail,
      subject: isLastWarning
        ? `⚠️ Final notice: Your SureTalk payment needs attention`
        : `Action needed: SureTalk payment of ${formattedAmount} failed`,
      html,
      text: this._text('Payment Failed', [
        `Hi ${userName},`,
        '',
        `We couldn't process your payment of ${formattedAmount}.`,
        `Please update your payment method at: ${billingUrl}`,
        '',
        nextRetryDate ? `Next retry: ${nextRetryDate}` : ''
      ])
    });
  }

  // ══════════════════════════════════════════════════════════════════════════
  // 5. ACCOUNT SUSPENDED (all retries exhausted)
  // ══════════════════════════════════════════════════════════════════════════
  async sendAccountSuspendedEmail(toEmail, userName) {
    const billingUrl = `${this.siteUrl}/usersDashboard/billing`;
    const html = this._wrap({
      title: 'Your Account Has Been Paused',
      preheader: 'Reactivate your SureTalk account to regain access.',
      headerAccent: BRAND.coral,
      toEmail,
      body: `
        <p class="greeting">Hi ${userName},</p>
        <p>Your SureTalk subscription has been suspended because we were unable to collect payment after multiple attempts.</p>
        <div class="info-box warn">
          <p style="margin:0"><strong>Your account is currently paused.</strong> You cannot access voice notes, contacts, or scheduled messages until your subscription is reactivated.</p>
        </div>
        <p><strong>The good news:</strong> Your data is completely safe. All your voice notes and contacts are preserved. You just need to update your payment method to restore access instantly.</p>
        <p style="text-align:center;margin:32px 0">
          <a href="${billingUrl}" class="btn btn-coral">Reactivate My Account</a>
        </p>
        <div class="divider"></div>
        <p style="font-size:13px;color:${BRAND.muted}">Need help? Reply to this email and our team will assist you.</p>`
    });

    return this._send({
      to: toEmail,
      subject: 'Your SureTalk account has been paused',
      html,
      text: this._text('Account Suspended', [
        `Hi ${userName},`,
        '',
        'Your SureTalk account has been paused due to a failed payment.',
        'Your data is safe. Reactivate at:',
        billingUrl
      ])
    });
  }

  // ══════════════════════════════════════════════════════════════════════════
  // 6. PAYMENT SUCCEEDED / RENEWAL RECEIPT
  // ══════════════════════════════════════════════════════════════════════════
  async sendPaymentSuccessEmail(toEmail, userName, { amountPaid, currency = 'USD', tier, nextBillingDate }) {
    const billingUrl = `${this.siteUrl}/usersDashboard/billing`;
    const formattedAmount = new Intl.NumberFormat('en-US', { style: 'currency', currency: currency.toUpperCase() }).format(amountPaid / 100);
    const tierLabel = { LITE: 'SureTalk LITE', ESSENTIAL: 'SureTalk Essential', LEGACY_VAULT_PREMIUM: 'SureTalk Premium (Legacy Vault)' }[tier] || tier;

    const html = this._wrap({
      title: 'Payment Confirmed',
      preheader: `Your ${formattedAmount} payment was successful.`,
      toEmail,
      body: `
        <p class="greeting">Hi ${userName},</p>
        <p>Your SureTalk subscription has been renewed. Thank you!</p>
        <div class="info-box">
          <table width="100%" cellpadding="0" cellspacing="0">
            <tr><td class="detail-label">Plan</td><td align="right" class="detail-value">${tierLabel}</td></tr>
            <tr><td class="detail-label">Amount charged</td><td align="right" class="detail-value">${formattedAmount}</td></tr>
            ${nextBillingDate ? `<tr><td class="detail-label">Next billing date</td><td align="right" class="detail-value">${nextBillingDate}</td></tr>` : ''}
          </table>
        </div>
        <p>Everything is active and ready. Keep using SureTalk as normal.</p>
        <p style="text-align:center;margin:32px 0">
          <a href="${this.siteUrl}/usersDashboard" class="btn">Go to Dashboard</a>
          &nbsp;
          <a href="${billingUrl}" style="display:inline-block;padding:14px 32px;color:${BRAND.blue};text-decoration:none;font-weight:700;font-size:15px">View Billing</a>
        </p>
        <div class="divider"></div>
        <p style="font-size:13px;color:${BRAND.muted}">To manage or cancel your subscription, visit your <a href="${billingUrl}" style="color:${BRAND.blue}">billing page</a>.</p>`
    });

    return this._send({
      to: toEmail,
      subject: `Payment confirmed — ${formattedAmount} charged for ${tierLabel}`,
      html,
      text: this._text('Payment Confirmed', [
        `Hi ${userName},`,
        '',
        `Payment of ${formattedAmount} confirmed for ${tierLabel}.`,
        nextBillingDate ? `Next billing date: ${nextBillingDate}` : '',
        '',
        `Manage billing: ${billingUrl}`
      ])
    });
  }

  // ══════════════════════════════════════════════════════════════════════════
  // 7. SUBSCRIPTION CANCELLED
  // ══════════════════════════════════════════════════════════════════════════
  async sendSubscriptionCancelledEmail(toEmail, userName, { tier, accessUntilDate }) {
    const billingUrl = `${this.siteUrl}/usersDashboard/billing`;
    const tierLabel = { LITE: 'SureTalk LITE', ESSENTIAL: 'SureTalk Essential', LEGACY_VAULT_PREMIUM: 'SureTalk Premium' }[tier] || tier;

    const html = this._wrap({
      title: 'Subscription Cancelled',
      preheader: 'Your SureTalk subscription has been cancelled.',
      toEmail,
      body: `
        <p class="greeting">Hi ${userName},</p>
        <p>Your <strong>${tierLabel}</strong> subscription has been cancelled. We're sorry to see you go.</p>
        <div class="info-box">
          <p style="margin:0">
            Your account will continue on the <strong>free LITE plan</strong>.
            ${accessUntilDate ? `You had paid access until <strong>${accessUntilDate}</strong>.` : ''}
            Your voice notes and contacts are preserved.
          </p>
        </div>
        <p><strong>What you still have on LITE:</strong></p>
        <ul style="font-size:15px;color:#374151;padding-left:20px;line-height:2">
          <li>Up to 3 voice notes</li>
          <li>Up to 3 contacts</li>
          <li>Phone-based access</li>
        </ul>
        <p>Changed your mind? You can reactivate your subscription at any time.</p>
        <p style="text-align:center;margin:32px 0">
          <a href="${billingUrl}" class="btn">Reactivate Subscription</a>
        </p>
        <div class="divider"></div>
        <p style="font-size:13px;color:${BRAND.muted}">Your card will not be charged again. If you have questions, just reply to this email.</p>`
    });

    return this._send({
      to: toEmail,
      subject: 'Your SureTalk subscription has been cancelled',
      html,
      text: this._text('Subscription Cancelled', [
        `Hi ${userName},`,
        '',
        `Your ${tierLabel} subscription has been cancelled.`,
        'Your account has been moved to the free LITE plan.',
        'Your data is safe.',
        '',
        `Reactivate at: ${billingUrl}`
      ])
    });
  }

  // ══════════════════════════════════════════════════════════════════════════
  // 8. TRIAL ENDING IN 3 DAYS
  // ══════════════════════════════════════════════════════════════════════════
  async sendTrialEndingEmail(toEmail, userName, { trialEndDate, tier }) {
    const billingUrl = `${this.siteUrl}/usersDashboard/billing`;
    const tierLabel = { ESSENTIAL: 'SureTalk Essential ($6.99/mo)', LEGACY_VAULT_PREMIUM: 'SureTalk Premium ($12.99/mo)' }[tier] || tier;

    const html = this._wrap({
      title: 'Your Trial Ends in 3 Days',
      preheader: `Your free trial ends on ${trialEndDate}. Add a card to keep your access.`,
      toEmail,
      body: `
        <p class="greeting">Hi ${userName},</p>
        <p>Your free trial of <strong>${tierLabel}</strong> ends on <strong>${trialEndDate}</strong>.</p>
        <p>To keep your full access — including all your voice notes, contacts, and features — add a payment method before your trial expires.</p>
        <div class="info-box">
          <p style="margin:0">After your trial ends, your account will move to the free <strong>LITE plan</strong> if no payment method is on file. You won't lose your data, but features will be limited.</p>
        </div>
        <p style="text-align:center;margin:32px 0">
          <a href="${billingUrl}" class="btn">Add Payment Method</a>
        </p>
        <div class="divider"></div>
        <p style="font-size:13px;color:${BRAND.muted}">You can cancel anytime from your billing page. No charge until your trial ends.</p>`
    });

    return this._send({
      to: toEmail,
      subject: `Your SureTalk trial ends on ${trialEndDate} — keep your access`,
      html,
      text: this._text('Trial Ending Soon', [
        `Hi ${userName},`,
        '',
        `Your free trial ends on ${trialEndDate}.`,
        `Add a payment method to continue: ${billingUrl}`
      ])
    });
  }
}

module.exports = new EmailService();
