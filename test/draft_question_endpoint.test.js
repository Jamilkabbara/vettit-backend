/**
 * POST /api/ai/draft-question — HTTP contract.
 *
 * The load-bearing assertion is METADATA ABSENCE. A user-drafted
 * question that carried a methodology tag would be selected by the
 * analysis modules in services/analysis/* (they all bucket by positive
 * tag match — audienceProfiling.js:153 finds attitudinal questions by
 * `kind` + `dimension`, pricing.js:117 finds Van Westendorp bands by
 * `methodology` + `vw_band`, and so on) and would corrupt the
 * customer's numbers. So we assert on the ABSENCE OF EVERY tag by
 * name, and additionally on exact key-set equality so a tag invented
 * after this file was written is caught by the same test.
 *
 * The adversarial case matters most: the model is made to return a
 * fully-tagged question, and the endpoint must still emit a clean one.
 */

jest.mock('../src/utils/logger', () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
}));

// ── Auth: authenticate() stamps a user; optionalAuthenticate is a no-op.
let mockAuthUser = { id: 'user-1' };
jest.mock('../src/middleware/auth', () => ({
  authenticate: (req, res, next) => {
    if (!mockAuthUser) return res.status(401).json({ error: 'unauthenticated' });
    req.user = mockAuthUser;
    next();
  },
  optionalAuthenticate: (req, _res, next) => next(),
}));

// ── Supabase: one missions row, scoped by id + user_id like the route does.
let mockMissionRow = null;
let mockLoadError = null;
const mockSupabaseCalls = [];
jest.mock('../src/db/supabase', () => ({
  from(table) {
    const filters = {};
    const chain = {
      select: () => chain,
      eq: (k, v) => { filters[k] = v; return chain; },
      maybeSingle: async () => {
        mockSupabaseCalls.push({ table, filters: { ...filters } });
        if (mockLoadError) return { data: null, error: mockLoadError };
        const row = mockMissionRow;
        const match = row && row.id === filters.id && row.user_id === filters.user_id;
        return { data: match ? row : null, error: null };
      },
      // If the route ever starts writing, these blow up loudly.
      update: () => { throw new Error('draft-question must not UPDATE'); },
      insert: () => { throw new Error('draft-question must not INSERT'); },
    };
    return chain;
  },
}));

// ── Anthropic: controlled model output.
let mockModelText = '';
let mockModelThrows = null;
const mockClaudeCalls = [];
jest.mock('../src/services/ai/anthropic', () => {
  const actual = jest.requireActual('../src/services/ai/anthropic');
  return {
    ...actual,
    callClaude: jest.fn(async (args) => {
      mockClaudeCalls.push(args);
      if (mockModelThrows) throw mockModelThrows;
      return { text: mockModelText };
    }),
  };
});

// claudeAI is heavy and unrelated to this route — stub it out.
jest.mock('../src/services/claudeAI', () => ({
  generateSurvey: jest.fn(), refineQuestion: jest.fn(),
  suggestTargeting: jest.fn(), analyseResults: jest.fn(),
}));

const express = require('express');
const request = require('supertest');
const aiRouter = require('../src/routes/ai');
const {
  DRAFT_QUESTION_CAP,
  METHODOLOGY_TAG_KEYS,
  DRAFT_QUESTION_KEYS,
  USER_DRAFTED_SOURCE,
} = require('../src/services/ai/draftQuestion');

const app = express();
app.use(express.json());
app.use('/api/ai', aiRouter);

const drafted = (n) => Array.from({ length: n }, (_, i) => ({
  id: `d${i}`, text: `drafted ${i}`, type: 'text', options: [], source: USER_DRAFTED_SOURCE,
}));

