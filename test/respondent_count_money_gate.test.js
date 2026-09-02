/**
 * The self-serve respondent-count ceiling must hold on every door that can
 * reach Stripe — not just the two that create a mission.
 *
 * On origin/main the 1..5000 bound was enforced on POST / and POST /draft and
 * on NEITHER of the two doors that decide what is finally charged:
 *
 *   PATCH /missions/:id     re-prices AND persists respondent_count, unvalidated
 *   POST  /missions/launch  builds a PaymentIntent from the stored count,
 *                           guarded only by `pricing.totalCents < 50`
 *
 * calculateMissionPrice has no ceiling of its own (n=100,000 -> $40,000), so
 * the two composed into a live money path:
 *
 *   create at a legal count -> PATCH respondentCount: 50000 -> launch
 *     => a real $20,000 PaymentIntent, for a mission the pipeline cannot
 *        deliver, with a $6,000 ai_spend_ceiling_usd authorised behind it.
 *
 * These tests assert ORDERING, not just status codes. A 400 that arrives after
 * a PaymentIntent already exists is not a fix, so every rejection also asserts
 * the Stripe mock was called ZERO times, and the persistence mock likewise.
 */
const express = require('express');
const request = require('supertest');

jest.mock('../src/middleware/auth', () => ({
  authenticate: (req, _res, next) => { req.user = { id: 'u1', email: 'owner@test.dev' }; next(); },
  optionalAuthenticate: (req, _res, next) => { req.user = { id: 'u1', email: 'owner@test.dev' }; next(); },
}));
jest.mock('../src/utils/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../src/jobs/runMission', () => ({ runMission: jest.fn() }));
jest.mock('../src/services/ai/insights', () => ({ synthesizeInsights: jest.fn(), aggregate: jest.fn() }));

jest.mock('../src/services/stripe', () => ({
  createPaymentIntent: jest.fn(async () => ({ clientSecret: 'cs_test', paymentIntentId: 'pi_test' })),
  createCheckoutSession: jest.fn(async () => ({ id: 'sess_test', url: 'https://stripe.test' })),
  createPromoOnStripe: jest.fn(), updateStripePromoActive: jest.fn(),
}));

jest.mock('../src/db/missionSchema', () => ({
  updateMission: jest.fn(async () => ({})),
  sanitizeMissionPatch: (p) => ({ patch: p, rejected: [] }),
}));

// The mission row PATCH/launch read back. respondent_count is overwritten per
// test to stand in for a row written before the guard existed.
let mockStoredCount = 100;  // mock-prefixed: jest factory hoisting rule
let mockLastUpdate = null;  // the payload that actually reached the DB
jest.mock('../src/db/supabase', () => {
  const row = () => ({
    id: 'm-1', user_id: 'u1', status: 'draft', goal_type: 'validate',
    respondent_count: mockStoredCount, questions: [], targeting: {}, brief: 'b', title: 't',
  });
  const makeChain = () => {
    const chain = {
      select: () => chain, eq: () => chain, order: () => chain, limit: () => chain,
      update: (payload) => { mockLastUpdate = payload; return chain; },
      insert: () => chain,
      single: async () => ({ data: row(), error: null }),
      maybeSingle: async () => ({ data: row(), error: null }),
      then: (onF, onR) => Promise.resolve({ data: row(), error: null }).then(onF, onR),
    };
    return chain;
  };
  return {
    from: () => makeChain(),
    auth: { admin: { getUserById: async () => ({ data: { user: { email: 'owner@test.dev' } } }) } },
  };
});

const stripe = require('../src/services/stripe');

const app = express();
app.use(express.json());
app.use('/api/missions', require('../src/routes/missions'));
app.use((err, _req, res, _next) => res.status(500).json({ error: err.message }));

beforeEach(() => { jest.clearAllMocks(); mockStoredCount = 100; mockLastUpdate = null; });

/** No Stripe object of any kind was created. */
const assertNoStripeCall = () => {
  expect(stripe.createPaymentIntent).toHaveBeenCalledTimes(0);
  expect(stripe.createCheckoutSession).toHaveBeenCalledTimes(0);
};

describe('door 3 — PATCH /missions/:id cannot persist an out-of-range count', () => {
  it('refuses 50,000 and writes nothing', async () => {
    const res = await request(app).patch('/api/missions/m-1').send({ respondentCount: 50000 });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_respondent_count');
    expect(mockLastUpdate).toBeNull(); // never reached persistence
    assertNoStripeCall();
  });

  it('refuses non-integers and zero, the same shapes create rejects', async () => {
    for (const bad of [0, -5, 1.5, 5001]) {
      jest.clearAllMocks();
      const res = await request(app).patch('/api/missions/m-1').send({ respondentCount: bad });
      expect({ bad, status: res.status }).toEqual({ bad, status: 400 });
      expect({ bad, wrote: mockLastUpdate }).toEqual({ bad, wrote: null });
    }
  });

  it('still allows a legal edit', async () => {
    const res = await request(app).patch('/api/missions/m-1').send({ respondentCount: 250 });
    expect(res.status).toBeLessThan(400);
    // Positive control. Without this the "wrote nothing" assertions above
    // would pass even if the route never wrote on ANY input.
    expect(mockLastUpdate).not.toBeNull();
    expect(mockLastUpdate.respondent_count).toBe(250);
  });
});

describe('door 4 — POST /missions/launch re-checks the STORED count before Stripe', () => {
  it('refuses a row already holding 50,000 without opening a PaymentIntent', async () => {
    mockStoredCount = 50000; // a row written before the guard existed
    const res = await request(app).post('/api/missions/launch').send({ missionId: 'm-1' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_respondent_count');
    assertNoStripeCall();
  });

  it('launches normally at a legal stored count', async () => {
    mockStoredCount = 250;
    const res = await request(app).post('/api/missions/launch').send({ missionId: 'm-1' });
    expect(res.status).toBeLessThan(400);
    expect(stripe.createPaymentIntent).toHaveBeenCalledTimes(1);
  });
});

describe('doors 1 and 2 keep their existing guard', () => {
  it('POST / refuses 50,000', async () => {
    const res = await request(app).post('/api/missions')
      .send({ goalType: 'validate', brief: 'b', respondentCount: 50000 });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_respondent_count');
    assertNoStripeCall();
  });

  it('POST /draft refuses 50,000', async () => {
    const res = await request(app).post('/api/missions/draft')
      .send({ goalType: 'validate', brief: 'b', respondentCount: 50000 });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_respondent_count');
    assertNoStripeCall();
  });
});
