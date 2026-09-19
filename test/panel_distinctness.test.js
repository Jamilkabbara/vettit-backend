/**
 * A paid panel must be made of different people.
 *
 * Production: the recruit loop asked the model for one persona at a time with
 * the same prompt and delivered the model's most likely persona on repeat -
 * 239 "Marcus" of 240 (10ecb820), 300 of 300 (0a494ef7), and five
 * "Marcus, 41, London" to a paying customer (bae6613a).
 *
 * The fake model below reproduces the mechanism, not the symptom: what it
 * returns depends only on what the prompt SAYS. Persona id numbers are
 * stripped before it looks, because the real model ignores them (the same
 * Marcus came back under P001..P240). An identical prompt therefore yields an
 * identical person, exactly as a temperature-1.0 model returns its mode.
 *
 * The panel is judged by panelDistinctness.measurePanel, the same rule the
 * live measurement script and the historical audit use.
 */

jest.mock('../src/utils/logger', () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
}));
jest.mock('../src/db/missionSchema', () => ({
  updateMission: jest.fn().mockResolvedValue({}),
  sanitizeMissionPatch: jest.fn((p) => ({ patch: p, rejected: [] })),
  isHeartbeatColumnMissing: jest.fn(() => false),
  noteHeartbeatColumnMissing: jest.fn(() => false),
}));

const mockNames = ['Marcus', 'Layla', 'Omar', 'Sara', 'Ahmed', 'Nour', 'Karim', 'Hana', 'Yusuf', 'Rania',
  'Tariq', 'Mona', 'Faisal', 'Dina', 'Ali', 'Reem', 'Hassan', 'Lina', 'Majid', 'Salma', 'Ziad', 'Aisha',
  'Khalid', 'Noura', 'Samir', 'Huda', 'Walid', 'Maya', 'Bilal', 'Yasmin', 'Adel', 'Farah', 'Rami',
  'Dalia', 'Nabil', 'Leen', 'Fadi', 'Jana', 'Hamza', 'Lama'];
const mockCities = ['Dubai', 'Abu Dhabi', 'Sharjah', 'Al Ain', 'Ajman', 'Ras Al Khaimah', 'Fujairah', 'Umm Al Quwain'];
const mockJobs = ['Teacher', 'Nurse', 'Software engineer', 'Accountant', 'Sales manager', 'Pharmacist',
  'Civil engineer', 'Marketing lead', 'Student', 'Shop owner', 'Consultant', 'Designer', 'Chef',
  'Logistics coordinator', 'HR officer', 'Banker', 'Architect', 'Driver', 'Doctor', 'Journalist'];
const mockHash = (s) => { let h = 2166136261; for (let i = 0; i < s.length; i += 1) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; };

const mockState = { mode: 'compliant', calls: 0 };
jest.mock('../src/services/ai/anthropic', () => ({
  MODEL_ROUTING: {},
  extractJSON: (t) => JSON.parse(t),
  callClaude: jest.fn(async ({ messages }) => {
    mockState.calls += 1;
    const prompt = messages[0].content;
    // What the model "sees": everything except id numbering.
    const seen = prompt.replace(/Starting persona ID index:[^\n]*\n/, '').replace(/P\d{3,}/g, 'P#');
    const h = mockHash(seen);
    const k = Number(prompt.match(/Generate (\d+) synthetic respondents/)[1]);
    // Ids follow the requested numbering (the real model does; it repeats
    // the PERSON, not the id: one Marcus came back as P001..P240).
    const start = Number(prompt.match(/Starting persona ID index: P(\d+)/)[1]);
    const slots = [...prompt.matchAll(/- P\d+: (male|female), age (\d+)/g)].map((m) => ({ gender: m[1], age: Number(m[2]) }));
    const usedLine = prompt.match(/First names already used, do not reuse any: ([^\n]*)/);
    const used = new Set(usedLine ? usedLine[1].split(', ').map((n) => n.toLowerCase()) : []);
    const takenHere = new Set();
    const personas = Array.from({ length: k }, (_, i) => {
      // Within one call a model varies its personas; across identical calls
      // it repeats them. Persona 0 of any call is the model's mode.
      let idx = (h + i * 7) % mockNames.length;
      if (mockState.mode === 'compliant') {
        for (let t = 0; t < mockNames.length && (used.has(mockNames[idx].toLowerCase()) || takenHere.has(idx)); t += 1) {
          idx = (idx + 1) % mockNames.length;
        }
      }
      takenHere.add(idx);
      const slot = slots[i];
      return {
        id: `P${String(start + i).padStart(3, '0')}`,
        first_name: mockNames[idx],
        age: slot ? slot.age : 34,
        gender: slot ? slot.gender : 'male',
        country: 'AE',
        city: mockCities[(h + i * 3) % mockCities.length],
        occupation: mockJobs[((h >>> 5) + i * 11) % mockJobs.length],
      };
    });
    return { text: JSON.stringify({ personas }), costUsd: 0.001 };
  }),
}));

