/**
 * creative_attention: the terminal write and the heartbeat.
 *
 * TWO DEFECTS, ONE FUNCTION (src/services/ai/creativeAttention.js
 * analyzeCreative).
 *
 * 1. UNSCOPED TERMINAL WRITE.
 *    analyzeCreative finished with a raw
 *      supabase.from('missions').update({ status: 'completed', ... }).eq('id', ...)
 *    filtered on the mission id ALONE. Pass 49 scoped every other terminal
 *    write in the codebase to `status: 'processing'` (see
 *    src/jobs/runMission.js and test/terminal_write_scoping.test.js) precisely
 *    so a stale or superseded worker cannot stamp a terminal state over a
 *    mission that has moved on. creative_attention bypassed that protection
 *    entirely: it never went through updateMission, so it had no scope, no
 *    matched-row count, and no way to notice it had lost the race. A run the
 *    Job 1 reaper had already auto-failed - or that an admin had
 *    force-completed - would write 'completed' straight back over that
 *    verdict and email the customer about it.
 *
 * 2. NO HEARTBEAT ACROSS THE VISION LOOP.
 *    The loop runs up to maxFrames (30) SERIAL Claude vision calls plus a
 *    synthesis call and stamped nothing. The last heartbeat a creative run
 *    got was the single one runMission writes right after the claim, so the
 *    row went silent for the whole analysis. missionRecovery Job 1 auto-fails
 *    a 'processing' mission whose heartbeat is older than
 *    JOB1_HEARTBEAT_STALE_MIN (45 min) - so a legitimate long creative run
 *    was reaped mid-flight and the customer's PAID mission was marked failed
 *    while it was still working.
 *
 * MUTATION CHECK: recorded in the PR body. Every assertion below fails when
 * the corresponding guard is reverted.
 */

// ── Module mocks ────────────────────────────────────────────────────────────

jest.mock('../src/db/supabase', () => ({
  from: jest.fn(),
  storage: { from: jest.fn() },
  auth: { admin: { getUserById: jest.fn() } },
}));
jest.mock('../src/utils/logger', () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
}));
jest.mock('../src/services/ai/insights', () => ({
  sanitizeAIOutputDeep: (x) => x,
  synthesizeInsights: jest.fn(),
  aggregate: jest.fn(() => ({})),
}));
jest.mock('../src/services/ai/anthropic', () => ({
  callClaude: jest.fn(),
  extractJSON: (t) => JSON.parse(t),
}));

// The vision client is constructed at module load, so the SDK itself is the
// seam. Each messages.create advances the virtual clock by mockPerCallMs,
// which is what turns "30 serial vision calls" into a measurable silence.
let mockPerCallMs = 0;
jest.mock('@anthropic-ai/sdk', () => {
  return jest.fn().mockImplementation(() => ({
    messages: {
      create: jest.fn(async () => {
        if (mockPerCallMs) jest.setSystemTime(Date.now() + mockPerCallMs);
        return {
          usage: { input_tokens: 10, output_tokens: 10 },
          content: [{ text: JSON.stringify({
            timestamp: 0,
            emotions: { joy: 40 },
            attention_hotspots: ['logo'],
            message_clarity: 70,
            audience_resonance: 65,
            engagement_score: 68,
            brief_description: 'A frame.',
          }) }],
        };
      }),
    },
  }));
});

// ffmpeg stands in for the real binary: it writes FRAME_COUNT jpegs into the
// temp dir analyzeCreative created and fires 'end', which is the whole
// contract extractVideoFrames depends on.
let FRAME_COUNT = 5;
jest.mock('@ffmpeg-installer/ffmpeg', () => ({ path: '/nonexistent/ffmpeg' }));
jest.mock('fluent-ffmpeg', () => {
  const fs = require('fs');
  const path = require('path');
  const factory = jest.fn(() => {
    const handlers = {};
    let outputPattern = null;
    const api = {
      outputOptions: () => api,
      output: (p) => { outputPattern = p; return api; },
      on: (evt, cb) => { handlers[evt] = cb; return api; },
      run: () => {
        const dir = path.dirname(outputPattern);
        for (let i = 1; i <= factory.__frameCount; i += 1) {
          fs.writeFileSync(
            path.join(dir, `frame-${String(i).padStart(4, '0')}.jpg`),
            Buffer.from([0xff, 0xd8, 0xff, 0xe0]),
          );
        }
        handlers.end();
      },
    };
    return api;
  });
  factory.setFfmpegPath = () => {};
  factory.__frameCount = 5;
  return factory;
});

