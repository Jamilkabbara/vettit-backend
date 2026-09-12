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
 * DO NOT QUOTE PRICES FROM THIS HEADER. The ladders below are the only
 * numbers that bill. This header carried the 2026-04 four-package ladder
 * (5/$9, 10/$35, 50/$99, 250/$299) and "$20 per extra question beyond the
 * first 5" for months after the 2026-09 reprice replaced both, so anyone who
 * read the top of the file and stopped got figures Stripe had never charged.
 * The live numbers live at VOLUME_TIERS, BRAND_LIFT_TIERS,
 * CREATIVE_ATTENTION_PRICES, EXTRA_QUESTION_PRICE and FREE_QUESTIONS, each
 * with its own comment. GET /api/pricing/tiers projects the default ladder
 * for any display surface that needs it.
 *
 * Bracket pricing applies the rate of the tier the count falls in, floored so
 * a count is never cheaper than the top of the tier below it - see
 * respondentLadderBase for the inversion that floor fixes.
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

// ── Geography does not affect any price ───────────────────────────
//
// Pass 23 Bug 23.PRICING retired country-tier pricing on 2026-04-28 and
// nothing replaced it. A country-tier registry (TIER_1, TIER_2, TIER_RATES)
// and the two functions that read it (getCountryTier, resolveHighestTier)
// survived that reprice for five months, feeding nothing but two
// informational fields on the breakdown, `tier` and `countryTier`.
//
// DELETED 2026-09-13. A consumer audit across both repos (#164) found zero
// readers: not a route, not the frontend, not an export, not admin, not
// analytics, and nothing persisted them - price_breakdown on missions stores
// the brand-lift uplift object, not this breakdown. The re-audit before the
// deletion confirmed it. The only thing keeping the registry alive was the
// comment claiming callers depended on it.
//
// `countries` is still an INPUT and is still echoed back on the breakdown,
// because callers pass the geography they targeted and a log line can want it.
// It is multiplied by nothing. The same ten countries cost the same as one;
// US costs the same as SD. pricing.test.js pins that with an explicit
// geography-does-not-price test, which outlives the deleted fields.
//
// If geography should price, that is a PRODUCT decision and it starts with a
// rate table someone chooses on purpose, not with reviving a 2026-04 one.

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

/**
 * Default volume ladder — used by validate, naming_messaging, marketing, and
 * every goal not named in getPricingForGoalType.
 *
 * ── The 2026-09 reprice: round prices first, rates derived ──────────────────
 *
 * The old ladder was built rate-first and the anchor prices fell out of it.
 * That produced a rate curve that was not monotone:
 *
 *     n=5    $1.80/resp      n=10   $3.50/resp      n=50   $1.98/resp
 *
 * A customer who moved the slider from 5 to 10 paid $9 -> $35, and their
 * per-respondent rate nearly DOUBLED, then halved again by n=50. $3.50 was not
 * a decision about what ten respondents are worth; it was the number that made
 * 10 x rate land on $35. Every price between the anchors was whatever the
 * multiplication produced.
 *
 * This ladder inverts the construction. The price at each anchor is chosen
 * first, as a number a customer can read, and ratePerResp is DERIVED as
 * price / anchorCount:
 *
 *   |  up to  |  price  |  derived rate  |
 *   |       5 |      $9 |    9 /    5 = 1.8000 |
 *   |      25 |     $39 |   39 /   25 = 1.5600 |
 *   |     100 |    $149 |  149 /  100 = 1.4900 |
 *   |     250 |    $299 |  299 /  250 = 1.1960 |
 *   |     500 |    $499 |  499 /  500 = 0.9980 |
 *   |   1,000 |    $899 |  899 / 1000 = 0.8990 |
 *   |   1,250 |  $1,099 | 1099 / 1250 = 0.8792 |
 *
 * The rate is now monotone DECREASING across the whole ladder, which is what
 * "buying more is cheaper per unit" is supposed to mean, and every anchor
 * renders as a round price without a second hand-maintained copy of it.
 * packagePrice is kept ONLY as documentation of the anchor that generated the
 * rate — respondentLadderBase and getActiveTierTable both compute from
 * ratePerResp, so the two can never drift.
 *
 * WHAT THIS COSTS. Removing the $3.50 spike makes n=10 cost $15.60 instead of
 * $35, and n=50 cost $74.50 instead of $99. Against the 23 charged missions in
 * production at the time of the change (all of them n=1, 5 or 10) this ladder
 * bills 42.6% less. That is not an accident of the reprice, it IS the reprice:
 * n=10 at $35 was the single most-bought price point and it was also the one
 * charging double the surrounding rate. The ladder gets more expensive than
 * today from n=75 upward, which is the range the un-gated methodologies sell
 * into.
 *
 * THE TOP BRACKET IS OPEN-ENDED ON PURPOSE. Its anchor, 1,250, is
 * MAX_SELF_SERVE_RESPONDENTS — the last count that is actually sellable. Above
 * that, isAboveSelfServeCap flags customQuote and the routes capture a lead
 * instead of charging. Leaving maxCount at Infinity means that if the cap is
 * ever raised by env, price keeps rising at $0.8792/resp rather than flattening
 * into a plateau. That is what retired the old 1,000 -> 5,000 linear bridge:
 * the bridge existed to close a flat $900 band that this ladder cannot form.
 */
