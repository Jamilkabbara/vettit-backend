/**
 * VETT — "does captured payment cover the run we are about to perform?"
 *
 * Every price check in the stack answers a question about a MOMENT:
 *
 *   validateMissionPricing  — is this mission priceable, at checkout time?
 *   create-checkout-session — what do we charge, at session-creation time?
 *   the Stripe webhook      — what did they actually pay, at capture time?
 *
 * None of them answers the question that decides whether we lose money:
 * does the amount we captured cover the mission AS IT WILL NOW RUN? The
 * mission is a mutable row, and the run reads that row - not the Stripe
 * session, not the price_breakdown snapshot.
 *
 * The window that matters is between session creation and capture. RLS
 * (missions_update_only_while_unpaid) permits owner edits while a mission is
 * draft or pending_payment, which is correct - a buyer who has not paid must
 * be able to change their mind. But a Stripe Checkout Session is created from
 * a mission in pending_payment and captures whatever amount it was created
 * with. So:
 *
 *   1. create a mission at 5 respondents          -> owed $9
 *   2. open checkout                              -> Session for $9
 *   3. edit respondent_count to 1000 (still pending_payment, RLS allows it)
 *   4. complete the $9 payment                    -> webhook marks paid
 *   5. runMission reads respondent_count = 1000   -> runs 1000 for $9
 *
 * Every individual step is behaving correctly. The price was right when the
 * session was made and right when it was charged; only the mission changed in
 * between. This module is the check that spans the two moments.
 *
 * WHAT COUNTS AS CAPTURED
 * Stripe is the record of truth for money, the way ai_calls is for spend.
 * mission.paid_amount_cents is a denormalised copy that is known to be null on
 * legitimately paid missions (adminCosts alerts on exactly that), and
 * paid_amount_estimated=true means it was backfilled from the mission's own
 * total_price_usd - which is a mission column, so trusting it would make the
 * gate circular. Order of preference:
 *
 *   1. Stripe amount_received on latest_payment_intent_id  (authoritative)
 *   2. paid_amount_cents when NOT flagged estimated        (Stripe-sourced copy)
 *   3. zero                                                (assume nothing)
 *
 * WHAT COUNTS AS OWED
 * The LOWEST amount that could have been a correct charge for this mission
 * under any pricing version we have shipped. That is min(exact ladder total,
 * whole-dollar charge), and it needs to be the minimum because the two
 * versions disagree in BOTH directions:
 *
 *   n=10  exact $15.60  ->  charged $16.00   (rounds UP)
 *   n=60  exact $89.40  ->  charged $89.00   (rounds DOWN)
 *
 * Compare against the charge alone and every customer billed before #160 is
 * refused on resume ($15.60 captured against $16 owed). Compare against the
 * exact total alone and every mission whose price rounds DOWN is refused right
 * now, on its first run, with a perfectly correct payment ($89 captured
 * against $89.40 owed) - Math.round rounds down half the time, so this is not
 * an edge case, it is half the ladder. The minimum accepts both and still
 * catches a real shortfall, which is dollars wide, not cents.
 *
 * WHAT THIS DOES NOT CLOSE
 * A $0 mission. If owed is zero (a valid free-type promo) then captured zero
 * covers it, by construction. That is correct for a real free launch, and it
 * means this gate contributes nothing against a forged one. Forged-free is
 * blocked elsewhere and only elsewhere: a client cannot write status='paid'
 * (RLS with_check) and runMission's claim requires status='paid', so a
 * client-forged promo_code cannot reach a run. That containment is RLS plus
 * the claim, not this file - noted here so nobody reads this gate as covering
 * it.
 */

const stripeService = require('../stripe');
const logger = require('../../utils/logger');
const {
  calculateMissionPrice,
  extractCountriesFromMission,
} = require('../../utils/pricingEngine');

// Float noise only. NOT a business allowance: a real shortfall is dollars, and
// anything a cent wide is arithmetic, not underpayment.
const TOLERANCE_CENTS = 1;

/**
 * Resolve the mission's promo the same way create-checkout-session does:
 * from the promo_codes table, active, unexpired, unexhausted. Never from the
 * mission row alone - mission.promo_code is only the NAME of a code, and the
 * terms have to come from the table a client cannot write.
 */
