/**
 * Pass 49 PR 1 — status-scoped terminal writes.
 *
 * THE BUG
 * -------
 * runMission's two terminal writes (`completed` at the end of the happy
 * path, `failed` in the fatal handler) and missionRecovery Job 1's
 * auto-fail write were all unconditional: they filtered on the mission id
 * alone. Only the atomic paid→processing claim at the top of runMission
 * was scoped to a status.
 *
 * The consequence on the 1000-respondent tier: JOB1_STUCK_AFTER_HOURS is
 * 6, and a healthy 1000-respondent recruit-loop run measures at ~3.4h at a
 * 100% screener pass rate and ~4.9h at 70% (weighted from live ai_calls
 * latency; the largest real run observed — 300 qualified respondents —
 * projects to 3.8h / 5.4h). So Job 1 reaps live runs, writing 'failed'
 * over a mission that is still executing — and the run then writes
 * 'completed' straight back over the reaper's verdict, emails the
 * customer, and increments spend, with neither writer aware of the other.
 * The pass-48 unique indexes stop the duplicate ROW inserts; they do
 * nothing about the status write, the insights / analysis /
 * aggregated_by_question payload (all built from in-memory arrays, never
 * re-read from the DB), or the customer email.
 *
 * WHAT THIS FILE PROVES
 * ---------------------
 *   A. updateMission's `scope` really appends .eq() filters, reports the
 *      matched row count, and does NOT route through .single() — which
 *      raises PGRST116 on the 0-row result that is precisely the signal
 *      we need to observe.
 *   B. A stale runMission that finishes after the row left 'processing'
 *      does NOT clobber the newer terminal state, and its customer
 *      notification + completion email are suppressed.
 *   C. Same for the fatal handler's 'failed' write.
 *   D. Job 1's reaper loses the same race instead of winning it, and does
 *      not raise a false "stuck mission" admin page.
 *
 * MUTATION CHECK: every assertion in sections B/C/D fails when the
 * `scope: { status: 'processing' }` option is removed from the write it
 * covers, and section A fails when `.select()` is swapped back to
 * `.select().single()`. Recorded output is in the PR body.
 */

