/**
 * A collapsed panel must never be delivered.
 *
 * Until 2026-09-19 nothing in the pipeline asked whether a study's
 * respondents were different people. 239 "Marcus" out of 240 were delivered
 * as a 240-person study (10ecb820), 300 of 300 in another (0a494ef7), and a
 * paying customer received five copies of "Marcus, 41, London" (bae6613a).
 * Every one of those reports read as normal.
 *
 * Generation now guards against it. This is the second line: the run measures
 * the panel it actually simulated and refuses to deliver a collapsed one,
 * exactly as it refuses to deliver over unsaved responses. The mission is
 * marked failed, ops are alerted for a re-run, and the customer is told.
 *
 * MUTATION CHECK: removing the delivery gate makes the first three tests
 * fail (the collapsed panel completes and reaches synthesis).
 */

jest.mock('../src/db/supabase', () => ({ from: jest.fn(), auth: { admin: { getUserById: jest.fn() } } }));
jest.mock('../src/services/ai/personas', () => ({ generatePersonas: jest.fn() }));
jest.mock('../src/services/ai/anthropic', () => ({
  callClaude: jest.fn(),
  streamClaude: jest.fn(),
  extractJSON: (t) => JSON.parse(String(t).replace(/^```(?:json)?|```$/g, '').trim()),
  MODEL_ROUTING: {},
  MODEL_PRICING: {},
}));
jest.mock('../src/services/ai/insights', () => ({
  synthesizeInsights: jest.fn(async () => ({ executive_summary: 'delivered' })),
  aggregate: jest.fn(() => ({})),
}));
jest.mock('../src/services/ai/simMeta', () => ({ buildSimMeta: jest.fn(() => ({})) }));
jest.mock('../src/services/ai/targetingBrief', () => ({ generateTargetingBrief: jest.fn() }));
jest.mock('../src/services/ai/creativeAttention', () => ({ analyzeCreative: jest.fn() }));
jest.mock('../src/services/ai/recruitLoop', () => ({
  runRecruitmentLoop: jest.fn(),
  shouldUseRecruitLoop: jest.fn(() => false),   // batch path; the gate is path-agnostic
}));
jest.mock('../src/services/ai/persistResponses', () => ({
  persistResponseRows: jest.fn(async () => ({ error: null, inserted: 0 })),
  persistReasoningRows: jest.fn(async () => ({ error: null })),
}));
jest.mock('../src/services/ai/ensureQuestions', () => ({
  ensureMissionQuestions: jest.fn(async (m) => m.questions || []),
}));
jest.mock('../src/services/analysis', () => ({ computeAnalysis: jest.fn(() => null) }));
jest.mock('../src/services/email', () => ({
  sendMissionCompletedEmail: jest.fn(async () => {}),
  sendMissionFailedEmail: jest.fn(async () => {}),
  MISSION_FAILURE_REMEDY: 'We will re-run it.',
}));
jest.mock('../src/utils/logger', () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
}));

const supabase = require('../src/db/supabase');
const emailService = require('../src/services/email');
const { generatePersonas } = require('../src/services/ai/personas');
const { callClaude } = require('../src/services/ai/anthropic');
const { synthesizeInsights } = require('../src/services/ai/insights');
const { runMission } = require('../src/jobs/runMission');

const MISSION_ID = '11111111-2222-3333-4444-555555555555';
const N = 20;

function makeDb(missionRow) {
  const rows = {
    missions: [{ ...missionRow }],
    mission_responses: [{ id: 'r1', mission_id: MISSION_ID }],
  };
  const inserts = { notifications: [], funnel_events: [], admin_alerts: [] };
  function chain(table) {
    const state = { op: 'select', patch: null, filters: [], returning: false, head: false, wantCount: false };
    const evaluate = () => {
      const matching = (rows[table] || []).filter((r) => state.filters.every(([k, v]) => r[k] === v));
      if (state.op === 'update') matching.forEach((r) => Object.assign(r, state.patch));
      const data = state.head ? null : ((state.returning || state.op !== 'update') ? matching : null);
      return { data, error: null, count: state.wantCount ? matching.length : null };
    };
    const api = {
      select: (_c, opts) => {
        if (state.op === 'update') state.returning = true;
        if (opts && opts.count) state.wantCount = true;
        if (opts && opts.head) state.head = true;
        return api;
      },
      update: (patch) => { state.op = 'update'; state.patch = patch; return api; },
      insert: async (r) => { (inserts[table] || (inserts[table] = [])).push(...[].concat(r)); return { data: null, error: null }; },
      upsert: async (r) => { (inserts[table] || (inserts[table] = [])).push(...[].concat(r)); return { data: null, error: null }; },
      delete: () => api,
      eq: (k, v) => { state.filters.push([k, v]); return api; },
      lt: () => api, limit: () => api, order: () => api, range: () => api,
      single: async () => {
        const { data } = evaluate();
        return data && data.length === 1 ? { data: data[0], error: null } : { data: null, error: { code: 'PGRST116', message: 'no rows' } };
      },
      maybeSingle: async () => { const { data } = evaluate(); return { data: data?.[0] ?? null, error: null }; },
      then: (resolve) => resolve(evaluate()),
    };
    return api;
  }
  supabase.from.mockImplementation((table) => chain(table));
  supabase.auth.admin.getUserById.mockResolvedValue({
    data: { user: { email: 'buyer@example.com', user_metadata: { name: 'Buyer' } } },
  });
  return { rows, inserts, mission: () => rows.missions[0] };
}

