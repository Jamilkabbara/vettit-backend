/**
 * Pass 49 PR 2 — mid-run abort (the kill switch).
 *
 * THE GAP
 * -------
 * Nothing in the mission pipeline ever asked "is my claim still valid?".
 * runMission takes an atomic paid→processing claim at the top and then
 * runs for hours without rechecking it. So a mission that missionRecovery
 * Job 1 auto-failed at the 6h mark — or that an admin force-completed, or
 * that a second concurrent run already finished — kept recruiting personas
 * and burning real Anthropic spend against a row nobody would ever read.
 * PR 1 stops the zombie's terminal WRITE; PR 2 stops the zombie.
 *
 * COST
 * ----
 * Zero extra queries on the recruit-loop path: recruitLoop.js already
 * re-reads the mission every iteration for ai_spend_usd_actual, so
 * `status` simply joins that projection. The legacy batch path has no such
 * read, so it does a throttled one on the every-25-personas cadence the
 * progress log already uses (~40 single-row reads across a 1000-respondent
 * run), latched into a boolean that shouldAbort reads at wave boundaries.
 *
 * THE BREAK MUST BE CLEAN
 * -----------------------
 * The loop exits like a ceiling hit — partial work kept, reported
 * honestly. It must NOT throw: a throw lands in runMission's fatal
 * handler, which would try to write 'failed' over whatever terminal state
 * the other writer just set. That is the exact clobber PR 1 exists to
 * prevent, so PR 2 must not reintroduce it through the back door. Several
 * tests below assert precisely that.
 *
 * FAIL OPEN, NOT CLOSED
 * ---------------------
 * A missed abort costs money. A false abort kills a paid mission. So the
 * guard fires only on a successful read that actually returned a status
 * other than 'processing'; a read error or an absent column keeps running.
 *
 * MUTATION CHECK: recorded in the PR body.
 */

jest.mock('../src/services/ai/personas', () => ({ generatePersonas: jest.fn() }));
jest.mock('../src/services/ai/simulate', () => {
  const actual = jest.requireActual('../src/services/ai/simulate');
  return {
    ...actual,
    simulateResponses: jest.fn(),
    simulateAllResponses: jest.fn(),
  };
});
jest.mock('../src/db/missionSchema', () => ({
  updateMission: jest.fn().mockResolvedValue({ matched: 1 }),
  sanitizeMissionPatch: jest.fn((p) => ({ patch: p, rejected: [] })),
  // Pass 49 — heartbeat_at availability latch (migration applied by hand).
  isHeartbeatColumnMissing: jest.fn(() => false),
  noteHeartbeatColumnMissing: jest.fn(() => false),
}));
jest.mock('../src/utils/logger', () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
}));
// The batch-path tests exercise the REAL simulateAllResponses, whose call to
// simulateResponses is intra-module and therefore not interceptable by the
// simulate mock above. Stubbing the model call is the seam that works.
jest.mock('../src/services/ai/anthropic', () => ({
  callClaude: jest.fn(async () => ({
    text: JSON.stringify({ responses: [{ question_id: 'q1', answer: 'a', reasoning: null }] }),
    costUsd: 0, inputTokens: 0, outputTokens: 0, latencyMs: 1, model: 'test',
  })),
  streamClaude: jest.fn(),
  extractJSON: (t) => JSON.parse(String(t).replace(/^```(?:json)?|```$/g, '').trim()),
  MODEL_ROUTING: {},
  MODEL_PRICING: {},
}));

const { generatePersonas } = require('../src/services/ai/personas');
const { simulateResponses } = require('../src/services/ai/simulate');
const { updateMission } = require('../src/db/missionSchema');
const logger = require('../src/utils/logger');
const { runRecruitmentLoop } = require('../src/services/ai/recruitLoop');

const MISSION_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

const mission = (over = {}) => ({
  id: MISSION_ID,
  user_id: 'user-1',
  title: 'kill switch',
  goal_type: 'research',
  target_qualified_count: 5,
  ai_spend_ceiling_usd: 100,
  ai_spend_usd_actual: 0,
  questions: [{ id: 'q1', text: 'Why?', type: 'open_ended' }],
  ...over,
});

/**
 * Supabase stub whose mission re-read returns a scripted status sequence,
 * so a test can say "healthy for two iterations, then the reaper wins".
 */