jest.mock('../src/db/supabase', () => ({ from: jest.fn(), auth: { admin: { getUserById: jest.fn() } } }));
jest.mock('../src/services/ai/personas', () => ({ generatePersonas: jest.fn() }));
jest.mock('../src/services/ai/simulate', () => ({
  simulateAllResponses: jest.fn(),
  simulateResponses: jest.fn(),
  passesScreening: () => true,
}));
jest.mock('../src/services/ai/insights', () => ({
  synthesizeInsights: jest.fn(),
  aggregate: jest.fn(() => ({})),
}));
jest.mock('../src/services/ai/simMeta', () => ({ buildSimMeta: jest.fn(() => ({})) }));
jest.mock('../src/services/ai/targetingBrief', () => ({ generateTargetingBrief: jest.fn() }));
jest.mock('../src/services/ai/creativeAttention', () => ({ analyzeCreative: jest.fn() }));
jest.mock('../src/services/ai/recruitLoop', () => ({
  runRecruitmentLoop: jest.fn(),
  shouldUseRecruitLoop: jest.fn(() => false),
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
const { simulateAllResponses } = require('../src/services/ai/simulate');
const { synthesizeInsights } = require('../src/services/ai/insights');
const { updateMission } = require('../src/db/missionSchema');
const { runMission } = require('../src/jobs/runMission');
const { runJob1 } = require('../src/jobs/missionRecovery');

const MISSION_ID = '11111111-2222-3333-4444-555555555555';

// ───────────────────────────────────────────────────────────────────────────
// In-memory Postgres-ish fake.
//
// The point of this harness is that the missions row is REAL STATE: a
// write whose accumulated .eq() filters do not all match leaves the row
// untouched and returns zero rows, exactly like Postgres. That is what
// makes "did not clobber" an assertion about data rather than about which
// mock happened to be called.
// ───────────────────────────────────────────────────────────────────────────
function makeDb(missionRow) {
  // Two persisted response rows so runMission's "refuse to complete over an
  // empty responses table" guard (src/jobs/runMission.js) is satisfied — that
  // guard is orthogonal to what this file tests.
  const rows = {
    missions: [{ ...missionRow }],
    mission_responses: [
      { id: 'r1', mission_id: MISSION_ID }, { id: 'r2', mission_id: MISSION_ID },
    ],
  };
  const inserts = { notifications: [], funnel_events: [], admin_alerts: [], mission_responses: [] };
  const singleOnUpdate = [];   // every .single() reached on a write chain

  function chain(table) {
    const state = { op: 'select', patch: null, filters: [], returning: false, head: false, wantCount: false };

    const evaluate = () => {
      const matching = (rows[table] || []).filter((r) =>
        state.filters.every(([k, v]) => r[k] === v));
      if (state.op === 'update') matching.forEach((r) => Object.assign(r, state.patch));
      const data = state.head
        ? null
        : ((state.returning || state.op !== 'update') ? matching : null);
      return { data, error: null, count: state.wantCount ? matching.length : null };
    };

    const api = {
      select: (_cols, opts) => {
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
      lt: () => api,
      limit: () => api,
      order: () => api,
      range: () => api,
      single: async () => {
        if (state.op === 'update') singleOnUpdate.push({ table, filters: [...state.filters] });
        const { data } = evaluate();
        return data && data.length === 1
          ? { data: data[0], error: null }
          // PostgREST's real behaviour on a 0-row .single(): an error, not
          // an empty result. This is the trap a scoped write must avoid.
          : { data: null, error: { code: 'PGRST116', message: 'JSON object requested, multiple (or no) rows returned' } };
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

  return { rows, inserts, singleOnUpdate, mission: () => rows.missions[0] };
}

const baseMission = (over = {}) => ({
  id: MISSION_ID,
  user_id: 'user-1',
  title: 'Terminal write scoping',
  status: 'paid',
  goal_type: 'research',
  respondent_count: 2,
  questions: [{ id: 'q1', text: 'Why?', type: 'open_ended' }],
  started_at: null,
  completed_at: null,
  failure_reason: null,
  executive_summary: null,
  ...over,
});

/** Wire the happy batch path: 2 personas, 1 answer each, insights returned. */
function wireHappyPath() {
  generatePersonas.mockResolvedValue([{ id: 'p1' }, { id: 'p2' }]);
  // PR #109 changed simulateAllResponses from a bare array to a result object
  // so a partial delivery can never be silent. This fixture follows that
  // contract; returning the old array shape makes runMission throw and the
  // mission ends 'failed', which is what broke this suite on the merge.
  const simResponses = [
    { persona_id: 'p1', persona_profile: { id: 'p1' }, question_id: 'q1', answer: 'a', reasoning: null },
    { persona_id: 'p2', persona_profile: { id: 'p2' }, question_id: 'q1', answer: 'b', reasoning: null },
  ];
  simulateAllResponses.mockResolvedValue({
    responses: simResponses,
    attempted: 2,
    succeeded: 2,
    failed: 0,
    failureRatio: 0,
    failedPersonaIds: [],
    failures: [],
  });
  synthesizeInsights.mockResolvedValue({ executive_summary: 'fresh run summary' });
}

beforeEach(() => { jest.clearAllMocks(); });

// ═══ A. updateMission scope mechanics ══════════════════════════════════════

describe('updateMission({ scope })', () => {
  test('applies scope as extra .eq() filters and reports matched=1 when it wins', async () => {
    const db = makeDb(baseMission({ status: 'processing' }));

    const res = await updateMission(supabase, MISSION_ID, { status: 'completed' }, {
      caller: 'test', scope: { status: 'processing' },
    });

    expect(res.error).toBeNull();
    expect(res.matched).toBe(1);
    expect(db.mission().status).toBe('completed');
  });

  test('reports matched=0 and leaves the row UNTOUCHED when the scope does not match', async () => {
    const db = makeDb(baseMission({ status: 'failed', failure_reason: 'reaper said so' }));

    const res = await updateMission(supabase, MISSION_ID, {
      status: 'completed', executive_summary: 'stale writer summary',
    }, { caller: 'test', scope: { status: 'processing' } });

    expect(res.error).toBeNull();
    expect(res.matched).toBe(0);
    expect(db.mission().status).toBe('failed');
    expect(db.mission().failure_reason).toBe('reaper said so');
    expect(db.mission().executive_summary).toBeNull();
  });

  test('a scoped write never routes through .single() — PGRST116 would mask the 0-row signal', async () => {
    const db = makeDb(baseMission({ status: 'failed' }));

    const res = await updateMission(supabase, MISSION_ID, { status: 'completed' }, {
      caller: 'test', scope: { status: 'processing' },
    });

    expect(db.singleOnUpdate).toHaveLength(0);
    expect(res.error).toBeNull();   // not a PGRST116
    expect(res.matched).toBe(0);
  });

  test('an UNSCOPED write keeps its old shape (matched=null, no row-count request)', async () => {
    const db = makeDb(baseMission({ status: 'processing' }));

    const res = await updateMission(supabase, MISSION_ID, { title: 'renamed' }, { caller: 'test' });

    expect(res.matched).toBeNull();
    expect(db.mission().title).toBe('renamed');
  });

  test('logs at ERROR level — a lost scoped write is never silent', async () => {
    makeDb(baseMission({ status: 'completed' }));

    await updateMission(supabase, MISSION_ID, { status: 'failed' }, {
      caller: 'test', scope: { status: 'processing' },
    });

    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining('SCOPED WRITE MATCHED 0 ROWS'),
      expect.objectContaining({ missionId: MISSION_ID, caller: 'test' }),
    );
  });
});

// ═══ B. runMission completion write ════════════════════════════════════════

describe("runMission's 'completed' write", () => {
  test('happy path: claims the mission, completes it, notifies and emails the customer', async () => {
    const db = makeDb(baseMission({ status: 'paid' }));
    wireHappyPath();

    await runMission(MISSION_ID);

    expect(db.mission().status).toBe('completed');
    // runMission rewrites the summary with a small-n disclaimer at n=2, so
    // assert the payload landed rather than pinning the exact prose.
    expect(db.mission().executive_summary).toBeTruthy();
    expect(db.mission().completed_at).toBeTruthy();
    expect(db.inserts.notifications.map((n) => n.type)).toContain('mission_complete');
    expect(emailService.sendMissionCompletedEmail).toHaveBeenCalledTimes(1);
  });

  test('STALE WRITER: a run that finishes after the reaper failed the mission does not clobber it', async () => {
    const db = makeDb(baseMission({ status: 'processing', started_at: new Date().toISOString() }));
    wireHappyPath();
    synthesizeInsights.mockImplementation(async () => {
      // The reaper fires while this run is still synthesising.
      Object.assign(db.mission(), {
        status: 'failed',
        failure_reason: "Mission stuck in 'processing' for >6h — auto-failed by recovery cron",
        completed_at: '2026-09-01T00:00:00.000Z',
      });
      return { executive_summary: 'stale writer summary' };
    });

    await runMission(MISSION_ID, { resume: true });

    // 1. The newer terminal state survived, untouched.
    expect(db.mission().status).toBe('failed');
    expect(db.mission().failure_reason).toContain('auto-failed by recovery cron');
    expect(db.mission().completed_at).toBe('2026-09-01T00:00:00.000Z');
    // 2. And the stale run's payload never landed.
    expect(db.mission().executive_summary).toBeNull();
  });

  test('STALE WRITER: the customer notification and completion email are SUPPRESSED', async () => {
    const db = makeDb(baseMission({ status: 'processing', started_at: new Date().toISOString() }));
    wireHappyPath();
    synthesizeInsights.mockImplementation(async () => {
      Object.assign(db.mission(), { status: 'completed', executive_summary: 'the OTHER run won' });
      return { executive_summary: 'stale writer summary' };
    });

    await runMission(MISSION_ID, { resume: true });

    expect(db.inserts.notifications.map((n) => n.type)).not.toContain('mission_complete');
    expect(emailService.sendMissionCompletedEmail).not.toHaveBeenCalled();
  });

  test('STALE WRITER: logs loudly and raises an ops alert instead of failing silently', async () => {
    const db = makeDb(baseMission({ status: 'processing', started_at: new Date().toISOString() }));
    wireHappyPath();
    synthesizeInsights.mockImplementation(async () => {
      Object.assign(db.mission(), { status: 'failed', failure_reason: 'reaper' });
      return { executive_summary: 'stale writer summary' };
    });

    await runMission(MISSION_ID, { resume: true });

    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining('COMPLETION WRITE LOST'),
      expect.objectContaining({ missionId: MISSION_ID }),
    );
    expect(db.inserts.admin_alerts.map((a) => a.alert_type))
      .toContain('mission_terminal_write_lost');
  });
});

// ═══ C. runMission fatal write ═════════════════════════════════════════════

describe("runMission's fatal 'failed' write", () => {
  test('STALE WRITER: a throwing run does not stamp failed over a completed mission', async () => {
    const db = makeDb(baseMission({ status: 'processing', started_at: new Date().toISOString() }));
    generatePersonas.mockImplementation(async () => {
      // Another writer resolves the mission, then this run blows up.
      Object.assign(db.mission(), {
        status: 'completed',
        completed_at: '2026-09-01T00:00:00.000Z',
        executive_summary: 'the OTHER run won',
      });
      throw new Error('Anthropic 529 overloaded');
    });

    await runMission(MISSION_ID, { resume: true });

    expect(db.mission().status).toBe('completed');
    expect(db.mission().failure_reason).toBeNull();
    expect(db.mission().executive_summary).toBe('the OTHER run won');
  });

  test('STALE WRITER: the failure notification and failure email are SUPPRESSED', async () => {
    const db = makeDb(baseMission({ status: 'processing', started_at: new Date().toISOString() }));
    generatePersonas.mockImplementation(async () => {
      Object.assign(db.mission(), { status: 'completed' });
      throw new Error('Anthropic 529 overloaded');
    });

    await runMission(MISSION_ID, { resume: true });

    expect(db.inserts.notifications.map((n) => n.type)).not.toContain('mission_failed');
    expect(emailService.sendMissionFailedEmail).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining('FAILURE WRITE LOST'),
      expect.objectContaining({ missionId: MISSION_ID }),
    );
  });

  test('a genuine failure on a still-processing mission still fails it, notifies and emails', async () => {
    const db = makeDb(baseMission({ status: 'processing', started_at: new Date().toISOString() }));
    generatePersonas.mockRejectedValue(new Error('Anthropic 529 overloaded'));

    await runMission(MISSION_ID, { resume: true });

    expect(db.mission().status).toBe('failed');
    expect(db.mission().failure_reason).toContain('529');
    expect(db.inserts.notifications.map((n) => n.type)).toContain('mission_failed');
    expect(emailService.sendMissionFailedEmail).toHaveBeenCalledTimes(1);
  });
});

// ═══ D. missionRecovery Job 1 ══════════════════════════════════════════════

describe('missionRecovery Job 1 auto-fail', () => {
  // Job 1 needs cron_locks to behave; missions come from the same fake row
  // store so the reaper's write is subject to the real scope filter.
  function wireJob1(missionRow) {
    const db = makeDb(missionRow);
    const inner = supabase.from.getMockImplementation();
    supabase.from.mockImplementation((table) => {
      if (table === 'cron_locks') {
        const c = {
          insert: async () => ({ error: null }), upsert: async () => ({ error: null }),
          select: () => c, update: () => c, delete: () => c, eq: () => c, lt: () => c,
          single: async () => ({ data: null, error: null }),
          maybeSingle: async () => ({ data: null, error: null }),
          then: (r) => r({ data: [], error: null }),
        };
        return c;
      }
      return inner(table);
    });
    return db;
  }

  test('a genuinely stuck mission is still auto-failed and paged', async () => {
    const db = wireJob1(baseMission({
      status: 'processing', started_at: new Date(Date.now() - 7 * 3600 * 1000).toISOString(),
    }));

    await runJob1();

    expect(db.mission().status).toBe('failed');
    expect(db.mission().failure_reason).toContain('auto-failed by recovery cron');
    expect(db.inserts.admin_alerts.map((a) => a.alert_type))
      .toContain('mission_stuck_processing');
  });

  test('a mission that leaves processing between the read and the write is not clobbered or paged', async () => {
    const db = wireJob1(baseMission({
      status: 'processing', started_at: new Date(Date.now() - 7 * 3600 * 1000).toISOString(),
    }));

    // Simulate the run finishing inside Job 1's read→write window: the
    // read still returns the row, then the status flips before the
    // reaper's write lands.
    const withMissions = supabase.from.getMockImplementation();
    let handedOver = false;
    supabase.from.mockImplementation((table) => {
      const c = withMissions(table);
      if (table !== 'missions' || handedOver) return c;
      const origThen = c.then;
      c.then = (resolve) => origThen((res) => {
        resolve(res);
        if (!handedOver && res.data && res.data.length) {
          handedOver = true;
          Object.assign(db.mission(), { status: 'completed', completed_at: 'X' });
        }
      });
      return c;
    });

    await runJob1();

    expect(db.mission().status).toBe('completed');
    expect(db.mission().failure_reason).toBeNull();
    expect(db.inserts.admin_alerts.map((a) => a.alert_type))
      .not.toContain('mission_stuck_processing');
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining('job1 auto-fail SKIPPED'),
      expect.objectContaining({ missionId: MISSION_ID }),
    );
  });
});
