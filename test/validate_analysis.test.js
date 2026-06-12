/**
 * Pass 46 Phase 3 — validate (concept test) module, hand-computed
 * fixtures. The battery mirrors VALIDATE_SURVEY_GEN_SYSTEM exactly
 * (src/services/claudeAI.js:1060-1069): funnel_stage tags
 * screener|reaction|relevance|uniqueness|believability|intent|
 * qualitative|price_fairness (price question present because the
 * fixture concept carries a price).
 */

const { computeValidate } = require('../src/services/analysis/validate');

const QUESTIONS = [
  { id: 'q1', text: 'Do you buy snacks at least monthly?', type: 'single', options: ['Yes, regularly', 'Occasionally', 'Never'], isScreening: true, qualifying_answers: ['Yes, regularly', 'Occasionally'], methodology: 'concept_test', funnel_stage: 'screener' },
  { id: 'q2', text: 'What is your overall reaction to this concept?', type: 'rating', options: [], methodology: 'concept_test', funnel_stage: 'reaction' },      // 1-10, claudeAI.js:1061
  { id: 'q3', text: 'How relevant is this concept to your needs?', type: 'rating', options: [], methodology: 'concept_test', funnel_stage: 'relevance' },        // 1-7, claudeAI.js:1062
  { id: 'q4', text: 'How different is this from other snack options?', type: 'rating', options: [], methodology: 'concept_test', funnel_stage: 'uniqueness' },   // 1-7, claudeAI.js:1063
  { id: 'q5', text: 'How believable are the claims about this concept?', type: 'rating', options: [], methodology: 'concept_test', funnel_stage: 'believability' }, // 1-7, claudeAI.js:1064
  // Intent options verbatim from claudeAI.js:1065
  { id: 'q6', text: 'If this were available at $5, how likely would you be to buy?', type: 'single', options: ['Definitely would buy', 'Probably would buy', 'Might or might not', 'Probably would NOT buy', 'Definitely would NOT buy'], methodology: 'concept_test', funnel_stage: 'intent' },
  { id: 'q7', text: 'What words come to mind when you think about this concept? Up to 5 words.', type: 'text', methodology: 'concept_test', funnel_stage: 'qualitative' },
  { id: 'q8', text: "What's your biggest concern or hesitation about this concept?", type: 'text', methodology: 'concept_test', funnel_stage: 'qualitative' },
  { id: 'q9', text: 'Who do you think this concept is for?', type: 'text', methodology: 'concept_test', funnel_stage: 'qualitative' },
  // Price-fair options verbatim from claudeAI.js:1069
  { id: 'q10', text: 'Is $5 a fair price for what is offered?', type: 'single', options: ['Too low', 'Fair', 'Too high'], methodology: 'concept_test', funnel_stage: 'price_fairness' },
];

const R = (p, q, answer) => ({ persona_id: p, question_id: q, answer });

// 10 personas. Hand-computed stage means:
//   reaction      [8,7,9,6,8,7,8,9,5,7]    sum 74 → mean 7.4, sd sqrt(14.4/9)=1.2649
//   relevance     ['6',5,6,4,6,5,7,6,5,6]  sum 56 → mean 5.6 (string '6' coerces)
//   uniqueness    [4,3,4,5,4,3,4,4,5,4]    sum 40 → mean 4.0
//   believability [5,5,4,6,5,5,6,5,4,5]    sum 50 → mean 5.0
//   intent: 2 Definitely + 3 Probably + 2 Might + 2 Probably NOT +
//           1 Definitely NOT → top-2 = 5/10 = 50%.
const REACTION = [8, 7, 9, 6, 8, 7, 8, 9, 5, 7];
const RELEVANCE = ['6', 5, 6, 4, 6, 5, 7, 6, 5, 6];
const UNIQUENESS = [4, 3, 4, 5, 4, 3, 4, 4, 5, 4];
const BELIEVABILITY = [5, 5, 4, 6, 5, 5, 6, 5, 4, 5];
const INTENT = [
  'Definitely would buy', 'Definitely would buy',
  'Probably would buy', 'Probably would buy', 'Probably would buy',
  'Might or might not', 'Might or might not',
  'Probably would NOT buy', 'Probably would NOT buy',
  'Definitely would NOT buy',
];
const PRICE = ['Fair', 'Fair', 'Fair', 'Fair', 'Fair', 'Fair', 'Too high', 'Too high', 'Too high', 'Too low'];

function buildRows() {
  const rows = [];
  for (let i = 1; i <= 10; i += 1) {
    const p = `p${i}`;
    rows.push(R(p, 'q1', 'Yes, regularly'));
    rows.push(R(p, 'q2', REACTION[i - 1]));
    rows.push(R(p, 'q3', RELEVANCE[i - 1]));
    rows.push(R(p, 'q4', UNIQUENESS[i - 1]));
    rows.push(R(p, 'q5', BELIEVABILITY[i - 1]));
    rows.push(R(p, 'q6', INTENT[i - 1]));
    rows.push(R(p, 'q7', `word association ${i}`));
    rows.push(R(p, 'q8', `concern ${i}`));
    if (i <= 4) rows.push(R(p, 'q9', `audience guess ${i}`));
    rows.push(R(p, 'q10', PRICE[i - 1]));
  }
  return rows;
}

