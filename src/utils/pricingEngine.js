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
  { id: 'deep_dive',  name: 'Deep Dive',  anchorCount: 250,  maxCount: 250,  ratePerResp: 1.20, packagePrice: 300  },
  { id: 'scale',      name: 'Scale',      anchorCount: 1000, maxCount: 1000, ratePerResp: 0.90, packagePrice: 900  },
  { id: 'enterprise', name: 'Enterprise', anchorCount: 5000, maxCount: Infinity, ratePerResp: 0.40, packagePrice: 2000 },
];

/** Brand Lift — minimum statistical sample sizes (no Sniff Test / Validate). */
const BRAND_LIFT_TIERS = [
  { id: 'pulse',      name: 'Pulse',      anchorCount: 50,   maxCount: 50,   ratePerResp: 1.98, packagePrice: 99,   minRespondents: 50 },
  { id: 'tracker',    name: 'Tracker',    anchorCount: 200,  maxCount: 200,  ratePerResp: 1.50, packagePrice: 300,  minRespondents: 50 },
  { id: 'wave',       name: 'Wave',       anchorCount: 500,  maxCount: 500,  ratePerResp: 1.20, packagePrice: 600,  minRespondents: 50 },
  { id: 'enterprise', name: 'Enterprise', anchorCount: 2000, maxCount: Infinity, ratePerResp: 0.75, packagePrice: 1500, minRespondents: 50 },
];

/**
 * Pass 25 Phase 0.3 — Creative Attention is now a respondent ladder.
 * 1-respondent missions yield no statistical signal; floor is 10. Per-
 * respondent rate is slightly higher than the validate ladder because
 * CA runs frame-by-frame Claude Vision per respondent (more compute).
 *   Sniff Test  10  $19   $1.90/resp
 *   Validate    25  $39   $1.56/resp
 *   Confidence  50  $69   $1.38/resp
 *   Deep Dive   100 $129  $1.29/resp
 *   Deep Dive XL 250 $299 $1.20/resp
 */
const CA_MIN_RESPONDENTS = 10;
const CREATIVE_ATTENTION_TIERS = [
  { id: 'sniff_test',   name: 'Sniff Test',   anchorCount: 10,  maxCount: 10,  ratePerResp: 1.90, packagePrice: 19,  minRespondents: CA_MIN_RESPONDENTS },
  { id: 'validate',     name: 'Validate',     anchorCount: 25,  maxCount: 25,  ratePerResp: 1.56, packagePrice: 39,  minRespondents: CA_MIN_RESPONDENTS },
  { id: 'confidence',   name: 'Confidence',   anchorCount: 50,  maxCount: 50,  ratePerResp: 1.38, packagePrice: 69,  minRespondents: CA_MIN_RESPONDENTS },
  { id: 'deep_dive',    name: 'Deep Dive',    anchorCount: 100, maxCount: 100, ratePerResp: 1.29, packagePrice: 129, minRespondents: CA_MIN_RESPONDENTS },
  { id: 'deep_dive_xl', name: 'Deep Dive XL', anchorCount: 250, maxCount: Infinity, ratePerResp: 1.20, packagePrice: 299, minRespondents: CA_MIN_RESPONDENTS },
];

// ── PRICING V2 — single canonical ladder (flag-gated) ───────────────────────
//
// One sample-size-anchored ladder for EVERY goal type (no goal-specific
// ladders). Goal type is a free choice within a tier, not a separate price.
// Prices are stored as AMOUNT-IN-CENTS (the single source of truth for both
// display via GET /api/pricing/tiers and the Stripe charge via
// calculateMissionPrice). The brand_lift / creative_attention >=100 sample
// requirement survives as a methodology RECOMMENDATION, not a price.
//
// Cutover is gated by PRICING_V2 (default OFF). When OFF, calculateMissionPrice
// and the tiers endpoint behave EXACTLY as the V1 ladders below — deploying this
// file changes nothing Stripe charges until the owner flips the flag.
const PRICING_V2_ACTIVE = process.env.PRICING_V2 === 'true' || process.env.PRICING_V2 === '1';

