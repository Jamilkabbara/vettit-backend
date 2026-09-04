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
const {
  updateMission,
  isHeartbeatColumnMissing,
  noteHeartbeatColumnMissing,
} = require('../db/missionSchema');
const logger = require('../utils/logger');
const os = require('os');

// ─── Config ────────────────────────────────────────────────────────────────

const JOB1_NAME = 'mission_recovery_stuck_processing';
const JOB1_INTERVAL_MS_DEFAULT = 10 * 60 * 1000; // 10 min
// Pass 46 Phase 2 — 2h → 6h. A 1000-respondent mission takes ~2.8h at
// the measured Pass 45 rate, so the 2h reaper would auto-fail EVERY
// large run. With the boot-time resume sweep (Job 3 below) a restart
// re-enters stranded missions instead of relying on this reaper, so
// 6h is a true catastrophic-hang backstop, not the primary recovery.
const JOB1_STUCK_AFTER_HOURS = 6;

// ─── Pass 49 — heartbeat staleness replaces wall-clock ────────────────────
//
// started_at measures how long a mission has EXISTED. It says nothing
// about whether the process running it is alive, which is the question
// both reapers are actually asking. missions.heartbeat_at (see
// migrations/pass-49/01_missions_heartbeat_at.sql) is written once per
// persona by the recruit loop and every 25 personas on the batch path, so
// its staleness is a direct liveness signal.
//
// THRESHOLD, MEASURED (read-only against production, 2026-09-01):
//   loop-path gap between consecutive ai_calls, n=1432:
//     p50 5.6s  p95 12.0s  p99 14.9s  MAX 21.8s      -> 15 min = 41x max
//   batch-path synthesis tail (last response_sim -> completed_at),
//     the longest stretch with no per-persona hook: max 3.66 min
//                                                    -> 15 min = 4.1x max
//   longest single LLM call of any type, all time: 122.3s (insight_synth)
//                                                    -> 15 min = 7.4x
const HEARTBEAT_STALE_MIN = Number(process.env.MISSION_HEARTBEAT_STALE_MINUTES || 15);

// WHY JOB 1 DOES NOT SHARE THAT NUMBER.
//
// Two independent reasons, both concrete:
//
// 1. Boot race. Job 3 (resume sweep) fires at T+20s and Job 1's primer
//    tick at T+30s, against the SAME rows. If both used 15 min, a mission
//    Job 3 had just resumed would still look stale to Job 1 ten seconds
//    later — the resumed run has to generate a persona before its first
//    heartbeat lands, and persona_gen measures at 7.0s mean / 25.8s p95 /
//    44.8s max. Job 1's write is the destructive one, so it must not be
//    able to win that race. The resume path is the recovery; auto-fail is
//    the last resort.
//
// 2. SDK silence. The Anthropic client is constructed with no explicit
//    timeout, so it uses the documented defaults of timeout=10 min and
//    maxRetries=2 (verified in node_modules/@anthropic-ai/sdk 0.20.9).
//    ONE logical call can therefore be legitimately silent for ~30 min.
//    A 15-minute auto-fail gate would reap a mission whose only problem
//    is a single call inside its own retry budget. 45 > 30 with margin.
//
// This is strictly less aggressive than the 6h it replaces for a run that
// IS checking in, and strictly more responsive for one that is not.
const JOB1_HEARTBEAT_STALE_MIN = Number(process.env.JOB1_HEARTBEAT_STALE_MINUTES || 45);

// Pass 48 — Job 3 must not re-enter a mission that is STILL RUNNING.
// The sweep fires 20s after boot and selects every mission in
// status='processing' with no age gate at all. On a rolling Railway
// deploy the new pod boots while a mission started seconds earlier on
// the draining pod is mid-flight, so Job 3 re-entered it with
// {resume:true} — which by design bypasses runMission's idempotency
// claim. Two full generate+simulate runs then raced, each inserting a
// complete copy of the dataset with DIFFERENT personas and answers
// (production: 3 missions, 785 duplicate rows). A genuinely stranded
// mission stays stranded, so waiting this long before resuming costs
// nothing; Job 1 does not auto-fail until 6h.
const JOB3_MIN_STRANDED_AGE_MIN = Number(process.env.JOB3_MIN_STRANDED_AGE_MINUTES || 15);

