/**
 * Pass 51 Fix 3 - the $0 promo path runs the pricing gate.
 *
 * THE DEFECT
 * Two holes, one shape. In create-checkout-session the `type === 'free'` promo
 * short-circuit returned { free: true } BEFORE validateMissionPricing ran, so
 * a $0 code skipped the gate entirely. The client then completed at
 * /api/payments/free-launch (PayButton.tsx, DashboardPage.tsx), which never
 * called validateMissionPricing at all. Net effect: a mission that no paid
 * route would touch - brand_lift under the 100 floor, creative_attention with
 * no media_type, anything over the self-serve cap - could be marked paid and
 * RUN, as long as it carried a free promo code.
 *
 * validateMissionPricing is not only a price check. It is where the
 * methodology floors live. $0 does not make an unpriceable study valid, it
 * makes it free, and the run costs real money either way.
 *
 * THE FIX, AND WHAT MUST STILL HOLD
 *   1. In create-checkout-session the free short-circuit moved BELOW the gate.
 *      Its condition and response body are untouched: a VALID mission with a
 *      free code must still get { free: true } and must still never reach
 *      Stripe.
 *   2. /free-launch runs the same gate itself, because it is a door, not a
 *      continuation - the client posts to it directly.
 */
const express = require('express');
const request = require('supertest');

jest.mock('../src/middleware/auth', () => ({
  authenticate: (req, _res, next) => { req.user = { id: 'u1', email: 'u1@test.dev' }; next(); },
  optionalAuthenticate: (req, _res, next) => { req.user = { id: 'u1', email: 'u1@test.dev' }; next(); },
}));
jest.mock('../src/utils/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

const mockCreateCheckoutSession = jest.fn(async () => ({ id: 'cs_test', url: 'https://stripe.test/cs', paymentIntentId: 'pi_test' }));
jest.mock('../src/services/stripe', () => ({
  createCheckoutSession: mockCreateCheckoutSession,
  createPromoOnStripe: jest.fn(), updateStripePromoActive: jest.fn(),
}));
const mockRunMission = jest.fn(async () => ({}));
jest.mock('../src/jobs/runMission', () => ({ runMission: mockRunMission }));
const mockUpdateMission = jest.fn(async () => ({}));
jest.mock('../src/db/missionSchema', () => ({
  updateMission: mockUpdateMission,
  sanitizeMissionPatch: (p) => ({ patch: p, rejected: [] }),
}));
jest.mock('../src/services/payments/confirmCheckoutSession', () => ({
  confirmCheckoutSessionPaid: jest.fn(async () => ({})),
}));

let mockMissionRow = null;
let mockPromo = null;
jest.mock('../src/db/supabase', () => {
  const makeChain = (table) => {
    const resolved = () => ({ data: mockMissionRow, error: mockMissionRow ? null : { message: 'not found' } });
    const chain = {
      select: () => chain, eq: () => chain, order: () => chain, limit: () => chain,
      update: () => chain, insert: () => chain,
      single: async () => (table === 'promo_codes'
        ? { data: mockPromo, error: mockPromo ? null : { message: 'not found' } }
        : resolved()),
      maybeSingle: async () => (table === 'promo_codes' ? { data: mockPromo, error: null } : resolved()),
      then: (onF, onR) => Promise.resolve(resolved()).then(onF, onR),
    };
    return chain;
  };
  return {
    from: (table) => makeChain(table),
    auth: { admin: { getUserById: async () => ({ data: { user: { email: 'u1@test.dev' } } }) } },
  };
});

const {
  BRAND_LIFT_MIN_RESPONDENTS,
  CA_MIN_RESPONDENTS,
  MAX_SELF_SERVE_RESPONDENTS,
} = require('../src/utils/pricingEngine');

const app = express();
app.use(express.json());
app.use('/api/payments', require('../src/routes/payments'));
app.use((err, _req, res, _next) => res.status(500).json({ error: err.message }));

const FREE_PROMO = { code: 'FREELAUNCH', active: true, type: 'free', expires_at: null, max_uses: null, uses_count: 0 };

const draft = (over) => ({
  id: 'm1', user_id: 'u1', status: 'draft',
  goal_type: 'validate', respondent_count: 300, media_type: null,
  targeting: {}, questions: [], ...over,
});

// Every one of these is refused by validateMissionPricing. They are the rows
// the free path used to wave through.
const UNPRICEABLE = [
  ['brand_lift under its floor',   draft({ goal_type: 'brand_lift', respondent_count: BRAND_LIFT_MIN_RESPONDENTS - 1 })],
  ['brand_lift at 5',              draft({ goal_type: 'brand_lift', respondent_count: 5 })],
  ['creative_attention under its floor', draft({ goal_type: 'creative_attention', respondent_count: CA_MIN_RESPONDENTS - 1, media_type: 'image' })],
  ['creative_attention with no media_type', draft({ goal_type: 'creative_attention', respondent_count: 50, media_type: null })],
  ['above the self-serve cap',     draft({ goal_type: 'validate', respondent_count: MAX_SELF_SERVE_RESPONDENTS + 1 })],
];

const tick = () => new Promise((r) => setImmediate(r));

beforeEach(() => {
  mockCreateCheckoutSession.mockClear();
  mockRunMission.mockClear();
  mockUpdateMission.mockClear();
  mockMissionRow = null;
  mockPromo = null;
});

describe('create-checkout-session: the free short-circuit no longer outruns the gate', () => {
  test.each(UNPRICEABLE)('%s + free promo -> 400, never { free: true }', async (_label, row) => {
    mockPromo = FREE_PROMO; mockMissionRow = row;
    const res = await request(app)
      .post('/api/payments/create-checkout-session')
      .send({ missionId: 'm1', promoCode: 'FREELAUNCH' });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Mission pricing is not valid for checkout');
    expect(res.body.free).toBeUndefined();       // the diversion did NOT happen
    expect(mockCreateCheckoutSession).not.toHaveBeenCalled();
  });

  test('a VALID mission + free promo still short-circuits to { free: true }', async () => {
    mockPromo = FREE_PROMO; mockMissionRow = draft();
    const res = await request(app)
      .post('/api/payments/create-checkout-session')
      .send({ missionId: 'm1', promoCode: 'FREELAUNCH' });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ free: true, missionId: 'm1', promoCode: 'FREELAUNCH' });
    expect(mockCreateCheckoutSession).not.toHaveBeenCalled(); // $0 never touches Stripe
  });

  test('no promo at all still reaches Stripe unchanged', async () => {
    mockMissionRow = draft();
    const res = await request(app)
      .post('/api/payments/create-checkout-session')
      .send({ missionId: 'm1' });

    expect(res.status).toBe(200);
    expect(mockCreateCheckoutSession).toHaveBeenCalledTimes(1);
  });
});

