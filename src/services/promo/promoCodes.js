/**
 * Promo codes: one place that decides whether a code may be used, and one
 * place that spends a use.
 *
 * THE DEFECT THIS REPLACES
 * `max_uses` was a number nobody enforced. Six routes each re-implemented the
 * same read-side check by hand, and exactly one place ever incremented
 * `uses_count`:
 *
 *     supabase.from('promo_codes')
 *       .update({ uses_count: (promo.uses_count || 0) + 1 })
 *       .eq('code', promo.code)
 *       .then(() => {}).catch(() => {});
 *
 * That is a read-modify-write with the read in the application, no await, and
 * no error path. Two checkouts that land in the same second both read
 * uses_count = 24 against max_uses = 25, both write 25, and both take "the
 * last use". It is also fire-and-forget, so a failed write looked exactly like
 * a successful one. VETTPROOF showed this in production.
 *
 * THE SHAPE OF THE FIX
 * The database arbitrates, not the application. A use is spent by a single
 * conditional statement that increments only while there is room:
 *
 *     UPDATE promo_codes
 *        SET uses_count = uses_count + 1
 *      WHERE code = $1
 *        AND uses_count = $2                 -- the value we read
 *        AND (max_uses IS NULL OR uses_count < max_uses)
 *     RETURNING ...
 *
 * Postgres evaluates that WHERE under a row lock, so of two concurrent claims
 * on the last use exactly one updates a row and the other updates none. No row
 * returned means no claim: the caller is refused rather than quietly allowed.
 *
 * TWO CLAIM PATHS, ONE CONTRACT
 *   1. public.claim_promo_code(code, mission_id) - preferred. Does the same
 *      conditional UPDATE inside the database AND reserves a row in
 *      public.promo_redemptions first, so redeeming twice for the same mission
 *      (a retried checkout, a webhook racing the success-page poll) spends one
 *      use, not two. Ships in migrations/pass-53 and is NOT applied yet.
 *   2. The conditional UPDATE issued from here over PostgREST - the fallback
 *      while that migration is unapplied. Just as atomic against max_uses; it
 *      simply has no per-mission ledger, so it cannot recognise a retry on its
 *      own.
 *
 * Which one a caller may use is a property of the caller, not of this module:
 *   - /payments/free-launch can use either, because the mission's own status
 *     guard already turns a retry into an early "already_running" return.
 *     recordFreeLaunchRedemption().
 *   - The paid confirmation paths (Stripe webhook, success-page poll, the
 *     webhook-miss cron) have no such guard between them and can confirm the
 *     same mission at the same time, so they require the ledger and do nothing
 *     at all without it. recordPaidRedemption(). Before the migration is
 *     applied that leaves paid redemptions uncounted, exactly as today; after
 *     it, they count once each. It never blocks a customer who has paid.
 *
 * `max_uses` NULL (or 0) stays unlimited, everywhere, unchanged.
 */

const logger = require('../../utils/logger');

// How many times a contended claim re-reads and retries before giving up. A
// claim only loses when a concurrent claim won, so each retry starts from a
// count that is one higher; a code with room runs out of contention fast, and
// a code without room reports exhausted on the next read instead.
const MAX_CLAIM_ATTEMPTS = 4;

// Postgres / PostgREST codes that mean "pass-53 is not applied on this
// database": undefined_function, undefined_table, and PostgREST's schema-cache
// equivalents. Anything else is a real error and is treated as one.
const NOT_DEPLOYED_CODES = new Set(['42883', '42P01', 'PGRST202', 'PGRST205']);

function normaliseCode(code) {
  if (code === null || code === undefined) return null;
  const trimmed = String(code).trim().toUpperCase();
  return trimmed || null;
}

/**
 * The ceiling, or null for unlimited. NULL, 0 and anything non-numeric all
 * mean unlimited - that is the behaviour the routes already had
 * (`promo.max_uses && promo.uses_count >= promo.max_uses` is false for all
 * three) and it is deliberately preserved.
 */
function promoLimit(row) {
  const max = Number(row?.max_uses);
  if (!Number.isFinite(max) || max <= 0) return null;
  return max;
}

function usesCount(row) {
  const used = Number(row?.uses_count);
  return Number.isFinite(used) ? used : 0;
}

function isExpired(row) {
  return !!(row?.expires_at && new Date(row.expires_at) < new Date());
}

function isExhausted(row) {
  const limit = promoLimit(row);
  if (limit === null) return false;
  return usesCount(row) >= limit;
}

/**
 * Why this row may not be used, or null when it may.
 */
function promoUnusableReason(row) {
  if (!row) return 'not_found';
  if (row.active === false) return 'inactive';
  if (isExpired(row)) return 'expired';
  if (isExhausted(row)) return 'exhausted';
  return null;
}

function isPromoUsable(row) {
  return promoUnusableReason(row) === null;
}