const mission = () => ({
  id: MISSION_ID,
  user_id: 'user-1',
  title: 'panel gate',
  status: 'processing',
  goal_type: 'research',
  respondent_count: N,
  ai_spend_ceiling_usd: 2.7,
  paid_amount_cents: 8900,
  questions: [{ id: 'q1', text: 'Would you buy it?', type: 'single', options: ['Yes', 'No'] }],
  started_at: new Date().toISOString(),
  completed_at: null,
  failure_reason: null,
  executive_summary: null,
});

const CITIES = ['Dubai', 'Abu Dhabi', 'Sharjah', 'Al Ain', 'Ajman'];
const JOBS = ['Teacher', 'Nurse', 'Accountant', 'Chef', 'Banker'];
const NAMES = ['Layla', 'Omar', 'Sara', 'Ahmed', 'Nour', 'Karim', 'Hana', 'Yusuf', 'Rania', 'Tariq',
  'Mona', 'Faisal', 'Dina', 'Ali', 'Reem', 'Hassan', 'Lina', 'Majid', 'Salma', 'Ziad'];

/** Everyone is the same person: what the loop actually delivered. */
const collapsedPanel = () => Array.from({ length: N }, (_, i) => ({
  id: `p${i}`, persona_id: `p${i}`, first_name: 'Marcus', age: 41, city: 'London', occupation: 'Marketing Manager',
}));

const healthyPanel = () => Array.from({ length: N }, (_, i) => ({
  id: `p${i}`, persona_id: `p${i}`, first_name: NAMES[i], age: 24 + i, city: CITIES[i % 5], occupation: JOBS[i % 5],
}));

function wire(personas) {
  generatePersonas.mockResolvedValue(personas);
  // Answers vary per persona, so differing answers cannot rescue a clone.
  let i = 0;
  callClaude.mockImplementation(async () => {
    i += 1;
    return {
      text: JSON.stringify({ responses: [{ question_id: 'q1', answer: i % 2 ? 'Yes' : 'No', reasoning: null }] }),
      costUsd: 0, inputTokens: 0, outputTokens: 0, latencyMs: 1, model: 'test',
    };
  });
}

beforeEach(() => { jest.clearAllMocks(); });

test('a collapsed panel fails the mission instead of delivering it', async () => {
  const db = makeDb(mission());
  wire(collapsedPanel());

  await runMission(MISSION_ID, { resume: true });

  expect(db.mission().status).toBe('failed');
  expect(db.mission().executive_summary).toBeNull();
});

test('the expensive synthesis never runs for a collapsed panel', async () => {
  makeDb(mission());
  wire(collapsedPanel());

  await runMission(MISSION_ID, { resume: true });

  expect(synthesizeInsights).not.toHaveBeenCalled();
});

test('the customer is told, in plain words, and ops get an alert', async () => {
  const db = makeDb(mission());
  wire(collapsedPanel());

  await runMission(MISSION_ID, { resume: true });

  expect(db.mission().failure_reason).toBe(
    'The respondents generated for this study were not different enough people, so we stopped before delivering it.',
  );
  expect(db.mission().failure_reason).not.toMatch(/[—–]/);        // hyphens only
  expect(db.mission().failure_reason).not.toMatch(/Marcus|near-duplicate|panel collapsed/);
  expect(emailService.sendMissionFailedEmail).toHaveBeenCalledTimes(1);
  expect(db.inserts.admin_alerts.length).toBeGreaterThan(0);
});

test('a healthy panel is delivered exactly as before', async () => {
  const db = makeDb(mission());
  wire(healthyPanel());

  await runMission(MISSION_ID, { resume: true });

  expect(db.mission().status).toBe('completed');
  expect(synthesizeInsights).toHaveBeenCalledTimes(1);
  expect(db.mission().failure_reason).toBeNull();
  expect(emailService.sendMissionFailedEmail).not.toHaveBeenCalled();
});