// Answers follow the person: the same person gives the same answers.
jest.mock('../src/services/ai/simulate', () => ({
  simulateAllResponses: jest.fn(),
  passesScreening: () => true,
  simulateResponses: jest.fn(async (persona) => {
    const h = mockHash(`${persona.first_name}|${persona.age}|${persona.city}|${persona.occupation}`);
    return [
      { question_id: 'q1', answer: ['A', 'B', 'C', 'D'][h % 4] },
      { question_id: 'q2', answer: 1 + ((h >>> 4) % 5) },
      { question_id: 'q3', answer: ['Yes', 'No'][(h >>> 9) % 2] },
    ];
  }),
}));

const { measurePanel, allowedNearDuplicates } = require('../src/services/ai/panelDistinctness');
const { generatePersonas } = require('../src/services/ai/personas');
const { runRecruitmentLoop } = require('../src/services/ai/recruitLoop');

function makeSupabase() {
  const rows = [];
  return {
    rows,
    from(table) {
      const chain = {
        select: () => chain, eq: () => chain, update: () => chain, order: () => chain, range: () => chain,
        single: async () => ({ data: { ai_spend_usd_actual: 0, status: 'processing', ai_spend_ceiling_usd: 100 }, error: null }),
        insert: async () => ({ error: null }),
        upsert: async (r) => { if (table === 'mission_responses') rows.push(...[].concat(r)); return { error: null }; },
        then: (resolve) => resolve({ data: table === 'mission_responses' ? [] : null, error: null }),
      };
      return chain;
    },
  };
}

const mission = (target) => ({
  id: `m-${target}`, user_id: 'u', goal_type: 'research', brief: 'Honey imports to the UAE',
  target_qualified_count: target, ai_spend_ceiling_usd: 100,
  targeting: { geography: { countries: ['AE'] }, demographics: { ageRanges: ['25-34', '35-44', '45-54'] } },
  questions: [
    { id: 'q1', text: 'Which brand', type: 'single', options: ['A', 'B', 'C', 'D'] },
    { id: 'q2', text: 'Rate', type: 'rating' },
    { id: 'q3', text: 'Would you buy', type: 'single', options: ['Yes', 'No'] },
  ],
});

function panelFromRows(rows) {
  const personas = new Map(); const answers = {};
  for (const r of rows) {
    personas.set(r.persona_id, r.persona_profile);
    (answers[r.persona_id] = answers[r.persona_id] || {})[r.question_id] = r.answer;
  }
  return measurePanel([...personas.values()], { answersByPersona: answers });
}

beforeEach(() => { mockState.mode = 'compliant'; mockState.calls = 0; process.env.RECRUIT_LOOP_ENABLED = 'true'; });

describe('the measure itself', () => {
  test('Hala-shaped panel (five of one Marcus) fails; a varied panel passes', () => {
    const marcus = Array.from({ length: 5 }, (_, i) => ({ id: `P${i}`, first_name: 'Marcus', age: 41, city: 'London', occupation: i < 4 ? 'Marketing manager' : 'Brand manager' }));
    const bad = measurePanel(marcus);
    expect(bad.pass).toBe(false);
    expect(bad.distinct).toBe(1);
    const good = measurePanel(mockNames.slice(0, 10).map((n, i) => ({ id: `P${i}`, first_name: n, age: 25 + i * 3, city: mockCities[i % 8], occupation: mockJobs[i] })));
    expect(good.pass).toBe(true);
    expect(good.distinct).toBe(10);
  });

  test('two unrelated people who happen to share a common name are not duplicates', () => {
    const r = measurePanel([
      { id: 'a', first_name: 'Mohammed', age: 24, city: 'Riyadh', occupation: 'Student' },
      { id: 'b', first_name: 'Mohammed', age: 51, city: 'Jeddah', occupation: 'Engineer' },
    ]);
    expect(r.nearDuplicates).toBe(0);
  });

  test('threshold scales with n', () => {
    expect([10, 50, 100, 300, 1000].map(allowedNearDuplicates)).toEqual([0, 2, 4, 8, 15]);
  });
});

describe('recruit loop delivers distinct people (production path)', () => {
  test.each([5, 20, 60])('target %i', async (target) => {
    const supabase = makeSupabase();
    const r = await runRecruitmentLoop(mission(target), supabase);
    expect(r.qualifiedCount).toBe(target);
    const m = panelFromRows(supabase.rows);
    expect(m.n).toBe(target);
    expect(m.reasons).toEqual([]);
  });

  test('a model that ignores the "already used" list is still stopped by the clone guard', async () => {
    mockState.mode = 'stubborn';
    const supabase = makeSupabase();
    const r = await runRecruitmentLoop(mission(60), supabase);
    const m = panelFromRows(supabase.rows);
    expect(r.qualifiedCount).toBe(60);
    expect(m.reasons).toEqual([]);
  });
});

describe('batch path delivers distinct people', () => {
  test.each([60, 100])('count %i', async (count) => {
    const personas = await generatePersonas(mission(count), count);
    expect(personas).toHaveLength(count);
    expect(measurePanel(personas).reasons).toEqual([]);
  });
});
