/**
 * A PRICING flag must not be able to switch off a METHODOLOGY gate.
 *
 * validateMissionPricing used to early-return inside `if (PRICING_V2_ACTIVE)`
 * BEFORE the goal-specific blocks, so flipping PRICING_V2 would have silently
 * removed three gates that have nothing to do with what Stripe charges:
 *
 *   - the brand_lift respondent floor (BRAND_LIFT_MIN_RESPONDENTS = 100)
 *   - the creative_attention respondent floor (CA_MIN_RESPONDENTS = 10,
 *     enforced through resolveTier returning null)
 *   - the self-serve delivery ceiling (MAX_SELF_SERVE_RESPONDENTS)
 *
 * These are sample-size / delivery constraints: below them the analysis
 * cannot produce the thing the customer paid for. They are pinned here in
 * BOTH flag states. The V2 pricing behaviour that genuinely IS pricing (one
 * canonical ladder, exact cents, the 500+ custom-quote gate) is pinned
 * alongside them so the hoist cannot be "fixed" by neutering V2.
 *
 * PRICING_V2 stays OFF in production. This suite flips it in-process only.
 */

const CA_MEDIA = 'video';

describe('PRICING_V2 ON — methodology floors still fire', () => {
  let engine;
  beforeAll(() => {
    jest.resetModules();
    process.env.PRICING_V2 = 'true';
    engine = require('../src/utils/pricingEngine');
  });
  afterAll(() => {
    delete process.env.PRICING_V2;
    jest.resetModules();
  });

  test('the flag really is on for this block (guards against a vacuous pass)', () => {
    expect(engine.PRICING_V2_ACTIVE).toBe(true);
    expect(engine.getActiveTierTable().version).toBe('v2');
  });

  test('brand_lift below the floor is refused', () => {
    const v = engine.validateMissionPricing({ goalType: 'brand_lift', respondentCount: 50 });
    expect(v.valid).toBe(false);
    expect(v.error).toMatch(/at least 100 respondents/);
  });

  test.each([1, 25, 99])('brand_lift %i is refused (whole range below the floor)', (n) => {
    expect(engine.validateMissionPricing({ goalType: 'brand_lift', respondentCount: n }).valid).toBe(false);
  });

  test('brand_lift AT the floor is accepted', () => {
    expect(engine.validateMissionPricing({ goalType: 'brand_lift', respondentCount: 100 }).valid).toBe(true);
  });

  test('creative_attention below the floor is refused', () => {
    const v = engine.validateMissionPricing({
      goalType: 'creative_attention', respondentCount: 5, mediaType: CA_MEDIA,
    });
    expect(v.valid).toBe(false);
    expect(v.error).toMatch(/at least 10 respondents/);
  });

  test.each([1, 9])('creative_attention %i is refused (whole range below the floor)', (n) => {
    expect(engine.validateMissionPricing({
      goalType: 'creative_attention', respondentCount: n, mediaType: CA_MEDIA,
    }).valid).toBe(false);
  });

  test('creative_attention AT the floor is accepted', () => {
    expect(engine.validateMissionPricing({
      goalType: 'creative_attention', respondentCount: 10, mediaType: CA_MEDIA,
    }).valid).toBe(true);
  });

  test('creative_attention still requires a media type', () => {
    const v = engine.validateMissionPricing({ goalType: 'creative_attention', respondentCount: 100 });
    expect(v.valid).toBe(false);
    expect(v.error).toMatch(/media_type/);
  });

  test('the self-serve delivery ceiling still fires, with its lead-capture payload', () => {
    const above = engine.MAX_SELF_SERVE_RESPONDENTS + 1;
    const v = engine.validateMissionPricing({ goalType: 'validate', respondentCount: above });
    expect(v.valid).toBe(false);
    expect(v.error).toMatch(/managed engagement/);
    expect(v.leadCapture).toBeTruthy();
  });
});

