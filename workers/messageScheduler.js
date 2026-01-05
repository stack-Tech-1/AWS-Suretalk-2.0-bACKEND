// messageScheduler.js

const { pool } = require('../config/database');

const nodemailer = require('nodemailer');
// const twilio = require('twilio'); // omit for now
const { generateDownloadUrl } = require('../utils/s3Storage');
const logger = require('../utils/logger');


// Email transporter
const emailTransporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: process.env.SMTP_PORT,
  secure: process.env.SMTP_SECURE === 'true',
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS
  }
});

// Process scheduled messages
const processScheduledMessages = async () => {
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const now = new Date();
    const messages = await client.query(
      `SELECT sm.*, vn.title as voice_note_title, vn.s3_key, vn.s3_bucket,
              u.full_name as sender_name, u.email as sender_email,
              c.name as recipient_name
       FROM scheduled_messages sm
       JOIN voice_notes vn ON sm.voice_note_id = vn.id
       JOIN users u ON sm.user_id = u.id
       LEFT JOIN contacts c ON sm.recipient_contact_id = c.id
       WHERE sm.delivery_status = 'scheduled'
         AND sm.scheduled_for <= $1
         AND sm.delivery_attempts < 3
       FOR UPDATE SKIP LOCKED
       LIMIT 50`,
      [now]
    );

    for (const message of messages.rows) {
      try {
        const downloadUrl = await generateDownloadUrl(
          message.s3_key,
          message.s3_bucket,
          7 * 24 * 3600
        );

        let deliverySuccess = false;

        if (message.recipient_email && message.delivery_method.includes('email')) {
          try {
            await sendEmail(
              message.recipient_email,
              message.voice_note_title,
              message.custom_message || `Voice note from ${message.sender_name}`,
              downloadUrl,
              message.sender_name
            );
            deliverySuccess = true;
          } catch (emailError) {
            console.error(`Email delivery failed for message ${message.id}:`, emailError);
          }
        }

        // You can re-add SMS later if needed

        if (deliverySuccess) {
          await client.query(
            `UPDATE scheduled_messages 
             SET delivery_status = 'delivered',
                 delivered_at = $1,
                 delivery_attempts = delivery_attempts + 1,
                 updated_at = $1
             WHERE id = $2`,
            [now, message.id]
          );
        } else {
          await client.query(
            `UPDATE scheduled_messages 
             SET delivery_attempts = delivery_attempts + 1,
                 last_attempt_at = $1,
                 error_message = 'Delivery failed for all methods',
                 updated_at = $1
             WHERE id = $2`,
            [now, message.id]
          );
        }
      } catch (error) {
        console.error(`Error processing message ${message.id}:`, error);
      }
    }

    await client.query('COMMIT');
    console.log(`Processed ${messages.rows.length} scheduled messages`);

  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Error processing scheduled messages:', error);
  } finally {
    client.release();
  }
};

// Email sending function
const sendEmail = async (to, title, message, downloadUrl, senderName) => {
  const emailHtml = `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
      <div style="background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); 
                  color: white; padding: 30px; text-align: center; border-radius: 10px 10px 0 0;">
        <h1 style="margin: 0;">${title}</h1>
        <p style="margin: 10px 0 0; opacity: 0.9;">A voice message from ${senderName}</p>
      </div>
      <div style="background: #f9f9f9; padding: 30px; border-radius: 0 0 10px 10px;">
        <p>${message}</p>
        <p>Click the button below to listen to the voice note:</p>
        <a href="${downloadUrl}" 
           style="display: inline-block; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); 
                  color: white; padding: 12px 30px; text-decoration: none; border-radius: 5px; 
                  margin: 20px 0;">
          Listen to Voice Note
        </a>
        <p><small>This link will expire in 7 days.</small></p>
      </div>
    </div>
  `;

  const mailOptions = {
    from: `"SureTalk" <${process.env.SMTP_FROM || 'noreply@suretalk.com'}>`,
    to,
    subject: `Voice Note: ${title}`,
    html: emailHtml,
    text: `${message}\n\nListen to voice note: ${downloadUrl}\n\nThis link will expire in 7 days.`
  };

  await emailTransporter.sendMail(mailOptions);
};

// Start scheduler
const startScheduler = () => {
  console.log('Message scheduler started');

  // Run scheduled messages every minute
  setInterval(processScheduledMessages, 60 * 1000);

  // Run immediately on startup
  processScheduledMessages();
};

module.exports = { startScheduler, processScheduledMessages };
