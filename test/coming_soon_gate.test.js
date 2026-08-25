/**
 * §A0 — server-side Coming-Soon gate across EVERY door that creates a mission
 * with a goal_type or authorises a charge/run. Gated types are rejected with
 * ZERO charge + ZERO run (createCheckoutSession / runMission never called); the
 * 11 live types still create, checkout, free-launch and mark-paid unchanged.
 *
 * Doors covered: create, draft, checkout, free-launch, admin mark-paid.
 * Downstream run-triggers (generate-responses, Stripe webhook,
 * confirmCheckoutSession) only fire on an already-paid mission, which a gated
 * type can no longer reach — except a PRE-EXISTING paid gated mission, whose
 * repair path (reanalyze) is intentionally left open.
 */
const express = require('express');
const request = require('supertest');

const ADMIN_EMAIL = 'kabbarajamil@gmail.com';

// ── mocks (factory vars must be `mock`-prefixed per jest hoisting rules) ──
jest.mock('../src/middleware/auth', () => ({
  authenticate: (req, _res, next) => { req.user = { id: 'u1', email: 'kabbarajamil@gmail.com' }; next(); },
  optionalAuthenticate: (req, _res, next) => { req.user = { id: 'u1', email: 'kabbarajamil@gmail.com' }; next(); },
}));
jest.mock('../src/utils/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
const mockCreateCheckoutSession = jest.fn(async () => ({ id: 'cs_test', url: 'https://stripe.test/cs', paymentIntentId: 'pi_test' }));
jest.mock('../src/services/stripe', () => ({ createCheckoutSession: mockCreateCheckoutSession, createPromoOnStripe: jest.fn(), updateStripePromoActive: jest.fn() }));
const mockRunMission = jest.fn(async () => ({}));
jest.mock('../src/jobs/runMission', () => ({ runMission: mockRunMission }));
const mockSynthesize = jest.fn(async () => ({ executive_summary: 'ok', kpis: [], recommendations: [] }));
jest.mock('../src/services/ai/insights', () => ({ synthesizeInsights: mockSynthesize, aggregate: jest.fn() }));
jest.mock('../src/db/missionSchema', () => ({
  updateMission: jest.fn(async () => ({})),
  sanitizeMissionPatch: (p) => ({ patch: p, rejected: [] }),
}));

let mockMissionRow = null;
let mockPromo = null;
jest.mock('../src/db/supabase', () => {
  const makeChain = (table) => {
    let inserted = null;
    const resolved = () => ({ data: inserted || mockMissionRow, error: (inserted || mockMissionRow) ? null : { message: 'not found' } });
    const chain = {
      select: () => chain, eq: () => chain, order: () => chain, limit: () => chain, update: () => chain,
      insert: (row) => { inserted = { id: 'm-new', ...row }; return chain; },
      single: async () => (table === 'promo_codes'
        ? { data: mockPromo, error: mockPromo ? null : { message: 'not found' } }
        : resolved()),
      maybeSingle: async () => (table === 'promo_codes' ? { data: mockPromo, error: null } : resolved()),
      // supabase query builders are thenable — awaiting executes them.
      then: (onF, onR) => Promise.resolve(resolved()).then(onF, onR),
    };
    return chain;
  };
  return {
    from: (table) => makeChain(table),
    auth: { admin: { getUserById: async () => ({ data: { user: { email: ADMIN_EMAIL } } }) } },
  };
});

const { COMING_SOON_GOAL_TYPES, isComingSoon } = require('../src/config/comingSoon');

const app = express();
app.use(express.json());
app.use('/api/missions', require('../src/routes/missions'));
app.use('/api/payments', require('../src/routes/payments'));
app.use('/api/admin', require('../src/routes/admin'));
app.use((err, _req, res, _next) => res.status(500).json({ error: err.message }));

const GATED = ['creative_attention'];
const LIVE_TYPES = ['validate', 'compare', 'marketing', 'satisfaction', 'pricing', 'roadmap', 'research', 'competitor', 'naming_messaging', 'churn_research', 'brand_lift', 'audience_profiling', 'market_entry'];
const draftRow = (goal_type) => ({ id: 'm1', user_id: 'u1', goal_type, status: 'draft', respondent_count: 300, media_type: null, targeting: {}, questions: [] });
const freePromo = { code: 'FREELAUNCH', active: true, type: 'free', expires_at: null, max_uses: null, uses_count: 0 };
const tick = () => new Promise((r) => setImmediate(r));

beforeEach(() => { mockCreateCheckoutSession.mockClear(); mockRunMission.mockClear(); mockSynthesize.mockClear(); mockMissionRow = null; mockPromo = null; });

describe('single source of truth', () => {
  test('exactly the 1 deferred type is gated', () => {
    expect([...COMING_SOON_GOAL_TYPES].sort()).toEqual(['creative_attention']);
  });
  test('none of the 13 live types are gated', () => LIVE_TYPES.forEach((t) => expect(isComingSoon(t)).toBe(false)));
  test('isComingSoon tolerates null / whitespace', () => {
    expect(isComingSoon(null)).toBe(false);
    expect(isComingSoon(' creative_attention ')).toBe(true);
  });
});

describe('create — POST /api/missions', () => {
  test.each(GATED)('gated %s → 403 not_available', async (goalType) => {
    const res = await request(app).post('/api/missions').send({ goalType, brief: 'x', respondentCount: 300 });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('not_available');
  });
  test('live (pricing) still creates 201', async () => {
    const res = await request(app).post('/api/missions').send({ goalType: 'pricing', brief: 'x', respondentCount: 300 });
    expect(res.status).toBe(201);
    expect(res.body.goal_type).toBe('pricing');
  });
});

describe('draft — POST /api/missions/draft', () => {
  test.each(GATED)('gated %s → 403 (no gated row persisted)', async (goalType) => {
    const res = await request(app).post('/api/missions/draft').send({ goalType, brief: 'x', respondentCount: 300 });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('not_available');
  });
  test('live (pricing) draft saves', async () => {
    const res = await request(app).post('/api/missions/draft').send({ goalType: 'pricing', brief: 'x', respondentCount: 300 });
    expect(res.status).toBe(200);
  });
});

describe('checkout — POST /api/payments/create-checkout-session (ZERO charge for gated)', () => {
  test.each(GATED)('gated %s → 403, Stripe NEVER called', async (goalType) => {
    mockMissionRow = draftRow(goalType);
    const res = await request(app).post('/api/payments/create-checkout-session').send({ missionId: 'm1' });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('not_available');
    expect(mockCreateCheckoutSession).not.toHaveBeenCalled();
  });
  test('live (validate) reaches Stripe checkout', async () => {
    mockMissionRow = draftRow('validate');
    const res = await request(app).post('/api/payments/create-checkout-session').send({ missionId: 'm1' });
    expect(mockCreateCheckoutSession).toHaveBeenCalledTimes(1);
    expect(res.status).toBe(200);
  });
});

describe('free-launch — POST /api/payments/free-launch (ZERO run for gated)', () => {
  test.each(GATED)('gated %s → 403, runMission NEVER called', async (goalType) => {
    mockPromo = freePromo; mockMissionRow = draftRow(goalType);
    const res = await request(app).post('/api/payments/free-launch').send({ missionId: 'm1', promoCode: 'FREELAUNCH' });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('not_available');
    expect(mockRunMission).not.toHaveBeenCalled();
  });
  test('live (validate) free-launch runs the mission', async () => {
    mockPromo = freePromo; mockMissionRow = draftRow('validate');
    await request(app).post('/api/payments/free-launch').send({ missionId: 'm1', promoCode: 'FREELAUNCH' });
    await tick();
    expect(mockRunMission).toHaveBeenCalledTimes(1);
  });
});

describe('admin mark-paid — POST /api/admin/missions/:id/mark-paid (ZERO run for gated)', () => {
  test.each(GATED)('gated %s → 403, runMission NEVER called', async (goalType) => {
    mockMissionRow = draftRow(goalType);
    const res = await request(app).post('/api/admin/missions/m1/mark-paid').send({ reason: 'test' });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('not_available');
    expect(mockRunMission).not.toHaveBeenCalled();
  });
  test('live (validate) mark-paid runs the mission', async () => {
    mockMissionRow = draftRow('validate');
    await request(app).post('/api/admin/missions/m1/mark-paid').send({ reason: 'test' });
    await tick();
    expect(mockRunMission).toHaveBeenCalledTimes(1);
  });
});

describe('admin reanalyze — POST /api/admin/missions/:id/reanalyze (6th door — NO synthesis for gated)', () => {
  test.each(GATED)('gated %s → 403, synthesizeInsights NEVER called', async (goalType) => {
    mockMissionRow = draftRow(goalType);
    const res = await request(app).post('/api/admin/missions/m1/reanalyze').send({});
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('not_available');
    expect(mockSynthesize).not.toHaveBeenCalled(); // gate fires before synthesis
  });
  test('a live type (validate) is NOT blocked by the gate', async () => {
    mockMissionRow = draftRow('validate');
    const res = await request(app).post('/api/admin/missions/m1/reanalyze').send({});
    expect(res.body.error).not.toBe('not_available'); // gate let it through (downstream behavior aside)
  });
});