const JOB2_NAME = 'mission_recovery_orphan_pending_payment';
// Pass 46 Phase 2 — audit P0-1: with no Stripe webhook configured this
// cron was the ONLY real-payment trigger, at 30min cadence + 6h age
// gate. Now sweeps every 10 min for missions >10 min old; PI-succeeded
// rows recover immediately, while the destructive branches (reset to
// draft / legacy alert) still require the original 6h age.
const JOB2_INTERVAL_MS_DEFAULT = 10 * 60 * 1000; // 10 min
const JOB2_RECOVER_AFTER_MINUTES = 10;
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

/**
 * Pass 22 Bug 22.10d — dedup before insert.
 *
 * Job 2's "no PI tracked" branch (alert-only safety hotfix from 0204240)
 * fires every 30min for the same legacy orphan missions, so production
 * accumulated 150 rows for 6 missions (25 dupes each) over ~12h.
 *
 * Job 1 and Job 2's other branches are self-deduping because they flip
 * the mission status (processing→failed, pending_payment→paid|draft) so
 * the next tick's WHERE clause excludes them. The legacy no-PI branch
 * intentionally does not mutate the mission row, so it would re-alert
 * forever. Dedup centrally here so all three callers stay safe.
 *
 * Predicate: an unresolved alert with the same (alert_type, mission_id)
 * already exists. Once the operator marks it resolved=true after manual
 * Stripe Dashboard reconciliation, future ticks can re-alert if the
 * mission re-enters the legacy state.
 */