const CANONICAL_TIERS_V2 = [
  { id: 'sniff',      name: 'Sniff',      respondents: 5,    maxCount: 5,        priceCents: 900,   custom: false },
  { id: 'validate',   name: 'Validate',   respondents: 25,   maxCount: 25,       priceCents: 3900,  custom: false },
  { id: 'confidence', name: 'Confidence', respondents: 100,  maxCount: 100,      priceCents: 14900, custom: false },
  { id: 'scale',      name: 'Scale',      respondents: 500,  maxCount: 500,      priceCents: 49900, custom: false },
  { id: 'enterprise', name: 'Enterprise', respondents: 1500, maxCount: Infinity, priceCents: null,  custom: true  },
];

// A flat/fixed promo must never drive a charge to $0 or below (FRIEND10 = $10
// off a $9 order). Cap the flat discount so the total stays at or above this
// floor (comfortably above Stripe's $0.50 minimum charge). Percentage/free
// promos are owner-controlled and may still reach $0 intentionally.
const MIN_CHARGE_CENTS_AFTER_FLAT_DISCOUNT = 100; // $1.00

/** V2: resolve the canonical tier for a respondent count (bracket = first tier whose maxCount >= count). */
function resolveCanonicalTierV2(count) {
  const c = Math.max(0, Number(count) || 0);
  return CANONICAL_TIERS_V2.find((t) => c <= t.maxCount) || CANONICAL_TIERS_V2[CANONICAL_TIERS_V2.length - 1];
}

/**
 * The flag-aware tier table for the display surfaces (GET /api/pricing/tiers).
 * Shape is reusable: each entry carries id, name, respondents, priceCents,
 * priceUsd, fromLabel (e.g. "$9"), and custom — enough to drive a pricing
 * section AND per-card "from" prices without a second pricing path.
 * Returns { version, flagActive, startingFromCents, tiers }.
 */
