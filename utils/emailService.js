// utils/emailService.js
// Every email SureTalk sends, built on one design (utils/emailTemplate.js). All names, messages and
// other values are escaped by the template, so customer-entered text can't inject links or markup.
const AWS = require('aws-sdk');
const logger = require('./logger');
const t = require('./emailTemplate');

// Customer-typed text with its line breaks kept (escaped)
const multiline = (s) => t.raw(String(s || '').split(/\r?\n/).map(t.esc).join('<br>'));
const TIER_LABELS ={ LITE: 'SureTalk LITE', ESSENTIAL: 'SureTalk Essential', LEGACY_VAULT_PREMIUM: 'SureTalk Premium (Legacy Vault)' };
const money = (cents, currency = 'USD') =>
  new Intl.NumberFormat('en-US', { style: 'currency', currency: String(currency).toUpperCase() }).format((cents || 0) / 100);

class EmailService {
  constructor() {
    this.ses = new AWS.SES({
      region: process.env.AWS_SES_REGION || process.env.AWS_REGION,
      accessKeyId: process.env.AWS_ACCESS_KEY_ID,
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY
    });
    this.fromEmail = process.env.SES_FROM_EMAIL;
    this.siteUrl = process.env.FRONTEND_URL || 'https://app.suretalknow.com';
  }