/**
 * Read a code and hand it back only if it may be used right now. Every pricing
 * and quoting surface goes through this, so "active, unexpired, not
 * exhausted" is decided once.
 *
 * Returns null for anything unusable - callers price without a promo, which is
 * what they already did.
 */
async function resolveUsablePromo(supabase, code) {
  const normalised = normaliseCode(code);
  if (!normalised) return null;
  const { data } = await supabase
    .from('promo_codes')
    .select('*')
    .eq('code', normalised)
    .eq('active', true)
    .single();
  return isPromoUsable(data) ? data : null;
}

/**
 * The pass-53 database function. Returns null when it is not deployed, so the
 * caller can decide whether to fall back or to stand down.
 */
async function claimViaDatabaseFunction(supabase, { code, missionId, source }) {
  if (typeof supabase.rpc !== 'function') return null;
  let result;
  try {
    result = await supabase.rpc('claim_promo_code', {
      p_code:       code,
      p_mission_id: missionId,
      p_source:     source || null,
    });
  } catch (err) {
    // A client without .rpc wired up (test doubles) is the same situation as a
    // database without the function: unavailable, not broken.
    return null;
  }
  const { data, error } = result || {};
  if (error) {
    if (NOT_DEPLOYED_CODES.has(error.code)) return null;
    logger.error('promo claim: claim_promo_code failed', {
      code, missionId, err: error.message, pgCode: error.code,
    });
    return { claimed: false, reason: 'error', via: 'rpc' };
  }
  const payload = Array.isArray(data) ? data[0] : data;
  if (!payload || typeof payload.claimed !== 'boolean') {
    logger.error('promo claim: claim_promo_code returned an unusable payload', { code, missionId });
    return { claimed: false, reason: 'error', via: 'rpc' };
  }
  return {
    claimed:      payload.claimed,
    reason:       payload.reason || (payload.claimed ? 'claimed' : 'refused'),
    usesCount:    payload.uses_count ?? null,
    maxUses:      payload.max_uses ?? null,
    via:          'rpc',
  };
}

/**
 * The conditional UPDATE, issued from here. One statement; Postgres decides.
 * Atomic against max_uses, but with no ledger it cannot tell a retry from a
 * second redemption, which is why only callers that are already guarded
 * against retries are allowed to use it.
 */
async function claimViaConditionalUpdate(supabase, { code }) {
  for (let attempt = 0; attempt < MAX_CLAIM_ATTEMPTS; attempt += 1) {
    const { data: row } = await supabase
      .from('promo_codes')
      .select('*')
      .eq('code', code)
      .eq('active', true)
      .single();

    const unusable = promoUnusableReason(row);
    if (unusable) return { claimed: false, reason: unusable, via: 'update' };

    const observed = row.uses_count;
    const limit    = promoLimit(row);

    let query = supabase
      .from('promo_codes')
      .update({ uses_count: usesCount(row) + 1 })
      .eq('code', row.code);

    // Compare-and-set on the count we read. This is what makes two concurrent
    // claims resolve to one winner: the loser's WHERE no longer matches.
    query = (observed === null || observed === undefined)
      ? query.is('uses_count', null)
      : query.eq('uses_count', observed);

    // And the ceiling itself, so the statement can never step over max_uses
    // even if the row moved between the read and the write.
    if (limit !== null) query = query.lt('uses_count', limit);

    const { data, error } = await query.select('code, uses_count, max_uses');

    if (error) {
      logger.error('promo claim: conditional update failed', {
        code, err: error.message, pgCode: error.code,
      });
      return { claimed: false, reason: 'error', via: 'update' };
    }

    const updated = Array.isArray(data) ? data : (data ? [data] : []);
    if (updated.length > 0) {
      return {
        claimed:   true,
        reason:    'claimed',
        usesCount: updated[0].uses_count ?? null,
        maxUses:   updated[0].max_uses ?? null,
        via:       'update',
      };
    }
    // Nothing updated: someone else moved the row. Re-read and try again; if
    // they took the last use, the next read reports exhausted.
  }
  return { claimed: false, reason: 'contended', via: 'update' };
}

/**
 * Spend one use of `code` for `missionId`.
 *
 * @param {object}  supabase
 * @param {object}  opts
 * @param {string}  opts.code        the promo code
 * @param {string}  opts.missionId   the mission the use is spent on
 * @param {string} [opts.source]     free text recorded on the ledger row
 * @param {boolean} [opts.requireLedger=false]
 *        true  - only the pass-53 function may claim; if it is not deployed,
 *                nothing is spent and the caller is told so.
 *        false - fall back to the conditional UPDATE when it is not deployed.
 * @returns {Promise<{claimed:boolean, reason:string, via:string}>}
 */
