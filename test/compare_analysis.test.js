/**
 * Pass 46 Phase 3 — compare-concepts analysis, hand-computed fixtures.
 *
 * Question metadata mirrors COMPARE_SURVEY_GEN_SYSTEM
 * (src/services/claudeAI.js:1160-1201): 5 battery questions per concept
 * carrying concept_id + funnel_stage (appeal 1-10 / relevance 1-7 /
 * uniqueness 1-7 / intent 5-option single / qualitative text), then a
 * forced choice + why both flagged is_final_choice=true with
 * concept_id=null (claudeAI.js:1193-1195). Final-choice options are
 * concept NAMES + "None of these"; answers are option strings
 * (simulate.js:47,65).
 */

const { computeCompare } = require('../src/services/analysis/compare');

const row = (persona_id, question_id, answer) => ({ persona_id, question_id, answer });

const INTENT_OPTS = [
  'Definitely would buy',
  'Probably would buy',
  'Might or might not',
  'Probably would NOT buy',
  'Definitely would NOT buy',
];

const QUESTIONS = [
  { id: 'q1', text: 'Do you buy desk lamps?', type: 'single', isScreening: true, methodology: 'sequential_monadic', options: ['Yes', 'No'] },
  // concept c1 "Aurora"
  { id: 'qa1', text: 'Considering [Aurora]: A color-shifting smart lamp. How appealing is this concept?', type: 'rating', methodology: 'sequential_monadic', concept_id: 'c1', funnel_stage: 'appeal' },
  { id: 'qr1', text: 'How relevant is this concept to your needs?', type: 'rating', methodology: 'sequential_monadic', concept_id: 'c1', funnel_stage: 'relevance' },
  { id: 'qu1', text: 'How different is this from other desk lamp options?', type: 'rating', methodology: 'sequential_monadic', concept_id: 'c1', funnel_stage: 'uniqueness' },
  { id: 'qi1', text: 'If [Aurora] were available, how likely would you be to buy?', type: 'single', methodology: 'sequential_monadic', concept_id: 'c1', funnel_stage: 'intent', options: INTENT_OPTS },
  { id: 'qb1', text: "What's the best thing and the worst thing about this concept?", type: 'text', methodology: 'sequential_monadic', concept_id: 'c1', funnel_stage: 'qualitative' },
  // concept c2 "Bolt"
  { id: 'qa2', text: 'Considering [Bolt]: A fast-charging desk lamp. How appealing is this concept?', type: 'rating', methodology: 'sequential_monadic', concept_id: 'c2', funnel_stage: 'appeal' },
  { id: 'qr2', text: 'How relevant is this concept to your needs?', type: 'rating', methodology: 'sequential_monadic', concept_id: 'c2', funnel_stage: 'relevance' },
  { id: 'qu2', text: 'How different is this from other desk lamp options?', type: 'rating', methodology: 'sequential_monadic', concept_id: 'c2', funnel_stage: 'uniqueness' },
  { id: 'qi2', text: 'If [Bolt] were available, how likely would you be to buy?', type: 'single', methodology: 'sequential_monadic', concept_id: 'c2', funnel_stage: 'intent', options: INTENT_OPTS },
  { id: 'qb2', text: "What's the best thing and the worst thing about this concept?", type: 'text', methodology: 'sequential_monadic', concept_id: 'c2', funnel_stage: 'qualitative' },
  // final block — BOTH carry is_final_choice=true (claudeAI.js:1193); the
  // forced choice is the non-text one.
  { id: 'qf', text: 'Which concept did you find most appealing overall?', type: 'single', methodology: 'sequential_monadic', is_final_choice: true, options: ['Aurora', 'Bolt', 'None of these'] },
  { id: 'qw', text: 'Why?', type: 'text', methodology: 'sequential_monadic', is_final_choice: true },
];

const MISSION = { concepts: [{ id: 'c1', name: 'Aurora' }, { id: 'c2', name: 'Bolt' }] };

