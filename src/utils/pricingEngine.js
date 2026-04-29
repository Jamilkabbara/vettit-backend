/**
 * VETT PRICING ENGINE — Volume-tier based pricing (server-side source of truth)
 *
 * This is the CANONICAL formula. The frontend (src/utils/pricingEngine.ts)
 * mirrors it exactly for display. Any change here must be reflected there.
 *
 * Pass 23 Bug 23.PRICING — switched from country-tier to a 4-tier respondent-
 * count ladder. AI-simulated personas have the same marginal cost regardless
 * of the country mocked, so charging more for "tier 1" countries was an
 * artifact of the panel-recruitment era. The new ladder anchors price-per-
 * mission at four named packages:
 *
 *   Sniff Test  — 5 resp     · $9    · $1.80/resp
 *   Validate    — 10 resp    · $35   · $3.50/resp   (the default first mission)
 *   Confidence  — 50 resp    · $99   · $1.98/resp
 *   Deep Dive   — 250 resp   · $299  · $1.20/resp   (also covers 250+)
 *
 * Bracket pricing applies the rate of the tier the count falls in. Boundary
 * effect: counts that straddle a tier boundary (e.g. 49 vs 50) can produce
 * non-monotonic totals because the per-respondent rate jumps. This is a
 * known consequence of value-based packaging — users who pick a non-anchor
 * count generally land within one tier and the boundary is a small minority.
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
 *   - until 2026-04-23: volume-based ($0.90/resp ≤200 across the board) —
 *     caused $26 undercharge on UAE mission 7f54fb42 (UI showed $35, charge $9).
 *   - 2026-04-23 → 2026-04-28: country-tier ($3.50 / $2.75 / $1.90 by ISO).
 *   - 2026-04-28 (this file): volume-tier 4-package ladder.
 */

// ── Country tier registry — kept for backwards-compat only ──────────────────
// Pass 23 Bug 23.PRICING: country tier is no longer used in the price
// calculation. The sets and helpers below are retained because callers
// elsewhere may import getCountryTier or resolveHighestTier for analytics
// or country grouping. New code should use getVolumeTier instead.

/** Tier 1 — premium research markets (legacy, no longer affects price) */
const TIER_1 = new Set([
  'AE','AU','CA','CH','DE','DK','FR','GB','IE','JP','KR','NL','NO','NZ','SE','SG','US',
]);

/** Tier 2 — secondary / major emerging markets (legacy) */
const TIER_2 = new Set([
  'AR','AT','BD','BE','BG','BH','BR','CL','CN','CO','CY','CZ','EE','ES','FI','GR',
  'HK','HR','HU','ID','IN','IS','IT','JO','KW','LB','LK','LT','LU','LV','MT','MX',
  'MY','NG','OM','PH','PK','PL','PT','QA','RO','RS','RU','SA','SK','SI','TH','TR',
  'TW','UA','VN','ZA',
]);

/** Country-tier rates — legacy, retained so analytics callers don't break. */
const TIER_RATES = {
  1: 3.50,
  2: 2.75,
  3: 1.90,
};

// ── Volume tier ladders — Pass 23 Bug 23.PRICING + 23.51 ──────────────────────
//
// Three goal-keyed ladders. The default ladder (validate / naming_messaging /
// marketing / fallback) is the original VOLUME_TIERS, extended with Scale and
// Enterprise tiers per the master Pass 23 plan. Brand Lift uses
// statistical-sample-size tiers only (no Sniff Test, no Validate). Creative
// Attention is flat-per-asset, not per-respondent.
//
// Each tier carries packagePrice + (for respondent-based) ratePerResp +
// anchorCount. Creative Attention tiers carry assetCount instead of anchor
// count, with packagePrice as the flat charge.

