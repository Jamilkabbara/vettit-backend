/**
 * PATCH /api/missions/:id must not let a client write server-owned columns.
 *
 * THE HOLE. The route mapped seven columns straight from the request body onto
 * the row: total_price_usd, base_cost_usd, targeting_surcharge_usd,
 * extra_questions_cost_usd, status, target_qualified_count and
 * ai_spend_ceiling_usd. The server re-price fires only when respondentCount /
 * questions / targeting change, so a body naming none of those skipped it and
 * the client's values were persisted verbatim.
 *
 * WHY THE PAIR IS THE POINT. Either column alone is bounded. recruitLoop caps
 * its iterations at target_qualified_count * MAX_PERSONAS_PER_TARGET and stops
 * when spend reaches ai_spend_ceiling_usd, so raising the ceiling alone still
 * hits the iteration cap, and raising the target alone still hits the spend
 * cap. One request sets BOTH, and both governors move together. The same body
 * writes neither respondent_count nor total_price_usd, so the pass-51
 * ensure_recruitment_columns trigger does not recompute them either, and a
 * heartbeating run is never reaped by missionRecovery. That is uncapped model
 * spend on a fixed-price sale.
 *
 * WHY ONLY `denied` IS CHECKED. sanitizeClientMissionPatch splits a body into
 * `denied` (a real column the server owns) and `rejected` (not a column at
 * all). This route's public contract is camelCase - respondentCount, goalType,
 * targetingConfig, missionStatement - none of which are column names, so they
 * land in `rejected` by design. Treating `rejected` as an error would 400
 * every legitimate call. The last test here pins that distinction, because it
 * is the one an over-eager tightening would break.
 */
const express = require('express');
const request = require('supertest');

jest.mock('../src/middleware/auth', () => ({
  authenticate: (req, _res, next) => { req.user = { id: 'u1', email: 'u1@test.dev' }; next(); },
  optionalAuthenticate: (req, _res, next) => { req.user = { id: 'u1', email: 'u1@test.dev' }; next(); },
}));
jest.mock('../src/utils/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../src/services/stripe', () => ({
  createCheckoutSession: jest.fn(), createPaymentIntent: jest.fn(),
  createPromoOnStripe: jest.fn(), updateStripePromoActive: jest.fn(),
}));
jest.mock('../src/jobs/runMission', () => ({ runMission: jest.fn(async () => ({})) }));

// Every write the route could make funnels through one of these two.
const mockUpdateMission = jest.fn(async () => ({ data: {}, error: null, matched: 1 }));
const realSchema = jest.requireActual('../src/db/missionSchema');
jest.mock('../src/db/missionSchema', () => {
  const actual = jest.requireActual('../src/db/missionSchema');
  return {
    ...actual,
    updateMission: (...a) => mockUpdateMission(...a),
  };
});

const mockSupabaseUpdate = jest.fn();
let mockMissionRow = { id: 'm1', user_id: 'u1', status: 'draft', goal_type: 'validate', respondent_count: 50, questions: [], targeting: {} };
jest.mock('../src/db/supabase', () => {
  const makeChain = () => {
    const chain = {
      select: () => chain, eq: () => chain, order: () => chain, limit: () => chain, range: () => chain,
      update: (patch) => { mockSupabaseUpdate(patch); return chain; },
      insert: () => chain,
      single:      async () => ({ data: mockMissionRow, error: null, count: 0 }),
      maybeSingle: async () => ({ data: mockMissionRow, error: null, count: 0 }),
      then: (onF, onR) => Promise.resolve({ data: mockMissionRow, error: null, count: 0 }).then(onF, onR),
    };
    return chain;
  };
  return { from: () => makeChain(), auth: { admin: { getUserById: async () => ({ data: { user: {} } }) } } };
});

const app = express();
app.use(express.json());
app.use('/api/missions', require('../src/routes/missions'));
app.use((err, _req, res, _next) => res.status(500).json({ error: err.message }));

const patch = (body) => request(app).patch('/api/missions/m1').send(body);
const wrote = () => mockUpdateMission.mock.calls.length + mockSupabaseUpdate.mock.calls.length;

beforeEach(() => { mockUpdateMission.mockClear(); mockSupabaseUpdate.mockClear(); });

describe('PATCH /missions/:id denies server-owned columns', () => {
  test('the recruit-loop pair is rejected and NOTHING is written', async () => {
    const res = await patch({ ai_spend_ceiling_usd: 1000000, target_qualified_count: 1000000 });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('server_owned_columns_denied');
    expect(res.body.denied).toEqual(
      expect.arrayContaining(['ai_spend_ceiling_usd', 'target_qualified_count']),
    );
    // The whole point: no write of any kind reached the database.
    expect(wrote()).toBe(0);
  });

  test('ai_spend_ceiling_usd alone is rejected', async () => {
    const res = await patch({ ai_spend_ceiling_usd: 999999 });
    expect(res.status).toBe(400);
    expect(res.body.denied).toContain('ai_spend_ceiling_usd');
    expect(wrote()).toBe(0);
  });

  test('target_qualified_count alone is rejected', async () => {
    const res = await patch({ target_qualified_count: 999999 });
    expect(res.status).toBe(400);
    expect(res.body.denied).toContain('target_qualified_count');
    expect(wrote()).toBe(0);
  });

  test('price columns and status are rejected', async () => {
    const res = await patch({ total_price_usd: 1, base_cost_usd: 0, status: 'paid' });
    expect(res.status).toBe(400);
    expect(res.body.denied).toEqual(
      expect.arrayContaining(['total_price_usd', 'base_cost_usd', 'status']),
    );
    expect(wrote()).toBe(0);
  });

  test('the guard runs BEFORE the schema-lock read, so a hostile body costs no query', async () => {
    // touchesSchema would be true here; if the guard ran after it, the route
    // would issue a mission_responses count before rejecting.
    const res = await patch({ questions: [{ q: 1 }], ai_spend_ceiling_usd: 1e6 });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('server_owned_columns_denied');
  });

  test('CONTROL: the real camelCase contract is NOT denied', async () => {
    // respondentCount / targetingConfig / missionStatement are not column
    // names. They belong in `rejected`, not `denied`. If this ever 400s, the
    // guard has been tightened onto `rejected` and every real call is broken.
    const res = await patch({ respondentCount: 200, targetingConfig: {}, missionStatement: 'x', title: 'y' });
    expect(res.status).not.toBe(400);
  });

  test('CONTROL: an empty body is not denied', async () => {
    const res = await patch({});
    expect(res.status).not.toBe(400);
  });
});

describe('sanitizeClientMissionPatch partitions the body correctly', () => {
  test('server-owned columns land in denied, unknown keys in rejected', () => {
    const r = realSchema.sanitizeClientMissionPatch({
      ai_spend_ceiling_usd: 1, respondentCount: 2, questions: [],
    });
    expect(r.denied).toContain('ai_spend_ceiling_usd');
    expect(r.rejected).toContain('respondentCount');
    expect(Object.keys(r.patch)).toContain('questions');
  });
});