/* Hand math (p1..p5, n=5 per question) —
 *   appeal     c1 [8,7,9,8,8] → mean 8.0     c2 [6,5,7,6,6] → mean 6.0
 *   relevance  c1 [5,6,5,6,3] → mean 5.0     c2 [4,4,4,5,3] → mean 4.0
 *   uniqueness c1 [4,5,4,5,2] → mean 4.0     c2 [6,5,6,7,6] → mean 6.0
 *   intent     c1 [Def, Prob, Might, Prob, DefNOT] → top-2 box 3/5 = 60%
 *              c2 [Prob, Might, ProbNOT, Might, ProbNOT] → top-2 1/5 = 20%
 *   final      [Aurora, Aurora, Bolt, Aurora, None of these]
 *              → Aurora 3/5 = 60%, Bolt 1/5 = 20%, None 1/5 = 20%
 *   head-to-head: appeal c1 +2.0, relevance c1 +1.0, uniqueness c2 +2.0,
 *                 intent c1 +40pp.
 */
const ROWS = [
  row('p1', 'qa1', 8), row('p2', 'qa1', 7), row('p3', 'qa1', 9), row('p4', 'qa1', 8), row('p5', 'qa1', 8),
  row('p1', 'qr1', 5), row('p2', 'qr1', 6), row('p3', 'qr1', 5), row('p4', 'qr1', 6), row('p5', 'qr1', 3),
  row('p1', 'qu1', 4), row('p2', 'qu1', 5), row('p3', 'qu1', 4), row('p4', 'qu1', 5), row('p5', 'qu1', 2),
  row('p1', 'qi1', 'Definitely would buy'), row('p2', 'qi1', 'Probably would buy'),
  row('p3', 'qi1', 'Might or might not'), row('p4', 'qi1', 'Probably would buy'),
  row('p5', 'qi1', 'Definitely would NOT buy'),
  row('p1', 'qb1', 'Best: colors. Worst: price.'),

  row('p1', 'qa2', 6), row('p2', 'qa2', 5), row('p3', 'qa2', 7), row('p4', 'qa2', 6), row('p5', 'qa2', 6),
  row('p1', 'qr2', 4), row('p2', 'qr2', 4), row('p3', 'qr2', 4), row('p4', 'qr2', 5), row('p5', 'qr2', 3),
  row('p1', 'qu2', 6), row('p2', 'qu2', 5), row('p3', 'qu2', 6), row('p4', 'qu2', 7), row('p5', 'qu2', 6),
  row('p1', 'qi2', 'Probably would buy'), row('p2', 'qi2', 'Might or might not'),
  row('p3', 'qi2', 'Probably would NOT buy'), row('p4', 'qi2', 'Might or might not'),
  row('p5', 'qi2', 'Probably would NOT buy'),

  row('p1', 'qf', 'Aurora'), row('p2', 'qf', 'Aurora'), row('p3', 'qf', 'Bolt'),
  row('p4', 'qf', 'Aurora'), row('p5', 'qf', 'None of these'),
  row('p1', 'qw', 'The colors won me over.'), row('p3', 'qw', 'Charging matters more.'),
];

const byId = (res, id) => res.concepts.find((c) => c.concept_id === id);
const h2h = (res, dim) => res.head_to_head.find((h) => h.dimension === dim);

test('per-concept dimension ratingStats (appeal/relevance/uniqueness)', () => {
  const res = computeCompare(ROWS, QUESTIONS, MISSION);
  expect(res.methodology).toBe('compare');
  expect(res.n).toBe(5);

  const c1 = byId(res, 'c1');
  expect(c1.label).toBe('Aurora');
  expect(c1.dimensions.appeal.mean).toBe(8);
  expect(c1.dimensions.appeal.n).toBe(5);
  expect(c1.dimensions.relevance.mean).toBe(5);
  expect(c1.dimensions.uniqueness.mean).toBe(4);

  const c2 = byId(res, 'c2');
  expect(c2.dimensions.appeal.mean).toBe(6);
  expect(c2.dimensions.relevance.mean).toBe(4);
  expect(c2.dimensions.uniqueness.mean).toBe(6);
});

test('intent: top-2 box share on the 5-option scale + raw distribution', () => {
  const res = computeCompare(ROWS, QUESTIONS, MISSION);
  const c1 = byId(res, 'c1');
  expect(c1.dimensions.intent.top2).toEqual({ pct: 60, count: 3, base: 5 });
  expect(c1.dimensions.intent.distribution).toEqual({
    'Definitely would buy': 1,
    'Probably would buy': 2,
    'Might or might not': 1,
    'Definitely would NOT buy': 1,
  });
  expect(byId(res, 'c2').dimensions.intent.top2).toEqual({ pct: 20, count: 1, base: 5 });
});

