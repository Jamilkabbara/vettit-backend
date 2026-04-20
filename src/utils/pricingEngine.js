/**
 * VETT PRICING ENGINE — Volume-based tiers (server-side source of truth)
 * Master prompt spec: DO NOT trust client-computed totals.
 * Recalculate from scratch before every Stripe charge.
 */

const TIER_RATES = [
  { max: 200,  rate: 0.90 },
  { max: 500,  rate: 0.75 },
  { max: 1000, rate: 0.62 },
  { max: 2000, rate: 0.50 },
  { max: 5000, rate: 0.40 },
];

const SURCHARGE_RATES = {
  city:            0.10,
  b2b:             0.15,
  income:          0.15,
  psychographics:  0.20,
  behavioural:     0.20,
  custom_persona:  0.25,
};

const SMART_CAP          = 0.60; // max combined targeting surcharge per respondent
const EXTRA_QUESTION_PRICE = 20; // $ per question after the 5th
const FREE_QUESTIONS     = 5;

/**
 * Main pricing function.
 *
 * @param {number}   respondentCount
 * @param {string[]} activeFilters    e.g. ['b2b', 'psychographics', 'city']
 * @param {number}   questionCount
 * @param {object}   [promoCode]      { code, type:'percentage'|'flat', value, active }
 * @returns {object} PricingBreakdown
 */
function calculateMissionPrice(respondentCount, activeFilters = [], questionCount = 0, promoCode = null) {
  // 1. Tier rate (volume-based)
  const tier = TIER_RATES.find(t => respondentCount <= t.max) || TIER_RATES[TIER_RATES.length - 1];
  const baseCost = respondentCount * tier.rate;

  // 2. Targeting surcharge (capped at SMART_CAP per respondent)
  const rawSurcharge = activeFilters.reduce((sum, f) => {
    return sum + (SURCHARGE_RATES[f] || 0);
  }, 0);
  const effectiveSurcharge = Math.min(rawSurcharge, SMART_CAP);
  const targetingSurchargeTotal = respondentCount * effectiveSurcharge;

  // 3. Extra questions ($20 each beyond 5 free)
  const extraQuestions = Math.max(0, questionCount - FREE_QUESTIONS);
  const extraQuestionsCost = extraQuestions * EXTRA_QUESTION_PRICE;

  const subtotal = baseCost + targetingSurchargeTotal + extraQuestionsCost;

  // 4. Promo discount
  let discount = 0;
  if (promoCode && promoCode.active) {
    if (promoCode.type === 'percentage') {
      discount = subtotal * (promoCode.value / 100);
    } else {
      discount = Math.min(promoCode.value, subtotal);
    }
  }

  const total = Math.max(0, subtotal - discount);

  return {
    baseCost:          round2(baseCost),
    targetingSurcharge: round2(targetingSurchargeTotal),
    extraQuestionsCost: round2(extraQuestionsCost),
    subtotal:          round2(subtotal),
    discount:          round2(discount),
    total:             round2(total),
    totalCents:        Math.round(total * 100), // for Stripe
    ratePerResp:       tier.rate,
    smartCapApplied:   rawSurcharge > SMART_CAP,
    respondentCount,
    activeFilters,
    questionCount,
  };
}

/**
 * Derive activeFilters array from a targeting config object.
 * The targeting config shape: { geography: { cities }, b2b, income, psychographics, behavioural, custom_persona }
 */
function deriveFilters(targeting = {}) {
  const filters = [];
  if (targeting.geography?.cities?.length > 0) filters.push('city');
  if (targeting.b2b)              filters.push('b2b');
  if (targeting.income)           filters.push('income');
  if (targeting.psychographics)   filters.push('psychographics');
  if (targeting.behavioural)      filters.push('behavioural');
  if (targeting.custom_persona)   filters.push('custom_persona');
  return filters;
}

function round2(val) {
  return Math.round(val * 100) / 100;
}

module.exports = { calculateMissionPrice, deriveFilters, TIER_RATES, SURCHARGE_RATES };
