// workers/syncReconciler.js
// Nightly comparison of every customer in the app with their phone-line account (DynamoDB Users).
// Fixed automatically (the app is the source of truth for these; Stripe drives the app's plan):
//   - plan differs                     → the app's plan is sent to the phone line, EXCEPT when the
//                                        phone line has an active Stripe subscription the app doesn't
//                                        know about (paid on a call): then it's only reported
//   - suspended in the app, phone on   → phone sign-in switched off
//   - deleted in the app, phone on     → phone-line account soft-deleted
// Reported for a person to look at:
//   - phone sign-in off for an active app customer (may be on purpose, e.g. old unsubscribes)
//   - an account created by phone whose phone-line account is missing
// Content (recordings, wills, contacts) is not compared yet: that sync is still being built.
// Runs once a night after RUN_HOUR_UTC (a database lock stops two backend copies running it), and on
// demand from Super admin → Sync monitor. More than MAX_AUTO_FIXES differences = nothing is changed
// automatically, in case something upstream is wrong.
const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, ScanCommand } = require('@aws-sdk/lib-dynamodb');
const { pool } = require('../config/database');
const logger = require('../utils/logger');
const { syncAccountToIvr } = require('../utils/syncIvr');
const { ivrTierName } = require('../utils/tierMapping');

const RUN_HOUR_UTC = 3;
const CHECK_EVERY_MS = 15 * 60 * 1000;
const MAX_AUTO_FIXES = 25;
const LOCK_ID = 727001;

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

// Same number written different ways (+1 or not, spaces, brackets) → one key
const phoneKey = (phone) => {
  let d = String(phone || '').replace(/[^0-9]/g, '');
  if (d.length === 11 && d.startsWith('1')) d = d.slice(1);
  return d;
};
const phoneTier = (t) => (t === 'PREMIUM' || t === 'LEGACY_VAULT_PREMIUM' ? 'PREMIUM' : t === 'ESSENTIAL' ? 'ESSENTIAL' : 'LITE');
const PLAN_NAMES = { LITE: 'Lite', ESSENTIAL: 'Essential', PREMIUM: 'Premium' };

async function loadPhoneLineAccounts() {
  const items = [];
  let ExclusiveStartKey;
  do {
    const r = await dynamo().send(new ScanCommand({
      TableName: process.env.DYNAMO_USERS_TABLE || 'Users',
      ProjectionExpression: 'userId, subscription_tier, verified, #st, migratedTo, stripeSubscriptionId, subscriptionStatus',
      ExpressionAttributeNames: { '#st': 'status' },
      ExclusiveStartKey,
    }));
    items.push(...(r.Items || []));
    ExclusiveStartKey = r.LastEvaluatedKey;
  } while (ExclusiveStartKey);
  // Backups left by the number-format conversion are not live accounts
  return items.filter(i => !i.migratedTo);
}

async function failedSyncCounts() {
  const app = (await pool.query(`SELECT COUNT(*) FILTER (WHERE status = 'dead')::int AS dead FROM sync_outbox`)).rows[0];
  let phoneLineDead = null;
  try {
    const { counts } = require('../utils/phoneLineQueue');
    phoneLineDead = (await counts()).byStatus.dead || 0;
  } catch (err) {
    logger.warn(`Reconcile: could not read the phone line's queue: ${err.message}`);
  }
  return { appDead: app.dead, phoneLineDead };
}

/**
 * Compare both sides. applyFixes=false only reports (used by tests / a dry run).
 * Returns the stored report row.
 */
