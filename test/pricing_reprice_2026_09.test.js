/**
 * The 2026-09 reprice, pinned.
 *
 * Three approved changes land together because they are one price:
 *
 *   1. The default ladder is rebuilt price-first. Seven round anchors, and
 *      ratePerResp DERIVED as price / anchorCount, which makes the rate curve
 *      monotone decreasing for the first time (it used to spike to $3.50/resp
 *      at n=10, between $1.80 at n=5 and $1.98 at n=50).
 *   2. The extra-question surcharge goes from $20 per question beyond 5 to $5
 *      per question beyond 10. Question counts are set by the methodology, not
 *      the customer, so the old rule collected nothing on generic instruments
 *      and $360 on a Feature Roadmap the customer could not shorten.
 *   3. PRICING_V2 is deleted. Its only live-behaviour survivor is the flat
 *      promo minimum-charge clamp, which is now unconditional.
 */
const {
  calculateMissionPrice,
  VOLUME_TIERS,
  EXTRA_QUESTION_PRICE_USD,
  formatRatePerResp,
} = require('../src/utils/pricingEngine');

const priceOf = (n, q = 5, extra = {}) => calculateMissionPrice({
  goalType: 'validate', respondentCount: n, questionCount: q, targeting: {}, ...extra,
});

describe('1. the ladder is price-first', () => {
  test.each([
    [5, 9], [25, 39], [100, 149], [250, 299], [500, 499], [1000, 899], [1250, 1099],
  ])('n=%i charges $%i exactly', (n, expected) => {
    expect(priceOf(n).base).toBe(expected);
  });

  test('every rate is exactly its anchor price divided by its anchor count', () => {
    for (const t of VOLUME_TIERS) {
      expect({ id: t.id, rate: t.ratePerResp })
        .toEqual({ id: t.id, rate: t.packagePrice / t.anchorCount });
    }
  });

  test('the $3.50/resp spike at n=10 is gone', () => {
    // The whole reason the ladder was rebuilt. The old ladder charged
    // $1.80/resp at n=5, $3.50 at n=10 and $1.98 at n=50 — moving the slider
    // one notch right nearly doubled the unit price.
    const rate = (n) => priceOf(n).base / n;
    expect(rate(10)).toBeLessThan(rate(5));
    expect(rate(50)).toBeLessThan(rate(10));
    expect(priceOf(10).base).toBe(15.6);
  });

  test('the rate label reconciles with the charge it produced', () => {
    // formatRatePerResp, not toFixed(2). 499/500 = $0.998; rendering that as
    // "$1.00 x 500 respondents = $499" is an arithmetic error on a receipt.
    for (const t of VOLUME_TIERS) {
      const shown = Number(formatRatePerResp(t.ratePerResp));
      expect({ id: t.id, product: Math.round(shown * t.anchorCount * 100) / 100 })
        .toEqual({ id: t.id, product: t.packagePrice });
    }
  });
});

describe('2. the extra-question surcharge', () => {
  test('the constant is $5 with a 10-question allowance', () => {
    expect(EXTRA_QUESTION_PRICE_USD).toBe(5);
  });

  test.each([
    [5, 0], [10, 0], [13, 15], [14, 20], [15, 25], [18, 40], [23, 65],
  ])('a %i-question instrument adds $%i', (q, expected) => {
    expect(priceOf(50, q).questionSurcharge).toBe(expected);
  });

  test('the methodologies that were priced out of existence are affordable again', () => {
    // feature_roadmap runs 23 questions and none of them are the customer's
    // choice: at n=50 the old rule quoted $99 base + $360 of questions.
    const roadmap = priceOf(50, 23);
    expect(roadmap.questionSurcharge).toBe(65);
    expect(roadmap.total).toBe(139.50);
    // The surcharge is now a minority of the bill, where it was 78% of it.
    expect(roadmap.questionSurcharge / roadmap.total).toBeLessThan(0.5);
  });
});

describe('3. the flat-promo minimum-charge clamp is unconditional', () => {
  test('a $10 flat promo on a $9 order charges $1, not $0', () => {
    // Before the V2 deletion this clamp only ran under a flag that was never
    // on. In production the order netted $0 and checkout then REFUSED it under
    // Stripe's minimum — the customer could not buy and the promo looked broken.
    const p = priceOf(5, 5, { promoCode: { active: true, type: 'flat', value: 10 } });
    expect(p.total).toBe(1);
    expect(p.discount).toBe(8);
  });

  test('a normal flat promo is untouched', () => {
    const p = priceOf(25, 5, { promoCode: { active: true, type: 'flat', value: 5 } });
    expect(p.total).toBe(34);
  });

  test('free and percentage promos may still reach $0 (owner-controlled)', () => {
    expect(priceOf(25, 5, { promoCode: { active: true, type: 'free' } }).total).toBe(0);
    expect(priceOf(25, 5, { promoCode: { active: true, type: 'percentage', value: 100 } }).total).toBe(0);
  });
});
