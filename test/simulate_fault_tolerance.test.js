/*
 * Batch-path fault tolerance for services/ai/simulate.js#simulateAllResponses.
 *
 * THE BUG THESE PIN: the wave barrier was `await Promise.all(wave)` with no
 * per-persona try/catch, so ONE failed Anthropic call (a 429, a 529, a
 * timeout) rejected the whole wave, propagated through jobs/runMission.js
 * into the fatal handler, and marked a PAID mission `failed`. Nothing is
 * persisted incrementally on this path, so the customer lost the entire run.
 *
 * MUTATION CHECK: every test in the first three describe blocks fails when
 * `Promise.allSettled` is reverted to `Promise.all` (or when the honest
 * counters / failure ceiling are removed). See the PR body for the numbers.
 */

jest.mock('../src/utils/logger', () => ({
  info: () => {}, warn: () => {}, error: () => {}, debug: () => {},
}));

// Mock the single Anthropic entry point simulateResponses uses, so we drive
// per-persona success/failure deterministically without touching the API.
const mockCallClaude = jest.fn();
jest.mock('../src/services/ai/anthropic', () => ({
  callClaude: (...args) => mockCallClaude(...args),
  extractJSON: jest.requireActual('../src/services/ai/anthropic').extractJSON,
}));

const {
  simulateAllResponses,
  MAX_SIMULATION_FAILURE_RATIO,
  SIM_RECOVERY_SWEEPS,
} = require('../src/services/ai/simulate');

// ── Fixtures ─────────────────────────────────────────────────────────
const QUESTIONS = [
  { id: 'q1', type: 'single', text: 'Would you buy it?', options: ['Yes', 'No'] },
  { id: 'q2', type: 'rating', text: 'How likely?', options: [1, 2, 3, 4, 5] },
];

const MISSION = { id: 'mission-fault-tol', user_id: 'user-1', goal_type: 'validate', brief: 'b' };

function makePersonas(n) {
  return Array.from({ length: n }, (_, i) => ({
    id: `p${i + 1}`, persona_id: `p${i + 1}`, name: `Persona ${i + 1}`, age: 30 + i,
  }));
}

function goodBody() {
  return JSON.stringify({
    responses: [
      { question_id: 'q1', answer: 'Yes', reasoning: 'because' },
      { question_id: 'q2', answer: 4, reasoning: 'because' },
    ],
  });
}

/** Extract the persona id from the prompt so the mock can decide per persona. */
function personaIdFromArgs(args) {
  const prompt = args.messages[0].content;
  const m = prompt.match(/"persona_id":\s*"([^"]+)"/) || prompt.match(/"id":\s*"([^"]+)"/);
  return m ? m[1] : null;
}

function apiError(status, message) {
  const e = new Error(message);
  e.status = status;
  e.name = 'APIError';
  return e;
}

/**
 * Program the mock: `failing` is a Map personaId -> number of times that
 * persona should throw before it starts succeeding. Infinity = always fails.
 */
function programClaude(failing) {
  const seen = new Map();
  mockCallClaude.mockImplementation(async (args) => {
    const pid = personaIdFromArgs(args);
    const budget = failing.get(pid);
    if (budget !== undefined) {
      const used = seen.get(pid) || 0;
      if (used < budget) {
        seen.set(pid, used + 1);
        throw apiError(429, `rate_limit_error for ${pid}`);
      }
    }
    return { text: goodBody() };
  });
}

beforeEach(() => { mockCallClaude.mockReset(); });

