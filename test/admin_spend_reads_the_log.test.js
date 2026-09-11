/**
 * Every admin spend figure must come from the ai_calls log, in full.
 *
 * THE DEFECT, IN TWO HALVES.
 *
 * 1. WRONG SOURCE. `missions.ai_cost_usd` / `missions.ai_spend_usd_actual` are
 *    denormalised running sums maintained at the call site. They have been
 *    wrong three separate ways (vision calls never rolled up, the newer column
 *    was added late and never backfilled, float drift), and 8 legacy rows can
 *    no longer be corrected at all because a NOT VALID CHECK constraint blocks
 *    the update. `ai_calls` - one row per call, written with the cost that call
 *    actually incurred - is the record of truth.
 *
 *    GET /api/admin/ai-costs served `mission_margins` from the
 *    admin_mission_margins RPC, which read COALESCE(m.ai_cost_usd, 0) for the
 *    cost, the net margin, the margin percent, and the ORDER BY that picks
 *    which missions are the "worst margin" ones. GET /api/admin/revenue took
 *    its headline gross profit from the log but drew the daily Cost and Profit
 *    lines underneath it from daily_revenue_buckets' SUM(m.ai_cost_usd) - two
 *    different costs in one response, and the flattering one was the chart.
 *
 * 2. SHORT READ. PostgREST caps an unbounded SELECT at 1000 rows and returns a
 *    200 with no warning. Production holds 3,434 ai_calls rows and 1,903 in the
 *    default 30-day window, so the handlers that DID read the log were summing
 *    the first 1000 of it. Measured read-only against production on 2026-09-11:
 *    the per-mission rollup behind the admin Missions tab returned exactly 1000
 *    rows summing to $4.50 where the true figure across those missions was
 *    $12.63. A short read of the log is as wrong as reading the stale column,
 *    and wrong in the same direction - it understates spend, which flatters
 *    margin.
 *
 * WHY THE FAKE CAPS AT 1000. The fake PostgREST below enforces the same 1000
 * row ceiling a real one does. Drop the paging from src/routes/admin.js and the
 * ">1000 calls" assertions below fail. A fake that returned everything would
 * pass with and without the fix.
 */
const express = require('express');
const request = require('supertest');

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

const { client: fake, tables, rpcResponses, reset: resetFake } = require('./helpers/cappedPostgrest');

jest.mock('../src/db/supabase', () => require('./helpers/cappedPostgrest').client);

const app = express();
app.use(express.json());
app.use('/api/admin', require('../src/routes/admin'));
app.use((err, _req, res, _next) => res.status(500).json({ error: err.message }));

const DAY = '2026-09-01';
const TS = (d, h = 0) => `${d}T${String(h).padStart(2, '0')}:00:00.000+00:00`;

function reset() {
  resetFake();
  tables.missions = [];
  tables.profiles = [];
  tables.ai_calls = [];
  rpcResponses.admin_ai_cost_summary = {};
  rpcResponses.admin_ai_cost_by_operation = [];
  rpcResponses.admin_ai_model_mix = [];
  rpcResponses.admin_funnel = {};
  rpcResponses.admin_user_segments = [];
  rpcResponses.admin_activity_feed = [];
}

/** A mission whose STORED cost column is a lie, and the calls that prove it. */
function seedMission({ id, price, storedCost, calls }) {
  tables.missions.push({
    id,
    user_id: 'user-1',
    title: `mission ${id}`,
    status: 'completed',
    goal_type: 'validate',
    brief: 'b',
    total_price_usd: price,
    // The stale denormalised sum. Nothing in the response may equal this.
    ai_cost_usd: storedCost,
    ai_spend_usd_actual: storedCost,
    respondent_count: 40,
    country: 'AE',
    promo_code: null,
    discount_usd: 0,
    created_at: TS(DAY),
    paid_at: TS(DAY),
    completed_at: TS(DAY),
    executive_summary: 'x',
  });
  calls.forEach((cost, i) => {
    tables.ai_calls.push({
      id: `${id}-call-${String(i).padStart(5, '0')}`,
      mission_id: id,
      cost_usd: cost,
      purpose: 'simulate',
      created_at: TS(DAY, 1),
    });
  });
}