function setMission(overrides = {}) {
  mockMissionRow = {
    id: 'mission-1',
    user_id: 'user-1',
    goal_type: 'pricing',
    brief: 'We sell a subscription coffee box and want to understand price sensitivity.',
    title: 'Coffee box pricing',
    questions: [
      { id: 'q1', text: 'Do you drink coffee at home?', type: 'single', options: ['Yes', 'No'], kind: 'screener' },
      { id: 'q2', text: 'At what price is it too expensive?', type: 'text', methodology: 'van_westendorp', vw_band: 'too_expensive' },
    ],
    ...overrides,
  };
}

const post = (body) => request(app).post('/api/ai/draft-question').send(body);
const OK_BODY = { mission_id: 'mission-1', prompt: 'ask how often they reorder' };

beforeEach(() => {
  mockAuthUser = { id: 'user-1' };
  mockLoadError = null;
  mockModelThrows = null;
  mockClaudeCalls.length = 0;
  mockSupabaseCalls.length = 0;
  setMission();
  mockModelText = JSON.stringify({
    text: 'How often do you reorder coffee?',
    type: 'single',
    options: ['Weekly', 'Monthly', 'Rarely'],
  });
});

describe('POST /api/ai/draft-question — success contract', () => {
  test('returns the drafted question with cap accounting and writes nothing', async () => {
    const res = await post(OK_BODY);
    expect(res.status).toBe(200);
    expect(res.body.question.text).toBe('How often do you reorder coffee?');
    expect(res.body.question.type).toBe('single');
    expect(res.body.question.options).toEqual(['Weekly', 'Monthly', 'Rarely']);
    expect(res.body.cap).toBe(DRAFT_QUESTION_CAP);
    expect(res.body.used).toBe(0);
    expect(res.body.remaining).toBe(DRAFT_QUESTION_CAP);
    // The supabase mock throws on update/insert; reaching 200 proves no write.
    expect(mockSupabaseCalls).toEqual([
      { table: 'missions', filters: { id: 'mission-1', user_id: 'user-1' } },
    ]);
  });

  test('carries the positive source marker', async () => {
    const res = await post(OK_BODY);
    expect(res.body.question.source).toBe('user_drafted');
  });

  test('routes through its own call type on the cheap model', async () => {
    await post(OK_BODY);
    expect(mockClaudeCalls).toHaveLength(1);
    expect(mockClaudeCalls[0].callType).toBe('question_draft');
    expect(mockClaudeCalls[0].userId).toBe('user-1');
  });

  test('existing mission questions are given to the model so it does not duplicate one', async () => {
    await post(OK_BODY);
    const prompt = mockClaudeCalls[0].messages[0].content;
    expect(prompt).toContain('Do you drink coffee at home?');
    expect(prompt).toContain('ask how often they reorder');
  });
});

