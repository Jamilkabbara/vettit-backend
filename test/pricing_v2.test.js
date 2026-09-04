/**
 * PR A — flag-gated canonical pricing module.
 *
 * Three guarantees:
 *   1. PRICING_V2 OFF (default): calculateMissionPrice charges EXACTLY what it
 *      charged before (V1 golden values) — deploying the module changes nothing.
 *   2. The min-order clamp: a flat promo can never drive the charge to $0/below.
 *   3. PRICING_V2 ON: one canonical package ladder for EVERY goal type, exact
 *      amount-in-cents per tier, brand_lift repriced off sample size, the
 *      Enterprise tier is a custom quote.
 */

describe('PRICING_V2 OFF (default) — V1 charge is unchanged', () => {
  const { calculateMissionPrice, getActiveTierTable } = require('../src/utils/pricingEngine');

  test.each([
    [5, 'validate', 9],     // sniff bracket: 5 * 1.80
    [10, 'validate', 35],   // validate: 10 * 3.50
    [50, 'validate', 99],   // confidence: 50 * 1.98
    [250, 'validate', 300], // deep dive: 250 * 1.20 = $300 (note: V1 CHARGE is rate x count,
                            // which already drifts from the $299 display packagePrice — V2 fixes this)
  ])('validate %i respondents charges $%i (V1 rate x count)', (count, goalType, expected) => {
    const p = calculateMissionPrice({ respondentCount: count, goalType });
    expect(p.total).toBeCloseTo(expected, 2);
    expect(p.totalCents).toBe(expected * 100);
    expect(p.customQuote).toBe(false);
  });

  test('brand_lift keeps its V1 ladder when the flag is off (Tracker 200 = $300)', () => {
    // Was Pulse 50 = $99. The brand_lift floor moved to 100, so Pulse's anchor
    // is no longer buyable; the V1-ladder assertion moves to the cheapest
    // count that IS buyable. What is being pinned here is unchanged: with the
    // flag off, brand_lift prices off BRAND_LIFT_TIERS, not the default ladder.
    const p = calculateMissionPrice({ respondentCount: 200, goalType: 'brand_lift' });
    expect(p.total).toBeCloseTo(300, 2);
  });

  test('brand_lift below the floor refuses rather than pricing off another ladder', () => {
    expect(() => calculateMissionPrice({ respondentCount: 50, goalType: 'brand_lift' }))
      .toThrow(/at least 100 respondents/);
  });

  test('getActiveTierTable reports v1 and projects VOLUME_TIERS', () => {
    const t = getActiveTierTable();
    expect(t.version).toBe('v1');
    expect(t.flagActive).toBe(false);
    expect(t.startingFromCents).toBe(900);
    expect(t.tiers.find((x) => x.id === 'sniff_test').priceCents).toBe(900);
  });

  test('flag off: flat $10 promo on a $9 order is UNCHANGED from today (nets $0, checkout then rejects)', () => {
    // The min-order clamp is gated behind PRICING_V2 so flag-off is byte-
    // identical to production. With the flag off a flat discount still caps at
    // the subtotal and may reach $0; the create-checkout route rejects a sub-
    // $0.50 charge. The $1 clamp is asserted in the PRICING_V2 ON block below.
    const p = calculateMissionPrice({
      respondentCount: 5, goalType: 'validate',
      promoCode: { code: 'FRIEND10', type: 'flat', value: 10, active: true },
    });
    expect(p.subtotal).toBeCloseTo(9, 2);
    expect(p.total).toBeCloseTo(0, 2);     // unchanged V1 behaviour, not clamped
    expect(p.totalCents).toBe(0);
  });

  test('clamp leaves a normal flat promo untouched (flat $5 on $35 = $30)', () => {
    const p = calculateMissionPrice({
      respondentCount: 10, goalType: 'validate',
      promoCode: { type: 'flat', value: 5, active: true },
    });
    expect(p.total).toBeCloseTo(30, 2);
  });

  test('percentage/free promos may still reach $0 (owner-controlled)', () => {
    const free = calculateMissionPrice({
      respondentCount: 5, goalType: 'validate',
      promoCode: { type: 'free', value: 100, active: true },
    });
    expect(free.total).toBe(0);
  });
});

describe('PRICING_V2 ON — one canonical ladder, exact cents', () => {
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
  ])('%i respondents charges the canonical tier (%s = %i cents)', (count, _name, cents) => {
    const p = engine.calculateMissionPrice({ respondentCount: count, goalType: 'validate' });
    expect(p.totalCents).toBe(cents);
    expect(p.customQuote).toBe(false);
  });

  test('between anchors the count lands in the next bracket up (30 -> Confidence $149)', () => {
    expect(engine.calculateMissionPrice({ respondentCount: 30, goalType: 'validate' }).totalCents).toBe(14900);
  });

  test('one ladder for ALL goal types: brand_lift 100 reprices to Confidence $149 (was $99)', () => {
    const bl = engine.calculateMissionPrice({ respondentCount: 100, goalType: 'brand_lift' });
    expect(bl.totalCents).toBe(14900);
  });

  test('Enterprise tier (1000 respondents) is a custom quote, blocked from self-serve checkout', () => {
    const p = engine.calculateMissionPrice({ respondentCount: 1000, goalType: 'validate' });
    expect(p.customQuote).toBe(true);
    const v = engine.validateMissionPricing({ goalType: 'validate', respondentCount: 1000 });
    expect(v.valid).toBe(false);
    expect(v.error).toMatch(/custom quote|contact sales/i);
  });

  test('Scale (500) is still self-serve', () => {
    expect(engine.validateMissionPricing({ goalType: 'validate', respondentCount: 500 }).valid).toBe(true);
  });

  test('getActiveTierTable reports v2 with the locked prices + per-card "from" labels', () => {
    const t = engine.getActiveTierTable();
    expect(t.version).toBe('v2');
    expect(t.flagActive).toBe(true);
    expect(t.startingFromCents).toBe(900);
    const by = Object.fromEntries(t.tiers.map((x) => [x.id, x]));
    expect(by.validate.priceCents).toBe(3900);
    expect(by.validate.fromLabel).toBe('$39');
    expect(by.confidence.priceCents).toBe(14900);
    expect(by.scale.fromLabel).toBe('$499');
    expect(by.enterprise.custom).toBe(true);
    expect(by.enterprise.fromLabel).toBe('Custom');
  });

  test('V2 returns ratePerResp null (flat tier pricing, never a stale V1 per-resp rate)', () => {
    const p = engine.calculateMissionPrice({ respondentCount: 100, goalType: 'validate' });
    expect(p.ratePerResp).toBeNull();
  });

  test('clamp still holds under V2: flat $50 on a $9 sniff charges $1', () => {
    const p = engine.calculateMissionPrice({
      respondentCount: 5, goalType: 'validate',
      promoCode: { type: 'flat', value: 50, active: true },
    });
    expect(p.totalCents).toBe(100);
  });
});
