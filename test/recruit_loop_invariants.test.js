/**
 * Pass 45 T2a/T2b — recruitment loop invariants.
 *
 * 1. recruited >= qualified across the qualification-rate spectrum.
 * 2. A 429 burst (transient persona-gen failures) NEVER yields
 *    recruitment_status='ceiling_hit'; spend >= ceiling is the only
 *    path to that label. Infra exhaustion yields 'incomplete'.
 * 3. Genuine spend-ceiling exits DO yield 'ceiling_hit'.
 */

jest.mock('../src/services/ai/personas', () => ({
  generatePersonas: jest.fn(),
}));
jest.mock('../src/services/ai/simulate', () => ({
  simulateResponses: jest.fn(),
  simulateAllResponses: jest.fn(),
  // Real-enough screening check: single-choice qualifyingAnswer match.
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
  // Pass 49 — heartbeat_at availability latch (migration applied by hand).
  isHeartbeatColumnMissing: jest.fn(() => false),
  noteHeartbeatColumnMissing: jest.fn(() => false),
}));
jest.mock('../src/utils/logger', () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
}));

const { generatePersonas } = require('../src/services/ai/personas');
const { simulateResponses } = require('../src/services/ai/simulate');
const { runRecruitmentLoop } = require('../src/services/ai/recruitLoop');

// Stub supabase: spend re-read returns a configurable value; alert
// inserts recorded for assertions.
function makeSupabase({ spendSequence = [] } = {}) {
  let spendIdx = 0;
  const alerts = [];
  return {
    alerts,
    from(table) {
      const self = {
        select: () => self,
        eq: () => self,
        // Pass 51 — the prior-rows read now pages through fetchAllResponses,
        // so the stub self must also answer .order() and .range().
        order: () => self,
        range: () => self,
        single: async () => {
          const spend = spendSequence[Math.min(spendIdx, spendSequence.length - 1)] ?? 0;
          spendIdx += 1;
          return { data: { ai_spend_usd_actual: spend }, error: null };
        },
        insert: async (row) => {
          if (table === 'admin_alerts') alerts.push(row);
          return { error: null };
        },
        // Pass 48 — persistResponseRows writes via upsert (ON CONFLICT
        // DO NOTHING) with a plain-insert fallback.
        upsert: async () => ({ error: null }),
        update: () => self,
      };
      return self;
    },
  };
}

const MISSION = {
  id: 'test-mission-id',
  user_id: 'test-user',
  goal_type: 'research',
  target_qualified_count: 5,
  ai_spend_ceiling_usd: 2.7,
  questions: [
    { id: 'q1', text: 'screener', type: 'single', options: ['Yes', 'No'], isScreening: true, qualifyingAnswer: 'Yes' },
    { id: 'q2', text: 'rating', type: 'rating', options: [] },
  ],
};

function personaFactory(i) {
  return { id: `p${i}`, persona_id: `p${i}`, name: `P${i}` };
}

function answersFor(qualifies) {
  return [
    { question_id: 'q1', answer: qualifies ? 'Yes' : 'No' },
    { question_id: 'q2', answer: 4 },
  ];
}

beforeEach(() => {
  jest.clearAllMocks();
  process.env.RECRUIT_LOOP_ENABLED = 'true';
});

test('100% qualification: target_hit, recruited === qualified === target', async () => {
  let n = 0;
  generatePersonas.mockImplementation(async () => [personaFactory(++n)]);
  simulateResponses.mockImplementation(async () => answersFor(true));
  const supabase = makeSupabase({ spendSequence: [0.01] });

  const r = await runRecruitmentLoop(MISSION, supabase);
  expect(r.terminalStatus).toBe('target_hit');
  expect(r.qualifiedCount).toBe(5);
  expect(r.recruitedCount).toBe(5);
  expect(r.recruitedCount).toBeGreaterThanOrEqual(r.qualifiedCount);
});

test('50% qualification: recruited >= qualified always', async () => {
  let n = 0;
  generatePersonas.mockImplementation(async () => [personaFactory(++n)]);
  simulateResponses.mockImplementation(async () => answersFor(n % 2 === 0));
  const supabase = makeSupabase({ spendSequence: [0.01] });

  const r = await runRecruitmentLoop(MISSION, supabase);
  expect(r.qualifiedCount).toBe(5);
  expect(r.recruitedCount).toBeGreaterThanOrEqual(r.qualifiedCount);
  expect(r.terminalStatus).toBe('target_hit');
});

test('429 burst exhausts retries: status incomplete, NEVER ceiling_hit', async () => {
  let n = 0;
  generatePersonas.mockImplementation(async () => {
    n += 1;
    if (n <= 2) return [personaFactory(n)];          // first 2 personas fine
    const err = new Error('429 rate_limit_error');   // then persistent 429s
    err.status = 429;
    throw err;
  });
  simulateResponses.mockImplementation(async () => answersFor(true));
  const supabase = makeSupabase({ spendSequence: [0.01] }); // spend NOWHERE near ceiling

  const r = await runRecruitmentLoop(MISSION, supabase);
  expect(r.qualifiedCount).toBe(2);
  expect(r.recruitedCount).toBe(2);
  expect(r.terminalStatus).toBe('incomplete');       // NOT ceiling_hit
  expect(r.terminalStatus).not.toBe('ceiling_hit');
  // generatePersonas retried: 2 successes + 3 attempts for the third persona
  expect(generatePersonas.mock.calls.length).toBeGreaterThanOrEqual(5);
  // infra-partial admin alert raised
  const infra = supabase.alerts.filter((a) => a.alert_type === 'recruitment_infra_partial');
  expect(infra.length).toBe(1);
  expect(infra[0].payload.break_reason).toBe('persona_gen_failed');
}, 90000);

test('genuine spend ceiling: status ceiling_hit', async () => {
  let n = 0;
  generatePersonas.mockImplementation(async () => [personaFactory(++n)]);
  simulateResponses.mockImplementation(async () => answersFor(true));
  // First re-read low, then spend exceeds ceiling after 2 qualified.
  const supabase = makeSupabase({ spendSequence: [0.01, 0.5, 3.0] });

  const r = await runRecruitmentLoop(MISSION, supabase);
  expect(r.terminalStatus).toBe('ceiling_hit');
  expect(r.qualifiedCount).toBeLessThan(5);
  expect(r.recruitedCount).toBeGreaterThanOrEqual(r.qualifiedCount);
  // No infra alert for a genuine ceiling
  const infra = supabase.alerts.filter((a) => a.alert_type === 'recruitment_infra_partial');
  expect(infra.length).toBe(0);
});