describe('POST /api/ai/draft-question — NO methodology metadata', () => {
  // The adversarial model output: a question wearing every tag the
  // generators emit. None of it may survive.
  const TAGGED = {
    text: 'How often do you reorder coffee?',
    type: 'single',
    options: ['Weekly', 'Monthly'],
    kind: 'attitudinal',
    dimension: 'price_sensitivity',
    methodology: 'van_westendorp',
    funnel_stage: 'consideration',
    kpi_category: 'intent',
    churn_stage: 'reason',
    vw_band: 'too_expensive',
    gg_anchor_index: 2,
    feature_id: 'f3',
    feature_set: ['f1', 'f2'],
    kano_type: 'functional',
    candidate_id: 'c1',
    criterion: 'memorability',
    is_paired_comparison: true,
    is_turf: true,
    is_lift_question: true,
    is_final_choice: true,
    concept_id: 'concept_2',
    brand_id: 'our_brand',
    channel_id: 'ch_tiktok',
    currency: 'USD',
    category: 'food_beverage',
    qualifying_answers: ['Weekly'],
    screening_continue_on: ['Weekly'],
    isScreening: true,
    qualifyingAnswer: 'Weekly',
    // A tag no methodology has shipped yet. A denylist would let this
    // through; the allowlist construction drops it.
    some_future_methodology_tag: 'lands_in_a_bucket',
  };

  test.each(METHODOLOGY_TAG_KEYS)('response omits the %s tag even when the model emits it', async (tag) => {
    mockModelText = JSON.stringify(TAGGED);
    const res = await post(OK_BODY);
    expect(res.status).toBe(200);
    expect(res.body.question).not.toHaveProperty(tag);
  });

  test('response omits screening fields the model tried to set', async () => {
    mockModelText = JSON.stringify(TAGGED);
    const res = await post(OK_BODY);
    expect(res.body.question).not.toHaveProperty('isScreening');
    expect(res.body.question).not.toHaveProperty('qualifyingAnswer');
  });

  test('response omits a tag that does not exist yet (allowlist, not denylist)', async () => {
    mockModelText = JSON.stringify(TAGGED);
    const res = await post(OK_BODY);
    expect(res.body.question).not.toHaveProperty('some_future_methodology_tag');
  });

  test('the key set is EXACTLY the four allowed keys', async () => {
    mockModelText = JSON.stringify(TAGGED);
    const res = await post(OK_BODY);
    expect(Object.keys(res.body.question).sort()).toEqual([...DRAFT_QUESTION_KEYS].sort());
  });

  test('a clean model response also yields exactly the four keys', async () => {
    const res = await post(OK_BODY);
    expect(Object.keys(res.body.question).sort()).toEqual([...DRAFT_QUESTION_KEYS].sort());
  });

  test('tags nested under a "question" wrapper are stripped too', async () => {
    mockModelText = JSON.stringify({ question: TAGGED });
    const res = await post(OK_BODY);
    expect(res.status).toBe(200);
    expect(Object.keys(res.body.question).sort()).toEqual([...DRAFT_QUESTION_KEYS].sort());
  });

  test('a single-element array still yields one stripped question', async () => {
    mockModelText = JSON.stringify([TAGGED]);
    const res = await post(OK_BODY);
    expect(res.status).toBe(200);
    expect(res.body.question.text).toBe('How often do you reorder coffee?');
    expect(Object.keys(res.body.question).sort()).toEqual([...DRAFT_QUESTION_KEYS].sort());
  });

  test('a multi-question response is REFUSED, not silently narrowed to the first', async () => {
    mockModelText = JSON.stringify([TAGGED, { text: 'a second question', type: 'text' }]);
    const res = await post(OK_BODY);
    expect(res.status).toBe(503);
  });
});

