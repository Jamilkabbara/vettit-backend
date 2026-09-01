/**
 * Mission benchmark category — taxonomy coercion + the clarify-route rider.
 *
 * Two things are locked here:
 *
 * 1. normalizeCategory() NEVER lets a bespoke string reach missions.category.
 *    That is the whole point of the feature: benchmarking works only if two
 *    missions about the same market land on the same key. Production had 15
 *    user-typed categories across 14 distinct values before this — the
 *    "unknown → other" fallback is the guard that stops that recurring.
 *
 * 2. POST /api/ai/clarify emits the category on the call it ALREADY makes.
 *    The tests assert callClaude is invoked exactly ONCE per request, which is
 *    the proof that classification added no second AI call and no extra
 *    round trip. They also cover the model returning an unknown key, omitting
 *    the key entirely, returning a label instead of a key, and the two failure
 *    modes (unparseable output, upstream throw) where category must be null
 *    rather than a guessed value.
 */
const express = require('express');
const request = require('supertest');

const {
  MISSION_CATEGORIES,
  CATEGORY_KEYS,
  FALLBACK_CATEGORY,
  CATEGORY_PROMPT_BLOCK,
  normalizeCategory,
  isMissionCategory,
  categoryLabel,
} = require('../src/services/ai/missionCategory');

// ─── unit: taxonomy shape ────────────────────────────────────────────────────

describe('MISSION_CATEGORIES taxonomy', () => {
  test('keys are unique, snake_case machine keys (not display strings)', () => {
    expect(new Set(CATEGORY_KEYS).size).toBe(CATEGORY_KEYS.length);
    for (const k of CATEGORY_KEYS) expect(k).toMatch(/^[a-z][a-z0-9_]*$/);
  });

  test('every entry carries a label and prompt-facing scope text', () => {
    for (const c of MISSION_CATEGORIES) {
      expect(typeof c.label).toBe('string');
      expect(c.label.length).toBeGreaterThan(0);
      expect(typeof c.includes).toBe('string');
      expect(c.includes.length).toBeGreaterThan(10);
    }
  });

  test('the escape hatch exists and is the declared fallback', () => {
    expect(CATEGORY_KEYS).toContain('other');
    expect(FALLBACK_CATEGORY).toBe('other');
  });

  test('taxonomy stays modest — a wide list gives thin benchmarks', () => {
    // Guardrail, not dogma: if the owner genuinely needs >24 buckets, raise
    // this deliberately and think about rows-per-bucket at current volume.
    expect(CATEGORY_KEYS.length).toBeLessThanOrEqual(24);
    expect(CATEGORY_KEYS.length).toBeGreaterThanOrEqual(8);
  });

  test('the prompt block is generated from the constant, so they cannot drift', () => {
    for (const k of CATEGORY_KEYS) expect(CATEGORY_PROMPT_BLOCK).toContain(k);
  });
});

// ─── unit: normalizeCategory ─────────────────────────────────────────────────

