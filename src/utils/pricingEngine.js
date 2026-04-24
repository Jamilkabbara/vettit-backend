/**
 * VETT PRICING ENGINE — Country-tier based pricing (server-side source of truth)
 *
 * This is the CANONICAL formula. The frontend (src/utils/pricingEngine.ts)
 * mirrors it exactly for display. Any change here must be reflected there.
 *
 * Rate per respondent (based on highest-quality country selected):
 *   Tier 1 (US, UAE, UK, AU, etc.)   → $3.50 / respondent
 *   Tier 2 (secondary/emerging)       → $2.75 / respondent
 *   Tier 3 (frontier markets)         → $1.90 / respondent  ← default
 *
 * Extra questions:  $20 each beyond the first 5 (free)
 *
 * Per-respondent targeting surcharges (capped per category):
 *   Professional B2B  min(count × $0.50, $1.50) / respondent
 *   Technographics    min(count × $0.50, $1.00) / respondent
 *   Financial         min(count × $0.50, $1.00) / respondent
 *   City targeting    $1.00 / respondent
 *   Screening         $0.50 / respondent
 *   Pixel retargeting (REMOVED 2026-04-24 — no longer charged)
 *
 * Demographics (age, gender, education, marital, parental, employment)
 *   are FREE — covered by the base rate.
 *
 * PRICING HISTORY
 *   Prior formula (until 2026-04-23) used volume-based tiers ($0.90/resp
 *   for ≤200 respondents) regardless of country. This caused the UAE
 *   mission 7f54fb42 to be charged $9 (900 cents) while the UI showed
 *   $35 — a $26 undercharge. This file is the corrected implementation.
 */

// ── Country tier registry ────────────────────────────────────────────────────

/** Tier 1 — premium research markets */
const TIER_1 = new Set([
  'AE','AU','CA','CH','DE','DK','FR','GB','IE','JP','KR','NL','NO','NZ','SE','SG','US',
]);

/** Tier 2 — secondary / major emerging markets */
const TIER_2 = new Set([
  'AR','AT','BD','BE','BG','BH','BR','CL','CN','CO','CY','CZ','EE','ES','FI','GR',
  'HK','HR','HU','ID','IN','IS','IT','JO','KW','LB','LK','LT','LU','LV','MT','MX',
  'MY','NG','OM','PH','PK','PL','PT','QA','RO','RS','RU','SA','SK','SI','TH','TR',
  'TW','UA','VN','ZA',
]);

/** Rate per respondent by tier */
const TIER_RATES = {
  1: 3.50,
  2: 2.75,
  3: 1.90,
};

const EXTRA_QUESTION_PRICE = 20; // $ per question beyond the 5th
const FREE_QUESTIONS        = 5;

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Return the tier (1/2/3) for a single ISO-3166-1-alpha-2 code. */
function getCountryTier(code) {
  if (TIER_1.has(code)) return 1;
  if (TIER_2.has(code)) return 2;
  return 3;
}

/**
 * Resolve the highest-quality tier (lowest number) from an array of country
 * codes. Returns 3 (cheapest) when the array is empty — callers that want a
 * different default must pass an explicit list.
 */
function resolveHighestTier(countries) {
  if (!Array.isArray(countries) || countries.length === 0) return 3;
  return countries.reduce((best, code) => {
    const t = getCountryTier(String(code).toUpperCase());
    return t < best ? t : best;
  }, 3);
}

/**
 * Extract country codes from a mission DB row.
 * Priority order:
 *   1. mission.targeting.geography.countries  (set when user picked countries in UI)
 *   2. mission.target_audience.aiTargeting.countries  (AI-suggested, used when 1 empty)
 *   3. mission.target_audience.suggestions.countries  (legacy shape)
 */
function extractCountriesFromMission(mission) {
  const t = mission && mission.targeting;
  const fromTargeting = t && t.geography && t.geography.countries;
  if (Array.isArray(fromTargeting) && fromTargeting.length > 0) return fromTargeting;

  const ta = mission && mission.target_audience;
  const fromAi = ta && ta.aiTargeting && ta.aiTargeting.countries;
  if (Array.isArray(fromAi) && fromAi.length > 0) return fromAi;

  const fromSugg = ta && ta.suggestions && ta.suggestions.countries;
  if (Array.isArray(fromSugg) && fromSugg.length > 0) return fromSugg;

  return [];
}