  // ── SES send helper ───────────────────────────────────────────────────────
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
    const link = `${this.siteUrl}/verify-email?token=${encodeURIComponent(verificationToken)}`;
    const html = t.render({
      category: 'Account', title: 'Verify your email', toEmail,
      preheader: 'One click to activate your SureTalk account.',
      body: [
        t.greeting(userName),
        t.p('Thanks for signing up! Click the button below to verify your email address and activate your SureTalk account.'),
        t.button('Verify my email', link),
        t.linkFallback(link),
        t.divider(),
        t.p("This link expires in 24 hours. If you didn't create a SureTalk account, you can safely ignore this email.", { muted: true, small: true }),
      ]
    });
    return this._send({
      to: toEmail,
      subject: 'Verify Your SureTalk Account',
      html,
      text: t.text({ title: 'Verify your email', toEmail, lines: [
        `Hi ${userName || 'there'},`, '', 'Verify your email by visiting this link:', link, '', 'This link expires in 24 hours.'
      ] })
    });
  }

  // ══════════════════════════════════════════════════════════════════════════
  // 2. PASSWORD RESET
  // ══════════════════════════════════════════════════════════════════════════
  async sendPasswordResetEmail(toEmail, resetLink, userName) {
    const html = t.render({
      category: 'Account', title: 'Reset your password', toEmail,
      preheader: 'We received a request to reset your SureTalk password.',
      body: [
        t.greeting(userName),
        t.p('We received a request to reset your SureTalk password. Click the button below to choose a new one.'),
        t.button('Reset my password', resetLink),
        t.linkFallback(resetLink),
        t.divider(),
        t.p("This link expires in 1 hour. If you didn't request a password reset, no action is needed: your password has not been changed.", { muted: true, small: true }),
      ]
    });
    return this._send({
      to: toEmail,
      subject: 'Reset Your SureTalk Password',
      html,
      text: t.text({ title: 'Reset your password', toEmail, lines: [
        `Hi ${userName || 'there'},`, '', 'Reset your password by visiting:', resetLink, '', 'This link expires in 1 hour.'
      ] })
    });
  }

  // ══════════════════════════════════════════════════════════════════════════
  // 3. WELCOME (after email verified)
  // ══════════════════════════════════════════════════════════════════════════
  async sendWelcomeEmail(toEmail, userName) {
    try {
      const dashboard = `${this.siteUrl}/usersDashboard`;
      const html = t.render({
        category: 'Account', title: 'Welcome to SureTalk', subtitle: 'Your account is verified and ready to go.', toEmail,
        preheader: 'Your account is verified and ready to go.',
        body: [
          t.lead(`Welcome, ${userName || 'there'}!`),
          t.p("Your email is verified and your SureTalk account is ready. Here's what you can do right now:"),
          t.steps([
            ['Record a voice note', 'Call in or use the web dashboard to record your first message.'],
            ['Add trusted contacts', 'Add the people who can receive and play your voice notes.'],
            ['Schedule a message', 'Set a voice message to be delivered automatically at a future date.'],
          ]),
          t.button('Go to my dashboard', dashboard),
        ]
      });
      return await this._send({
        to: toEmail,
        subject: "Welcome to SureTalk — You're all set!",
        html,
        text: t.text({ title: 'Welcome to SureTalk', toEmail, lines: [
          `Welcome, ${userName || 'there'}!`, '', 'Your account is verified and ready.', `Log in at: ${this.siteUrl}`
        ] })
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
    const amount = money(amountDue, currency);
    const html = t.render({
      category: 'Billing', accent: 'urgent', toEmail,
      title: isLastWarning ? 'Action required: final payment attempt' : 'Payment failed',
      preheader: `We couldn't process your ${amount} payment. Please update your card.`,
      body: [
        t.greeting(userName),
        t.p('We were unable to process your SureTalk subscription payment. Please update your payment method to keep your account active.'),
        t.details([
          ['Amount due', amount],
          ['Attempt', `${attemptCount} of 4`],
          nextRetryDate ? ['Next retry', nextRetryDate] : null,
        ]),
        isLastWarning
          ? t.callout('If payment is not resolved, your account will be suspended and you will lose access to your voice notes and contacts.', { tone: 'warn', title: 'This is our final attempt' })
          : t.p("We'll automatically try again. To avoid any interruption to your service, please update your payment method now."),
        t.button('Update payment method', billingUrl, { tone: 'urgent' }),
        t.divider(),
        t.p("If you believe this is an error, please contact us. Your data is safe: we won't delete anything.", { muted: true, small: true }),
      ]
    });
    return this._send({
      to: toEmail,
      subject: isLastWarning
        ? 'Final notice: Your SureTalk payment needs attention'
        : `Action needed: SureTalk payment of ${amount} failed`,
      html,
      text: t.text({ title: 'Payment failed', toEmail, lines: [
        `Hi ${userName || 'there'},`, '', `We couldn't process your payment of ${amount}.`,
        `Please update your payment method at: ${billingUrl}`, '', nextRetryDate ? `Next retry: ${nextRetryDate}` : ''
      ] })
    });
  }

  // ══════════════════════════════════════════════════════════════════════════
  // 5. ACCOUNT SUSPENDED (all payment retries exhausted)
  // ══════════════════════════════════════════════════════════════════════════
  async sendAccountSuspendedEmail(toEmail, userName) {
    const billingUrl = `${this.siteUrl}/usersDashboard/billing`;
    const html = t.render({
      category: 'Billing', accent: 'urgent', title: 'Your account has been paused', toEmail,
      preheader: 'Reactivate your SureTalk account to regain access.',
      body: [
        t.greeting(userName),
        t.p('Your SureTalk subscription has been suspended because we were unable to collect payment after multiple attempts.'),
        t.callout('You cannot access voice notes, contacts, or scheduled messages until your subscription is reactivated.', { tone: 'warn', title: 'Your account is currently paused' }),
        t.p(t.rich(t.b('The good news:'), ' Your data is completely safe. All your voice notes and contacts are preserved. You just need to update your payment method to restore access instantly.')),
        t.button('Reactivate my account', billingUrl, { tone: 'urgent' }),
        t.divider(),
        t.p('Need help? Reply to this email and our team will assist you.', { muted: true, small: true }),
      ]
    });
    return this._send({
      to: toEmail,
      subject: 'Your SureTalk account has been paused',
      html,
      text: t.text({ title: 'Account paused', toEmail, lines: [
        `Hi ${userName || 'there'},`, '', 'Your SureTalk account has been paused due to a failed payment.', 'Your data is safe. Reactivate at:', billingUrl
      ] })
    });
  }

  // ══════════════════════════════════════════════════════════════════════════
  // 6. PAYMENT SUCCEEDED / RENEWAL RECEIPT
  // ══════════════════════════════════════════════════════════════════════════
  async sendPaymentSuccessEmail(toEmail, userName, { amountPaid, currency = 'USD', tier, nextBillingDate }) {
    const billingUrl = `${this.siteUrl}/usersDashboard/billing`;
    const amount = money(amountPaid, currency);
    const tierLabel = TIER_LABELS[tier] || tier;
    const html = t.render({
      category: 'Billing', accent: 'success', title: 'Payment confirmed', subtitle: 'Thank you. Your subscription has been renewed.', toEmail,
      preheader: `Your ${amount} payment was successful.`,
      body: [
        t.greeting(userName),
        t.details([
          ['Plan', tierLabel],
          ['Amount charged', amount],
          nextBillingDate ? ['Next billing date', nextBillingDate] : null,
        ]),
        t.p('Everything is active and ready. Keep using SureTalk as normal.'),
        t.button('Go to dashboard', `${this.siteUrl}/usersDashboard`),
        t.divider(),
        t.p(t.rich('To manage or cancel your subscription, visit your ', t.a('billing page', billingUrl), '.'), { muted: true, small: true }),
      ]
    });
    return this._send({
      to: toEmail,
      subject: `Payment confirmed — ${amount} charged for ${tierLabel}`,
      html,
      text: t.text({ title: 'Payment confirmed', toEmail, lines: [
        `Hi ${userName || 'there'},`, '', `Payment of ${amount} confirmed for ${tierLabel}.`,
        nextBillingDate ? `Next billing date: ${nextBillingDate}` : '', '', `Manage billing: ${billingUrl}`
      ] })
    });
  }

  // ══════════════════════════════════════════════════════════════════════════
  // 7. SUBSCRIPTION CANCELLED
  // ══════════════════════════════════════════════════════════════════════════
  async sendSubscriptionCancelledEmail(toEmail, userName, { tier, accessUntilDate }) {
    const billingUrl = `${this.siteUrl}/usersDashboard/billing`;
    const tierLabel = { LITE: 'SureTalk LITE', ESSENTIAL: 'SureTalk Essential', LEGACY_VAULT_PREMIUM: 'SureTalk Premium' }[tier] || tier;
    const html = t.render({
      category: 'Billing', title: 'Subscription cancelled', toEmail,
      preheader: 'Your SureTalk subscription has been cancelled.',
      body: [
        t.greeting(userName),
        t.p(t.rich('Your ', t.b(tierLabel), " subscription has been cancelled. We're sorry to see you go.")),
        t.callout(t.rich(
          'Your account will continue on the ', t.b('free LITE plan'), '. ',
          accessUntilDate ? t.rich('You had paid access until ', t.b(accessUntilDate), '. ') : '',
          'Your voice notes and contacts are preserved.'
        ), { tone: 'info' }),
        t.p(t.b('What you still have on LITE:')),
        t.list(['Up to 3 voice notes', 'Up to 3 contacts', 'Phone-based access']),
        t.p('Changed your mind? You can reactivate your subscription at any time.'),
        t.button('Reactivate subscription', billingUrl),
        t.divider(),
        t.p('Your card will not be charged again. If you have questions, just reply to this email.', { muted: true, small: true }),
      ]
    });
    return this._send({
      to: toEmail,
      subject: 'Your SureTalk subscription has been cancelled',
      html,
      text: t.text({ title: 'Subscription cancelled', toEmail, lines: [
        `Hi ${userName || 'there'},`, '', `Your ${tierLabel} subscription has been cancelled.`,
        'Your account has been moved to the free LITE plan.', 'Your data is safe.', '', `Reactivate at: ${billingUrl}`
      ] })
    });
  }

  // ══════════════════════════════════════════════════════════════════════════
  // 8. ACCOUNT DELETED
  // ══════════════════════════════════════════════════════════════════════════
  async sendAccountDeletedEmail(toEmail, userName) {
    const html = t.render({
      category: 'Account', title: 'Account deleted', toEmail,
      preheader: 'Your SureTalk account has been deleted.',
      reason: `This is a confirmation that the SureTalk account for ${toEmail || 'this address'} was deleted.`,
      body: [
        t.greeting(userName),
        t.p("Your SureTalk account has been successfully deleted. We're sorry to see you go."),
        t.callout('Your account access has been removed immediately. Any active subscription has been cancelled: you will not be charged again. Your personal data is retained for a period required by applicable law before being permanently removed.', { tone: 'neutral', title: 'What this means' }),
        t.p(t.rich("If you change your mind, you're always welcome back. Simply create a new account at ", t.a('suretalknow.com', `${this.siteUrl}/signup`), '.')),
        t.p('If you did not request this deletion or believe this was made in error, please contact our support team immediately by replying to this email.'),
        t.divider(),
        t.p('Thank you for using SureTalk. We hope to see you again someday.', { muted: true, small: true }),
      ]
    });
    return this._send({
      to: toEmail,
      subject: 'Your SureTalk account has been deleted',
      html,
      text: t.text({ title: 'Account deleted', lines: [
        `Hi ${userName || 'there'},`, '', 'Your SureTalk account has been successfully deleted.',
        'Any active subscription has been cancelled. You will not be charged again.', '',
        'If this was a mistake, please reply to this email immediately.', '', `Create a new account anytime at ${this.siteUrl}/signup`
      ] })
    });
  }

  // ══════════════════════════════════════════════════════════════════════════
  // 9. TRIAL ENDING IN 3 DAYS
  // ══════════════════════════════════════════════════════════════════════════
  async sendTrialEndingEmail(toEmail, userName, { trialEndDate, tier }) {
    const billingUrl = `${this.siteUrl}/usersDashboard/billing`;
    const tierLabel = { ESSENTIAL: 'SureTalk Essential ($6.99/mo)', LEGACY_VAULT_PREMIUM: 'SureTalk Premium ($12.99/mo)' }[tier] || tier;
    const html = t.render({
      category: 'Billing', title: 'Your trial ends in 3 days', toEmail,
      preheader: `Your free trial ends on ${trialEndDate}. Add a card to keep your access.`,
      body: [
        t.greeting(userName),
        t.p(t.rich('Your free trial of ', t.b(tierLabel), ' ends on ', t.b(trialEndDate), '.')),
        t.p('To keep your full access, including all your voice notes, contacts, and features, add a payment method before your trial expires.'),
        t.callout(t.rich("After your trial ends, your account will move to the free ", t.b('LITE plan'), " if no payment method is on file. You won't lose your data, but features will be limited."), { tone: 'info' }),
        t.button('Add payment method', billingUrl),
        t.divider(),
        t.p('You can cancel anytime from your billing page. No charge until your trial ends.', { muted: true, small: true }),
      ]
    });
    return this._send({
      to: toEmail,
      subject: `Your SureTalk trial ends on ${trialEndDate} — keep your access`,
      html,
      text: t.text({ title: 'Trial ending soon', toEmail, lines: [
        `Hi ${userName || 'there'},`, '', `Your free trial ends on ${trialEndDate}.`, `Add a payment method to continue: ${billingUrl}`
      ] })
    });
  }

  // ══════════════════════════════════════════════════════════════════════════
  // 10. VOICE WILL RELEASED TO A BENEFICIARY
  // ══════════════════════════════════════════════════════════════════════════
  async sendWillReleasedEmail(toEmail, recipientName, { ownerName, listenUrl, expiresDate }) {
    const owner = ownerName || 'Someone';
    const html = t.render({
      category: 'Legacy Vault', title: 'A voice will has been shared with you', toEmail,
      preheader: `${owner} left a voice will for you on SureTalk.`,
      reason: 'You received this email because a SureTalk member named you as a recipient of their voice will.',
      accountLinks: false,
      body: [
        t.greeting(recipientName),
        t.p(t.rich(t.b(owner), ' recorded a voice will on SureTalk and named you as someone who should hear it. It has now been released to you.')),
        t.button('Listen to the voice will', listenUrl),
        t.callout(`This private link was created for you. Please don't forward it. It works until ${expiresDate}.`, { tone: 'neutral' }),
        t.p("If you weren't expecting this or think it reached you by mistake, reply to this email and our team will help.", { muted: true, small: true }),
      ]
    });
    return this._send({
      to: toEmail,
      subject: `${owner} left a voice will for you on SureTalk`,
      html,
      text: t.text({ title: 'A voice will has been shared with you', lines: [
        `Hi ${recipientName || 'there'},`, '', `${owner} recorded a voice will on SureTalk and named you as someone who should hear it.`,
        `Listen here (private link, works until ${expiresDate}): ${listenUrl}`, '', 'If you think this reached you by mistake, reply to this email.'
      ] })
    });
  }

  // ══════════════════════════════════════════════════════════════════════════
  // 11. NEW ADMIN ACCESS REQUEST (to super admins)
  // ══════════════════════════════════════════════════════════════════════════
  async sendAdminRequestNotification(toEmail, { applicantName, applicantEmail, department, reason }) {
    const reviewUrl = `${this.siteUrl}/adminDashboard/admin-requests`;
    const html = t.render({
      category: 'Admin', title: 'New admin access request', toEmail,
      preheader: `${applicantName} asked for access to the SureTalk admin console.`,
      reason: "You're receiving this because you're a SureTalk super admin.",
      body: [
        t.lead('Hi,'),
        t.p(t.rich(t.b(applicantName), ` (${applicantEmail || 'no email'}) has asked for access to the SureTalk admin console.`)),
        t.details([
          department ? ['Department', department] : null,
          ['Reason', reason || '—'],
        ]),
        t.button('Review the request', reviewUrl),
        t.p("Only approve people you know. Admins can see every user's data.", { muted: true, small: true }),
      ]
    });
    return this._send({
      to: toEmail,
      subject: `Admin access request from ${applicantName}`,
      html,
      text: t.text({ title: 'New admin access request', lines: [
        `${applicantName} (${applicantEmail}) asked for admin access.`, department ? `Department: ${department}` : '',
        `Reason: ${reason || '—'}`, '', `Review it here: ${reviewUrl}`
      ] })
    });
  }

  // ══════════════════════════════════════════════════════════════════════════
  // 12. ADMIN ACCESS DECISION (to the applicant)
  // ══════════════════════════════════════════════════════════════════════════
  async sendAdminRequestDecision(toEmail, userName, { approved, reason }) {
    const loginUrl = `${this.siteUrl}/admin/login`;
    const html = t.render({
      category: 'Admin', accent: approved ? 'success' : 'brand', toEmail,
      title: approved ? 'Admin access approved' : 'Admin access request',
      preheader: approved ? 'You can now sign in to the SureTalk admin console.' : 'An update on your SureTalk admin access request.',
      body: approved ? [
        t.greeting(userName),
        t.p(t.rich('Your request for access to the SureTalk admin console has been ', t.b('approved'), '.')),
        t.button('Sign in to the admin console', loginUrl),
        t.p("For your account's safety, turn on two-step verification after you sign in (Security & audit page).", { muted: true, small: true }),
      ] : [
        t.greeting(userName),
        t.p(t.rich('Your request for access to the SureTalk admin console was ', t.b('not approved'), '.')),
        reason ? t.callout(reason, { tone: 'neutral', title: 'Reason' }) : '',
        t.p('If you think this is a mistake, reply to this email.'),
      ].filter(Boolean)
    });
    return this._send({
      to: toEmail,
      subject: approved ? 'Your SureTalk admin access is approved' : 'Your SureTalk admin access request',
      html,
      text: t.text({ title: approved ? 'Admin access approved' : 'Admin access request', toEmail, lines: approved
        ? [`Hi ${userName || 'there'},`, '', 'Your admin access request was approved.', `Sign in: ${loginUrl}`]
        : [`Hi ${userName || 'there'},`, '', 'Your admin access request was not approved.', reason ? `Reason: ${reason}` : '', 'Reply to this email if you think this is a mistake.'] })
    });
  }

  // ══════════════════════════════════════════════════════════════════════════
  // 12b. SUPPORT: NEW TICKET (to the support inbox) and REPLY (to the customer)
  // ══════════════════════════════════════════════════════════════════════════
  async sendNewTicketNotification(toEmail, { ticketId, ticketNumber, subject, category, priority, customerName, customerEmail, description }) {
    const url = `${this.siteUrl}/adminDashboard/helpandsupport/tickets/${ticketId}`;
    const html = t.render({
      category: 'Support', title: 'New support ticket', toEmail,
      preheader: `${ticketNumber}: ${subject}`,
      reason: "You're receiving this because this address is SureTalk's support inbox.",
      body: [
        t.lead('Hi,'),
        t.p(t.rich(t.b(customerName || customerEmail || 'A customer'), ' opened a support ticket.')),
        t.details([
          ['Ticket', ticketNumber],
          ['Subject', subject],
          ['Category', category],
          ['Priority', priority],
          customerEmail ? ['Customer', customerEmail] : null,
        ]),
        t.callout(multiline(description), { tone: 'neutral', title: 'Their message' }),
        t.button('Open the ticket', url),
      ]
    });
    return this._send({
      to: toEmail,
      subject: `[${ticketNumber}] New ${priority} ticket: ${subject}`,
      html,
      text: t.text({ title: 'New support ticket', lines: [
        `${customerName || customerEmail || 'A customer'} opened ${ticketNumber}: ${subject}`,
        `Category: ${category} · Priority: ${priority}`, '', description, '', `Open it: ${url}`
      ] })
    });
  }

  async sendSupportReplyEmail(toEmail, userName, { ticketId, ticketNumber, subject, message }) {
    const url = `${this.siteUrl}/usersDashboard/helpandsupport/tickets/${ticketId}`;
    const html = t.render({
      category: 'Support', title: 'We replied to your ticket', toEmail, accountLinks: true,
      preheader: `A reply about "${subject}"`,
      body: [
        t.greeting(userName),
        t.p(t.rich('Our support team replied to your ticket ', t.b(ticketNumber), ` (${subject}).`)),
        t.callout(multiline(message), { tone: 'info', title: 'Reply from SureTalk Support' }),
        t.button('View the conversation', url),
        t.p('To answer, reply on the ticket page so the whole conversation stays in one place.', { muted: true, small: true }),
      ]
    });
    return this._send({
      to: toEmail,
      subject: `[${ticketNumber}] Reply to: ${subject}`,
      html,
      text: t.text({ title: 'We replied to your ticket', toEmail, lines: [
        `Hi ${userName || 'there'},`, '', `Our support team replied to ${ticketNumber} (${subject}):`, '', message, '', `View and answer: ${url}`
      ] })
    });
  }

  // ══════════════════════════════════════════════════════════════════════════
  // 13. VOICE MESSAGE DELIVERED BY EMAIL (scheduled messages and test sends)
  // ══════════════════════════════════════════════════════════════════════════
  async sendVoiceMessageEmail(toEmail, { title, message, listenUrl, senderName, expiresText = 'This link expires in 7 days.', subject }) {
    const sender = senderName || 'SureTalk';
    const noteTitle = title || 'Voice Note';
    const html = t.render({
      category: 'Voice message', title: 'Voice message for you', subtitle: `A message from ${sender}`,
      preheader: `${sender} sent you a voice message on SureTalk.`,
      reason: `You received this email because ${sender} sent you a voice message with SureTalk.`,
      accountLinks: false,
      body: [
        t.callout(message || 'You have received a voice message.', { tone: 'info', title: noteTitle }),
        t.p('Click the button below to listen:'),
        t.button('Listen to voice note', listenUrl),
        t.p(`Sent via SureTalk. ${expiresText}`, { muted: true, small: true, center: true }),
      ]
    });
    return this._send({
      to: toEmail,
      subject: subject || `Voice Note from ${sender}: ${noteTitle}`,
      html,
      text: t.text({ title: 'Voice message for you', lines: [
        `${message || 'You have received a voice message.'}`, '', `Listen here: ${listenUrl}`, '', expiresText
      ] })
    });
  }

  // ══════════════════════════════════════════════════════════════════════════
  // 15. INTERNAL: NIGHTLY APP ↔ PHONE LINE COMPARISON (to ADMIN_EMAIL)
  // ══════════════════════════════════════════════════════════════════════════
  async sendReconcileReport(toEmail, { summary, fixes = [], issues = [] }) {
    const reviewUrl = `${this.siteUrl}/adminDashboard/super`;
    const line = (x) => `${x.label}${x.email || x.name ? ` — ${x.name || ''}${x.email ? ` (${x.email})` : ''}` : ''}`;
    const html = t.render({
      category: 'Admin', accent: issues.length ? 'urgent' : 'brand', title: 'Nightly app and phone line check',
      subtitle: `${summary.fixes} fixed automatically · ${summary.needsAttention} need a look`,
      preheader: `${summary.fixes} differences fixed, ${summary.needsAttention} need attention.`,
      reason: "You're receiving this because this address is set as SureTalk's admin alert address.",
      body: [
        t.details([
          ['Customers checked', String(summary.appCustomers)],
          ['Phone-line accounts', String(summary.phoneLineAccounts)],
          ['Fixed automatically', summary.fixesApplied || !summary.fixes ? String(summary.fixes) : `${summary.fixes} (not applied: over the safety limit)`],
          ['Need a look', String(summary.needsAttention)],
          ['Failed syncs (app → phone line)', String(summary.appFailedSyncs)],
          ['Failed syncs (phone line → app)', summary.phoneLineFailedSyncs == null ? 'Could not read' : String(summary.phoneLineFailedSyncs)],
        ]),
        fixes.length ? t.p(t.b(summary.fixesApplied ? 'Fixed automatically' : 'Differences found (not changed)')) : '',
        fixes.length ? t.list(fixes.slice(0, 20).map(line)) : '',
        issues.length ? t.p(t.b('Need a look')) : '',
        issues.length ? t.list(issues.slice(0, 20).map(line)) : '',
        (fixes.length > 20 || issues.length > 20) ? t.p('The full list is on the Super admin page.', { muted: true, small: true }) : '',
        t.button('Open the Sync monitor', reviewUrl, { tone: issues.length ? 'urgent' : 'primary' }),
      ].filter(Boolean)
    });
    return this._send({
      to: toEmail,
      subject: `[SureTalk] Nightly check: ${summary.fixes} fixed, ${summary.needsAttention} need a look`,
      html,
      text: [
        'SureTalk nightly app and phone line check', '',
        `Fixed automatically: ${summary.fixes}${summary.fixesApplied || !summary.fixes ? '' : ' (not applied: over the safety limit)'}`,
        ...fixes.slice(0, 20).map(f => `  - ${line(f)}`),
        `Need a look: ${summary.needsAttention}`,
        ...issues.slice(0, 20).map(i => `  - ${line(i)}`), '',
        `Details: ${reviewUrl}`
      ].join('\n')
    });
  }

  // ══════════════════════════════════════════════════════════════════════════
  // 14. INTERNAL: A SYNC TO THE PHONE LINE FAILED FOR GOOD (to ADMIN_EMAIL)
  // ══════════════════════════════════════════════════════════════════════════
  async sendSyncFailureAlert(toEmail, { recordId, eventType, error, payload }) {
    const reviewUrl = `${this.siteUrl}/adminDashboard/super`;
    const payloadText = JSON.stringify(payload, null, 2);
    const html = t.render({
      category: 'Admin', accent: 'urgent', title: 'A change could not reach the phone line',
      preheader: `Sync of type ${eventType} failed after every retry.`,
      reason: "You're receiving this because this address is set as SureTalk's admin alert address.",
      body: [
        t.p('The app tried to send this change to the phone line several times and gave up. Retry or dismiss it from the Failed syncs tab.'),
        t.details([['Record ID', recordId], ['Type', eventType], ['Error', error || '—']]),
        t.pre(payloadText),
        t.button('Open failed syncs', reviewUrl, { tone: 'urgent' }),
      ]
    });
    return this._send({
      to: toEmail,
      subject: `[SureTalk] Dead sync: ${eventType}`,
      html,
      text: `DEAD SYNC ITEM - App to phone line\n\nRecord ID: ${recordId}\nEvent Type: ${eventType}\nError: ${error}\nPayload: ${payloadText}\n\nOpen ${reviewUrl} to retry or dismiss it.`
    });
  }
}

module.exports = new EmailService();
