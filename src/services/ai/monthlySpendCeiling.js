/**
 * The monthly AI spend ceiling — a tripwire, not a budget.
 *
 * WHY IT EXISTS
 * -------------
 * All-time AI spend across the whole product is $36.15, and the most
 * expensive calendar month on record is $9.87. A single month reaching $50 is
 * therefore not "a busy month" - it is roughly ten times a normal one, and the
 * plausible causes are all faults: a recruit loop that will not terminate, an
 * API key leaked and being spent by someone else, or one study spiralling.
 *
 * So the number is a smoke detector. It is not a cap on how much the business
 * is allowed to earn.
 *
 * WHAT IT MEASURES, AND WHY NOT THE OTHER THING
 * ---------------------------------------------
 * `ai_calls.cost_usd`, summed over the current calendar month. Never
 * `missions.ai_cost_usd`. The mission column only sees calls that carry a
 * mission_id, and 1,931 calls worth $15.26 - 42% of all spend - carry none:
 * clarify, targeting suggestions, subject extraction, admin insights, chat.
 * A ceiling reading the mission column would sit at 58% of reality, so a
 * runaway would have to reach $86 of real spend before a $50 ceiling noticed.
 * It would be a detector wired to the wrong room.
 *
 * The read is PAGED, via fetchAllRows. PostgREST caps an unbounded SELECT at
 * 1000 rows and returns a 200 with no warning, so an unpaged sum is silently
 * short. The month this exists to catch is by definition the month with an
 * unusual number of calls in it - an unpaged ceiling is broken in exactly the
 * case it was built for. One indexed filter on `created_at` drives it
 * (idx_ai_calls_date), and only three columns come back.
 *
 * TWO LINES, AND WHAT EACH ONE DOES
 * ---------------------------------
 *   Ceiling  ($50 default, AI_MONTHLY_CEILING_USD)
 *     Raises one admin alert and pages immediately. Stops nothing. A human
 *     looks at the biggest contributor and decides.
 *
 *   Hard limit ($150 default = 3x the ceiling, AI_MONTHLY_HARD_LIMIT_USD)
 *     Refuses to START new work. Never touches work already in flight.
 *
 * The gap between them is deliberate, and it is a money decision rather than
 * an engineering one. A study already running has been paid for and has half
 * its data written; there is no re-run credit system, so killing it mid-flight
 * turns an overspend into a refund and a support ticket, and rewrites what a
 * customer bought. A study that has not started yet loses nothing by waiting:
 * it keeps its paid status and its payment, an admin alert is raised, and it
 * is re-triggered by hand - the same remedy every other refused run uses.
 *
 * FAILS OPEN
 * ----------
 * If the log cannot be read, new work proceeds and the reason is logged. A
 * tripwire that becomes an outage when a SELECT fails is worse than no
 * tripwire: it would stop paid studies over a transient database error.
 */
'use strict';

const logger = require('../../utils/logger');
const fetchAllRows = require('../../db/fetchAllRows');

/**
 * Not a credential, so a numeric default is correct here rather than
 * dangerous: the house rule against fallbacks is about config that is a SECRET
 * (a key with a default is a key that silently works wrong). A ceiling with no
 * default would be a ceiling that does not exist until someone remembers to
 * set it, which is the failure this guards against.
 */
const CEILING_DEFAULT_USD = 50;

/** The hard limit sits this many times above the ceiling unless set directly. */
const HARD_LIMIT_MULTIPLE = 3;

const ALERT_TYPE = 'ai_monthly_spend_ceiling';

/** A positive, finite dollar figure, or null. Never a silent zero. */
function positiveNumber(raw) {
  if (raw === null || raw === undefined) return null;
  const s = String(raw).trim();
  if (!s) return null;
  const n = Number(s);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n;
}

function round4(n) {
  return Math.round(n * 10000) / 10000;
}

/**
 * @param {object} [env]  defaults to process.env
 * @returns {{ceilingUsd: number, hardLimitUsd: number}}
 */
