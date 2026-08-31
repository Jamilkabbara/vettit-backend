/**
 * Pass 46 Phase 2 — recruit-loop resumability + in-loop exposure.
 *
 * 1. RESUME: a loop entered with previously-persisted qualified rows
 *    reconstructs state and only generates the remainder (simulating a
 *    process restart mid-run).
 * 2. Incremental persistence: every qualified persona's rows are
 *    inserted immediately (what makes 1 possible).
 * 3. brand_lift exposure is tagged BEFORE simulation, alternating —
 *    simulate.js must see _exposure_status (the old post-loop tagging
 *    produced baseline answers with cosmetic labels).
 */

jest.mock('../src/services/ai/personas', () => ({
  generatePersonas: jest.fn(),
}));
jest.mock('../src/services/ai/simulate', () => ({
  simulateResponses: jest.fn(),
  simulateAllResponses: jest.fn(),
  passesScreening: (q, answer) => {
    if (!q.isScreening || !q.qualifyingAnswer) return true;
    return Array.isArray(answer)
      ? answer.includes(q.qualifyingAnswer)
      : answer === q.qualifyingAnswer;
  },
}));
jest.mock('../src/db/missionSchema', () => ({
  updateMission: jest.fn().mockResolvedValue({}),
  sanitizeMissionPatch: jest.fn((p) => ({ patch: p, rejected: [] })),
}));
jest.mock('../src/utils/logger', () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
}));

const { generatePersonas } = require('../src/services/ai/personas');
const { simulateResponses } = require('../src/services/ai/simulate');
const { runRecruitmentLoop } = require('../src/services/ai/recruitLoop');

// Table-aware stub: the prior-rows read awaits the chain directly
// (thenable); the missions spend re-read uses .single(); inserts are
// recorded per table.
function makeSupabase({ spendSequence = [], priorResponseRows = [] } = {}) {
  let spendIdx = 0;
  const inserts = { mission_responses: [], admin_alerts: [] };
  return {
    inserts,
    from(table) {
      const chain = {
        select: () => chain,
        eq: () => chain,
        // Pass 51 — the prior-rows read now pages through fetchAllResponses,
        // so the stub chain must also answer .order() and .range().
        order: () => chain,
        range: () => chain,
        update: () => chain,
        single: async () => {
          const spend = spendSequence[Math.min(spendIdx, spendSequence.length - 1)] ?? 0;
          spendIdx += 1;
          return { data: { ai_spend_usd_actual: spend }, error: null };
        },
        insert: async (rows) => {
          if (inserts[table]) inserts[table].push(...(Array.isArray(rows) ? rows : [rows]));
          return { error: null };
        },
        // Pass 48 — persistResponseRows writes via upsert (ON CONFLICT DO
        // NOTHING); record it exactly like insert so the existing
        // assertions on inserts.mission_responses keep working.
        upsert: async (rows) => {
          if (inserts[table]) inserts[table].push(...(Array.isArray(rows) ? rows : [rows]));
          return { error: null };
        },
        order: () => chain,
        range: async () => ({ data: [], error: null }),
        then: (resolve) => resolve({
          data: table === 'mission_responses' ? priorResponseRows : null,
          error: null,
        }),
      };
      return chain;
    },
  };
}

const QUESTIONS = [
  { id: 'q1', text: 'screener', type: 'single', options: ['Yes', 'No'], isScreening: true, qualifyingAnswer: 'Yes' },
  { id: 'q2', text: 'rating', type: 'rating', options: [] },
];

function mission(overrides = {}) {
  return {
    id: 'resume-test-mission',
    user_id: 'test-user',
    goal_type: 'research',
    target_qualified_count: 5,
    ai_spend_ceiling_usd: 2.7,
    questions: QUESTIONS,
    ...overrides,
  };
}

function answersFor(qualifies) {
  return [
    { question_id: 'q1', answer: qualifies ? 'Yes' : 'No' },
    { question_id: 'q2', answer: 4 },
  ];
}

