/**
 * The spend ceiling is re-read from the row on every iteration.
 *
 * THE DEFECT. runRecruitmentLoop captured `ai_spend_ceiling_usd` once at
 * entry. Raising it on a mission that was ALREADY RUNNING had no effect: both
 * ceiling comparisons kept using the value from the moment the loop started.
 * An operator watching a long mission approach its limit could not extend it
 * without killing and restarting the run, and got no signal that their change
 * was being ignored.
 *
 * WHY IT MATTERS BEYOND OPERATOR CONVENIENCE. The ceiling can be wrong at
 * insert time. /free-launch never writes total_price_usd, so the pass-51
 * recompute trigger never fires and the row keeps whatever placeholder the
 * client wrote. Production mission 10ecb820 carried $29.70, derived from a
 * hardcoded $99, on a study estimated at $548.
 *
 * The fallback matters as much as the refresh: a transient read failure must
 * not lower a ceiling and strand a paid run, nor raise one and overspend.
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

const { runRecruitmentLoop } = require('../src/services/ai/recruitLoop');

const QUESTIONS = [
  { id: 'q1', text: 'Do you drink coffee?', isScreening: true,
    options: ['Yes', 'No'], qualifyingAnswers: ['Yes'] },
  { id: 'q2', text: 'How often?', options: ['Daily', 'Weekly'] },
];

const makeMission = (ceiling) => ({
  id: 'm-ceiling', user_id: 'u1', goal_type: 'compare',
  target_qualified_count: 40, ai_spend_ceiling_usd: ceiling,
  questions: QUESTIONS, targeting: {},
});

/** Every persona qualifies; each simulate call costs `cost`. */
function primeGeneration(cost, spendRef) {
  let n = 0;
  mockGeneratePersonas.mockImplementation(async (_m, count) => {
    const out = [];
    for (let i = 0; i < count; i++) { n += 1; out.push({ id: `p${n}`, persona_id: `p${n}`, name: `P${n}`, age: 30 }); }
    return out;
  });
  mockSimulateResponses.mockImplementation(async (persona) => {
    spendRef.value += cost;
    return QUESTIONS.map((q) => ({
      persona_id: persona.persona_id, question_id: q.id,
      answer: q.isScreening ? 'Yes' : 'Daily',
    }));
  });
}

/**
 * Supabase stub whose `.single()` serves BOTH the spend re-read and the
 * ceiling re-read, and whose ceiling is supplied by a live getter so a test
 * can move it mid-run.
 */
function makeSupabase(spendRef, ceilingRef, opts = {}) {
  return {
    from() {
      const chain = {
        select: () => chain, update: () => chain, eq: () => chain,
        order: () => chain, range: () => chain,
        single: async () => {
          if (opts.failReads) return { data: null, error: { message: 'transient' } };
          return { data: { ai_spend_usd_actual: spendRef.value, ai_spend_ceiling_usd: ceilingRef.value }, error: null };
        },
        insert: async () => ({ error: null }),
        upsert: async () => ({ error: null }),
        then: (resolve) => resolve({ data: [], error: null }),
      };
      return chain;
    },
  };
}

beforeEach(() => { mockGeneratePersonas.mockReset(); mockSimulateResponses.mockReset(); });

describe('a mid-flight ceiling change takes effect', () => {
  test('RAISING the ceiling mid-run lets the loop continue past the original limit', async () => {
    const spendRef = { value: 0 };
    const ceilingRef = { value: 1.0 };            // would stop at ~10 personas
    primeGeneration(0.10, spendRef);
    // Raise it once the run is clearly underway.
    mockSimulateResponses.mockImplementation(async (persona) => {
      spendRef.value += 0.10;
      if (spendRef.value >= 0.5) ceilingRef.value = 100;
      return QUESTIONS.map((q) => ({
        persona_id: persona.persona_id, question_id: q.id,
        answer: q.isScreening ? 'Yes' : 'Daily',
      }));
    });
    const res = await runRecruitmentLoop(makeMission(1.0), makeSupabase(spendRef, ceilingRef));
    // With the ceiling captured at entry this stops around 10; with the
    // re-read it runs to the 40 target.
    expect(res.qualifiedCount).toBe(40);
  });

  test('LOWERING the ceiling mid-run stops the loop early', async () => {
    const spendRef = { value: 0 };
    const ceilingRef = { value: 100 };
    primeGeneration(0.10, spendRef);
    mockSimulateResponses.mockImplementation(async (persona) => {
      spendRef.value += 0.10;
      if (spendRef.value >= 0.5) ceilingRef.value = 0.5;   // slam it shut
      return QUESTIONS.map((q) => ({
        persona_id: persona.persona_id, question_id: q.id,
        answer: q.isScreening ? 'Yes' : 'Daily',
      }));
    });
    const res = await runRecruitmentLoop(makeMission(100), makeSupabase(spendRef, ceilingRef));
    expect(res.qualifiedCount).toBeLessThan(40);
  });
});

describe('the refresh is non-fatal', () => {
  test('a failing read keeps the previous ceiling rather than stranding the run', async () => {
    const spendRef = { value: 0 };
    const ceilingRef = { value: 100 };
    primeGeneration(0.01, spendRef);
    const res = await runRecruitmentLoop(
      makeMission(100),
      makeSupabase(spendRef, ceilingRef, { failReads: true }),
    );
    // Reads always fail, so the entry ceiling of 100 must persist and the
    // run must reach target rather than halting on a NaN or a zero.
    expect(res.qualifiedCount).toBe(40);
  });

  test('a non-numeric ceiling from the database is ignored, not applied', async () => {
    const spendRef = { value: 0 };
    const ceilingRef = { value: null };
    primeGeneration(0.01, spendRef);
    const res = await runRecruitmentLoop(makeMission(100), makeSupabase(spendRef, ceilingRef));
    expect(res.qualifiedCount).toBe(40);
  });
});
