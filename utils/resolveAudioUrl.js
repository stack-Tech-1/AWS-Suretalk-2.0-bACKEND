const EC2_BASE_URL = process.env.EC2_STREAM_URL || 'https://test-api.suretalknow.com';

function resolveAudioUrl(record) {
  const source = record.source || 'app';

  // IVR recordings — stream via EC2 Twilio proxy
  if (source === 'ivr') {
    // Check twilio_recording_sid first
    const sid = record.twilio_recording_sid ||
      (record.s3_key && record.s3_key.startsWith('RE') && record.s3_key.length > 30 && !record.s3_key.includes('/')
        ? record.s3_key
        : null);

    if (sid) {
      return `${EC2_BASE_URL}/api/stream-recording/${sid}`;
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
  // URL suitable for use in Twilio <Play> tags — must be publicly accessible
  const source = record.source || 'app';
  const EC2 = process.env.EC2_STREAM_URL || 'https://test-api.suretalknow.com';

  if (source === 'ivr') {
    const sid = record.twilio_recording_sid ||
      (record.s3_key?.startsWith('RE') && record.s3_key?.length > 30 && !record.s3_key?.includes('/')
        ? record.s3_key
        : null);
    if (sid) return `${EC2}/api/stream-recording/${sid}`;
  }

  if (record.s3_key) {
    return `${EC2}/api/stream-s3-recording/${record.s3_key}`;
  }

  return null;
}

module.exports = { resolveAudioUrl, resolveIvrPlaybackUrl };
