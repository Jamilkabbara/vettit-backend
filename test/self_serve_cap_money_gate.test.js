/**
 * The self-serve ceiling must hold at EVERY door that authorises a charge, and
 * it must hold BEFORE any Stripe object exists.
 *
 * A cap that rejects after a PaymentIntent or Checkout Session has been created
 * is worse than no cap: the customer has a live Stripe object pointing at a
 * mission we will refuse to run, and the mission row has already been flipped
 * to pending_payment.
 *
 * There are FOUR doors, and two of them were open when the cap first landed:
 *
 *   POST /api/missions                      capped at create      (was capped)
 *   POST /api/missions/draft                capped at create      (was capped)
 *   PATCH /api/missions/:id                 re-prices + persists  (WAS NOT capped)
 *   POST /api/missions/launch               creates a PaymentIntent directly,
 *                                           bypassing the checkout route's
 *                                           validateMissionPricing +
 *                                           customQuote guards  (WAS NOT capped)
 *   POST /api/payments/create-checkout-session   (guarded via customQuote)
 *
 * The bypass chain the last two allowed:
 *   create at 1,250  ->  PATCH respondentCount to 50,000  ->  POST /launch
 *     ->  live PaymentIntent for a mission the pipeline cannot deliver.
 *
 * These tests pin the ordering, not just the status code: the Stripe mocks must
 * have been called ZERO times on every rejection.
 */
const express = require('express');
const request = require('supertest');

