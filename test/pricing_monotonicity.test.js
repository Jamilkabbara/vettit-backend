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
  BRAND_LIFT_MIN_RESPONDENTS,
  CREATIVE_ATTENTION_TIERS,
  MAX_SELF_SERVE_RESPONDENTS,
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

describe('price is monotonic non-decreasing in respondent count', () => {
  it('sanity: there is exactly one ladder and these tests exercise it', () => {
    // Guards against a second flag-gated ladder being reintroduced and making
    // every assertion below vacuous.
    expect(VOLUME_TIERS.length).toBeGreaterThan(0);
    expect(baseFor('validate', VOLUME_TIERS[0].anchorCount)).toBe(VOLUME_TIERS[0].packagePrice);
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
    // Sweep from the FLOOR. Below BRAND_LIFT_MIN_RESPONDENTS a brand_lift
    // mission has no price at all - calculateMissionPrice throws rather than
    // silently pricing it off the default ladder - so monotonicity is
    // undefined below the floor, not violated.
    const counts = sweepCounts(BRAND_LIFT_TIERS, BRAND_LIFT_MIN_RESPONDENTS, 5000, 1);
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
  it('1,000 vs 1,005 respondents (Growth -> Enterprise): the $498 hole is gone', () => {
    expect(baseFor('validate', 1000)).toBe(899);
    // The original defect: 1,005 x $0.40 = $402.00, i.e. $498 CHEAPER than
    // 1,000. The previous-ceiling floor closed it but left a flat $900 band
    // 1,251 counts wide, and a linear bridge closed that.
    //
    // The 2026-09 reprice shrinks the cause instead of patching the symptom.
    // The rate step across this boundary is $0.899 -> $0.8792, so the floor
    // still holds a flat band here — but 23 counts (1,000..1,022) rather than
    // 1,251, which is why the bridge could be retired. 1,005 is inside that
    // band, so the honest assertion is not-cheaper, and the width is asserted
    // separately below.
    expect(baseFor('validate', 1005)).toBeGreaterThanOrEqual(baseFor('validate', 1000));
    expect(baseFor('validate', 1023)).toBeGreaterThan(baseFor('validate', 1000));
  });

  it('1,000 vs 1,001 respondents (the API-reachable version)', () => {
    expect(baseFor('validate', 1001)).toBeGreaterThanOrEqual(baseFor('validate', 1000));
  });

  it('no flat band below the self-serve cap is wider than 60 counts', () => {
    // The plateau the retired bridge existed to close was 1,251 counts wide.
    // Flat bands are inherent to a floored bracket ladder, but a WIDE one is
    // an arbitrage window: everyone in it pays the same money for materially
    // different inventory. 60 is a deliberate ceiling on that, not a
    // description of the current ladder (its widest band is 56).
    let widest = 0;
    let widestAt = null;
    let start = 1;
    let prev = baseFor('validate', 1);
    for (let n = 2; n <= MAX_SELF_SERVE_RESPONDENTS; n += 1) {
      const p = baseFor('validate', n);
      if (p !== prev) {
        if (n - start > widest) { widest = n - start; widestAt = `${start}..${n - 1}`; }
        start = n;
        prev = p;
      }
    }
    if (MAX_SELF_SERVE_RESPONDENTS + 1 - start > widest) {
      widest = MAX_SELF_SERVE_RESPONDENTS + 1 - start;
      widestAt = `${start}..${MAX_SELF_SERVE_RESPONDENTS}`;
    }
    expect({ widest: widest <= 60, at: widest <= 60 ? widestAt : `${widestAt} is ${widest} counts wide` })
      .toEqual({ widest: true, at: widestAt });
  });

  it('the per-respondent rate never rises as the count rises', () => {
    // The defect the reprice was built to remove: the old ladder charged
    // $1.80/resp at n=5, $3.50 at n=10 and $1.98 at n=50. Buying more was
    // more expensive per unit across a boundary a slider could cross.
    for (let i = 1; i < VOLUME_TIERS.length; i += 1) {
      expect({ from: VOLUME_TIERS[i - 1].id, rises: VOLUME_TIERS[i].ratePerResp > VOLUME_TIERS[i - 1].ratePerResp })
        .toEqual({ from: VOLUME_TIERS[i - 1].id, rises: false });
    }
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
    let checked = 0;
    for (const t of BRAND_LIFT_TIERS) {
      if (!Number.isFinite(t.maxCount)) continue;
      // Pulse's maxCount (50) now sits below the floor and is unpriceable.
      if (t.maxCount < BRAND_LIFT_MIN_RESPONDENTS) continue;
      const at = baseFor('brand_lift', t.maxCount);
      const past = baseFor('brand_lift', t.maxCount + 1);
      expect(past).toBeGreaterThanOrEqual(at);
      checked += 1;
    }
    expect(checked).toBeGreaterThan(0); // no vacuous pass if every tier is skipped
  });
});

describe('the ladder anchors are pinned', () => {
  // These are the counts the setup UI snaps to (tier markers + preset cards).
  // They were repriced in 2026-09; changing one again must be deliberate.
  it.each([
    [5, 9], [25, 39], [100, 149], [250, 299], [500, 499], [1000, 899], [1250, 1099],
  ])('validate n=%i → $%s (the repriced anchors)', (n, expected) => {
    expect(baseFor('validate', n)).toBe(expected);
  });

  it('every anchor price is a whole dollar', () => {
    // The reprice picks the customer-facing number first and derives the rate
    // from it. If a future edit moves a rate instead of a price, this fails.
    for (const t of VOLUME_TIERS) {
      expect({ id: t.id, cents: Math.round(baseFor('validate', t.anchorCount) * 100) % 100 })
        .toEqual({ id: t.id, cents: 0 });
    }
  });

  it.each([
    [200, 300], [500, 600], [2000, 1500],
  ])('brand_lift n=%i → $%s (unchanged)', (n, expected) => {
    expect(baseFor('brand_lift', n)).toBe(expected);
  });

  it('brand_lift n=50 is no longer priced at all (floor moved to 100)', () => {
    // Was [50, 99]. 50 is below the floor, so the honest assertion is that it
    // REFUSES, not that it costs $99. Pulse now anchors AT the floor instead.
    expect(() => baseFor('brand_lift', 50)).toThrow(/at least 100 respondents/);
  });
});

// ── Pulse is buyable, and moving it moved no price ──────────────────────────
//
// Pulse anchored at 50 with maxCount 50, entirely below the 100-respondent
// floor, so no count could resolve to it: a tier on the ladder that could not
// be bought. Its anchor moved to 100. These pin both halves of that: the tier
// now RESOLVES, and the money did not move.

describe('the Pulse tier is reachable at the brand_lift floor', () => {
  const pulse = BRAND_LIFT_TIERS.find(t => t.id === 'pulse');

  it('anchors at the floor, not below it', () => {
    expect(pulse.anchorCount).toBe(BRAND_LIFT_MIN_RESPONDENTS);
    expect(pulse.maxCount).toBeGreaterThanOrEqual(BRAND_LIFT_MIN_RESPONDENTS);
  });

  it('a study at the floor actually lands on Pulse', () => {
    const p = calculateMissionPrice({
      goalType: 'brand_lift', respondentCount: BRAND_LIFT_MIN_RESPONDENTS,
    });
    expect(p.volumeTier.id).toBe('pulse');
  });

  it('every brand_lift tier at or above the floor is reachable by some count', () => {
    // The defect in one sentence: a tier whose whole band sits under the floor
    // is dead inventory. No tier on this ladder may be in that state again.
    for (const t of BRAND_LIFT_TIERS) {
      const n = Math.max(t.anchorCount, BRAND_LIFT_MIN_RESPONDENTS);
      expect(calculateMissionPrice({ goalType: 'brand_lift', respondentCount: n }).volumeTier.id)
        .toBe(t.id);
    }
  });

  it('the Pulse band and the Tracker band meet with no gap and no overlap', () => {
    const tracker = BRAND_LIFT_TIERS.find(t => t.id === 'tracker');
    // Pulse owns up to its maxCount; the next count belongs to Tracker, and
    // Tracker still owns 200. Nothing between the two is unpriced.
    expect(calculateMissionPrice({ goalType: 'brand_lift', respondentCount: pulse.maxCount }).volumeTier.id).toBe('pulse');
    expect(calculateMissionPrice({ goalType: 'brand_lift', respondentCount: pulse.maxCount + 1 }).volumeTier.id).toBe('tracker');
    expect(calculateMissionPrice({ goalType: 'brand_lift', respondentCount: tracker.maxCount }).volumeTier.id).toBe('tracker');
  });

  it('the rate never rises with volume across the Pulse -> Tracker step', () => {
    // A cheaper per-respondent rate on the SMALLER tier is the $3.50 spike the
    // 2026-09 reprice removed from the default ladder. Pulse must not add one.
    const tracker = BRAND_LIFT_TIERS.find(t => t.id === 'tracker');
    expect(pulse.ratePerResp).toBeGreaterThanOrEqual(tracker.ratePerResp);
  });

  it.each([
    [100, 150],
    [150, 225],
    [199, 298.5],
  ])('n=%i still costs $%s, exactly what it cost before the move', (n, expected) => {
    expect(baseFor('brand_lift', n)).toBe(expected);
  });
});
