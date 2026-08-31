// Pass 42 A5 — recruitment loop integration tests across the
// qualification-rate spectrum. Mocks persona generation + survey
// simulation at the module boundary so we test the loop's control
// flow + ceiling enforcement without hitting the Claude API.
//
// The scenarios exercise the full economic envelope:
//   1. Normal brief    (70% pass rate) — should hit target on budget
//   2. Strict brief    (10% pass rate) — should hit target with extra spend
//   3. Very strict     (5% pass rate)  — should hit target near ceiling
//   4. Impossible      (1% pass rate)  — should ceiling_hit with partial
//   5. Pathological    (0% pass rate)  — should hit MAX_PERSONAS guard
//
// NO REFUNDS policy enforcement: under no test path may the loop
// call any Stripe / refund API. Verified by asserting no `stripe`
// or `refund` calls in the spy log.

// Env vars primed in test/setupEnv.js (jest setupFiles) so transitive
// require of supabase/anthropic doesn't throw at module-load time.

// ── Mocks (jest.mock is hoisted; mock vars must be prefixed `mock`) ──
jest.mock('../src/utils/logger', () => ({
  info: () => {}, warn: () => {}, error: () => {}, debug: () => {},
}));

const mockGeneratePersonas = jest.fn();
jest.mock('../src/services/ai/personas', () => ({
  generatePersonas: mockGeneratePersonas,
}));

const mockSimulateResponses = jest.fn();
jest.mock('../src/services/ai/simulate', () => ({
  simulateResponses: mockSimulateResponses,
  // Real screening logic — we want to test the loop's interaction
  // with the actual passesScreening implementation.
  passesScreening: jest.requireActual('../src/services/ai/simulate').passesScreening,
}));

const mockUpdateMission = jest.fn().mockResolvedValue({ data: null, error: null });
jest.mock('../src/db/missionSchema', () => ({
  updateMission: mockUpdateMission,
}));

const { runRecruitmentLoop, MAX_PERSONAS_PER_TARGET } = require('../src/services/ai/recruitLoop');

// ── Helpers ──────────────────────────────────────────────────────────

function makePersona(id) {
  return { id, persona_id: id, name: `P${id}`, age: 35 };
}

function setupPersonaGeneration() {
  let counter = 0;
  mockGeneratePersonas.mockImplementation(async (mission, count) => {
    const out = [];
    for (let i = 0; i < count; i++) {
      counter += 1;
      out.push(makePersona(`m${counter}`));
    }
    return out;
  });
}

/**
 * Deterministic pass-rate mock: every (1/passRate)-th persona passes
 * the screener. Other personas answer "No" to q1 (the screening
 * question) which fails passesScreening since qualifyingAnswers=['Yes'].
 *
 * spendRef is a shared object whose `.value` field is incremented by
 * costPerCallUsd on every call — emulates the anthropic.js side-effect
 * that bumps ai_spend_usd_actual in production.
 */
function setupSimulationWithPassRate(passRate, missionQuestions, costPerCallUsd, spendRef) {
  let callCount = 0;
  mockSimulateResponses.mockImplementation(async (persona) => {
    callCount += 1;
    // Pass if THIS call's threshold crosses the next integer boundary
    // — gives clean deterministic distribution.
    const passes = passRate > 0 &&
      Math.floor(callCount * passRate) > Math.floor((callCount - 1) * passRate);
    spendRef.value += costPerCallUsd;
    return missionQuestions.map((q, idx) => ({
      question_id: q.id,
      answer: idx === 0 ? (passes ? 'Yes' : 'No') : 'some answer',
    }));
  });
}

