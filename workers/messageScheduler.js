// messageScheduler.js

const { pool } = require('../config/database');

const { generateDownloadUrl } = require('../utils/s3Storage');


// Process scheduled messages
const processScheduledMessages = async () => {
  const now = new Date();

  // Hold the client only long enough to atomically SELECT the rows.
  // Releasing before email/Twilio calls avoids tying up a DB connection during I/O.
  let lockedRows;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await client.query(
      `SELECT id, voice_note_id, user_id, recipient_contact_id,
              recipient_email, delivery_method, custom_message,
              delivery_attempts
       FROM scheduled_messages
       WHERE delivery_status = 'scheduled'
         AND scheduled_for <= $1
         AND delivery_attempts < 3
       FOR UPDATE SKIP LOCKED
       LIMIT 50`,
      [now]
    );
    lockedRows = result.rows;
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('Error locking scheduled messages:', error);
    return;
  } finally {
    client.release();
  }

  for (const sm of lockedRows) {
    try {
      // Fetch enrichment data using pool.query() — no client held during I/O
      const detailResult = await pool.query(
        `SELECT vn.title as voice_note_title, vn.s3_key, vn.s3_bucket,
                vn.twilio_recording_sid,
                u.full_name as sender_name, u.email as sender_email,
                c.name as recipient_name, c.phone as recipient_phone
         FROM voice_notes vn
         JOIN users u ON u.id = $2
         LEFT JOIN contacts c ON c.id = $3
         WHERE vn.id = $1`,
        [sm.voice_note_id, sm.user_id, sm.recipient_contact_id]
      );

      if (detailResult.rows.length === 0) {
        await pool.query(
          `UPDATE scheduled_messages
           SET delivery_attempts = delivery_attempts + 1,
               last_attempt_at = $1,
               error_message = 'Voice note or user not found',
               updated_at = $1
           WHERE id = $2`,
          [now, sm.id]
        );
        continue;
      }

      const message = { ...sm, ...detailResult.rows[0] };

      let downloadUrl = null;
      if (message.s3_key && message.s3_bucket &&
          !message.s3_key.startsWith('http') &&
          !message.s3_key.startsWith('RE')) {
        try {
          downloadUrl = await generateDownloadUrl(
            message.s3_key,
            message.s3_bucket,
            7 * 24 * 3600
          );
        } catch (urlError) {
          console.warn('Could not generate download URL for scheduled message', sm.id, urlError.message);
          downloadUrl = process.env.FRONTEND_URL + '/usersDashboard/voice-notes';
        }
      } else {
        downloadUrl = process.env.FRONTEND_URL + '/usersDashboard/voice-notes';
      }

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

      if (message.recipient_phone && message.delivery_method !== 'email') {
        console.log(`Phone delivery skipped for message ${message.id} - Twilio not configured. Phone: ${message.recipient_phone}`);
        // Phone delivery will be added in a future update
        // For now, if email also exists, email delivery counts as success
        if (!message.recipient_email) {
          // Phone-only delivery — mark as failed with clear reason
          await pool.query(
            `UPDATE scheduled_messages
             SET delivery_attempts = delivery_attempts + 1,
                 last_attempt_at = $1,
                 error_message = 'Phone delivery not yet configured - please use email delivery',
                 updated_at = $1
             WHERE id = $2`,
            [now, sm.id]
          );
          continue;
        }
      }

      if (deliverySuccess) {
        await pool.query(
          `UPDATE scheduled_messages
           SET delivery_status = 'delivered',
               delivered_at = $1,
               delivery_attempts = delivery_attempts + 1,
               updated_at = $1
           WHERE id = $2`,
          [now, message.id]
        );
      } else {
        await pool.query(
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
      console.error(`Error processing message ${sm.id}:`, error);
    }
  }

  console.log(`Processed ${lockedRows.length} scheduled messages`);
};

// Email sending function (AWS SES)
const sendEmail = async (to, title, message, downloadUrl, senderName) => {
  const AWS = require('aws-sdk');
  const ses = new AWS.SES({
    region: process.env.AWS_REGION,
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY
  });

  const emailHtml = `
    <!DOCTYPE html>
    <html>
    <head><meta charset="UTF-8"></head>
    <body style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
      <div style="background: linear-gradient(135deg, #6366f1 0%, #7c3aed 100%);
                  color: white; padding: 30px; text-align: center; border-radius: 12px 12px 0 0;">
        <h1 style="margin: 0; font-size: 24px;">Voice Message for You</h1>
        <p style="margin: 10px 0 0; opacity: 0.9;">A message from ${senderName}</p>
      </div>
      <div style="background: #f9f9f9; padding: 30px; border-radius: 0 0 12px 12px; border: 1px solid #e2e8f0;">
        <p style="color: #334155; font-size: 16px;">${message}</p>
        <p style="color: #64748b;">Click the button below to listen to your voice message:</p>
        <div style="text-align: center; margin: 30px 0;">
          <a href="${downloadUrl}"
             style="display: inline-block; background: linear-gradient(135deg, #6366f1, #7c3aed);
                    color: white; padding: 14px 32px; text-decoration: none; border-radius: 8px;
                    font-weight: bold; font-size: 16px;">
            🎧 Listen to Voice Note
          </a>
        </div>
        <p style="color: #94a3b8; font-size: 12px; text-align: center;">
          This link will expire in 7 days. Sent via SureTalk.
        </p>
      </div>
    </body>
    </html>
  `;

  const params = {
    Destination: { ToAddresses: [to] },
    Message: {
      Body: {
        Html: { Charset: 'UTF-8', Data: emailHtml },
        Text: {
          Charset: 'UTF-8',
          Data: `${message}\n\nListen to your voice note: ${downloadUrl}\n\nThis link expires in 7 days.`
        }
      },
      Subject: {
        Charset: 'UTF-8',
        Data: `Voice Note: ${title}`
      }
    },
    Source: process.env.SES_FROM_EMAIL
  };

  await ses.sendEmail(params).promise();
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
