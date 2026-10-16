const { signedEc2RecordingUrl, signedEc2S3Url, signedProxyRecordingPath, signedProxyS3Path, TTL } = require('./audioSigning');

const EC2_BASE_URL = process.env.EC2_STREAM_URL || 'https://test-api.suretalknow.com';

const twilioSidOf = (record) =>
  record.twilio_recording_sid ||
  (record.s3_key?.startsWith('RE') && record.s3_key.length > 30 && !record.s3_key.includes('/')
    ? record.s3_key
    : null);

function resolveAudioUrl(record) {
  const source = record.source || 'app';

  // IVR recordings — stream via EC2 Twilio proxy
  if (source === 'ivr') {
    const sid = twilioSidOf(record);
    if (sid) {
      return signedEc2RecordingUrl(EC2_BASE_URL, sid, TTL.app);
    }
  }

  // App recordings — stream via EC2 S3 proxy (for IVR delivery)
  // or use S3 signed URL (for app playback)
  // We return the s3Key here so the caller can generate a signed URL or build the EC2 stream URL
  if (record.s3_key && record.s3_bucket) {
    return null; // Signal: use generateDownloadUrl(s3_key, s3_bucket)
  }

  return null;
}

function resolveIvrPlaybackUrl(record) {
  // URL suitable for use in Twilio <Play> tags — must be publicly accessible.
  // The IVR stores this link for phone playback, so it gets a long-lived signature.
  const source = record.source || 'app';
  const EC2 = process.env.EC2_STREAM_URL || 'https://test-api.suretalknow.com';

  if (source === 'ivr') {
    const sid = twilioSidOf(record);
    if (sid) return signedEc2RecordingUrl(EC2, sid, TTL.ivr);
  }

  if (record.s3_key) {
    return signedEc2S3Url(EC2, record.s3_key, TTL.ivr);
  }

  return null;
}

function resolveAppPlaybackUrl(record) {
  // Relative path for use in the frontend audio player.
  // Frontend prepends the API base URL (e.g. http://localhost:5000/api).
  const source = record.source || 'app';

  if (source === 'ivr') {
    const sid = twilioSidOf(record);
    if (sid) return signedProxyRecordingPath(sid);
  }

  if (record.s3_key) {
    return signedProxyS3Path(record.s3_key);
  }

  return null;
}

module.exports = { resolveAudioUrl, resolveIvrPlaybackUrl, resolveAppPlaybackUrl };
