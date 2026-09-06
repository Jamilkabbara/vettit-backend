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

/**
 * VETT — Missions table schema guard.
 *
 * ── What changed and why ───────────────────────────────────────────────
 * ALLOWED_COLUMNS used to be a hand-maintained literal. It drifted: at the
 * time this was rewritten it was missing 18 of the 118 real columns of
 * public.missions. Because sanitizeMissionPatch drops unknown keys with
 * only a logger.warn, that drift was SILENT — three columns written by
 * POST /api/missions today (price_breakdown, targeted_markets,
 * campaign_channels) were being thrown away in production with no error.
 * The same failure had already eaten `brand_name` and `category` once.
 *
 * The list is no longer hand-maintained. It is generated from
 * information_schema and committed as src/db/missionsColumns.json by
 * `node scripts/dump-missions-schema.js`. test/mission_schema_snapshot.test.js
 * FAILS in CI when the table gains a column that has not been classified,
 * so the next missing column is caught at review time instead of in prod.
 *
 * ── Two different questions, two different sets ─────────────────────────
 * These are NOT the same question and must not share a list:
 *
 *   1. "Does this column exist on the table?"  → ALLOWED_COLUMNS
 *      A schema-existence guard. Writing a column outside it produces a
 *      PostgREST 400 that 400s the whole request. This applies to EVERY
 *      writer, including the ~20 trusted server-side writers (runMission,
 *      the Stripe webhooks, payments, missionRecovery, recruitLoop) that
 *      legitimately write status, paid_at and the *_usd money columns.
 *      ALLOWED_COLUMNS is therefore the FULL snapshot — all 118 columns.
 *
 *   2. "May an end user set this column?"      → CLIENT_PATCHABLE_COLUMNS
 *      An authorization ceiling for request-driven writes. Everything the
 *      server owns — identity, lifecycle, money, AI output, counters — is
 *      in SERVER_OWNED_COLUMNS and can never be set from a request body.
 *
 * Collapsing (2) into (1) would be a money hole: a client-patchable
 * `status` or `total_price_usd` is a free mission. Collapsing (1) into (2)
 * would break every internal writer. Hence both.
 *
 * ── Deny by default ─────────────────────────────────────────────────────
 * CLIENT_PATCHABLE_COLUMNS is an explicit allowlist, not "snapshot minus
 * denylist". A column added to the table lands in NEITHER set, so it is
 * not client-patchable until someone deliberately classifies it — and the
 * snapshot test fails until they do. That direction of failure is safe
 * (a dropped write, loudly logged); the other direction is not.
 */

const logger = require('../utils/logger');
const SCHEMA_SNAPSHOT = require('./missionsColumns.json');

/**
 * Every column that exists on public.missions, generated from
 * information_schema. This is a SCHEMA-EXISTENCE guard, not a permission
 * check — see the header. Trusted server writers pass through it.
 */
const ALLOWED_COLUMNS = new Set(SCHEMA_SNAPSHOT.columns);

/**
 * Columns the SERVER owns. A value for one of these arriving in a request
 * body is either a bug or an attack; sanitizeClientMissionPatch refuses it.
 *
 * Grouped by why each is server-owned. If you are tempted to move one of
 * these to CLIENT_PATCHABLE_COLUMNS, read the group comment first.
 */
