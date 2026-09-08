/**
 * ESTIMATED_FULL_SURVEY_COST_USD gates the PRE-EMPTIVE ceiling exit.
 *
 * The loop has two ceiling checks. The hard one fires when spend has already
 * reached the ceiling. The pre-emptive one fires when the NEXT persona's
 * worst-case cost would breach it, so we do not pay for work we would discard.
 *
 * The pre-emptive check can only fire in the window
 *   (ceiling - ESTIMATED_FULL_SURVEY_COST_USD, ceiling)
 * so the constant IS the width of that window. At 0.15 the window was 15 to
 * 19x the measured marginal cost of a persona, which meant the pre-emptive
 * exit triggered on missions that had plenty of budget left. At 0.03 the
 * window is roughly 3x the marginal rate: wide enough to skip a persona we
 * genuinely cannot afford, narrow enough not to strand a paid mission.
 *
 * This test discriminates the two values behaviourally rather than asserting
 * the number, so it fails if the constant drifts back up as well as if the
 * pre-emptive check is removed.
 *
 * Arithmetic: ceiling 1.00, cost 0.10 per persona, so spend lands on
 * 0.10 ... 0.90, 1.00.
 *   at 0.03: 0.90 + 0.03 = 0.93 < 1.00, continue; hard check stops it at 1.00
 *            -> 10 qualified
 *   at 0.15: 0.90 + 0.15 = 1.05 > 1.00, pre-emptive stops it early
 *            ->  9 qualified
 */
jest.mock('../src/utils/logger', () => ({
  info: () => {}, warn: () => {}, error: () => {}, debug: () => {},
}));
const mockGeneratePersonas = jest.fn();
jest.mock('../src/services/ai/personas', () => ({ generatePersonas: mockGeneratePersonas }));
const mockSimulateResponses = jest.fn();
jest.mock('../src/services/ai/simulate', () => ({
  simulateResponses: mockSimulateResponses,
  passesScreening: jest.requireActual('../src/services/ai/simulate').passesScreening,
}));
jest.mock('../src/db/missionSchema', () => ({
  updateMission: jest.fn().mockResolvedValue({ data: null, error: null }),
  isHeartbeatColumnMissing: jest.fn(() => false),
  noteHeartbeatColumnMissing: jest.fn(() => false),
}));

const QUESTIONS = [
  { id: 'q1', text: 'Screen?', isScreening: true, options: ['Yes', 'No'], qualifyingAnswers: ['Yes'] },
  { id: 'q2', text: 'Detail?', options: ['A', 'B'] },
];

function harness(costPerPersona) {
  const spendRef = { value: 0 };
  let n = 0;
  mockGeneratePersonas.mockImplementation(async (_m, count) => {
    const out = [];
    for (let i = 0; i < count; i++) { n += 1; out.push({ id: `p${n}`, persona_id: `p${n}`, name: `P${n}`, age: 30 }); }
    return out;
  });
  mockSimulateResponses.mockImplementation(async (persona) => {
    spendRef.value = Number((spendRef.value + costPerPersona).toFixed(4));
    return QUESTIONS.map((q) => ({
      persona_id: persona.persona_id, question_id: q.id,
      answer: q.isScreening ? 'Yes' : 'A',
    }));
  });
  const supabase = {
    from() {
      const chain = {
        select: () => chain, update: () => chain, eq: () => chain,
        order: () => chain, range: () => chain,
        single: async () => ({
          data: { ai_spend_usd_actual: spendRef.value, status: 'processing', ai_spend_ceiling_usd: 1.0 },
          error: null,
        }),
        insert: async () => ({ error: null }),
        upsert: async () => ({ error: null }),
        then: (resolve) => resolve({ data: [], error: null }),
      };
      return chain;
    },
  };
  const mission = {
    id: 'm-est', user_id: 'u1', goal_type: 'validate',
    target_qualified_count: 999, ai_spend_ceiling_usd: 1.0,
    questions: QUESTIONS, targeting: {},
  };
  return { mission, supabase };
}

/** Re-require the loop with a specific constant so both values are testable. */
async function runWith(estimate) {
  jest.resetModules();
  process.env.ESTIMATED_FULL_SURVEY_COST_USD = String(estimate);
  const { runRecruitmentLoop } = require('../src/services/ai/recruitLoop');
  const { mission, supabase } = harness(0.10);
  return runRecruitmentLoop(mission, supabase);
}

afterEach(() => { delete process.env.ESTIMATED_FULL_SURVEY_COST_USD; });

describe('the pre-emptive window is sized to real cost, not the old estimate', () => {
  test('at 0.03 the loop uses its full budget: 10 personas on a $1.00 ceiling', async () => {
    const res = await runWith(0.03);
    expect(res.qualifiedCount).toBe(10);
  });

  test('at the old 0.15 it stops a whole persona early, leaving budget unspent', async () => {
    const res = await runWith(0.15);
    expect(res.qualifiedCount).toBe(9);
  });

  test('the shipped default is the lower value, so a paid mission is not short-changed', async () => {
    jest.resetModules();
    delete process.env.ESTIMATED_FULL_SURVEY_COST_USD;
    const { runRecruitmentLoop } = require('../src/services/ai/recruitLoop');
    const { mission, supabase } = harness(0.10);
    const res = await runRecruitmentLoop(mission, supabase);
    expect(res.qualifiedCount).toBe(10);
  });
});
