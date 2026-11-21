// Automatic voice will release worker. Every minute: sends the warnings that are due, then releases
// wills whose date has come and that nobody postponed. Rules and switch: utils/willRelease.js.
// With WILL_AUTO_RELEASE unset or 'off' (the default) it does nothing at all.

const { pool } = require('../config/database');
const logger = require('../utils/logger');
const wr = require('../utils/willRelease');

let running = false;

// Each warning stage needs (a) the date to be close enough and (b) a full "day" since the previous
// warning, so a late or compressed cycle never skips a warning. Release needs all three warnings and a
// day since the last one: a will can be released late, never early.
const STAGE_DAYS_BEFORE = { 1: 3, 2: 2, 3: 1 };
const GAP_TOLERANCE = 0.9; // a "day" between warnings may be 10% short, so call-hour rounding doesn't push it a day

function nextAction(will, now) {
  const day = wr.dayMs(will.will_test_account);
  const release = new Date(will.release_date).getTime();
  const sinceLast = will.last_warning_at ? now - new Date(will.last_warning_at).getTime() : Infinity;
  const stage = will.warning_stage || 0;
  if (stage < 3) {
    const next = stage + 1;
    const due = now >= release - STAGE_DAYS_BEFORE[next] * day && sinceLast >= GAP_TOLERANCE * day;
    return due ? { type: 'warn', stage: next } : null;
  }
  return now >= release && sinceLast >= GAP_TOLERANCE * day ? { type: 'release' } : null;
}

async function dueWills(now) {
  // A will is looked at once its first warning could be due (3 test-days or 3 days before release).
  const testOnly = wr.mode() === 'test';
  const r = await pool.query(
    `SELECT vw.*, u.full_name AS owner_name, u.email AS owner_email, u.phone AS owner_phone, u.will_test_account
     FROM voice_wills vw JOIN users u ON u.id = vw.user_id
     WHERE vw.release_flow = 'auto' AND vw.release_state = 'scheduled' AND vw.deleted_at IS NULL
       AND vw.admin_removed_at IS NULL AND COALESCE(vw.is_released, false) = false AND u.deleted_at IS NULL
       AND vw.release_date <= $1::timestamp + CASE WHEN u.will_test_account THEN $2 * interval '1 millisecond' ELSE interval '3 days' END
       AND ($3::boolean = false OR u.will_test_account)
     ORDER BY vw.release_date LIMIT 50`,
    [new Date(now), wr.dayMs(true) * 3, testOnly]
  );
  return r.rows;
}

async function warn(will, stage) {
  // Claim the stage first so two servers can't send the same warning twice
  const claimed = await pool.query(
    `UPDATE voice_wills SET warning_stage = $2, last_warning_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
     WHERE id = $1 AND warning_stage = $3 AND release_state = 'scheduled' AND release_date = $4 RETURNING id`,
    [will.id, stage, will.warning_stage || 0, will.release_date]
  );
  if (!claimed.rowCount) return;
  const sent = await wr.sendWarning({ ...will, warning_stage: stage }, stage);
  await wr.logEvent(null, will.id, 'warning_sent', 'system', 'worker', { newDate: will.release_date, details: sent });
  logger.info(`Will ${will.id}: warning ${stage} sent ${JSON.stringify(sent)}`);
}

async function release(will) {
  const claimed = await pool.query(
    `UPDATE voice_wills SET release_state = 'releasing', release_attempts = release_attempts + 1, updated_at = CURRENT_TIMESTAMP
     WHERE id = $1 AND release_state = 'scheduled' AND release_date = $2 AND COALESCE(is_released, false) = false RETURNING release_attempts`,
    [will.id, will.release_date]
  );
  if (!claimed.rowCount) return;
  const attempts = claimed.rows[0].release_attempts;
  try {
    const { willAudioUrl, buildRecipients } = require('../routes/adminWills');
    const result = await wr.deliverWill(will, { willAudioUrl, buildRecipients });
    if (!result.delivered) throw new Error(result.recipients ? 'No call, text or email could be delivered' : 'This will has no reachable recipients');
    await pool.query(
      `UPDATE voice_wills SET release_state = 'released', is_released = true, released_at = CURRENT_TIMESTAMP,
              release_notes = 'Released automatically on its release date', release_error = NULL, updated_at = CURRENT_TIMESTAMP
       WHERE id = $1`, [will.id]);
    await wr.logEvent(null, will.id, 'released', 'system', 'worker', { newDate: will.release_date, details: result });
    logger.warn(`Will ${will.id} released automatically: ${result.delivered}/${result.recipients} recipients reached`);
  } catch (err) {
    // Retry on later ticks; after MAX attempts it waits for an admin (shown as failed)
    const failed = attempts >= wr.MAX_RELEASE_ATTEMPTS;
    await pool.query(
      `UPDATE voice_wills SET release_state = $2, release_error = $3, updated_at = CURRENT_TIMESTAMP WHERE id = $1`,
      [will.id, failed ? 'failed' : 'scheduled', String(err.message).slice(0, 500)]);
    await wr.logEvent(null, will.id, 'release_failed', 'system', 'worker', { details: { attempt: attempts, error: err.message, givingUp: failed } });
    logger.error(`Will ${will.id} release attempt ${attempts} failed: ${err.message}`);
  }
}

async function processWillReleases() {
  if (!wr.isEnabled() || running) return;
  running = true;
  try {
    const now = Date.now();
    for (const will of await dueWills(now)) {
      const action = nextAction(will, now);
      if (!action) continue;
      // Real customers are only called in daytime, their time. Test accounts any time.
      if (!will.will_test_account && !wr.withinCallHours(will, new Date(now))) continue;
      try {
        if (action.type === 'warn') await warn(will, action.stage);
        else await release(will);
      } catch (err) {
        logger.error(`Will ${will.id} ${action.type} failed: ${err.message}`);
      }
    }
  } catch (err) {
    logger.error(`Will release worker tick failed: ${err.message}`);
  } finally {
    running = false;
  }
}

const startWillReleaseWorker = () => {
  logger.info(`Will release worker loaded (mode: ${wr.mode()})`);
  setInterval(processWillReleases, 60 * 1000);
};

module.exports = { startWillReleaseWorker, processWillReleases, nextAction };