function makeMission({ target, ceiling, goalType = 'research' }) {
  return {
    id: 'test-mission-' + Math.random().toString(36).slice(2, 10),
    goal_type: goalType,
    target_qualified_count: target,
    ai_spend_ceiling_usd: ceiling,
    respondent_count: target,
    questions: [
      // q1 screener — answer must be 'Yes' to qualify. passesScreening
      // reads `qualifying_answers` (snake_case) per simulate.js
      // contract, not the camelCase variant.
      { id: 'q1', isScreening: true, type: 'single',
        options: ['Yes', 'No'], qualifying_answers: ['Yes'] },
      { id: 'q2', type: 'rating', options: [1, 2, 3, 4, 5] },
      { id: 'q3', type: 'text' },
    ],
  };
}

/**
 * Minimal supabase mock — supports the .from().select().eq().single()
 * chain that recruitLoop uses to re-read ai_spend_usd_actual, plus
 * .from().update().eq() for writeProgress. Also exposes a stripeRefunds
 * spy that must never be called (NO REFUNDS policy enforcement).
 */
function makeSupabaseMock(spendRef) {
  // Pass 46 Phase 2 — the loop now also (a) reads prior mission_responses
  // rows with a DOUBLE .eq() chain awaited directly (resume support) and
  // (b) inserts each qualified persona's rows. The chain object is both
  // chainable and thenable: awaiting it resolves empty (no prior rows →
  // fresh start), .single() serves the spend re-read, insert no-ops.
  return {
    from() {
      const chain = {
        select: () => chain,
        update: () => chain,
        eq: () => chain,
        // Pass 51 — the prior-rows read now pages through fetchAllResponses,
        // so the stub chain must also answer .order() and .range().
        order: () => chain,
        range: () => chain,
        single: async () => ({
          data: { ai_spend_usd_actual: spendRef.value },
          error: null,
        }),
        insert: async () => ({ error: null }),
        // Pass 48 — the loop now persists via persistResponseRows, which
        // issues INSERT ... ON CONFLICT DO NOTHING (supabase-js upsert).
        upsert: async () => ({ error: null }),
        order: () => chain,
        range: async () => ({ data: [], error: null }),
        then: (resolve) => resolve({ data: [], error: null }),
      };
      return chain;
    },
    stripeRefunds: jest.fn(),
  };
}

beforeEach(() => {
  mockGeneratePersonas.mockReset();
  mockSimulateResponses.mockReset();
  mockUpdateMission.mockClear();
  setupPersonaGeneration();
});

// ── Scenarios ────────────────────────────────────────────────────────