// ── Main formula ─────────────────────────────────────────────────────────────

/**
 * Calculate the authoritative price for a mission.
 *
 * @param {object} opts
 * @param {number}   opts.respondentCount
 * @param {object}   [opts.targeting]          Full TargetingConfig (from missions.targeting)
 * @param {number}   [opts.questionCount]
 * @param {string[]} [opts.countries]           ISO codes for tier resolution
 * @param {object}   [opts.promoCode]           { code, type:'percentage'|'flat', value, active }
 * @param {boolean}  [opts.isScreeningActive]
 * @returns {PricingBreakdown}
 */
function calculateMissionPrice({
  respondentCount,
  targeting = {},
  questionCount = 0,
  countries = [],
  promoCode = null,
  isScreeningActive = false,
} = {}) {
  // 1. Base rate from country tier
  const tier        = resolveHighestTier(countries);
  const ratePerResp = TIER_RATES[tier] ?? 1.90;
  const base        = respondentCount * ratePerResp;

  // 2. Extra questions
  const extraQ         = Math.max(0, questionCount - FREE_QUESTIONS);
  const questionSurcharge = extraQ * EXTRA_QUESTION_PRICE;

  // 3. Per-respondent targeting surcharges (capped per category, same as frontend)
  const tgt = targeting || {};

  // Professional B2B: industries + roles + companySizes, capped at $1.50/resp
  const professionalCount =
    ((tgt.professional && tgt.professional.industries) || []).length +
    ((tgt.professional && tgt.professional.roles)      || []).length +
    ((tgt.professional && tgt.professional.companySizes) || []).length;
  const professionalCost = Math.min(professionalCount * 0.50, 1.50);

  // Technographics: non-"No Preference" devices + behaviors, capped at $1.00/resp
  const devices = ((tgt.technographics && tgt.technographics.devices) || [])
    .filter(d => d !== 'No Preference').length;
  const behaviors = (tgt.behaviors || []).length;
  const technographicsCost = Math.min((devices + behaviors) * 0.50, 1.00);

  // Financial: income ranges, capped at $1.00/resp
  const incomeCount    = ((tgt.financials && tgt.financials.incomeRanges) || []).length;
  const financialCost  = Math.min(incomeCount * 0.50, 1.00);

  // City targeting: flat $1.00/resp
  const hasCities = ((tgt.geography && tgt.geography.cities) || []).length > 0;
  const cityCost  = hasCities ? 1.00 : 0;

  const perRespFilterCost = professionalCost + technographicsCost + financialCost + cityCost;
  const targetingSurcharge = round2(perRespFilterCost * respondentCount);

  // 4. Screening surcharge ($0.50/resp)
  const screeningSurcharge = isScreeningActive ? round2(respondentCount * 0.50) : 0;

  // Pixel retargeting surcharge removed — feature discontinued 2026-04-24.
  // Historical missions may still have targeting.retargeting data; we no
  // longer add any surcharge for it.

  const subtotal = round2(base + questionSurcharge + targetingSurcharge + screeningSurcharge);

  // 6. Promo discount
  let discount = 0;
  if (promoCode && promoCode.active) {
    if (promoCode.type === 'free') {
      discount = subtotal;                                           // 100% off
    } else if (promoCode.type === 'percentage') {
      discount = round2(subtotal * (promoCode.value / 100));
    } else if (promoCode.type === 'flat' || promoCode.type === 'fixed') {
      discount = round2(Math.min(promoCode.value, subtotal));
    }
  }

  const total = round2(Math.max(0, subtotal - discount));

  return {
    // Mirror the frontend PricingBreakdown field names so verifyServerQuote() works:
    base:               round2(base),
    questionSurcharge:  round2(questionSurcharge),
    targetingSurcharge,
    screeningSurcharge,
    subtotal,
    discount,
    total,
    totalCents: Math.round(total * 100),
    // Extra metadata for logging / breakdown lines:
    tier,
    ratePerResp,
    countries,
    respondentCount,
    questionCount,
    // Legacy aliases (payments.js stores these column names):
    baseCost:             round2(base),
    extraQuestionsCost:   round2(questionSurcharge),
  };
}

function round2(val) {
  return Math.round(val * 100) / 100;
}

module.exports = {
  calculateMissionPrice,
  extractCountriesFromMission,
  resolveHighestTier,
  getCountryTier,
  TIER_RATES,
  TIER_1,
  TIER_2,
};
