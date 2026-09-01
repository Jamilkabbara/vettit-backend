/**
 * Pass 49 PR 3 — who writes the heartbeat, and what it costs.
 *
 * mission_heartbeat.test.js covers the reapers reading the column. This
 * file covers the other half: the writers.
 *
 * The 15-minute staleness threshold is only defensible because of the
 * cadence proved here. Production measurements (read-only, 2026-09-01):
 *   - loop-path gap between consecutive ai_calls, n=1432:
 *       p50 5.6s  p95 12.0s  p99 14.9s  MAX 21.8s
 *   - batch-path synthesis tail, the longest stretch with no per-persona
 *       hook: max 3.66 min
 * The loop heartbeat rides an update that was already going out once per
 * persona, so it is genuinely free. The batch heartbeat rides the existing
 * every-25-personas onProgress throttle: ~40 writes across a
 * 1000-respondent run, roughly 55s apart at the measured batch rate.
 *
 * MUTATION CHECK: recorded in the PR body.
 */

jest.mock('../src/services/ai/personas', () => ({ generatePersonas: jest.fn() }));
jest.mock('../src/services/ai/simulate', () => ({
  simulateResponses: jest.fn(),
  simulateAllResponses: jest.fn(),
  passesScreening: () => true,
}));
jest.mock('../src/utils/logger', () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
}));

const { generatePersonas } = require('../src/services/ai/personas');
const { simulateResponses } = require('../src/services/ai/simulate');
const logger = require('../src/utils/logger');
const { _resetHeartbeatColumnLatch, isHeartbeatColumnMissing } = require('../src/db/missionSchema');
const { runRecruitmentLoop } = require('../src/services/ai/recruitLoop');

const MISSION_ID = 'cccccccc-dddd-eeee-ffff-000000000000';

const mission = (over = {}) => ({
  id: MISSION_ID,
  user_id: 'user-1',
  title: 'heartbeat',
  goal_type: 'research',
  target_qualified_count: 4,
  ai_spend_ceiling_usd: 100,
  ai_spend_usd_actual: 0,
  questions: [{ id: 'q1', text: 'Why?', type: 'open_ended' }],
  ...over,
});

/**
 * Records every write against `missions` so a test can assert both what
 * was written and HOW MANY round trips it took.
 */
function makeSupabase({ heartbeatColumnError = null } = {}) {
  const missionUpdates = [];
  return {
    missionUpdates,
    from(table) {
      const st = { op: 'select', patch: null };
      const chain = {
        select: () => chain,
        eq: () => chain,
        order: () => chain,
        range: () => chain,
        update: (patch) => { st.op = 'update'; st.patch = patch; return chain; },
        single: async () => ({ data: { ai_spend_usd_actual: 0, status: 'processing' }, error: null }),
        insert: async () => ({ error: null }),
        upsert: async () => ({ error: null }),
        then: (resolve) => {
          if (st.op === 'update' && table === 'missions') {
            missionUpdates.push(st.patch);
            if (heartbeatColumnError && 'heartbeat_at' in st.patch) {
              return resolve({ data: null, error: heartbeatColumnError });
            }
            return resolve({ data: [{ id: MISSION_ID }], error: null });
          }
          return resolve({ data: table === 'mission_responses' ? [] : null, error: null });
        },
      };
      return chain;
    },
  };
}

function wireQualifyingPersonas() {
  let n = 0;
  generatePersonas.mockImplementation(async (_m, count) =>
    Array.from({ length: count }, () => ({ id: `p${++n}` })));
  simulateResponses.mockImplementation(async () => [{ question_id: 'q1', answer: 'yes', reasoning: null }]);
}

beforeEach(() => { jest.clearAllMocks(); _resetHeartbeatColumnLatch(); });

