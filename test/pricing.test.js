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
  it('tier 1 (UAE): 10 respondents, 5 questions → $35', () => {
    const { total, totalCents } = calculateMissionPrice({
      respondentCount: 10,
      questionCount: 5,
      countries: ['AE'],
    });
    expect(total).toBe(35.00);
    expect(totalCents).toBe(3500);
  });

  it('tier 2 (SA): 10 respondents, 5 questions → $27.50', () => {
    const { total, totalCents } = calculateMissionPrice({
      respondentCount: 10,
      questionCount: 5,
      countries: ['SA'],
    });
    expect(total).toBe(27.50);
    expect(totalCents).toBe(2750);
  });

  it('tier 3 (default): 10 respondents, 5 questions → $19', () => {
    const { total, totalCents } = calculateMissionPrice({
      respondentCount: 10,
      questionCount: 5,
      countries: [],
    });
    expect(total).toBe(19.00);
    expect(totalCents).toBe(1900);
  });

  it('100 respondents, tier 1 → $350', () => {
    const { total } = calculateMissionPrice({ respondentCount: 100, questionCount: 5, countries: ['US'] });
    expect(total).toBe(350.00);
  });
});

// ── REGRESSION: mission 7f54fb42 ─────────────────────────────────────────────

describe('mission 7f54fb42 regression', () => {
  // Stored values (from Supabase 2026-04-23 audit):
  //   respondent_count: 10
  //   question_count:   5  (no extra questions)
  //   targeting:        null (no TargetingConfig set)
  //   target_audience.aiTargeting.countries: ['AE']  (UAE — tier 1)
  //   price_estimated:  "35" (what UI showed — correct)
  //   total_price_usd:  "9.00" (old backend formula — was wrong)
  //   Stripe PIs:       900 cents (old backend formula — was wrong)

  it('10 respondents × UAE (tier 1), 5 questions, null targeting → $35 / 3500 cents', () => {
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
    expect(total).toBe(35.00);
    expect(totalCents).toBe(3500);
  });

  it('confirms old formula was wrong: 10 × $0.90 = $9 ≠ $35', () => {
    // Document the discrepancy so it is never silently reintroduced.
    const oldResult = 10 * 0.90;
    const newResult = calculateMissionPrice({ respondentCount: 10, questionCount: 5, countries: ['AE'] }).total;
    expect(oldResult).toBe(9.00);   // old (wrong) value
    expect(newResult).toBe(35.00);  // new (correct) value
    expect(newResult).not.toBe(oldResult);
  });
});

// ── Question surcharge ────────────────────────────────────────────────────────

describe('question surcharge', () => {
  it('5 questions → no surcharge', () => {
    const { questionSurcharge } = calculateMissionPrice({ respondentCount: 10, questionCount: 5, countries: ['AE'] });
    expect(questionSurcharge).toBe(0);
  });

  it('6 questions → $20 surcharge', () => {
    const { questionSurcharge } = calculateMissionPrice({ respondentCount: 10, questionCount: 6, countries: ['AE'] });
    expect(questionSurcharge).toBe(20);
  });

  it('10 questions → $100 surcharge (5 extra × $20)', () => {
    const { questionSurcharge } = calculateMissionPrice({ respondentCount: 10, questionCount: 10, countries: ['AE'] });
    expect(questionSurcharge).toBe(100);
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

// ── totalCents is always integer ──────────────────────────────────────────────

describe('totalCents is always an integer', () => {
  const cases = [
    { respondentCount: 7,  questionCount: 3,  countries: ['AE'] },
    { respondentCount: 13, questionCount: 7,  countries: ['GB', 'AE'] },
    { respondentCount: 50, questionCount: 5,  countries: ['SA'] },
    { respondentCount: 11, questionCount: 11, countries: ['PS'] },
  ];

  cases.forEach(c => {
    it(`${c.respondentCount} resp, ${c.questionCount} q, [${c.countries}]`, () => {
      const { totalCents } = calculateMissionPrice(c);
      expect(Number.isInteger(totalCents)).toBe(true);
    });
  });
});