function getActiveTierTable() {
  if (PRICING_V2_ACTIVE) {
    const tiers = CANONICAL_TIERS_V2.map((t) => ({
      id: t.id, name: t.name, respondents: t.respondents,
      priceCents: t.priceCents, priceUsd: t.priceCents == null ? null : t.priceCents / 100,
      fromLabel: t.priceCents == null ? 'Custom' : `$${t.priceCents / 100}`,
      custom: t.custom,
    }));
    const cheapest = tiers.find((t) => t.priceCents != null);
    return { version: 'v2', flagActive: true, startingFromCents: cheapest ? cheapest.priceCents : null, tiers };
  }
  // V1: project the live VOLUME_TIERS into the same shape.
  //
  // The displayed price is DERIVED by calling the same function the charge
  // path calls (respondentLadderBase), not read off the tier's packagePrice
  // literal. Reading the same module is not the same as reading the same
  // value: packagePrice was a hand-maintained second copy of the price and it
  // drifted, so this endpoint published $299/$899/$1990 while checkout
  // charged $300/$900/$2000 for the same three tiers. There is now one
  // expression, so a rate or bracket change moves display and charge together.
  const tiers = VOLUME_TIERS.map((t) => {
    // A tier whose anchor sits above the self-serve ceiling cannot be bought.
    // Publishing a price for it is the same defect as publishing a stale one:
    // the ladder would advertise something checkout refuses. Render it as a
    // custom quote instead, which is where the above-cap path already routes.
    if (t.anchorCount > MAX_SELF_SERVE_RESPONDENTS) {
      return {
        id: t.id, name: t.name, respondents: t.anchorCount,
        priceCents: null, priceUsd: null,
        fromLabel: 'Custom', custom: true,
      };
    }
    const priceUsd   = respondentLadderBase(VOLUME_TIERS, t, t.anchorCount, t.ratePerResp);
    const priceCents = Math.round(priceUsd * 100);
    return {
      id: t.id, name: t.name, respondents: t.anchorCount,
      priceCents, priceUsd,
      fromLabel: `$${formatUsd(priceUsd)}`, custom: false,
    };
  });
  const cheapest = tiers.find((t) => t.priceCents != null);
  return { version: 'v1', flagActive: false, startingFromCents: cheapest ? cheapest.priceCents : null, tiers };
}

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
  // Pass 25 Phase 0.3 — CA is now respondent-based like validate/brand_lift.
  // mediaType still tracked for the analysis pipeline but doesn't pick the
  // pricing tier any more.
  if (goalType === 'creative_attention') {
    const c = Math.max(0, Number(respondentCount) || 0);
    if (c < CA_MIN_RESPONDENTS) {
      return null; // signal: CA requires >= 10
    }
    return CREATIVE_ATTENTION_TIERS.find(t => c <= t.maxCount)
        || CREATIVE_ATTENTION_TIERS[CREATIVE_ATTENTION_TIERS.length - 1];
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

/**
 * ── V1 tier-boundary price inversion fix ────────────────────────────────────
 *
 * V1 prices the respondent ladders as a pure `count × tier.ratePerResp`. The
 * bracket rate DROPS at every tier boundary, so the total could go DOWN as the
 * respondent count went UP:
 *
 *   default ladder:  1,000 × $0.90 (Scale)      = $900.00
 *                    1,005 × $0.40 (Enterprise) = $402.00   ← $498.00 CHEAPER
 *                                                             for 5 MORE people
 *
 * That is reachable from the setup slider (min 5, max 5,000, step 5) by
 * dragging one notch to the right — not just via a hand-crafted API call.
 * Every boundary on the default AND brand-lift ladders inverted the same way.
 *
 * FIX (option (a) of the three weighed): floor each tier at the maximum price
 * payable in the tier BELOW it. Price is then monotonic non-decreasing in
 * respondent count, and — critically — no anchor/preset count gets more
 * expensive. The floor only lifts the "dip" band immediately after a boundary
 * back up to the boundary price it just fell off; the boundary counts
 * themselves (5/10/50/250/1,000/5,000 and 50/200/500/2,000) are untouched,
 * because within a tier `count × rate` is already increasing and reaches its
 * own ceiling exactly at maxCount.
 *
 * NOT option (b) ("charge the tier's packagePrice when count × rate falls
 * below it"): a tier's packagePrice is its price at the TOP of the tier
 * (e.g. Confidence = $99 at n=50), so flooring at it collapses the whole
 * bracket flat and would raise 11–49 respondents to $99. That raises real
 * purchase points; the previous-ceiling floor does not.
 *
 * Creative Attention is unaffected — it charges a flat packagePrice per tier
 * (19/39/69/129/299), which is already monotonic in count.
 *
 * PRICING_V2 is untouched by this: the V2 branch is a flat per-bracket package
 * price and never multiplies a rate by a count.
 */
const TIER_PRICE_FLOORS = new WeakMap();

/** Per-tier price floors for a ladder: floors[i] = max price payable in tiers < i. */
function getTierPriceFloors(ladder) {
  const cached = TIER_PRICE_FLOORS.get(ladder);
  if (cached) return cached;
  const floors = [];
  let running = 0;
  for (const t of ladder) {
    floors.push(running);
    // The open-ended top tier has maxCount Infinity and no ceiling to carry.
    if (Number.isFinite(t.maxCount) && typeof t.ratePerResp === 'number') {
      running = Math.max(running, t.maxCount * t.ratePerResp);
    }
  }
  TIER_PRICE_FLOORS.set(ladder, floors);
  return floors;
}

/** The price floor a given tier inherits from the tier below it (0 if unknown). */
function tierPriceFloor(ladder, tier) {
  if (!Array.isArray(ladder) || !tier) return 0;
  const idx = ladder.indexOf(tier);
  if (idx < 0) return 0;
  return getTierPriceFloors(ladder)[idx] || 0;
}

/**
 * Monotonic base price for a respondent-count ladder.
 * base(n) = max(n × tierRate, ceiling price of the tier below)
 * @param {Array}  ladder  the goal's tier ladder (VOLUME_TIERS / BRAND_LIFT_TIERS)
 * @param {Object} tier    the resolved tier object (may be null)
 * @param {number} count   respondent count
 * @param {number} rate    the per-respondent rate the caller resolved
 */
function respondentLadderBase(ladder, tier, count, rate) {
  const n = Math.max(0, Number(count) || 0);
  return round2(Math.max(n * rate, tierPriceFloor(ladder, tier)));
}

/**
 * Display helper for fromLabel. Whole dollars render bare with thousands
 * separators ("2,000"); fractional amounts keep 2dp. fromLabel is rendered
 * verbatim into the public /terms price table, so it has to read as money.
 * Deterministic on purpose — no toLocaleString, no host-locale dependency.
 */
function formatUsd(v) {
  const whole = Number.isInteger(v) ? String(v) : v.toFixed(2);
  const [int, frac] = whole.split('.');
  const grouped = int.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return frac ? `${grouped}.${frac}` : grouped;
}

/**
 * ── The 1,000-2,250 price plateau, and the linear bridge that closes it ─────
 *
 * The tier-floor fix above (PR #101) removed a $498 inversion by flooring the
 * Enterprise bracket at Scale's ceiling of $900. That left a FLAT price:
 *
 *   base(n) = max(n × $0.40, $900) = $900   for every n in [1,000 .. 2,250]
 *
 * $900 / $0.40 = 2,250, so 1,251 consecutive respondent counts all cost the
 * same. At the top of the plateau a 2,250-respondent study costs $0.40/resp —
 * the SAME marginal rate as a 5,000-respondent study, for less than half the
 * money. Monotonic, but not honest: the buyer who wants 2,250 is handed 1,250
 * respondents of free inventory, and the buyer who wants 1,050 pays for 2,250.
 *
 * FIX: interpolate linearly between the two PINNED anchors of the default
 * ladder instead of holding a floor.
 *
 *   base(n) = existing bracket price          n <= 1,000
 *           = 900 + (n - 1,000) × 0.275       1,000 < n <= 5,000
 *           = existing bracket price          n >  5,000
 *
 * $0.275 is not a chosen number — it is the ONLY marginal rate that lands on
 * both pinned anchors:
 *
 *   ($2,000 − $900) / (5,000 − 1,000) = $1,100 / 4,000 = $0.275
 *
 * so base(1,000) = $900 and base(5,000) = $2,000 are both unchanged, and the
 * bridge is strictly increasing in between. Every other anchor on the ladder
 * (5/$9, 10/$35, 50/$99, 100/$120, 250/$300) is outside the band and untouched.
 * Above 5,000 the Enterprise bracket resumes at n × $0.40, which is $2,000.40
 * at n = 5,001 — so the join is monotonic on both sides.
 *
 * SCOPE: the default (VOLUME_TIERS) ladder only. BRAND_LIFT_TIERS has its own
 * anchors and its own (smaller) plateau; CREATIVE_ATTENTION_TIERS is flat per
 * bracket and has no rate to interpolate. Neither is reachable above the
 * self-serve cap below, so neither is touched here.
 */
const BRIDGE_FROM_COUNT = 1000;   // Scale anchor — $900
const BRIDGE_TO_COUNT   = 5000;   // Enterprise anchor — $2,000
const BRIDGE_FROM_PRICE = 900;
const BRIDGE_TO_PRICE   = 2000;
/** ($2,000 − $900) / (5,000 − 1,000). Kept as a literal so the anchors are auditable. */
const BRIDGE_RATE_PER_RESP =
  (BRIDGE_TO_PRICE - BRIDGE_FROM_PRICE) / (BRIDGE_TO_COUNT - BRIDGE_FROM_COUNT); // 0.275

/**
 * ── The self-serve ceiling ──────────────────────────────────────────────────
 *
 * Measured, not guessed. Full derivation lives in the PR body; the short form:
 *
 *   Window   The only TOTAL-duration guarantee in the system is
 *            JOB1_STUCK_AFTER_HOURS = 6h (src/jobs/missionRecovery.js). Pass 49
 *            replaced the wall clock with a 45-min heartbeat-staleness gate for
 *            any run that checks in — which imposes no total-duration ceiling at
 *            all — so 6h is the number that actually bounds a run, and it is the
 *            rule that has governed every production mission to date (exactly 1
 *            row in production has ever had heartbeat_at set).
 *
 *   Rate     A PAID mission gets an ai_spend_ceiling_usd and therefore takes the
 *            recruit-loop path (shouldUseRecruitLoop). Measured from ai_calls +
 *            started_at/completed_at over the 11 loop-path completions with >= 10
 *            delivered: OLS marginal 11.86 s per delivered respondent; the two
 *            runs above n=10 bracket it at 10.92 s/resp (n=100) and 14.16 s/resp
 *            (n=50).
 *
 *   Ceiling  21,600 s / 14.16 s per respondent = 1,525 respondents at the WORST
 *            measured rate.
 *
 *   Margin   1,250 sits 18% under that, and finishes in 4.1h at the central rate.
 *            The margin is not decoration: (a) the largest mission ever DELIVERED
 *            in production is 100 respondents, so 1,250 is a 12.5x extrapolation;
 *            (b) both measured large runs had a 100% screener pass rate, while
 *            the loop is allowed up to MAX_PERSONAS_PER_TARGET = 20 personas per
 *            qualified respondent, so a real screener multiplies the wall clock;
 *            (c) synthesis cost grows with n, so a per-respondent rate measured
 *            at n=100 understates n=1,250.
 *
 * Above the cap we CAPTURE THE LEAD, we do not sell: calculateMissionPrice still
 * returns a real (bridged) base so nothing downstream divides by zero, but flags
 * customQuote — which the existing fail-closed guards in routes/payments.js and
 * routes/pricing.js already turn into "contact sales" without a charge.
 */
const MAX_SELF_SERVE_RESPONDENTS = Number(process.env.MAX_SELF_SERVE_RESPONDENTS || 1250);

/** Where a customer above the cap is sent. Consumed by the route error payloads. */
const SELF_SERVE_LEAD_CAPTURE = {
  endpoint: '/api/crm/lead',   // public, rate-limited (5/hour/IP), dedupes on email
  cta: 'Request a quote',      // exactly what MissionControlPricing sends as `cta`
  page: 'mission_control_pricing',
  message: 'Studies above this size are run as a managed engagement — leave an email and we will scope it with you.',
};

/**
 * Base price for the DEFAULT ladder inside the bridge band, or null when the
 * count is outside it (caller falls back to respondentLadderBase).
 */
function defaultLadderBridgeBase(count) {
  const n = Math.max(0, Number(count) || 0);
  if (n <= BRIDGE_FROM_COUNT || n > BRIDGE_TO_COUNT) return null;
  return round2(BRIDGE_FROM_PRICE + (n - BRIDGE_FROM_COUNT) * BRIDGE_RATE_PER_RESP);
}

/**
 * Monotonic base for a respondent ladder, with the default ladder's
 * 1,000 -> 5,000 plateau bridged. Every other ladder is unchanged.
 */
function bridgedRespondentBase(ladder, tier, count, rate) {
  if (ladder === VOLUME_TIERS) {
    const bridged = defaultLadderBridgeBase(count);
    if (bridged != null) return bridged;
  }
  return respondentLadderBase(ladder, tier, count, rate);
}

/** True when a respondent count is beyond what the pipeline can honestly deliver. */
function isAboveSelfServeCap(count) {
  return (Math.max(0, Number(count) || 0)) > MAX_SELF_SERVE_RESPONDENTS;
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
  // PRICING V2 (flag on): ONE canonical package ladder for every goal type.
  // base = the bracket's flat package price (count picks the bracket). Surcharges
  // below (questions/targeting/screening) still apply on top. Enterprise (beyond
  // the Scale tier's 500) is a custom quote — flagged so the route blocks
  // self-serve checkout. ratePerResp is null in V2 (flat pricing, not per-resp)
  // so callers/breakdowns never multiply a stale V1 rate against a flat total.
  // V1 (flag off): byte-identical to before (rate×count, or CA flat package).
  let base, volumeTier, ratePerResp, customQuote = false;
  if (PRICING_V2_ACTIVE) {
    const v2 = resolveCanonicalTierV2(respondentCount);
    customQuote = v2.custom;
    base = v2.custom ? 0 : v2.priceCents / 100;
    ratePerResp = null;
    volumeTier = { id: v2.id, name: v2.name, anchorCount: v2.respondents, packagePrice: v2.custom ? null : v2.priceCents / 100 };
  } else {
    // Creative Attention: flat package price, count irrelevant.
    // Other goals: rate × count. Tier null (brand_lift below minRespondents)
    // falls back to the cheapest in-ladder tier rate × count for safety;
    // route layer should reject the invalid combo BEFORE calling here.
    ratePerResp = isCreative ? null : (tier?.ratePerResp || VOLUME_TIERS[0].ratePerResp);
    base = isCreative
      ? (tier?.packagePrice || CREATIVE_ATTENTION_TIERS[0].packagePrice)
      // Monotonic: never cheaper than the top of the tier below (see
      // respondentLadderBase — V1 tier-boundary inversion fix).
      // Monotonic AND plateau-free: the default ladder interpolates between
      // its $900/$2,000 anchors across 1,000 < n <= 5,000 (see
      // bridgedRespondentBase); every other ladder keeps the tier floor.
      : bridgedRespondentBase(getPricingForGoalType(goalType), tier, respondentCount, ratePerResp);
    volumeTier = tier || (isCreative ? CREATIVE_ATTENTION_TIERS[0] : VOLUME_TIERS[0]);
    // Above the self-serve cap the price is still computed (so breakdowns and
    // logs stay sane) but is NOT sellable. routes/payments.js and
    // routes/pricing.js already fail closed on customQuote.
    customQuote = isAboveSelfServeCap(respondentCount);
  }

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
      if (PRICING_V2_ACTIVE) {
        // Min-order clamp — PRICING_V2 money path ONLY, so deploying with the
        // flag off is byte-identical to today. A flat promo can never drive the
        // charge to $0 or below: cap the discount so the total stays >= the
        // floor ($1.00, above Stripe's $0.50 min). FRIEND10 ($10) on a $9 order
        // yields a $1 charge, not $0. Percentage/free promos are owner-controlled
        // and may still reach $0 intentionally.
        const minCharge = MIN_CHARGE_CENTS_AFTER_FLAT_DISCOUNT / 100;
        const maxFlatDiscount = Math.max(0, subtotal - minCharge);
        discount = round2(Math.min(promoCode.value, maxFlatDiscount));
      } else {
        // V1 (flag off): UNCHANGED. Flat discount caps at the subtotal and may
        // reach $0 — the checkout route then rejects it under the $0.50 minimum,
        // exactly as in production today. The clamp above rides the V2 cutover.
        discount = round2(Math.min(promoCode.value, subtotal));
      }
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
    customQuote,  // true above MAX_SELF_SERVE_RESPONDENTS (V1) or in the V2 Enterprise tier — routes block self-serve checkout
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
 *   - creative_attention REQUIRES mediaType in {image,video,bundle,series}
 *     AND respondentCount >= CA_MIN_RESPONDENTS. (This comment used to say
 *     respondentCount is ignored - it was stale from before Pass 25 Phase 0.3
 *     moved CA onto a respondent ladder, and it is what made the missing
 *     argument below look intentional.)
 *   - brand_lift REQUIRES respondentCount >= 50 (the Pulse minimum).
 *   - validate / naming_messaging / marketing accept any
 *     respondentCount in [5, 5000].
 *   - Other goal_types fall back to the default ladder (lenient).
 */
function validateMissionPricing({ goalType, respondentCount, mediaType }) {
  // PRICING V2 (flag on): one canonical ladder for every goal type. The only
  // hard price gate is the Enterprise/custom tier (500+ respondents) — block
  // self-serve checkout so a large mission never charges the $0 base. The
  // brand_lift/creative_attention sample minimums survive only as setup
  // recommendations, not price gates. (creative_attention still needs a media
  // type for its analysis pipeline.)
  if (PRICING_V2_ACTIVE) {
    if (goalType === 'creative_attention') {
      const validMedia = new Set(['image', 'video', 'bundle', 'series']);
      if (!mediaType || !validMedia.has(mediaType)) {
        return { valid: false, error: 'creative_attention missions require media_type in {image, video, bundle, series}' };
      }
    }
    const c = Number(respondentCount) || 0;
    if (c < 1) return { valid: false, error: 'respondentCount must be >= 1' };
    const tier = resolveCanonicalTierV2(c);
    if (tier.custom) {
      return { valid: false, error: 'Studies beyond 500 respondents require a custom quote, please contact sales.' };
    }
    return { valid: true, tier };
  }
  // V1 self-serve ceiling — goal-agnostic, because the constraint is DELIVERY
  // (wall-clock inside the 6h recovery backstop at the measured recruit-loop
  // rate), not the price ladder. Fires before any goal-specific gate so a
  // 3,000-respondent Creative Attention mission is refused for the same reason
  // a 3,000-respondent validate mission is.
  if (isAboveSelfServeCap(respondentCount)) {
    return {
      valid: false,
      error: `Studies above ${MAX_SELF_SERVE_RESPONDENTS.toLocaleString('en-US')} respondents are run as a managed engagement, not self-serve — please contact sales.`,
      leadCapture: SELF_SERVE_LEAD_CAPTURE,
    };
  }
  if (goalType === 'creative_attention') {
    const validMedia = new Set(['image', 'video', 'bundle', 'series']);
    if (!mediaType || !validMedia.has(mediaType)) {
      return {
        valid: false,
        error: 'creative_attention missions require media_type in {image, video, bundle, series}',
      };
    }
    const c = Number(respondentCount) || 0;
    // resolveTier needs the COUNT. Without it the argument arrives as
    // undefined, coerces to 0, trips 0 < CA_MIN_RESPONDENTS and returns null -
    // the documented "invalid combo" signal - for EVERY creative_attention
    // mission, legal ones included. The old code then returned valid: true
    // with that null attached, so two things were wrong at once: the CA floor
    // of 10 was never enforced at checkout, and no caller ever received a real
    // CA tier from this function.
    const tier = resolveTier({ goalType, respondentCount: c, mediaType });
    if (!tier) {
      return {
        valid: false,
        error: `creative_attention missions require at least ${CA_MIN_RESPONDENTS} respondents`,
      };
    }
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

// ── Pass 27 — Brand Lift uplift tiers (market + channel) ──────────
const MARKET_UPLIFT_TIERS = [
  { min: 1,  max: 1,        name: 'single_market',  upliftUSD: 0   },
  { min: 2,  max: 3,        name: 'small_multi',    upliftUSD: 10  },
  { min: 4,  max: 7,        name: 'regional',       upliftUSD: 25  },
  { min: 8,  max: 15,       name: 'multi_regional', upliftUSD: 50  },
  { min: 16, max: Infinity, name: 'global',         upliftUSD: 100 },
];

const CHANNEL_UPLIFT_TIERS = [
  { min: 1,   max: 10,       name: 'starter',    upliftUSD: 0  },
  { min: 11,  max: 25,       name: 'standard',   upliftUSD: 10 },
  { min: 26,  max: 50,       name: 'plus',       upliftUSD: 20 },
  { min: 51,  max: 100,      name: 'pro',        upliftUSD: 35 },
  { min: 101, max: Infinity, name: 'enterprise', upliftUSD: 50 },
];

function calculateMarketUplift(count) {
  const c = Math.max(0, Math.floor(Number(count) || 0));
  if (c === 0) return 0;
  return (MARKET_UPLIFT_TIERS.find(t => c >= t.min && c <= t.max) || {}).upliftUSD || 0;
}

function calculateChannelUplift(count) {
  const c = Math.max(0, Math.floor(Number(count) || 0));
  if (c === 0) return 0;
  return (CHANNEL_UPLIFT_TIERS.find(t => c >= t.min && c <= t.max) || {}).upliftUSD || 0;
}

/**
 * Compute the Brand Lift price breakdown.
 *
 * @param {object} input
 * @param {number} input.respondentBaseUSD
 * @param {number} input.marketCount
 * @param {number} input.channelCount
 * @returns {object} { base, market_uplift_usd, channel_uplift_usd,
 *   total_usd, market_count, channel_count, ladder_version }
 */
function calculateBrandLiftMissionPrice({ respondentBaseUSD, marketCount, channelCount }) {
  const base = Math.max(0, Number(respondentBaseUSD) || 0);
  const marketUplift = calculateMarketUplift(marketCount);
  const channelUplift = calculateChannelUplift(channelCount);
  const total = base + marketUplift + channelUplift;
  return {
    base_usd: base,
    market_uplift_usd: marketUplift,
    channel_uplift_usd: channelUplift,
    total_usd: total,
    market_count: Number(marketCount) || 0,
    channel_count: Number(channelCount) || 0,
    ladder_version: 'pass_27_v1',
  };
}

module.exports = {
  MARKET_UPLIFT_TIERS,
  CHANNEL_UPLIFT_TIERS,
  calculateMarketUplift,
  calculateChannelUplift,
  calculateBrandLiftMissionPrice,
  calculateMissionPrice,
  extractCountriesFromMission,
  // Goal-keyed tier ladders (Pass 23 Bug 23.51 — canonical)
  getPricingForGoalType,
  resolveTier,
  validateMissionPricing,
  VOLUME_TIERS,
  BRAND_LIFT_TIERS,
  CREATIVE_ATTENTION_TIERS,
  CA_MIN_RESPONDENTS,
  // Pricing V2 (flag-gated single canonical ladder)
  PRICING_V2_ACTIVE,
  CANONICAL_TIERS_V2,
  MIN_CHARGE_CENTS_AFTER_FLAT_DISCOUNT,
  resolveCanonicalTierV2,
  getActiveTierTable,
  // Default-ladder helper kept for backwards compat
  getVolumeTier,
  // V1 monotonicity helpers (tier-boundary price inversion fix)
  tierPriceFloor,
  respondentLadderBase,
  // Plateau bridge + self-serve ceiling
  bridgedRespondentBase,
  defaultLadderBridgeBase,
  isAboveSelfServeCap,
  MAX_SELF_SERVE_RESPONDENTS,
  SELF_SERVE_LEAD_CAPTURE,
  BRIDGE_FROM_COUNT,
  BRIDGE_TO_COUNT,
  BRIDGE_RATE_PER_RESP,
  // Country-tier (legacy, no longer affects price; retained for analytics)
  resolveHighestTier,
  getCountryTier,
  TIER_RATES,
  TIER_1,
  TIER_2,
};