const SERVER_OWNED_COLUMNS = new Set([
  // ── Identity & ownership ──────────────────────────────────────────────
  // A patchable user_id is a mission-theft primitive.
  'id',
  'user_id',
  'created_at',

  // ── Lifecycle state machine ───────────────────────────────────────────
  // `status` is the gate every money path and the runner key off. A client
  // that can set status='paid' gets a free mission; one that can set
  // status='processing' can steal another writer's claim.
  'status',
  'paid_at',
  'started_at',
  'completed_at',
  'heartbeat_at',
  'delivery_status',
  'delivery_check_at',
  'failure_reason',
  'recruitment_status',
  'recruitment_completed_at',

  // ── Money ─────────────────────────────────────────────────────────────
  // All of these are computed by src/utils/pricingEngine.js or stamped by
  // Stripe. Every one is a direct "pay less / refund more" hole.
  // NOTE: the `pricing_*` and `concept_price_usd` columns are NOT here —
  // they describe the product the CUSTOMER is researching, not what VETT
  // bills. Read the CLIENT_PATCHABLE note on them before moving anything.
  'price_estimated',
  'base_cost_usd',
  'targeting_surcharge_usd',
  'extra_questions_cost_usd',
  'total_price_usd',
  'price_breakdown',
  'discount_usd',
  'promo_code',            // validated server-side; a direct write skips validation
  'paid_amount_cents',
  'paid_amount_estimated',
  'partial_refund_id',
  'partial_refund_amount_cents',
  'payment_method',
  'latest_payment_intent_id',
  'checkout_session_id',

  // ── Cost accounting & margin control ──────────────────────────────────
  // ai_spend_ceiling_usd is the 30%-of-price cap protecting the margin
  // floor. Client-writable, it is an unbounded AI spend authorization.
  'ai_cost_usd',
  'chat_cost_usd',
  'chat_messages_used',
  'chat_quota_limit',
  'ai_spend_usd_actual',
  'ai_spend_ceiling_usd',

  // ── Delivery counters (what we owe vs what we delivered) ──────────────
  // These decide whether the auto-refund path fires. target_qualified_count
  // is derived server-side from respondent_count at insert/re-price.
  'target_qualified_count',
  'recruited_persona_count',
  'total_simulated_count',
  'qualified_respondent_count',
  'qualification_rate',
  'delivered_respondent_count',
  'delivery_unit',

  // ── AI / pipeline output ──────────────────────────────────────────────
  // The deliverable itself. Client-writable output is fabricated research.
  'executive_summary',
  'insights',
  'analysis',
  'aggregated_by_question',
  'targeting_brief',
  'creative_analysis',
  'mission_assets',

  // ── Cross-row references & wave sequencing ────────────────────────────
  // linked_mission_ids points at other mission rows and is not ownership-
  // checked anywhere; a patchable array of uuids is an IDOR primitive.
  // wave_number / wave_config drive the paired brand-lift split the runner
  // and the wave pricing uplift both read.
  'linked_mission_ids',
  'wave_number',
  'wave_config',

  // ── Brand-lift pricing inputs (see note below) ────────────────────────
  // calculateBrandLiftMissionPrice() prices off marketCount and
  // channelCount, i.e. off these two columns. POST /api/missions computes
  // the price from them in the same request, so mission CREATION is fine —
  // but PATCH does not re-price when they change, so a client that could
  // PATCH them would change the fair price after paying. They stay denied
  // until the PATCH route adds them to its re-price trigger set alongside
  // respondentCount/questions/targeting.
  'targeted_markets',
  'campaign_channels',

  // ── Pricing-adjacent / unclassified ───────────────────────────────────
  // `media_type` is a declared parameter of calculateMissionPrice and
  // gates creative_attention validation (resolveTier says it does not pick
  // the tier *today*, which is exactly the kind of thing that changes).
  // `tier` has no reader in src/ at all — an unread column with a
  // pricing-shaped name is denied until someone can say what it is.
  'media_type',
  'tier',
]);

/**
 * Columns an authenticated owner may set on their own mission.
 *
 * This is a CEILING, not a route contract: routes/missions.js still maps
 * request fields to columns explicitly, so listing a column here does not
 * expose it by itself. It is the boundary the "route all mission writes
 * through the backend" work builds against, replacing the direct
 * supabase-js insert the UI does today.
 */