function readConfig(env = process.env) {
  const ceilingUsd = positiveNumber(env.AI_MONTHLY_CEILING_USD) ?? CEILING_DEFAULT_USD;
  const configured = positiveNumber(env.AI_MONTHLY_HARD_LIMIT_USD);
  // A hard limit at or below the ceiling would make the stop bite before (or
  // at the same moment as) the warning, collapsing the two lines into one and
  // turning the tripwire into the hard stop this design rejects. Ignore it.
  const hardLimitUsd = configured && configured > ceilingUsd
    ? configured
    : ceilingUsd * HARD_LIMIT_MULTIPLE;
  return { ceilingUsd, hardLimitUsd };
}

/** 'YYYY-MM' for the calendar month containing `ts`, in UTC. */
function monthKey(ts = Date.now()) {
  const d = new Date(ts);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

/** Midnight UTC on the first of the calendar month containing `ts`. */
function monthStartIso(ts = Date.now()) {
  const d = new Date(ts);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)).toISOString();
}

/**
 * Sum `ai_calls.cost_usd` for the current calendar month, grouped by
 * call_type so the alert can say where the money went.
 *
 * @returns {Promise<{month, monthStart, spendUsd, calls, byCallType, topContributor, error}>}
 */
async function readMonthToDateSpend({ supabase = require('../../db/supabase'), now = Date.now } = {}) {
  const ts = typeof now === 'function' ? now() : now;
  const month = monthKey(ts);
  const monthStart = monthStartIso(ts);

  // THROWN, not just returned. A failed read reaches this code two different
  // ways: PostgREST answering with an error object, and the client itself
  // raising (a transport fault, a misconfigured client, an unexpected shape).
  // Only the first is an `error` field. Both have to end up in the same place,
  // because the caller is a gate that must fail OPEN - an exception escaping
  // here would refuse every paid mission on a transient fault, which is a
  // worse outage than the overspend this module exists to catch.
  let data;
  let error;
  try {
    ({ data, error } = await fetchAllRows(supabase, {
      table: 'ai_calls',
      columns: 'id, call_type, cost_usd',
      build: (q) => q.gte('created_at', monthStart),
      label: 'monthlySpendCeiling',
    }));
  } catch (err) {
    error = { message: err?.message || 'ai_calls read threw', thrown: true };
  }

  if (error) {
    return { month, monthStart, spendUsd: 0, calls: 0, byCallType: [], topContributor: null, error };
  }

  const rows = Array.isArray(data) ? data : [];
  const totals = new Map();
  let spendUsd = 0;

  for (const row of rows) {
    const cost = Number(row.cost_usd);
    const usd = Number.isFinite(cost) ? cost : 0;
    spendUsd += usd;
    const key = row.call_type || 'unknown';
    const prev = totals.get(key) || { call_type: key, spendUsd: 0, calls: 0 };
    prev.spendUsd += usd;
    prev.calls += 1;
    totals.set(key, prev);
  }

  // Sorted by MONEY, not by call count. The noisiest call type is routinely
  // the cheapest one (subject_extract: 3 calls, $0.0007), and pointing the
  // reader at it would send them to the wrong room.
  const byCallType = [...totals.values()]
    .map((t) => ({ ...t, spendUsd: round4(t.spendUsd) }))
    .sort((a, b) => b.spendUsd - a.spendUsd);

  return {
    month,
    monthStart,
    spendUsd: round4(spendUsd),
    calls: rows.length,
    byCallType,
    topContributor: byCallType[0] || null,
    error: null,
  };
}

/**
 * Read the spend and compare it to both lines. Writes nothing.
 *
 * @returns {Promise<object>} state, or `{failed: true}` if the log is unreadable
 */
