/**
 * The basis check must be WIRED IN, not merely written.
 *
 * Mission 3fc15087's delivered report opened with "purchase intent of 82.5%",
 * which was the Saudi figure (33 of 40) for a study of 80. These tests run the
 * real synthesiser against a model that produces exactly that sentence, and
 * require that what gets stored is the computed summary instead.
 */

jest.mock('../src/utils/logger', () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
}));

const mockState = { text: '' };
jest.mock('../src/services/ai/anthropic', () => ({
  MODEL_ROUTING: {},
  MODEL_PRICING: {},
  callClaude: jest.fn(async () => ({ text: mockState.text, costUsd: 0 })),
  streamClaude: jest.fn(),
  extractJSON: (t) => JSON.parse(String(t).replace(/^```(?:json)?|```$/g, '').trim()),
}));

const logger = require('../src/utils/logger');
const { synthesizeInsights } = require('../src/services/ai/insights');

const QUESTIONS = [{
  id: 'q3',
  text: 'How likely would you be to buy them?',
  type: 'single',
  options: ['Definitely would buy', 'Probably would buy', 'Might or might not', 'Probably would NOT buy', 'Definitely would NOT buy'],
}];

/** The delivered distribution: 3 + 57 of 80 = 75% top-two. */
function responses() {
  const pick = (n, answer) => Array.from({ length: n }, (_, i) => ({
    persona_id: `${answer}-${i}`, question_id: 'q3', answer,
  }));
  return [
    ...pick(3, 'Definitely would buy'),
    ...pick(57, 'Probably would buy'),
    ...pick(1, 'Might or might not'),
    ...pick(16, 'Probably would NOT buy'),
    ...pick(3, 'Definitely would NOT buy'),
  ];
}

const MISSION = {
  id: 'm-basis', user_id: 'u', goal_type: 'market_entry', respondent_count: 80,
  brief: 'Premium plant-based ready-meals in Saudi Arabia and Egypt',
  targeted_markets: 'Saudi Arabia and Egypt',
  questions: QUESTIONS,
};

/** Computed analysis, with the subgroup figure where it belongs. */
const ANALYSIS = {
  methodology: 'market_entry',
  n: 80,
  demand_index: 62,
  purchase_intent_pct: 75,
  by_market: [
    { market: 'Saudi Arabia', n: 40, purchase_intent_pct: 82.5, demand_index: 68 },
    { market: 'Egypt', n: 40, purchase_intent_pct: 67.5, demand_index: 56 },
  ],
};

const modelReturns = (executive_summary, kpis = []) => {
  mockState.text = JSON.stringify({
    executive_summary, kpis, per_question_insights: [], recommendations: [], follow_ups: [], contradictions: [],
  });
};

beforeEach(() => jest.clearAllMocks());

test('the sentence that shipped is not what gets stored', async () => {
  modelReturns('Premium plant-based ready-meals show real demand, scoring a demand index of 62/100 and purchase intent of 82.5%. The category is ready for entry.');

  const out = await synthesizeInsights(MISSION, responses(), ANALYSIS);

  expect(out.executive_summary).not.toContain('82.5');
  expect(out.exec_summary_source).toBe('computed_after_basis_violation');
  expect(logger.error).toHaveBeenCalledWith(
    expect.stringContaining('subgroup figure as the whole study'),
    expect.objectContaining({ missionId: 'm-basis' }),
  );
});

test('the same figure is kept when the sentence says whose it is', async () => {
  const labelled = 'Purchase intent across the study is 75%, and reaches 82.5% among Saudi respondents against 67.5% in Egypt. Entry looks strongest in Saudi Arabia.';
  modelReturns(labelled);

  const out = await synthesizeInsights(MISSION, responses(), ANALYSIS);

  expect(out.executive_summary).toBe(labelled);
  expect(out.exec_summary_source).toBeUndefined();
});

test('a hero tile carrying an unlabelled subgroup figure is dropped', async () => {
  modelReturns('Purchase intent across the study is 75%.', [
    { label: 'Purchase intent', value: '82.5%', trend: 'positive' },
    { label: 'Purchase intent, Saudi Arabia', value: '82.5%', trend: 'positive' },
    { label: 'Purchase intent', value: '75%', trend: 'positive' },
  ]);

  const out = await synthesizeInsights(MISSION, responses(), ANALYSIS);

  const values = out.kpis.map((k) => `${k.label} ${k.value}`);
  expect(values).toContain('Purchase intent 75%');
  expect(values).toContain('Purchase intent, Saudi Arabia 82.5%');
  expect(values).not.toContain('Purchase intent 82.5%');
});

test('a study with no subgroups is untouched', async () => {
  const text = 'Purchase intent is 75% and the category looks viable.';
  modelReturns(text);

  const out = await synthesizeInsights(MISSION, responses(), { methodology: 'market_entry', n: 80, purchase_intent_pct: 75 });

  expect(out.executive_summary).toBe(text);
});
