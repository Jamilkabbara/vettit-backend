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
 * { user_id: req.user.id } — to scope the update to the row's owner.
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
    return { data: null, error: null, rejected };
  }

  let query = supabase.from('missions').update(patch).eq('id', missionId);
  if (scope) {
    for (const [k, v] of Object.entries(scope)) query = query.eq(k, v);
  }
  if (select) query = query.select().single();

  const { data, error } = await query;
  if (error) {
    logger.error('missions.update: postgres error', {
      caller,
      missionId,
      error: { code: error.code, message: error.message, details: error.details },
      patchKeys: Object.keys(patch),
    });
  }
  return { data, error, rejected };
}

module.exports = { ALLOWED_COLUMNS, sanitizeMissionPatch, updateMission };
