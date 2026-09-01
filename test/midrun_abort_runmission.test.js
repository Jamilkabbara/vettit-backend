/**
 * Pass 49 PR 2 — mid-run abort, end to end through runMission.
 *
 * midrun_abort.test.js proves the two mechanisms in isolation (the recruit
 * loop's kill switch, and simulateAllResponses' shouldAbort). This file
 * proves the legacy batch path actually WIRES them: the throttled claim
 * check fires from the existing every-25-personas onProgress hook, the
 * latch reaches shouldAbort, and runMission returns instead of pressing on
 * into synthesis and the terminal write.
 *
 * The load-bearing assertion is `synthesizeInsights` never being called.
 * That is the money: synthesis is the expensive tail (measured max
 * insight_synth latency 122.3s, the longest single LLM call of any type in
 * production), and running it for a mission somebody else already resolved
 * is pure burn.
 *
 * The second load-bearing assertion is that the abort is a RETURN, not a
 * throw — nothing writes 'failed' over the other writer's terminal state.
 *
 * MUTATION CHECK: recorded in the PR body.
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
  synthesizeInsights: jest.fn(async () => ({ executive_summary: 'should never run' })),
  aggregate: jest.fn(() => ({})),
}));
jest.mock('../src/services/ai/simMeta', () => ({ buildSimMeta: jest.fn(() => ({})) }));
jest.mock('../src/services/ai/targetingBrief', () => ({ generateTargetingBrief: jest.fn() }));
jest.mock('../src/services/ai/creativeAttention', () => ({ analyzeCreative: jest.fn() }));
jest.mock('../src/services/ai/recruitLoop', () => ({
  runRecruitmentLoop: jest.fn(),
  shouldUseRecruitLoop: jest.fn(() => false),   // force the legacy batch path
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
}));
jest.mock('../src/utils/logger', () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
}));

const supabase = require('../src/db/supabase');
const logger = require('../src/utils/logger');
const emailService = require('../src/services/email');
const { generatePersonas } = require('../src/services/ai/personas');
const { callClaude } = require('../src/services/ai/anthropic');
const { synthesizeInsights } = require('../src/services/ai/insights');
const { runMission } = require('../src/jobs/runMission');

const MISSION_ID = '99999999-8888-7777-6666-555555555555';
const PERSONA_COUNT = 60;   // > 25 so the throttled claim check fires

function makeDb(missionRow) {
  const rows = {
    missions: [{ ...missionRow }],
    mission_responses: [{ id: 'r1', mission_id: MISSION_ID }],
  };
  const inserts = { notifications: [], funnel_events: [], admin_alerts: [] };

  function chain(table) {
    const state = { op: 'select', patch: null, filters: [], returning: false, head: false, wantCount: false };
    const evaluate = () => {
      const matching = (rows[table] || []).filter((r) =>
        state.filters.every(([k, v]) => r[k] === v));
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
      insert: async (r) => {
        (inserts[table] || (inserts[table] = [])).push(...(Array.isArray(r) ? r : [r]));
        return { data: null, error: null };
      },
      upsert: async (r) => {
        (inserts[table] || (inserts[table] = [])).push(...(Array.isArray(r) ? r : [r]));
        return { data: null, error: null };
      },
      delete: () => api,
      eq: (k, v) => { state.filters.push([k, v]); return api; },
      lt: () => api, limit: () => api, order: () => api, range: () => api,
      single: async () => {
        const { data } = evaluate();
        return data && data.length === 1
          ? { data: data[0], error: null }
          : { data: null, error: { code: 'PGRST116', message: 'no rows' } };
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

const baseMission = (over = {}) => ({
  id: MISSION_ID,
  user_id: 'user-1',
  title: 'batch kill switch',
  status: 'processing',
  goal_type: 'research',
  respondent_count: PERSONA_COUNT,
  questions: [{ id: 'q1', text: 'Why?', type: 'open_ended' }],
  started_at: new Date().toISOString(),
  completed_at: null,
  failure_reason: null,
  executive_summary: null,
  ...over,
});

/**
 * Every simulated persona answers. `flipAt` (a call index) is when the
 * other writer resolves the mission out from under this run.
 */
function wireSimulation(db, flipAt) {
  generatePersonas.mockResolvedValue(
    Array.from({ length: PERSONA_COUNT }, (_, i) => ({ id: `p${i}` })));

  let calls = 0;
  callClaude.mockImplementation(async () => {
    calls += 1;
    if (flipAt != null && calls === flipAt) {
      Object.assign(db.mission(), {
        status: 'failed',
        failure_reason: "Mission stuck in 'processing' for >6h — auto-failed by recovery cron",
        completed_at: '2026-09-01T00:00:00.000Z',
      });
    }
    // A real tick, so the fire-and-forget claim read has room to land
    // before the next concurrency-wave boundary is evaluated.
    await new Promise((r) => setTimeout(r, 0));
    return {
      text: JSON.stringify({ responses: [{ question_id: 'q1', answer: 'a', reasoning: null }] }),
      costUsd: 0, inputTokens: 0, outputTokens: 0, latencyMs: 1, model: 'test',
    };
  });
}

beforeEach(() => { jest.clearAllMocks(); });

describe('runMission batch path — mid-run claim revocation', () => {
  test('aborts, returns cleanly, and never reaches synthesis', async () => {
    const db = makeDb(baseMission());
    wireSimulation(db, 10);   // reaper wins after 10 personas

    const res = await runMission(MISSION_ID, { resume: true });

    expect(res).toMatchObject({ aborted: true });
    expect(synthesizeInsights).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining('ABORTING simulation'),
      expect.objectContaining({ missionId: MISSION_ID, observedStatus: 'failed' }),
    );
  });

  test('stops paying: far fewer model calls than the full persona set', async () => {
    const db = makeDb(baseMission());
    wireSimulation(db, 10);

    await runMission(MISSION_ID, { resume: true });

    // 60 personas would mean >= 60 response_sim calls. The abort lands at
    // the first wave boundary after the every-25 check, so it must come in
    // well under that — this is the spend the kill switch saves.
    expect(callClaude.mock.calls.length).toBeLessThan(PERSONA_COUNT);
    expect(callClaude.mock.calls.length).toBeGreaterThan(0);
  });

  test('the newer terminal state is left exactly as the other writer set it', async () => {
    const db = makeDb(baseMission());
    wireSimulation(db, 10);

    await runMission(MISSION_ID, { resume: true });

    expect(db.mission().status).toBe('failed');
    expect(db.mission().failure_reason).toContain('auto-failed by recovery cron');
    expect(db.mission().completed_at).toBe('2026-09-01T00:00:00.000Z');
    expect(db.mission().executive_summary).toBeNull();
  });

  test('no customer notification and no email of either kind', async () => {
    const db = makeDb(baseMission());
    wireSimulation(db, 10);

    await runMission(MISSION_ID, { resume: true });

    expect(db.inserts.notifications).toHaveLength(0);
    expect(emailService.sendMissionCompletedEmail).not.toHaveBeenCalled();
    expect(emailService.sendMissionFailedEmail).not.toHaveBeenCalled();
  });

  test('a healthy run is untouched: it simulates every persona and completes', async () => {
    const db = makeDb(baseMission());
    wireSimulation(db, null);   // nobody steals the claim

    const res = await runMission(MISSION_ID, { resume: true });

    expect(res && res.aborted).toBeFalsy();
    expect(synthesizeInsights).toHaveBeenCalledTimes(1);
    expect(db.mission().status).toBe('completed');
    expect(callClaude.mock.calls.length).toBeGreaterThanOrEqual(PERSONA_COUNT);
  });
});
