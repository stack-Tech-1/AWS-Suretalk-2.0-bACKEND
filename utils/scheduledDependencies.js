// utils/scheduledDependencies.js — a scheduled message has no audio of its own: it plays a saved voice
// note or will. Before a recording is deleted, this finds the messages still waiting to send it, so the
// customer can be warned, and cancels them once the customer confirms.
const axios = require('axios');
const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, ScanCommand } = require('@aws-sdk/lib-dynamodb');
const { pool } = require('../config/database');

let doc;
const dynamo = () => {
  if (!doc) {
    doc = DynamoDBDocumentClient.from(new DynamoDBClient({
      region: process.env.IVR_AWS_REGION || 'eu-central-1',
      credentials: process.env.AWS_ACCESS_KEY_ID
        ? { accessKeyId: process.env.AWS_ACCESS_KEY_ID, secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY }
        : undefined,
      maxAttempts: 3,
    }));
  }
  return doc;
};

const phoneLineId = (phone) => {
  const digits = String(phone || '').replace(/\D/g, '');
  return digits.length === 10 ? `+1${digits}` : `+${digits}`;
};

// The recording a link or id points at, without the link's signature
const recordingKey = (v) => String(v || '').split('?')[0].replace(/\/+$/, '').split('/').pop();

async function pendingOnPhoneLine(phone) {
  const items = [];
  let ExclusiveStartKey;
  do {
    const r = await dynamo().send(new ScanCommand({
      TableName: process.env.DYNAMO_SCHEDULES_TABLE || 'SCHEDULES',
      FilterExpression: 'userId = :u AND #s = :pending',
      ExpressionAttributeNames: { '#s': 'status' },
      ExpressionAttributeValues: { ':u': phoneLineId(phone), ':pending': 'PENDING' },
      ExclusiveStartKey,
    }));
    items.push(...(r.Items || []));
    ExclusiveStartKey = r.LastEvaluatedKey;
  } while (ExclusiveStartKey);
  return items;
}

/**
 * Messages still waiting to send this recording, from the app and the phone line, each listed once.
 * Returns [{ id, ivrScheduleId, scheduledFor, recipient }].
 */
async function findDependentMessages({ userId, phone, voiceNoteId, recordings }) {
  const keys = new Set((recordings || []).filter(Boolean).map(recordingKey));
  const found = [];

  if (userId) {
    const r = await pool.query(
      `SELECT sm.id, sm.voice_note_id, sm.scheduled_for, sm.recipient_phone, sm.recipient_email, sm.metadata,
              c.name AS contact_name, vn.s3_key, vn.twilio_recording_sid
       FROM scheduled_messages sm
       LEFT JOIN contacts c ON c.id = sm.recipient_contact_id
       LEFT JOIN voice_notes vn ON vn.id = sm.voice_note_id
       WHERE sm.user_id = $1 AND sm.delivery_status = 'scheduled'`,
      [userId]
    );
    for (const m of r.rows) {
      const uses = (voiceNoteId && m.voice_note_id === voiceNoteId)
        || [m.metadata?.recordingSid, m.s3_key, m.twilio_recording_sid].some(v => v && keys.has(recordingKey(v)));
      if (uses) {
        found.push({
          id: m.id,
          ivrScheduleId: m.metadata?.ivrScheduleId || null,
          scheduledFor: new Date(m.scheduled_for).toISOString(),
          recipient: m.contact_name || m.recipient_phone || m.recipient_email || '',
        });
      }
    }
  }

  // Scheduled on a call and not yet copied to the app, or a customer with no app account
  try {
    const known = new Set(found.map(m => m.ivrScheduleId).filter(Boolean));
    for (const s of await pendingOnPhoneLine(phone)) {
      const uses = [s.recordingSid, s.audioUrl].some(v => v && keys.has(recordingKey(v)));
      if (uses && !known.has(s.scheduleId)) {
        found.push({ id: null, ivrScheduleId: s.scheduleId, scheduledFor: s.scheduledFor, recipient: s.contact || '' });
      }
    }
  } catch (err) {
    console.warn(`Could not read phone-line schedules: ${err.message}`);
  }
  return found.sort((a, b) => String(a.scheduledFor).localeCompare(String(b.scheduledFor)));
}

// Cancels a phone-scheduled message on the phone line. Returns the answer's status, or null if unreachable.
async function cancelOnPhoneLine(phone, ivrScheduleId) {
  if (!process.env.IVR_API_URL || !process.env.IVR_REQUEST_KEY) return null;
  try {
    const r = await axios.post(`${process.env.IVR_API_URL}/deleteScheduledMessage`,
      { key: process.env.IVR_REQUEST_KEY, userId: phone, scheduleId: ivrScheduleId, source: 'app' },
      { timeout: 8000, validateStatus: () => true });
    return r.status;
  } catch (err) {
    console.error('Phone line cancel failed:', err.message);
    return null;
  }
}

// Throws if a message can't be cancelled, so its recording is not deleted while it is still due to send
async function cancelDependentMessages(messages, phone) {
  for (const m of messages) {
    if (m.ivrScheduleId) {
      const status = await cancelOnPhoneLine(phone, m.ivrScheduleId);
      if (status !== 200 && status !== 404) throw new Error('PHONE_LINE_UNAVAILABLE');
    }
    if (m.id) {
      await pool.query(
        `UPDATE scheduled_messages
         SET delivery_status = 'cancelled', cancelled_at = NOW(), updated_at = NOW(),
             metadata = COALESCE(metadata, '{}'::jsonb) || '{"cancelledBecause":"recording deleted"}'::jsonb
         WHERE id = $1 AND delivery_status = 'scheduled'`,
        [m.id]
      );
    }
  }
}

/**
 * For the delete routes. Returns true when the delete may go ahead. Otherwise it has already answered:
 * 409 with the messages to warn about, or 502 if they could not be cancelled.
 * The customer confirms by repeating the delete with ?cancelScheduled=true.
 */
async function clearScheduledBeforeDelete(req, res, { voiceNoteId, recordings }) {
  const messages = await findDependentMessages({ userId: req.user.id, phone: req.user.phone, voiceNoteId, recordings });
  if (!messages.length) return true;
  if (req.query.cancelScheduled !== 'true') {
    res.status(409).json({
      success: false,
      code: 'HAS_SCHEDULED_MESSAGES',
      error: 'This recording is scheduled to be sent. Deleting it will cancel the scheduled message.',
      scheduled: messages.map(({ scheduledFor, recipient }) => ({ scheduledFor, recipient })),
    });
    return false;
  }
  try {
    await cancelDependentMessages(messages, req.user.phone);
    return true;
  } catch (err) {
    res.status(502).json({
      success: false,
      code: 'PHONE_LINE_UNAVAILABLE',
      error: 'Could not cancel the scheduled message right now, so nothing was deleted. Try again in a moment.',
    });
    return false;
  }
}

module.exports = { findDependentMessages, cancelDependentMessages, clearScheduledBeforeDelete, cancelOnPhoneLine, recordingKey };
