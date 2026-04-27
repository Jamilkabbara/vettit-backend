/**
 * Pass 22 Bug 22.10 — Mission status recovery cron.
 *
 * Two watchdog jobs that run on intervals from the same Express process:
 *
 *   JOB 1 — runMission stuck in 'processing' >2h
 *     The synthetic-audience pipeline normally finishes in seconds-minutes.
 *     A row stuck in 'processing' for hours means runMission() crashed
 *     between status='processing' (its claim guard) and status='completed'.
 *     The user is left staring at a spinner; their mission row stays paid
 *     but unviewable. Flip to 'failed' with a recovery reason so the
 *     /results page surfaces the failure (Pass 21 Bug 19 wired
 *     failure_reason into the API surface).
 *
 *   JOB 2 — pending_payment >6h with stale Stripe PI
 *     Bug 22.23 forensic showed missions stranded in pending_payment when:
 *       (a) The user paid via a fresh PI but the webhook never fired (stripe
 *           outage / our /webhooks/stripe path failed before Bug 22.8).
 *       (b) The user abandoned the checkout flow.
 *     For each, query Stripe for the PI status:
 *       * succeeded  → "webhook miss": flip mission to 'paid', trigger
 *                      runMission(), insert admin_alert.
 *       * anything else → flip mission to 'draft', clear
 *                      latest_payment_intent_id (user can retry cleanly with
 *                      fresh quote).
 *
 * Distributed-instance safety:
 *   Each tick acquires a row-lock in public.cron_locks (Bug 22.12 schema).
 *   If another Railway instance already holds the lock, the tick skips. A
 *   lock older than 15min is auto-stolen (crash-recovery path).
 *
 * In-memory self-overlap guard:
 *   If a tick takes longer than its interval, the next tick refuses to
 *   start until the previous one finishes. Avoids parallel runs against
 *   the same DB rows on a single instance.
 *
 * SIGTERM handling:
 *   shutdown() clears intervals so Railway's redeploy doesn't leak
 *   intervals into orphaned old pods.
 *
 * Single-instance assumption:
 *   Railway is currently single-instance. cron_locks is the safety net for
 *   any future horizontal scale. If the app moves to >1 instance, no code
 *   change is needed; cron_locks already handles it.
 */

const supabase = require('../db/supabase');
const stripeService = require('../services/stripe');
const { runMission } = require('./runMission');
const { updateMission } = require('../db/missionSchema');
const logger = require('../utils/logger');
const os = require('os');

// ─── Config ────────────────────────────────────────────────────────────────

const JOB1_NAME = 'mission_recovery_stuck_processing';
const JOB1_INTERVAL_MS_DEFAULT = 10 * 60 * 1000; // 10 min
const JOB1_STUCK_AFTER_HOURS = 2;

const JOB2_NAME = 'mission_recovery_orphan_pending_payment';
const JOB2_INTERVAL_MS_DEFAULT = 30 * 60 * 1000; // 30 min
const JOB2_STUCK_AFTER_HOURS = 6;

const LOCK_STALE_MINUTES = 15;

// ─── State ─────────────────────────────────────────────────────────────────

let _job1Timer = null;
let _job2Timer = null;
let _job1InFlight = false;
let _job2InFlight = false;
const _instanceId = `${os.hostname() || 'unknown'}:${process.pid}`;

// ─── Distributed lock helpers ─────────────────────────────────────────────

/**
 * Try to acquire the cron_locks row for `jobName`. Returns true if this
 * instance now holds the lock. Steals locks older than LOCK_STALE_MINUTES
 * (crash recovery for instances that died mid-job).
 */
async function tryAcquireLock(jobName) {
  // INSERT-then-conflict-update with a stale-window WHERE clause.
  // Postgres atomically checks the WHERE on the conflicting row; if our
  // condition doesn't match (lock is fresh), the UPDATE is a no-op and
  // RETURNING returns the existing acquired_by — not us, so we lose.
  const stalePivot = new Date(Date.now() - LOCK_STALE_MINUTES * 60 * 1000).toISOString();

  // Note: supabase-js's .upsert() with onConflict supports this, but we want
  // the conditional WHERE. Using raw RPC isn't worth a wrapper for one query.
  // Fallback: insert; on duplicate, update if stale.
  const { error: insertErr } = await supabase
    .from('cron_locks')
    .insert({ job_name: jobName, acquired_by: _instanceId });

  if (!insertErr) {
    // Got it — fresh insert.
    return true;
  }
  if (insertErr.code !== '23505') {
    logger.warn('[cron] tryAcquireLock insert failed (non-fatal)', {
      jobName, err: insertErr.message,
    });
    return false;
  }

  // Conflict — try to steal if stale.
  const { data: stolen, error: updateErr } = await supabase
    .from('cron_locks')
    .update({ acquired_at: new Date().toISOString(), acquired_by: _instanceId })
    .eq('job_name', jobName)
    .lt('acquired_at', stalePivot)
    .select('acquired_by');

  if (updateErr) {
    logger.warn('[cron] tryAcquireLock steal-update failed (non-fatal)', {
      jobName, err: updateErr.message,
    });
    return false;
  }
  return Array.isArray(stolen) && stolen.length > 0;
}