// runMission's own dependencies — only needed by section C.
jest.mock('../src/services/ai/personas', () => ({ generatePersonas: jest.fn() }));
jest.mock('../src/services/ai/simulate', () => ({
  simulateAllResponses: jest.fn(), simulateResponses: jest.fn(), passesScreening: () => true,
}));
jest.mock('../src/services/ai/simMeta', () => ({ buildSimMeta: jest.fn(() => ({})) }));
jest.mock('../src/services/ai/targetingBrief', () => ({ generateTargetingBrief: jest.fn() }));
jest.mock('../src/services/ai/recruitLoop', () => ({
  runRecruitmentLoop: jest.fn(), shouldUseRecruitLoop: jest.fn(() => false),
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

const supabase = require('../src/db/supabase');
const logger = require('../src/utils/logger');
const ffmpegFactory = require('fluent-ffmpeg');
const { callClaude } = require('../src/services/ai/anthropic');
const { analyzeCreative } = require('../src/services/ai/creativeAttention');
const { runMission } = require('../src/jobs/runMission');
const { JOB1_HEARTBEAT_STALE_MIN } = require('../src/jobs/missionRecovery');

const MISSION_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const T0 = Date.parse('2026-09-06T00:00:00.000Z');

// ───────────────────────────────────────────────────────────────────────────
// In-memory Postgres-ish fake. The missions row is REAL STATE: a write whose
// accumulated .eq() filters do not all match leaves the row untouched and
// returns zero rows, exactly like Postgres. That is what makes "did not
// clobber" an assertion about data rather than about which mock was called.
// ───────────────────────────────────────────────────────────────────────────
function makeDb(missionRow) {
  const rows = { missions: [{ ...missionRow }] };
  const inserts = { admin_alerts: [], notifications: [], ai_calls: [], funnel_events: [] };
  const missionUpdates = [];   // every patch ATTEMPTED against missions
  const hooks = { onMissionUpdate: null };

  function chain(table) {
    const state = { op: 'select', patch: null, filters: [], returning: false };

    const evaluate = () => {
      const matching = (rows[table] || []).filter((r) =>
        state.filters.every(([k, v]) => r[k] === v));
      if (state.op === 'update') matching.forEach((r) => Object.assign(r, state.patch));
      const data = (state.returning || state.op !== 'update') ? matching : null;
      return { data, error: null };
    };

    const api = {
      select: () => { if (state.op === 'update') state.returning = true; return api; },
      update: (patch) => {
        state.op = 'update'; state.patch = patch;
        if (table === 'missions') {
          missionUpdates.push(patch);
          if (hooks.onMissionUpdate) hooks.onMissionUpdate(patch);
        }
        return api;
      },
      insert: async (r) => {
        (inserts[table] || (inserts[table] = [])).push(...(Array.isArray(r) ? r : [r]));
        return { data: null, error: null };
      },
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
  supabase.storage.from.mockImplementation(() => ({
    download: async () => ({
      data: { arrayBuffer: async () => Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0]).buffer },
      error: null,
    }),
  }));
  supabase.auth.admin.getUserById.mockResolvedValue({
    data: { user: { email: 'buyer@example.com', user_metadata: { name: 'Buyer' } } },
  });

  return {
    rows, inserts, missionUpdates, hooks,
    mission: () => rows.missions[0],
    /** ISO timestamps of every heartbeat write ATTEMPTED, in order. */
    heartbeatAttempts: () => missionUpdates.filter((p) => 'heartbeat_at' in p).map((p) => p.heartbeat_at),
  };
}

const creativeMission = (over = {}) => ({
  id: MISSION_ID,
  user_id: 'user-1',
  title: 'Creative attention run',
  status: 'processing',
  goal_type: 'creative_attention',
  brand_name: 'Acme',
  brief_attachment: { path: 'user-1/creatives/ad.mp4', mimeType: 'video/mp4' },
  creative_analysis: null,
  heartbeat_at: new Date(T0).toISOString(),
  started_at: new Date(T0).toISOString(),
  completed_at: null,
  failure_reason: null,
  ...over,
});

function wireSynthesis() {
  callClaude.mockImplementation(async () => {
    if (mockPerCallMs) jest.setSystemTime(Date.now() + mockPerCallMs);
    return { text: JSON.stringify({ overall_read: 'Strong.', recommendations: ['Ship it.'] }) };
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  // Fake the CLOCK ONLY. setTimeout must stay real: analyzeCreative awaits a
  // 200ms rate-limit delay per frame on runs longer than 5 frames, and a
  // faked-but-unadvanced timer would deadlock the loop.
  jest.useFakeTimers({
    doNotFake: [
      'hrtime', 'nextTick', 'performance', 'queueMicrotask',
      'requestAnimationFrame', 'cancelAnimationFrame',
      'requestIdleCallback', 'cancelIdleCallback',
      'setImmediate', 'clearImmediate',
      'setInterval', 'clearInterval', 'setTimeout', 'clearTimeout',
    ],
  });
  jest.setSystemTime(T0);
  mockPerCallMs = 0;
  FRAME_COUNT = 5;
  ffmpegFactory.__frameCount = FRAME_COUNT;
  wireSynthesis();
});

afterEach(async () => {
  // runMission is fired from setImmediate by its production callers; drain
  // anything still pending so one test's callbacks cannot land in the next.
  await new Promise((r) => setImmediate(r));
  jest.useRealTimers();
});

// ═══ A. The terminal write is status-scoped ════════════════════════════════

describe("creative_attention's 'completed' write", () => {
  test('happy path: a run that still owns the mission completes it and persists the analysis', async () => {
    const db = makeDb(creativeMission());

    const res = await analyzeCreative({ mission: creativeMission() });

    expect(db.mission().status).toBe('completed');
    expect(db.mission().completed_at).toBeTruthy();
    expect(db.mission().creative_analysis).toBeTruthy();
    expect(db.mission().creative_analysis.schema_version).toBe('v2');
    expect(db.mission().creative_analysis.frame_analyses).toHaveLength(FRAME_COUNT);
    expect(res.terminalWriteLost).toBe(false);
  });

  test('STALE WRITER: a run that finishes after the reaper failed the mission does not clobber it', async () => {
    const db = makeDb(creativeMission());
    // The Job 1 reaper fires while this run is still analysing frames.
    let flipped = false;
    db.hooks.onMissionUpdate = () => {
      if (flipped) return;
      flipped = true;
      Object.assign(db.mission(), {
        status: 'failed',
        failure_reason: 'Mission has not checked in for 61 min — auto-failed by recovery cron',
        completed_at: '2026-09-05T00:00:00.000Z',
      });
    };

    const res = await analyzeCreative({ mission: creativeMission() });

    // 1. The newer terminal state survived, untouched.
    expect(db.mission().status).toBe('failed');
    expect(db.mission().failure_reason).toContain('auto-failed by recovery cron');
    expect(db.mission().completed_at).toBe('2026-09-05T00:00:00.000Z');
    // 2. And the stale run's payload never landed.
    expect(db.mission().creative_analysis).toBeNull();
    // 3. The caller is told, so it can suppress the customer-facing effects.
    expect(res.terminalWriteLost).toBe(true);
  });

  test('STALE WRITER: logs loudly and raises an ops alert instead of dropping the result silently', async () => {
    const db = makeDb(creativeMission({ status: 'completed' }));

    await analyzeCreative({ mission: creativeMission() });

    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining('TERMINAL WRITE LOST'),
      expect.objectContaining({ missionId: MISSION_ID }),
    );
    const alerts = db.inserts.admin_alerts.filter((a) => a.alert_type === 'mission_terminal_write_lost');
    expect(alerts).toHaveLength(1);
    expect(alerts[0].payload.stage).toBe('creative_attention');
  });

  test('the analysis payload survives sanitizeMissionPatch — creative_analysis is an ALLOWED column', async () => {
    // Routing the write through updateMission made this load-bearing:
    // sanitizeMissionPatch silently DROPS any key outside ALLOWED_COLUMNS,
    // and creative_analysis was never listed. Without it the mission would
    // complete with a NULL report and nothing would say why.
    const db = makeDb(creativeMission());

    await analyzeCreative({ mission: creativeMission() });

    expect(db.mission().creative_analysis).not.toBeNull();
    expect(logger.warn).not.toHaveBeenCalledWith(
      expect.stringContaining('dropped unknown columns'),
      expect.anything(),
    );
  });
});

// ═══ B. The heartbeat across the vision loop ═══════════════════════════════

describe('creative_attention heartbeat', () => {
  test('stamps once per vision call, so the reaper never sees a 45-minute silence', async () => {
    // 5 frames at 12 virtual minutes each = a 60+ minute run. Job 1's
    // threshold is 45. This exact shape used to be auto-failed mid-flight.
    mockPerCallMs = 12 * 60 * 1000;
    const db = makeDb(creativeMission());

    await analyzeCreative({ mission: creativeMission() });

    const marks = [T0, ...db.heartbeatAttempts().map((t) => Date.parse(t)), Date.now()];
    const maxSilenceMin = Math.max(
      ...marks.slice(1).map((t, i) => (t - marks[i]) / 60000),
    );

    // The run really was long enough to be reaped without the fix.
    expect((Date.now() - T0) / 60000).toBeGreaterThan(JOB1_HEARTBEAT_STALE_MIN);
    // But it never went quiet for long enough.
    expect(maxSilenceMin).toBeLessThan(JOB1_HEARTBEAT_STALE_MIN);
  });

  test('the stamp is INSIDE the loop — one per frame, not one for the whole run', async () => {
    FRAME_COUNT = 30;                       // the real maxFrames worst case
    ffmpegFactory.__frameCount = FRAME_COUNT;
    const db = makeDb(creativeMission());

    await analyzeCreative({ mission: creativeMission() });

    // 30 frames + the pre-synthesis stamp.
    expect(db.heartbeatAttempts()).toHaveLength(FRAME_COUNT + 1);
  }, 60000);

  test('the stamp is status-scoped — a run that lost the mission stops keeping the row alive', async () => {
    const db = makeDb(creativeMission());
    const beat0 = db.mission().heartbeat_at;
    // The mission is resolved by someone else before the first frame lands.
    Object.assign(db.mission(), { status: 'failed' });
    mockPerCallMs = 60 * 1000;

    await analyzeCreative({ mission: creativeMission() });

    // Stamps were attempted...
    expect(db.heartbeatAttempts().length).toBeGreaterThan(0);
    // ...and every one of them matched zero rows, so a zombie cannot make a
    // resolved mission look live.
    expect(db.mission().heartbeat_at).toBe(beat0);
  });
});

// ═══ C. runMission's creative bypass honours the lost write ════════════════

describe('runMission creative_attention bypass', () => {
  test('happy path: completes and notifies the customer', async () => {
    const db = makeDb(creativeMission({ status: 'paid' }));

    await runMission(MISSION_ID);

    expect(db.mission().status).toBe('completed');
    expect(db.inserts.notifications.map((n) => n.type)).toContain('mission_complete');
  });

  test('STALE WRITER: the customer notification is SUPPRESSED', async () => {
    const db = makeDb(creativeMission({ status: 'processing' }));
    let flipped = false;
    db.hooks.onMissionUpdate = (patch) => {
      if (flipped || !('heartbeat_at' in patch)) return;
      flipped = true;
      Object.assign(db.mission(), { status: 'completed', creative_analysis: { theOther: 'run won' } });
    };

    await runMission(MISSION_ID, { resume: true });

    expect(db.inserts.notifications.map((n) => n.type)).not.toContain('mission_complete');
    // And the other writer's payload is intact.
    expect(db.mission().creative_analysis).toEqual({ theOther: 'run won' });
  });
});
