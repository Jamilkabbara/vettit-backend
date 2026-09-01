/**
 * VETT — Missions table schema guard.
 *
 * The actual public.missions columns (queried live from Postgres on
 * 2026-04-21) are enumerated below. Any write to a column outside this
 * set produces a PostgREST 400 and silently breaks the request path.
 *
 * Historical drift — code has been writing these phantom columns that
 * do NOT exist in the schema:
 *   - mission_statement  (use `brief`)
 *   - targeting_config   (use `targeting`)
 *   - stripe_payment_intent_id  (Stripe is the source of truth; drop)
 *   - price              (use `total_price_usd`)
 *   - pricing_breakdown  (derivable from base_cost_usd + surcharges)
 *   - payment_status     (collapse to `status`)
 *   - updated_at         (column was never added)
 *
 * This module filters patches to the allowed set, logs any rejected
 * keys so new drift is caught immediately instead of silently 400-ing,
 * and wraps the UPDATE with error logging.
 */

const logger = require('../utils/logger');

// Live schema (information_schema.columns query — source of truth)
const ALLOWED_COLUMNS = new Set([
  'id',
  'user_id',
  'title',
  'status',
  'country',
  'target_audience',
  'price_estimated',
  'created_at',
  'goal_type',
  'brief',
  'respondent_count',
  'targeting',
  'questions',
  'base_cost_usd',
  'targeting_surcharge_usd',
  'extra_questions_cost_usd',
  'total_price_usd',
  'promo_code',
  'discount_usd',
  'paid_at',
  'started_at',
  'completed_at',
  'executive_summary',
  'insights',
  'ai_cost_usd',
  'chat_cost_usd',
  'chat_messages_used',
  'chat_quota_limit',
  'creative_urls',
  'mission_assets',
  // Pass 21 Bug 5: persist qualification aggregates so dashboards/reports
  // never need to recompute from mission_responses on every read.
  'total_simulated_count',
  'qualified_respondent_count',
  'qualification_rate',
  // Pass 21 Bug 19: top-level failure reason populated by runMission's
  // fatal handler. Replaces fishing the message out of mission_assets.
  'failure_reason',
  // Pass 22 Bug 22.23: track the most recent Stripe PI for this mission so
  // /api/payments/create-intent can resume an in-flight PI instead of creating
  // a new one on every retry. See migrations/pass-22/03_bug_22_9_*.sql.
  'latest_payment_intent_id',
  // Pass 22 Bug 22.24: user-editable screener acceptance criteria. Set on
  // mission setup before launch; runMission reads it when generating the
  // screener prompt.
  'screener_criteria',
  // Pass 23 Bug 23.0e v2: active Stripe Checkout Session id for this mission.
  // Set on POST /api/payments/create-checkout-session; cleared on
  // checkout.session.expired webhook. Parallel to latest_payment_intent_id
  // (Stripe Checkout still creates a PaymentIntent under the hood).
  'checkout_session_id',
  // A3 — payment method type (e.g. "card") from the succeeded PaymentIntent,
  // stamped by the Stripe webhook so the dashboard shows how a mission was paid.
  'payment_method',
  // Pass 23 Bug 23.25 — delivery integrity columns. Stamped by runMission's
  // over-recruit loop or the partial-delivery branch. delivery_status is the
  // canonical {full|partial} flag; the rest are forensic + idempotency for
  // the auto-refund path.
  'delivery_status',
  'delivery_check_at',
  'paid_amount_cents',
  // Pass 29 A1 — flag for backfilled paid_amount_cents (TRUE means
  // estimated from total_price_usd, FALSE means captured directly
  // from Stripe payment_intent.succeeded).
  'paid_amount_estimated',
  'partial_refund_id',
  'partial_refund_amount_cents',
  // Pass 29 B2 — universal mission inputs. Required on every
  // methodology-bound mission type (everything except `research`).
  // Brand Lift and Creative Attention already capture equivalents
  // through their deep pickers but writing here is harmless.
  'brand_name',
  'category',
  'audience_description',
  // Pass 29 B4 — pricing research (Van Westendorp + Gabor-Granger).
  'pricing_product_description',
  'pricing_currency',
  'pricing_model',
  'pricing_context',
  'pricing_expected_min',
  'pricing_expected_max',
  'pricing_methodology',
  // Pass 29 B6 — feature roadmap (MaxDiff + Kano).
  'roadmap_features',
  'roadmap_methodology',
  // Pass 29 B8 — customer satisfaction (NPS + CSAT + CES).
  'csat_touchpoint',
  'csat_custom_touchpoint',
  'csat_customer_type',
  'csat_recency_window',
  'csat_methodology',
  // Pass 30 B1 — validate product (concept test).
  'concept_description',
  'concept_media_url',
  'concept_media_type',
  'concept_price_usd',
  'concept_use_occasion',
  'validate_methodology',
  // Pass 30 B3 — compare concepts (sequential monadic).
  'concepts',
  'comparison_methodology',
  'rotation_strategy',
  // Pass 30 B5 — test marketing / ads (ad effectiveness).
  'creative_media_url',
  'creative_media_type',
  'campaign_channel',
  'campaign_format',
  'campaign_objective',
  'intended_message',
  'ad_methodology',
  // Pass 31 B1 — competitor analysis (brand health tracker).
  // competitor_brands JSONB already exists from Pass 28.
  'attribute_battery',
  'competitor_methodology',
  // Pass 31 B3 — naming & messaging (monadic + paired + TURF).
  'naming_test_type',
  'naming_candidates',
  'naming_criteria',
  'naming_methodology',
  'brand_personality',
  // Pass 31 B5 — churn research (driver tree + win-back).
  'churn_definition',
  'churn_custom_definition',
  'churn_customer_type',
  'churn_winback_possible',
  'churn_methodology',
  // Pass 32 X1 — delivered_respondent_count records actual delivered
  // count (may differ from contract for Brand Lift paired splits etc).
  'delivered_respondent_count',
  // Pass 32 X2 — delivery_unit ∈ {respondent, creative_asset}.
  'delivery_unit',
  // Pass 42 A1 — recruit-until-qualified semantics.
  // target_qualified_count is the customer-paid count (recruit loop
  // runs until reached); recruited_persona_count is the running
  // total of personas generated (pass + fail); ai_spend_usd_actual
  // is the accumulated AI cost; ai_spend_ceiling_usd is the hard
  // 30%-of-mission-price cap protecting the 70% margin floor;
  // recruitment_status ∈ {pending|recruiting|ceiling_hit|target_hit};
  // recruitment_completed_at is the loop-exit timestamp.
  'target_qualified_count',
  'recruited_persona_count',
  'ai_spend_usd_actual',
  'ai_spend_ceiling_usd',
  'recruitment_status',
  'recruitment_completed_at',
  // Pass 45 T1 — per-question aggregation map consumed by the 9
  // methodology result renderers (CSAT/Naming/Pricing/etc.).
  'aggregated_by_question',
  // Pass 46 Phase 3 — deterministic methodology analysis object.
  'analysis',
  // Pass 49 — liveness stamp for the reapers. MUST be listed here:
  // sanitizeMissionPatch silently drops anything outside this set with
  // only a logger.warn, which has already broken two columns after they
  // shipped (`brand_name`, `category`). See
  // migrations/pass-49/01_missions_heartbeat_at.sql.
  'heartbeat_at',
]);

