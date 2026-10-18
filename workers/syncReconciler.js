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
//   - recordings (voice notes / wills), matched by the recording itself: ones the app lost the slot of,
//     extra copies on the phone line, ones missing on either side. A Super admin fixes them with
//     "Fix recordings" (POST /api/super-admin/sync/reconcile/:id/copy-content), which re-reads both sides first.
// Runs once a night after RUN_HOUR_UTC (a database lock stops two backend copies running it), and on
// demand from Super admin → Sync monitor. More than MAX_AUTO_FIXES differences = nothing is changed
// automatically, in case something upstream is wrong.
const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, ScanCommand } = require('@aws-sdk/lib-dynamodb');
const { pool } = require('../config/database');
const logger = require('../utils/logger');
const { syncAccountToIvr } = require('../utils/syncIvr');
const { ivrTierName } = require('../utils/tierMapping');
const { limitsFor } = require('../utils/planLimits');

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
      ProjectionExpression: 'userId, subscription_tier, verified, #st, migratedTo, stripeSubscriptionId, subscriptionStatus, #sl, voiceWillSlots',
      ExpressionAttributeNames: { '#st': 'status', '#sl': 'slots' },
      ExclusiveStartKey,
    }));
    items.push(...(r.Items || []));
    ExclusiveStartKey = r.LastEvaluatedKey;
  } while (ExclusiveStartKey);
  // Backups left by the number-format conversion are not live accounts
  return items.filter(i => !i.migratedTo);
}

const countText = (n, word) => (n ? `${n} ${word}${n > 1 ? 's' : ''}` : '');

// The recording a slot or an app item points at, without the link's signature: the last part of the
// path ("…/stream-s3-recording/voice-notes/<id>/1773918077125-0f90.mp3?exp=…" -> "1773918077125-0f90.mp3");
// Twilio recording ids ("RE…") stay as they are. Same key on both sides = same recording.
const recordingKey = (v) => { const s = String(v || '').split('?')[0].replace(/\/+$/, ''); return s ? s.split('/').pop() : ''; };

/**
 * One side (keypad slots or will slots) for one customer. Recordings are matched by the recording itself
 * first, so an app note whose slot link was lost is recognised instead of copied again.
 *   relink:     app items already on the phone line in another slot -> the app adopts that slot
 *   duplicates: phone slots repeating a recording that's already in another slot (extra copies)
 *   missing:    app items whose recording isn't on the phone line (get a free slot when copied)
 *   inAppMissing: phone slots the app has no recording for
 */
function planSide(phoneList, slotField, appItems, appSlotOf, maxSlots) {
  const phone = (phoneList || []).map(s => ({ slot: Number(s[slotField]), key: recordingKey(s.voiceMessage), created: String(s.createdAt || '') })).filter(s => s.slot);
  // Same recording in several slots: the OLDEST slot is the original and stays (ties: lowest number)
  const slotsByKey = new Map();
  for (const p of [...phone].sort((a, b) => (a.created && b.created ? a.created.localeCompare(b.created) : 0) || a.slot - b.slot)) {
    if (p.key) (slotsByKey.get(p.key) || slotsByKey.set(p.key, []).get(p.key)).push(p.slot);
  }

  const keep = new Map(); // recording key -> the slot that stays
  const linkedSlots = new Set();
  const relink = [], missing = [];
  for (const a of appItems) {
    const slots = a.key ? slotsByKey.get(a.key) : null;
    if (slots && slots.length) {
      const target = keep.get(a.key) || slots[0];
      keep.set(a.key, target);
      linkedSlots.add(target);
      if (a.appSlot !== target) relink.push({ id: a.id, title: a.title, from: a.appSlot || null, to: target });
    } else if (a.appSlot && phone.some(p => p.slot === a.appSlot && !p.key)) {
      linkedSlots.add(a.appSlot); // old slot without a recording address: trust the slot number
    } else {
      missing.push(a);
    }
  }
  for (const [key, slots] of slotsByKey) if (!keep.has(key)) keep.set(key, slots[0]);
  const duplicates = phone.filter(p => p.key && keep.get(p.key) !== p.slot).map(p => ({ slot: p.slot, sameAs: keep.get(p.key) }));
  const linkedKeys = new Set(appItems.filter(a => a.key && slotsByKey.has(a.key)).map(a => a.key));
  const inAppMissing = phone.filter(p => !duplicates.some(d => d.slot === p.slot) && !linkedSlots.has(p.slot) && !(p.key && linkedKeys.has(p.key))).map(p => p.slot).sort((a, b) => a - b);

  // Slots a copied item may use: free on the phone line (duplicates count as taken until they're removed).
  // The phone line's limit counts recordings, not slot numbers, so a slot number used twice uses two.
  const taken = new Set(phone.map(p => p.slot));
  const room = Math.max(0, maxSlots - phone.length);
  const free = []; for (let s = 1; s <= maxSlots && free.length < room; s++) if (!taken.has(s)) free.push(s);
  const counts = phone.reduce((m, p) => m.set(p.slot, (m.get(p.slot) || 0) + 1), new Map());
  return {
    relink,
    duplicates: duplicates.sort((a, b) => a.slot - b.slot),
    missing: missing.slice(0, free.length).map((a, i) => ({ id: a.id, title: a.title, slot: free[i] })),
    noRoom: Math.max(0, missing.length - free.length),
    // Missing items that won't fit but claim a slot the phone line uses for another recording: the app
    // drops that claim (the item stays in the app, over the plan's keypad limit)
    unplaced: missing.slice(free.length).filter(a => a.appSlot && (taken.has(a.appSlot) || relink.some(r => r.to === a.appSlot))).map(a => a.id),
    inAppMissing,
    repeatedSlots: [...counts].filter(([, n]) => n > 1).map(([s]) => s).sort((a, b) => a - b),
  };
}