function priorRowsFor(personaIds) {
  const rows = [];
  for (const pid of personaIds) {
    for (const q of QUESTIONS) {
      rows.push({
        persona_id: pid,
        persona_profile: { id: pid, persona_id: pid, name: pid },
        question_id: q.id,
        answer: q.id === 'q1' ? 'Yes' : 4,
        exposure_status: 'not_applicable',
      });
    }
  }
  return rows;
}

beforeEach(() => {
  jest.clearAllMocks();
  process.env.RECRUIT_LOOP_ENABLED = 'true';
});

test('resume: prior 2 qualified personas → loop only generates the remaining 3', async () => {
  let n = 100; // fresh ids distinct from resumed p1/p2
  generatePersonas.mockImplementation(async () => [{ id: `p${++n}`, persona_id: `p${n}`, name: `P${n}` }]);
  simulateResponses.mockImplementation(async () => answersFor(true));
  const supabase = makeSupabase({
    spendSequence: [0.01],
    priorResponseRows: priorRowsFor(['p1', 'p2']),
  });

  const r = await runRecruitmentLoop(mission({ recruited_persona_count: 4 }), supabase);

  expect(r.resumed).toBe(true);
  expect(r.qualifiedCount).toBe(5);
  // resumed recruited floor (4) + 3 fresh generations
  expect(r.recruitedCount).toBe(7);
  expect(generatePersonas).toHaveBeenCalledTimes(3);
  expect(r.terminalStatus).toBe('target_hit');
  // only the 3 NEW personas' rows were inserted (2 questions each)
  expect(supabase.inserts.mission_responses).toHaveLength(6);
  const insertedPersonas = new Set(supabase.inserts.mission_responses.map((row) => row.persona_id));
  expect(insertedPersonas.has('p1')).toBe(false);
  expect(insertedPersonas.has('p2')).toBe(false);
  // responses returned to runMission include resumed + new
  expect(r.responses).toHaveLength(10);
  expect(r.responsesAlreadyPersisted).toBe(true);
  expect(r.unpersistedResponses).toHaveLength(0);
});

test('fresh run: every qualified persona is persisted incrementally', async () => {
  let n = 0;
  generatePersonas.mockImplementation(async () => [{ id: `p${++n}`, persona_id: `p${n}`, name: `P${n}` }]);
  simulateResponses.mockImplementation(async () => answersFor(true));
  const supabase = makeSupabase({ spendSequence: [0.01] });

  const r = await runRecruitmentLoop(mission({ target_qualified_count: 3 }), supabase);

  expect(r.resumed).toBe(false);
  expect(r.qualifiedCount).toBe(3);
  expect(supabase.inserts.mission_responses).toHaveLength(6); // 3 personas × 2 questions
  for (const row of supabase.inserts.mission_responses) {
    expect(row.mission_id).toBe('resume-test-mission');
    expect(row.screened_out).toBe(false);
  }
});

test('brand_lift: personas are exposure-tagged BEFORE simulation, alternating', async () => {
  let n = 0;
  generatePersonas.mockImplementation(async () => [{ id: `p${++n}`, persona_id: `p${n}`, name: `P${n}` }]);
  const seenExposures = [];
  simulateResponses.mockImplementation(async (persona) => {
    seenExposures.push(persona._exposure_status);
    return answersFor(true);
  });
  const supabase = makeSupabase({ spendSequence: [0.01] });

  const r = await runRecruitmentLoop(
    mission({ goal_type: 'brand_lift', target_qualified_count: 4 }),
    supabase,
  );

  expect(r.qualifiedCount).toBe(4);
  // recruitedCount parity: 1st persona exposed, then alternating —
  // and crucially the tag was visible DURING simulation.
  expect(seenExposures).toEqual(['exposed', 'control', 'exposed', 'control']);
  // persisted rows carry the same tags
  const byPersona = {};
  for (const row of supabase.inserts.mission_responses) {
    byPersona[row.persona_id] = row.exposure_status;
  }
  expect(Object.values(byPersona).sort()).toEqual(['control', 'control', 'exposed', 'exposed']);
});