test('final choice: per-concept share, "None of these" kept in the option table, overall winner', () => {
  const res = computeCompare(ROWS, QUESTIONS, MISSION);
  expect(byId(res, 'c1').final_choice_pct).toEqual({ pct: 60, count: 3, base: 5 });
  expect(byId(res, 'c2').final_choice_pct).toEqual({ pct: 20, count: 1, base: 5 });
  expect(res.final_choice.base).toBe(5);
  expect(res.final_choice.options['None of these']).toEqual({ count: 1, pct: 20 });
  expect(res.overall_winner).toEqual({ concept_id: 'c1', by: 'final_choice' });
  // the WHY rows (qw, also is_final_choice=true but type=text) must not
  // pollute the forced-choice base
  expect(res.final_choice.question_id).toBe('qf');
});

test('head-to-head: winner + delta per dimension (means; intent in pp)', () => {
  const res = computeCompare(ROWS, QUESTIONS, MISSION);
  expect(h2h(res, 'appeal')).toEqual({
    dimension: 'appeal', winner_concept_id: 'c1', runner_up_concept_id: 'c2', delta: 2, metric: 'mean_diff',
  });
  expect(h2h(res, 'relevance').winner_concept_id).toBe('c1');
  expect(h2h(res, 'relevance').delta).toBe(1);
  expect(h2h(res, 'uniqueness').winner_concept_id).toBe('c2');
  expect(h2h(res, 'uniqueness').delta).toBe(2);
  expect(h2h(res, 'intent')).toEqual({
    dimension: 'intent', winner_concept_id: 'c1', runner_up_concept_id: 'c2', delta: 40, metric: 'top2_pp_diff',
  });
});

test('missing funnel_stage → positional fallback (prompt block order, claudeAI.js:1188-1192)', () => {
  const stripped = QUESTIONS.map((q) => {
    if (!q.concept_id) return q;
    const { funnel_stage, ...rest } = q;
    return rest;
  });
  const res = computeCompare(ROWS, stripped, MISSION);
  expect(byId(res, 'c1').dimensions.appeal.mean).toBe(8);
  expect(byId(res, 'c1').dimensions.uniqueness.mean).toBe(4);
  expect(byId(res, 'c1').dimensions.intent.top2.pct).toBe(60);
});

test('no mission context: labels recovered from "Considering [<name>]" battery text', () => {
  const res = computeCompare(ROWS, QUESTIONS, null);
  expect(byId(res, 'c1').label).toBe('Aurora');
  expect(byId(res, 'c2').label).toBe('Bolt');
  // final-choice mapping still works against recovered labels
  expect(byId(res, 'c1').final_choice_pct.pct).toBe(60);
  expect(res.overall_winner).toEqual({ concept_id: 'c1', by: 'final_choice' });
});

test('mission.concepts as a JSON string (TEXT column) parses', () => {
  const res = computeCompare(ROWS, QUESTIONS, { concepts: JSON.stringify(MISSION.concepts) });
  expect(byId(res, 'c2').label).toBe('Bolt');
});

test('incomputable → null, never throw (empty + junk inputs)', () => {
  expect(computeCompare([], [], null)).toEqual({
    methodology: 'compare',
    n: 0,
    concepts: [],
    head_to_head: [],
    final_choice: null,
    overall_winner: null,
  });
  expect(() => computeCompare(undefined, 'nonsense', 9)).not.toThrow();
  // all-None final choice → no concept won → overall_winner null
  const noneRows = [row('p1', 'qf', 'None of these')];
  const res = computeCompare(noneRows, QUESTIONS, MISSION);
  expect(res.overall_winner).toBeNull();
  expect(byId(res, 'c1').final_choice_pct).toEqual({ pct: 0, count: 0, base: 1 });
  // concepts with no rows at all → null dimensions, not zeros
  expect(byId(res, 'c1').dimensions.appeal).toBeNull();
});