async function loadAppContent(ids) {
  const [notes, wills] = await Promise.all([
    pool.query(
      `SELECT id, user_id, title, ivr_slot_number, slot_number, s3_key, twilio_recording_sid FROM voice_notes
       WHERE user_id = ANY($1) AND deleted_at IS NULL AND COALESCE(is_will, false) = false ORDER BY created_at`, [ids]).then(r => r.rows),
    pool.query(
      `SELECT id, user_id, title, will_slot_number, s3_key, twilio_recording_sid FROM voice_wills
       WHERE user_id = ANY($1) AND deleted_at IS NULL AND admin_removed_at IS NULL ORDER BY created_at`, [ids]).then(r => r.rows),
  ]);
  const group = (rows) => rows.reduce((m, r) => (m.get(r.user_id) || m.set(r.user_id, []).get(r.user_id)).push(r) && m, new Map());
  return { notesBy: group(notes), willsBy: group(wills) };
}

// For each linked, active customer: what matches, what to relink, extra copies, and what's missing where
async function compareContent(pairs) {
  if (!pairs.length) return [];
  const { notesBy, willsBy } = await loadAppContent(pairs.map(p => p.u.id));
  return pairs.map(({ u, acct }) => {
    const plan = limitsFor(u.subscription_tier);
    const notes = (notesBy.get(u.id) || []).map(n => ({ id: n.id, title: n.title, appSlot: n.ivr_slot_number || n.slot_number || null, key: recordingKey(n.twilio_recording_sid || n.s3_key) }));
    const wills = (willsBy.get(u.id) || []).map(w => ({ id: w.id, title: w.title, appSlot: w.will_slot_number || null, key: recordingKey(w.twilio_recording_sid || w.s3_key) }));
    return {
      u, acct,
      notes: planSide(acct.slots, 'slotNumber', notes, null, plan.slots),
      wills: plan.wills ? planSide(acct.voiceWillSlots, 'willSlotNumber', wills, null, plan.wills) : planSide([], 'willSlotNumber', [], null, 0),
    };
  });
}

/**
 * The "Fix recordings" button: re-reads both sides NOW (never an old report) for these customers and
 *   1. relinks app items that are already on the phone line,
 *   2. removes extra copies from the phone line (a slot repeating another slot's recording),
 *   3. copies what's missing into slots that are free on the phone line.
 * Nothing in the app is deleted. Returns what was done per customer.
 */
