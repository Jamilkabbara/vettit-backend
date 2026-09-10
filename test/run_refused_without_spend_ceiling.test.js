/**
 * A mission with no spend ceiling must not run.
 *
 * `ai_spend_ceiling_usd` is the only cost governor the pipeline has, and a
 * falsy value does not mean "unlimited" by design - it means the column was
 * never written. Worse, it silently changes which branch executes:
 * shouldUseRecruitLoop() requires a truthy ceiling, so without one the run
 * falls to the legacy BATCH branch, which generates exactly
 * mission.respondent_count personas and never checks spend at all.
 *
 * A 100%-off PERCENTAGE promo produces exactly this: total $0, so
 * ceiling = total x 0.30 = 0, which is falsy. free-type promos divert to
 * /free-launch before that write, which is why the live free code never
 * triggered it.
 *
 * NO CARVE-OUT FOR FREE MISSIONS. A free mission still spends real money on
 * compute and already carries a ceiling: both create routes derive one from
 * the LIST price before any promo exists. An "unless it is free" exception
 * would protect nothing real and would reopen the path above.
 */
jest.mock('../src/db/supabase', () => ({ from: jest.fn(), auth: { admin: { getUserById: jest.fn() } } }));
jest.mock('../src/services/ai/personas', () => ({ generatePersonas: jest.fn() }));
jest.mock('../src/services/ai/simulate', () => ({
  simulateAllResponses: jest.fn(), simulateResponses: jest.fn(), passesScreening: () => true,
}));
jest.mock('../src/services/ai/insights', () => ({ synthesizeInsights: jest.fn(), aggregate: jest.fn(() => ({})) }));
jest.mock('../src/services/ai/simMeta', () => ({ buildSimMeta: jest.fn(() => ({})) }));
jest.mock('../src/services/ai/targetingBrief', () => ({ generateTargetingBrief: jest.fn() }));
jest.mock('../src/services/ai/creativeAttention', () => ({ analyzeCreative: jest.fn() }));
jest.mock('../src/services/ai/recruitLoop', () => ({
  runRecruitmentLoop: jest.fn(), shouldUseRecruitLoop: jest.fn(() => false),
}));
jest.mock('../src/services/ai/persistResponses', () => ({
  persistResponseRows: jest.fn(async () => ({ error: null, inserted: 0 })),
  persistReasoningRows: jest.fn(async () => ({ error: null })),
}));
jest.mock('../src/services/ai/ensureQuestions', () => ({ ensureMissionQuestions: jest.fn(async (m) => m.questions || []) }));
jest.mock('../src/services/analysis', () => ({ computeAnalysis: jest.fn(() => null) }));
jest.mock('../src/services/email', () => ({ sendMissionCompletedEmail: jest.fn(async () => {}), sendMissionFailedEmail: jest.fn(async () => {}) }));
jest.mock('../src/utils/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../src/db/missionSchema', () => ({
  updateMission: jest.fn(async () => ({})),
  sanitizeMissionPatch: (p) => ({ patch: p, rejected: [] }),
  stampMissionHeartbeat: jest.fn(async () => ({})),
}));

const supabase = require('../src/db/supabase');
const logger = require('../src/utils/logger');
const { generatePersonas } = require('../src/services/ai/personas');
const { runMission } = require('../src/jobs/runMission');

const MISSION_ID = 'm-ceiling-test';
let missionRow;
let alerts;
let claimAttempts;

/** Minimal supabase double: mission SELECT, admin_alerts INSERT, claim UPDATE. */
function wire() {
  alerts = [];
  claimAttempts = 0;
  supabase.from.mockImplementation((table) => {
    if (table === 'admin_alerts') {
      return { insert: async (row) => { alerts.push(row); return { error: null }; } };
    }
    if (table === 'missions') {
      return {
        select: () => ({ eq: () => ({ single: async () => ({ data: missionRow, error: null }) }) }),
        update: () => ({
          eq: () => ({
            eq: () => ({ select: async () => { claimAttempts += 1; return { data: [{ id: MISSION_ID }], error: null }; } }),
            select: async () => { claimAttempts += 1; return { data: [{ id: MISSION_ID }], error: null }; },
          }),
        }),
      };
    }
    return { select: () => ({ eq: () => ({ single: async () => ({ data: null, error: null }) }) }) };
  });
}

