/**
 * VETTIT PRICING ENGINE (Backend)
 * ─────────────────────────────────────────────────────────────
 * This is the SOURCE OF TRUTH for all pricing.
 * The frontend shows estimated prices; this backend re-calculates
 * before every payment to ensure Jamil never loses margin.
 *
 * Pollfish base costs (update these once you have your Pollfish
 * account and know their actual per-market CPI rates):
 *   Tier 1 (US, UK, CA, AU): ~$2.00–$2.50 / respondent actual cost
 *   Tier 2 (UAE, SA, DE, FR): ~$1.80–$2.20 / respondent actual cost
 *   Tier 3 (Rest of World):   ~$0.95–$1.50 / respondent actual cost
 *
 * Vettit charges customers (with margin built in):
 *   Tier 1: $3.50 / respondent
 *   Tier 2: $2.75 / respondent
 *   Tier 3: $1.90 / respondent
 */

const TIER_1_COUNTRIES = ['US', 'UK', 'CA', 'AU', 'NZ', 'IE'];
const TIER_2_COUNTRIES = ['AE', 'SA', 'DE', 'FR', 'JP', 'SG', 'NL', 'SE', 'CH', 'NO'];

// What Vettit charges the customer
const CUSTOMER_RATES = {
  tier1: 3.50,
  tier2: 2.75,
  tier3: 1.90,
};

// Minimum margin we must maintain (safety check)
const MIN_MARGIN_PERCENT = 0.20; // 20% minimum

function getCountryTier(countryCode) {
  if (TIER_1_COUNTRIES.includes(countryCode)) return 'tier1';
  if (TIER_2_COUNTRIES.includes(countryCode)) return 'tier2';
  return 'tier3';
}

function getHighestTier(countries = []) {
  if (!countries.length) return 'tier3';
  // Use the most expensive tier (highest cost = most premium market)
  if (countries.some(c => TIER_1_COUNTRIES.includes(c))) return 'tier1';
  if (countries.some(c => TIER_2_COUNTRIES.includes(c))) return 'tier2';
  return 'tier3';
}

function calculatePricing({ respondentCount, questions = [], targeting = {}, isScreeningActive = false }) {
  const countries = targeting?.geography?.countries || [];
  const cities = targeting?.geography?.cities || [];
  const professional = targeting?.professional || {};
  const technographics = targeting?.technographics || {};
  const financials = targeting?.financials || {};
  const retargeting = targeting?.retargeting || {};

  const tier = getHighestTier(countries);
  const baseRate = CUSTOMER_RATES[tier];

  // 1. Base cost
  const baseCost = respondentCount * baseRate;

  // 2. Question surcharge ($20 per question beyond 5)
  const extraQuestions = Math.max(0, questions.length - 5);
  const questionSurcharge = extraQuestions * 20;

  // 3. Targeting surcharges (per respondent, capped by category)
  let targetingSurcharge = 0;

  // Professional B2B: $0.50/filter, capped at $1.50/respondent
  const professionalFilters = [
    ...(professional.industries || []),
    ...(professional.roles || []),
    ...(professional.companySizes || []),
  ].length;
  const professionalRate = Math.min(professionalFilters * 0.50, 1.50);
  targetingSurcharge += professionalRate * respondentCount;

  // Technographics: $0.50/filter, capped at $1.00/respondent
  const techFilters = [
    ...(technographics.devices || []),
    ...(technographics.behaviors || []),
  ].length;
  const techRate = Math.min(techFilters * 0.50, 1.00);
  targetingSurcharge += techRate * respondentCount;

  // Financial: $0.50/filter, capped at $1.00/respondent
  const financialFilters = (financials.incomeRanges || []).length;
  const financialRate = Math.min(financialFilters * 0.50, 1.00);
  targetingSurcharge += financialRate * respondentCount;

  // City targeting: $1.00/respondent flat
  const cityRate = cities.length > 0 ? 1.00 : 0;
  targetingSurcharge += cityRate * respondentCount;

  // 4. Screening surcharge: $0.50/respondent if active
  const screeningSurcharge = isScreeningActive ? respondentCount * 0.50 : 0;

  // 5. Retargeting: $1.50/respondent if pixel enabled
  const retargetingSurcharge = retargeting.enabled ? respondentCount * 1.50 : 0;

  const total = baseCost + questionSurcharge + targetingSurcharge + screeningSurcharge + retargetingSurcharge;

  const filterCount = professionalFilters + techFilters + financialFilters + (cities.length > 0 ? 1 : 0);

  return {
    tier,
    baseRate,
    respondentCount,
    baseCost: round(baseCost),
    questionSurcharge: round(questionSurcharge),
    targetingSurcharge: round(targetingSurcharge),
    screeningSurcharge: round(screeningSurcharge),
    retargetingSurcharge: round(retargetingSurcharge),
    total: round(total),
    totalCents: Math.round(total * 100), // for Stripe
    filterCount,
    breakdown: {
      professional: round(professionalRate * respondentCount),
      technographics: round(techRate * respondentCount),
      financial: round(financialRate * respondentCount),
      city: round(cityRate * respondentCount),
      retargeting: round(retargetingSurcharge),
    }
  };
}

function round(val) {
  return Math.round(val * 100) / 100;
}

module.exports = { calculatePricing, getCountryTier, getHighestTier };