async function fixContent(userIds) {
  const phoneLineContent = require('../utils/phoneLineContent');
  const users = (await pool.query(
    `SELECT id, full_name, email, phone, subscription_tier FROM users WHERE id = ANY($1) AND deleted_at IS NULL AND phone IS NOT NULL`,
    [userIds]
  )).rows;
  const byKey = new Map((await loadPhoneLineAccounts()).map(a => [phoneKey(a.userId), a]));
  const pairs = users.map(u => ({ u, acct: byKey.get(phoneKey(u.phone)) })).filter(p => p.acct);
  const plans = await compareContent(pairs);
  const results = [];
  for (const p of plans) {
    const r = { userId: p.u.id, name: p.u.full_name || p.u.email, relinked: 0, duplicatesRemoved: 0, notes: 0, wills: 0 };
    for (const id of p.notes.unplaced) await pool.query('UPDATE voice_notes SET ivr_slot_number = NULL WHERE id = $1', [id]);
    for (const id of p.wills.unplaced) await pool.query('UPDATE voice_wills SET will_slot_number = NULL WHERE id = $1', [id]);
    for (const x of p.notes.relink) { await pool.query('UPDATE voice_notes SET ivr_slot_number = $1 WHERE id = $2', [x.to, x.id]); r.relinked++; }
    for (const x of p.wills.relink) { await pool.query('UPDATE voice_wills SET will_slot_number = $1 WHERE id = $2', [x.to, x.id]); r.relinked++; }
    for (const d of p.notes.duplicates) { await phoneLineContent.removeNote(p.u.phone, d.slot); r.duplicatesRemoved++; }
    for (const d of p.wills.duplicates) { await phoneLineContent.removeWill(p.u.phone, d.slot); r.duplicatesRemoved++; }
    for (const m of p.notes.missing) {
      const note = (await pool.query('UPDATE voice_notes SET ivr_slot_number = $1 WHERE id = $2 RETURNING *', [m.slot, m.id])).rows[0];
      await phoneLineContent.sendNote(p.u.phone, note); r.notes++;
    }
    for (const m of p.wills.missing) {
      const will = (await pool.query('UPDATE voice_wills SET will_slot_number = $1 WHERE id = $2 RETURNING *', [m.slot, m.id])).rows[0];
      await phoneLineContent.sendWill(p.u.phone, will); r.wills++;
    }
    results.push(r);
  }
  return results;
}

