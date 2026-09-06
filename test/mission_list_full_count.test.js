/**
 * GET /api/missions must return EVERY mission the user owns.
 *
 * THE BUG. The route applied a flat `.limit(MISSION_LIST_DEFAULT_LIMIT = 100)`
 * whenever the caller sent no `?limit`. MissionsListPage.tsx never sends one,
 * and it renders `${missions.length} missions total` directly off the response
 * length. Verified against production on 2026-09-06: the owner account holds
 * 112 mission rows and the dashboard read "100 missions total" - a wrong number
 * presented as a fact, with 12 missions absent from the grid and nothing
 * indicating anything had been withheld.
 *
 * This is the same class of defect as the PostgREST 1000-row cap that produced
 * a fabricated sample size earlier in this codebase: a silently truncated read
 * whose result is then reported as a total. src/db/fetchAllResponses.js exists
 * because of that one. This route now pages the same way.
 *
 * The tests below pin three separate things, because the fix has three parts
 * and two of them are easy to drop without noticing:
 *   - every row comes back, across more than one page
 *   - the sort carries a UNIQUE tiebreaker, or rows duplicate and vanish
 *     across page boundaries when created_at ties
 *   - an explicit ?limit still slices, for callers that want a preview
 */
const express = require('express');
const request = require('supertest');

jest.mock('../src/middleware/auth', () => ({
  authenticate: (req, _res, next) => { req.user = { id: 'u1', email: 'u1@test.dev' }; next(); },
  optionalAuthenticate: (req, _res, next) => { req.user = { id: 'u1', email: 'u1@test.dev' }; next(); },
}));
const mockWarn = jest.fn();
jest.mock('../src/utils/logger', () => ({
  info: jest.fn(), warn: (...a) => mockWarn(...a), error: jest.fn(), debug: jest.fn(),
}));
jest.mock('../src/services/stripe', () => ({
  createCheckoutSession: jest.fn(), createPaymentIntent: jest.fn(),
  createPromoOnStripe: jest.fn(), updateStripePromoActive: jest.fn(),
}));
jest.mock('../src/jobs/runMission', () => ({ runMission: jest.fn(async () => ({})) }));

// The synthetic table. Every row shares a created_at on purpose: that is the
// production shape (seeded and audit missions were written in bulk) and it is
// what makes a non-unique sort key unsafe to page on.
let mockRows = [];
const mockRangeCalls = [];
const mockOrderCalls  = [];

jest.mock('../src/db/supabase', () => {
  const makeChain = () => {
    const chain = {
      select: () => chain,
      eq:     () => chain,
      order:  (col, opts) => { mockOrderCalls.push({ col, ...(opts || {}) }); return chain; },
      limit:  (n) => {
        // The OLD code path. Record it so a regression is visible as a
        // truncated result rather than as a silent pass.
        chain._limit = n;
        return chain;
      },
      range: (from, to) => {
        mockRangeCalls.push([from, to]);
        chain._range = [from, to];
        return chain;
      },
      then: (onF, onR) => {
        const src = mockRows;
        let out;
        if (chain._range) {
          const [from, to] = chain._range;
          out = src.slice(from, to + 1);
        } else if (chain._limit != null) {
          out = src.slice(0, chain._limit);
        } else {
          out = src.slice();
        }
        return Promise.resolve({ data: out, error: null }).then(onF, onR);
      },
    };
    return chain;
  };
  return { from: () => makeChain(), auth: { admin: { getUserById: async () => ({ data: { user: {} } }) } } };
});

const app = express();
app.use(express.json());
app.use('/api/missions', require('../src/routes/missions'));
app.use((err, _req, res, _next) => res.status(500).json({ error: err.message }));

const buildRows = (n) => Array.from({ length: n }, (_, i) => ({
  id: `m${String(i).padStart(4, '0')}`,
  user_id: 'u1',
  title: `mission ${i}`,
  // Deliberately identical across every row.
  created_at: '2026-04-22T00:00:00.000Z',
  mission_responses: [{ count: 0 }],
}));

beforeEach(() => {
  mockRows = [];
  mockRangeCalls.length = 0;
  mockOrderCalls.length = 0;
  mockWarn.mockClear();
});

describe('GET /api/missions returns every row the user owns', () => {
  test('112 missions (the production count) all come back, not 100', async () => {
    mockRows = buildRows(112);
    const res = await request(app).get('/api/missions');
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(112);
  });

  test('the response is not silently truncated at any page boundary', async () => {
    mockRows = buildRows(437);
    const res = await request(app).get('/api/missions');
    expect(res.body).toHaveLength(437);
    // Every id present exactly once: no drops, no duplicates.
    const ids = new Set(res.body.map(r => r.id));
    expect(ids.size).toBe(437);
  });

  test('a count that is an exact multiple of the page size still terminates', async () => {
    mockRows = buildRows(400);
    const res = await request(app).get('/api/missions');
    expect(res.body).toHaveLength(400);
  });

  test('reads are paged, not one unbounded request', async () => {
    mockRows = buildRows(250);
    await request(app).get('/api/missions');
    expect(mockRangeCalls.length).toBeGreaterThan(1);
    // Pages must be contiguous and non-overlapping.
    for (let i = 1; i < mockRangeCalls.length; i++) {
      expect(mockRangeCalls[i][0]).toBe(mockRangeCalls[i - 1][1] + 1);
    }
  });

  test('the sort carries a unique tiebreaker so paging is stable', async () => {
    mockRows = buildRows(250);
    await request(app).get('/api/missions');
    const cols = mockOrderCalls.map(o => o.col);
    expect(cols).toContain('created_at');
    // Without this, rows with equal created_at reorder between requests and
    // page boundaries both drop and duplicate rows.
    expect(cols).toContain('id');
  });

  test('an explicit ?limit still slices', async () => {
    mockRows = buildRows(112);
    const res = await request(app).get('/api/missions?limit=10');
    expect(res.body).toHaveLength(10);
  });

  test('responses_collected is still flattened off the join', async () => {
    mockRows = buildRows(3).map((r, i) => ({ ...r, mission_responses: [{ count: i * 5 }] }));
    const res = await request(app).get('/api/missions');
    expect(res.body.map(r => r.responses_collected)).toEqual([0, 5, 10]);
  });
});
