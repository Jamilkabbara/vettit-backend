/**
 * Pass 48 — a resumed recruit-loop run must not re-insert rows it has
 * already persisted.
 *
 * Production evidence (mission bdae4d45-9a85-40f2-a32a-51cce7ef37e0):
 * 1440 rows over 720 distinct (persona_id, question_id) keys — every key
 * present exactly twice, with DIFFERENT answers and DIFFERENT
 * persona_profiles in the two copies, because the second copy came from
 * an independent generate+simulate run of the same mission.
 *
 * These tests pin the loop half of the fix. The persistResponseRows unit
 * itself is covered by test/persist_responses_idempotent.test.js.
 */

jest.mock('../src/services/ai/personas', () => ({ generatePersonas: jest.fn() }));
jest.mock('../src/services/ai/simulate', () => ({
  simulateResponses: jest.fn(),
  simulateAllResponses: jest.fn(),
  passesScreening: (q, answer) => {
    if (!q.isScreening || !q.qualifyingAnswer) return true;
    return Array.isArray(answer) ? answer.includes(q.qualifyingAnswer) : answer === q.qualifyingAnswer;
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

const QUESTIONS = [
  { id: 'q1', text: 'screener', type: 'single', options: ['Yes', 'No'], isScreening: true, qualifyingAnswer: 'Yes' },
  { id: 'q2', text: 'rating', type: 'rating', options: [] },
];

/**
 * Table-aware stub. The prior-rows read awaits the chain directly
 * (thenable); the missions spend re-read uses .single(); writes arrive as
 * upsert (ON CONFLICT DO NOTHING) and are recorded per table. .order() /
 * .range() exist because persistResponseRows pages its key read when it
 * is NOT handed a knownKeys set.
 */
function makeSupabase({ spendSequence = [0.01], priorResponseRows = [] } = {}) {
  let spendIdx = 0;
  const writes = { mission_responses: [], admin_alerts: [] };
  return {
    writes,
    from(table) {
      const chain = {
        select: () => chain,
        eq: () => chain,
        update: () => chain,
        order: () => chain,
        range: async () => ({ data: [], error: null }),
        single: async () => {
          const spend = spendSequence[Math.min(spendIdx, spendSequence.length - 1)] ?? 0;
          spendIdx += 1;
          return { data: { ai_spend_usd_actual: spend }, error: null };
        },
        insert: async (rows) => {
          if (writes[table]) writes[table].push(...(Array.isArray(rows) ? rows : [rows]));
          return { error: null };
        },
        upsert: async (rows) => {
          if (writes[table]) writes[table].push(...(Array.isArray(rows) ? rows : [rows]));
          return { error: null };
        },
        then: (resolve) => resolve({
          data: table === 'mission_responses' ? priorResponseRows : null,
          error: null,
        }),
      };
      return chain;
    },
  };
}

function mission(overrides = {}) {
  return {
    id: 'idem-mission',
    user_id: 'test-user',
    goal_type: 'research',
    target_qualified_count: 3,
    ai_spend_ceiling_usd: 2.7,
    questions: QUESTIONS,
    ...overrides,
  };
}

const answers = () => [
  { question_id: 'q1', answer: 'Yes' },
  { question_id: 'q2', answer: 4 },
];

function priorRowsFor(personaIds) {
  const rows = [];
  for (const pid of personaIds) {
    for (const q of QUESTIONS) {
      rows.push({
        persona_id: pid,
        persona_profile: { id: pid, persona_id: pid },
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

test('resume with the target already met writes ZERO rows and generates ZERO personas', async () => {
  generatePersonas.mockImplementation(async () => [{ id: 'SHOULD-NOT-RUN' }]);
  simulateResponses.mockImplementation(async () => answers());
  const supabase = makeSupabase({ priorResponseRows: priorRowsFor(['P001', 'P002', 'P003']) });

  const r = await runRecruitmentLoop(mission(), supabase);

  expect(r.resumed).toBe(true);
  expect(r.qualifiedCount).toBe(3);
  expect(generatePersonas).not.toHaveBeenCalled();
  // THE REGRESSION: pre-fix this path was safe only because the loop
  // never ran; the guarantee we now pin is that no write is attempted.
  expect(supabase.writes.mission_responses).toHaveLength(0);
  expect(r.terminalStatus).toBe('target_hit');
});

test('resume re-generating a persona_id that is ALREADY persisted does not duplicate it', async () => {
  // Persona ids are LLM-assigned "P001, P002, ..." from a sequential
  // prompt (src/services/ai/personas.js), so two independent runs of the
  // same mission collide on persona_id while producing different
  // answers. This reproduces exactly that: the resumed loop regenerates
  // P001 (already stored) and then a genuinely new P004.
  const generated = ['P001', 'P004'];
  let i = 0;
  generatePersonas.mockImplementation(async () => {
    const id = generated[Math.min(i, generated.length - 1)];
    i += 1;
    return [{ id, persona_id: id }];
  });
  // Different answers from the stored copy — the divergence that makes
  // duplicates corrupting rather than merely redundant.
  simulateResponses.mockImplementation(async () => ([
    { question_id: 'q1', answer: 'Yes' },
    { question_id: 'q2', answer: 1 },
  ]));
  const supabase = makeSupabase({ priorResponseRows: priorRowsFor(['P001', 'P002']) });

  const r = await runRecruitmentLoop(mission(), supabase);

  const written = supabase.writes.mission_responses;
  // P001's rows were already stored — not written again.
  expect(written.filter((row) => row.persona_id === 'P001')).toHaveLength(0);
  // Only the genuinely new persona's 2 rows were written.
  expect(written).toHaveLength(2);
  expect(new Set(written.map((row) => row.persona_id))).toEqual(new Set(['P004']));
  // And no (persona_id, question_id) key is written twice.
  const keys = written.map((row) => `${row.persona_id}|${row.question_id}`);
  expect(new Set(keys).size).toBe(keys.length);
  // The re-generated P001 must NOT have been counted as a fresh
  // qualifier: qualifiedCount has to equal the number of DISTINCT
  // personas actually held, or the loop "hits target" with fewer
  // respondents than the customer paid for.
  expect(r.qualifiedCount).toBe(3);
  const personaIds = r.personas.map((p) => p.persona_id || p.id);
  expect(new Set(personaIds).size).toBe(3);
  expect(new Set(personaIds)).toEqual(new Set(['P001', 'P002', 'P004']));
});

test('fresh run still persists every qualified persona exactly once', async () => {
  let n = 0;
  generatePersonas.mockImplementation(async () => {
    n += 1;
    return [{ id: `P00${n}`, persona_id: `P00${n}` }];
  });
  simulateResponses.mockImplementation(async () => answers());
  const supabase = makeSupabase();

  const r = await runRecruitmentLoop(mission(), supabase);

  expect(r.resumed).toBe(false);
  expect(r.qualifiedCount).toBe(3);
  const written = supabase.writes.mission_responses;
  expect(written).toHaveLength(6); // 3 personas x 2 questions
  const keys = written.map((row) => `${row.persona_id}|${row.question_id}`);
  expect(new Set(keys).size).toBe(6);
});

test('a persist failure still routes the persona into unpersistedResponses', async () => {
  generatePersonas.mockImplementation(async () => [{ id: 'P001', persona_id: 'P001' }]);
  simulateResponses.mockImplementation(async () => answers());
  const supabase = makeSupabase();
  const realFrom = supabase.from.bind(supabase);
  supabase.from = (table) => {
    const chain = realFrom(table);
    if (table === 'mission_responses') {
      chain.upsert = async () => ({ error: { code: '08006', message: 'connection failure' } });
      chain.insert = async () => ({ error: { code: '08006', message: 'connection failure' } });
    }
    return chain;
  };

  const r = await runRecruitmentLoop(mission({ target_qualified_count: 1 }), supabase);

  expect(r.unpersistedResponses).toHaveLength(2);
  expect(r.responsesAlreadyPersisted).toBe(true);
});
