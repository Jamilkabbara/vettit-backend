/**
 * PR 1 — the public price DISPLAY must equal what Stripe actually charges.
 *
 * GET /api/pricing/tiers served $299 / $899 / $1990 for Deep Dive / Scale /
 * Enterprise while calculateMissionPrice charged $300 / $900 / $2000 at the
 * same respondent counts. Both numbers lived in src/utils/pricingEngine.js —
 * reading the same MODULE is not the same as reading the same VALUE. The
 * display read the hand-written `packagePrice` literal; the charge computed
 * `anchorCount x ratePerResp`. Nothing tied the two together, so the literal
 * drifted and the drift went out on the landing page and /terms.
 *
 * These are the invariants that would have caught it. They are deliberately
 * written against the PUBLIC surface (getActiveTierTable) and the MONEY
 * surface (calculateMissionPrice), not against a shared constant, so a future
 * refactor cannot make them vacuously true.
 */
const {
  VOLUME_TIERS,
  BRAND_LIFT_TIERS,
  CREATIVE_ATTENTION_TIERS,
  calculateMissionPrice,
  getActiveTierTable,
  PRICING_V2_ACTIVE,
} = require('../src/utils/pricingEngine');

const round2 = (v) => Math.round(v * 100) / 100;

/** base price only — 5 questions is the free allowance, no targeting. */
const baseFor = (goalType, n) =>
  calculateMissionPrice({ goalType, respondentCount: n, questionCount: 5, targeting: {} }).base;

describe('public price display equals the charged price', () => {
  test('the tiers endpoint is serving the V1 ladder (guards the assertions below)', () => {
    // If PRICING_V2 is ever flipped on, these V1 assertions describe a ladder
    // that is no longer served and would pass vacuously. Fail loudly instead.
    expect(PRICING_V2_ACTIVE).toBe(false);
    expect(getActiveTierTable().version).toBe('v1');
  });

  test('every VOLUME_TIERS packagePrice equals anchorCount x ratePerResp', () => {
    expect(VOLUME_TIERS.length).toBeGreaterThan(0); // no vacuous pass
    for (const t of VOLUME_TIERS) {
      expect({ id: t.id, packagePrice: t.packagePrice })
        .toEqual({ id: t.id, packagePrice: round2(t.anchorCount * t.ratePerResp) });
    }
  });

  test('every BRAND_LIFT_TIERS packagePrice equals anchorCount x ratePerResp', () => {
    expect(BRAND_LIFT_TIERS.length).toBeGreaterThan(0);
    for (const t of BRAND_LIFT_TIERS) {
      expect({ id: t.id, packagePrice: t.packagePrice })
        .toEqual({ id: t.id, packagePrice: round2(t.anchorCount * t.ratePerResp) });
    }
  });

  test('Creative Attention packagePrice IS the charge, so it is exempt from the rate identity', () => {
    // CA charges the flat packagePrice per bracket; anchorCount x ratePerResp
    // is descriptive there, not the formula. Assert the charge directly.
    expect(CREATIVE_ATTENTION_TIERS.length).toBeGreaterThan(0);
    for (const t of CREATIVE_ATTENTION_TIERS) {
      expect({ id: t.id, charged: baseFor('creative_attention', t.anchorCount) })
        .toEqual({ id: t.id, charged: t.packagePrice });
    }
  });

  test('GET /api/pricing/tiers publishes exactly what checkout charges at each anchor', () => {
    const { tiers } = getActiveTierTable();
    expect(tiers.length).toBe(VOLUME_TIERS.length);
    expect(tiers.length).toBeGreaterThan(0);
    let priced = 0;
    for (const published of tiers) {
      if (published.custom) {
        // Above the ceiling: no price may be published at all.
        expect({ id: published.id, priceUsd: published.priceUsd, label: published.fromLabel })
          .toEqual({ id: published.id, priceUsd: null, label: 'Custom' });
        continue;
      }
      priced += 1;
      const charged = baseFor('validate', published.respondents);
      expect({ id: published.id, published: published.priceUsd })
        .toEqual({ id: published.id, published: charged });
      expect(published.priceCents).toBe(Math.round(charged * 100));
    }
    expect(priced).toBeGreaterThan(0); // no vacuous pass if every tier went custom
  });

  test('the three tiers that actually drifted publish the corrected figures', () => {
    // Pinned literals. If the ladder is repriced these must be updated
    // deliberately — that is the point of pinning them.
    const byId = Object.fromEntries(getActiveTierTable().tiers.map((t) => [t.id, t]));
    expect(byId.deep_dive.priceUsd).toBe(300);
    expect(byId.scale.priceUsd).toBe(900);
    expect(byId.deep_dive.fromLabel).toBe('$300');
    expect(byId.scale.fromLabel).toBe('$900'); // rendered verbatim into /terms
    // Enterprise anchors at 5,000, above the self-serve ceiling, so it no
    // longer carries a price. $1,990 was stale; $2,000 was correct but
    // unsellable. "Custom" is the only honest third option.
    expect(byId.enterprise.custom).toBe(true);
    expect(byId.enterprise.priceUsd).toBeNull();
  });
});