const base = {
  id: MISSION_ID, user_id: 'user-1', title: 'ceiling gate', status: 'paid',
  goal_type: 'research', respondent_count: 1250,
  questions: [{ id: 'q1', text: 'Why?', type: 'open_ended' }],
  started_at: null, completed_at: null, failure_reason: null,
};

beforeEach(() => { jest.clearAllMocks(); wire(); });

describe.each([
  ['null',      null],
  ['zero',      0],
  ['undefined', undefined],
  ['a string that is not a number', 'free'],
])('a ceiling of %s refuses the run', (_label, ceiling) => {
  test('returns skipped, never claims, never generates a persona', async () => {
    missionRow = { ...base, ai_spend_ceiling_usd: ceiling };
    const out = await runMission(MISSION_ID);
    expect(out).toEqual({ skipped: true, reason: 'no_spend_ceiling' });
    expect(generatePersonas).not.toHaveBeenCalled();
    expect(claimAttempts).toBe(0);
  });

  test('refuses loudly: an error log and an admin alert, not a silent skip', async () => {
    missionRow = { ...base, ai_spend_ceiling_usd: ceiling };
    await runMission(MISSION_ID);
    expect(logger.error).toHaveBeenCalled();
    expect(alerts).toHaveLength(1);
    expect(alerts[0].alert_type).toBe('mission_missing_spend_ceiling');
    expect(alerts[0].mission_id).toBe(MISSION_ID);
    expect(alerts[0].resolved).toBe(false);
    expect(alerts[0].payload.action_required).toMatch(/ceiling/i);
  });
});

test('the gate also covers a RESUME, which bypasses the paid claim by design', async () => {
  missionRow = { ...base, status: 'processing', ai_spend_ceiling_usd: 0, started_at: new Date().toISOString() };
  const out = await runMission(MISSION_ID, { resume: true });
  expect(out).toEqual({ skipped: true, reason: 'no_spend_ceiling' });
  expect(generatePersonas).not.toHaveBeenCalled();
});

test('a free-promo mission is NOT exempt — it is refused the same way', async () => {
  missionRow = { ...base, ai_spend_ceiling_usd: 0, promo_code: 'FREEBIE' };
  const out = await runMission(MISSION_ID);
  expect(out).toEqual({ skipped: true, reason: 'no_spend_ceiling' });
  expect(alerts[0].payload.promo_code).toBe('FREEBIE');
});

describe('CONTROL — a normal mission is untouched', () => {
  // These assert ONLY that the gate let the run through. What happens further
  // down the pipeline is other suites' business and is not fully doubled here,
  // so the run is allowed to fail later; the gate's own signals are what is
  // being measured.
  const pastTheGate = async () => {
    try { return await runMission(MISSION_ID); } catch { return 'threw later'; }
  };

  test('a positive ceiling passes the gate and proceeds to claim the mission', async () => {
    missionRow = { ...base, ai_spend_ceiling_usd: 2.7 };
    const out = await pastTheGate();
    expect(out).not.toEqual({ skipped: true, reason: 'no_spend_ceiling' });
    expect(claimAttempts).toBeGreaterThan(0);
    expect(alerts.filter((a) => a.alert_type === 'mission_missing_spend_ceiling')).toHaveLength(0);
  });

  test('a small positive ceiling is still a ceiling', async () => {
    missionRow = { ...base, ai_spend_ceiling_usd: 0.0001 };
    const out = await pastTheGate();
    expect(out).not.toEqual({ skipped: true, reason: 'no_spend_ceiling' });
    expect(alerts.filter((a) => a.alert_type === 'mission_missing_spend_ceiling')).toHaveLength(0);
  });
});