const CLIENT_PATCHABLE_COLUMNS = new Set([
  // ── Core mission definition ───────────────────────────────────────────
  // respondent_count, goal_type, questions and targeting are pricing
  // inputs, but PATCH /api/missions/:id already re-prices server-side when
  // any of them changes (and re-validates the cap and the per-goal floor),
  // so the customer never controls the resulting price.
  'title',
  'brief',
  'goal_type',
  'questions',
  'targeting',
  'target_audience',
  'respondent_count',
  'country',
  'screener_criteria',

  // ── Creative & brief attachments (the customer's own assets) ──────────
  'creative_urls',
  'brief_attachment',
  'media_url',
  'creative_metadata',
  'desired_emotions',
  'key_message',

  // ── Universal methodology inputs (Pass 29 B2) ─────────────────────────
  'brand_name',
  'category',
  'audience_description',

  // ── Pricing RESEARCH inputs (Pass 29 B4) ──────────────────────────────
  // Read this before moving any of them to SERVER_OWNED: these describe
  // the price of the CUSTOMER'S product in a Van Westendorp / Gabor-Granger
  // study. They are survey stimulus, not VETT billing. Nothing in
  // pricingEngine.js reads them.
  'pricing_product_description',
  'pricing_currency',
  'pricing_model',
  'pricing_context',
  'pricing_expected_min',
  'pricing_expected_max',
  'pricing_methodology',

  // ── Feature roadmap (Pass 29 B6) ──────────────────────────────────────
  'roadmap_features',
  'roadmap_methodology',

  // ── Customer satisfaction (Pass 29 B8) ────────────────────────────────
  'csat_touchpoint',
  'csat_custom_touchpoint',
  'csat_customer_type',
  'csat_recency_window',
  'csat_methodology',

  // ── Validate product (Pass 30 B1) ─────────────────────────────────────
  // concept_price_usd is the price point shown TO respondents, not a
  // billing column.
  'concept_description',
  'concept_media_url',
  'concept_media_type',
  'concept_price_usd',
  'concept_use_occasion',
  'validate_methodology',

  // ── Compare concepts (Pass 30 B3) ─────────────────────────────────────
  'concepts',
  'comparison_methodology',
  'rotation_strategy',

  // ── Test marketing / ads (Pass 30 B5) ─────────────────────────────────
  // Footgun: `campaign_channel` (singular, text) is this survey-setup
  // field and is patchable. `campaign_channels` (plural, jsonb) is the
  // brand-lift PRICING input and is server-owned. They are different
  // columns with near-identical names.
  'creative_media_url',
  'creative_media_type',
  'campaign_channel',
  'campaign_format',
  'campaign_objective',
  'intended_message',
  'ad_methodology',

  // ── Competitor analysis (Pass 31 B1) ──────────────────────────────────
  'competitor_brands',
  'attribute_battery',
  'competitor_methodology',

  // ── Naming & messaging (Pass 31 B3) ───────────────────────────────────
  'naming_test_type',
  'naming_candidates',
  'naming_criteria',
  'naming_methodology',
  'brand_personality',

  // ── Churn research (Pass 31 B5) ───────────────────────────────────────
  'churn_definition',
  'churn_custom_definition',
  'churn_customer_type',
  'churn_winback_possible',
  'churn_methodology',

  // ── Brand lift setup (non-pricing) ────────────────────────────────────
  // The KPI template and KPI selection do not feed
  // calculateBrandLiftMissionPrice — only market and channel counts do.
  'brand_lift_template',
  'brand_lift_kpis',
]);

/**
 * Filter a patch that came from a REQUEST BODY down to the columns an end
 * user is allowed to set.
 *
 * Unlike sanitizeMissionPatch this distinguishes the two failure modes,
 * because they mean very different things:
 *   `rejected` — key is not a column of the table at all (drift / typo)
 *   `denied`   — key IS a real column but the SERVER owns it. This is the
 *                interesting one: it is either a bug in a route mapping or
 *                someone probing for a writable `status` / `total_price_usd`.
 *
 * Callers should treat a non-empty `denied` as a 400, not a silent drop —
 * see the warn-vs-error note on sanitizeMissionPatch.
 */