// ─────────────────────────────────────────────────────────────────────
describe('one persona failing does not kill the wave or the mission', () => {
  test('a permanently-failing persona is dropped; the other 7 in its wave survive', async () => {
    // 8 personas = exactly ONE wave at CONCURRENCY=8, so a single rejection
    // is the whole wave under Promise.all.
    const personas = makePersonas(8);
    programClaude(new Map([['p3', Infinity]]));

    const res = await simulateAllResponses(personas, QUESTIONS, MISSION);

    expect(res.attempted).toBe(8);
    expect(res.succeeded).toBe(7);
    expect(res.failed).toBe(1);
    expect(res.failedPersonaIds).toEqual(['p3']);
    // 7 surviving personas x 2 questions
    expect(res.responses).toHaveLength(14);
    expect(new Set(res.responses.map((r) => r.persona_id)))
      .toEqual(new Set(['p1', 'p2', 'p4', 'p5', 'p6', 'p7', 'p8']));
  });

  test('failures in DIFFERENT waves are all tolerated', async () => {
    const personas = makePersonas(20); // 3 waves at CONCURRENCY=8
    programClaude(new Map([['p1', Infinity], ['p12', Infinity], ['p20', Infinity]]));

    const res = await simulateAllResponses(personas, QUESTIONS, MISSION);

    expect(res.failed).toBe(3);
    expect(res.succeeded).toBe(17);
    expect(res.failedPersonaIds.sort()).toEqual(['p1', 'p12', 'p20']);
    expect(res.responses).toHaveLength(34);
  });

  test('the failure record carries missionId-diagnosable context', async () => {
    const personas = makePersonas(8);
    programClaude(new Map([['p5', Infinity]]));

    const res = await simulateAllResponses(personas, QUESTIONS, MISSION);

    expect(res.failures).toHaveLength(1);
    expect(res.failures[0]).toMatchObject({
      personaId: 'p5',
      status: 429,
      name: 'APIError',
    });
    expect(res.failures[0].message).toContain('rate_limit_error');
  });

  test('a persona that returns zero parseable responses is a failure, not a phantom respondent', async () => {
    // Mirrors recruitLoop's zero-response guard. simulateResponses swallows
    // parse errors and returns [], so without the guard this persona would
    // contribute 0 rows while still counting toward the delivered n.
    const personas = makePersonas(10);
    mockCallClaude.mockImplementation(async (args) => {
      const pid = personaIdFromArgs(args);
      if (pid === 'p2') return { text: 'not json at all' };
      return { text: goodBody() };
    });

    const res = await simulateAllResponses(personas, QUESTIONS, MISSION);

    expect(res.failed).toBe(1);
    expect(res.failedPersonaIds).toEqual(['p2']);
    expect(res.succeeded).toBe(9);
    expect(res.responses).toHaveLength(18);
    expect(res.responses.some((r) => r.persona_id === 'p2')).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────
describe('the delivered count is honest', () => {
  test('succeeded + failed === attempted, and succeeded matches distinct persona ids in rows', async () => {
    const personas = makePersonas(10);
    programClaude(new Map([['p4', Infinity], ['p9', Infinity]]));

    const res = await simulateAllResponses(personas, QUESTIONS, MISSION);

    expect(res.succeeded + res.failed).toBe(res.attempted);
    const distinct = new Set(res.responses.map((r) => r.persona_id)).size;
    expect(distinct).toBe(res.succeeded);
    // The number the customer would see must be 8, never the paid-for 10.
    expect(distinct).toBe(8);
    expect(res.failureRatio).toBeCloseTo(0.2, 5);
  });

  test('a fully clean run reports zero failures and the full n', async () => {
    const personas = makePersonas(12);
    programClaude(new Map());

    const res = await simulateAllResponses(personas, QUESTIONS, MISSION);

    expect(res.failed).toBe(0);
    expect(res.failedPersonaIds).toEqual([]);
    expect(res.succeeded).toBe(12);
    expect(new Set(res.responses.map((r) => r.persona_id)).size).toBe(12);
  });

  test('the deferred recovery sweep recovers a transient failure so n stays whole', async () => {
    // p6 fails its FIRST attempt only. One end-of-run sweep should recover it,
    // and the delivered count must then be the full 8 with zero reported loss.
    const personas = makePersonas(8);
    programClaude(new Map([['p6', 1]]));

    const res = await simulateAllResponses(personas, QUESTIONS, MISSION);

    expect(SIM_RECOVERY_SWEEPS).toBeGreaterThanOrEqual(1);
    expect(res.failed).toBe(0);
    expect(res.succeeded).toBe(8);
    expect(new Set(res.responses.map((r) => r.persona_id)).size).toBe(8);
    expect(res.responses.filter((r) => r.persona_id === 'p6')).toHaveLength(2);
  });
});

// ─────────────────────────────────────────────────────────────────────
describe('the many-failures threshold', () => {
  test('exactly at the ceiling still delivers (partial, honest)', async () => {
    // 10 personas, 2 failures = 0.20 exactly. Strictly-greater-than ceiling.
    expect(MAX_SIMULATION_FAILURE_RATIO).toBe(0.2);
    const personas = makePersonas(10);
    programClaude(new Map([['p1', Infinity], ['p2', Infinity]]));

    const res = await simulateAllResponses(personas, QUESTIONS, MISSION);

    expect(res.failureRatio).toBeCloseTo(0.2, 5);
    expect(res.failed).toBe(2);
    expect(res.succeeded).toBe(8);
  });

  test('one persona past the ceiling throws SIMULATION_FAILURE_THRESHOLD', async () => {
    // 10 personas, 3 failures = 0.30 > 0.20.
    const personas = makePersonas(10);
    programClaude(new Map([['p1', Infinity], ['p2', Infinity], ['p3', Infinity]]));

    await expect(simulateAllResponses(personas, QUESTIONS, MISSION))
      .rejects.toMatchObject({
        code: 'SIMULATION_FAILURE_THRESHOLD',
        attempted: 10,
        failed: 3,
        succeeded: 7,
      });
  });

  test('55 of 60 lost is a FAILED mission, not a success with n=5', async () => {
    const personas = makePersonas(60);
    const failing = new Map();
    for (let i = 1; i <= 55; i += 1) failing.set(`p${i}`, Infinity);
    programClaude(failing);

    await expect(simulateAllResponses(personas, QUESTIONS, MISSION))
      .rejects.toThrow(/refusing to deliver a gutted sample/);
  });

  test('1 of 60 lost is a partial delivery, not a failed mission', async () => {
    const personas = makePersonas(60);
    programClaude(new Map([['p30', Infinity]]));

    const res = await simulateAllResponses(personas, QUESTIONS, MISSION);

    expect(res.failed).toBe(1);
    expect(res.succeeded).toBe(59);
    expect(new Set(res.responses.map((r) => r.persona_id)).size).toBe(59);
  });
});

// ─────────────────────────────────────────────────────────────────────
describe('a wave where ALL personas fail still behaves sanely', () => {
  test('every persona failing throws the threshold error rather than hanging or returning empty', async () => {
    const personas = makePersonas(8);
    const failing = new Map(personas.map((p) => [p.id, Infinity]));
    programClaude(failing);

    await expect(simulateAllResponses(personas, QUESTIONS, MISSION))
      .rejects.toMatchObject({
        code: 'SIMULATION_FAILURE_THRESHOLD',
        attempted: 8,
        succeeded: 0,
        failed: 8,
      });
  });

  test('an empty persona list is a no-op, not a divide-by-zero abort', async () => {
    const res = await simulateAllResponses([], QUESTIONS, MISSION);
    expect(res).toMatchObject({
      responses: [], attempted: 0, succeeded: 0, failed: 0, failureRatio: 0,
    });
  });
});

// ─────────────────────────────────────────────────────────────────────
describe('failedPersonaIds key contract (what runMission prunes on)', () => {
  // jobs/runMission.js prunes the persona array with EXACTLY this expression
  // before deriving total_simulated_count / qualified_respondent_count /
  // qualification_rate / recruited_persona_count. If the key convention here
  // ever drifts from that expression the prune silently no-ops and all four
  // columns go back to claiming the paid-for N. This pins the contract.
  const runMissionPrune = (personas, failedPersonaIds) => {
    const lost = new Set(failedPersonaIds);
    return personas.filter((p, i) => !lost.has(p.persona_id || p.id || `idx:${i}`));
  };

  test('personas carrying persona_id + id prune correctly', async () => {
    const personas = makePersonas(10);
    programClaude(new Map([['p4', Infinity]]));
    const res = await simulateAllResponses(personas, QUESTIONS, MISSION);

    const kept = runMissionPrune(personas, res.failedPersonaIds);
    expect(kept).toHaveLength(res.succeeded);
    expect(kept.map((p) => p.id)).not.toContain('p4');
  });

  test('personas carrying only `id` prune correctly', async () => {
    const personas = makePersonas(10).map(({ persona_id, ...rest }) => rest);
    programClaude(new Map([['p7', Infinity]]));
    const res = await simulateAllResponses(personas, QUESTIONS, MISSION);

    expect(res.failedPersonaIds).toEqual(['p7']);
    const kept = runMissionPrune(personas, res.failedPersonaIds);
    expect(kept).toHaveLength(9);
    expect(kept.map((p) => p.id)).not.toContain('p7');
  });

  test('idless personas fall back to a positional key that still prunes', async () => {
    // Defensive: a truncated generation can hand back objects with no id.
    // The positional fallback must not prune the WRONG persona (or none).
    const personas = Array.from({ length: 10 }, (_, i) => ({ name: `anon${i}` }));
    // No id in the prompt, so nothing matches the failing map; force one
    // failure by index via call order-independent content matching instead.
    mockCallClaude.mockImplementation(async (args) => {
      if (args.messages[0].content.includes('anon5')) throw apiError(529, 'overloaded');
      return { text: goodBody() };
    });

    const res = await simulateAllResponses(personas, QUESTIONS, MISSION);

    expect(res.failed).toBe(1);
    expect(res.failedPersonaIds).toEqual(['idx:5']);
    const kept = runMissionPrune(personas, res.failedPersonaIds);
    expect(kept).toHaveLength(9);
    expect(kept.map((p) => p.name)).not.toContain('anon5');
  });
});

// ─────────────────────────────────────────────────────────────────────
describe('enforceFailureCeiling:false (the screener-replacement top-up path)', () => {
  test('a tiny replacement batch losing 50% reports honestly but does NOT throw', async () => {
    // runMission generates replacements for screened-out personas in batches
    // of 1-2. Any loss there is >20% by arithmetic; failing the whole mission
    // over a top-up blip, when the MAIN batch is healthy, would be a
    // regression, not a fix.
    const personas = makePersonas(2);
    programClaude(new Map([['p1', Infinity]]));

    const res = await simulateAllResponses(
      personas, QUESTIONS, MISSION, () => {}, { enforceFailureCeiling: false },
    );

    expect(res.failed).toBe(1);
    expect(res.succeeded).toBe(1);
    expect(res.failureRatio).toBeCloseTo(0.5, 5);
    expect(res.responses).toHaveLength(2);
  });

  test('the ceiling is ON by default (omitted options must not disable it)', async () => {
    const personas = makePersonas(2);
    programClaude(new Map([['p1', Infinity]]));
    await expect(simulateAllResponses(personas, QUESTIONS, MISSION))
      .rejects.toMatchObject({ code: 'SIMULATION_FAILURE_THRESHOLD' });
  });
});
