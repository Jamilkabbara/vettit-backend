/**
 * validateMissionPricing computed the Creative Attention answer correctly and
 * then discarded it.
 *
 *   const tier = resolveTier({ goalType, mediaType });   // no respondentCount
 *   return { valid: true, tier };                        // valid regardless
 *
 * resolveTier received respondentCount: undefined, coerced it to 0, saw
 * 0 < CA_MIN_RESPONDENTS, and correctly returned null - the documented
 * "invalid combo" signal. The very next line returned valid: true anyway, so
 * the null never reached a caller as a rejection. The CA floor of 10 has
 * therefore never been enforced at checkout, while the brand_lift floor
 * immediately below it in the same function IS enforced.
 *
 * The consequence is not an undercharge. CA is flat-priced per bracket, and a
 * null tier falls back to CREATIVE_ATTENTION_TIERS[0].packagePrice, so a
 * 1-respondent CA study is charged the FULL $19 Sniff Test price. The defect
 * is that it sells a statistically empty study at list price.
 *
 * The invariant test below is the one that matters: valid: true and tier: null
 * is a contradiction in this function's own contract, whatever the goal.
 */
const {
  validateMissionPricing,
  calculateMissionPrice,
  CA_MIN_RESPONDENTS,
} = require('../src/utils/pricingEngine');

const ca = (n) => validateMissionPricing({
  goalType: 'creative_attention', respondentCount: n, mediaType: 'image',
});

describe('the CA floor is enforced at checkout, not just computed', () => {
  test.each([0, 1, 2, 5, 9])('creative_attention n=%i is refused', (n) => {
    expect(ca(n).valid).toBe(false);
  });

  test('the refusal names the floor so the UI can render it', () => {
    expect(String(ca(1).error)).toContain(String(CA_MIN_RESPONDENTS));
  });

  test('n=1 is no longer priceable at all', () => {
    // This assertion used to read `.total).toBe(19)` - the full flat Sniff
    // Test price the old valid:true path let through for a 1-respondent
    // study. Not an undercharge: the defect was selling an empty study at
    // list price. The follow-on PR that makes a null tier throw removed the
    // silent packagePrice fallback that produced that $19, and this is the
    // one caller in the tree that the removal surfaced. Kept as a pin on the
    // charge that used to be possible.
    expect(() => calculateMissionPrice({
      goalType: 'creative_attention', respondentCount: 1, mediaType: 'image',
    })).toThrow(/at least 10 respondents/);
  });
});

// ── The invariant the bug violated ──────────────────────────────────────────

describe('validateMissionPricing never returns valid: true with a null tier', () => {
  const combos = [];
  for (const goalType of ['creative_attention', 'brand_lift', 'validate', 'naming_messaging', 'marketing']) {
    for (const respondentCount of [0, 1, 5, 9, 10, 25, 49, 50, 100, 200, 500]) {
      combos.push([goalType, respondentCount]);
    }
  }
  test.each(combos)('%s n=%i', (goalType, respondentCount) => {
    const v = validateMissionPricing({ goalType, respondentCount, mediaType: 'image' });
    if (v.valid) expect(v.tier).not.toBeNull();
  });
});

// ── POSITIVE CONTROL ────────────────────────────────────────────────────────
//
// Without these, a change that simply refused every creative_attention
// mission - or every mission - would satisfy every assertion above.

describe('positive control - legal missions still validate, with a real tier', () => {
  test.each([
    [10,  'sniff_test',   19],
    [25,  'validate',     39],
    [50,  'confidence',   69],
    [100, 'deep_dive',    129],
    [250, 'deep_dive_xl', 299],
  ])('creative_attention n=%i is valid on tier %s at $%i', (n, tierId, price) => {
    const v = ca(n);
    expect(v.valid).toBe(true);
    expect(v.tier.id).toBe(tierId);
    expect(calculateMissionPrice({
      goalType: 'creative_attention', respondentCount: n, mediaType: 'image',
    }).total).toBe(price);
  });

  test('brand_lift keeps its own floor and its own ladder', () => {
    expect(validateMissionPricing({ goalType: 'brand_lift', respondentCount: 49 }).valid).toBe(false);
    const ok = validateMissionPricing({ goalType: 'brand_lift', respondentCount: 200 });
    expect(ok.valid).toBe(true);
    expect(ok.tier.id).toBe('tracker');
  });

  test('the default ladder is untouched', () => {
    const v = validateMissionPricing({ goalType: 'validate', respondentCount: 5 });
    expect(v.valid).toBe(true);
    expect(v.tier.id).toBe('sniff_test');
    expect(calculateMissionPrice({ goalType: 'validate', respondentCount: 5 }).total).toBe(9);
  });

  test('creative_attention still requires a media_type, and that check fires first', () => {
    const v = validateMissionPricing({ goalType: 'creative_attention', respondentCount: 50, mediaType: null });
    expect(v.valid).toBe(false);
    expect(v.error).toMatch(/media_type/);
  });
});
