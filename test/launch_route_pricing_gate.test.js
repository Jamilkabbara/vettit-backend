/**
 * POST /api/missions/launch is a SECOND money path. It builds a Stripe
 * PaymentIntent straight from the stored mission row, and it has never run
 * validateMissionPricing - the fail-closed gate that
 * /payments/create-checkout-session runs before it computes a price.
 *
 * Two consequences, both live:
 *
 *   1. Ladder. Until PR #122 this route also omitted goalType/mediaType from
 *      calculateMissionPrice, so every goal was priced off the DEFAULT
 *      VOLUME_TIERS ladder. brand_lift n=200 charged $240 instead of $300;
 *      creative_attention n=50 charged $99 instead of $69. #122 fixed the
 *      arguments; nothing pinned them, so the "prices off its own ladder"
 *      tests below exist to keep them fixed.
 *
 *   2. Gate. A mission row whose {goal_type, respondent_count, media_type}
 *      combo is not chargeable still gets a PaymentIntent here, because the
 *      only guards on this route are the respondent-count ceiling and
 *      totalCents < 50. A brand_lift study stored at n=5 is below the Pulse
 *      minimum, has no tier on its own ladder, and is charged $9 off the
 *      Sniff Test rate of the DEFAULT ladder - a price from a ladder it does
 *      not belong to, with "Sniff Test" written onto the stored breakdown and
 *      the Stripe receipt.
 *
 * These tests pin the ordering as well as the status code: on every rejection
 * the Stripe mock must have been called ZERO times.
 */
const express = require('express');
const request = require('supertest');

jest.mock('../src/middleware/auth', () => ({
  authenticate: (req, _res, next) => { req.user = { id: 'u1', email: 'u1@test.dev' }; next(); },
  optionalAuthenticate: (req, _res, next) => { req.user = { id: 'u1', email: 'u1@test.dev' }; next(); },
}));
jest.mock('../src/utils/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

const mockCreatePaymentIntent = jest.fn(async () => ({ clientSecret: 'cs_secret', paymentIntentId: 'pi_test' }));
jest.mock('../src/services/stripe', () => ({
  createCheckoutSession: jest.fn(),
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
    const resolved = () => (table === 'promo_codes'
      ? { data: null, error: { message: 'not found' } }
      : { data: mockMissionRow, error: mockMissionRow ? null : { message: 'not found' } });
    const chain = {
      select: () => chain, eq: () => chain, order: () => chain, limit: () => chain, update: () => chain,
      insert: () => chain,
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
app.use((err, _req, res, _next) => res.status(500).json({ error: err.message }));

const mission = (over) => ({
  id: 'm1', user_id: 'u1', status: 'draft',
  goal_type: 'validate', respondent_count: 50, media_type: null,
  targeting: {}, questions: [],
  ...over,
});

const launch = () => request(app).post('/api/missions/launch').send({ missionId: 'm1' });
const chargedCents = () => mockCreatePaymentIntent.mock.calls[0][0].amountCents;

beforeEach(() => { mockCreatePaymentIntent.mockClear(); mockMissionRow = null; });

// ── The gate: an unchargeable combo must never reach Stripe ──────────────────

describe('/launch runs the same fail-closed pricing gate as checkout', () => {
  test('brand_lift below the Pulse minimum is refused, and no PaymentIntent is opened', async () => {
    mockMissionRow = mission({ goal_type: 'brand_lift', respondent_count: 5 });
    const res = await launch();
    expect(res.status).toBe(400);
    expect(mockCreatePaymentIntent).not.toHaveBeenCalled();
  });

  test('creative_attention with no media_type is refused, and no PaymentIntent is opened', async () => {
    mockMissionRow = mission({ goal_type: 'creative_attention', respondent_count: 50, media_type: null });
    const res = await launch();
    expect(res.status).toBe(400);
    expect(mockCreatePaymentIntent).not.toHaveBeenCalled();
  });

  test('the rejection carries a machine-readable reason, not a bare 400', async () => {
    mockMissionRow = mission({ goal_type: 'brand_lift', respondent_count: 5 });
    const res = await launch();
    expect(res.body.error).toBe('mission_pricing_invalid');
    expect(typeof res.body.reason).toBe('string');
    expect(res.body.reason.length).toBeGreaterThan(0);
  });
});

// ── The ladder: /launch must price off the mission's own ladder ──────────────
//
// Both figures below are what /payments/create-checkout-session charges for
// the identical row. They differ from the DEFAULT-ladder price in OPPOSITE
// directions, so a regression to the default ladder cannot pass both.

describe('/launch prices each goal off its own ladder, not the default one', () => {
  test('brand_lift n=200 charges the Tracker price ($300), not the Deep Dive price ($240)', async () => {
    mockMissionRow = mission({ goal_type: 'brand_lift', respondent_count: 200 });
    const res = await launch();
    expect(res.status).toBe(200);
    expect(chargedCents()).toBe(30000);
    expect(res.body.pricing.volumeTier.name).toBe('Tracker');
  });

  test('creative_attention n=50 charges the CA flat price ($69), not the default $99', async () => {
    mockMissionRow = mission({ goal_type: 'creative_attention', respondent_count: 50, media_type: 'video' });
    const res = await launch();
    expect(res.status).toBe(200);
    expect(chargedCents()).toBe(6900);
    expect(res.body.pricing.ratePerResp).toBeNull();
  });
});

// ── POSITIVE CONTROL ────────────────────────────────────────────────────────
//
// A legal mission must still get its PaymentIntent at the unchanged price.
// Without this, a bug that rejects EVERY launch would satisfy every
// assertion above.

describe('positive control - a legal mission still launches, at the same price as before', () => {
  test('validate n=50 opens a PaymentIntent for $99', async () => {
    mockMissionRow = mission({ goal_type: 'validate', respondent_count: 50 });
    const res = await launch();
    expect(res.status).toBe(200);
    expect(res.body.clientSecret).toBe('cs_secret');
    expect(mockCreatePaymentIntent).toHaveBeenCalledTimes(1);
    expect(chargedCents()).toBe(9900);
  });

  test('validate n=250 opens a PaymentIntent for $300', async () => {
    mockMissionRow = mission({ goal_type: 'validate', respondent_count: 250 });
    const res = await launch();
    expect(res.status).toBe(200);
    expect(chargedCents()).toBe(30000);
  });
});