describe('recruit loop heartbeat', () => {
  test('every progress write carries a fresh heartbeat_at', async () => {
    const supabase = makeSupabase();
    wireQualifyingPersonas();
    const before = Date.now();

    await runRecruitmentLoop(mission(), supabase);

    // writeProgress patches only recruited_persona_count. The loop's init
    // and terminal writes also carry recruitment_status and go through
    // updateMission, not writeProgress — they are not heartbeats.
    const progressWrites = supabase.missionUpdates.filter(
      (p) => 'recruited_persona_count' in p && !('recruitment_status' in p));
    expect(progressWrites.length).toBeGreaterThanOrEqual(4);
    for (const p of progressWrites) {
      expect(typeof p.heartbeat_at).toBe('string');
      expect(new Date(p.heartbeat_at).getTime()).toBeGreaterThanOrEqual(before);
    }
  });

  test('it is FREE: the heartbeat rides the existing per-persona write', async () => {
    const supabase = makeSupabase();
    wireQualifyingPersonas();

    await runRecruitmentLoop(mission(), supabase);

    // Not one write that only touches heartbeat_at — every heartbeat is
    // carried by a patch that had other work to do anyway.
    const heartbeatOnly = supabase.missionUpdates.filter(
      (p) => Object.keys(p).length === 1 && 'heartbeat_at' in p);
    expect(heartbeatOnly).toHaveLength(0);
  });

  test('the cadence is per persona, so silence never approaches 15 minutes', async () => {
    const supabase = makeSupabase();
    wireQualifyingPersonas();

    const res = await runRecruitmentLoop(mission(), supabase);

    const beats = supabase.missionUpdates.filter((p) => 'heartbeat_at' in p);
    // One per recruited persona (plus the loop's terminal bookkeeping).
    expect(beats.length).toBeGreaterThanOrEqual(res.recruitedCount);
  });
});

describe('recruit loop heartbeat — migration not yet applied', () => {
  const missing = { code: '42703', message: 'column missions.heartbeat_at does not exist' };

  test('retries WITHOUT the column so recruited_persona_count still lands', async () => {
    const supabase = makeSupabase({ heartbeatColumnError: missing });
    wireQualifyingPersonas();

    await runRecruitmentLoop(mission(), supabase);

    // The first write that tried the heartbeat was rejected...
    const attemptIdx = supabase.missionUpdates.findIndex((p) => 'heartbeat_at' in p);
    expect(attemptIdx).toBeGreaterThan(-1);
    expect(supabase.missionUpdates[attemptIdx]).toHaveProperty('recruited_persona_count');
    // ...and was immediately retried without it, keeping the customer's
    // live progress counter working.
    const retry = supabase.missionUpdates[attemptIdx + 1];
    expect(retry).toHaveProperty('recruited_persona_count');
    expect(retry).not.toHaveProperty('heartbeat_at');
  });

  test('latches after the first failure — subsequent writes never re-try the column', async () => {
    const supabase = makeSupabase({ heartbeatColumnError: missing });
    wireQualifyingPersonas();

    await runRecruitmentLoop(mission(), supabase);

    expect(isHeartbeatColumnMissing()).toBe(true);
    const withHeartbeat = supabase.missionUpdates.filter((p) => 'heartbeat_at' in p);
    expect(withHeartbeat).toHaveLength(1);   // only the very first attempt
    expect(logger.error).toHaveBeenCalledTimes(1);
  });
});

describe('runMission heartbeat', () => {
  const src = require('fs').readFileSync(
    require.resolve('../src/jobs/runMission'), 'utf8');

  test('is stamped immediately after the claim, so a live run is never NULL', () => {
    // Ordering matters: the reapers treat a NULL heartbeat as "never
    // checked in" and fall back to started_at, so a live run must get its
    // first stamp down before it does any long work.
    const claimIdx = src.indexOf("reason: 'claim failed — another worker got it'");
    const stampIdx = src.indexOf('await stampHeartbeat();');
    const tryIdx   = src.indexOf('\n  try {', claimIdx);
    expect(claimIdx).toBeGreaterThan(-1);
    expect(stampIdx).toBeGreaterThan(claimIdx);
    expect(stampIdx).toBeLessThan(tryIdx);
  });

  test("is status-scoped — a zombie must not keep a resolved row looking alive", () => {
    const fn = src.slice(src.indexOf('const stampHeartbeat'), src.indexOf('await stampHeartbeat();'));
    expect(fn).toContain("heartbeat_at: new Date().toISOString()");
    expect(fn).toContain(".eq('status', 'processing')");
  });

  test('the batch path stamps it on the existing every-25 onProgress throttle', () => {
    const hook = src.slice(src.indexOf('(completed, total) => {'), src.indexOf('{ shouldAbort:'));
    expect(hook).toContain('completed % 25 === 0');
    expect(hook).toContain('stampHeartbeat();');
  });
});