const VOLUME_TIERS = [
  { id: 'sniff_test', name: 'Sniff Test', anchorCount: 5,    maxCount: 5,    ratePerResp: 9    / 5,    packagePrice: 9    },
  { id: 'validate',   name: 'Validate',   anchorCount: 25,   maxCount: 25,   ratePerResp: 39   / 25,   packagePrice: 39   },
  { id: 'confidence', name: 'Confidence', anchorCount: 100,  maxCount: 100,  ratePerResp: 149  / 100,  packagePrice: 149  },
  { id: 'deep_dive',  name: 'Deep Dive',  anchorCount: 250,  maxCount: 250,  ratePerResp: 299  / 250,  packagePrice: 299  },
  { id: 'scale',      name: 'Scale',      anchorCount: 500,  maxCount: 500,  ratePerResp: 499  / 500,  packagePrice: 499  },
  { id: 'growth',     name: 'Growth',     anchorCount: 1000, maxCount: 1000, ratePerResp: 899  / 1000, packagePrice: 899  },
  { id: 'enterprise', name: 'Enterprise', anchorCount: 1250, maxCount: Infinity, ratePerResp: 1099 / 1250, packagePrice: 1099 },
];

/**
 * The brand-lift respondent floor, in ONE place.
 *
 * It used to be written four times as a literal 50 on the tiers below, once
 * more as `ladder[0].minRespondents || 50` in resolveTier, and once more as a
 * bare `c < 50` in validateMissionPricing. Six copies of a number nobody could
 * change in one edit.
 *
 * RECONCILED AT 100 (owner decision). The product told users two different
 * numbers: this constant said 50, while src/lib/sampleSizeMinimums.ts in the
 * frontend says >= 100. 100 is now the single number.
 *
 * The power analysis, because the number alone is misleading. Brand lift is a
 * two-proportion comparison across an exposed/control split, so n splits into
 * two cells and the minimum detectable effect at 80% power, two-sided
 * alpha 0.05, worst case p=0.5, is:
 *
 *     MDE = (z_0.975 + z_0.80) * sqrt(2*p*(1-p) / n_per_cell)
 *         = 2.8016 * sqrt(0.5 / n_per_cell)
 *
 *     n=50   (25/cell)  ->  39.6 pp
 *     n=100  (50/cell)  ->  28.0 pp   <- this floor
 *     n=800  (400/cell) ->   9.9 pp
 *     n=1250 (625/cell) ->   7.9 pp   <- the self-serve ceiling
 *
 * Real brand-lift effects run 2-10 pp. Detecting 10 pp needs n=786; 5 pp needs
 * n=3,140. So NEITHER 50 nor 100 confers adequate power, and no floor can fix
 * that - even at the 1,250 ceiling the best attainable MDE is 7.9 pp. 100 is
 * the less indefensible number and the one already published to users; the
 * honest move is to state the MDE alongside the result rather than let a floor
 * imply a validity it does not deliver. brandLiftMDE() below does that.
 *
 * Accepted cost: a $99 study that cannot support its own methodology is not
 * worth selling, so the floor stands. Pulse was MOVED to the floor rather than
 * deleted - see BRAND_LIFT_TIERS below for why it now anchors at 100/$150.
 */
const BRAND_LIFT_MIN_RESPONDENTS = 100;

/**
 * Minimum detectable effect, in percentage points, for a brand-lift study of
 * `n` total respondents split evenly across exposed and control. Surfaced on
 * the results page and in exports so the number carries its own limit.
 * Returns null for a non-positive n.
 */
function brandLiftMDE(n) {
  const total = Number(n);
  if (!Number.isFinite(total) || total <= 0) return null;
  const perCell = total / 2;
  if (perCell <= 0) return null;
  // 2.8016 = z(0.975) + z(0.80); p = 0.5 is the worst case (max variance).
  return Math.round(2.801585 * Math.sqrt(0.5 / perCell) * 1000) / 10;
}

