/**
 * The admin list endpoints must not lose rows across page boundaries.
 *
 * THE DEFECT. GET /api/admin/missions and GET /api/admin/users both page with
 * `.range(offset, offset + limit - 1)` over `.order('created_at')` and return
 * `total` from a `{ count: 'exact' }` select. AdminMissions.tsx and
 * AdminUsers.tsx render that as "1-50 of 121" with prev/next buttons.
 *
 * `created_at` is not unique on either table. Verified READ-ONLY against
 * production pg_index on 2026-09-06: the only unique indexes on `missions` and
 * `profiles` are their `id` primary keys. Both columns default to the
 * transaction clock (`now()` / `timezone('utc', now())`), and in Postgres
 * now() is the TRANSACTION timestamp, not the statement one - so every row
 * inserted by a single bulk statement carries a byte-identical value. The same
 * shape is already visible in production on sibling tables: with mission_id and
 * question_id fixed, persona_response_reasoning has tie groups of 200 rows on
 * created_at, and mission_responses.answered_at has tie groups of 200.
 *
 * When the sort key ties, the database may arrange those rows differently for
 * the page-1 request than for the page-2 request. A row then lands in both
 * windows, or in neither, and `total` still reports the exact count - so the
 * admin sees a complete-looking list that is silently missing accounts and
 * showing others twice. This is the third instance of this class in this
 * codebase (see mission_list_full_count.test.js for the second).
 *
 * The fix is `.order('id')` as a final, unique tiebreaker.
 *
 * WHY THE MOCK SHUFFLES. test/helpers/unstableSortTable.js applies the caller's
 * ORDER BY keys and then breaks any REMAINING tie with a permutation that
 * rotates per query - what a real planner is entitled to do. Remove the
 * `.order('id')` lines from src/routes/admin.js and the "exactly once" tests
 * below fail. A mock that preserved insertion order would pass either way.
 */
const express = require('express');
const request = require('supertest');
const { makeUnstableSupabase } = require('./helpers/unstableSortTable');

jest.mock('../src/middleware/auth', () => ({
  authenticate: (req, _res, next) => {
    req.user = { id: 'admin', email: process.env.ADMIN_EMAIL || 'kabbarajamil@gmail.com' };
    next();
  },
  optionalAuthenticate: (req, _res, next) => next(),
}));
jest.mock('../src/utils/logger', () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
}));
jest.mock('../src/services/stripe', () => ({
  createPromoOnStripe: jest.fn(), updateStripePromoActive: jest.fn(),
  createCheckoutSession: jest.fn(), createPaymentIntent: jest.fn(),
}));

const tables = { missions: [], profiles: [], ai_calls: [] };
const mock = makeUnstableSupabase(tables);
jest.mock('../src/db/supabase', () => mock.client);

const app = express();
app.use(express.json());
app.use('/api/admin', require('../src/routes/admin'));
app.use((err, _req, res, _next) => res.status(500).json({ error: err.message }));

/**
 * The production shape: written in bulk, so every row shares one timestamp.
 * That is the ONLY shape that exposes a missing tiebreaker.
 */
const TIED_TS = '2026-04-22T09:15:00.000000+00:00';

const buildMissions = (n) => Array.from({ length: n }, (_, i) => ({
  id: `mission-${String(i).padStart(4, '0')}`,
  user_id: `user-${i % 4}`,
  status: 'completed',
  goal_type: 'market_entry',
  brief: `brief ${i}`,
  total_price_usd: 100,
  ai_cost_usd: 1,
  respondent_count: 60,
  country: 'AE',
  promo_code: null,
  discount_usd: 0,
  created_at: TIED_TS,
  paid_at: TIED_TS,
  completed_at: TIED_TS,
  executive_summary: 'x'.repeat(120),
}));

const buildProfiles = (n) => Array.from({ length: n }, (_, i) => ({
  id: `user-${String(i).padStart(4, '0')}`,
  first_name: `First${i}`,
  last_name: `Last${i}`,
  full_name: `First${i} Last${i}`,
  company_name: `Co ${i}`,
  role: 'founder',
  project_stage: 'idea',
  is_admin: false,
  created_at: TIED_TS,
}));

/** Walk every page the UI would walk and return the ids, in page order. */
async function readAllPages(path, total, limit) {
  const ids = [];
  for (let offset = 0; offset < total; offset += limit) {
    const res = await request(app).get(`${path}?limit=${limit}&offset=${offset}`);
    expect(res.status).toBe(200);
    const rows = res.body.data || res.body.users || res.body;
    for (const r of rows) ids.push(r.id);
  }
  return ids;
}

beforeEach(() => {
  tables.missions = [];
  tables.profiles = [];
  tables.ai_calls = [];
  mock.reset();
});

describe('GET /api/admin/missions pages safely over a tied created_at', () => {
  test('every mission appears exactly once across the paged walk', async () => {
    const rows = buildMissions(121); // the production mission count
    tables.missions = rows;
    tables.profiles = buildProfiles(4);

    const seen = await readAllPages('/api/admin/missions', 121, 50);

    expect(seen).toHaveLength(121);
    expect(new Set(seen).size).toBe(121);            // no duplicates
    expect(new Set(seen)).toEqual(new Set(rows.map(r => r.id))); // nothing vanished
  });

  test('a small page size, which crosses more boundaries, is also exact', async () => {
    const rows = buildMissions(97);
    tables.missions = rows;

    const seen = await readAllPages('/api/admin/missions', 97, 7);

    expect(new Set(seen).size).toBe(97);
    expect(seen).toHaveLength(97);
  });

  test('`total` is only trustworthy because the walk is exact', async () => {
    tables.missions = buildMissions(121);
    const res = await request(app).get('/api/admin/missions?limit=50&offset=0');
    expect(res.body.total).toBe(121);
    const seen = await readAllPages('/api/admin/missions', res.body.total, 50);
    expect(seen).toHaveLength(res.body.total);
    // Length alone is not enough: a duplicate plus a drop keeps the length
    // correct while the list is wrong. Distinct ids must match the total too.
    expect(new Set(seen).size).toBe(res.body.total);
  });

  test('the sort ends in a unique column', async () => {
    tables.missions = buildMissions(10);
    await request(app).get('/api/admin/missions');
    const cols = mock.orderCalls.filter(o => o.table === 'missions').map(o => o.col);
    expect(cols).toContain('created_at');
    expect(cols[cols.length - 1]).toBe('id');
  });
});

describe('GET /api/admin/users pages safely over a tied created_at', () => {
  test('every profile appears exactly once across the paged walk', async () => {
    const rows = buildProfiles(213);
    tables.profiles = rows;

    const seen = await readAllPages('/api/admin/users', 213, 50);

    expect(seen).toHaveLength(213);
    expect(new Set(seen).size).toBe(213);
    expect(new Set(seen)).toEqual(new Set(rows.map(r => r.id)));
  });

  test('a page size that does not divide the total still loses nothing', async () => {
    const rows = buildProfiles(64);
    tables.profiles = rows;

    const seen = await readAllPages('/api/admin/users', 64, 25);

    expect(seen).toHaveLength(64);
    expect(new Set(seen).size).toBe(64);
  });

  test('the sort ends in a unique column', async () => {
    tables.profiles = buildProfiles(10);
    await request(app).get('/api/admin/users');
    const cols = mock.orderCalls.filter(o => o.table === 'profiles').map(o => o.col);
    expect(cols).toContain('created_at');
    expect(cols[cols.length - 1]).toBe('id');
  });
});