async function alertAdmin(alertType, missionId, payload) {
  // Skip insert if an unresolved alert with the same scope already exists.
  if (missionId) {
    const { data: existing } = await supabase
      .from('admin_alerts')
      .select('id')
      .eq('alert_type', alertType)
      .eq('mission_id', missionId)
      .eq('resolved', false)
      .limit(1)
      .maybeSingle();
    if (existing?.id) {
      logger.debug('[cron] alertAdmin dedup: existing unresolved alert', {
        alertType, missionId, existingId: existing.id,
      });
      return;
    }
  }

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

// ─── Pass 49 — shared liveness helpers ────────────────────────────────────

/**
 * Select every mission in status='processing', asking for heartbeat_at
 * unless this process has already learned the column is absent.
 *
 * migrations/pass-49/01_missions_heartbeat_at.sql is applied by hand, so
 * the app can legitimately run against a schema without the column. On
 * PostgREST 42703 we latch it, log once, and re-select the caller's
 * original projection — from which point both jobs behave exactly as they
 * did before Pass 49 (see the NULL fallbacks below).
 */
async function selectProcessingMissions(baseCols, caller) {
  const cols = isHeartbeatColumnMissing() ? baseCols : `${baseCols}, heartbeat_at`;
  const { data, error } = await supabase
    .from('missions').select(cols).eq('status', 'processing');
  if (error && noteHeartbeatColumnMissing(error, `cron:missionRecovery:${caller}`)) {
    return supabase.from('missions').select(baseCols).eq('status', 'processing');
  }
  return { data, error };
}

/** Minutes since a mission last checked in; null when it never has. */
function heartbeatAgeMin(m) {
  if (!m || !m.heartbeat_at) return null;
  const t = new Date(m.heartbeat_at).getTime();
  if (!Number.isFinite(t)) return null;
  return (Date.now() - t) / 60000;
}

/** Minutes since started_at; null when the claim never stamped it. */
function startedAgeMin(m) {
  if (!m || !m.started_at) return null;
  const t = new Date(m.started_at).getTime();
  if (!Number.isFinite(t)) return null;
  return (Date.now() - t) / 60000;
}

/**
 * JOB 1 gate — should this processing mission be auto-failed?
 *
 * With a heartbeat: stale beyond JOB1_HEARTBEAT_STALE_MIN.
 * Without one: the PRE-PASS-49 rule, unchanged — started_at older than
 * JOB1_STUCK_AFTER_HOURS. A run that has never checked in even once tells
 * us nothing about its own liveness, so it keeps the conservative window.
 * A processing row with neither stamp has no age at all and is left alone
 * rather than guessed at.
 */
function isReapable(m) {
  const hb = heartbeatAgeMin(m);
  if (hb != null) return hb > JOB1_HEARTBEAT_STALE_MIN;
  const started = startedAgeMin(m);
  if (started == null) return false;
  return started > JOB1_STUCK_AFTER_HOURS * 60;
}

function reapReason(m) {
  const hb = heartbeatAgeMin(m);
  return hb != null
    ? `Mission has not checked in for ${Math.round(hb)} min (>${JOB1_HEARTBEAT_STALE_MIN} min heartbeat threshold) — auto-failed by recovery cron`
    : `Mission stuck in 'processing' for >${JOB1_STUCK_AFTER_HOURS}h with no heartbeat ever recorded — auto-failed by recovery cron`;
}

/**
 * JOB 3 gate — is this processing mission safe to re-enter with
 * {resume:true}?
 *
 * With a heartbeat: silent beyond HEARTBEAT_STALE_MIN. This is the whole
 * point of Pass 49 for Job 3. The Pass 48 started_at gate only protected
 * the first 15 minutes of a run, so a 1000-respondent mission 20 minutes
 * into a healthy 5-hour run was already past it and every rolling Railway
 * deploy re-entered it — the exact concurrency behind the 785 duplicate
 * rows. A live run refreshes its heartbeat every persona, so it now stays
 * protected for its entire duration.
 *
 * Without a heartbeat: the PASS-48 rule, unchanged — started_at older
 * than JOB3_MIN_STRANDED_AGE_MIN, or no started_at at all.
 */
function isResumable(m) {
  const hb = heartbeatAgeMin(m);
  if (hb != null) return hb > HEARTBEAT_STALE_MIN;
  const started = startedAgeMin(m);
  // No started_at on a 'processing' row means the claim never stamped it —
  // treat as genuinely stranded.
  if (started == null) return true;
  return started > JOB3_MIN_STRANDED_AGE_MIN;
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
      // Pass 49 — the age decision moved out of SQL and into JS. Two
      // reasons: (a) the NULL-heartbeat fallback needs a different
      // threshold per job, which is awkward to express as PostgREST
      // filters and easy to get silently wrong (`heartbeat_at < X` is NULL
      // for a NULL heartbeat, and SQL treats that as not-true, so those
      // rows would vanish from the job forever); (b) status='processing'
      // is a handful of rows, so there is nothing to optimise.
      const { data: processing, error } = await selectProcessingMissions(
        'id, status, started_at, created_at, user_id, title', 'job1');
      if (error) throw error;

      const stuck = (processing || []).filter((m) => isReapable(m));

      if (stuck.length === 0) {
        logger.debug('[cron] job1 tick: 0 stuck processing missions', {
          processingCount: (processing || []).length,
        });
        return;
      }

      logger.warn('[cron] job1 tick: found stuck processing missions', {
        count: stuck.length, of: (processing || []).length,
      });

      for (const m of stuck) {
        // Pass 49 — status-scoped. The SELECT above already filters on
        // status='processing', but time passes between the read and the
        // write: on a large mission the run can finish (or an admin can
        // force-complete it) in that window, and an unconditional UPDATE
        // would stamp 'failed' + failure_reason + completed_at straight
        // over a genuine terminal state. The .eq('status','processing')
        // makes the reaper's own write lose that race instead of winning
        // it. This is the reaper side of the same invariant runMission's
        // two terminal writes now enforce.
        const { error: reapErr, matched } = await updateMission(supabase, m.id, {
          status:         'failed',
          failure_reason: reapReason(m),
          completed_at:   new Date().toISOString(),
        }, { caller: 'cron:missionRecovery:job1', scope: { status: 'processing' } });

        if (!reapErr && matched === 0) {
          // Benign in outcome — the mission resolved itself — but loud on
          // purpose: it means the reaper came within one query of
          // clobbering a live run's terminal state, and the admin alert
          // below would have been a false "stuck mission" page.
          logger.error('[cron] job1 auto-fail SKIPPED — mission left processing between select and update', {
            missionId: m.id, started_at: m.started_at,
          });
          continue;
        }

        await alertAdmin('mission_stuck_processing', m.id, {
          user_id:           m.user_id,
          title:             m.title,
          stuck_since:       m.started_at,
          last_heartbeat_at: m.heartbeat_at || null,
          stuck_after_hours: JOB1_STUCK_AFTER_HOURS,
          heartbeat_stale_min: JOB1_HEARTBEAT_STALE_MIN,
        });

        logger.warn('[cron] job1 auto-failed stuck mission', {
          missionId: m.id, started_at: m.started_at, heartbeat_at: m.heartbeat_at || null,
          basis: m.heartbeat_at ? 'heartbeat' : 'started_at (no heartbeat ever written)',
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
      // Pass 42 H2 — auto-expire pending_payment missions older
      // than 14 days. These are legacy / abandoned and were
      // spamming the cron warn log every tick. After this UPDATE
      // they fall out of the recoverable set.
      const expireCutoff = new Date(Date.now() - 14 * 24 * 3600 * 1000).toISOString();
      const { data: expired, error: expireErr } = await supabase
        .from('missions')
        .update({
          status: 'expired',
          failure_reason: 'legacy pre-payment-intent orphan (auto-expired)',
        })
        .eq('status', 'pending_payment')
        .lt('created_at', expireCutoff)
        .select('id');
      if (expireErr) {
        logger.warn('[cron] job2 auto-expire failed (non-fatal, continuing)', { err: expireErr.message });
      } else if (expired && expired.length > 0) {
        logger.info('[cron] job2 auto-expired legacy pending_payment missions', { count: expired.length });
      }

      // Pass 46 Phase 2 — sweep young rows too (>10 min) so webhook-miss
      // recovery is fast; reconcileOrphanPendingPayment age-gates the
      // destructive branches at JOB2_STUCK_AFTER_HOURS.
      const cutoff = new Date(Date.now() - JOB2_RECOVER_AFTER_MINUTES * 60 * 1000).toISOString();
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
  // Pass 46 Phase 2 — the sweep now sees rows as young as 10 min so a
  // succeeded PI recovers fast (P0-1). Destructive/noisy branches
  // (legacy alert, reset-to-draft) keep the original 6h age gate: a
  // user can legitimately sit on the Stripe checkout page for a while.
  const ageMs = Date.now() - new Date(m.created_at).getTime();
  const isOldEnoughToReset = ageMs > JOB2_STUCK_AFTER_HOURS * 3600 * 1000;

  // No PI ever recorded — legacy / pre-Bug-22.9 mission. SAFE PATH: alert,
  // do NOT auto-mutate. The Bali forensic showed these rows can have a
  // succeeded PI in Stripe (webhook miss; user paid) that we don't know
  // about because we never stored the PI id on the mission row.
  if (!m.latest_payment_intent_id) {
    if (!isOldEnoughToReset) return; // young + legacy → leave alone, no alert spam
    await alertAdmin('orphan_pending_payment_legacy_unsafe_to_auto_reset', m.id, {
      user_id:           m.user_id,
      title:             m.title,
      reason:            'no_latest_payment_intent_id (legacy orphan)',
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

  // ─── PI-to-mission binding ────────────────────────────────────────────────
  // `pi.status === 'succeeded'` alone is NOT proof that THIS mission was paid
  // for. `latest_payment_intent_id` lives on the mission row, and the RLS
  // policy on `missions` is ownership-only with no column restriction, so a
  // signed-in user can write any value they like into it. Without the checks
  // below, a user who has ever completed one real payment can take that
  // succeeded PI id, paste it onto a brand-new expensive mission, set the row
  // to 'pending_payment', and let this job flip it to paid and run it. The
  // same PI is reusable indefinitely - nothing marks one as consumed.
  //
  // Every PI this app creates carries metadata.missionId (services/stripe.js),
  // and the webhook path already keys off it (routes/webhooks.js:216,325).
  // This job simply was not using it.
  //
  // A mismatch is a SIGNAL, not noise: alert rather than silently skipping.
  const piMissionId = pi.metadata && pi.metadata.missionId;
  if (piMissionId && String(piMissionId) !== String(m.id)) {
    await alertAdmin('pi_mission_id_mismatch', m.id, {
      user_id:         m.user_id,
      payment_intent:  pi.id,
      pi_mission_id:   String(piMissionId),
      reason:          'latest_payment_intent_id points at a PI created for a DIFFERENT mission',
      action_required: 'Treat as attempted payment reuse until proven otherwise. Do not recover this row automatically.',
    });
    logger.error('[cron] job2 REFUSED: PI belongs to another mission', {
      missionId: m.id, pi: pi.id, piMissionId: String(piMissionId),
    });
    return;
  }

  // A PI with no metadata.missionId predates the metadata (or was not created
  // by us). Refuse to auto-recover on it; alert for manual reconciliation.
  if (!piMissionId) {
    if (!isOldEnoughToReset) return;
    await alertAdmin('pi_missing_mission_metadata', m.id, {
      user_id:         m.user_id,
      payment_intent:  pi.id,
      reason:          'PI carries no metadata.missionId, so it cannot be bound to this mission',
      action_required: 'Manual Stripe Dashboard reconciliation before recovering.',
    });
    logger.warn('[cron] job2 alert-only (PI has no missionId metadata)', { missionId: m.id, pi: pi.id });
    return;
  }

  if (pi.status === 'succeeded') {
    // The captured amount must actually cover what this mission costs. A bound
    // but under-paying PI is still not payment for THIS mission.
    const capturedCents = Number.isFinite(pi.amount_received) ? pi.amount_received
      : (Number.isFinite(pi.amount) ? pi.amount : null);
    const owedCents = Number.isFinite(Number(m.total_price_usd))
      ? Math.round(Number(m.total_price_usd) * 100)
      : null;
    if (owedCents != null && capturedCents != null && capturedCents < owedCents) {
      await alertAdmin('pi_amount_below_mission_price', m.id, {
        user_id:         m.user_id,
        payment_intent:  pi.id,
        captured_cents:  capturedCents,
        owed_cents:      owedCents,
        reason:          'succeeded PI is bound to this mission but captured less than the mission price',
        action_required: 'Reconcile manually. Do not recover automatically.',
      });
      logger.error('[cron] job2 REFUSED: PI captured less than mission price', {
        missionId: m.id, pi: pi.id, capturedCents, owedCents,
      });
      return;
    }

    // Webhook miss — recover.
    const piPaidAt = pi.created
      ? new Date(pi.created * 1000).toISOString()
      : new Date().toISOString();
    await updateMission(supabase, m.id, {
      status:  'paid',
      paid_at: piPaidAt,
      // P0-6 — stamp the Stripe-confirmed amount + PI id so revenue reporting
      // is confirmed, not estimated. This recovery path previously marked paid
      // WITHOUT paid_amount_cents (the main cause of the paid_at-but-null-amount
      // rows the admin Costs panel flags). amount_received is the captured cents.
      latest_payment_intent_id: pi.id,
      paid_amount_cents: Number.isFinite(pi.amount_received) ? pi.amount_received
        : (Number.isFinite(pi.amount) ? pi.amount : null),
      paid_amount_estimated: false,
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
  // Pass 46 Phase 2 — young rows with a non-succeeded PI are mid-checkout;
  // leave them for a later tick.
  if (!isOldEnoughToReset) return;
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

// ─── JOB 3 — boot-time resume sweep (Pass 46 Phase 2, audit P1-3) ─────────
//
// The recruit loop persists each qualified persona's responses
// incrementally, so a mission stranded in status='processing' by a
// process restart (Railway redeploy, crash, OOM) is RESUMABLE: re-enter
// runMission with {resume:true} and the loop reconstructs its state
// from mission_responses and continues. This runs once, shortly after
// boot — exactly when stranded missions exist. Without it, a stranded
// 1000-respondent run (~2.8h) would burn its progress and eventually be
// auto-failed by Job 1.
async function runJob3BootResume() {
  try {
    if (!(await tryAcquireLock('mission_recovery_boot_resume'))) {
      logger.debug('[cron] job3 skip: another instance holds lock');
      return;
    }
    try {
      const { data: stranded, error } = await selectProcessingMissions(
        'id, title, started_at, recruitment_status', 'job3');
      if (error) throw error;
      if (!stranded || stranded.length === 0) {
        logger.info('[cron] job3 boot resume: no stranded processing missions');
        return;
      }
      // Pass 48 age gate, upgraded in Pass 49 from wall-clock to liveness.
      // A mission whose process is still checking in is still executing
      // (possibly on the pod we are replacing); resuming it produces a
      // concurrent second run whose responses land as duplicates. Only
      // re-enter missions that have gone silent.
      const tooYoung = [];
      const resumable = stranded.filter((m) => {
        if (isResumable(m)) return true;
        tooYoung.push(m.id);
        return false;
      });
      if (tooYoung.length > 0) {
        logger.info('[cron] job3 boot resume: skipping missions that are still checking in', {
          skipped: tooYoung.length,
          ids: tooYoung,
          heartbeatStaleMin: HEARTBEAT_STALE_MIN,
          noHeartbeatFallbackMinAgeMin: JOB3_MIN_STRANDED_AGE_MIN,
        });
      }
      if (resumable.length === 0) {
        logger.info('[cron] job3 boot resume: no missions past the min-age gate');
        return;
      }
      logger.warn('[cron] job3 boot resume: re-entering stranded missions', {
        count: resumable.length, ids: resumable.map((m) => m.id),
      });
      for (const m of resumable) {
        setImmediate(() => {
          runMission(m.id, { resume: true }).catch((err) => {
            logger.error('[cron] job3 resume runMission failed', {
              missionId: m.id, err: err.message,
            });
          });
        });
      }
    } finally {
      await releaseLock('mission_recovery_boot_resume');
    }
  } catch (err) {
    logger.error('[cron] job3 crashed', { err: err.message });
  }
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

  // Pass 22 Bug 22.10c hotfix — kick off both jobs ~30s after init so the
  // first tick happens regardless of redeploy frequency. Without this,
  // every Railway redeploy resets the setInterval clock to T+0, and Job 2's
  // 30min interval means a busy deploy day (B1, B2, hotfixes) can keep
  // pushing the first tick past the redeploy window — Job 2 effectively
  // never fires.
  //
  // The advisory lock in cron_locks prevents this primer-run from racing
  // with the regular interval tick (or with another instance during a
  // rolling deploy).
  setTimeout(() => { runJob1().catch(() => {}); }, 30 * 1000);
  setTimeout(() => { runJob2().catch(() => {}); }, 45 * 1000);
  // Pass 46 Phase 2 — resume stranded processing missions ~20s after
  // boot (before Job 1 could ever see them as stuck).
  setTimeout(() => { runJob3BootResume().catch(() => {}); }, 20 * 1000);

  logger.info('[cron] missionRecovery started', {
    instance: _instanceId,
    job1IntervalMs,
    job2IntervalMs,
    job1StuckAfterHours: JOB1_STUCK_AFTER_HOURS,
    job1HeartbeatStaleMin: JOB1_HEARTBEAT_STALE_MIN,
    job3HeartbeatStaleMin: HEARTBEAT_STALE_MIN,
    job2StuckAfterHours: JOB2_STUCK_AFTER_HOURS,
    primerTickJob1Sec: 30,
    primerTickJob2Sec: 45,
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
  runJob3BootResume,
  reconcileOrphanPendingPayment,
  JOB3_MIN_STRANDED_AGE_MIN,
  JOB1_STUCK_AFTER_HOURS,
  HEARTBEAT_STALE_MIN,
  JOB1_HEARTBEAT_STALE_MIN,
  isReapable,
  isResumable,
};