/** Default volume ladder — used by validate, naming_messaging, marketing. */
const VOLUME_TIERS = [
  { id: 'sniff_test', name: 'Sniff Test', anchorCount: 5,    maxCount: 5,    ratePerResp: 1.80, packagePrice: 9    },
  { id: 'validate',   name: 'Validate',   anchorCount: 10,   maxCount: 10,   ratePerResp: 3.50, packagePrice: 35   },
  { id: 'confidence', name: 'Confidence', anchorCount: 50,   maxCount: 50,   ratePerResp: 1.98, packagePrice: 99   },
  { id: 'deep_dive',  name: 'Deep Dive',  anchorCount: 250,  maxCount: 250,  ratePerResp: 1.20, packagePrice: 299  },
  { id: 'scale',      name: 'Scale',      anchorCount: 1000, maxCount: 1000, ratePerResp: 0.90, packagePrice: 899  },
  { id: 'enterprise', name: 'Enterprise', anchorCount: 5000, maxCount: Infinity, ratePerResp: 0.40, packagePrice: 1990 },
];

/** Brand Lift — minimum statistical sample sizes (no Sniff Test / Validate). */
const BRAND_LIFT_TIERS = [
  { id: 'pulse',      name: 'Pulse',      anchorCount: 50,   maxCount: 50,   ratePerResp: 1.98, packagePrice: 99,   minRespondents: 50 },
  { id: 'tracker',    name: 'Tracker',    anchorCount: 200,  maxCount: 200,  ratePerResp: 1.50, packagePrice: 299,  minRespondents: 50 },
  { id: 'wave',       name: 'Wave',       anchorCount: 500,  maxCount: 500,  ratePerResp: 1.20, packagePrice: 599,  minRespondents: 50 },
  { id: 'enterprise', name: 'Enterprise', anchorCount: 2000, maxCount: Infinity, ratePerResp: 0.75, packagePrice: 1499, minRespondents: 50 },
];

/** Creative Attention — flat per-asset charges, not per-respondent. */
const CREATIVE_ATTENTION_TIERS = [
  { id: 'image',  name: 'Image',  assetCount: 1,  packagePrice: 19,  mediaType: 'image'  },
  { id: 'video',  name: 'Video',  assetCount: 1,  packagePrice: 39,  mediaType: 'video'  },
  { id: 'bundle', name: 'Bundle', assetCount: 5,  packagePrice: 79,  mediaType: 'bundle' },
  { id: 'series', name: 'Series', assetCount: 20, packagePrice: 249, mediaType: 'series' },
];

/**
 * Resolve the active tier ladder for a goal_type. Unrecognised goal types
 * fall back to the default volume ladder (so a new goal added to the UI
 * without backend awareness still gets a price).
 */
function getPricingForGoalType(goalType) {
  switch (goalType) {
    case 'brand_lift':         return BRAND_LIFT_TIERS;
    case 'creative_attention': return CREATIVE_ATTENTION_TIERS;
    default:                   return VOLUME_TIERS;
  }
}

/**
 * Resolve the tier object for a {goalType, respondentCount, mediaType}
 * combo. For Creative Attention the count is meaningless; mediaType picks
 * the tier directly.
 *
 * Returns one of the goal-specific tier objects, or null on invalid combo
 * (e.g. brand_lift with count < minRespondents). Validation callers should
 * surface the null as a 400 with a friendly message.
 */
function resolveTier({ goalType, respondentCount, mediaType }) {
  if (goalType === 'creative_attention') {
    const desiredId = mediaType || 'image';
    const tier = CREATIVE_ATTENTION_TIERS.find(t => t.id === desiredId)
              || CREATIVE_ATTENTION_TIERS.find(t => t.mediaType === desiredId);
    return tier || CREATIVE_ATTENTION_TIERS[0]; // fallback: image
  }
  const ladder = getPricingForGoalType(goalType);
  const c = Math.max(0, Number(respondentCount) || 0);
  if (goalType === 'brand_lift' && c < (ladder[0].minRespondents || 50)) {
    return null; // signal: brand_lift requires >= minRespondents
  }
  return ladder.find(t => c <= t.maxCount) || ladder[ladder.length - 1];
}

/**
 * Legacy helper kept for callers that haven't migrated to resolveTier.
 * Always returns a default-ladder tier (no goal_type awareness).
 */