async function checkMonthlyCeiling({ supabase, now = Date.now, env = process.env } = {}) {
  const { ceilingUsd, hardLimitUsd } = readConfig(env);
  const spend = await readMonthToDateSpend({ supabase, now });

  if (spend.error) {
    return { ...spend, ceilingUsd, hardLimitUsd, breached: false, hardBreached: false, failed: true };
  }

  return {
    ...spend,
    ceilingUsd,
    hardLimitUsd,
    breached: spend.spendUsd >= ceilingUsd,
    hardBreached: spend.spendUsd >= hardLimitUsd,
  };
}

function alertPayload(state) {
  const severity = state.hardBreached ? 'hard_limit' : 'ceiling';
  const top = state.topContributor;
  return {
    severity,
    month: state.month,
    spend_usd: state.spendUsd,
    ceiling_usd: state.ceilingUsd,
    hard_limit_usd: state.hardLimitUsd,
    calls: state.calls,
    biggest_contributor: top
      ? { call_type: top.call_type, spend_usd: top.spendUsd, calls: top.calls }
      : null,
    measured_from: 'ai_calls.cost_usd, summed over the calendar month. Not missions.ai_cost_usd, '
                 + 'which misses every call with no mission_id (42% of real spend).',
    what_happens_now: severity === 'hard_limit'
      ? 'New missions are being REFUSED until this is resolved. Missions already running are '
      + 'left alone and will finish. A refused mission keeps its paid status and raises its own '
      + 'alert; nothing a customer bought has been changed or cancelled.'
      : 'Nothing has been stopped. Every mission still runs. New missions are only refused '
      + `above the hard limit of $${state.hardLimitUsd}.`,
    action_required: severity === 'hard_limit'
      ? 'Find the cause before raising the limit. If the spend is legitimate, raise '
      + 'AI_MONTHLY_HARD_LIMIT_USD and re-trigger any deferred missions. If it is not, '
      + 'rotate the AI provider key and stop the runaway first.'
      : 'Check the biggest contributor above against the missions that ran this month. '
      + 'A normal month is under $10, so this is ten times normal: look for a loop that is '
      + 'not terminating, a key being used by someone else, or one study spiralling.',
  };
}

/**
 * Raise ONE admin alert per month per severity, on the existing admin_alerts
 * channel, and page immediately.
 *
 * Immediately, not in the nightly digest, for the same reason a provider
 * refusal pages: a runaway loop keeps spending while the digest waits, and up
 * to 24 hours of silence is the entire window this is meant to close. One
 * email per month per severity is at most two a month, so it cannot become
 * noise.
 *
 * Deduplication is in the DATABASE, not in memory, so it holds across Railway
 * instances and across redeploys - an in-memory throttle resets on every
 * deploy, and a deploy is a likely response to this very alert.
 */
async function reportMonthlyCeilingBreach(state, deps = {}) {
  const supabase = deps.supabase || require('../../db/supabase');
  const payload = alertPayload(state);

  try {
    const { data: open, error: openErr } = await supabase
      .from('admin_alerts')
      .select('id')
      .eq('alert_type', ALERT_TYPE)
      .eq('resolved', false)
      .eq('payload->>month', state.month)
      .eq('payload->>severity', payload.severity)
      .limit(1);

    if (openErr) {
      // Could not establish whether we already alerted. Say nothing rather
      // than risk mailing the owner on every tick.
      logger.warn('[spend-ceiling] dedup check failed, not alerting', { err: openErr.message });
      return { raised: false, reason: 'dedup_check_failed' };
    }
    if (Array.isArray(open) && open.length) {
      return { raised: false, reason: 'already_open' };
    }

    logger.error('[spend-ceiling] monthly AI spend ceiling reached', {
      month: state.month,
      spendUsd: state.spendUsd,
      ceilingUsd: state.ceilingUsd,
      hardLimitUsd: state.hardLimitUsd,
      severity: payload.severity,
      topContributor: state.topContributor,
    });

    const { data: rows, error: insErr } = await supabase
      .from('admin_alerts')
      .insert({ alert_type: ALERT_TYPE, mission_id: null, user_id: null, payload, resolved: false })
      .select('id, alert_type, mission_id, payload, created_at');

    if (insErr) {
      logger.warn('[spend-ceiling] alert insert failed', { err: insErr.message });
    }

    // Lazily required: services/email.js builds a Resend client at module
    // load and throws without RESEND_API_KEY, which would make this module
    // unimportable in every unit test and on any deploy without mail.
    const email = deps.email || require('../email');
    const alert = (rows && rows[0]) || {
      id: 'unsaved', alert_type: ALERT_TYPE, mission_id: null, payload,
      created_at: new Date(typeof deps.now === 'function' ? deps.now() : Date.now()).toISOString(),
    };
    await email.sendAdminAlertDigest({
      to: process.env.ADMIN_ALERT_EMAIL || 'kabbarajamil@gmail.com',
      alerts: [alert],
      windowHours: 24,
    }).catch((e) => logger.warn('[spend-ceiling] alert email failed', { err: e.message }));

    return { raised: true, severity: payload.severity };
  } catch (err) {
    logger.warn('[spend-ceiling] reportMonthlyCeilingBreach failed (non-fatal)', { err: err.message });
    return { raised: false, reason: 'error' };
  }
}