/**
 * Brand Lift - minimum statistical sample sizes (no Sniff Test / Validate).
 *
 * ── Pulse moved from 50 to 100, 2026-09-13 ─────────────────────────────────
 *
 * Pulse anchored at 50 with maxCount 50, which put the WHOLE tier below the
 * 100-respondent floor this ladder enforces (and below the NOT VALID CHECK
 * constraint missions_brand_lift_respondent_floor_chk). resolveTier refuses
 * anything under 100 outright, so no count could ever resolve to Pulse: it was
 * a tier on the ladder, on the landing page's data and in the setup panel's
 * default state, that could not be bought. Worse, the setup panel DEFAULTED a
 * new brand-lift study to BRAND_LIFT_TIERS[0].anchorCount, i.e. 50, a count
 * the backend and the database both reject.
 *
 * Owner decision: move the anchor to 100 so the tier is buyable. The three
 * other numbers follow from constraints, not from preference:
 *
 *   maxCount 100    The tier has to COVER 100 to be reachable, and Tracker
 *                   owns 200. Pulse taking (floor, 100] and Tracker (100, 200]
 *                   leaves no gap and no overlap. Since the floor IS 100, Pulse
 *                   is exactly the entry study - which is what "Pulse" means.
 *
 *   ratePerResp     1.50, the SAME rate as Tracker, and this is the honest
 *                   number rather than the flattering one. Rate must not RISE
 *                   with volume (that spike is exactly what the 2026-09 default
 *                   reprice removed), so Pulse's rate cannot be below Tracker's
 *                   1.50. Nor should it be above: 1.98 would price 100
 *                   respondents at $198, RAISING the cheapest brand-lift study
 *                   from the $150 it costs today. Equal rates it is.
 *
 *   packagePrice    150 = 100 x 1.50. It is documentation of the anchor, and
 *                   the derived rate, in the same relationship the default
 *                   ladder uses. STARTING_PRICE_BRAND_LIFT_USD in the frontend
 *                   reads this field, so it was publishing "from $99" for a
 *                   study that has cost $150 since the floor moved.
 *
 * NO PRICE MOVES. Today 100/150/199 all fall to Tracker and cost $150.00 /
 * $225.00 / $298.50. After this change 100 falls to Pulse and 150/199 still
 * fall to Tracker, at $150.00 / $225.00 / $298.50 - identical, because the
 * rates are equal and the tier floor (100 x 1.50 = 150) never binds against
 * Tracker's own minimum (101 x 1.50 = 151.50). What changes is that the tier
 * RESOLVES: n=100 now stamps `pulse` on missions.tier instead of `tracker`,
 * the landing ladder can show it, and the setup panel's default count is legal.
 */
const BRAND_LIFT_TIERS = [
  { id: 'pulse',      name: 'Pulse',      anchorCount: 100,  maxCount: 100,  ratePerResp: 1.50, packagePrice: 150,  minRespondents: BRAND_LIFT_MIN_RESPONDENTS },
  { id: 'tracker',    name: 'Tracker',    anchorCount: 200,  maxCount: 200,  ratePerResp: 1.50, packagePrice: 300,  minRespondents: BRAND_LIFT_MIN_RESPONDENTS },
  { id: 'wave',       name: 'Wave',       anchorCount: 500,  maxCount: 500,  ratePerResp: 1.20, packagePrice: 600,  minRespondents: BRAND_LIFT_MIN_RESPONDENTS },
  { id: 'enterprise', name: 'Enterprise', anchorCount: 2000, maxCount: Infinity, ratePerResp: 0.75, packagePrice: 1500, minRespondents: BRAND_LIFT_MIN_RESPONDENTS },
];