async function claimPromoUse(supabase, { code, missionId, source, requireLedger = false }) {
  const normalised = normaliseCode(code);
  if (!normalised) return { claimed: false, reason: 'not_found', via: 'none' };

  const viaFunction = await claimViaDatabaseFunction(supabase, {
    code: normalised, missionId, source,
  });
  if (viaFunction) return viaFunction;

  if (requireLedger) {
    return { claimed: false, reason: 'ledger_unavailable', via: 'none' };
  }
  return claimViaConditionalUpdate(supabase, { code: normalised });
}

/**
 * Hand a use back. Used when a claim succeeded but the thing it was claimed
 * for then failed, so a customer is never charged a use for a launch that did
 * not happen. Best effort and never throws: a release that fails leaves the
 * count one high, which refuses one extra redemption rather than allowing one.
 */
async function releasePromoUse(supabase, { code, missionId, source }) {
  const normalised = normaliseCode(code);
  if (!normalised) return { released: false, reason: 'not_found' };

  if (typeof supabase.rpc === 'function') {
    try {
      const { data, error } = await supabase.rpc('release_promo_code', {
        p_code:       normalised,
        p_mission_id: missionId,
        p_source:     source || null,
      }) || {};
      if (!error) {
        const payload = Array.isArray(data) ? data[0] : data;
        if (payload && typeof payload.released === 'boolean') {
          return { released: payload.released, reason: payload.reason || 'released' };
        }
      } else if (!NOT_DEPLOYED_CODES.has(error.code)) {
        logger.warn('promo release: release_promo_code failed', {
          code: normalised, missionId, err: error.message,
        });
        return { released: false, reason: 'error' };
      }
    } catch (_) { /* fall through to the conditional update */ }
  }

  try {
    const { data: row } = await supabase
      .from('promo_codes')
      .select('code, uses_count')
      .eq('code', normalised)
      .single();
    if (!row) return { released: false, reason: 'not_found' };
    const observed = usesCount(row);
    if (observed <= 0) return { released: false, reason: 'nothing_to_release' };

    const { data } = await supabase
      .from('promo_codes')
      .update({ uses_count: observed - 1 })
      .eq('code', row.code)
      .eq('uses_count', observed)
      .gt('uses_count', 0)
      .select('code, uses_count');
    const updated = Array.isArray(data) ? data : (data ? [data] : []);
    return updated.length > 0
      ? { released: true, reason: 'released' }
      : { released: false, reason: 'contended' };
  } catch (err) {
    logger.warn('promo release: conditional update threw', {
      code: normalised, missionId, err: err.message,
    });
    return { released: false, reason: 'error' };
  }
}

/**
 * The $0 path. Allowed to fall back to the conditional UPDATE because
 * /payments/free-launch returns "already_running" for any mission that is
 * already paid, so a retry never reaches the claim.
 */
function recordFreeLaunchRedemption(supabase, { code, missionId }) {
  return claimPromoUse(supabase, {
    code, missionId, source: 'free_launch', requireLedger: false,
  });
}

/**
 * The paid paths. Requires the pass-53 ledger, because the Stripe webhook, the
 * success-page poll and the webhook-miss cron can all confirm the same mission
 * at the same time and only a per-mission ledger can turn that into one use.
 *
 * Never throws and never blocks: the customer has already paid, so a promo
 * that cannot be counted is a bookkeeping problem, not a reason to withhold
 * the mission they bought.
 */
async function recordPaidRedemption(supabase, { code, missionId, source }) {
  const normalised = normaliseCode(code);
  if (!normalised) return { claimed: false, reason: 'no_promo', via: 'none' };
  try {
    const result = await claimPromoUse(supabase, {
      code: normalised, missionId, source: source || 'paid', requireLedger: true,
    });
    if (result.reason === 'ledger_unavailable') {
      logger.warn('promo redemption not counted: claim_promo_code is not deployed', {
        code: normalised, missionId, source,
      });
    } else if (!result.claimed) {
      // Two checkouts can both be open on the last use of a code and both
      // pay. Refusing the mission at this point would be taking money and
      // withholding the study, so this is loud and then allowed.
      logger.warn('promo redemption over its limit at payment confirmation', {
        code: normalised, missionId, source, reason: result.reason,
      });
    } else {
      logger.info('promo redemption counted', {
        code: normalised, missionId, source, reason: result.reason,
      });
    }
    return result;
  } catch (err) {
    logger.error('promo redemption crashed (payment is unaffected)', {
      code: normalised, missionId, err: err.message,
    });
    return { claimed: false, reason: 'error', via: 'none' };
  }
}

module.exports = {
  normaliseCode,
  promoLimit,
  isExpired,
  isExhausted,
  isPromoUsable,
  promoUnusableReason,
  resolveUsablePromo,
  claimPromoUse,
  releasePromoUse,
  recordFreeLaunchRedemption,
  recordPaidRedemption,
  MAX_CLAIM_ATTEMPTS,
};
