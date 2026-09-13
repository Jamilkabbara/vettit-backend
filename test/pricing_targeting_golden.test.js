/**
 * Prices and targeting behaviour, pinned.
 *
 * The owner's rule for the Creative Attention placement/market work: a test
 * must fail if a Creative Attention price moves off its flat $19 / $49, or if
 * any other mission type's price or targeting behaviour changes.
 *
 * The golden file was generated from main BEFORE that work (see
 * scripts/generate-pricing-targeting-golden.js). It is compared case by case
 * so a failure names the exact goal type, count, targeting and promo that
 * moved, rather than reporting one giant object mismatch.
 */
const golden = require('./fixtures/pricing_targeting_golden.json');
const { buildGolden } = require('./helpers/pricingTargetingGolden');
const engine = require('../src/utils/pricingEngine');

describe('Creative Attention flat prices', () => {
  // Stated outright, independent of the golden file, so the two numbers the
  // public site quotes are readable in the test itself.
  const price = (mediaType, extra = {}) => engine.calculateMissionPrice({
    respondentCount: 10, questionCount: 0, targeting: {}, countries: [],
    goalType: 'creative_attention', mediaType, ...extra,
  }).total;

  test('an image is $19', () => expect(price('image')).toBe(19));
  test('a video is $49', () => expect(price('video')).toBe(49));

  test('placement, market and audience fields do not reach the price', () => {
    // The money routes build their inputs from the mission row; none of them
    // reads the Creative Attention columns. Passing them through anyway
    // proves the engine ignores them rather than relying on nobody passing
    // them.
    const withFields = { ca_placement: 'tiktok_feed', ca_market: 'SA', ca_target_audience: 'Mothers in Saudi' };
    expect(price('image', withFields)).toBe(19);
    expect(price('video', withFields)).toBe(49);
  });
});

describe('pricing and targeting behaviour matches the pre-change snapshot', () => {
  const now = buildGolden();

  test('the snapshot covers the same cases', () => {
    expect(Object.keys(now.cases).sort()).toEqual(Object.keys(golden.cases).sort());
  });

  test('every priced case is unchanged', () => {
    const moved = [];
    for (const key of Object.keys(golden.cases)) {
      if (JSON.stringify(now.cases[key]) !== JSON.stringify(golden.cases[key])) {
        moved.push(`${key}\n      was ${JSON.stringify(golden.cases[key])}\n      now ${JSON.stringify(now.cases[key])}`);
      }
    }
    if (moved.length) {
      throw new Error(`${moved.length} priced case(s) changed:\n  ${moved.slice(0, 10).join('\n  ')}` +
        (moved.length > 10 ? `\n  ...and ${moved.length - 10} more` : ''));
    }
  });

  test('countries are read from a mission row exactly as before', () => {
    expect(now.countries).toEqual(golden.countries);
  });

  test('no existing column changed between client-writable and server-owned', () => {
    expect(now.schema).toEqual(golden.schema);
  });
});
