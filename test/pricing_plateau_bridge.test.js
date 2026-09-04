/**
 * The 1,000–2,250 price plateau, and the self-serve delivery ceiling.
 *
 * PR #101 killed a $498 price inversion by flooring the Enterprise bracket at
 * Scale's ceiling of $900. The side effect was a FLAT price across 1,251
 * consecutive counts:  base(n) = max(n × $0.40, $900) = $900 for n in
 * [1,000 .. 2,250].  At the top of that plateau 2,250 respondents cost
 * $0.40/resp — the same marginal rate as 5,000 respondents for less than half
 * the money.
 *
 * The bridge interpolates between the two PINNED anchors instead:
 *   base(n) = 900 + (n - 1,000) × 0.275     for 1,000 < n <= 5,000
 * $0.275 = ($2,000 - $900) / (5,000 - 1,000), the only marginal rate that
 * lands on BOTH anchors — which is why test/pricing_monotonicity.test.js
 * passes unmodified.
 *
 * The ceiling caps self-serve at what the pipeline can actually deliver
 * inside the 6h recovery backstop at the measured recruit-loop rate.
 */
const {
  calculateMissionPrice,
  validateMissionPricing,
  defaultLadderBridgeBase,
  isAboveSelfServeCap,
  MAX_SELF_SERVE_RESPONDENTS,
  SELF_SERVE_LEAD_CAPTURE,
  BRIDGE_FROM_COUNT,
  BRIDGE_TO_COUNT,
  BRIDGE_RATE_PER_RESP,
  PRICING_V2_ACTIVE,
} = require('../src/utils/pricingEngine');

const base = (n) =>
  calculateMissionPrice({ goalType: 'validate', respondentCount: n, questionCount: 5 }).base;

describe('sanity', () => {
  it('PRICING_V2 is OFF — these tests exercise the live V1 path', () => {
    expect(PRICING_V2_ACTIVE).toBe(false);
  });
});

describe('the plateau is gone', () => {
  it('the old plateau band no longer prices flat', () => {
    // Every one of these was exactly $900 before the bridge.
    expect(base(1000)).toBe(900);
    expect(base(1001)).toBeGreaterThan(900);
    expect(base(1500)).toBeGreaterThan(base(1001));
    expect(base(2250)).toBeGreaterThan(base(1500));
  });

  it('2,250 no longer costs the same $0.40/resp as 5,000', () => {
    const rateAt2250 = base(2250) / 2250;
    const rateAt5000 = base(5000) / 5000;
    expect(rateAt5000).toBeCloseTo(0.40, 6);
    expect(rateAt2250).toBeGreaterThan(rateAt5000);
  });

  it('no two distinct counts in (1,000, 5,000] share a price', () => {
    const seen = new Map();
    for (let n = 1001; n <= 5000; n++) {
      const p = base(n);
      expect(seen.has(p)).toBe(false);
      seen.set(p, n);
    }
  });
});

describe('the bridge is the only rate that lands on both anchors', () => {
  it('$0.275 is derived, not chosen', () => {
    expect(BRIDGE_RATE_PER_RESP).toBeCloseTo(0.275, 10);
    expect(BRIDGE_FROM_COUNT).toBe(1000);
    expect(BRIDGE_TO_COUNT).toBe(5000);
  });

  it('both pinned anchors are unchanged', () => {
    expect(base(1000)).toBe(900);
    expect(base(5000)).toBe(2000);
  });

  it.each([[5, 9], [10, 35], [50, 99], [100, 120], [250, 300], [1000, 900], [5000, 2000]])(
    'anchor n=%i still prices $%i', (n, price) => {
      expect(base(n)).toBeCloseTo(price, 2);
    });

  it('is linear inside the band and inert outside it', () => {
    expect(defaultLadderBridgeBase(1000)).toBeNull();   // <= from: bracket price
    expect(defaultLadderBridgeBase(5001)).toBeNull();   // >  to:   bracket price
    expect(defaultLadderBridgeBase(1001)).toBeCloseTo(900.28, 2);
    expect(defaultLadderBridgeBase(3000)).toBeCloseTo(1450, 2);
    expect(defaultLadderBridgeBase(5000)).toBeCloseTo(2000, 2);
  });

  it('joins the Enterprise bracket monotonically above 5,000', () => {
    expect(base(5001)).toBeGreaterThanOrEqual(base(5000));
    expect(base(5001)).toBeCloseTo(2000.40, 2);
  });
});

describe('price is still monotonic non-decreasing, well past the ladder', () => {
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
      goalType: 'validate', respondentCount: n, questionCount: 8,
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

  it('at or below the cap, a mission is sellable', () => {
    const p = calculateMissionPrice({ goalType: 'validate', respondentCount: 1250 });
    expect(p.customQuote).toBe(false);
    expect(p.base).toBeCloseTo(968.75, 2);
    expect(validateMissionPricing({ goalType: 'validate', respondentCount: 1250 }).valid).toBe(true);
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

describe('PRICING_V2 stays dormant', () => {
  it('the flag is off and the V1 path is what produced every number above', () => {
    expect(PRICING_V2_ACTIVE).toBe(false);
    expect(calculateMissionPrice({ goalType: 'validate', respondentCount: 250 }).total).toBeCloseTo(300, 2);
  });
});