async function followPhoneLineSchedules(apply) {
  const appMsgs = (await pool.query(
    `SELECT sm.id, sm.metadata->>'ivrScheduleId' AS sid, sm.scheduled_for, u.id AS user_id, u.full_name, u.email, u.phone
     FROM scheduled_messages sm JOIN users u ON u.id = sm.user_id
     WHERE sm.metadata->>'source' = 'ivr' AND sm.metadata->>'ivrScheduleId' IS NOT NULL AND sm.delivery_status = 'scheduled'`
  )).rows;
  if (!appMsgs.length) return [];
  const phone = new Map();
  let ExclusiveStartKey;
  do {
    const r = await dynamo().send(new ScanCommand({
      TableName: process.env.DYNAMO_SCHEDULES_TABLE || 'SCHEDULES',
      ProjectionExpression: 'scheduleId, #st',
      ExpressionAttributeNames: { '#st': 'status' },
      ExclusiveStartKey,
    }));
    for (const i of r.Items || []) phone.set(i.scheduleId, i.status);
    ExclusiveStartKey = r.LastEvaluatedKey;
  } while (ExclusiveStartKey);
  // Nothing read from the phone line (empty table, wrong name, no access): compare nothing rather than
  // treat every phone-scheduled message as cancelled
  if (phone.size === 0) return [];

  const out = [];
  for (const m of appMsgs) {
    const st = phone.get(m.sid);
    const to = st === 'COMPLETED' ? 'delivered' : st === 'FAILED' ? 'failed' : st === undefined ? 'cancelled' : null;
    if (!to) continue; // PENDING / PROCESSING: still on its way
    out.push({ userId: m.user_id, name: m.full_name || null, email: m.email || null, phone: m.phone, type: 'SCHEDULE_FOLLOWED_PHONE_LINE',
      label: `Phone-scheduled message for ${new Date(m.scheduled_for).toISOString().slice(0, 16).replace('T', ' ')} UTC was ${to} on the phone line; the app now shows that` });
    if (apply) {
      await pool.query(
        `UPDATE scheduled_messages SET delivery_status = $2::text, updated_at = NOW(),
                delivered_at = CASE WHEN $2::text = 'delivered' THEN COALESCE(delivered_at, NOW()) ELSE delivered_at END,
                failed_at = CASE WHEN $2::text = 'failed' THEN COALESCE(failed_at, NOW()) ELSE failed_at END,
                cancelled_at = CASE WHEN $2::text = 'cancelled' THEN COALESCE(cancelled_at, NOW()) ELSE cancelled_at END
         WHERE id = $1 AND delivery_status = 'scheduled'`,
        [m.id, to]
      );
    }
  }
  return out;
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
    const contentToCompare = [];
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
      contentToCompare.push({ u, acct });
    }
    const phoneOnly = phoneAccounts.filter(a => !matchedKeys.has(phoneKey(a.userId))).length;

    // Recordings and wills: what each side has, by keypad slot / will slot. Never changed automatically:
    // a Super admin reviews the list and presses "Copy to the phone line".
    const content = await compareContent(contentToCompare);
    const both = (n, w, nw, ww) => [countText(n, nw), countText(w, ww)].filter(Boolean).join(' and ');
    const slotList = (word, slots) => `${word} slot${slots.length > 1 ? 's' : ''} ${slots.join(', ')}`;
    for (const c of content) {
      const u = c.u, N = c.notes, W = c.wills;
      if (N.relink.length || W.relink.length) {
        issues.push({
          ...who(u), type: 'CONTENT_RELINK', fixable: true,
          label: `${both(N.relink.length, W.relink.length, 'voice note', 'voice will')} already on the phone line, but the app lost which slot: the app will be relinked (nothing is copied)`,
          items: { notes: N.relink, wills: W.relink },
        });
      }
      if (N.duplicates.length || W.duplicates.length) {
        issues.push({
          ...who(u), type: 'PHONE_DUPLICATE_SLOTS', fixable: true,
          label: `Extra copies on the phone line: ${[
            ...N.duplicates.map(d => `keypad ${d.slot} repeats keypad ${d.sameAs}`),
            ...W.duplicates.map(d => `will slot ${d.slot} repeats will slot ${d.sameAs}`),
          ].join('; ')}. The extra copies will be removed.`,
          items: { notes: N.duplicates, wills: W.duplicates },
        });
      }
      if (N.missing.length || W.missing.length) {
        issues.push({
          ...who(u), type: 'CONTENT_MISSING_ON_PHONE_LINE', fixable: true,
          label: `${both(N.missing.length, W.missing.length, 'voice note', 'voice will')} in the app but not on their phone line${N.noRoom || W.noRoom ? ` (${N.noRoom + W.noRoom} more won't fit: no free slots)` : ''}`,
          items: { notes: N.missing, wills: W.missing },
        });
      }
      if (N.repeatedSlots.length || W.repeatedSlots.length) {
        issues.push({
          ...who(u), type: 'PHONE_SLOT_NUMBER_REPEATED',
          label: `On the phone line, ${[
            ...N.repeatedSlots.map(s => `keypad ${s}`), ...W.repeatedSlots.map(s => `will slot ${s}`),
          ].join(', ')} holds more than one recording. Decide which to keep before copying anything to this customer.`,
          items: { notes: N.repeatedSlots, wills: W.repeatedSlots },
        });
      }
      if (N.inAppMissing.length || W.inAppMissing.length) {
        issues.push({
          ...who(u), type: 'CONTENT_MISSING_IN_APP',
          label: `On the phone line but not in the app: ${[
            N.inAppMissing.length ? slotList('keypad', N.inAppMissing) : '',
            W.inAppMissing.length ? slotList('will', W.inAppMissing) : '',
          ].filter(Boolean).join('; ')}`,
          items: { notes: N.inAppMissing, wills: W.inAppMissing },
        });
      }
    }

    let fixesApplied = false;
    if (fixes.length > MAX_AUTO_FIXES) {
      issues.unshift({ type: 'TOO_MANY_DIFFERENCES', label: `${fixes.length} differences found, more than the safety limit of ${MAX_AUTO_FIXES}, so nothing was changed automatically. Check the list below.` });
    } else if (applyFixes && fixes.length) {
      for (const f of fixes) await syncAccountToIvr(f.phone, f.change);
      fixesApplied = true;
    }

    // Messages scheduled BY PHONE are sent by the phone line, so its SCHEDULES record decides their state.
    // A delivery result or cancellation that never reached the app is applied here (app only).
    try {
      const preview = await followPhoneLineSchedules(false);
      if (preview.length > MAX_AUTO_FIXES) {
        issues.unshift({ type: 'TOO_MANY_DIFFERENCES', label: `${preview.length} phone-scheduled messages differ from the phone line, more than the safety limit of ${MAX_AUTO_FIXES}, so none were changed.` });
      } else if (preview.length) {
        const scheduleFixes = applyFixes ? await followPhoneLineSchedules(true) : preview;
        for (const s of scheduleFixes) fixes.push(s);
      }
    } catch (err) {
      logger.warn(`Reconcile: could not compare scheduled messages: ${err.message}`);
    }

    const summary = {
      appCustomers: appUsers.filter(u => !u.deleted_at).length,
      phoneLineAccounts: phoneAccounts.length,
      matched, phoneOnly, appOnlyUs,
      fixes: fixes.length, fixesApplied,
      needsAttention: issues.length,
      contentMissingOnPhoneLine: issues.filter(i => i.type === 'CONTENT_MISSING_ON_PHONE_LINE').length,
      contentMissingInApp: issues.filter(i => i.type === 'CONTENT_MISSING_IN_APP').length,
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

module.exports = { runReconcile, startReconciler, nightlyTick, phoneKey, MAX_AUTO_FIXES, fixContent, recordingKey, planSide };