async function releaseLock(jobName) {
  await supabase
    .from('cron_locks')
    .delete()
    .eq('job_name', jobName)
    .eq('acquired_by', _instanceId)
    .then(() => {}, (err) => {
      logger.warn('[cron] releaseLock failed (non-fatal)', {
        jobName, err: err?.message,
      });
    });
}

// ─── Admin alert helper ───────────────────────────────────────────────────

async function alertAdmin(alertType, missionId, payload) {
  const { error } = await supabase.from('admin_alerts').insert({
    alert_type: alertType,
    mission_id: missionId,
    user_id:    payload?.user_id || null,
    payload:    payload || {},
    resolved:   false,
  });
  if (error) {
    logger.warn('[cron] alertAdmin insert failed (non-fatal)', {
      alertType, missionId, err: error.message,
    });
  }
}

// ─── JOB 1 — stuck processing missions ────────────────────────────────────

async function runJob1() {
  if (_job1InFlight) {
    logger.debug('[cron] job1 skip: previous tick still in flight');
    return;
  }
  _job1InFlight = true;

  try {
    if (!(await tryAcquireLock(JOB1_NAME))) {
      logger.debug('[cron] job1 skip: another instance holds lock');
      return;
    }

    try {
      const cutoff = new Date(Date.now() - JOB1_STUCK_AFTER_HOURS * 3600 * 1000).toISOString();
      const { data: stuck, error } = await supabase
        .from('missions')
        .select('id, status, started_at, created_at, user_id, title')
        .eq('status', 'processing')
        .lt('started_at', cutoff);
      if (error) throw error;

      if (!stuck || stuck.length === 0) {
        logger.debug('[cron] job1 tick: 0 stuck processing missions');
        return;
      }

      logger.warn('[cron] job1 tick: found stuck processing missions', { count: stuck.length });

      for (const m of stuck) {
        await updateMission(supabase, m.id, {
          status:         'failed',
          failure_reason: `Mission stuck in 'processing' for >${JOB1_STUCK_AFTER_HOURS}h — auto-failed by recovery cron`,
          completed_at:   new Date().toISOString(),
        }, { caller: 'cron:missionRecovery:job1' });

        await alertAdmin('mission_stuck_processing', m.id, {
          user_id:           m.user_id,
          title:             m.title,
          stuck_since:       m.started_at,
          stuck_after_hours: JOB1_STUCK_AFTER_HOURS,
        });

        logger.warn('[cron] job1 auto-failed stuck mission', {
          missionId: m.id, started_at: m.started_at,
        });
      }
    } finally {
      await releaseLock(JOB1_NAME);
    }
  } catch (err) {
    logger.error('[cron] job1 crashed', { err: err.message, stack: err.stack });
  } finally {
    _job1InFlight = false;
  }
}

// ─── JOB 2 — orphan pending_payment missions ──────────────────────────────

async function runJob2() {
  if (_job2InFlight) {
    logger.debug('[cron] job2 skip: previous tick still in flight');
    return;
  }
  _job2InFlight = true;

  try {
    if (!(await tryAcquireLock(JOB2_NAME))) {
      logger.debug('[cron] job2 skip: another instance holds lock');
      return;
    }

    try {
      const cutoff = new Date(Date.now() - JOB2_STUCK_AFTER_HOURS * 3600 * 1000).toISOString();
      const { data: stuck, error } = await supabase
        .from('missions')
        .select('id, status, latest_payment_intent_id, user_id, total_price_usd, title, created_at')
        .eq('status', 'pending_payment')
        .lt('created_at', cutoff);
      if (error) throw error;

      if (!stuck || stuck.length === 0) {
        logger.debug('[cron] job2 tick: 0 orphan pending_payment missions');
        return;
      }

      logger.warn('[cron] job2 tick: found orphan pending_payment missions', { count: stuck.length });

      for (const m of stuck) {
        await reconcileOrphanPendingPayment(m);
      }
    } finally {
      await releaseLock(JOB2_NAME);
    }
  } catch (err) {
    logger.error('[cron] job2 crashed', { err: err.message, stack: err.stack });
  } finally {
    _job2InFlight = false;
  }
}

/**
 * Per-mission reconciliation. Branches based on whether we have a PI on the
 * row (Bug 22.9) and the Stripe PI state:
 *
 *   no PI on row (pre-Bug-22.9 historical orphans)
 *              → ALERT ONLY. Cannot safely auto-reset — Stripe forensic
 *                showed pre-Bug-22.9 rows can have a succeeded PI in Stripe
 *                (webhook miss) that's not tracked on the mission row.
 *                Auto-flipping to draft would silently lose paid missions.
 *                Operator must reconcile manually via Stripe Dashboard.
 *
 *   PI succeeded → webhook miss; recover the mission (mark paid, run pipeline)
 *
 *   PI in any non-succeeded state (canceled / failed / requires_* / processing
 *                                  >6h old)
 *              → flip to draft, clear latest_payment_intent_id (user retries
 *                clean with a fresh quote)
 */