test('scores: hand-computed stage means (reaction 7.4, relevance 5.6, uniqueness 4.0, believability 5.0)', () => {
  const out = computeValidate(buildRows(), QUESTIONS, {});
  expect(out.methodology).toBe('validate');
  expect(out.n).toBe(10);
  expect(out.scores.reaction.mean).toBe(7.4);
  expect(out.scores.reaction.n).toBe(10);
  expect(out.scores.reaction.stddev).toBeCloseTo(1.2649, 3); // sqrt(14.4/9)
  expect(out.scores.relevance.mean).toBe(5.6); // string '6' coerced via num()
  expect(out.scores.relevance.n).toBe(10);
  expect(out.scores.uniqueness.mean).toBe(4);
  expect(out.scores.believability.mean).toBe(5);
});

test('intent: top-2-box = "Definitely would buy"+"Probably would buy" = 5/10 = 50%; NOT-buy options never count', () => {
  const out = computeValidate(buildRows(), QUESTIONS, {});
  expect(out.intent.top2_pct).toBe(50);
  expect(out.intent.n).toBe(10);
  expect(out.intent.distribution).toEqual({
    'Definitely would buy': 2,
    'Probably would buy': 3,
    'Might or might not': 2,
    'Probably would NOT buy': 2, // contains "Probably" but is NOT top-2
    'Definitely would NOT buy': 1,
  });
});

test('price_fairness: distribution over Too low / Fair / Too high with base n', () => {
  const out = computeValidate(buildRows(), QUESTIONS, {});
  expect(out.price_fairness).toEqual({
    distribution: { Fair: 6, 'Too high': 3, 'Too low': 1 },
    n: 10,
  });
});

test('verbatims: keyed by qualitative question_id with honest totals', () => {
  const out = computeValidate(buildRows(), QUESTIONS, {});
  expect(Object.keys(out.verbatims)).toEqual(['q7', 'q8', 'q9']);
  expect(out.verbatims.q7.n).toBe(10);
  expect(out.verbatims.q7.items[0]).toBe('word association 1');
  expect(out.verbatims.q8.items).toHaveLength(10);
  expect(out.verbatims.q9.items).toEqual([
    'audience guess 1', 'audience guess 2', 'audience guess 3', 'audience guess 4',
  ]);
  expect(out.verbatims.q9.question).toBe('Who do you think this concept is for?');
});

test('verbatims capped at 30 per open question, total n stays honest', () => {
  const rows = [];
  for (let i = 1; i <= 35; i += 1) rows.push(R(`p${i}`, 'q8', `concern ${i}`));
  const out = computeValidate(rows, QUESTIONS, {});
  expect(out.verbatims.q8.items).toHaveLength(30);
  expect(out.verbatims.q8.n).toBe(35);
});

test('norms: explicitly null (no benchmark DB yet — renderer must label honestly)', () => {
  const out = computeValidate(buildRows(), QUESTIONS, {});
  expect(out).toHaveProperty('norms');
  expect(out.norms).toBeNull();
});

test('scale guards: out-of-range / non-numeric answers excluded from stage stats', () => {
  const rows = [
    R('p1', 'q2', 5),      // valid (1-10)
    R('p2', 'q2', 11),     // out of range for reaction
    R('p3', 'q2', 'abc'),  // non-numeric
    R('p4', 'q2', 0),      // below scale
    R('p1', 'q3', 7),      // valid (1-7)
    R('p2', 'q3', 8),      // out of range for relevance
  ];
  const out = computeValidate(rows, QUESTIONS, {});
  expect(out.scores.reaction).toMatchObject({ mean: 5, n: 1 });
  expect(out.scores.relevance).toMatchObject({ mean: 7, n: 1 });
});

test('incomputable → null, never throw: empty rows, null args, garbage answers', () => {
  const empty = computeValidate([], QUESTIONS, {});
  expect(empty).toMatchObject({
    methodology: 'validate', n: 0,
    scores: { reaction: null, relevance: null, uniqueness: null, believability: null },
    intent: null, price_fairness: null, norms: null,
  });
  expect(empty.verbatims).toEqual({
    q7: { question: expect.any(String), n: 0, items: [] },
    q8: { question: expect.any(String), n: 0, items: [] },
    q9: { question: expect.any(String), n: 0, items: [] },
  });
  expect(() => computeValidate(null, null, null)).not.toThrow();
  expect(computeValidate(null, null, null).n).toBe(0);
  const garbage = [
    { persona_id: 'p1', question_id: 'q2', answer: { weird: true } },
    { persona_id: 'p2', question_id: 'q6', answer: ['array', 'junk'] },
    { persona_id: 'p3' }, null,
  ];
  expect(() => computeValidate(garbage, QUESTIONS, {})).not.toThrow();
});

test('deterministic: identical input → identical JSON', () => {
  const a = JSON.stringify(computeValidate(buildRows(), QUESTIONS, {}));
  const b = JSON.stringify(computeValidate(buildRows(), QUESTIONS, {}));
  expect(a).toBe(b);
});

test('questions fallback: pulled from mission.questions when arg missing', () => {
  const out = computeValidate(buildRows(), null, { questions: QUESTIONS });
  expect(out.intent.top2_pct).toBe(50);
});

test('no price question (9-question variant, claudeAI.js:1069 "omit otherwise") → price_fairness null', () => {
  const noPriceQs = QUESTIONS.filter((q) => q.funnel_stage !== 'price_fairness');
  const rows = buildRows().filter((r) => r.question_id !== 'q10');
  const out = computeValidate(rows, noPriceQs, {});
  expect(out.price_fairness).toBeNull();
  expect(out.intent.top2_pct).toBe(50);
});