async function resolvePromo(supabase, promoCode) {
  if (!promoCode) return null;
  const { data } = await supabase
    .from('promo_codes')
    .select('*')
    .eq('code', String(promoCode).toUpperCase().trim())
    .eq('active', true)
    .maybeSingle();
  if (!data) return null;
  const expired   = data.expires_at && new Date(data.expires_at) < new Date();
  const exhausted = data.max_uses && data.uses_count >= data.max_uses;
  if (expired || exhausted) return null;
  return data;
}

/**
 * What did we actually capture? Stripe first, and say which source answered so
 * the refusal payload can be audited without re-deriving it.
 */
async function resolveCapturedCents(mission) {
  const piId = mission.latest_payment_intent_id;
  if (piId) {
    try {
      const pi = await stripeService.retrievePaymentIntent(piId);
      if (pi && Number.isFinite(pi.amount_received)) {
        return { capturedCents: pi.amount_received, source: 'stripe', paymentIntentId: piId };
      }
    } catch (err) {
      // A Stripe outage must not become a free run, and must not become a
      // false refusal on a mission whose row already carries a Stripe-sourced
      // amount. Fall through to that copy; fall to zero only if there is none.
      logger.warn('paymentCoversRun: Stripe lookup failed, falling back to mission row', {
        missionId: mission.id, paymentIntentId: piId, err: err.message,
      });
    }
  }

  const rowCents = Number(mission.paid_amount_cents);
  if (Number.isFinite(rowCents) && rowCents > 0 && mission.paid_amount_estimated !== true) {
    return { capturedCents: rowCents, source: 'mission.paid_amount_cents', paymentIntentId: piId || null };
  }

  return { capturedCents: 0, source: 'none', paymentIntentId: piId || null };
}

/**
 * @returns {Promise<{ok: boolean, owedCents: number, capturedCents: number,
 *                     source: string, detail: object}>}
 */
async function checkPaymentCoversRun(supabase, mission) {
  const promo = await resolvePromo(supabase, mission.promo_code);

  // Price the mission exactly as the run will read it: the live columns, not
  // price_breakdown, not total_price_usd. If pricing throws (an unpriceable
  // mission that somehow reached paid), that is a refusal, not a pass.
  let pricing;
  try {
    pricing = calculateMissionPrice({
      respondentCount: mission.respondent_count,
      targeting:       mission.targeting || {},
      questionCount:   (mission.questions || []).length,
      countries:       extractCountriesFromMission(mission),
      promoCode:       promo,
      goalType:        mission.goal_type,
      mediaType:       mission.media_type,
    });
  } catch (err) {
    return {
      ok: false,
      owedCents: null,
      capturedCents: null,
      source: 'unpriced',
      detail: { pricing_error: err.message },
    };
  }

  const exactTotal   = Number(pricing.exactTotal != null ? pricing.exactTotal : pricing.total);
  const chargedTotal = Number(pricing.total);
  const exactCents   = Math.round(exactTotal * 100);
  const chargedCents = Number.isFinite(pricing.totalCents)
    ? pricing.totalCents
    : Math.round(chargedTotal * 100);

  // See WHAT COUNTS AS OWED above: whichever of the two shipped pricing
  // versions is cheaper is the bar, so neither rounding direction can refuse a
  // correct payment.
  const owedCents = Math.min(exactCents, chargedCents);

  const { capturedCents, source, paymentIntentId } = await resolveCapturedCents(mission);

  const ok = capturedCents + TOLERANCE_CENTS >= owedCents;

  return {
    ok,
    owedCents,
    capturedCents,
    source,
    detail: {
      payment_intent_id:  paymentIntentId,
      captured_source:    source,
      owed_exact_usd:     exactTotal,
      owed_charged_usd:   chargedTotal,
      owed_exact_cents:   exactCents,
      owed_charged_cents: chargedCents,
      shortfall_cents:    ok ? 0 : owedCents - capturedCents,
      respondent_count:   mission.respondent_count,
      question_count:     (mission.questions || []).length,
      goal_type:          mission.goal_type,
      media_type:         mission.media_type,
      promo_code:         mission.promo_code || null,
      promo_honoured:     promo ? promo.code : null,
      promo_type:         promo ? promo.type : null,
      total_price_usd:    mission.total_price_usd,
      paid_amount_cents:  mission.paid_amount_cents,
      paid_amount_estimated: mission.paid_amount_estimated === true,
    },
  };
}

module.exports = {
  checkPaymentCoversRun,
  resolvePromo,
  resolveCapturedCents,
  TOLERANCE_CENTS,
};