/**
 * The scheduled entry point: read, compare, alert if over. Never throws.
 */
async function runMonthlyCeilingCheck(deps = {}) {
  const state = await checkMonthlyCeiling(deps);

  if (state.failed) {
    logger.warn('[spend-ceiling] month-to-date spend could not be read', {
      err: state.error?.message, month: state.month,
    });
    return { ...state, alert: { raised: false, reason: 'spend_unreadable' } };
  }

  if (!state.breached) {
    logger.debug('[spend-ceiling] under the ceiling', {
      month: state.month, spendUsd: state.spendUsd, ceilingUsd: state.ceilingUsd,
    });
    return { ...state, alert: { raised: false, reason: 'under_ceiling' } };
  }

  const alert = await reportMonthlyCeilingBreach(state, deps);
  return { ...state, alert };
}

/**
 * May a NEW piece of AI work begin?
 *
 * Call this where work STARTS, never inside a running pipeline - a check that
 * fires mid-run is the hard stop this design rejects.
 *
 * @param {boolean} [opts.resume]  true for a run already in flight: always allowed
 * @returns {Promise<{allowed: boolean, reason: string, state?: object}>}
 */
async function spendAllowsNewWork({ supabase, now = Date.now, env = process.env, resume = false } = {}) {
  // An in-flight run is not new work. It is a paid study with data already
  // written, and no spend figure justifies killing it.
  if (resume === true) return { allowed: true, reason: 'in_flight_run' };

  // Belt and braces around the whole gate, not only the read. Nothing in this
  // function is allowed to throw into a caller that is about to run a paid
  // study: if the tripwire cannot answer, the answer is yes.
  let state;
  try {
    state = await checkMonthlyCeiling({ supabase, now, env });
  } catch (err) {
    logger.warn('[spend-ceiling] gate failing OPEN: check threw', { err: err?.message });
    return { allowed: true, reason: 'spend_unreadable' };
  }

  if (state.failed) {
    logger.warn('[spend-ceiling] gate failing OPEN: spend not readable', { err: state.error?.message });
    return { allowed: true, reason: 'spend_unreadable', state };
  }
  if (state.hardBreached) {
    return { allowed: false, reason: 'over_hard_limit', state };
  }
  if (state.breached) {
    // Over the tripwire, under the stop. The alert has already been raised by
    // the scheduled check; this run goes ahead.
    return { allowed: true, reason: 'over_ceiling_under_hard_limit', state };
  }
  return { allowed: true, reason: 'under_ceiling', state };
}

module.exports = {
  readConfig,
  monthKey,
  monthStartIso,
  readMonthToDateSpend,
  checkMonthlyCeiling,
  reportMonthlyCeilingBreach,
  runMonthlyCeilingCheck,
  spendAllowsNewWork,
  alertPayload,
  CEILING_DEFAULT_USD,
  HARD_LIMIT_MULTIPLE,
  ALERT_TYPE,
};