/**
 * ── Creative Attention prices per CREATIVE, not per respondent ─────────────
 *
 * It used to charge a respondent ladder: 10/$19, 25/$39, 50/$69, 100/$129,
 * 250+/$299. That ladder was wrong in a way no reprice could fix, because it
 * priced by a quantity the product does not have.
 *
 * The analysis NEVER reads respondent_count - verified by grep across
 * services/ai/creativeAttention.js, which has zero references to it - and the
 * results page never mentions respondents. A Creative Attention mission
 * produces no respondents and no response rows: it downloads one creative,
 * samples frames from it, and scores them. So a customer paying $299 for "250
 * respondents" received byte-identical work to one paying $19 for "10": the
 * same video, the same 30 frames, the same report. Fifteen times the money for
 * the same thing, labelled with a number that does not exist.
 *
 * COST DRIVES PER CREATIVE, AND IT IS BOUNDED. Measured on production:
 *
 *   image   3 vision calls          $0.028 - $0.063   (six completed missions)
 *   video   30 frames + synthesis    $0.476            (mission cff8a2ec)
 *
 * Video is 7.5x an image, not because it is longer but because the extractor
 * samples one frame per second and stops at 30. A 35-second and a ten-minute
 * video cost the same. So there is no long-video tail to price against.
 *
 * THE PRICES ARE CHOSEN, NOT DERIVED. $19 keeps the entry price customers
 * already see advertised. $49 says the harder analysis costs more without
 * pretending the ratio should track cost - 11x cost would be an $209 video,
 * which is not what a frame-by-frame attention read is worth to a buyer.
 * Margin is 99.7% and 99.0%, so margin is not the constraint and should not be
 * the author.
 *
 * NO VOLUME TIERS. A mission takes exactly one creative today: the form holds
 * a single file and analyzeCreative downloads one attachment with no loop over
 * assets. Someone testing five videos creates five missions. A bundle price is
 * the right conversation when multi-creative actually exists.
 */
const CREATIVE_ATTENTION_PRICES = Object.freeze({
  image: 19,
  video: 49,
});

/**
 * Creative Attention's respondent floor.
 *
 * Retained ONLY because a NOT VALID CHECK constraint on missions enforces
 * respondent_count >= 10 for this goal type, and Postgres re-checks a NOT VALID
 * constraint on any subsequent update to the row - including updates that touch
 * unrelated columns. Dropping the number from the product without dropping the
 * constraint would make every Creative Attention row unwritable.
 *
 * It is no longer a customer-facing input. The setup form does not ask for it
 * and nothing downstream reads it.
 */
const CA_MIN_RESPONDENTS = 10;

/** The count written on a CA mission so the CHECK constraint is satisfied. */
const CA_FIXED_RESPONDENT_COUNT = CA_MIN_RESPONDENTS;

/**
 * Legacy shape, kept so the /terms table, the landing ladder and any stored
 * breakdown that names a CA tier keep resolving. Both entries carry the flat
 * per-creative price; anchorCount is the constraint floor, not a choice a
 * customer makes.
 */
const CREATIVE_ATTENTION_TIERS = [
  { id: 'image', name: 'Image',  anchorCount: CA_FIXED_RESPONDENT_COUNT, maxCount: Infinity, ratePerResp: null, packagePrice: CREATIVE_ATTENTION_PRICES.image, minRespondents: CA_MIN_RESPONDENTS },
  { id: 'video', name: 'Video',  anchorCount: CA_FIXED_RESPONDENT_COUNT, maxCount: Infinity, ratePerResp: null, packagePrice: CREATIVE_ATTENTION_PRICES.video, minRespondents: CA_MIN_RESPONDENTS },
];

/** The flat price for a creative of this media type. Video and image only. */
function creativeAttentionPrice(mediaType) {
  const m = String(mediaType || '').toLowerCase();
  if (m === 'video') return CREATIVE_ATTENTION_PRICES.video;
  // image, bundle and series all analyse as stills today.
  return CREATIVE_ATTENTION_PRICES.image;
}
/**
 * ── PRICING_V2 was deleted 2026-09 ─────────────────────────────────────────
 *
 * It was a second, flag-gated canonical ladder (5/$9, 25/$39, 100/$149,
 * 500/$499, then a custom-quote wall at 500) that never ran in production:
 * PRICING_V2 was false on every deploy of its life. Two ladders meant every
 * pricing change had to be made twice and reasoned about twice, and the flag
 * had already coupled things that are not prices to itself — the brand_lift
 * and creative_attention sample floors and the self-serve delivery ceiling all
 * sat below its early return, so flipping a PRICING flag would have switched
 * off three METHODOLOGY gates. That coupling was removed first (the floors now
 * run unconditionally); this removes the flag itself.
 *
 * Its round numbers were not thrown away. The 5/$9, 25/$39, 100/$149 and
 * 500/$499 brackets are exactly the anchors VOLUME_TIERS now carries, which is
 * what the reprice above means by "round prices first": V2 had already picked
 * them, it simply picked them in a branch nobody could reach.
 *
 * One V2-only behaviour was KEPT rather than deleted, and it is a live
 * behaviour change: the flat-promo minimum-charge clamp below. See
 * MIN_CHARGE_CENTS_AFTER_FLAT_DISCOUNT.
 */

