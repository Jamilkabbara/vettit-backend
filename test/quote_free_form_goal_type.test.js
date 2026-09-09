/**
 * The in-app promo field quotes a mission that does not exist yet.
 *
 * POST /api/pricing/quote has two branches. The DB-backed one (missionId)
 * reads goal_type off the row. The FREE-FORM one — the branch the promo field
 * on the Creative Attention pay step actually calls, because the mission is
 * not created until the customer clicks Pay — used to build its stub row with
 * only `targeting`. So goal_type and media_type arrived at
 * calculateMissionPrice as undefined, and every free-form quote was priced off
 * the DEFAULT ladder no matter what the caller asked for.
 *
 * Measured against production on 2026-09-08, with the exact body the field
 * sends:
 *
 *   {goalType:'creative_attention', respondentCount:10, mediaType:'image'}
 *     quoted  $35.00   (default ladder, 10 x $3.50)
 *     charged $19.00   (Creative Attention ladder)
 *
 * So the panel offered a discount against $35 while the button beside it said
 * $19. A free code resolved to $0 either way, which is why the free path still
 * worked and the wrong number went unnoticed; a percentage code would have
 * discounted the wrong base.
 */
const express = require('express');
const request = require('supertest');

jest.mock('../src/middleware/auth', () => ({
  authenticate: (req, _res, next) => { req.user = { id: 'u1' }; next(); },
  optionalAuthenticate: (req, _res, next) => { next(); },
}));
jest.mock('../src/utils/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

let mockPromoRow = null;
jest.mock('../src/db/supabase', () => ({
  from: () => ({
    select: () => ({
      eq: function () { return this; },
      single: async () => ({ data: mockPromoRow, error: mockPromoRow ? null : { message: 'none' } }),
    }),
  }),
}));

const { calculateMissionPrice } = require('../src/utils/pricingEngine');
const pricingRouter = require('../src/routes/pricing');
const errorHandler = require('../src/middleware/errorHandler');

const app = express();
app.use(express.json());
app.use('/api/pricing', pricingRouter);
app.use(errorHandler);

const quote = (body) => request(app).post('/api/pricing/quote').send(body);

/** What the money paths charge for the same study. */
const charged = (goalType, respondentCount, mediaType) => calculateMissionPrice({
  goalType, mediaType, respondentCount, questionCount: 5, targeting: {}, countries: [],
}).total;

beforeEach(() => { mockPromoRow = null; });

describe('free-form quote honours the caller goal type', () => {
  test('creative_attention n=10 image quotes $19, the CA ladder, not the default $35', async () => {
    const res = await quote({ goalType: 'creative_attention', respondentCount: 10, mediaType: 'image', questionCount: 0 });
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(19);
    expect(res.body.total).toBe(charged('creative_attention', 10, 'image'));
    // The number production actually returned. Pinned so the regression is loud.
    expect(res.body.total).not.toBe(35);
  });

  test('brand_lift n=200 quotes $300, the Tracker price, not the default $239.20', async () => {
    const res = await quote({ goalType: 'brand_lift', respondentCount: 200, questionCount: 5 });
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(300);
    expect(res.body.total).toBe(charged('brand_lift', 200));
    expect(res.body.total).not.toBe(239.20);
  });

  test('neither goal can be satisfied by the default ladder', async () => {
    // Originally "diverge in OPPOSITE directions": brand_lift above the default,
    // creative_attention below it. The 2026-09 reprice flipped the second one.
    // The default ladder at ten respondents was $35 and is now $15.60, so
    // Creative Attention's $19 went from cheaper than the default to dearer
    // than it. That is a real consequence of pricing a per-creative product on
    // a respondent ladder, and it is why the CA ladder is being replaced.
    //
    // What this test is for is unchanged: a regression to the default ladder
    // must not satisfy both goals by coincidence. Pinning both distances does
    // that regardless of sign.
    expect(charged('brand_lift', 200)).toBeGreaterThan(charged('validate', 200));
    expect(charged('creative_attention', 10, 'image')).not.toBe(charged('validate', 10));
    expect(charged('validate', 10)).toBe(15.60);
    expect(charged('creative_attention', 10, 'image')).toBe(19);
    expect(charged('brand_lift', 200)).toBe(300);
    expect(charged('validate', 200)).toBe(239.20);
  });

  test('omitting goalType keeps the old lenient default-ladder behaviour', async () => {
    // A bare respondent-count quote is still a legitimate caller.
    const res = await quote({ respondentCount: 250, questionCount: 5 });
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(charged('validate', 250));
  });
});

describe('a quote runs the same methodology gate the money paths run', () => {
  test('creative_attention below its 10-respondent floor is refused, not priced', async () => {
    const res = await quote({ goalType: 'creative_attention', respondentCount: 1, mediaType: 'image', questionCount: 0 });
    expect(res.status).toBe(400);
    expect(res.body.total).toBeNull();
    expect(res.body.error).toMatch(/10/);
  });

  test('creative_attention without a media type is refused', async () => {
    const res = await quote({ goalType: 'creative_attention', respondentCount: 50, questionCount: 0 });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/media_type/);
  });

  test('brand_lift below its 100-respondent floor is refused', async () => {
    const res = await quote({ goalType: 'brand_lift', respondentCount: 50, questionCount: 5 });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/100/);
  });

  test('above the self-serve cap the quote refuses and carries the lead-capture destination', async () => {
    const res = await quote({ goalType: 'validate', respondentCount: 3000, questionCount: 5 });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/managed engagement|contact sales/i);
    expect(res.body.leadCapture).toBeTruthy();
  });
});

describe('promo applied to a free-form quote', () => {
  test('a free code takes a CA quote to $0 and discounts the CA price, not the default one', async () => {
    mockPromoRow = { code: 'VETTPROOF', type: 'free', value: 100, active: true, uses_count: 0, max_uses: 25, expires_at: null };
    const res = await quote({
      goalType: 'creative_attention', respondentCount: 10, mediaType: 'image',
      questionCount: 0, promoCode: 'VETTPROOF',
    });
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(0);
    // The discount line is what the panel renders as the struck-through price.
    expect(res.body.details.subtotal).toBe(19);
    expect(res.body.details.discount).toBe(19);
  });

  test('a percentage code discounts the CA base, which is the case the bug actually broke', async () => {
    // A free code hits $0 off either ladder, so it hid this. 50% off $19 is
    // $9.50; off the wrongly-quoted $35 it would have read $17.50.
    mockPromoRow = { code: 'HALF', type: 'percentage', value: 50, active: true, uses_count: 0, max_uses: null, expires_at: null };
    const res = await quote({
      goalType: 'creative_attention', respondentCount: 10, mediaType: 'image',
      questionCount: 0, promoCode: 'HALF',
    });
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(9.50);
    expect(res.body.total).not.toBe(17.50);
  });
});