function getVolumeTier(count) {
  const c = Math.max(0, Number(count) || 0);
  return VOLUME_TIERS.find(t => c <= t.maxCount) || VOLUME_TIERS[VOLUME_TIERS.length - 1];
}

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
  // Pass 23 Bug 23.61 fix — named destructured params (replacing the
  // `arguments[0]?.goalType` hack that broke callers who didn't know to
  // pass them). Defaults preserve existing behaviour for non-CA missions.
  goalType  = 'validate',
  mediaType = null,
} = {}) {
  // 1. Base rate via goal-type-aware tier resolution (Pass 23 Bug 23.51 + 23.61).
  // Validate / naming / marketing → respondent-count ladder (default).
  // Brand Lift → statistical-sample ladder (Pulse/Tracker/Wave/Enterprise).
  // Creative Attention → flat per-asset (Image/Video/Bundle/Series).
  const countryTier = resolveHighestTier(countries);
  const tier        = resolveTier({ goalType, respondentCount, mediaType });
  const isCreative  = goalType === 'creative_attention';
  const ratePerResp = isCreative ? null : (tier?.ratePerResp || VOLUME_TIERS[0].ratePerResp);
  // Creative Attention: flat package price, count irrelevant.
  // Other goals: rate × count. Tier null (brand_lift below minRespondents)
  // falls back to the cheapest in-ladder tier rate × count for safety;
  // route layer should reject the invalid combo BEFORE calling here.
  const base = isCreative
    ? (tier?.packagePrice || CREATIVE_ATTENTION_TIERS[0].packagePrice)
    : respondentCount * ratePerResp;
  const volumeTier = tier || (isCreative ? CREATIVE_ATTENTION_TIERS[0] : VOLUME_TIERS[0]);

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
    tier:         countryTier,                  // legacy alias = country tier
    countryTier,                                // new explicit name
    volumeTier:   { id: volumeTier.id, name: volumeTier.name, anchorCount: volumeTier.anchorCount, packagePrice: volumeTier.packagePrice },
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

/**
 * Pass 23 Bug 23.61 — fail-closed mission pricing validation.
 *
 * Returns { valid: true, tier } when the {goalType, mediaType,
 * respondentCount} combo is internally consistent for charging.
 * Returns { valid: false, error } with a user-friendly reason
 * otherwise. The route layer calls this BEFORE calculateMissionPrice
 * so we never accidentally charge a Sniff Test rate for a Creative
 * Attention asset (the original 23.61 forensic).
 *
 * Validation rules:
 *   - creative_attention REQUIRES mediaType in {image,video,bundle,series}.
 *     respondentCount is ignored.
 *   - brand_lift REQUIRES respondentCount >= 50 (the Pulse minimum).
 *   - validate / naming_messaging / marketing accept any
 *     respondentCount in [5, 5000].
 *   - Other goal_types fall back to the default ladder (lenient).
 */
function validateMissionPricing({ goalType, respondentCount, mediaType }) {
  if (goalType === 'creative_attention') {
    const validMedia = new Set(['image', 'video', 'bundle', 'series']);
    if (!mediaType || !validMedia.has(mediaType)) {
      return {
        valid: false,
        error: 'creative_attention missions require media_type in {image, video, bundle, series}',
      };
    }
    const tier = resolveTier({ goalType, mediaType });
    return { valid: true, tier };
  }
  if (goalType === 'brand_lift') {
    const c = Number(respondentCount) || 0;
    if (c < 50) {
      return {
        valid: false,
        error: 'brand_lift missions require at least 50 respondents (Pulse tier minimum)',
      };
    }
    return { valid: true, tier: resolveTier({ goalType, respondentCount: c }) };
  }
  // Default ladder — accept any positive count.
  const c = Number(respondentCount) || 0;
  if (c < 1) {
    return { valid: false, error: 'respondentCount must be >= 1' };
  }
  return { valid: true, tier: resolveTier({ goalType, respondentCount: c }) };
}

module.exports = {
  calculateMissionPrice,
  extractCountriesFromMission,
  // Goal-keyed tier ladders (Pass 23 Bug 23.51 — canonical)
  getPricingForGoalType,
  resolveTier,
  validateMissionPricing,
  VOLUME_TIERS,
  BRAND_LIFT_TIERS,
  CREATIVE_ATTENTION_TIERS,
  // Default-ladder helper kept for backwards compat
  getVolumeTier,
  // Country-tier (legacy, no longer affects price; retained for analytics)
  resolveHighestTier,
  getCountryTier,
  TIER_RATES,
  TIER_1,
  TIER_2,
};
