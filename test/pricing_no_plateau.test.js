/**
 * The price plateau, and why the linear bridge was retired.
 *
 * PR #101 removed a $498 price INVERSION (1,005 respondents cost LESS than
 * 1,000) by flooring each bracket at the ceiling of the bracket below. On the
 * old ladder that turned the inversion into a FLAT band: max(n x $0.40, $900)
 * held $900 across every count in [1,000 .. 2,250]. 1,251 consecutive counts
 * bought materially different inventory for identical money. A linear bridge
 * between the $900 and $2,000 anchors closed that band.
 *
 * The 2026-09 reprice removes the cause. A wide plateau forms when a bracket's
 * rate falls far enough that `n x rate` stays under the previous bracket's
 * ceiling for a long stretch — the old ladder's rate more than halved at that
 * boundary ($0.90 -> $0.40). The repriced ladder's steps are small and its top
 * bracket is open-ended, so the widest band anywhere under the self-serve cap
 * is 56 counts and the bridge had nothing left to do.
 *
 * These tests pin the property (bounded plateau width), not the mechanism, so
 * a future reprice is free to change the rates as long as it does not
 * reintroduce a wide flat band.
 */
const {
  calculateMissionPrice,
  validateMissionPricing,
  isAboveSelfServeCap,
  MAX_SELF_SERVE_RESPONDENTS,
  SELF_SERVE_LEAD_CAPTURE,
  VOLUME_TIERS,
} = require('../src/utils/pricingEngine');

const base = (n) => calculateMissionPrice({
  goalType: 'validate', respondentCount: n, questionCount: 5, targeting: {},
}).base;

/** Every maximal run of counts in [1, hi] that share a price. */
function flatBands(hi) {
  const bands = [];
  let start = 1;
  let prev = base(1);
  for (let n = 2; n <= hi; n += 1) {
    const p = base(n);
    if (p !== prev) {
      bands.push({ from: start, to: n - 1, width: n - start, price: prev });
      start = n;
      prev = p;
    }
  }
  bands.push({ from: start, to: hi, width: hi + 1 - start, price: prev });
  return bands;
}

/** The widest flat band strictly wider than 1 count. */
const widestBand = (hi) => flatBands(hi).reduce((a, b) => (b.width > a.width ? b : a));

describe('no wide price plateau survives below the self-serve cap', () => {
  it('the widest flat band is at most 60 counts', () => {
    // 60 is a deliberate ceiling on arbitrage width, not a description of the
    // current ladder (widest today is 56, at 500..555). The band the bridge
    // was built for was 1,251.
    const w = widestBand(MAX_SELF_SERVE_RESPONDENTS);
    expect({ ok: w.width <= 60, band: `${w.from}..${w.to} @ $${w.price} (${w.width} counts)` })
      .toEqual({ ok: true, band: `${w.from}..${w.to} @ $${w.price} (${w.width} counts)` });
  });

  it('the old $900 plateau band is gone: 1,000 and 2,250 no longer cost the same', () => {
    // 2,250 is above the cap and unsellable, but the ARITHMETIC must still
    // separate them — a cap is not a reason for the ladder to go flat behind it.
    expect(base(2250)).toBeGreaterThan(base(1000));
  });

  it('the top bracket is open-ended, so price keeps climbing past the cap', () => {
    const top = VOLUME_TIERS[VOLUME_TIERS.length - 1];
    expect(Number.isFinite(top.maxCount)).toBe(false);
    expect(base(5000)).toBeGreaterThan(base(2500));
    expect(base(2500)).toBeGreaterThan(base(1250));
  });
});

describe('price is monotonic non-decreasing, well past the ladder', () => {
  it('sweeps every integer 1..25,000 with zero inversions', () => {
    let prev = -Infinity;
    let prevN = null;
    for (let n = 1; n <= 25000; n++) {
      const p = base(n);
      if (p < prev - 1e-9) throw new Error(`inversion: n=${prevN} -> $${prev}, n=${n} -> $${p}`);
      prev = p; prevN = n;
    }
  });

  it('survives the full total (surcharges + rounding)', () => {
    const total = (n) => calculateMissionPrice({
      goalType: 'validate', respondentCount: n, questionCount: 14,
      targeting: { professional: { industries: ['tech'], roles: ['eng'] } },
      isScreeningActive: true,
    }).total;
    let prev = -Infinity;
    for (let n = 1; n <= 6000; n++) {
      const p = total(n);
      if (p < prev - 1e-9) throw new Error(`total inversion at n=${n}`);
      prev = p;
    }
  });
});

describe('the self-serve ceiling captures the lead instead of selling', () => {
  it('the cap is the derived delivery number, not the old 5,000 price bound', () => {
    expect(MAX_SELF_SERVE_RESPONDENTS).toBe(1250);
    expect(isAboveSelfServeCap(MAX_SELF_SERVE_RESPONDENTS)).toBe(false);
    expect(isAboveSelfServeCap(MAX_SELF_SERVE_RESPONDENTS + 1)).toBe(true);
  });

  it('the top bracket anchors AT the cap, so the last sellable count has a round price', () => {
    const top = VOLUME_TIERS[VOLUME_TIERS.length - 1];
    expect(top.anchorCount).toBe(MAX_SELF_SERVE_RESPONDENTS);
    const p = calculateMissionPrice({ goalType: 'validate', respondentCount: MAX_SELF_SERVE_RESPONDENTS });
    expect(p.customQuote).toBe(false);
    expect(p.base).toBe(1099);
    expect(validateMissionPricing({ goalType: 'validate', respondentCount: MAX_SELF_SERVE_RESPONDENTS }).valid).toBe(true);
  });

  it('above the cap, the price still computes but is NOT sellable', () => {
    const p = calculateMissionPrice({ goalType: 'validate', respondentCount: 1251 });
    expect(p.customQuote).toBe(true);
    expect(p.base).toBeGreaterThan(0);      // never a $0 base reaching Stripe
    expect(p.total).toBeGreaterThan(0);
  });

  it('the cap is goal-agnostic — the constraint is delivery, not the ladder', () => {
    for (const goalType of ['validate', 'brand_lift', 'creative_attention', 'marketing']) {
      const v = validateMissionPricing({ goalType, respondentCount: 3000, mediaType: 'image' });
      expect(v.valid).toBe(false);
      expect(v.error).toMatch(/managed engagement|contact sales/i);
    }
  });

  it('the refusal carries a destination — it is not a dead end', () => {
    const v = validateMissionPricing({ goalType: 'validate', respondentCount: 3000 });
    expect(v.leadCapture).toEqual(SELF_SERVE_LEAD_CAPTURE);
    expect(SELF_SERVE_LEAD_CAPTURE.endpoint).toBe('/api/crm/lead');
    expect(SELF_SERVE_LEAD_CAPTURE.cta).toBe('Request a quote');
  });
});
