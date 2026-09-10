/**
 * The quote a customer READS must come off the same ladder as the charge they
 * PAY.
 *
 * Every call site of calculateMissionPrice passed the mission's goal_type
 * except one: POST /api/pricing/quote, where it was gated behind
 * `PRICING_V2_ACTIVE ? { goalType, mediaType } : {}`. PRICING_V2 was false on
 * every deploy of its life, so the gate meant "never pass it", and /quote
 * priced every mission off the DEFAULT ladder while /payments and
 * /missions/launch priced it off the goal's own.
 *
 * That is a live divergence between the number on the screen and the number on
 * the card, in both directions:
 *
 *   brand_lift         n=200  quoted $239.20  charged $300.00   (+$60.80)
 *   creative_attention n=50   quoted  $74.50  charged  $69.00   (-$5.50)
 *
 * The frontend reconciles a quote against its own client-side computation and
 * accepts the SERVER number whenever they differ by more than $0.02, so the
 * customer saw $239.20 right up to the Stripe page.
 *
 * These tests pin the fix at the route, not at the engine, because the engine
 * was never wrong — the argument was missing.
 */
const express = require('express');
const request = require('supertest');

jest.mock('../src/middleware/auth', () => ({
  authenticate: (req, _res, next) => { req.user = { id: 'u1' }; next(); },
  optionalAuthenticate: (req, _res, next) => { req.user = { id: 'u1' }; next(); },
}));
jest.mock('../src/utils/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

let mockMissionRow = null;
jest.mock('../src/db/supabase', () => ({
  from: () => ({
    select: () => ({
      eq: function () { return this; },
      single: async () => (mockMissionRow
        ? { data: mockMissionRow, error: null }
        : { data: null, error: { message: 'not found' } }),
    }),
  }),
}));

const { calculateMissionPrice } = require('../src/utils/pricingEngine');
const pricingRouter = require('../src/routes/pricing');

const app = express();
app.use(express.json());
app.use('/api/pricing', pricingRouter);

const quote = (missionId = 'm1') =>
  request(app).post('/api/pricing/quote').send({ missionId });

/** What the money paths charge for the same row. */
const charged = (goal_type, respondent_count, media_type = null) =>
  calculateMissionPrice({
    goalType: goal_type,
    mediaType: media_type,
    respondentCount: respondent_count,
    questionCount: 5,
    targeting: {},
    countries: [],
  }).total;

const row = (goal_type, respondent_count, media_type = null) => ({
  respondent_count, goal_type, media_type,
  targeting: {}, target_audience: {}, questions: Array(5).fill({}), user_id: 'u1',
});

describe('POST /api/pricing/quote uses the mission goal type', () => {
  test('brand_lift n=200 quotes $300, the Tracker price, not the default ladder', async () => {
    mockMissionRow = row('brand_lift', 200);
    const res = await quote();
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(300);
    expect(res.body.total).toBe(charged('brand_lift', 200));
    // The number it used to publish. Pinned so a regression is unmistakable.
    expect(res.body.total).not.toBe(239.20);
  });

  test('creative_attention quotes the per-creative price, not a respondent tier', async () => {
    // Was $69 at n=50 on the retired respondent ladder. Creative Attention is
    // priced per creative now, so the count does not move the number.
    mockMissionRow = row('creative_attention', 50, 'image');
    const img = await quote();
    expect(img.status).toBe(200);
    expect(img.body.total).toBe(19);
    expect(img.body.total).toBe(charged('creative_attention', 50, 'image'));
    expect(img.body.total).not.toBe(74.50);   // the default ladder at n=50

    mockMissionRow = row('creative_attention', 50, 'video');
    const vid = await quote();
    expect(vid.body.total).toBe(49);
  });

  test('the two goals diverge from the default ladder in OPPOSITE directions', async () => {
    // So a regression to the default ladder cannot pass both assertions by
    // coincidence.
    const dflt200 = charged('validate', 200);
    const dflt50  = charged('validate', 50);
    expect(charged('brand_lift', 200)).toBeGreaterThan(dflt200);
    expect(charged('creative_attention', 50, 'image')).toBeLessThan(dflt50);
  });

  test.each([
    ['validate', 250, 299],
    ['marketing', 100, 149],
    ['compare', 5, 9],
  ])('%s n=%i quotes the default-ladder price $%s', async (goal_type, n, expected) => {
    mockMissionRow = row(goal_type, n);
    const res = await quote();
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(expected);
    expect(res.body.total).toBe(charged(goal_type, n));
  });

  test('the base breakdown line multiplies out to the base it charged', async () => {
    // 499/500 = $0.998. Rendered with toFixed(2) the receipt would read
    // "500 respondents x $1.00" against a $499 base.
    mockMissionRow = row('validate', 500);
    const res = await quote();
    expect(res.status).toBe(200);
    const line = res.body.breakdown[0];
    const rate = Number(line.label.match(/\$([\d.]+)/)[1]);
    expect(Math.round(rate * 500 * 100) / 100).toBe(line.amount);
    expect(line.amount).toBe(499);
  });

  test('above the self-serve cap the quote refuses instead of publishing a price', async () => {
    // This asserted 200 + customQuote until the fail-closed gate was added to
    // this route. A refusal is now a 400 carrying the reason and the
    // lead-capture destination, which is the same answer create-checkout-session
    // and free-launch give. Either way the invariant this test exists for holds:
    // no price is published for a study that cannot be bought.
    mockMissionRow = row('validate', 3000);
    const res = await quote();
    expect(res.status).toBe(400);
    expect(res.body.total).toBeNull();
    expect(res.body.error).toMatch(/managed engagement|contact sales/i);
    expect(res.body.leadCapture).toBeTruthy();
  });
});
