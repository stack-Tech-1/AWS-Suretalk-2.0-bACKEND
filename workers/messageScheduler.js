const { Pool } = require('pg');
const nodemailer = require('nodemailer');
//const twilio = require('twilio');
const { generateDownloadUrl } = require('../utils/s3Storage');
const { logger } = require('../server'); // Import logger safely

// Database connection
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

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

// Twilio client
const twilioClient = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);

// Process scheduled messages
const processScheduledMessages = async () => {
  const client = await pool.connect();
  
  try {
    await client.query('BEGIN');
    
    // Get messages scheduled for delivery now
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
        // Generate download URL
        const downloadUrl = await generateDownloadUrl(
          message.s3_key,
          message.s3_bucket,
          7 * 24 * 3600 // 7 days
        );

        let deliverySuccess = false;

        // Send email
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

        // Send SMS
        if (message.recipient_phone && message.delivery_method.includes('sms')) {
          try {
            await sendSMS(
              message.recipient_phone,
              message.voice_note_title,
              message.custom_message || `Voice note from ${message.sender_name}`,
              downloadUrl,
              message.sender_name
            );
            deliverySuccess = true;
          } catch (smsError) {
            console.error(`SMS delivery failed for message ${message.id}:`, smsError);
          }
        }

        // Update message status
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

          // Record analytics
          await client.query(
            `INSERT INTO analytics_events (
              user_id, event_type, voice_note_id, contact_id, event_data
            ) VALUES ($1, 'scheduled_message_sent', $2, $3, $4)`,
            [
              message.user_id,
              message.voice_note_id,
              message.recipient_contact_id,
              JSON.stringify({
                scheduledFor: message.scheduled_for,
                deliveredAt: now,
                deliveryMethod: message.delivery_method,
                noteTitle: message.voice_note_title
              })
            ]
          );

        } else {
          // Increment delivery attempts
          await client.query(
            `UPDATE scheduled_messages 
             SET delivery_attempts = delivery_attempts + 1,
                 last_attempt_at = $1,
                 error_message = 'Delivery failed for all methods',
                 updated_at = $1
             WHERE id = $2`,
            [now, message.id]
          );

          // Mark as failed if max attempts reached
          if (message.delivery_attempts + 1 >= 3) {
            await client.query(
              `UPDATE scheduled_messages 
               SET delivery_status = 'failed',
                   updated_at = $1
               WHERE id = $2`,
              [now, message.id]
            );
          }
        }

      } catch (error) {
        console.error(`Error processing message ${message.id}:`, error);
        
        // Log error but continue with other messages
        await client.query(
          `UPDATE scheduled_messages 
           SET delivery_attempts = delivery_attempts + 1,
               last_attempt_at = $1,
               error_message = $2,
               updated_at = $1
           WHERE id = $3`,
          [now, error.message, message.id]
        );
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
        <div style="margin-top: 30px; padding-top: 20px; border-top: 1px solid #eee; color: #666; font-size: 12px;">
          <p>Sent via SureTalk - Your Voice, Preserved Forever</p>
          <p>If you didn't expect this message, please ignore it.</p>
        </div>
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

// SMS sending function
const sendSMS = async (to, title, message, downloadUrl, senderName) => {
  const smsMessage = `
${message}

Voice note "${title}" from ${senderName}
Listen here: ${downloadUrl}

Link expires in 7 days.
Sent via SureTalk
  `.trim();

  await twilioClient.messages.create({
    body: smsMessage,
    from: process.env.TWILIO_PHONE_NUMBER,
    to
  });
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