describe('POST /api/ai/draft-question — server-side cap', () => {
  test(`allows drafting while under the cap of ${DRAFT_QUESTION_CAP}`, async () => {
    setMission({ questions: [...drafted(DRAFT_QUESTION_CAP - 1)] });
    const res = await post(OK_BODY);
    expect(res.status).toBe(200);
    expect(res.body.used).toBe(DRAFT_QUESTION_CAP - 1);
    expect(res.body.remaining).toBe(1);
  });

  test('409s at the cap, counted from the STORED row', async () => {
    setMission({ questions: drafted(DRAFT_QUESTION_CAP) });
    const res = await post(OK_BODY);
    expect(res.status).toBe(409);
    expect(res.body).toEqual({
      error: 'draft_cap_reached', cap: DRAFT_QUESTION_CAP, used: DRAFT_QUESTION_CAP, remaining: 0,
    });
    // Refused BEFORE any spend.
    expect(mockClaudeCalls).toHaveLength(0);
  });

  test('409s past the cap too (a row that somehow holds more)', async () => {
    setMission({ questions: drafted(DRAFT_QUESTION_CAP + 5) });
    const res = await post(OK_BODY);
    expect(res.status).toBe(409);
    expect(res.body.used).toBe(DRAFT_QUESTION_CAP);
  });

  test('generated questions do not consume the ad-hoc budget', async () => {
    setMission({
      questions: [
        ...Array.from({ length: 14 }, (_, i) => ({ id: `q${i}`, text: `gen ${i}`, kind: 'appeal' })),
        ...drafted(1),
      ],
    });
    const res = await post(OK_BODY);
    expect(res.status).toBe(200);
    expect(res.body.used).toBe(1);
  });

  test('a client reporting the same drafts it already stored is not double-counted', async () => {
    setMission({ questions: drafted(2) });
    const res = await post({ ...OK_BODY, pending_drafts: 2 });
    expect(res.status).toBe(200);
    expect(res.body.used).toBe(2);
    expect(res.body.remaining).toBe(1);
  });

  test('the cap cannot be widened by the client', async () => {
    setMission({ questions: drafted(DRAFT_QUESTION_CAP) });
    for (const pending of [-99, -1, 0, '0', null, undefined, NaN, 'lots']) {
      const res = await post({ ...OK_BODY, pending_drafts: pending });
      expect(res.status).toBe(409);
    }
  });

  test('pending_drafts can only tighten the cap (covers the unflushed-save window)', async () => {
    setMission({ questions: [] });
    const res = await post({ ...OK_BODY, pending_drafts: DRAFT_QUESTION_CAP });
    expect(res.status).toBe(409);
    expect(mockClaudeCalls).toHaveLength(0);
  });

  test('a mission with no questions at all starts with a full budget', async () => {
    setMission({ questions: null });
    const res = await post(OK_BODY);
    expect(res.status).toBe(200);
    expect(res.body.used).toBe(0);
  });
});

describe('POST /api/ai/draft-question — auth, ownership, validation', () => {
  test('401 without a user', async () => {
    mockAuthUser = null;
    const res = await post(OK_BODY);
    expect(res.status).toBe(401);
    expect(mockClaudeCalls).toHaveLength(0);
  });

  test("404 (not 403) for someone else's mission, so ids cannot be probed", async () => {
    mockAuthUser = { id: 'user-2' };
    const res = await post(OK_BODY);
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'mission_not_found' });
    expect(mockClaudeCalls).toHaveLength(0);
  });

  test('404 for a mission that does not exist', async () => {
    const res = await post({ ...OK_BODY, mission_id: 'nope' });
    expect(res.status).toBe(404);
  });

  test('400 without mission_id', async () => {
    const res = await post({ prompt: 'something' });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'mission_id_required' });
  });

  test('400 on an empty or too-short prompt', async () => {
    for (const prompt of ['', '  ', 'ab', 42, null, undefined]) {
      const res = await post({ mission_id: 'mission-1', prompt });
      expect(res.status).toBe(400);
    }
    expect(mockClaudeCalls).toHaveLength(0);
  });

  test('the mission is loaded scoped to the caller, never unscoped', async () => {
    await post(OK_BODY);
    expect(mockSupabaseCalls[0].filters.user_id).toBe('user-1');
  });
});

describe('POST /api/ai/draft-question — degraded upstream', () => {
  test('503 when the model throws', async () => {
    mockModelThrows = new Error('anthropic exploded');
    const res = await post(OK_BODY);
    expect(res.status).toBe(503);
    expect(res.body).toEqual({ error: 'draft_unavailable' });
  });

  test('503 on unparseable model output', async () => {
    mockModelText = 'I am terribly sorry but I cannot do that.';
    const res = await post(OK_BODY);
    expect(res.status).toBe(503);
  });

  test('503 when the model returns a question with no usable text', async () => {
    mockModelText = JSON.stringify({ text: '', type: 'single', options: ['a', 'b'] });
    const res = await post(OK_BODY);
    expect(res.status).toBe(503);
  });

  test('503 when the mission row cannot be read', async () => {
    mockLoadError = { code: '500', message: 'db down' };
    const res = await post(OK_BODY);
    expect(res.status).toBe(503);
  });
});
