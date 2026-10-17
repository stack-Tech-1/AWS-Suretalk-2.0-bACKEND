// Admin storage overview — read-only, built from the app's own records (voice_notes / voice_wills).
// S3 lifecycle rules and bucket settings are managed in the AWS console, not here.
// Mounted at /api/admin before routes/admin.js.
const express = require('express');
const router = express.Router();
const { authenticateAdmin } = require('../middleware/auth');
const { pool } = require('../config/database');
const { BUCKETS } = require('../utils/s3Storage');

// S3 Standard, eu-central-1 (Frankfurt), first 50 TB — an estimate; check the AWS bill for real figures
const S3_USD_PER_GB_MONTH = 0.0245;
const GB = 1024 ** 3;

// A recording that only exists in Twilio (phone-line recording) rather than in S3
const TWILIO_ONLY = `(vn.s3_key ~ '^RE[0-9a-fA-F]{32}$' OR (COALESCE(vn.source, 'app') = 'ivr' AND vn.s3_key NOT LIKE '%/%'))`;

const bucketLabel = (name) => {
  if (name === BUCKETS.VOICE_NOTES) return 'Voice notes';
  if (name === BUCKETS.LEGACY_VAULT) return 'Legacy Vault';
  if (name === BUCKETS.WILLS) return 'Voice wills';
  return name || 'Unknown';
};

router.get('/storage/overview', authenticateAdmin, async (req, res) => {
  try {
    const [byBucket, twilio, wills, byTier, users, monthly] = await Promise.all([
      pool.query(`
        SELECT vn.s3_bucket AS bucket, COUNT(*)::int AS files, COALESCE(SUM(vn.file_size_bytes), 0)::bigint AS bytes
        FROM voice_notes vn
        WHERE vn.deleted_at IS NULL AND NOT ${TWILIO_ONLY}
        GROUP BY vn.s3_bucket ORDER BY bytes DESC`),
      pool.query(`
        SELECT COUNT(*)::int AS files, COALESCE(SUM(vn.file_size_bytes), 0)::bigint AS bytes
        FROM voice_notes vn WHERE vn.deleted_at IS NULL AND ${TWILIO_ONLY}`),
      pool.query(`
        SELECT COUNT(*)::int AS total,
               COUNT(*) FILTER (WHERE COALESCE(source, 'app') = 'ivr')::int AS phone,
               COUNT(*) FILTER (WHERE metadata ? 'backup_s3_key')::int AS backups
        FROM voice_wills WHERE deleted_at IS NULL`),
      pool.query(`
        SELECT COALESCE(u.subscription_tier, 'LITE') AS tier, COUNT(DISTINCT u.id)::int AS users,
               COALESCE(SUM(vn.file_size_bytes) FILTER (WHERE vn.id IS NOT NULL AND NOT ${TWILIO_ONLY}), 0)::bigint AS bytes
        FROM users u
        LEFT JOIN voice_notes vn ON vn.user_id = u.id AND vn.deleted_at IS NULL
        WHERE u.deleted_at IS NULL AND COALESCE(u.is_admin, false) = false
        GROUP BY 1 ORDER BY bytes DESC`),
      // Per-user usage vs their limit (top users + anyone at or over 90% of their limit)
      pool.query(`
        WITH usage AS (
          SELECT u.id, u.full_name, u.email, u.subscription_tier, u.storage_limit_gb,
                 COALESCE(SUM(vn.file_size_bytes), 0)::bigint AS bytes, COUNT(vn.id)::int AS files
          FROM users u
          JOIN voice_notes vn ON vn.user_id = u.id AND vn.deleted_at IS NULL AND NOT ${TWILIO_ONLY}
          WHERE u.deleted_at IS NULL
          GROUP BY u.id
        )
        SELECT *, CASE WHEN storage_limit_gb > 0 THEN ROUND(bytes * 100.0 / (storage_limit_gb * ${GB}::numeric), 1) END AS percent_used
        FROM usage
        ORDER BY bytes DESC
        LIMIT 200`),
      pool.query(`
        SELECT TO_CHAR(DATE_TRUNC('month', m), 'YYYY-MM') AS key,
               (SELECT COUNT(*)::int FROM voice_notes vn WHERE DATE_TRUNC('month', vn.created_at) = DATE_TRUNC('month', m) AND NOT ${TWILIO_ONLY}) AS files,
               (SELECT COALESCE(SUM(vn.file_size_bytes), 0)::bigint FROM voice_notes vn WHERE DATE_TRUNC('month', vn.created_at) = DATE_TRUNC('month', m) AND NOT ${TWILIO_ONLY}) AS bytes
        FROM generate_series(DATE_TRUNC('month', NOW()) - INTERVAL '11 months', DATE_TRUNC('month', NOW()), INTERVAL '1 month') AS m
        ORDER BY m`),
    ]);

    const buckets = byBucket.rows.map(b => ({ bucket: b.bucket, label: bucketLabel(b.bucket), files: b.files, bytes: Number(b.bytes) }));
    const totalBytes = buckets.reduce((s, b) => s + b.bytes, 0);
    const usageRows = users.rows.map(u => ({ ...u, bytes: Number(u.bytes), percent_used: u.percent_used === null ? null : Number(u.percent_used) }));

    res.json({
      success: true,
      data: {
        totals: {
          bytes: totalBytes,
          files: buckets.reduce((s, b) => s + b.files, 0),
          estimatedMonthlyCostUsd: Math.round((totalBytes / GB) * S3_USD_PER_GB_MONTH * 100) / 100,
          pricePerGbUsd: S3_USD_PER_GB_MONTH,
        },
        buckets,
        twilioOnly: { files: twilio.rows[0].files, bytes: Number(twilio.rows[0].bytes) },
        wills: wills.rows[0],
        byTier: byTier.rows.map(t => ({ ...t, bytes: Number(t.bytes) })),
        topUsers: usageRows.slice(0, 10),
        nearOrOverLimit: usageRows.filter(u => u.percent_used !== null && u.percent_used >= 90).slice(0, 50),
        monthly: monthly.rows.map(m => ({ ...m, bytes: Number(m.bytes) })),
        region: process.env.AWS_REGION || 'eu-central-1',
      }
    });
  } catch (error) {
    console.error('Storage overview error:', error);
    res.status(500).json({ success: false, error: 'Failed to load storage overview' });
  }
});

module.exports = router;