describe('PRICING_V2 ON — the pricing behaviour that SHOULD survive still does', () => {
  let engine;
  beforeAll(() => {
    jest.resetModules();
    process.env.PRICING_V2 = 'true';
    engine = require('../src/utils/pricingEngine');
  });
  afterAll(() => {
    delete process.env.PRICING_V2;
    jest.resetModules();
  });

  test.each([
    [5, 'sniff', 900],
    [25, 'validate', 3900],
    [100, 'confidence', 14900],
    [500, 'scale', 49900],
  ])('%i respondents resolves the canonical V2 tier %s and charges %i cents', (count, id, cents) => {
    const v = engine.validateMissionPricing({ goalType: 'validate', respondentCount: count });
    expect(v.valid).toBe(true);
    expect(v.tier.id).toBe(id);
    expect(engine.calculateMissionPrice({ respondentCount: count, goalType: 'validate' }).totalCents).toBe(cents);
  });

  test('the 500+ custom-quote gate still blocks self-serve checkout', () => {
    const v = engine.validateMissionPricing({ goalType: 'validate', respondentCount: 1000 });
    expect(v.valid).toBe(false);
    expect(v.error).toMatch(/custom quote|contact sales/i);
  });

  test('a goal that clears its floor is priced off the CANONICAL ladder, not its V1 goal ladder', () => {
    // brand_lift 100 is Confidence ($149) under V2, not the V1 Pulse/Tracker
    // ladder. If the hoisted floor had dragged the V1 tier back into the V2
    // return, this id would be a brand_lift tier instead.
    const v = engine.validateMissionPricing({ goalType: 'brand_lift', respondentCount: 100 });
    expect(v.valid).toBe(true);
    expect(v.tier.id).toBe('confidence');
    expect(v.tier.priceCents).toBe(14900);
  });

  test('creative_attention above its floor also gets the canonical tier', () => {
    const v = engine.validateMissionPricing({
      goalType: 'creative_attention', respondentCount: 25, mediaType: CA_MEDIA,
    });
    expect(v.valid).toBe(true);
    expect(v.tier.id).toBe('validate');
    expect(v.tier.priceCents).toBe(3900);
  });
});

describe('PRICING_V2 OFF (production default) — floors unchanged, V1 tiers unchanged', () => {
  const engine = require('../src/utils/pricingEngine');

  test('the flag really is off for this block', () => {
    expect(engine.PRICING_V2_ACTIVE).toBe(false);
  });

  test('brand_lift below the floor is refused', () => {
    const v = engine.validateMissionPricing({ goalType: 'brand_lift', respondentCount: 50 });
    expect(v.valid).toBe(false);
    expect(v.error).toMatch(/at least 100 respondents/);
  });

  test('brand_lift above the floor still resolves a V1 brand_lift tier', () => {
    const v = engine.validateMissionPricing({ goalType: 'brand_lift', respondentCount: 200 });
    expect(v.valid).toBe(true);
    expect(v.tier.id).toBe('tracker');
  });

  test('creative_attention below the floor is refused', () => {
    const v = engine.validateMissionPricing({
      goalType: 'creative_attention', respondentCount: 5, mediaType: CA_MEDIA,
    });
    expect(v.valid).toBe(false);
    expect(v.error).toMatch(/at least 10 respondents/);
  });

  test('creative_attention above the floor still resolves a V1 CA tier', () => {
    const v = engine.validateMissionPricing({
      goalType: 'creative_attention', respondentCount: 25, mediaType: CA_MEDIA,
    });
    expect(v.valid).toBe(true);
    expect(v.tier.id).toBe('validate');
    expect(v.tier.packagePrice).toBe(39);
  });

  test('the self-serve ceiling still fires', () => {
    const v = engine.validateMissionPricing({
      goalType: 'validate', respondentCount: engine.MAX_SELF_SERVE_RESPONDENTS + 1,
    });
    expect(v.valid).toBe(false);
    expect(v.leadCapture).toBeTruthy();
  });
});
