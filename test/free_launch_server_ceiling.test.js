/**
 * Residual 2 - the free-launch path ran on a browser-written spend ceiling.
 *
 * THE DEFECT
 * POST /api/payments/free-launch flips a mission to paid and fires runMission.
 * It wrote three columns: status, paid_at and promo_code. It never wrote
 * total_price_usd, so the pass-51 trigger - which fires ON UPDATE OF
 * respondent_count, total_price_usd - never fired either, and unlike
 * create-checkout-session the route did not write ai_spend_ceiling_usd or
 * target_qualified_count itself.
 *
 * So on this path both governors of the recruit loop were numbers the browser
 * put on the row at INSERT. The RLS INSERT policy blocks status, paid_at,
 * paid_amount_cents, promo_code and ai_spend_usd_actual; it does not block
 * these two, and `authenticated` holds INSERT on both columns.
 *
 * Neither live gate caught it. runMission's ceiling check only requires a
 * positive number. The payment-covers-run gate prices a free-promo mission at
 * $0 owed against $0 captured and passes by construction.
 *
 * THE FIX, AND WHAT MUST STILL HOLD
 *   1. free-launch computes the price server-side and writes
 *      target_qualified_count and ai_spend_ceiling_usd from it, whatever the
 *      row carried.
 *   2. The ceiling comes from the LIST price, not from the $0 charge. Thirty
 *      percent of zero is zero, and runMission refuses a mission whose ceiling
 *      is not positive - a ceiling derived from the charge would stop every
 *      free launch dead.
 *   3. A normal free launch still works end to end.
 */
const express = require('express');
const request = require('supertest');

jest.mock('../src/middleware/auth', () => ({
  authenticate: (req, _res, next) => { req.user = { id: 'u1', email: 'u1@test.dev' }; next(); },
  optionalAuthenticate: (req, _res, next) => { req.user = { id: 'u1', email: 'u1@test.dev' }; next(); },
}));
jest.mock('../src/utils/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../src/services/stripe', () => ({
  createCheckoutSession: jest.fn(), createPromoOnStripe: jest.fn(), updateStripePromoActive: jest.fn(),
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
// The promo claim is exercised by its own suite; here it always succeeds so
// the ceiling write is what is under test.
jest.mock('../src/services/promo/promoCodes', () => {
  const actual = jest.requireActual('../src/services/promo/promoCodes');
  return {
    ...actual,
    recordFreeLaunchRedemption: jest.fn(async () => ({ claimed: true })),
    releasePromoUse: jest.fn(async () => ({})),
  };
});

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
    storage: { from: () => ({
      createSignedUrl: async () => ({ data: null, error: { message: 'no object' } }),
      info: async () => ({ data: null, error: { message: 'no object' } }),
    }) },
    auth: { admin: { getUserById: async () => ({ data: { user: { email: 'u1@test.dev' } } }) } },
  };
});

const { calculateMissionPrice } = require('../src/utils/pricingEngine');

const app = express();
app.use(express.json());
app.use('/api/payments', require('../src/routes/payments'));
app.use((err, _req, res, _next) => res.status(500).json({ error: err.message }));

const FREE_PROMO = { code: 'FREELAUNCH', active: true, type: 'free', expires_at: null, max_uses: null, uses_count: 0 };

const draft = (over) => ({
  id: 'm1', user_id: 'u1', status: 'draft', goal_type: 'validate',
  respondent_count: 300, media_type: null, targeting: {}, questions: [],
  brief_attachment: null, target_audience: null, ...over,
});

const tick = () => new Promise((r) => setImmediate(r));
const patchOf = () => mockUpdateMission.mock.calls[0][2];

beforeEach(() => {
  mockUpdateMission.mockClear();
  mockRunMission.mockClear();
  mockMissionRow = null; mockPromo = null;
});

describe('free-launch writes both governors from the server price', () => {
  test('the row\'s own ceiling and target are overwritten, not honoured', async () => {
    mockPromo = FREE_PROMO;
    // What a browser could put on the row at INSERT: a ceiling two orders of
    // magnitude too high, and a target that bears no relation to the count.
    mockMissionRow = draft({ ai_spend_ceiling_usd: 9999, target_qualified_count: 1 });

    const res = await request(app)
      .post('/api/payments/free-launch')
      .send({ missionId: 'm1', promoCode: 'FREELAUNCH' });
    await tick();

    expect(res.status).toBe(200);
    const list = calculateMissionPrice({
      respondentCount: 300, targeting: {}, questionCount: 0, countries: [], goalType: 'validate',
    });
    const expectedCeiling = Math.round(list.total * 0.30 * 10000) / 10000;

    expect(patchOf().ai_spend_ceiling_usd).toBe(expectedCeiling);
    expect(patchOf().ai_spend_ceiling_usd).not.toBe(9999);
    expect(patchOf().target_qualified_count).toBe(300);
    expect(patchOf().target_qualified_count).not.toBe(1);
  });

  test('the ceiling is positive, so runMission will actually start the mission', async () => {
    // 30% of the $0 CHARGE would be $0, and runMission refuses any mission
    // whose ai_spend_ceiling_usd is not a positive number. The ceiling has to
    // come from the list price for a free launch to run at all.
    mockPromo = FREE_PROMO;
    mockMissionRow = draft({ ai_spend_ceiling_usd: null, target_qualified_count: null });

    await request(app).post('/api/payments/free-launch').send({ missionId: 'm1', promoCode: 'FREELAUNCH' });
    await tick();

    expect(patchOf().ai_spend_ceiling_usd).toBeGreaterThan(0);
    expect(patchOf().total_price_usd).toBe(0);   // what they were actually charged
  });

  test('a Creative Attention video free launch gets the VIDEO budget, not the image one', async () => {
    mockPromo = FREE_PROMO;
    mockMissionRow = draft({
      goal_type: 'creative_attention', respondent_count: 10, media_type: 'video',
    });

    await request(app).post('/api/payments/free-launch').send({ missionId: 'm1', promoCode: 'FREELAUNCH' });
    await tick();

    // $49 list x 0.30
    expect(patchOf().ai_spend_ceiling_usd).toBe(14.7);
  });

  test('POSITIVE CONTROL: a normal free launch still completes end to end', async () => {
    mockPromo = FREE_PROMO;
    mockMissionRow = draft();

    const res = await request(app)
      .post('/api/payments/free-launch')
      .send({ missionId: 'm1', promoCode: 'FREELAUNCH' });
    await tick();

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ success: true, missionId: 'm1', status: 'processing' });
    expect(mockUpdateMission).toHaveBeenCalledTimes(1);
    expect(mockRunMission).toHaveBeenCalledTimes(1);
    // the three columns it always wrote are still written
    expect(patchOf()).toMatchObject({ status: 'paid', promo_code: 'FREELAUNCH' });
    expect(patchOf().paid_at).toEqual(expect.any(String));
  });

  test('a mission that cannot be priced is still refused before any of this', async () => {
    mockPromo = FREE_PROMO;
    mockMissionRow = draft({ goal_type: 'brand_lift', respondent_count: 5 });

    const res = await request(app)
      .post('/api/payments/free-launch')
      .send({ missionId: 'm1', promoCode: 'FREELAUNCH' });
    await tick();

    expect(res.status).toBe(400);
    expect(mockUpdateMission).not.toHaveBeenCalled();
    expect(mockRunMission).not.toHaveBeenCalled();
  });
});