async function reconcileOrphanPendingPayment(m) {
  // No PI ever recorded — legacy / pre-Bug-22.9 mission. SAFE PATH: alert,
  // do NOT auto-mutate. The Bali forensic showed these rows can have a
  // succeeded PI in Stripe (webhook miss; user paid) that we don't know
  // about because we never stored the PI id on the mission row.
  if (!m.latest_payment_intent_id) {
    await alertAdmin('orphan_pending_payment_legacy_unsafe_to_auto_reset', m.id, {
      user_id:           m.user_id,
      title:             m.title,
      reason:            'no_latest_payment_intent_id (predates Pass 22 Bug 22.9)',
      stuck_since:       m.created_at,
      stuck_after_hours: JOB2_STUCK_AFTER_HOURS,
      action_required:   'Manual Stripe Dashboard reconciliation: search PIs by metadata.missionId; if any succeeded, recover the row; otherwise admin can flip to draft.',
    });
    logger.warn('[cron] job2 alert-only (legacy, no PI tracked)', { missionId: m.id });
    return;
  }

  // Query Stripe for the PI's current state.
  const pi = await stripeService.retrievePaymentIntent(m.latest_payment_intent_id);
  if (!pi) {
    logger.warn('[cron] job2 Stripe PI retrieve failed; skipping for this tick', {
      missionId: m.id, pi: m.latest_payment_intent_id,
    });
    return;
  }

  if (pi.status === 'succeeded') {
    // Webhook miss — recover.
    const piPaidAt = pi.created
      ? new Date(pi.created * 1000).toISOString()
      : new Date().toISOString();
    await updateMission(supabase, m.id, {
      status:  'paid',
      paid_at: piPaidAt,
    }, { caller: 'cron:missionRecovery:job2:webhook_miss_recovered' });

    setImmediate(() => {
      runMission(m.id).catch((err) => {
        logger.error('[cron] runMission failed after webhook-miss recovery', {
          missionId: m.id, err: err.message,
        });
      });
    });

    await alertAdmin('webhook_miss_recovered', m.id, {
      user_id:           m.user_id,
      title:             m.title,
      pi_id:             pi.id,
      pi_amount_cents:   pi.amount,
      pi_created:        piPaidAt,
      total_price_usd:   m.total_price_usd,
    });
    logger.warn('[cron] job2 RECOVERED webhook miss', { missionId: m.id, pi: pi.id });
    return;
  }

  // resumable states — leave alone if young; reset if old.
  // Bug 22.9 assessPIResumability uses age <24h. If we're running this cron
  // for a >6h-old mission with a still-resumable PI, that's a long-abandoned
  // checkout. Reset so the user can retry cleanly with a fresh quote.
  // (succeeded/canceled/anything else also lands here = reset.)
  await updateMission(supabase, m.id, {
    status:                   'draft',
    latest_payment_intent_id: null,
  }, { caller: 'cron:missionRecovery:job2:stuck_pending_reset' });

  await alertAdmin('orphan_pending_payment_reset', m.id, {
    user_id:           m.user_id,
    title:             m.title,
    reason:            `pi_status:${pi.status}`,
    pi_id:             pi.id,
    stuck_since:       m.created_at,
    stuck_after_hours: JOB2_STUCK_AFTER_HOURS,
  });
  logger.warn('[cron] job2 reset stuck pending', {
    missionId: m.id, pi: pi.id, pi_status: pi.status,
  });
}

// ─── init / shutdown ──────────────────────────────────────────────────────

/**
 * Start both interval loops. Idempotent — calling twice resets timers.
 */
function init(opts = {}) {
  const { job1IntervalMs = JOB1_INTERVAL_MS_DEFAULT,
          job2IntervalMs = JOB2_INTERVAL_MS_DEFAULT } = opts;

  shutdown(); // clear any prior timers

  // Skip in test environments — the cron is a side-effect-laden background
  // process that has no place in unit tests.
  if (process.env.NODE_ENV === 'test') {
    logger.info('[cron] missionRecovery skipped (NODE_ENV=test)');
    return;
  }

  _job1Timer = setInterval(() => { runJob1().catch(() => {}); }, job1IntervalMs);
  _job2Timer = setInterval(() => { runJob2().catch(() => {}); }, job2IntervalMs);

  logger.info('[cron] missionRecovery started', {
    instance: _instanceId,
    job1IntervalMs,
    job2IntervalMs,
    job1StuckAfterHours: JOB1_STUCK_AFTER_HOURS,
    job2StuckAfterHours: JOB2_STUCK_AFTER_HOURS,
  });
}

function shutdown() {
  if (_job1Timer) {
    clearInterval(_job1Timer);
    _job1Timer = null;
  }
  if (_job2Timer) {
    clearInterval(_job2Timer);
    _job2Timer = null;
  }
}

module.exports = {
  init,
  shutdown,
  // exported for tests / one-off admin tooling
  runJob1,
  runJob2,
  reconcileOrphanPendingPayment,
};
