/**
 * The "why did this persona answer X?" modal must show the SAME reasons twice.
 *
 * THE DEFECT. GET /api/results/:missionId/reasoning reads
 * persona_response_reasoning ordered by `created_at` descending and cuts the
 * result with `.limit(limit)` (default 5, max 20). This does not page, so it
 * cannot duplicate rows the way the admin lists could - but the cut itself is
 * the problem. `created_at` has no unique index (verified READ-ONLY against
 * production pg_index on 2026-09-06) and defaults to now(), the Postgres
 * TRANSACTION clock. The reasoning rows for one mission+question are written as
 * a single batch, so they all share one timestamp: production carries a
 * (mission_id, question_id) group of 10 rows on an identical created_at, and
 * tie groups of 200 exist on the table overall.
 *
 * With every candidate row tied, "the 5 newest" is not a defined set. The
 * database is free to return a different five each time, so a user who reopens
 * the same modal, or refreshes, sees different quotes for the same question and
 * the same answer value - with nothing indicating the sample changed.
 *
 * The fix orders by `persona_id` after `created_at`. The table's unique index
 * is (mission_id, persona_id, question_id), and this route pins mission_id and
 * question_id with .eq(), so persona_id is unique across the candidate set and
 * the sort becomes total.
 *
 * POSITIVE CONTROL. Remove the `.order('persona_id')` line from
 * src/routes/results.js and the stability tests below fail: the mock in
 * test/helpers/unstableSortTable.js rotates rows that are still tied after the
 * caller's ORDER BY keys, which is what a real planner may do.
 */
const express = require('express');
const request = require('supertest');
const { makeUnstableSupabase } = require('./helpers/unstableSortTable');

jest.mock('../src/middleware/auth', () => ({
  authenticate: (req, _res, next) => { req.user = { id: 'owner', email: 'owner@test.dev' }; next(); },
  optionalAuthenticate: (req, _res, next) => next(),
}));
jest.mock('../src/utils/logger', () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
}));
// The results router pulls in the heavy export builders at module load.
jest.mock('../src/services/exports/pdf-v2', () => ({ buildPDF: jest.fn() }));
jest.mock('../src/services/exports/pdf', () => ({ buildPDF: jest.fn() }));
jest.mock('../src/services/exports/pptx', () => ({ buildPPTX: jest.fn() }));
jest.mock('../src/services/exports/xlsx', () => ({ buildXLSX: jest.fn() }));

const MISSION_ID = 'mission-abc';
const QUESTION_ID = 'q3';

const tables = { missions: [], persona_response_reasoning: [] };
const mock = makeUnstableSupabase(tables);
jest.mock('../src/db/supabase', () => mock.client);

const app = express();
app.use(express.json());
app.use('/api/results', require('../src/routes/results'));
app.use((err, _req, res, _next) => res.status(500).json({ error: err.message }));

/** One batch write: every row carries the same created_at. */
const TIED_TS = '2026-05-03T11:02:44.000000+00:00';

const buildReasoning = (n) => Array.from({ length: n }, (_, i) => ({
  id: `prr-${String(i).padStart(3, '0')}`,
  mission_id: MISSION_ID,
  question_id: QUESTION_ID,
  persona_id: `persona-${String(i).padStart(3, '0')}`,
  response_value: 'Strongly agree',
  reasoning_text: `reason ${i}`,
  created_at: TIED_TS,
}));

const fetchSample = async (query = '') => {
  const res = await request(app)
    .get(`/api/results/${MISSION_ID}/reasoning?question_id=${QUESTION_ID}${query}`);
  expect(res.status).toBe(200);
  return res.body.rows.map((r) => r.persona_id);
};

beforeEach(() => {
  tables.missions = [{ id: MISSION_ID, user_id: 'owner' }];
  // The production shape: a batch of 10 reasoning rows on one timestamp,
  // read back through a default limit of 5.
  tables.persona_response_reasoning = buildReasoning(10);
  mock.reset();
});

describe('GET /api/results/:missionId/reasoning samples deterministically', () => {
  test('two identical requests return the same personas, in the same order', async () => {
    const first = await fetchSample();
    const second = await fetchSample();
    const third = await fetchSample();

    expect(first).toHaveLength(5);
    expect(second).toEqual(first);
    expect(third).toEqual(first);
  });

  test('the sample is stable across every supported limit', async () => {
    for (const limit of [1, 3, 5, 9, 20]) {
      const a = await fetchSample(`&limit=${limit}`);
      const b = await fetchSample(`&limit=${limit}`);
      expect(b).toEqual(a);
    }
  });

  test('a wider limit is a superset of a narrower one, not a different draw', async () => {
    const five = await fetchSample('&limit=5');
    const ten = await fetchSample('&limit=10');
    // If the cut were arbitrary these two draws would disagree; a total sort
    // means the first five of ten ARE the five.
    expect(ten.slice(0, 5)).toEqual(five);
  });

  test('the sort ends in a column that is unique within mission+question', async () => {
    await fetchSample();
    const cols = mock.orderCalls
      .filter((o) => o.table === 'persona_response_reasoning')
      .map((o) => o.col);
    expect(cols).toContain('created_at');
    expect(cols[cols.length - 1]).toBe('persona_id');
  });
});
