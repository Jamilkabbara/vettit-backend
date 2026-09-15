'use strict';
/**
 * A failed read must surface as an error, never as an empty result.
 *
 * Before: the results/export loader and the results chat ignored the error
 * from fetchAllResponses and carried on with [], so GET /api/results/:id came
 * back 200 with every question at n=0 and the copilot answered from an empty
 * report. These tests drive the real route and the real chat service with a
 * database whose response read fails.
 */
const express = require('express');
const request = require('supertest');

const mockState = { missionRow: null, missionErr: null, responsesErr: null, writes: [] };

jest.mock('../src/utils/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../src/middleware/auth', () => ({
  authenticate: (req, _res, next) => { req.user = { id: 'user-1', email: 'u@example.com' }; next(); },
  optionalAuthenticate: (req, _res, next) => { req.user = { id: 'user-1' }; next(); },
}));
jest.mock('../src/db/fetchAllResponses', () => jest.fn(async () => (
  mockState.responsesErr ? { data: null, error: mockState.responsesErr } : { data: [], error: null }
)));
jest.mock('../src/db/supabase', () => {
  const build = (table) => {
    const q = { table, op: 'select' };
    const chain = {
      select: () => chain, eq: () => chain, gte: () => chain, order: () => chain, limit: () => chain, in: () => chain, is: () => chain, not: () => chain,
      insert: (p) => { q.op = 'insert'; mockState.writes.push([table, 'insert', p]); return chain; },
      update: (p) => { q.op = 'update'; mockState.writes.push([table, 'update', p]); return chain; },
      single: () => chain, maybeSingle: () => chain,
      then: (res, rej) => Promise.resolve(resolve(q)).then(res, rej),
    };
    return chain;
  };
  const resolve = (q) => {
    if (q.table === 'missions') return mockState.missionErr ? { data: null, error: mockState.missionErr } : { data: mockState.missionRow, error: null };
    if (q.table === 'chat_sessions') return { data: { id: 'sess-1', quota_limit: 30, messages_used: 0, quota_overage_purchased: 0, messages: [] }, error: null };
    return { data: null, error: null, count: 0 };
  };
  return { from: build, rpc: async () => ({ data: null, error: null }) };
});
jest.mock('../src/services/ai/anthropic', () => ({
  callClaude: jest.fn(async () => { throw new Error('model must not be called when the context failed'); }),
  streamClaude: jest.fn(async () => { throw new Error('model must not be called when the context failed'); }),
  extractJSON: (t) => JSON.parse(t),
  recordMissionAiSpend: jest.fn(),
  MODEL_ROUTING: { chat_results: 'claude-sonnet-4-6', chat_dashboard: 'claude-sonnet-4-6', chat_setup: 'claude-haiku-4-5' },
  MODEL_PRICING: {},
}));

const completed = { id: 'm-1', user_id: 'user-1', status: 'completed', goal_type: 'validate', questions: [{ id: 'q1', text: 'Q', type: 'single', options: ['a', 'b'] }], respondent_count: 50 };

function app(router, mount) {
  const a = express(); a.use(express.json()); a.use(mount, router);
  a.use(require('../src/middleware/errorHandler'));
  return a;
}

beforeEach(() => { Object.assign(mockState, { missionRow: completed, missionErr: null, responsesErr: null, writes: [] }); });

describe('results loader', () => {
  const { loadMissionForExport } = require('../src/services/exports/shared');

  test('a failed response read rejects with a retryable 503, not an empty pack', async () => {
    mockState.responsesErr = { message: 'page 3 of 25 failed', code: '57014' };
    await expect(loadMissionForExport('m-1', 'user-1')).rejects.toMatchObject({ status: 503, code: 'RESULTS_READ_FAILED' });
  });

  test('a failed mission read rejects; a genuine no-row is still not-found', async () => {
    mockState.missionErr = { message: 'connection reset', code: 'XX000' };
    await expect(loadMissionForExport('m-1', 'user-1')).rejects.toMatchObject({ status: 503 });
    mockState.missionErr = { message: 'no rows', code: 'PGRST116' };
    await expect(loadMissionForExport('m-1', 'user-1')).resolves.toBeNull();
  });

  test('positive control: a successful empty read still loads', async () => {
    await expect(loadMissionForExport('m-1', 'user-1')).resolves.toMatchObject({ mission: { id: 'm-1' } });
  });
});

describe('GET /api/results/:id', () => {
  const router = require('../src/routes/results');

  test('a failed response read is a 503, never a 200 with n=0', async () => {
    mockState.responsesErr = { message: 'page 3 of 25 failed' };
    const res = await request(app(router, '/api/results')).get('/api/results/m-1');
    expect(res.status).toBe(503);
    expect(res.body.aggregatedByQuestion).toBeUndefined();
  });

  test('a failed mission read is a 503, not "Mission not found"', async () => {
    mockState.missionErr = { message: 'connection reset', code: 'XX000' };
    const res = await request(app(router, '/api/results')).get('/api/results/m-1');
    expect(res.status).toBe(503);
  });

  test('positive control: the same route returns 200 when the read succeeds', async () => {
    const res = await request(app(router, '/api/results')).get('/api/results/m-1');
    expect(res.status).toBe(200);
  });
});

describe('results chat', () => {
  const chat = require('../src/services/ai/chat');

  test('a failed response read rejects before the model is called or quota is used', async () => {
    mockState.responsesErr = { message: 'page 3 of 25 failed' };
    await expect(chat.sendMessage({ userId: 'user-1', scope: 'results', missionId: 'm-1', userMessage: 'What was the top answer?' }))
      .rejects.toMatchObject({ status: 503, code: 'RESULTS_READ_FAILED' });
    expect(require('../src/services/ai/anthropic').callClaude).not.toHaveBeenCalled();
    expect(mockState.writes.filter(([t, op]) => t === 'chat_sessions' && op === 'update')).toEqual([]);
  });

  test('the stream route sends an error event and no answer', async () => {
    mockState.responsesErr = { message: 'page 3 of 25 failed' };
    const res = await request(app(require('../src/routes/chat'), '/api/chat')).post('/api/chat/stream').send({ scope: 'results', missionId: 'm-1', message: 'What was the top answer?' });
    expect(res.text).toMatch(/"error":"Could not load this mission's results right now/);
    expect(res.text).not.toMatch(/"done":true/);
  });
});
