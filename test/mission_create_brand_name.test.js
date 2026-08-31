/**
 * POST /api/missions — focal-brand round-trip.
 *
 * The competitor gate (missions.js) validates req.body.brand_name and 400s
 * with `brand_required` when it is missing. But the insert payload never
 * carried brand_name, so a mission that PASSED the gate still landed with
 * brand_name NULL — precisely the failure the gate exists to prevent (the
 * report then leans on focalBrand.js to derive a name from the brief).
 *
 * This locks the round trip: what the gate validates is what gets written.
 * Also covers category + audience_description, dropped the same way, and the
 * camelCase aliases API callers may send.
 *
 * Why this went unnoticed: the web app inserts missions client-side via
 * supabase-js (MissionSetupPage.tsx), so the API create path is exercised
 * almost exclusively by scripts and integrations.
 */
const express = require('express');
const request = require('supertest');

jest.mock('../src/middleware/auth', () => ({
  authenticate: (req, _res, next) => { req.user = { id: 'u1', email: 'owner@test.dev' }; next(); },
  optionalAuthenticate: (req, _res, next) => { req.user = { id: 'u1', email: 'owner@test.dev' }; next(); },
}));
jest.mock('../src/utils/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../src/services/stripe', () => ({ createCheckoutSession: jest.fn(), createPromoOnStripe: jest.fn(), updateStripePromoActive: jest.fn() }));
jest.mock('../src/jobs/runMission', () => ({ runMission: jest.fn() }));
jest.mock('../src/services/ai/insights', () => ({ synthesizeInsights: jest.fn(), aggregate: jest.fn() }));
// Pass the patch through untouched so the test asserts on what the ROUTE built.
jest.mock('../src/db/missionSchema', () => ({
  updateMission: jest.fn(async () => ({})),
  sanitizeMissionPatch: (p) => ({ patch: p, rejected: [] }),
}));

let mockLastInsert = null; // mock-prefixed: jest factory hoisting rule
jest.mock('../src/db/supabase', () => {
  const makeChain = () => {
    const chain = {
      select: () => chain, eq: () => chain, order: () => chain, limit: () => chain, update: () => chain,
      insert: (row) => { mockLastInsert = Array.isArray(row) ? row[0] : row; return chain; },
      single: async () => ({ data: { id: 'm-new', ...(mockLastInsert || {}) }, error: null }),
      maybeSingle: async () => ({ data: null, error: null }),
      then: (onF, onR) => Promise.resolve({ data: { id: 'm-new', ...(mockLastInsert || {}) }, error: null }).then(onF, onR),
    };
    return chain;
  };
  return { from: () => makeChain(), auth: { admin: { getUserById: async () => ({ data: { user: { email: 'owner@test.dev' } } }) } } };
});

const app = express();
app.use(express.json());
app.use('/api/missions', require('../src/routes/missions'));
app.use((err, _req, res, _next) => res.status(500).json({ error: err.message }));

const body = (over = {}) => ({
  goalType: 'competitor', brief: 'Benchmark us against rivals', respondentCount: 30, ...over,
});

beforeEach(() => { mockLastInsert = null; });

describe('POST /api/missions — brand_name round trip', () => {
  test('competitor without a focal brand is still rejected (gate intact)', async () => {
    const res = await request(app).post('/api/missions').send(body());
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('brand_required');
    expect(mockLastInsert).toBeNull();
  });

  test('snake_case brand_name is PERSISTED, not just validated', async () => {
    const res = await request(app).post('/api/missions').send(body({ brand_name: 'SpeedEats' }));
    expect(res.status).toBeLessThan(400);
    expect(mockLastInsert).not.toBeNull();
    expect(mockLastInsert.brand_name).toBe('SpeedEats');
  });

  test('camelCase brandName is persisted too (the gate accepts both)', async () => {
    const res = await request(app).post('/api/missions').send(body({ brandName: 'SpeedEats' }));
    expect(res.status).toBeLessThan(400);
    expect(mockLastInsert.brand_name).toBe('SpeedEats');
  });

  test('category + audience_description round-trip, both cases', async () => {
    await request(app).post('/api/missions').send(body({
      brand_name: 'SpeedEats', category: 'food delivery', audience_description: 'UAE urban commuters',
    }));
    expect(mockLastInsert.category).toBe('food delivery');
    expect(mockLastInsert.audience_description).toBe('UAE urban commuters');

    mockLastInsert = null;
    await request(app).post('/api/missions').send(body({
      brandName: 'SpeedEats', audienceDescription: 'UAE urban commuters',
    }));
    expect(mockLastInsert.audience_description).toBe('UAE urban commuters');
  });

  test('non-competitor goals may carry a brand and are unaffected by the gate', async () => {
    const res = await request(app).post('/api/missions').send(body({ goalType: 'research', brand_name: 'SpeedEats' }));
    expect(res.status).toBeLessThan(400);
    expect(mockLastInsert.brand_name).toBe('SpeedEats');
  });

  test('omitted optional fields are not written as undefined/null keys', async () => {
    await request(app).post('/api/missions').send(body({ brand_name: 'SpeedEats' }));
    expect(Object.prototype.hasOwnProperty.call(mockLastInsert, 'category')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(mockLastInsert, 'audience_description')).toBe(false);
  });
});
