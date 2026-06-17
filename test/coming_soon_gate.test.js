/**
 * §A0 — server-side Coming-Soon gate. The authoritative gate that blocks money:
 * gated goal_types must be REJECTED at mission-create AND at Stripe-checkout,
 * with ZERO charge (createCheckoutSession never called); the 11 live types must
 * still create + reach checkout unchanged.
 */
const express = require('express');
const request = require('supertest');

// The router require chain pulls runMission → email → new Resend(KEY), which
// throws at module-load without a key. Provide harmless test values (the
// services that use them — Stripe, email — are mocked or never invoked here).
process.env.RESEND_API_KEY = process.env.RESEND_API_KEY || 're_test_dummy';
process.env.STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || 'sk_test_dummy';

// ── mocks (factory vars must be `mock`-prefixed per jest hoisting rules) ──
jest.mock('../src/middleware/auth', () => ({
  authenticate: (req, _res, next) => { req.user = { id: 'u1' }; next(); },
  optionalAuthenticate: (req, _res, next) => { req.user = { id: 'u1' }; next(); },
}));
jest.mock('../src/utils/logger', () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
}));
const mockCreateCheckoutSession = jest.fn(async () => ({ id: 'cs_test', url: 'https://stripe.test/cs_test', paymentIntentId: 'pi_test' }));
jest.mock('../src/services/stripe', () => ({ createCheckoutSession: mockCreateCheckoutSession }));
jest.mock('../src/db/missionSchema', () => ({
  updateMission: jest.fn(async () => ({})),
  sanitizeMissionPatch: (p) => ({ patch: p, rejected: [] }),
}));

// fake supabase — one mutable mission row drives the checkout fetch; create inserts.
let mockMissionRow = null;
jest.mock('../src/db/supabase', () => {
  const makeChain = () => {
    const chain = {
      select: () => chain,
      eq: () => chain,
      order: () => chain,
      limit: () => chain,
      single: async () => ({ data: mockMissionRow, error: mockMissionRow ? null : { message: 'not found' } }),
      maybeSingle: async () => ({ data: mockMissionRow, error: null }),
      insert: (row) => ({ select: () => ({ single: async () => ({ data: { id: 'm-new', ...row }, error: null }) }) }),
    };
    return chain;
  };
  return {
    from: () => makeChain(),
    auth: { admin: { getUserById: async () => ({ data: { user: { email: 'owner@vett.test' } } }) } },
  };
});

const { COMING_SOON_GOAL_TYPES, isComingSoon } = require('../src/config/comingSoon');

const app = express();
app.use(express.json());
app.use('/api/missions', require('../src/routes/missions'));
app.use('/api/payments', require('../src/routes/payments'));
app.use((err, _req, res, _next) => res.status(500).json({ error: err.message }));

const LIVE_TYPES = ['validate', 'compare', 'marketing', 'satisfaction', 'pricing', 'roadmap', 'research', 'competitor', 'naming_messaging', 'churn_research', 'brand_lift'];

beforeEach(() => { mockCreateCheckoutSession.mockClear(); mockMissionRow = null; });

describe('single source of truth', () => {
  test('exactly the 3 deferred types are gated', () => {
    expect([...COMING_SOON_GOAL_TYPES].sort()).toEqual(['audience_profiling', 'creative_attention', 'market_entry']);
  });
  test('none of the 11 live types are gated', () => {
    LIVE_TYPES.forEach((t) => expect(isComingSoon(t)).toBe(false));
  });
  test('isComingSoon tolerates null / whitespace', () => {
    expect(isComingSoon(null)).toBe(false);
    expect(isComingSoon(' market_entry ')).toBe(true);
  });
});

describe('mission create — POST /api/missions', () => {
  test.each(['market_entry', 'audience_profiling', 'creative_attention'])('gated %s is rejected 403 not_available', async (goalType) => {
    const res = await request(app).post('/api/missions').send({ goalType, brief: 'x', respondentCount: 300 });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('not_available');
  });

  test('a live type (pricing) still creates (201)', async () => {
    const res = await request(app).post('/api/missions').send({ goalType: 'pricing', brief: 'price test', respondentCount: 300 });
    expect(res.status).toBe(201);
    expect(res.body.goal_type).toBe('pricing');
  });
});

describe('checkout — POST /api/payments/create-checkout-session (ZERO charge for gated)', () => {
  test.each(['market_entry', 'audience_profiling', 'creative_attention'])('gated %s → 403 and Stripe is NEVER called', async (goalType) => {
    mockMissionRow = { id: 'm1', user_id: 'u1', goal_type: goalType, status: 'draft', respondent_count: 300, media_type: null, targeting: {}, questions: [] };
    const res = await request(app).post('/api/payments/create-checkout-session').send({ missionId: 'm1' });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('not_available');
    expect(mockCreateCheckoutSession).not.toHaveBeenCalled(); // <-- zero charge
  });

  test('a live mission (validate) reaches Stripe checkout unchanged', async () => {
    mockMissionRow = { id: 'm2', user_id: 'u1', goal_type: 'validate', status: 'draft', respondent_count: 300, media_type: null, targeting: {}, questions: [] };
    const res = await request(app).post('/api/payments/create-checkout-session').send({ missionId: 'm2' });
    expect(mockCreateCheckoutSession).toHaveBeenCalledTimes(1);
    expect(res.status).toBe(200);
  });
});