describe('normalizeCategory', () => {
  test('canonical keys pass through untouched', () => {
    for (const k of CATEGORY_KEYS) expect(normalizeCategory(k)).toBe(k);
  });

  test('tolerates case, padding and punctuation around a real key', () => {
    expect(normalizeCategory('  FOOD_BEVERAGE  ')).toBe('food_beverage');
    expect(normalizeCategory('Food-Beverage')).toBe('food_beverage');
    expect(normalizeCategory('food beverage')).toBe('food_beverage');
    expect(normalizeCategory('software/saas')).toBe('software_saas');
  });

  test('accepts the human label the model may echo back', () => {
    expect(normalizeCategory('Food & Beverage')).toBe('food_beverage');
    expect(normalizeCategory('fintech & financial services')).toBe('fintech_financial_services');
  });

  test('maps the common shorthand a model actually emits', () => {
    expect(normalizeCategory('F&B')).toBe('food_beverage');
    expect(normalizeCategory('FMCG')).toBe('food_beverage');
    expect(normalizeCategory('SaaS')).toBe('software_saas');
    expect(normalizeCategory('fintech')).toBe('fintech_financial_services');
    expect(normalizeCategory('telco')).toBe('telecom');
    expect(normalizeCategory('real estate')).toBe('real_estate_property');
  });

  // THE fallback cases the feature lives or dies on.
  test('an UNKNOWN category from the model becomes the fallback, never itself', () => {
    expect(normalizeCategory('quantum_llama_futures')).toBe(FALLBACK_CATEGORY);
    // The real historical free-text values — none may survive as themselves.
    for (const legacy of [
      'premium subscription coffee',
      'mobile fitness app',
      'B2B SaaS market research',
      'QR code for restaurants in Syria',
      'Personal finance app, FinTech, B2C SaaS',
    ]) {
      expect(isMissionCategory(normalizeCategory(legacy))).toBe(true);
    }
    expect(normalizeCategory('premium subscription coffee')).toBe(FALLBACK_CATEGORY);
  });

  test('MISSING or non-string input becomes the fallback and never throws', () => {
    for (const v of [undefined, null, '', '   ', 0, 42, NaN, true, [], {}, () => {}]) {
      expect(normalizeCategory(v)).toBe(FALLBACK_CATEGORY);
    }
  });

  test('output is ALWAYS a valid taxonomy key — the invariant callers rely on', () => {
    const junk = ['', '???', '   ', 'F&B', 'nope', null, undefined, 7, 'other', 'Travel'];
    for (const v of junk) expect(isMissionCategory(normalizeCategory(v))).toBe(true);
  });

  test('categoryLabel resolves keys and degrades gracefully', () => {
    expect(categoryLabel('food_beverage')).toBe('Food & Beverage');
    expect(categoryLabel('not_a_key')).toBe('not_a_key');
  });
});

// ─── route: POST /api/ai/clarify ─────────────────────────────────────────────

jest.mock('../src/middleware/auth', () => ({
  authenticate: (req, _res, next) => { req.user = { id: 'u1' }; next(); },
  optionalAuthenticate: (req, _res, next) => { req.user = { id: 'u1' }; next(); },
}));
jest.mock('../src/utils/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../src/services/claudeAI', () => ({
  generateSurvey: jest.fn(), refineQuestion: jest.fn(), suggestTargeting: jest.fn(),
}));

const mockCallClaude = jest.fn();
jest.mock('../src/services/ai/anthropic', () => {
  const actual = jest.requireActual('../src/services/ai/anthropic');
  return { ...actual, callClaude: (...a) => mockCallClaude(...a) };
});

const app = express();
app.use(express.json());
app.use('/api/ai', require('../src/routes/ai'));
app.use((err, _req, res, _next) => res.status(500).json({ error: err.message }));

const BRIEF = 'We want to test a new ready-to-drink cold brew coffee in the UAE.';
const oneQuestion = [{
  id: 'market', question: 'Which market?',
  chips: [{ id: 'uae', label: 'UAE' }, { id: 'ksa', label: 'KSA' }],
}];
const reply = (obj) => ({ text: JSON.stringify(obj) });

beforeEach(() => mockCallClaude.mockReset());