function makeSupabase({ statusSequence = [], readError = null } = {}) {
  let readIdx = 0;
  const inserts = { mission_responses: [], admin_alerts: [] };
  const readsSeen = [];
  return {
    inserts,
    readsSeen,
    from(table) {
      const chain = {
        select: () => chain,
        eq: () => chain,
        order: () => chain,
        range: () => chain,
        update: () => chain,
        single: async () => {
          if (readError) return { data: null, error: readError };
          const step = statusSequence[Math.min(readIdx, statusSequence.length - 1)] ?? {};
          readIdx += 1;
          readsSeen.push(step);
          return { data: { ai_spend_usd_actual: 0, ...step }, error: null };
        },
        insert: async (rows) => {
          (inserts[table] || (inserts[table] = [])).push(...(Array.isArray(rows) ? rows : [rows]));
          return { error: null };
        },
        upsert: async (rows) => {
          (inserts[table] || (inserts[table] = [])).push(...(Array.isArray(rows) ? rows : [rows]));
          return { error: null };
        },
        then: (resolve) => resolve({
          data: table === 'mission_responses' ? [] : null, error: null,
        }),
      };
      return chain;
    },
  };
}

/** Every generated persona qualifies, one answer each. */
function wireQualifyingPersonas() {
  let n = 0;
  generatePersonas.mockImplementation(async (_m, count) =>
    Array.from({ length: count }, () => ({ id: `p${++n}` })));
  simulateResponses.mockImplementation(async () => [{ question_id: 'q1', answer: 'yes', reasoning: null }]);
}

beforeEach(() => { jest.clearAllMocks(); });

// ═══ recruit-loop path ═════════════════════════════════════════════════════

describe('recruitLoop mid-run abort', () => {
  test('the status read rides on the EXISTING projection — no extra query per iteration', () => {
    const src = require('fs').readFileSync(
      require.resolve('../src/services/ai/recruitLoop'), 'utf8');
    // One combined projection, and no second .from('missions') read inside
    // the loop. If someone adds a dedicated status query later, this fails.
    expect(src).toContain("select('ai_spend_usd_actual, status')");
    expect(src).not.toContain("select('status')");
  });

  test('a mission that leaves processing mid-run stops the loop', async () => {
    const supabase = makeSupabase({
      statusSequence: [
        { status: 'processing' },
        { status: 'processing' },
        { status: 'failed' },        // the reaper wins here
      ],
    });
    wireQualifyingPersonas();

    const res = await runRecruitmentLoop(mission(), supabase);

    expect(res.claimRevoked).toBe(true);
    expect(res.breakReason).toBe('claim_revoked');
    // It stopped early: target was 5, it never got there.
    expect(res.qualifiedCount).toBeLessThan(5);
    expect(res.partial).toBe(true);
  });

  test('the partial work is KEPT and reported honestly, not discarded', async () => {
    const supabase = makeSupabase({
      statusSequence: [
        { status: 'processing' }, { status: 'processing' }, { status: 'processing' },
        { status: 'completed' },
      ],
    });
    wireQualifyingPersonas();

    const res = await runRecruitmentLoop(mission(), supabase);

    expect(res.qualifiedCount).toBe(3);
    expect(res.responses).toHaveLength(3);
    expect(res.recruitedCount).toBe(3);
    // Rows generated before the abort were still persisted incrementally.
    expect(supabase.inserts.mission_responses).toHaveLength(3);
  });

  test('it BREAKS, it does not throw — the fatal handler must never see this', async () => {
    const supabase = makeSupabase({ statusSequence: [{ status: 'failed' }] });
    wireQualifyingPersonas();

    await expect(runRecruitmentLoop(mission(), supabase)).resolves.toBeDefined();
  });

  test("an abort is NOT labelled 'ceiling_hit' — it is not a budget event", async () => {
    const supabase = makeSupabase({
      statusSequence: [{ status: 'processing' }, { status: 'failed' }],
    });
    wireQualifyingPersonas();

    const res = await runRecruitmentLoop(mission(), supabase);

    expect(res.terminalStatus).toBe('incomplete');
    expect(res.terminalStatus).not.toBe('ceiling_hit');
  });

  test('an abort does not raise the infra-partial alert (nothing to re-run)', async () => {
    const supabase = makeSupabase({
      statusSequence: [{ status: 'processing' }, { status: 'failed' }],
    });
    wireQualifyingPersonas();

    await runRecruitmentLoop(mission(), supabase);

    expect(supabase.inserts.admin_alerts.map((a) => a.alert_type))
      .not.toContain('recruitment_infra_partial');
  });

  test("the aborting loop's own bookkeeping write is status-scoped too", async () => {
    const supabase = makeSupabase({
      statusSequence: [{ status: 'processing' }, { status: 'failed' }],
    });
    wireQualifyingPersonas();

    await runRecruitmentLoop(mission(), supabase);

    const terminal = updateMission.mock.calls.find(
      ([, , , opts]) => opts && String(opts.caller).startsWith('recruitLoop: terminal='));
    expect(terminal).toBeDefined();
    expect(terminal[3].scope).toEqual({ status: 'processing' });
  });

  test('FAILS OPEN on a read error — a transient blip must not kill a paid mission', async () => {
    const supabase = makeSupabase({ readError: { message: 'network reset' } });
    wireQualifyingPersonas();

    const res = await runRecruitmentLoop(mission(), supabase);

    expect(res.claimRevoked).toBe(false);
    expect(res.qualifiedCount).toBe(5);
    expect(res.terminalStatus).toBe('target_hit');
  });

  test('FAILS OPEN when the projection returns no status at all', async () => {
    const supabase = makeSupabase({ statusSequence: [{}] });   // no `status` key
    wireQualifyingPersonas();

    const res = await runRecruitmentLoop(mission(), supabase);

    expect(res.claimRevoked).toBe(false);
    expect(res.terminalStatus).toBe('target_hit');
  });

  test('a healthy run is untouched — status stays processing throughout', async () => {
    const supabase = makeSupabase({ statusSequence: [{ status: 'processing' }] });
    wireQualifyingPersonas();

    const res = await runRecruitmentLoop(mission(), supabase);

    expect(res.claimRevoked).toBe(false);
    expect(res.qualifiedCount).toBe(5);
    expect(res.terminalStatus).toBe('target_hit');
    expect(logger.error).not.toHaveBeenCalledWith(
      expect.stringContaining('ABORTING'), expect.anything());
  });
});

