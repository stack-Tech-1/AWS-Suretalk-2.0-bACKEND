// messageScheduler.js
// Required env vars for delivery:
// SES_FROM_EMAIL        — verified AWS SES sender email
// TWILIO_ACCOUNT_SID   — from Twilio console
// TWILIO_AUTH_TOKEN    — from Twilio console
// TWILIO_PHONE_NUMBER  — your Twilio phone number (e.g. +15551234567)
// EC2_STREAM_URL       — https://test-api.suretalknow.com

const { pool } = require('../config/database');
const AWS = require('aws-sdk');
const twilio = require('twilio');
const { generateDownloadUrl } = require('../utils/s3Storage');
const logger = require('../utils/logger');

const twilioClient = process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN
  ? twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN)
  : null;

const ses = new AWS.SES({
  region: process.env.AWS_REGION,
  accessKeyId: process.env.AWS_ACCESS_KEY_ID,
  secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY
});

// Email sending function (AWS SES)
const sendEmail = async (to, title, message, downloadUrl, senderName) => {
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
        <p style="color: #334155; font-size: 16px;">${message || 'You have received a voice message.'}</p>
        <p style="color: #64748b;">Click the button below to listen:</p>
        <div style="text-align: center; margin: 30px 0;">
          <a href="${downloadUrl}"
             style="display: inline-block; background: linear-gradient(135deg, #6366f1, #7c3aed);
                    color: white; padding: 14px 32px; text-decoration: none; border-radius: 8px;
                    font-weight: bold; font-size: 16px;">
            🎧 Listen to Voice Note
          </a>
        </div>
        <p style="color: #94a3b8; font-size: 12px; text-align: center;">
          Sent via SureTalk. This link expires in 7 days.
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
          Data: `${message || 'You have received a voice message.'}\n\nListen here: ${downloadUrl}\n\nThis link expires in 7 days.`
        }
      },
      Subject: {
        Charset: 'UTF-8',
        Data: `Voice Note from ${senderName}: ${title}`
      }
    },
    Source: process.env.SES_FROM_EMAIL
  };

  await ses.sendEmail(params).promise();
  logger.info(`Email sent via SES to ${to}`);
};

// Twilio phone call
const makePhoneCall = async (to, senderName, audioUrl, customMessage) => {
  if (!twilioClient) throw new Error('Twilio not configured');
  const fromNumber = process.env.TWILIO_PHONE_NUMBER;
  if (!fromNumber) throw new Error('TWILIO_PHONE_NUMBER not set in environment');

  const introText = customMessage
    ? customMessage
    : `Hello! You have a voice message from ${senderName} on SureTalk.`;

  const twiml = `<?xml version="1.0" encoding="TwiML"?>
    <Response>
      <Say voice="Polly.Joanna" language="en-US">${introText}</Say>
      <Pause length="1"/>
      <Say voice="Polly.Joanna" language="en-US">Here is your message:</Say>
      <Pause length="1"/>
      <Play>${audioUrl}</Play>
      <Pause length="1"/>
      <Say voice="Polly.Joanna" language="en-US">This message was delivered by SureTalk. Goodbye.</Say>
    </Response>`;

  const call = await twilioClient.calls.create({
    to,
    from: fromNumber,
    twiml,
    timeout: 30,
    statusCallback: process.env.TWILIO_STATUS_CALLBACK_URL || undefined
  });

  logger.info(`Phone call initiated to ${to}, call SID: ${call.sid}`);
  return call.sid;
};

// Twilio SMS
const sendSMS = async (to, senderName, downloadUrl, customMessage) => {
  if (!twilioClient) throw new Error('Twilio not configured');
  const fromNumber = process.env.TWILIO_PHONE_NUMBER;
  if (!fromNumber) throw new Error('TWILIO_PHONE_NUMBER not set in environment');

  const body = customMessage
    ? `${customMessage}\n\nListen to your voice note: ${downloadUrl}`
    : `You have a voice message from ${senderName} on SureTalk.\n\nListen here: ${downloadUrl}`;

  const smsMessage = await twilioClient.messages.create({ to, from: fromNumber, body });
  logger.info(`SMS sent to ${to}, message SID: ${smsMessage.sid}`);
  return smsMessage.sid;
};

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
      let errorMessages = [];
      let callSid = null;
      let smsSid = null;

      // Build audio URL for Twilio <Play> — must be publicly accessible
      const EC2_URL = process.env.EC2_STREAM_URL || 'https://test-api.suretalknow.com';
      const audioUrl = message.s3_key && !message.s3_key.startsWith('http') && !message.s3_key.startsWith('RE')
        ? `${EC2_URL}/api/stream-s3-recording/${message.s3_key}`
        : downloadUrl;

      // EMAIL DELIVERY
      if (message.recipient_email &&
          (message.delivery_method === 'email' || message.delivery_method === 'both')) {
        try {
          await sendEmail(
            message.recipient_email,
            message.voice_note_title || 'Voice Note',
            message.custom_message || `You have a voice message from ${message.sender_name}`,
            downloadUrl,
            message.sender_name || 'SureTalk'
          );
          deliverySuccess = true;
          logger.info(`Email delivered for message ${sm.id}`);
        } catch (emailError) {
          logger.error(`Email delivery failed for message ${sm.id}:`, emailError.message);
          errorMessages.push(`Email: ${emailError.message}`);
        }
      }

      // PHONE DELIVERY (call + SMS)
      if (message.recipient_phone &&
          (message.delivery_method === 'phone' || message.delivery_method === 'both')) {

        try {
          callSid = await makePhoneCall(
            message.recipient_phone,
            message.sender_name || 'SureTalk',
            audioUrl,
            message.custom_message
          );
          deliverySuccess = true;
          logger.info(`Call delivered for message ${sm.id}, SID: ${callSid}`);
        } catch (callError) {
          logger.error(`Call delivery failed for message ${sm.id}:`, callError.message);
          errorMessages.push(`Call: ${callError.message}`);
        }

        try {
          smsSid = await sendSMS(
            message.recipient_phone,
            message.sender_name || 'SureTalk',
            downloadUrl,
            message.custom_message
          );
          logger.info(`SMS delivered for message ${sm.id}, SID: ${smsSid}`);
        } catch (smsError) {
          logger.error(`SMS delivery failed for message ${sm.id}:`, smsError.message);
          errorMessages.push(`SMS: ${smsError.message}`);
        }
      }

      if (deliverySuccess) {
        await pool.query(
          `UPDATE scheduled_messages
           SET delivery_status = 'delivered',
               delivered_at = $1,
               delivery_attempts = delivery_attempts + 1,
               twilio_call_sid = $3,
               twilio_message_sid = $4,
               updated_at = $1
           WHERE id = $2`,
          [now, sm.id, callSid || null, smsSid || null]
        );
      } else {
        await pool.query(
          `UPDATE scheduled_messages
           SET delivery_attempts = delivery_attempts + 1,
               last_attempt_at = $1,
               error_message = $3,
               updated_at = $1
           WHERE id = $2`,
          [now, sm.id, errorMessages.join(' | ') || 'All delivery methods failed']
        );
      }
    } catch (error) {
      console.error(`Error processing message ${sm.id}:`, error);
    }
  }

  console.log(`Processed ${lockedRows.length} scheduled messages`);
};

// Start scheduler
const startScheduler = () => {
  console.log('Message scheduler started');
  setInterval(processScheduledMessages, 60 * 1000);
  processScheduledMessages();
};

module.exports = { startScheduler, processScheduledMessages };