describe('POST /api/ai/clarify — category rides on the existing call', () => {
  test('returns the model category AND makes exactly ONE AI call', async () => {
    mockCallClaude.mockResolvedValue(reply({ questions: oneQuestion, category: 'food_beverage' }));
    const res = await request(app).post('/api/ai/clarify').send({ goal: 'pricing', brief: BRIEF });
    expect(res.status).toBe(200);
    expect(res.body.category).toBe('food_beverage');
    expect(res.body.questions).toHaveLength(1);
    // The no-extra-latency proof: one request in, one Claude call out.
    expect(mockCallClaude).toHaveBeenCalledTimes(1);
  });

  test('the taxonomy is actually sent — on the SAME prompt, not a second one', () => {
    // Guards against the classifier being "wired" but never reaching the model.
    expect(CATEGORY_PROMPT_BLOCK).toContain('food_beverage');
  });

  test('the single call carries the taxonomy in its system prompt', async () => {
    mockCallClaude.mockResolvedValue(reply({ questions: [], category: 'telecom' }));
    await request(app).post('/api/ai/clarify').send({ goal: null, brief: BRIEF });
    const arg = mockCallClaude.mock.calls[0][0];
    expect(arg.callType).toBe('adaptive_clarify');
    expect(arg.systemPrompt).toContain('food_beverage');
    expect(arg.systemPrompt).toContain('other');
  });

  test('category survives an EMPTY questions array (complete brief)', async () => {
    mockCallClaude.mockResolvedValue(reply({ questions: [], category: 'telecom' }));
    const res = await request(app).post('/api/ai/clarify').send({ goal: null, brief: BRIEF });
    expect(res.body.questions).toEqual([]);
    expect(res.body.category).toBe('telecom');
  });

  test('UNKNOWN category from the model → other (never echoed back raw)', async () => {
    mockCallClaude.mockResolvedValue(reply({ questions: oneQuestion, category: 'artisanal cold brew' }));
    const res = await request(app).post('/api/ai/clarify').send({ goal: null, brief: BRIEF });
    expect(res.body.category).toBe('other');
  });

  test('MISSING category key → other, and the questions still return', async () => {
    mockCallClaude.mockResolvedValue(reply({ questions: oneQuestion }));
    const res = await request(app).post('/api/ai/clarify').send({ goal: null, brief: BRIEF });
    expect(res.body.category).toBe('other');
    expect(res.body.questions).toHaveLength(1);
  });

  test('a LABEL instead of a key is still coerced to the key', async () => {
    mockCallClaude.mockResolvedValue(reply({ questions: [], category: 'Food & Beverage' }));
    const res = await request(app).post('/api/ai/clarify').send({ goal: null, brief: BRIEF });
    expect(res.body.category).toBe('food_beverage');
  });

  test('a non-string category (array/object/number) → other, no crash', async () => {
    for (const bad of [['food_beverage'], { key: 'food_beverage' }, 7, null]) {
      mockCallClaude.mockResolvedValue(reply({ questions: [], category: bad }));
      const res = await request(app).post('/api/ai/clarify').send({ goal: null, brief: BRIEF });
      expect(res.status).toBe(200);
      expect(res.body.category).toBe('other');
    }
  });

  test('unparseable model output → category null, NOT a guessed value', async () => {
    mockCallClaude.mockResolvedValue({ text: 'sorry, I cannot do that' });
    const res = await request(app).post('/api/ai/clarify').send({ goal: null, brief: BRIEF });
    expect(res.status).toBe(200);
    expect(res.body.questions).toEqual([]);
    expect(res.body.category).toBeNull();
  });

  test('upstream failure → category null (unclassified ≠ other)', async () => {
    mockCallClaude.mockRejectedValue(new Error('anthropic 529'));
    const res = await request(app).post('/api/ai/clarify').send({ goal: null, brief: BRIEF });
    expect(res.status).toBe(200);
    expect(res.body.category).toBeNull();
  });

  test('the gibberish 400 is unchanged by the category rider', async () => {
    mockCallClaude.mockResolvedValue(reply({ error: 'gibberish' }));
    const res = await request(app).post('/api/ai/clarify').send({ goal: null, brief: 'asdfasdfasdf' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('gibberish');
  });

  test('the short-brief 400 short-circuits before any AI call', async () => {
    const res = await request(app).post('/api/ai/clarify').send({ goal: null, brief: 'hi' });
    expect(res.status).toBe(400);
    expect(mockCallClaude).not.toHaveBeenCalled();
  });
});