// ═══ legacy batch path — simulateAllResponses ══════════════════════════════

describe('simulateAllResponses shouldAbort', () => {
  const { simulateAllResponses } = jest.requireActual('../src/services/ai/simulate');

  const personas = Array.from({ length: 40 }, (_, i) => ({ id: `p${i}` }));
  const questions = [{ id: 'q1', text: 'Why?', type: 'open_ended' }];

  test('stops at the next wave boundary and returns the partial rows', async () => {
    let seen = 0;
    const out = await simulateAllResponses(personas, questions, { id: MISSION_ID },
      () => { seen += 1; },
      // Abort once the first wave (CONCURRENCY = 8) has finished.
      { shouldAbort: () => seen >= 8 });

    expect(out.responses.length).toBeGreaterThan(0);
    expect(out.responses.length).toBeLessThan(personas.length);
    // Nothing in flight was discarded: the first wave completed in full.
    expect(out.responses).toHaveLength(8);
    // ...and the honest counters agree with the rows actually produced.
    expect(out.succeeded).toBe(8);
  });

  test('aborting returns — it never throws', async () => {
    const r = await simulateAllResponses(
      personas, questions, { id: MISSION_ID }, () => {}, { shouldAbort: () => true },
    );
    expect(r.responses).toEqual([]);
  });

  // PR #109 computes succeeded as attempted - failed, which silently assumes
  // every persona RAN. An abort breaks that assumption: personas past the
  // break point never ran, so they are neither failed nor succeeded. Without
  // the abort-aware count this returned succeeded=40 alongside zero response
  // rows, and runMission derives its delivery columns from these counters -
  // it would have reported 40 respondents delivered on a run that produced
  // nothing.
  test('an aborted run never reports un-run personas as succeeded', async () => {
    const r = await simulateAllResponses(
      personas, questions, { id: MISSION_ID }, () => {}, { shouldAbort: () => true },
    );
    expect(r.attempted).toBe(personas.length);
    expect(r.responses).toHaveLength(0);
    expect(r.succeeded).toBe(0);
    expect(r.failed).toBe(0);
  });

  test('a partial abort reports only the personas that produced rows', async () => {
    let waves = 0;
    const r = await simulateAllResponses(
      personas, questions, { id: MISSION_ID }, () => {}, { shouldAbort: () => waves++ >= 1 },
    );
    const distinct = new Set(r.responses.map((x) => x.persona_id)).size;
    expect(r.succeeded).toBe(distinct);
    expect(r.succeeded).toBeLessThan(personas.length);
    expect(r.succeeded).toBeGreaterThan(0);
  });

  test('without shouldAbort the behaviour is exactly as before', async () => {
    const r = await simulateAllResponses(personas, questions, { id: MISSION_ID }, () => {});
    expect(r.responses).toHaveLength(40);
    expect(r.succeeded).toBe(40);
    expect(r.failed).toBe(0);
  });
});