function sanitizeClientMissionPatch(raw) {
  const patch = {};
  const rejected = [];
  const denied = [];
  for (const [k, v] of Object.entries(raw || {})) {
    if (CLIENT_PATCHABLE_COLUMNS.has(k)) patch[k] = v;
    else if (ALLOWED_COLUMNS.has(k)) denied.push(k);
    else rejected.push(k);
  }
  return { patch, rejected, denied };
}

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
 * Pass `strict: true` to throw instead of silently dropping unknown keys.
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
  const { caller = 'unknown', scope = null, select = false, strict = false } = opts;
  const { patch, rejected } = sanitizeMissionPatch(rawPatch);

  if (rejected.length > 0) {
    logger.warn('missions.update: dropped unknown columns', {
      caller,
      missionId,
      rejected,
    });
    // `strict: true` turns the silent drop into a hard failure. Opt-in
    // rather than the default because ~20 trusted writers share this
    // function and a throw on a background job (the Stripe webhooks,
    // missionRecovery) would convert a partial write into a lost one.
    // Recommended for request-driven routes, where the caller can turn it
    // into a 400 and the client can see the mistake. See the PR body.
    if (strict) {
      const err = new Error(
        `missions.update: unknown column(s) ${rejected.join(', ')} — not in public.missions. `
        + 'Regenerate src/db/missionsColumns.json if the schema changed.',
      );
      err.code = 'UNKNOWN_MISSION_COLUMN';
      err.rejected = rejected;
      throw err;
    }
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

/**
 * Refresh missions.heartbeat_at for a run that still owns the mission.
 *
 * THE ONE implementation. runMission had a local closure and recruitLoop
 * folds the same stamp into writeProgress; creative_attention had neither,
 * which is how a legitimate 30-frame vision run could sit silent past
 * JOB1_HEARTBEAT_STALE_MIN (45 min) and be auto-failed mid-flight by the
 * Job 1 reaper.
 *
 * Contract, matching the closure this replaces:
 *   - Scoped to status='processing'. A run that no longer owns the mission
 *     must NOT keep the row looking alive; that is the precise opposite of
 *     what the column is for.
 *   - Non-fatal in every failure mode. A missed liveness ping must never
 *     take down the work it is reporting on.
 *   - No-ops once the 42703 latch has fired, so a schema without the
 *     hand-applied migration does not 400 on every stamp.
 *
 * Deliberately a raw update rather than updateMission(): heartbeat_at is a
 * liveness ping, not a state transition, and it must not emit the
 * "SCOPED WRITE MATCHED 0 ROWS" incident log on every tick of a run that
 * legitimately lost its claim.
 */
async function stampMissionHeartbeat(supabase, missionId, caller = 'unknown') {
  if (isHeartbeatColumnMissing()) return;
  try {
    const { error } = await supabase
      .from('missions')
      .update({ heartbeat_at: new Date().toISOString() })
      .eq('id', missionId)
      .eq('status', 'processing');
    if (error && !noteHeartbeatColumnMissing(error, caller)) {
      logger.warn('heartbeat write failed (non-fatal)', {
        caller, missionId, err: error.message, code: error.code,
      });
    }
  } catch (e) {
    logger.warn('heartbeat write threw (non-fatal)', { caller, missionId, err: e?.message });
  }
}

module.exports = {
  ALLOWED_COLUMNS,
  SERVER_OWNED_COLUMNS,
  CLIENT_PATCHABLE_COLUMNS,
  SCHEMA_SNAPSHOT,
  sanitizeMissionPatch,
  sanitizeClientMissionPatch,
  updateMission,
  isHeartbeatColumnMissing,
  noteHeartbeatColumnMissing,
  stampMissionHeartbeat,
  _resetHeartbeatColumnLatch,
};
