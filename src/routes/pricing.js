const express = require('express');
const router = express.Router();
const { optionalAuthenticate } = require('../middleware/auth');
const supabase = require('../db/supabase');
const { calculateMissionPrice, extractCountriesFromMission, getActiveTierTable } = require('../utils/pricingEngine');
const logger = require('../utils/logger');

/**
 * POST /api/pricing/quote
 *
 * Authoritative server-side price quote. Returns the same shape the
 * frontend's `verifyServerQuote()` helper (src/utils/pricingEngine.ts)
 * expects, so the setup page can reconcile its client-computed total
 * against the server before Stripe charge. If they diverge by more
 * than $0.02 the client uses the server breakdown.
 *
 * Accepts either shape:
 *   1. { missionId }                               — look up the row
 *   2. { respondentCount, targetingConfig, questions?, promoCode? }
 *        — free-form quote (no DB row required)
 *
 * Response:
 *   {
 *     total:       number,                 // dollars
 *     actualRate:  number,                 // per-respondent $ (baseline tier rate)
 *     breakdown:   Array<{ label, amount }>,
 *     // plus the full PricingBreakdown for tooling that wants it
 *     details:     PricingBreakdown
 *   }
 */
router.post('/quote', optionalAuthenticate, async (req, res, next) => {
  try {
    const {
      missionId,
      respondentCount: bodyRespCount,
      targetingConfig,
      targeting,
      activeFilters,
      questions,
      questionCount,
      promoCode,
    } = req.body || {};

    let respCount;
    let missionRow;
    let qCount;

    if (missionId) {
      // DB-backed quote — recompute from the authoritative row
      const query = supabase
        .from('missions')
        .select('respondent_count, targeting, target_audience, questions, user_id, goal_type, media_type')
        .eq('id', missionId);

      // If the caller is authenticated, scope to their row (prevents
      // quoting on someone else's mission). Anonymous callers get a
      // read-only quote because calculate-price already exposes the
      // pricing engine publicly — not a new information leak.
      const { data: mission, error } = req.user
        ? await query.eq('user_id', req.user.id).single()
        : await query.single();

      if (error || !mission) {
        return res.status(404).json({ error: 'Mission not found' });
      }

      // Pass 21 Bug 16: default fallback 100 → 50 to align with the new
      // entry-tier default. Existing missions still respect their stored
      // respondent_count; this only affects rows where it's null/0.
      respCount       = mission.respondent_count || 50;
      missionRow      = mission;
      qCount          = Array.isArray(mission.questions) ? mission.questions.length : 0;
    } else {
      respCount = bodyRespCount || 50;
      missionRow = { targeting: targetingConfig || targeting || {} };
      qCount = Array.isArray(questions)
        ? questions.length
        : (typeof questionCount === 'number' ? questionCount : 5);
    }

    // Resolve promo (optional)
    let promo = null;
    if (promoCode) {
      const { data } = await supabase
        .from('promo_codes')
        .select('*')
        .eq('code', promoCode)
        .eq('active', true)
        .single();
      if (data) {
        const expired = data.expires_at && new Date(data.expires_at) < new Date();
        const exhausted = data.max_uses && data.uses_count >= data.max_uses;
        if (!expired && !exhausted) promo = data;
      }
    }

    const countries = extractCountriesFromMission(missionRow);
    const details = calculateMissionPrice({
      respondentCount: respCount,
      targeting:       missionRow.targeting || {},
      questionCount:   qCount,
      countries,
      promoCode:       promo,
      // Pass the mission's goal_type/media_type so the quote uses the same
      // ladder the charge does (DB-backed quotes; free-form quotes default to
      // validate). Under PRICING_V2 all goals share one ladder anyway.
      goalType:        missionRow.goal_type,
      mediaType:       missionRow.media_type,
    });

    // Enterprise / custom-tier (PRICING_V2): no self-serve price — return a
    // custom-quote response, never a $0 or per-respondent breakdown.
    if (details.customQuote) {
      return res.json({
        total: null, actualRate: null, breakdown: [], details, customQuote: true,
        error: 'This study size requires a custom quote, please contact sales.',
      });
    }

    // Build the human-readable breakdown the UI renders line-by-line. V2 is flat
    // tier pricing (ratePerResp null), so label the base by tier, not "× $rate".
    const baseLabel = details.ratePerResp != null
      ? `${respCount} respondents × $${details.ratePerResp.toFixed(2)}`
      : `${(details.volumeTier && details.volumeTier.name) || 'Base'} tier (${respCount} respondents)`;
    const breakdown = [
      { label: baseLabel, amount: details.base },
    ];
    if (details.targetingSurcharge > 0) {
      breakdown.push({
        label: 'Targeting surcharge',
        amount: details.targetingSurcharge,
      });
    }
    if (details.extraQuestionsCost > 0) {
      breakdown.push({
        label: `Extra questions (${qCount - 5})`,
        amount: details.extraQuestionsCost,
      });
    }
    if (details.discount > 0) {
      breakdown.push({
        label: promo?.code ? `Promo: ${promo.code}` : 'Promo discount',
        amount: -details.discount,
      });
    }

    res.json({
      total: details.total,
      actualRate: details.ratePerResp,
      breakdown,
      details,
    });
  } catch (err) {
    logger.error('pricing/quote failed', { err: err.message });
    next(err);
  }
});

/**
 * GET /api/pricing/tiers
 *
 * THE single, flag-aware source of truth for every price DISPLAY surface
 * (pricing section, per-card "from" prices, setup tier picker, Terms table).
 * Returns the active tier ladder — V1 today, the canonical V2 ladder after the
 * owner flips PRICING_V2 — so display can never drift from what Stripe charges
 * (both read this same module). Public (no auth): prices are not sensitive and
 * the landing page renders them pre-login. Cache lightly at the edge.
 *
 * Response: { version, flagActive, startingFromCents, tiers: [
 *   { id, name, respondents, priceCents, priceUsd, fromLabel, custom } ] }
 */
router.get('/tiers', (req, res) => {
  res.set('Cache-Control', 'public, max-age=300');
  res.json(getActiveTierTable());
});

module.exports = router;
