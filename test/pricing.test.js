/**
 * Regression tests for the VETT pricing engine.
 *
 * These lock the formula used by /api/payments/create-intent and
 * /api/pricing/quote against known good inputs. Any change to the
 * pricing formula must update these tests intentionally — a failing
 * test here is a revenue alert, not just a code smell.
 */

const { calculateMissionPrice, resolveHighestTier, getCountryTier, extractCountriesFromMission } = require('../src/utils/pricingEngine');

// ── Tier helpers ─────────────────────────────────────────────────────────────

describe('getCountryTier', () => {
  it('UAE is tier 1', () => expect(getCountryTier('AE')).toBe(1));
  it('US is tier 1',  () => expect(getCountryTier('US')).toBe(1));
  it('GB is tier 1',  () => expect(getCountryTier('GB')).toBe(1));
  it('SA is tier 2',  () => expect(getCountryTier('SA')).toBe(2));
  it('IN is tier 2',  () => expect(getCountryTier('IN')).toBe(2));
  it('SD is tier 3',  () => expect(getCountryTier('SD')).toBe(3));
  it('PS is tier 3',  () => expect(getCountryTier('PS')).toBe(3));
  it('unknown code is tier 3', () => expect(getCountryTier('XX')).toBe(3));
});

describe('resolveHighestTier', () => {
  it('empty array → tier 3 (default)',   () => expect(resolveHighestTier([])).toBe(3));
  it('null → tier 3',                    () => expect(resolveHighestTier(null)).toBe(3));
  it('single tier-1 country → 1',        () => expect(resolveHighestTier(['AE'])).toBe(1));
  it('mix of tier 2+3 → 2',             () => expect(resolveHighestTier(['SA', 'PS'])).toBe(2));
  it('mix of tier 1+3 → 1',             () => expect(resolveHighestTier(['AE', 'PS'])).toBe(1));
  it('all tier 3 → 3',                  () => expect(resolveHighestTier(['SD', 'AF'])).toBe(3));
});

// ── extractCountriesFromMission ───────────────────────────────────────────────

describe('extractCountriesFromMission', () => {
  it('returns targeting.geography.countries when present', () => {
    const m = { targeting: { geography: { countries: ['US', 'GB'] } } };
    expect(extractCountriesFromMission(m)).toEqual(['US', 'GB']);
  });

  it('falls back to target_audience.aiTargeting.countries', () => {
    const m = {
      targeting: null,
      target_audience: { aiTargeting: { countries: ['AE'] } },
    };
    expect(extractCountriesFromMission(m)).toEqual(['AE']);
  });

  it('falls back to target_audience.suggestions.countries', () => {
    const m = {
      targeting: null,
      target_audience: { suggestions: { countries: ['SA'] } },
    };
    expect(extractCountriesFromMission(m)).toEqual(['SA']);
  });

  it('returns [] when no countries anywhere', () => {
    expect(extractCountriesFromMission({ targeting: null, target_audience: {} })).toEqual([]);
    expect(extractCountriesFromMission(null)).toEqual([]);
  });
});

// ── calculateMissionPrice — base cases ───────────────────────────────────────

describe('calculateMissionPrice — base price by tier', () => {
  it('tier 1 (UAE): 10 respondents, 5 questions → $15.60', () => {
    const { total, totalCents } = calculateMissionPrice({
      respondentCount: 10,
      questionCount: 5,
      countries: ['AE'],
    });
    expect(total).toBe(15.60);
    expect(totalCents).toBe(1560);
  });

  // Pass 46 — country tiers were removed from the base-price model
  // (volume tiers only since the Pass 23 PRICING overhaul); these
  // expectations were stale relics of the deleted country-tier table,
  // first caught when Pass 46 ran the full suite.
  it('country does not change base price: 10 respondents (SA) → $15.60', () => {
    const { total, totalCents } = calculateMissionPrice({
      respondentCount: 10,
      questionCount: 5,
      countries: ['SA'],
    });
    expect(total).toBe(15.60);
    expect(totalCents).toBe(1560);
  });

  it('no-country default: 10 respondents → $15.60 (inside the Validate bracket)', () => {
    const { total, totalCents } = calculateMissionPrice({
      respondentCount: 10,
      questionCount: 5,
      countries: [],
    });
    expect(total).toBe(15.60);
    expect(totalCents).toBe(1560);
  });

  it('100 respondents → $149 (the Confidence anchor)', () => {
    const { total } = calculateMissionPrice({ respondentCount: 100, questionCount: 5, countries: ['US'] });
    expect(total).toBe(149.00);
  });
});

// ── REGRESSION: mission 7f54fb42 ─────────────────────────────────────────────

describe('mission 7f54fb42 regression', () => {
  // Stored values (from Supabase 2026-04-23 audit):
  //   respondent_count: 10
  //   question_count:   5  (no extra questions)
  //   targeting:        null (no TargetingConfig set)
  //   target_audience.aiTargeting.countries: ['AE']  (UAE — tier 1)
  //   price_estimated:  "35" (what the UI showed)
  //   total_price_usd:  "9.00" (old backend formula — was wrong)
  //   Stripe PIs:       900 cents (old backend formula — was wrong)
  //
  // The bug this pins is that the CHARGE was computed off a different formula
  // than the DISPLAY, not that $35 is the right price for ten respondents. The
  // 2026-09 reprice moved the ladder and ten respondents now cost $15.60; the
  // invariant being guarded — display and charge come from one expression — is
  // unchanged, and is asserted directly in pricing_display_matches_charge.

  it('10 respondents × UAE (tier 1), 5 questions, null targeting → $15.60 / 1560 cents', () => {
    const mission = {
      respondent_count: 10,
      questions: Array(5).fill({}),
      targeting: null,
      target_audience: { aiTargeting: { countries: ['AE'] } },
    };
    const countries = extractCountriesFromMission(mission);
    const { total, totalCents } = calculateMissionPrice({
      respondentCount: mission.respondent_count,
      targeting: mission.targeting || {},
      questionCount: mission.questions.length,
      countries,
    });
    expect(countries).toEqual(['AE']);
    expect(total).toBe(15.60);
    expect(totalCents).toBe(1560);
  });

  it('the charge is the ladder price, not a second hand-written formula', () => {
    // Document the discrepancy so it is never silently reintroduced.
    const strayFormula = 10 * 0.90;
    const charged = calculateMissionPrice({ respondentCount: 10, questionCount: 5, countries: ['AE'] }).total;
    expect(charged).toBe(15.60);
    expect(charged).not.toBe(strayFormula);
  });
});