describe('free-launch: the gate runs on the route itself', () => {
  test.each(UNPRICEABLE)('%s -> 400, mission NOT marked paid and NOT run', async (_label, row) => {
    mockPromo = FREE_PROMO; mockMissionRow = row;
    const res = await request(app)
      .post('/api/payments/free-launch')
      .send({ missionId: 'm1', promoCode: 'FREELAUNCH' });
    await tick();

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Mission pricing is not valid for checkout');
    expect(mockUpdateMission).not.toHaveBeenCalled();  // no status flip
    expect(mockRunMission).not.toHaveBeenCalled();     // no compute spent
  });

  test('a VALID mission is still marked paid and run', async () => {
    mockPromo = FREE_PROMO; mockMissionRow = draft();
    const res = await request(app)
      .post('/api/payments/free-launch')
      .send({ missionId: 'm1', promoCode: 'FREELAUNCH' });
    await tick();

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ success: true, missionId: 'm1', status: 'processing' });
    expect(mockUpdateMission).toHaveBeenCalledTimes(1);
    expect(mockRunMission).toHaveBeenCalledTimes(1);
  });

  test('an already-running mission stays idempotent even below a floor', async () => {
    // The status short-circuit must keep firing first, or a legacy under-floor
    // mission that is already paid would start 400ing on a retry.
    mockPromo = FREE_PROMO;
    mockMissionRow = draft({ goal_type: 'brand_lift', respondent_count: 5, status: 'completed' });
    const res = await request(app)
      .post('/api/payments/free-launch')
      .send({ missionId: 'm1', promoCode: 'FREELAUNCH' });
    await tick();

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('already_running');
    expect(mockRunMission).not.toHaveBeenCalled();
  });
});
