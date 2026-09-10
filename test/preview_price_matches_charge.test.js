/**
 * Three surfaces answer "what does this cost", and they must agree.
 *
 *   POST /api/pricing/quote                the in-app promo panel
 *   POST /api/missions/calculate-price     the preview
 *   calculateMissionPrice(...)             what create-checkout-session and
 *                                          /missions/launch charge
 *
 * They have diverged twice. First the quote endpoint gated goalType behind a
 * flag that was never on, so brand_lift was quoted $239.20 and charged $300.
 * Then per-creative Creative Attention pricing made a second, older omission
 * live: calculate-price never passed mediaType, so it answered $19 - the image
 * price - for a video that checkout charges $49 for.
 *
 * Both real charge paths read media_type off the mission row and always have.
 * The preview is the surface that takes it from the body, and it was dropping
 * it on the floor.
 */
const express = require('express');
const request = require('supertest');

jest.mock('../src/middleware/auth', () => ({
  authenticate: (req, _res, next) => { req.user = { id: 'u1' }; next(); },
  optionalAuthenticate: (req, _res, next) => { next(); },
}));
jest.mock('../src/utils/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../src/db/supabase', () => ({
  from: () => ({ select: () => ({ eq: function () { return this; }, single: async () => ({ data: null, error: { message: 'none' } }) }) }),
}));
jest.mock('../src/jobs/runMission', () => ({ runMission: jest.fn() }));
jest.mock('../src/services/stripe', () => ({
  createCheckoutSession: jest.fn(), createPaymentIntent: jest.fn(),
  createPromoOnStripe: jest.fn(), updateStripePromoActive: jest.fn(),
}));
jest.mock('../src/db/missionSchema', () => ({
  updateMission: jest.fn(async () => ({})),
  sanitizeMissionPatch: (p) => ({ patch: p, rejected: [] }),
  sanitizeClientMissionPatch: (p) => ({ patch: p, rejected: [], denied: [] }),
  stampMissionHeartbeat: jest.fn(async () => ({})),
}));

const { calculateMissionPrice } = require('../src/utils/pricingEngine');
const missionsRouter = require('../src/routes/missions');
const pricingRouter = require('../src/routes/pricing');
const errorHandler = require('../src/middleware/errorHandler');

const app = express();
app.use(express.json());
app.use('/api/missions', missionsRouter);
app.use('/api/pricing', pricingRouter);
app.use(errorHandler);

/** What create-checkout-session and /missions/launch compute for the same row. */
const charged = (goalType, respondentCount, mediaType) => calculateMissionPrice({
  goalType, mediaType, respondentCount, questionCount: 0, targeting: {}, countries: [],
}).total;

const preview = (body) => request(app).post('/api/missions/calculate-price').send(body);
const quote = (body) => request(app).post('/api/pricing/quote').send(body);

describe('Creative Attention: all three surfaces agree per media type', () => {
  test.each([['image', 19], ['video', 49]])('%s is $%i everywhere', async (mediaType, expected) => {
    const body = { goalType: 'creative_attention', respondentCount: 10, mediaType, questionCount: 0 };

    const p = await preview(body);
    const q = await quote(body);

    expect(p.status).toBe(200);
    expect(q.status).toBe(200);
    expect(charged('creative_attention', 10, mediaType)).toBe(expected);
    expect(p.body.total).toBe(expected);
    expect(q.body.total).toBe(expected);
  });

  test('a video preview is not silently answered at the image price', async () => {
    // The exact regression: $19 returned for a video that costs $49.
    const p = await preview({ goalType: 'creative_attention', respondentCount: 10, mediaType: 'video', questionCount: 0 });
    expect(p.body.total).not.toBe(19);
    expect(p.body.total).toBe(49);
  });

  test('media_type snake_case is accepted too', async () => {
    const p = await preview({ goalType: 'creative_attention', respondentCount: 10, media_type: 'video', questionCount: 0 });
    expect(p.body.total).toBe(49);
  });
});

describe('the other ladders still agree', () => {
  test.each([
    ['validate', 250, 299],
    ['validate', 10, 15.60],
    ['brand_lift', 200, 300],
  ])('%s n=%i is $%s on preview, quote and charge', async (goalType, n, expected) => {
    const body = { goalType, respondentCount: n, questionCount: 5 };
    const p = await preview(body);
    const q = await quote(body);
    expect(p.body.total).toBe(expected);
    expect(q.body.total).toBe(expected);
    expect(charged(goalType, n)).toBe(expected);
  });
});
