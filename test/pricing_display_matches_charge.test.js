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
  MAX_SELF_SERVE_RESPONDENTS,
} = require('../src/utils/pricingEngine');

const round2 = (v) => Math.round(v * 100) / 100;

/** base price only — 5 questions is the free allowance, no targeting. */
const baseFor = (goalType, n) =>
  calculateMissionPrice({ goalType, respondentCount: n, questionCount: 5, targeting: {} }).base;

describe('public price display equals the charged price', () => {
  test('the tiers endpoint is serving the live ladder (guards the assertions below)', () => {
    // If a second ladder is ever introduced behind a flag again, these
    // assertions would describe a ladder that is no longer served and would
    // pass vacuously. Fail loudly instead.
    expect(getActiveTierTable().version).toBe('v1');
    expect(getActiveTierTable().tiers.map((t) => t.id)).toEqual(VOLUME_TIERS.map((t) => t.id));
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

  test('every published anchor is a round dollar price', () => {
    // The point of the 2026-09 reprice: the customer-facing number is chosen
    // first and the rate is derived from it, so no published anchor may carry
    // cents. This is the invariant that keeps a future rate tweak from
    // reintroducing "$968.75".
    const { tiers } = getActiveTierTable();
    expect(tiers.length).toBeGreaterThan(0);
    for (const t of tiers) {
      if (t.custom) continue;
      expect({ id: t.id, cents: t.priceCents % 100 }).toEqual({ id: t.id, cents: 0 });
    }
  });

  test('the repriced ladder publishes its pinned figures', () => {
    // Pinned literals. If the ladder is repriced these must be updated
    // deliberately — that is the point of pinning them.
    const byId = Object.fromEntries(getActiveTierTable().tiers.map((t) => [t.id, t]));
    expect(byId.sniff_test.priceUsd).toBe(9);
    expect(byId.validate.priceUsd).toBe(39);
    expect(byId.confidence.priceUsd).toBe(149);
    expect(byId.deep_dive.priceUsd).toBe(299);
    expect(byId.scale.priceUsd).toBe(499);
    expect(byId.growth.priceUsd).toBe(899);
    expect(byId.enterprise.priceUsd).toBe(1099);
    // fromLabel is rendered verbatim into /terms.
    expect(byId.deep_dive.fromLabel).toBe('$299');
    expect(byId.enterprise.fromLabel).toBe('$1,099');
  });

  test('the top bracket anchors AT the self-serve cap, so nothing published is unsellable', () => {
    // The old ladder anchored Enterprise at 5,000 — above the cap — so the
    // endpoint had to publish "Custom" for it. Anchoring at the cap means
    // every published price is a price a customer can actually pay.
    const byId = Object.fromEntries(getActiveTierTable().tiers.map((t) => [t.id, t]));
    expect(byId.enterprise.respondents).toBe(MAX_SELF_SERVE_RESPONDENTS);
    expect(byId.enterprise.custom).toBe(false);
    for (const t of getActiveTierTable().tiers) {
      expect({ id: t.id, sellable: t.respondents <= MAX_SELF_SERVE_RESPONDENTS })
        .toEqual({ id: t.id, sellable: true });
    }
  });
});