async function runReconcile({ trigger = 'manual', runBy = null, applyFixes = true } = {}) {
  const started = new Date();
  const report = await pool.query(
    `INSERT INTO sync_reconcile_reports (trigger, run_by, started_at) VALUES ($1, $2, $3) RETURNING id`,
    [trigger, runBy, started]
  );
  const reportId = report.rows[0].id;
  try {
    const [phoneAccounts, appUsers, failed] = await Promise.all([
      loadPhoneLineAccounts(),
      pool.query(`SELECT id, full_name, email, phone, subscription_tier, source, deleted_at, stripe_subscription_id,
                         COALESCE(is_suspended, false) AS is_suspended
                  FROM users WHERE phone IS NOT NULL AND phone <> '' AND COALESCE(is_admin, false) = false`).then(r => r.rows),
      failedSyncCounts(),
    ]);

    const byKey = new Map(phoneAccounts.map(a => [phoneKey(a.userId), a]));
    const matchedKeys = new Set();
    const fixes = [];
    const issues = [];
    let matched = 0, appOnlyUs = 0;
    const who = (u) => ({ userId: u.id, name: u.full_name || null, email: u.email || null, phone: u.phone });

    for (const u of appUsers) {
      const key = phoneKey(u.phone);
      const acct = byKey.get(key);
      if (acct) { matched++; matchedKeys.add(key); }

      if (u.deleted_at) {
        if (acct && acct.verified === true && acct.status !== 'deleted') {
          fixes.push({ ...who(u), type: 'DELETED_STILL_ON', label: 'Deleted in the app but phone sign-in was still on', change: { action: 'delete' } });
        }
        continue;
      }
      if (u.is_suspended) {
        if (acct && acct.verified === true) {
          fixes.push({ ...who(u), type: 'SUSPENDED_STILL_ON', label: 'Suspended in the app but phone sign-in was still on', change: { verified: false, action: 'suspend' } });
        }
        continue;
      }
      if (!acct) {
        if (u.source === 'ivr') issues.push({ ...who(u), type: 'PHONE_ACCOUNT_MISSING', label: 'Created by phone, but no phone-line account was found for this number' });
        else if (key.length === 10) appOnlyUs++;
        continue;
      }
      const appPlan = ivrTierName(u.subscription_tier);
      const linePlan = phoneTier(acct.subscription_tier);
      if (appPlan !== linePlan) {
        // Paid through the phone line (Stripe subscription there) but the app doesn't know: the app is
        // the side that's behind, so never push its plan; a person re-syncs the app from the phone line.
        const paidOnPhoneLine = acct.stripeSubscriptionId && acct.stripeSubscriptionId !== 'unsubscribed'
          && ['active', 'trialing', 'past_due'].includes(acct.subscriptionStatus) && !u.stripe_subscription_id;
        if (paidOnPhoneLine) {
          issues.push({ ...who(u), type: 'PAID_ON_PHONE_LINE', label: `Pays through the phone line (${PLAN_NAMES[linePlan]}), but the app shows ${PLAN_NAMES[appPlan]}. Open their profile and use "Re-sync from phone line".` });
        } else {
          fixes.push({ ...who(u), type: 'PLAN_MISMATCH', label: `Plan on the phone line was ${PLAN_NAMES[linePlan]}, app says ${PLAN_NAMES[appPlan]}`, change: { subscription_tier: appPlan, action: 'reconcile_plan' } });
        }
      }
      if (acct.verified !== true) {
        issues.push({ ...who(u), type: 'PHONE_SIGNIN_OFF', label: 'Active in the app, but phone sign-in is switched off' });
      }
    }
    const phoneOnly = phoneAccounts.filter(a => !matchedKeys.has(phoneKey(a.userId))).length;

    let fixesApplied = false;
    if (fixes.length > MAX_AUTO_FIXES) {
      issues.unshift({ type: 'TOO_MANY_DIFFERENCES', label: `${fixes.length} differences found, more than the safety limit of ${MAX_AUTO_FIXES}, so nothing was changed automatically. Check the list below.` });
    } else if (applyFixes && fixes.length) {
      for (const f of fixes) await syncAccountToIvr(f.phone, f.change);
      fixesApplied = true;
    }

    const summary = {
      appCustomers: appUsers.filter(u => !u.deleted_at).length,
      phoneLineAccounts: phoneAccounts.length,
      matched, phoneOnly, appOnlyUs,
      fixes: fixes.length, fixesApplied,
      needsAttention: issues.length,
      appFailedSyncs: failed.appDead,
      phoneLineFailedSyncs: failed.phoneLineDead,
    };
    const saved = (await pool.query(
      `UPDATE sync_reconcile_reports SET finished_at = NOW(), summary = $2, fixes = $3, issues = $4 WHERE id = $1 RETURNING *`,
      [reportId, JSON.stringify(summary), JSON.stringify(fixes), JSON.stringify(issues)]
    )).rows[0];
    logger.info(`Reconcile (${trigger}): ${fixes.length} fixes${fixesApplied ? ' applied' : ''}, ${issues.length} need attention`);

    if (trigger === 'nightly' && (fixes.length || issues.length) && process.env.ADMIN_EMAIL) {
      require('../utils/emailService').sendReconcileReport(process.env.ADMIN_EMAIL, { summary, fixes, issues })
        .catch(err => logger.error(`Reconcile report email failed: ${err.message}`));
    }
    return saved;
  } catch (err) {
    await pool.query(`UPDATE sync_reconcile_reports SET finished_at = NOW(), error = $2 WHERE id = $1`, [reportId, err.message]).catch(() => {});
    logger.error(`Reconcile failed: ${err.message}`);
    throw err;
  }
}

// Once a night, after RUN_HOUR_UTC, on exactly one backend copy
async function nightlyTick() {
  if (new Date().getUTCHours() < RUN_HOUR_UTC) return;
  const client = await pool.connect();
  let locked = false;
  try {
    locked = (await client.query('SELECT pg_try_advisory_lock($1) AS ok', [LOCK_ID])).rows[0].ok;
    if (!locked) return;
    const done = await client.query(
      `SELECT 1 FROM sync_reconcile_reports WHERE trigger = 'nightly' AND started_at >= date_trunc('day', NOW() AT TIME ZONE 'UTC') LIMIT 1`
    );
    if (done.rows.length) return;
    await runReconcile({ trigger: 'nightly' });
  } catch (err) {
    logger.error(`Nightly reconcile tick failed: ${err.message}`);
  } finally {
    if (locked) await client.query('SELECT pg_advisory_unlock($1)', [LOCK_ID]).catch(() => {});
    client.release();
  }
}

const startReconciler = () => {
  setTimeout(nightlyTick, 60 * 1000);
  setInterval(nightlyTick, CHECK_EVERY_MS);
};

module.exports = { runReconcile, startReconciler, nightlyTick, phoneKey, MAX_AUTO_FIXES };