/**
 * A flat/fixed promo must never drive a charge to $0 or below (FRIEND10 = $10
 * off a $9 order). Cap the flat discount so the total stays at or above this
 * floor, comfortably above Stripe's $0.50 minimum charge. Percentage and free
 * promos are owner-controlled and may still reach $0 intentionally.
 *
 * BEHAVIOUR CHANGE. Until the V2 deletion this clamp only applied when
 * PRICING_V2 was on, i.e. never. In production a $10 flat promo on a $9 order
 * produced a $0 total, and checkout then REFUSED the order under Stripe's
 * minimum — the customer could not buy at all, and the promo looked broken.
 * Deleting the flag forced a choice between the two branches and this is the
 * one that lets the sale complete, so it is now unconditional.
 */
const MIN_CHARGE_CENTS_AFTER_FLAT_DISCOUNT = 100; // $1.00

/**
 * The flag-aware tier table for the display surfaces (GET /api/pricing/tiers).
 * Shape is reusable: each entry carries id, name, respondents, priceCents,
 * priceUsd, fromLabel (e.g. "$9"), and custom — enough to drive a pricing
 * section AND per-card "from" prices without a second pricing path.
 * Returns { version, flagActive, startingFromCents, tiers }.
 */
function getActiveTierTable() {
  // Project the live VOLUME_TIERS into the published shape.
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
    // Priced per creative. respondentCount is still floor-checked because the
    // database CHECK constraint requires it, but it does not pick the tier -
    // the media type does.
    const c = Math.max(0, Number(respondentCount) || 0);
    if (c < CA_MIN_RESPONDENTS) {
      return null; // signal: the row would violate the CHECK constraint
    }
    const isVideo = String(mediaType || '').toLowerCase() === 'video';
    return CREATIVE_ATTENTION_TIERS.find(t => t.id === (isVideo ? 'video' : 'image'));
  }
  const ladder = getPricingForGoalType(goalType);
  const c = Math.max(0, Number(respondentCount) || 0);
  if (goalType === 'brand_lift' && c < (ladder[0].minRespondents || BRAND_LIFT_MIN_RESPONDENTS)) {
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
 * Render a per-respondent rate so that `count x rate` visibly reconciles with
 * the base it produced.
 *
 * The reprice derives rates from round anchor prices, so four of the seven are
 * not two-decimal numbers: 299/250 = 1.196, 499/500 = 0.998, 899/1000 = 0.899,
 * 1099/1250 = 0.8792. `toFixed(2)` renders those as $1.20, $1.00, $0.90 and
 * $0.88, and the checkout breakdown then reads "500 respondents x $1.00 =
 * $499" — an arithmetic error on the customer's receipt, introduced purely by
 * rounding the label. Show up to 4 decimals and trim the trailing zeros
 * instead, with a 2-decimal minimum so $1.80 does not render as $1.8.
 */
function formatRatePerResp(rate) {
  const r = Number(rate);
  if (!Number.isFinite(r)) return null;
  const four = r.toFixed(4).replace(/(\.\d{2}\d*?)0+$/, '$1');
  return four;
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
 * ── The plateau bridge was retired by the 2026-09 reprice ──────────────────
 *
 * PR #101 removed a $498 price INVERSION on the old ladder by flooring each
 * bracket at the ceiling of the bracket below. On the old ladder that turned
 * the inversion into a FLAT band: max(n x $0.40, $900) = $900 for every n in
 * [1,000 .. 2,250], so 1,251 consecutive counts cost the same money. A linear
 * bridge between the $900 and $2,000 anchors closed it.
 *
 * The reprice removes the cause instead. A plateau forms when a bracket's rate
 * falls far enough that n x rate stays under the previous bracket's ceiling for
 * a long stretch. The new ladder's rate steps are small (1.80 -> 1.56 -> 1.49
 * -> 1.196 -> 0.998 -> 0.899 -> 0.8792) and its top bracket is open-ended, so
 * the widest flat band anywhere below the self-serve cap is 56 counts
 * (500..555) and there is no band at all above 1,022. The bridge had nothing
 * left to bridge, and its far anchor (5,000 at $2,000) was a count no customer
 * can buy — the cap is 1,250.
 *
 * respondentLadderBase is therefore called directly again; bridgedRespondentBase,
 * defaultLadderBridgeBase and the BRIDGE_* constants are gone.
 */

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
 * returns a real base so nothing downstream divides by zero, but flags
 * customQuote — which the existing fail-closed guards in routes/payments.js and
 * routes/pricing.js already turn into "contact sales" without a charge.
 */
const MAX_SELF_SERVE_RESPONDENTS = Number(process.env.MAX_SELF_SERVE_RESPONDENTS || 1250);

/** Where a customer above the cap is sent. Consumed by the route error payloads. */
const SELF_SERVE_LEAD_CAPTURE = {
  endpoint: '/api/crm/lead',   // public, rate-limited (5/hour/IP), dedupes on email
  cta: 'Request a quote',      // exactly what MissionControlPricing sends as `cta`
  page: 'mission_control_pricing',
  message: 'Studies above this size are run as a managed engagement. Leave an email and we will scope it with you.',
};

/** True when a respondent count is beyond what the pipeline can honestly deliver. */
function isAboveSelfServeCap(count) {
  return (Math.max(0, Number(count) || 0)) > MAX_SELF_SERVE_RESPONDENTS;
}

/**
 * ── Why a null tier now throws ──────────────────────────────────────────────
 *
 * resolveTier returns null to say "this {goal, count} combination has no tier
 * on this goal's ladder". calculateMissionPrice used to answer that by picking
 * a tier from a DIFFERENT ladder:
 *
 *   ratePerResp = tier?.ratePerResp || VOLUME_TIERS[0].ratePerResp
 *   volumeTier  = tier || VOLUME_TIERS[0]
 *   base        = tier?.packagePrice || CREATIVE_ATTENTION_TIERS[0].packagePrice
 *
 * A brand_lift study at n=5 has no brand-lift tier, so it was priced at the
 * DEFAULT ladder's Sniff Test rate: 5 x $1.80 = $9.00, with "Sniff Test",
 * anchorCount 5 and packagePrice 9 written onto the stored breakdown and the
 * Stripe receipt. n=49 came out at $88.20. A creative_attention study at n=1
 * took the packagePrice fallback to the flat $19 and was labelled "Sniff Test"
 * with anchorCount 10 - a tier that appears on neither ladder involved.
 *
 * None of those prices was ever a decision. They were the shape of an `||`.
 * The fallback also hid the omission that produced them, because a
 * manufactured price is indistinguishable from a real one downstream.
 *
 * So: refuse. The routes that create, re-price or charge a mission all reject
 * a below-floor goal before they get here, which makes this a backstop rather
 * than the user-facing behaviour - the tests assert exactly that. It carries
 * statusCode 400 so the two price-preview endpoints can translate it into a
 * clean client error instead of a 500.
 */
class UnpriceableMissionError extends Error {
  constructor({ goalType, respondentCount, minRespondents }) {
    super(
      `${goalType} missions require at least ${minRespondents} respondents; `
      + `${respondentCount} has no tier on the ${goalType} ladder and will not be priced off another one.`
    );
    this.name = 'UnpriceableMissionError';
    this.code = 'unpriceable_mission';
    this.statusCode = 400;
    this.goalType = goalType;
    this.respondentCount = respondentCount;
    this.minRespondents = minRespondents;
  }
}

/** The respondent floor for a goal, or null when the goal has no floor. */
function goalMinRespondents(goalType) {
  if (goalType === 'brand_lift')         return BRAND_LIFT_MIN_RESPONDENTS;
  if (goalType === 'creative_attention') return CA_MIN_RESPONDENTS;
  return null;
}

/**
 * ── Extra-question surcharge: $20 beyond 5 -> $5 beyond 10 ─────────────────
 *
 * The old rule assumed the question count was a customer choice. It is not.
 * A user can hand-add at most DRAFT_QUESTION_CAP = 3 questions; every other
 * question on the instrument is generated by the methodology itself:
 *
 *   validate / naming / marketing / research / competitor / satisfaction  5
 *   brand_lift                                                       10 - 14
 *   pricing_research (Van Westendorp + Gabor-Granger)                     13
 *   compare_concepts (5N + 3)                                        13 - 23
 *   feature_roadmap (MaxDiff + Kano)                            13 - 23 typ.
 *
 * So a $99 Feature Roadmap study quoted $459 at checkout, and 78% of that was
 * a line item the customer never chose and could not remove. On the generic
 * 5-question instrument the same rule collected nothing at all. It was a
 * purchase blocker aimed squarely at the specialist methodologies.
 *
 * $5 beyond 10 is also where the cost evidence lands. simulate.js budgets 220
 * output tokens per question per respondent on claude-haiku-4-5 ($5/Mtok out),
 * and insights.js adds ~500 tokens per question once per mission on sonnet, so
 * one extra question costs $0.00116n + $0.0075. Holding the 70% margin floor
 * needs $0.00387n + $0.025 -> $0.22 at n=50, $1.96 at n=500, $4.86 at n=1,250.
 * $5 clears the floor across the entire self-serve range and breaks even just
 * past the cap, at n=1,286. $20 was 305x marginal cost at n=50.
 *
 * Raising the free allowance from 5 to 10 does most of the work on its own: it
 * takes "generic instrument plus three user drafts" and the low end of
 * brand_lift to zero.
 */
const EXTRA_QUESTION_PRICE = 5;  // $ per question beyond FREE_QUESTIONS
const FREE_QUESTIONS        = 10;

// ── Helpers ──────────────────────────────────────────────────────────────────

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
  {
    // Creative Attention: flat package price per bracket.
    // Other goals: rate x count. A null tier (brand_lift or creative_attention
    // below its floor) is REFUSED here; the route layer rejects the invalid
    // combo first, so this throw is a backstop, not the normal path.
    // A null tier is resolveTier saying the combo has no price on this goal's
    // ladder. Refuse it here rather than silently borrowing another ladder's
    // rate - see UnpriceableMissionError above for what that silence charged.
    if (!tier) {
      throw new UnpriceableMissionError({
        goalType,
        respondentCount: Math.max(0, Number(respondentCount) || 0),
        minRespondents: goalMinRespondents(goalType),
      });
    }
    ratePerResp = isCreative ? null : tier.ratePerResp;
    base = isCreative
      ? tier.packagePrice
      // Monotonic: never cheaper than the top of the tier below (see
      // respondentLadderBase - V1 tier-boundary inversion fix). The default
      // ladder's top bracket is open-ended, so there is no plateau to bridge.
      : respondentLadderBase(getPricingForGoalType(goalType), tier, respondentCount, ratePerResp);
    volumeTier = tier;
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
      // Min-order clamp. A flat promo can never drive the charge to $0 or
      // below: cap the discount so the total stays at or above the floor
      // ($1.00, above Stripe's $0.50 minimum). FRIEND10 ($10) on a $9 order
      // yields a $1 charge, not a $0 order that checkout then refuses.
      // Percentage and free promos are owner-controlled and may still reach $0.
      const minCharge = MIN_CHARGE_CENTS_AFTER_FLAT_DISCOUNT / 100;
      const maxFlatDiscount = Math.max(0, subtotal - minCharge);
      discount = round2(Math.min(promoCode.value, maxFlatDiscount));
    }
  }

  // The exact arithmetic, before the customer-facing rounding.
  const exactTotal = round2(Math.max(0, subtotal - discount));
  // What is actually charged. See roundChargeToWholeDollar: the ladder's round
  // numbers are its anchors, and the slider lets a customer land between them.
  const total = roundChargeToWholeDollar(exactTotal);

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
    // The pre-rounding figure, so a breakdown can show its own arithmetic and
    // a caller that needs the exact ladder value is not forced to recompute it.
    exactTotal,
    // Extra metadata for logging / breakdown lines.
    //
    // `tier` and `countryTier` USED TO SIT HERE and were removed 2026-09-13.
    // Both were the same number - the geography bucket a mission fell in under
    // a model retired on 2026-04-28 - and both were multiplied by nothing. A
    // consumer audit across both repos (#164) and a re-audit before the
    // deletion found zero readers: no route, no frontend component, no export,
    // no admin or analytics surface, and nothing persisted. They were on the
    // wire (POST /api/missions/calculate-price serialises this object, POST
    // /api/pricing/quote nests it under `details`), so their removal is an API
    // response change - a removal of two fields nobody read.
    //
    // `countries` below is NOT one of them. It is the caller's own input
    // echoed back, and it does not price anything either. Geography does not
    // price. If you are about to describe geographic pricing in a deck or a
    // rate card, that feature does not exist yet.
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