beforeEach(reset);

describe('fetchAllRows', () => {
  const fetchAllRows = require('../src/db/fetchAllRows');

  it('reads past the 1000-row ceiling instead of stopping at it', async () => {
    tables.ai_calls = Array.from({ length: 2350 }, (_, i) => ({
      id: `c-${String(i).padStart(6, '0')}`,
      mission_id: 'm1',
      cost_usd: 0.01,
    }));
    const { data, error } = await fetchAllRows(fake, {
      table: 'ai_calls', columns: 'id, cost_usd',
    });
    expect(error).toBeNull();
    expect(data).toHaveLength(2350);
    // The number an unpaged read would have produced, for contrast.
    expect(data.reduce((s, r) => s + r.cost_usd, 0)).toBeCloseTo(23.5, 6);
  });

  it('returns each row exactly once across page boundaries', async () => {
    tables.ai_calls = Array.from({ length: 2001 }, (_, i) => ({
      id: `c-${String(i).padStart(6, '0')}`, mission_id: 'm1', cost_usd: 1,
    }));
    const { data } = await fetchAllRows(fake, {
      table: 'ai_calls', columns: 'id, cost_usd',
    });
    expect(new Set(data.map((r) => r.id)).size).toBe(2001);
  });

  it('passes a PostgREST error straight back instead of returning a short sum', async () => {
    const failing = { from: () => ({
      select: () => ({ order: () => ({ range: () => Promise.resolve({ data: null, error: { message: 'boom' } }) }) }),
    }) };
    const { data, error } = await fetchAllRows(failing, { table: 'ai_calls', columns: 'id' });
    expect(data).toBeNull();
    expect(error.message).toBe('boom');
  });
});

describe('GET /api/admin/ai-costs — mission_margins', () => {
  it('costs each mission from ai_calls, never from missions.ai_cost_usd', async () => {
    // Stored column says $1.00. The log says $4.00. The log is right.
    seedMission({ id: 'm-drifted', price: 100, storedCost: 1, calls: [1, 1, 1, 1] });

    const res = await request(app).get('/api/admin/ai-costs?range=30d');
    expect(res.status).toBe(200);

    const row = res.body.mission_margins.find((m) => m.mission_id === 'm-drifted');
    expect(row.ai_cost_usd).toBeCloseTo(4, 4);
    expect(row.cost_usd).toBeCloseTo(4, 4);
    // Revenue is the stored price - that IS what the customer was billed.
    expect(row.revenue_usd).toBeCloseTo(100, 4);
    expect(row.net_margin_usd).toBeCloseTo(96, 4);
    expect(row.margin_pct).toBeCloseTo(96, 2);
    // The stale number must not survive anywhere in the row.
    expect(row.net_margin_usd).not.toBeCloseTo(99, 4);
  });

  it('ranks worst-margin missions by LOGGED spend, not by the stale column', async () => {
    // By the stored column, cheap-looking is the worse margin ($100 - $9).
    // By the log it is the better one, and expensive-looking is the disaster.
    seedMission({ id: 'cheap-looking',     price: 100, storedCost: 9, calls: [1] });
    seedMission({ id: 'expensive-looking', price: 100, storedCost: 1, calls: Array(80).fill(1) });

    const res = await request(app).get('/api/admin/ai-costs?range=30d');
    expect(res.status).toBe(200);
    expect(res.body.mission_margins.map((m) => m.mission_id))
      .toEqual(['expensive-looking', 'cheap-looking']);
  });

  it('sums more than 1000 logged calls for one mission', async () => {
    seedMission({ id: 'big', price: 500, storedCost: 0, calls: Array(1500).fill(0.01) });

    const res = await request(app).get('/api/admin/ai-costs?range=30d');
    const row = res.body.mission_margins.find((m) => m.mission_id === 'big');
    // An unpaged read would have stopped at 1000 calls and reported $10.00.
    expect(row.ai_cost_usd).toBeCloseTo(15, 4);
  });
});

