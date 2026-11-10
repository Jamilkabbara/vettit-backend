/**
 * Above the monthly hard limit, a NEW mission does not start. A mission
 * already in flight always finishes.
 *
 * The monthly ceiling ($50) only wakes a human. The hard limit (3x it) is the
 * second line: if nobody acted and spend kept climbing, stop taking on NEW
 * work. The distinction is the whole design, and it is a money decision:
 *
 *   - A customer whose study is mid-run has already been charged, half their
 *     data is written, and there is no re-run credit system. Killing that run
 *     turns an overspend into a refund and a support ticket. So resume is
 *     never refused, at any spend.
 *
 *   - A mission that has not started yet has nothing to lose by waiting. It
 *     keeps its paid status and its payment, raises an admin alert, and is
 *     re-triggered by hand once the limit is raised or the cause is fixed -
 *     the same remedy every other refused run uses. It is NOT marked failed,
 *     because a failed row is a customer-visible dead end and this mission is
 *     merely waiting.
 *
 * The gate sits in the money-gates block beside the per-mission ceiling and
 * the payment-covers-run check: after the terminal-status skip, before the
 * claim.
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
jest.mock('../src/services/email', () => ({
  sendMissionCompletedEmail: jest.fn(async () => {}),
  sendMissionFailedEmail: jest.fn(async () => {}),
  sendAdminAlertDigest: jest.fn(async () => ({ sent: true })),
}));
jest.mock('../src/utils/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../src/db/missionSchema', () => ({
  updateMission: jest.fn(async () => ({})),
  sanitizeMissionPatch: (p) => ({ patch: p, rejected: [] }),
  stampMissionHeartbeat: jest.fn(async () => ({})),
}));
// The payment-covers-run gate sits beside this one and would otherwise refuse
// the fixture first, which would make every assertion below prove nothing.
jest.mock('../src/services/payments/paymentCoversRun', () => ({
  checkPaymentCoversRun: jest.fn(async () => ({ ok: true })),
}));
// The monthly spend read is doubled rather than faked through supabase: this
// suite is about what runMission DOES with the answer, and the read itself is
// proved against a PostgREST-shaped double in monthly_spend_ceiling.test.js.
jest.mock('../src/services/ai/monthlySpendCeiling', () => ({
  spendAllowsNewWork: jest.fn(),
}));

const supabase = require('../src/db/supabase');
const logger = require('../src/utils/logger');
const { generatePersonas } = require('../src/services/ai/personas');
const { spendAllowsNewWork } = require('../src/services/ai/monthlySpendCeiling');
const { runMission } = require('../src/jobs/runMission');

const MISSION_ID = 'm-monthly-hard-limit';
let missionRow;
let alerts;
let claimAttempts;
let missionUpdates;

function wire() {
  alerts = [];
  claimAttempts = 0;
  missionUpdates = [];
  supabase.from.mockImplementation((table) => {
    if (table === 'admin_alerts') {
      return { insert: async (row) => { alerts.push(row); return { error: null }; } };
    }
    if (table === 'promo_codes') {
      return { select: () => ({ eq: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }) }) }) };
    }
    if (table === 'missions') {
      return {
        select: () => ({ eq: () => ({ single: async () => ({ data: missionRow, error: null }) }) }),
        update: (patch) => {
          missionUpdates.push(patch);
          return {
            eq: () => ({
              eq: () => ({ select: async () => { claimAttempts += 1; return { data: [{ id: MISSION_ID }], error: null }; } }),
              select: async () => { claimAttempts += 1; return { data: [{ id: MISSION_ID }], error: null }; },
            }),
          };
        },
      };
    }
    return { select: () => ({ eq: () => ({ single: async () => ({ data: null, error: null }) }) }) };
  });
}

const base = {
  id: MISSION_ID, user_id: 'user-1', title: 'monthly hard limit', status: 'paid',
  goal_type: 'research', respondent_count: 1250,
  questions: [{ id: 'q1', text: 'Why?', type: 'open_ended' }],
  started_at: null, completed_at: null, failure_reason: null,
  paid_amount_cents: 109900,
  ai_spend_ceiling_usd: 329.7,
};

const OVER_HARD_LIMIT = {
  allowed: false,
  reason: 'over_hard_limit',
  state: {
    month: '2026-11', spendUsd: 212.5, ceilingUsd: 50, hardLimitUsd: 150,
    calls: 14100, breached: true, hardBreached: true,
    topContributor: { call_type: 'response_sim', spendUsd: 198.2, calls: 13900 },
  },
};

beforeEach(() => {
  jest.clearAllMocks();
  wire();
  missionRow = { ...base };
  spendAllowsNewWork.mockResolvedValue({ allowed: true, reason: 'under_ceiling', state: { spendUsd: 5.94 } });
});

describe('a new mission above the hard limit does not start', () => {
  test('it is refused before the claim and before any persona is generated', async () => {
    spendAllowsNewWork.mockResolvedValue(OVER_HARD_LIMIT);
    const out = await runMission(MISSION_ID);
    expect(out).toEqual({ skipped: true, reason: 'monthly_spend_hard_limit' });
    expect(generatePersonas).not.toHaveBeenCalled();
    expect(claimAttempts).toBe(0);
  });

  test('it refuses loudly: an error log and an admin alert naming the month and the spend', async () => {
    spendAllowsNewWork.mockResolvedValue(OVER_HARD_LIMIT);
    await runMission(MISSION_ID);
    expect(logger.error).toHaveBeenCalled();
    const raised = alerts.filter((a) => a.alert_type === 'mission_deferred_monthly_spend');
    expect(raised).toHaveLength(1);
    expect(raised[0].mission_id).toBe(MISSION_ID);
    expect(raised[0].resolved).toBe(false);
    expect(raised[0].payload.month).toBe('2026-11');
    expect(raised[0].payload.spend_usd).toBeCloseTo(212.5, 4);
    expect(raised[0].payload.hard_limit_usd).toBe(150);
    expect(raised[0].payload.biggest_contributor).toMatchObject({ call_type: 'response_sim' });
    expect(raised[0].payload.action_required).toMatch(/re-trigger|raise/i);
  });

  test('the customer is not told their paid study failed - the row keeps its status', async () => {
    spendAllowsNewWork.mockResolvedValue(OVER_HARD_LIMIT);
    await runMission(MISSION_ID);
    expect(missionUpdates).toHaveLength(0);
    for (const patch of missionUpdates) {
      expect(patch.status).not.toBe('failed');
    }
  });

  test('the gate is asked about THIS run, and told whether it is a resume', async () => {
    spendAllowsNewWork.mockResolvedValue(OVER_HARD_LIMIT);
    await runMission(MISSION_ID);
    expect(spendAllowsNewWork).toHaveBeenCalledWith(expect.objectContaining({ resume: false }));
  });
});

describe('a study already in flight is never killed', () => {
  test('a resumed run proceeds even when the gate would refuse new work', async () => {
    // The real gate short-circuits on resume. Prove runMission asks it with
    // resume=true and honours an allow, rather than re-deciding locally.
    spendAllowsNewWork.mockImplementation(async ({ resume }) => (resume
      ? { allowed: true, reason: 'in_flight_run' }
      : OVER_HARD_LIMIT));
    missionRow = { ...base, status: 'processing', started_at: new Date().toISOString() };

    const out = await (async () => {
      try { return await runMission(MISSION_ID, { resume: true }); } catch { return 'threw later'; }
    })();

    expect(out).not.toEqual({ skipped: true, reason: 'monthly_spend_hard_limit' });
    expect(spendAllowsNewWork).toHaveBeenCalledWith(expect.objectContaining({ resume: true }));
    expect(alerts.filter((a) => a.alert_type === 'mission_deferred_monthly_spend')).toHaveLength(0);
  });
});

describe('CONTROL — the gate does not touch a normal month', () => {
  const pastTheGate = async () => {
    try { return await runMission(MISSION_ID); } catch { return 'threw later'; }
  };

  test('under the ceiling, the mission claims and runs', async () => {
    const out = await pastTheGate();
    expect(out).not.toEqual({ skipped: true, reason: 'monthly_spend_hard_limit' });
    expect(claimAttempts).toBeGreaterThan(0);
    expect(alerts.filter((a) => a.alert_type === 'mission_deferred_monthly_spend')).toHaveLength(0);
  });

  test('over the ceiling but under the hard limit, the mission still runs', async () => {
    spendAllowsNewWork.mockResolvedValue({
      allowed: true, reason: 'over_ceiling_under_hard_limit', state: { spendUsd: 72.4 },
    });
    const out = await pastTheGate();
    expect(out).not.toEqual({ skipped: true, reason: 'monthly_spend_hard_limit' });
    expect(claimAttempts).toBeGreaterThan(0);
  });

  test('if the spend log cannot be read, the mission is not blocked', async () => {
    spendAllowsNewWork.mockResolvedValue({ allowed: true, reason: 'spend_unreadable' });
    const out = await pastTheGate();
    expect(out).not.toEqual({ skipped: true, reason: 'monthly_spend_hard_limit' });
    expect(claimAttempts).toBeGreaterThan(0);
  });

  test('a finished mission is not re-gated - the terminal skip comes first', async () => {
    spendAllowsNewWork.mockResolvedValue(OVER_HARD_LIMIT);
    missionRow = { ...base, status: 'completed' };
    const out = await runMission(MISSION_ID);
    expect(out).toMatchObject({ skipped: true, reason: 'already completed' });
    expect(spendAllowsNewWork).not.toHaveBeenCalled();
    expect(alerts).toHaveLength(0);
  });
});