/**
 * The amount a customer is actually charged, in whole dollars.
 *
 * The ladder picks round numbers at its ANCHORS and derives a per-respondent
 * rate from each one, so an anchor count lands on a round price - but the
 * slider steps by 5, so most customers land BETWEEN anchors and got the raw
 * multiplication: 10 respondents at $1.56 is $15.60, 50 at $1.49 is $74.50.
 * "From $9" followed by a checkout reading $15.60 is the same credibility
 * problem the round anchors were chosen to avoid, one step further in.
 *
 * Rounding the TOTAL rather than the base is deliberate: it is the last number
 * before the card, so every surcharge, promo and clamp is already inside it and
 * nothing downstream can un-round it.
 *
 * A positive charge never rounds to zero. A 95%-off promo on a $9 mission is
 * $0.45, and rounding that to $0 would turn a paid mission into a free one -
 * checkout would refuse it either way at Stripe's $0.50 minimum, but "free"
 * and "refused" are different states and the engine should not invent one.
 * Genuinely free missions reach 0 through a free-type promo, which zeroes the
 * total before this runs.
 */
function roundChargeToWholeDollar(exactTotal) {
  const t = Number(exactTotal);
  if (!Number.isFinite(t) || t <= 0) return 0;
  return Math.max(1, Math.round(t));
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
 *
 * Structure: the METHODOLOGY gates run first and unconditionally, above the
 * tier resolution. This split is deliberate and outlived the flag that forced
 * it. The goal-specific blocks used to sit BELOW an `if (PRICING_V2_ACTIVE)`
 * early return, so flipping a PRICING flag would have silently switched off
 * the brand_lift floor, the creative_attention floor and the self-serve
 * ceiling. Those three are not prices. The floors are the sample
 * sizes below which the analysis cannot produce the thing the customer is
 * buying (brand_lift's exposed/control split cannot detect a realistic lift
 * under 100; creative_attention's attention model has nothing to average
 * under 10), and the ceiling is a DELIVERY constraint (wall-clock inside the
 * 6h recovery backstop at the measured recruit-loop rate). None of them
 * should move because the price ladder changed.
 */
function validateMissionPricing({ goalType, respondentCount, mediaType }) {
  // ── Methodology + delivery gates — run in BOTH pricing modes ────────────
  //
  // Self-serve ceiling first, goal-agnostic, because the constraint is
  // delivery, not the price ladder: a 3,000-respondent Creative Attention
  // mission is refused for the same reason a 3,000-respondent validate
  // mission is.
  if (isAboveSelfServeCap(respondentCount)) {
    return {
      valid: false,
      error: `Studies above ${MAX_SELF_SERVE_RESPONDENTS.toLocaleString('en-US')} respondents are run as a managed engagement, not self-serve. Please contact sales.`,
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
    // resolveTier needs the COUNT. Without it the argument arrives as
    // undefined, coerces to 0, trips 0 < CA_MIN_RESPONDENTS and returns null -
    // the documented "invalid combo" signal - for EVERY creative_attention
    // mission, legal ones included. The old code then returned valid: true
    // with that null attached, so two things were wrong at once: the CA floor
    // of 10 was never enforced at checkout, and no caller ever received a real
    // CA tier from this function.
    //
    // resolveTier is used here as the FLOOR ORACLE (null = below
    // CA_MIN_RESPONDENTS); the tier it returns is also what the caller gets.
    if (!resolveTier({ goalType, respondentCount: Number(respondentCount) || 0, mediaType })) {
      return {
        valid: false,
        error: `creative_attention missions require at least ${CA_MIN_RESPONDENTS} respondents`,
      };
    }
  }
  if (goalType === 'brand_lift') {
    if ((Number(respondentCount) || 0) < BRAND_LIFT_MIN_RESPONDENTS) {
      return {
        valid: false,
        error: `brand_lift missions require at least ${BRAND_LIFT_MIN_RESPONDENTS} respondents. Below that the exposed/control split cannot detect a realistic lift.`,
      };
    }
  }
  // Every remaining goal type accepts any positive count. (creative_attention
  // and brand_lift already cleared floors well above 1.)
  const c = Number(respondentCount) || 0;
  if (c < 1) {
    return { valid: false, error: 'respondentCount must be >= 1' };
  }

  // ── Tier resolution — the only flag-aware part ──────────────────────────
  //
  return { valid: true, tier: resolveTier({ goalType, respondentCount: c, mediaType }) };
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
  BRAND_LIFT_MIN_RESPONDENTS,
  brandLiftMDE,
  goalMinRespondents,
  UnpriceableMissionError,
  MIN_CHARGE_CENTS_AFTER_FLAT_DISCOUNT,
  getActiveTierTable,
  formatRatePerResp,
  roundChargeToWholeDollar,
  EXTRA_QUESTION_PRICE_USD: EXTRA_QUESTION_PRICE,
  FREE_QUESTIONS,
  // Default-ladder helper kept for backwards compat
  getVolumeTier,
  // V1 monotonicity helpers (tier-boundary price inversion fix)
  tierPriceFloor,
  respondentLadderBase,
  // Self-serve ceiling
  isAboveSelfServeCap,
  MAX_SELF_SERVE_RESPONDENTS,
  SELF_SERVE_LEAD_CAPTURE,
};