/**
 * Strip any keys that aren't in the actual missions table schema.
 * Returns `{ patch, rejected }` — rejected is logged by the caller's
 * context so we can see which route is writing phantom columns.
 */
function sanitizeMissionPatch(raw) {
  const patch = {};
  const rejected = [];
  for (const [k, v] of Object.entries(raw || {})) {
    if (ALLOWED_COLUMNS.has(k)) {
      patch[k] = v;
    } else {
      rejected.push(k);
    }
  }
  return { patch, rejected };
}

/**
 * Wrapper around supabase.from('missions').update() that:
 *   1. Filters the patch to known columns
 *   2. Logs any rejected keys with caller context
 *   3. Logs the PostgREST error body on failure (was previously silent)
 *
 * Usage:
 *   await updateMission(supabase, missionId, patch, { caller: 'routes/missions PATCH', userId: req.user.id });
 *
 * Caller can pass additional `.eq()` filters via `scope` — e.g.
 * { user_id: req.user.id } — to scope the update to the row's owner, or
 * { status: 'processing' } to make a terminal write conditional on the
 * mission still being in the state the writer believes it owns.
 *
 * Pass 49 — RETURN CONTRACT for scoped writes.
 * `matched` is the number of rows the UPDATE actually hit:
 *   null  — unknown (an error occurred, or nothing was requested back)
 *   0     — the row exists but did NOT satisfy `scope`; ANOTHER WRITER
 *           already moved it. The caller MUST treat this as a lost race
 *           and suppress any side effect that assumes it won.
 *   >0    — this writer won.
 *
 * The row count is only observable when `.select()` is chained, so a
 * scoped write implies it. Note `.single()` is deliberately NOT used:
 * PostgREST raises PGRST116 ("JSON object requested, multiple (or no)
 * rows returned") on a 0-row result, which would turn the exact signal
 * we need into an error. This mirrors the atomic paid→processing claim
 * in src/jobs/runMission.js, which has always used bare `.select('id')`
 * plus a `length === 0` test for the same reason.
 *
 * Consequence: `select: true` now resolves `data` to an ARRAY rather
 * than a single object. No caller in this repo passed `select: true`
 * when this changed (grep across src/, test/ and scripts/ was clean),
 * so no existing call site is affected.
 */
