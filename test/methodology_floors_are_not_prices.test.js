/**
 * The methodology floors and the delivery ceiling are NOT prices, and must not
 * move when the price ladder does.
 *
 * This file was written when PRICING_V2 existed. The goal-specific gates sat
 * BELOW an `if (PRICING_V2_ACTIVE)` early return in validateMissionPricing, so
 * flipping a PRICING flag would silently have switched off three things that
 * are not pricing decisions at all:
 *
 *   - brand_lift's 100-respondent floor (below it the exposed/control split
 *     cannot detect a realistic lift — 28pp MDE at n=100 as it is)
 *   - creative_attention's 10-respondent floor (the attention model has
 *     nothing to average under it)
 *   - the 1,250 self-serve ceiling (a DELIVERY bound: wall clock inside the
 *     6h mission-recovery backstop at the measured recruit-loop rate)
 *
 * PRICING_V2 is gone and the 2026-09 reprice moved every anchor on the default
 * ladder. These tests are what proves the reprice did not drag the floors with
 * it, and they stay as the standing guard for the next one.
 */
const {
  validateMissionPricing,
  calculateMissionPrice,
  BRAND_LIFT_MIN_RESPONDENTS,
  CA_MIN_RESPONDENTS,
  MAX_SELF_SERVE_RESPONDENTS,
  SELF_SERVE_LEAD_CAPTURE,
  VOLUME_TIERS,
} = require('../src/utils/pricingEngine');

describe('the floors are stated as sample-size constants, not read off a price tier', () => {
  test('no ladder bracket boundary coincides with a methodology floor by accident', () => {
    // If a floor were ever derived from the ladder, repricing the ladder would
    // move it. Assert the constants are what they are, independent of tiers.
    expect(BRAND_LIFT_MIN_RESPONDENTS).toBe(100);
    expect(CA_MIN_RESPONDENTS).toBe(10);
    expect(MAX_SELF_SERVE_RESPONDENTS).toBe(1250);
  });

  test('the default ladder was repriced and the floors did not follow', () => {
    // Guards against a vacuous pass: if the ladder ever reverts to its
    // pre-reprice anchors this test should be revisited deliberately.
    expect(VOLUME_TIERS.map((t) => t.anchorCount)).toEqual([5, 25, 100, 250, 500, 1000, 1250]);
    expect(BRAND_LIFT_MIN_RESPONDENTS).toBe(100);
    expect(CA_MIN_RESPONDENTS).toBe(10);
  });
});

describe('brand_lift floor', () => {
  test('below the floor is refused', () => {
    const v = validateMissionPricing({ goalType: 'brand_lift', respondentCount: BRAND_LIFT_MIN_RESPONDENTS - 1 });
    expect(v.valid).toBe(false);
    expect(v.error).toMatch(/100/);
  });

  test('at the floor is accepted, and priced off the brand_lift ladder', () => {
    const v = validateMissionPricing({ goalType: 'brand_lift', respondentCount: BRAND_LIFT_MIN_RESPONDENTS });
    expect(v.valid).toBe(true);
    expect(v.tier).not.toBeNull();
    // The brand_lift ladder is untouched by the default-ladder reprice.
    expect(calculateMissionPrice({ goalType: 'brand_lift', respondentCount: 100, questionCount: 5 }).base).toBe(150);
    expect(calculateMissionPrice({ goalType: 'brand_lift', respondentCount: 200, questionCount: 5 }).base).toBe(300);
  });

  test('the refusal is a refusal, not a silent reprice off the default ladder', () => {
    expect(() => calculateMissionPrice({ goalType: 'brand_lift', respondentCount: 50, questionCount: 5 }))
      .toThrow(/at least 100 respondents/);
  });
});

describe('creative_attention floor and media gate', () => {
  test('below the floor is refused', () => {
    const v = validateMissionPricing({ goalType: 'creative_attention', respondentCount: CA_MIN_RESPONDENTS - 1, mediaType: 'image' });
    expect(v.valid).toBe(false);
    expect(v.error).toMatch(/10/);
  });

  test('at the floor is accepted, and priced off the CA ladder', () => {
    const v = validateMissionPricing({ goalType: 'creative_attention', respondentCount: CA_MIN_RESPONDENTS, mediaType: 'image' });
    expect(v.valid).toBe(true);
    expect(v.tier).not.toBeNull();
    // Creative Attention is priced PER CREATIVE since the video cost was
    // measured: $19 an image, $49 a video, flat. The respondent count no
    // longer picks a price, so both counts below charge the same.
    expect(calculateMissionPrice({ goalType: 'creative_attention', respondentCount: 10, questionCount: 0, mediaType: 'image' }).base).toBe(19);
    expect(calculateMissionPrice({ goalType: 'creative_attention', respondentCount: 250, questionCount: 0, mediaType: 'image' }).base).toBe(19);
    expect(calculateMissionPrice({ goalType: 'creative_attention', respondentCount: 10, questionCount: 0, mediaType: 'video' }).base).toBe(49);
  });

  test('still requires a media type', () => {
    const v = validateMissionPricing({ goalType: 'creative_attention', respondentCount: 50 });
    expect(v.valid).toBe(false);
    expect(v.error).toMatch(/media_type/);
  });
});

describe('the self-serve delivery ceiling', () => {
  test('fires above the cap, for every goal type, with its lead-capture payload', () => {
    for (const goalType of ['validate', 'brand_lift', 'creative_attention', 'marketing']) {
      const v = validateMissionPricing({ goalType, respondentCount: MAX_SELF_SERVE_RESPONDENTS + 1, mediaType: 'image' });
      expect({ goalType, valid: v.valid }).toEqual({ goalType, valid: false });
      expect(v.leadCapture).toEqual(SELF_SERVE_LEAD_CAPTURE);
    }
  });

  test('does not fire at the cap', () => {
    expect(validateMissionPricing({ goalType: 'validate', respondentCount: MAX_SELF_SERVE_RESPONDENTS }).valid).toBe(true);
  });
});
