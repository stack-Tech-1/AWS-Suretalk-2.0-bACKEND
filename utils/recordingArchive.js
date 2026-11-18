// utils/recordingArchive.js — what happens to the audio when a customer deletes a recording.
// Retention policy (decided 2026-11-18): deleted recordings are kept for 2 years in a private archive
// bucket, whose lifecycle rule erases them automatically. The original in Twilio or S3 is removed only
// after its copy is safely in the archive; if archiving fails, the original stays where it is.
const axios = require('axios');
const { S3Client, CopyObjectCommand, PutObjectCommand } = require('@aws-sdk/client-s3');
const Twilio = require('twilio');
const { deleteFromS3 } = require('./s3Storage');

const ARCHIVE_BUCKET = process.env.AWS_S3_BUCKET_ARCHIVE || 'suretalk-deleted-recordings-archive';

const s3 = new S3Client({ region: process.env.AWS_REGION || 'eu-central-1' });

const archiveKey = (kind, userId, fileName) =>
  `${kind}/${userId}/${new Date().toISOString().slice(0, 10)}/${fileName}`;

const details = (kind, userId, recordId) => ({
  kind,
  'user-id': String(userId),
  'record-id': String(recordId),
  'deleted-at': new Date().toISOString(),
});

async function archiveS3File(record, { kind, userId }) {
  await s3.send(new CopyObjectCommand({
    Bucket: ARCHIVE_BUCKET,
    Key: archiveKey(kind, userId, record.s3_key.split('/').pop()),
    CopySource: encodeURI(`${record.s3_bucket}/${record.s3_key}`),
    MetadataDirective: 'REPLACE',
    Metadata: details(kind, userId, record.id),
    ServerSideEncryption: 'AES256',
  }));
}

// Returns false when Twilio no longer has the recording
async function archiveTwilioFile(sid, record, { kind, userId }) {
  const response = await axios.get(
    `https://api.twilio.com/2010-04-01/Accounts/${process.env.TWILIO_ACCOUNT_SID}/Recordings/${sid}.mp3`,
    {
      auth: { username: process.env.TWILIO_ACCOUNT_SID, password: process.env.TWILIO_AUTH_TOKEN },
      responseType: 'arraybuffer',
      timeout: 60000,
      validateStatus: (status) => status === 200 || status === 404,
    }
  );
  if (response.status === 404) return false;
  await s3.send(new PutObjectCommand({
    Bucket: ARCHIVE_BUCKET,
    Key: archiveKey(kind, userId, `${sid}.mp3`),
    Body: Buffer.from(response.data),
    ContentType: 'audio/mpeg',
    Metadata: details(kind, userId, record.id),
    ServerSideEncryption: 'AES256',
  }));
  return true;
}

const twilioSidOf = (record) => record.twilio_recording_sid ||
  (record.s3_key?.startsWith('RE') && !record.s3_key.includes('/') ? record.s3_key : null);

/**
 * Archives a deleted voice note or will, then removes the original. Never throws, so it is safe to call
 * without waiting. kind is 'voice-note' or 'voice-will'.
 */
async function archiveThenDelete(record, { kind, userId }) {
  try {
    if (record.source === 'ivr') {
      const sid = twilioSidOf(record);
      if (!sid || !process.env.TWILIO_ACCOUNT_SID || !process.env.TWILIO_AUTH_TOKEN) return;
      if (await archiveTwilioFile(sid, record, { kind, userId })) {
        await new Twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN).recordings(sid).remove();
      }
    } else if (record.s3_key && record.s3_bucket) {
      await archiveS3File(record, { kind, userId });
      await deleteFromS3(record.s3_key, record.s3_bucket);
    }
  } catch (err) {
    console.error(`Recording ${record.id} (${kind}) was not archived, so the original was kept: ${err.message}`);
  }
}

module.exports = { archiveThenDelete, ARCHIVE_BUCKET };