async function updateMission(supabase, missionId, rawPatch, opts = {}) {
  const { caller = 'unknown', scope = null, select = false } = opts;
  const { patch, rejected } = sanitizeMissionPatch(rawPatch);

  if (rejected.length > 0) {
    logger.warn('missions.update: dropped unknown columns', {
      caller,
      missionId,
      rejected,
    });
  }

  if (Object.keys(patch).length === 0) {
    logger.warn('missions.update: nothing to update after sanitize', { caller, missionId });
    return { data: null, error: null, rejected, matched: null };
  }

  let query = supabase.from('missions').update(patch).eq('id', missionId);
  const scopeKeys = scope ? Object.keys(scope) : [];
  if (scopeKeys.length > 0) {
    for (const [k, v] of Object.entries(scope)) query = query.eq(k, v);
  }
  // A scoped write is worthless without knowing whether it matched, so it
  // always asks for the affected rows back. `select: true` keeps working
  // for callers that just want the updated row.
  const wantRows = select || scopeKeys.length > 0;
  if (wantRows) query = query.select();

  const { data, error } = await query;
  if (error) {
    logger.error('missions.update: postgres error', {
      caller,
      missionId,
      error: { code: error.code, message: error.message, details: error.details },
      patchKeys: Object.keys(patch),
    });
  }

  let matched = null;
  if (!error && wantRows) {
    if (Array.isArray(data)) matched = data.length;
    else if (data) matched = 1;
    else matched = 0;
  }

  if (matched === 0) {
    logger.error('missions.update: SCOPED WRITE MATCHED 0 ROWS — another writer owns this mission', {
      caller,
      missionId,
      scope,
      patchKeys: Object.keys(patch),
    });
  }

  return { data, error, rejected, matched };
}

// ─── Pass 49 — heartbeat_at availability latch ─────────────────────────────
//
// migrations/pass-49/01_missions_heartbeat_at.sql is applied by hand, so
// the application can legitimately be running against a schema that does
// not have the column yet. Rather than let that 400 every progress write
// and every reaper query, the readers and writers detect PostgREST 42703
// once, latch it, and fall back to pre-Pass-49 behaviour.
//
// The latch is per-process and deliberately one-way: it never re-probes.
// Applying the migration therefore requires an app restart (or the next
// Railway deploy) to take effect — stated in the migration header too.
let _heartbeatColumnMissing = false;

/** True once a 42703 on heartbeat_at has been observed in this process. */
function isHeartbeatColumnMissing() {
  return _heartbeatColumnMissing;
}

/**
 * Inspect a PostgREST error. If it is "column heartbeat_at does not
 * exist", latch it (logging once, loudly) and return true so the caller
 * can retry without the column.
 */
function noteHeartbeatColumnMissing(error, caller) {
  if (!error) return false;
  const code = error.code || '';
  const msg  = `${error.message || ''} ${error.details || ''}`;
  const isMissing = (code === '42703' || code === 'PGRST204') && /heartbeat_at/.test(msg);
  if (!isMissing) return false;
  if (!_heartbeatColumnMissing) {
    _heartbeatColumnMissing = true;
    logger.error('missions.heartbeat_at is MISSING — apply migrations/pass-49/01_missions_heartbeat_at.sql, then restart. Falling back to pre-Pass-49 started_at behaviour until then.', {
      caller, code, message: error.message,
    });
  }
  return true;
}

/** Test-only: clear the latch between cases. */
function _resetHeartbeatColumnLatch() {
  _heartbeatColumnMissing = false;
}

module.exports = {
  ALLOWED_COLUMNS,
  sanitizeMissionPatch,
  updateMission,
  isHeartbeatColumnMissing,
  noteHeartbeatColumnMissing,
  _resetHeartbeatColumnLatch,
};