// ── Question surcharge ────────────────────────────────────────────────────────

describe('question surcharge', () => {
  // $5 per question beyond 10, since the 2026-09 reprice. Question counts are
  // set by the methodology, not the customer, so the allowance covers every
  // generic instrument (5) plus the three drafts a user may add.
  it('5 questions → no surcharge', () => {
    const { questionSurcharge } = calculateMissionPrice({ respondentCount: 10, questionCount: 5, countries: ['AE'] });
    expect(questionSurcharge).toBe(0);
  });

  it('10 questions → no surcharge (exactly the allowance)', () => {
    const { questionSurcharge } = calculateMissionPrice({ respondentCount: 10, questionCount: 10, countries: ['AE'] });
    expect(questionSurcharge).toBe(0);
  });

  it('11 questions → $5 surcharge (one beyond the allowance)', () => {
    const { questionSurcharge } = calculateMissionPrice({ respondentCount: 10, questionCount: 11, countries: ['AE'] });
    expect(questionSurcharge).toBe(5);
  });

  it('23 questions (feature_roadmap) → $65 surcharge, was $360', () => {
    const { questionSurcharge } = calculateMissionPrice({ respondentCount: 10, questionCount: 23, countries: ['AE'] });
    expect(questionSurcharge).toBe(65);
  });
});

// ── Targeting surcharges ──────────────────────────────────────────────────────

describe('targeting surcharges', () => {
  const base = { respondentCount: 10, questionCount: 5, countries: ['AE'] };

  it('no targeting → $0 surcharge', () => {
    const { targetingSurcharge } = calculateMissionPrice({ ...base, targeting: {} });
    expect(targetingSurcharge).toBe(0);
  });

  it('city targeting → $1.00 × respondents', () => {
    const { targetingSurcharge } = calculateMissionPrice({
      ...base,
      targeting: { geography: { cities: ['Dubai'] } },
    });
    expect(targetingSurcharge).toBe(10.00);
  });

  it('professional B2B (3 fields) capped at $1.50/resp', () => {
    const { targetingSurcharge } = calculateMissionPrice({
      ...base,
      targeting: {
        professional: {
          industries: ['Tech', 'Finance', 'Healthcare', 'Retail'],  // 4 items → $2.00 → capped at $1.50
          roles: [],
          companySizes: [],
        },
      },
    });
    expect(targetingSurcharge).toBe(15.00); // $1.50 × 10
  });
});

// ── Promo code discounts ──────────────────────────────────────────────────────

describe('promo code discounts', () => {
  const base = { respondentCount: 25, questionCount: 5, countries: ['AE'] }; // $39 base

  it('type=free → total is $0, discount equals full subtotal', () => {
    const { total, discount } = calculateMissionPrice({
      ...base,
      promoCode: { code: 'VETTPROOF', type: 'free', value: 100, active: true },
    });
    expect(total).toBe(0);
    expect(discount).toBe(39.00);
  });

  it('type=percentage 20% → total is $31.20, discount is $7.80', () => {
    const { total, discount } = calculateMissionPrice({
      ...base,
      promoCode: { code: 'TWENTY', type: 'percentage', value: 20, active: true },
    });
    expect(total).toBe(31.20);
    expect(discount).toBe(7.80);
  });

  it('type=flat $10 → total is $29, discount is $10', () => {
    const { total, discount } = calculateMissionPrice({
      ...base,
      promoCode: { code: 'FRIEND10', type: 'flat', value: 10, active: true },
    });
    expect(total).toBe(29.00);
    expect(discount).toBe(10.00);
  });

  it('inactive promo → no discount applied', () => {
    const { total, discount } = calculateMissionPrice({
      ...base,
      promoCode: { code: 'DEAD', type: 'percentage', value: 50, active: false },
    });
    expect(total).toBe(39.00);
    expect(discount).toBe(0);
  });

  it('flat discount larger than the order → clamped to leave a $1 charge, not $0', () => {
    // BEHAVIOUR CHANGE, 2026-09. This clamp used to be gated behind PRICING_V2,
    // which was never on, so a flat promo could drive the total to $0 and
    // checkout then refused the order under Stripe's minimum — the customer
    // could not buy at all. Deleting the flag forced a choice between the two
    // branches; this is the one that lets the sale complete.
    const { total, discount } = calculateMissionPrice({
      ...base,
      promoCode: { code: 'BIG', type: 'flat', value: 500, active: true },
    });
    expect(total).toBe(1.00);
    expect(discount).toBe(38.00);
  });

  it('totalCents is 0 for free promo (integer)', () => {
    const { totalCents } = calculateMissionPrice({
      ...base,
      promoCode: { code: 'VETTPROOF', type: 'free', value: 100, active: true },
    });
    expect(totalCents).toBe(0);
    expect(Number.isInteger(totalCents)).toBe(true);
  });
});