jest.mock('../src/middleware/auth', () => ({
  authenticate: (req, _res, next) => { req.user = { id: 'u1', email: 'u1@test.dev' }; next(); },
  optionalAuthenticate: (req, _res, next) => { req.user = { id: 'u1', email: 'u1@test.dev' }; next(); },
}));
jest.mock('../src/utils/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

const mockCreateCheckoutSession = jest.fn(async () => ({ id: 'cs_test', url: 'https://stripe.test/cs', paymentIntentId: 'pi_test' }));
const mockCreatePaymentIntent = jest.fn(async () => ({ clientSecret: 'cs_secret', paymentIntentId: 'pi_test' }));
jest.mock('../src/services/stripe', () => ({
  createCheckoutSession: mockCreateCheckoutSession,
  createPaymentIntent: mockCreatePaymentIntent,
  createPromoOnStripe: jest.fn(),
  updateStripePromoActive: jest.fn(),
}));
jest.mock('../src/jobs/runMission', () => ({ runMission: jest.fn(async () => ({})) }));
jest.mock('../src/db/missionSchema', () => ({
  updateMission: jest.fn(async () => ({})),
  sanitizeMissionPatch: (p) => ({ patch: p, rejected: [] }),
}));

let mockMissionRow = null;
jest.mock('../src/db/supabase', () => {
  const makeChain = (table) => {
    let inserted = null;
    const resolved = () => (table === 'mission_responses'
      ? { data: [], error: null, count: 0 }
      : { data: inserted || mockMissionRow, error: (inserted || mockMissionRow) ? null : { message: 'not found' } });
    const chain = {
      select: () => chain, eq: () => chain, order: () => chain, limit: () => chain, update: () => chain,
      insert: (row) => { inserted = { id: 'm-new', ...row }; return chain; },
      single: async () => resolved(),
      maybeSingle: async () => resolved(),
      then: (onF, onR) => Promise.resolve(resolved()).then(onF, onR),
    };
    return chain;
  };
  return {
    from: (table) => makeChain(table),
    auth: { admin: { getUserById: async () => ({ data: { user: { email: 'u1@test.dev' } } }) } },
  };
});

const app = express();
app.use(express.json());
app.use('/api/missions', require('../src/routes/missions'));
app.use('/api/payments', require('../src/routes/payments'));
app.use((err, _req, res, _next) => res.status(500).json({ error: err.message }));

const { MAX_SELF_SERVE_RESPONDENTS } = require('../src/utils/pricingEngine');
const OVER  = MAX_SELF_SERVE_RESPONDENTS + 1;
const AT    = MAX_SELF_SERVE_RESPONDENTS;

const missionRow = (respondent_count) => ({
  id: 'm1', user_id: 'u1', goal_type: 'validate', status: 'draft',
  respondent_count, media_type: null, targeting: {}, questions: [],
});

const noStripe = () => {
  expect(mockCreateCheckoutSession).not.toHaveBeenCalled();
  expect(mockCreatePaymentIntent).not.toHaveBeenCalled();
};

beforeEach(() => {
  mockCreateCheckoutSession.mockClear();
  mockCreatePaymentIntent.mockClear();
  mockMissionRow = null;
});

describe('door 1 — POST /api/missions (create)', () => {
  test(`${OVER} is refused with the lead-capture payload, no Stripe`, async () => {
    const res = await request(app).post('/api/missions').send({ goalType: 'validate', brief: 'x', respondentCount: OVER });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('respondent_count_above_self_serve_cap');
    expect(res.body.maxSelfServeRespondents).toBe(MAX_SELF_SERVE_RESPONDENTS);
    expect(res.body.leadCapture.endpoint).toBe('/api/crm/lead');
    noStripe();
  });
  test(`${AT} (exactly at the cap) still creates`, async () => {
    const res = await request(app).post('/api/missions').send({ goalType: 'validate', brief: 'x', respondentCount: AT });
    expect(res.status).toBe(201);
  });
});

describe('door 2 — POST /api/missions/draft', () => {
  test(`${OVER} is refused, no Stripe`, async () => {
    const res = await request(app).post('/api/missions/draft').send({ goalType: 'validate', brief: 'x', respondentCount: OVER });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('respondent_count_above_self_serve_cap');
    noStripe();
  });
});

describe('door 3 — PATCH /api/missions/:id (the edit-path bypass)', () => {
  test('cannot raise respondent_count above the cap after creation', async () => {
    mockMissionRow = missionRow(AT);
    const res = await request(app).patch('/api/missions/m1').send({ respondentCount: 50000 });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('respondent_count_above_self_serve_cap');
    expect(res.body.requestedRespondents).toBe(50000);
    noStripe();
  });
  test('an edit at or below the cap still re-prices', async () => {
    mockMissionRow = missionRow(AT);
    const res = await request(app).patch('/api/missions/m1').send({ respondentCount: 1000 });
    expect(res.status).not.toBe(400);
  });
});

describe('door 4 — POST /api/missions/launch (creates a PaymentIntent directly)', () => {
  test('an above-cap mission NEVER reaches createPaymentIntent', async () => {
    mockMissionRow = missionRow(50000);
    const res = await request(app).post('/api/missions/launch').send({ missionId: 'm1' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('respondent_count_above_self_serve_cap');
    noStripe();
  });
  test('a mission at the cap does reach Stripe (the gate is not a blanket block)', async () => {
    mockMissionRow = missionRow(AT);
    const res = await request(app).post('/api/missions/launch').send({ missionId: 'm1' });
    expect(res.status).toBe(200);
    expect(mockCreatePaymentIntent).toHaveBeenCalledTimes(1);
  });
});

describe('door 5 — POST /api/payments/create-checkout-session', () => {
  test('an above-cap mission NEVER reaches createCheckoutSession', async () => {
    mockMissionRow = missionRow(50000);
    const res = await request(app).post('/api/payments/create-checkout-session').send({ missionId: 'm1' });
    expect(res.status).toBe(400);
    noStripe();
  });
  test('a mission at the cap does reach Stripe checkout', async () => {
    mockMissionRow = missionRow(AT);
    await request(app).post('/api/payments/create-checkout-session').send({ missionId: 'm1' });
    expect(mockCreateCheckoutSession).toHaveBeenCalledTimes(1);
  });
});
