// Signed audio links.
//
// Audio streams (Twilio recordings and S3 recordings) are served without a login, because browser
// <audio> players, Twilio <Play> and non-user recipients cannot send an Authorization header.
// Instead every link we hand out carries `exp` (unix seconds) and `sig` = HMAC-SHA256 over
// "<resource>|<exp>", where resource is "rec:<RecordingSid>" or "s3:<s3Key>". The same signature is
// accepted by this backend's /api/audio/* proxy and by the EC2 stream server, which shares
// AUDIO_SIGNING_SECRET.
//
// Rollout: links are signed as soon as AUDIO_SIGNING_SECRET is set. Unsigned requests are still
// served (and logged) until AUDIO_SIGNATURE_REQUIRED=true, so old links can be found and replaced first.
const crypto = require('crypto');

const TTL = {
  app: 6 * 3600,               // dashboard players and the recipient /play page (refetched per visit)
  call: 3600,                  // Twilio <Play> during a scheduled call
  ivr: 10 * 365 * 24 * 3600,   // links stored by the IVR for phone playback
};

const getSecret = () => process.env.AUDIO_SIGNING_SECRET;
const signatureRequired = () => process.env.AUDIO_SIGNATURE_REQUIRED === 'true';

const computeSignature = (resource, exp) =>
  crypto.createHmac('sha256', getSecret()).update(`${resource}|${exp}`).digest('hex');

// Returns "exp=...&sig=..." for the resource, or '' when signing is not configured yet
function signatureQuery(resource, ttlSeconds) {
  if (!getSecret()) return '';
  const exp = Math.floor(Date.now() / 1000) + ttlSeconds;
  return `exp=${exp}&sig=${computeSignature(resource, exp)}`;
}

const withQuery = (path, query) => (query ? `${path}?${query}` : path);

const recordingResource = (sid) => `rec:${sid}`;
const s3Resource = (s3Key) => `s3:${s3Key}`;

// EC2 stream server URLs (used by Twilio calls, the /play page and links stored by the IVR)
const signedEc2RecordingUrl = (baseUrl, sid, ttlSeconds) =>
  withQuery(`${baseUrl}/api/stream-recording/${sid}`, signatureQuery(recordingResource(sid), ttlSeconds));

const signedEc2S3Url = (baseUrl, s3Key, ttlSeconds) =>
  withQuery(`${baseUrl}/api/stream-s3-recording/${s3Key}`, signatureQuery(s3Resource(s3Key), ttlSeconds));

// Paths on this backend's /api/audio proxy (prefix with the API origin or `/api`)
const signedProxyRecordingPath = (sid, ttlSeconds = TTL.app) =>
  withQuery(`/audio/recording/${sid}`, signatureQuery(recordingResource(sid), ttlSeconds));

const signedProxyS3Path = (s3Key, ttlSeconds = TTL.app) =>
  withQuery(`/audio/s3/${s3Key}`, signatureQuery(s3Resource(s3Key), ttlSeconds));

function isValidSignature(resource, exp, sig) {
  if (!getSecret() || !exp || !sig || typeof sig !== 'string') return false;
  const expSeconds = Number(exp);
  if (!Number.isFinite(expSeconds) || expSeconds < Math.floor(Date.now() / 1000)) return false;
  const expected = Buffer.from(computeSignature(resource, expSeconds), 'hex');
  const given = Buffer.from(sig, 'hex');
  return given.length === expected.length && crypto.timingSafeEqual(given, expected);
}

// Express middleware for the /api/audio proxy routes. resourceFromReq maps the request to its resource.
const requireAudioSignature = (resourceFromReq, logger = console) => (req, res, next) => {
  const resource = resourceFromReq(req);
  if (isValidSignature(resource, req.query.exp, req.query.sig)) return next();

  if (signatureRequired()) {
    return res.status(403).json({ error: 'This audio link is invalid or has expired' });
  }
  // Transition mode: serve, but log so remaining unsigned callers can be found before enforcing
  logger.warn(`[audio] unsigned or invalid audio request allowed (enforcement off): ${resource} ip=${req.ip} ua=${req.get('user-agent')}`);
  next();
};

module.exports = {
  TTL,
  signedEc2RecordingUrl,
  signedEc2S3Url,
  signedProxyRecordingPath,
  signedProxyS3Path,
  requireAudioSignature,
  isValidSignature,
};