describe('GET /api/admin/ai-costs — daily buckets', () => {
  it('does not stop summing the log at 1000 calls in the window', async () => {
    seedMission({ id: 'm1', price: 100, storedCost: 0, calls: Array(1400).fill(0.01) });

    const res = await request(app).get('/api/admin/ai-costs?range=30d');
    const total = res.body.daily_buckets.reduce((s, b) => s + b.cost_usd, 0);
    expect(total).toBeCloseTo(14, 4);
  });
});

describe('GET /api/admin/revenue', () => {
  it('draws the daily cost line from ai_calls, not from the RPC cost column', async () => {
    seedMission({ id: 'm1', price: 100, storedCost: 1, calls: [1, 1, 1, 1] });
    // What daily_revenue_buckets returns: its third column is SUM(ai_cost_usd),
    // i.e. the stale $1.00. The handler must ignore it.
    rpcResponses.daily_revenue_buckets = [
      { bucket_date: DAY, revenue_usd: 100, ai_cost_usd: 1, mission_count: 1 },
    ];

    const res = await request(app).get('/api/admin/revenue?range=30d');
    expect(res.status).toBe(200);

    const bucket = res.body.daily_buckets.find((b) => b.day === DAY);
    expect(bucket.cost_usd).toBeCloseTo(4, 4);
    expect(bucket.revenue_usd).toBeCloseTo(100, 4);

    // The chart and the headline must agree about what was spent.
    expect(res.body.gross_profit.value).toBeCloseTo(96, 4);
    expect(bucket.revenue_usd - bucket.cost_usd).toBeCloseTo(res.body.gross_profit.value, 4);
  });

  it('does not truncate the mission cost rollup at 1000 calls', async () => {
    seedMission({ id: 'm1', price: 500, storedCost: 0, calls: Array(1200).fill(0.01) });
    rpcResponses.daily_revenue_buckets = [];

    const res = await request(app).get('/api/admin/revenue?range=30d');
    // Unpaged: $10.00 of cost and a $490.00 gross profit.
    expect(res.body.gross_profit.value).toBeCloseTo(488, 4);
  });
});

describe('GET /api/admin/missions', () => {
  it('rolls up more than 1000 logged calls across the page', async () => {
    seedMission({ id: 'm1', price: 100, storedCost: 0, calls: Array(700).fill(0.01) });
    seedMission({ id: 'm2', price: 100, storedCost: 0, calls: Array(700).fill(0.01) });

    const res = await request(app).get('/api/admin/missions?limit=50');
    expect(res.status).toBe(200);
    const byId = Object.fromEntries(res.body.data.map((m) => [m.id, m]));
    // Unpaged, the 1400 calls are cut to 1000 and one mission comes back short.
    expect(byId.m1.ai_cost_usd).toBeCloseTo(7, 4);
    expect(byId.m2.ai_cost_usd).toBeCloseTo(7, 4);
    expect(byId.m1.margin_usd).toBeCloseTo(93, 4);
  });

  it('still falls back to the stored column for a mission with no logged calls', async () => {
    // Legacy rows pre-date the log. The column is all there is, and the
    // fallback is deliberate - see the handler comment.
    seedMission({ id: 'legacy', price: 100, storedCost: 2.5, calls: [] });

    const res = await request(app).get('/api/admin/missions?limit=50');
    const row = res.body.data.find((m) => m.id === 'legacy');
    expect(row.ai_cost_usd).toBeCloseTo(2.5, 4);
  });
});