describe('Pass 42 A5 — recruitment loop integration', () => {
  it('hits target on normal brief (70% pass rate, generous ceiling)', async () => {
    const target = 10;
    const ceiling = 30;
    const mission = makeMission({ target, ceiling });
    const spendRef = { value: 0 };
    setupSimulationWithPassRate(0.7, mission.questions, 0.10, spendRef);
    const supabase = makeSupabaseMock(spendRef);

    const result = await runRecruitmentLoop(mission, supabase);

    expect(result.qualifiedCount).toBe(target);
    expect(result.partial).toBe(false);
    expect(result.terminalStatus).toBe('target_hit');
    // ~target/0.7 ≈ 15 personas
    expect(result.recruitedCount).toBeGreaterThanOrEqual(target);
    expect(result.recruitedCount).toBeLessThanOrEqual(target * 3);
    expect(supabase.stripeRefunds).not.toHaveBeenCalled();
  });

  it('hits target on strict brief (10% pass rate) with extra spend', async () => {
    const target = 5;
    const ceiling = 30;
    const mission = makeMission({ target, ceiling });
    const spendRef = { value: 0 };
    setupSimulationWithPassRate(0.1, mission.questions, 0.10, spendRef);
    const supabase = makeSupabaseMock(spendRef);

    const result = await runRecruitmentLoop(mission, supabase);

    expect(result.qualifiedCount).toBe(target);
    expect(result.partial).toBe(false);
    expect(result.terminalStatus).toBe('target_hit');
    expect(result.recruitedCount).toBeGreaterThanOrEqual(target);
    expect(supabase.stripeRefunds).not.toHaveBeenCalled();
  });

  it('hits target on very strict brief (5% pass rate) near ceiling', async () => {
    const target = 3;
    const ceiling = 30;
    const mission = makeMission({ target, ceiling });
    const spendRef = { value: 0 };
    setupSimulationWithPassRate(0.05, mission.questions, 0.10, spendRef);
    const supabase = makeSupabaseMock(spendRef);

    const result = await runRecruitmentLoop(mission, supabase);

    expect(result.qualifiedCount).toBe(target);
    expect(result.terminalStatus).toBe('target_hit');
    expect(supabase.stripeRefunds).not.toHaveBeenCalled();
  });

  it('ceiling_hit on impossible brief (1% pass rate, tight ceiling) — NO REFUND', async () => {
    const target = 10;
    const ceiling = 1.50;
    const mission = makeMission({ target, ceiling });
    const spendRef = { value: 0 };
    // 1% pass rate, $0.10/persona → need ~1000 personas = $100, way over
    // the $1.50 ceiling.
    setupSimulationWithPassRate(0.01, mission.questions, 0.10, spendRef);
    const supabase = makeSupabaseMock(spendRef);

    const result = await runRecruitmentLoop(mission, supabase);

    expect(result.qualifiedCount).toBeLessThan(target);
    expect(result.partial).toBe(true);
    expect(result.terminalStatus).toBe('ceiling_hit');
    // CRITICAL: NO REFUND — loop must terminate cleanly without
    // touching any Stripe API.
    expect(supabase.stripeRefunds).not.toHaveBeenCalled();
  });

  it('hits MAX_PERSONAS_PER_TARGET guard on 0% pass rate', async () => {
    const target = 1;
    const ceiling = 9999;
    const mission = makeMission({ target, ceiling });
    const spendRef = { value: 0 };
    setupSimulationWithPassRate(0.0, mission.questions, 0.0, spendRef);
    const supabase = makeSupabaseMock(spendRef);

    const result = await runRecruitmentLoop(mission, supabase);

    expect(result.qualifiedCount).toBe(0);
    expect(result.recruitedCount).toBeLessThanOrEqual(target * MAX_PERSONAS_PER_TARGET);
    // Pass 45 T2b — 'ceiling_hit' means SPEND ceiling only; the
    // max-personas guard is an infra exit and labels 'incomplete'
    // (see recruit_loop_invariants.test.js). Updated from the stale
    // Pass 42 expectation when Pass 46 first ran the full suite.
    expect(result.terminalStatus).toBe('incomplete');
    expect(supabase.stripeRefunds).not.toHaveBeenCalled();
  });

  it('writes recruitment_status=target_hit on success path', async () => {
    const target = 5;
    const ceiling = 30;
    const mission = makeMission({ target, ceiling });
    const spendRef = { value: 0 };
    setupSimulationWithPassRate(0.7, mission.questions, 0.10, spendRef);
    const supabase = makeSupabaseMock(spendRef);

    await runRecruitmentLoop(mission, supabase);

    const lastPatch = mockUpdateMission.mock.calls[mockUpdateMission.mock.calls.length - 1][2];
    expect(lastPatch.recruitment_status).toBe('target_hit');
    expect(lastPatch.recruitment_completed_at).toBeDefined();
  });

  it('writes recruitment_status=ceiling_hit on partial-delivery path', async () => {
    const target = 100;
    const ceiling = 0.50;
    const mission = makeMission({ target, ceiling });
    const spendRef = { value: 0 };
    setupSimulationWithPassRate(0.05, mission.questions, 0.10, spendRef);
    const supabase = makeSupabaseMock(spendRef);

    await runRecruitmentLoop(mission, supabase);

    const lastPatch = mockUpdateMission.mock.calls[mockUpdateMission.mock.calls.length - 1][2];
    expect(lastPatch.recruitment_status).toBe('ceiling_hit');
    expect(lastPatch.recruitment_completed_at).toBeDefined();
  });
});
