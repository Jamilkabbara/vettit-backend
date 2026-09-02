/**
 * V1 tier-boundary price inversion regression.
 *
 * V1 priced respondent ladders as a pure `count × tier.ratePerResp`. The
 * bracket rate drops at each tier boundary, so the total went DOWN as the
 * count went UP — e.g. 1,000 × $0.90 = $900.00 but 1,005 × $0.40 = $402.00.
 * That was reachable from the setup slider (min 5, max 5,000, step 5) by
 * dragging one notch right.
 *
 * These tests pin the invariant: price must be MONOTONIC NON-DECREASING in
 * respondent count, on every ladder, across every boundary.
 */
const {
  calculateMissionPrice,
  VOLUME_TIERS,
  BRAND_LIFT_TIERS,
  CREATIVE_ATTENTION_TIERS,
  PRICING_V2_ACTIVE,
} = require('../src/utils/pricingEngine');

const baseFor = (goalType, n, extra = {}) =>
  calculateMissionPrice({ goalType, respondentCount: n, questionCount: 5, targeting: {}, ...extra }).base;

const totalFor = (goalType, n, extra = {}) =>
  calculateMissionPrice({ goalType, respondentCount: n, questionCount: 5, targeting: {}, ...extra }).total;

/** Every count in [lo, hi] stepping by `step`, plus every boundary ± a few. */
function sweepCounts(ladder, lo, hi, step) {
  const pts = new Set();
  for (let n = lo; n <= hi; n += step) pts.add(n);
  for (const t of ladder) {
    if (!Number.isFinite(t.maxCount)) continue;
    for (const d of [-2, -1, 0, 1, 2]) {
      const n = t.maxCount + d;
      if (n >= lo && n <= hi) pts.add(n);
    }
  }
  return [...pts].sort((a, b) => a - b);
}

describe('V1 price is monotonic non-decreasing in respondent count', () => {
  it('sanity: PRICING_V2 is OFF, so these tests exercise the live V1 path', () => {
    expect(PRICING_V2_ACTIVE).toBe(false);
  });

  it('default ladder (validate): price(n+1) >= price(n) across every boundary', () => {
    const counts = sweepCounts(VOLUME_TIERS, 1, 5000, 1);
    let prev = -Infinity;
    let prevN = null;
    for (const n of counts) {
      const p = baseFor('validate', n);
      if (p < prev) {
        throw new Error(`price inversion: n=${prevN} → $${prev}, n=${n} → $${p}`);
      }
      prev = p;
      prevN = n;
    }
  });

  it('brand_lift ladder: price(n+1) >= price(n) across every boundary', () => {
    const counts = sweepCounts(BRAND_LIFT_TIERS, 50, 5000, 1);
    let prev = -Infinity;
    let prevN = null;
    for (const n of counts) {
      const p = baseFor('brand_lift', n);
      if (p < prev) {
        throw new Error(`price inversion: n=${prevN} → $${prev}, n=${n} → $${p}`);
      }
      prev = p;
      prevN = n;
    }
  });

  it('creative_attention ladder (flat package price): still monotonic', () => {
    const counts = sweepCounts(CREATIVE_ATTENTION_TIERS, 10, 5000, 1);
    let prev = -Infinity;
    let prevN = null;
    for (const n of counts) {
      const p = baseFor('creative_attention', n, { mediaType: 'image' });
      if (p < prev) {
        throw new Error(`price inversion: n=${prevN} → $${prev}, n=${n} → $${p}`);
      }
      prev = p;
      prevN = n;
    }
  });

  it('monotonicity survives the full total (surcharges + rounding), not just base', () => {
    let prev = -Infinity;
    let prevN = null;
    for (const n of sweepCounts(VOLUME_TIERS, 5, 5000, 5)) {
      const p = totalFor('validate', n, {
        questionCount: 8,
        targeting: { professional: { industries: ['tech'], roles: ['eng'] } },
        isScreeningActive: true,
      });
      if (p < prev) {
        throw new Error(`total inversion: n=${prevN} → $${prev}, n=${n} → $${p}`);
      }
      prev = p;
      prevN = n;
    }
  });
});

describe('the specific reported arbitrage windows are closed', () => {
  it('1,000 vs 1,005 respondents (Scale → Enterprise): the $498 hole is gone', () => {
    expect(baseFor('validate', 1000)).toBe(900);
    // was 1005 × $0.40 = $402.00.
    //
    // This line used to read `.toBe(900)`. That did not assert the invariant
    // this file is named for — it pinned the FLAT $900 plateau that the
    // previous-ceiling floor created across [1,000 .. 2,250], i.e. it asserted
    // the defect. The linear bridge (900 + (n-1,000) × 0.275) now charges
    // $901.38 here. The hole this test exists to close — 1,005 costing LESS
    // than 1,000 — is still closed, and that is what is asserted.
    expect(baseFor('validate', 1005)).toBeGreaterThanOrEqual(900);
    expect(baseFor('validate', 1005)).toBeGreaterThanOrEqual(baseFor('validate', 1000));
  });

  it('1,000 vs 1,001 respondents (the API-reachable version)', () => {
    expect(baseFor('validate', 1001)).toBeGreaterThanOrEqual(baseFor('validate', 1000));
  });

  it('every default-ladder boundary: maxCount+1 is never cheaper than maxCount', () => {
    for (const t of VOLUME_TIERS) {
      if (!Number.isFinite(t.maxCount)) continue;
      const at = baseFor('validate', t.maxCount);
      const past = baseFor('validate', t.maxCount + 1);
      expect(past).toBeGreaterThanOrEqual(at);
    }
  });

  it('every brand_lift boundary: maxCount+1 is never cheaper than maxCount', () => {
    for (const t of BRAND_LIFT_TIERS) {
      if (!Number.isFinite(t.maxCount)) continue;
      const at = baseFor('brand_lift', t.maxCount);
      const past = baseFor('brand_lift', t.maxCount + 1);
      expect(past).toBeGreaterThanOrEqual(at);
    }
  });
});

describe('the fix does not raise prices at the tier anchor / preset counts', () => {
  // These are the counts the setup UI snaps to (tier markers + preset cards)
  // and the counts every existing pricing test asserts. They must be
  // byte-identical to pre-fix `count × rate`.
  it.each([
    [5, 9], [10, 35], [50, 99], [100, 120], [250, 300], [1000, 900], [5000, 2000],
  ])('validate n=%i → $%s (unchanged)', (n, expected) => {
    expect(baseFor('validate', n)).toBe(expected);
  });

  it.each([
    [50, 99], [200, 300], [500, 600], [2000, 1500],
  ])('brand_lift n=%i → $%s (unchanged)', (n, expected) => {
    expect(baseFor('brand_lift', n)).toBe(expected);
  });
});
