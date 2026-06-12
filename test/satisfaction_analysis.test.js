/**
 * Pass 46 Phase 3 — satisfaction (NPS + CSAT + CES) module, hand-computed
 * fixtures. The question battery mirrors CSAT_SURVEY_GEN_SYSTEM exactly
 * (src/services/claudeAI.js:899-909): 10 questions, methodology tags
 * screener|nps|nps_driver|csat|csat_driver|ces|ces_driver|
 * attribute_matrix|retention|specific_issues.
 */

const { computeSatisfaction } = require('../src/services/analysis/satisfaction');

const QUESTIONS = [
  { id: 'q1', text: 'Have you used Acme in the past 90 days?', type: 'single', options: ['Yes', 'No'], isScreening: true, qualifying_answers: ['Yes'], methodology: 'screener' },
  { id: 'q2', text: 'How likely are you to recommend Acme to a friend or colleague?', type: 'rating', options: [], methodology: 'nps' },
  { id: 'q3', text: "What's the main reason for your score?", type: 'text', methodology: 'nps_driver', is_driver: true },
  // CSAT options verbatim from claudeAI.js:903
  { id: 'q4', text: "How satisfied are you with Acme overall?", type: 'single', options: ['Very dissatisfied', 'Dissatisfied', 'Neutral', 'Satisfied', 'Very satisfied'], methodology: 'csat' },
  { id: 'q5', text: 'What could Acme do to improve?', type: 'text', methodology: 'csat_driver', is_driver: true },
  // CES 7-point (1=Very difficult, 7=Very easy), claudeAI.js:905
  { id: 'q6', text: 'How easy was it to use Acme?', type: 'rating', options: [], methodology: 'ces' },
  { id: 'q7', text: 'What made it easy or hard?', type: 'text', methodology: 'ces_driver', is_driver: true },
  // Attribute matrix options verbatim from claudeAI.js:907
  { id: 'q8', text: 'Rate Acme on each of the following:', type: 'rating', options: ['Quality', 'Value', 'Reliability', 'Customer service', 'Ease of use'], methodology: 'attribute_matrix' },
  { id: 'q9', text: 'How likely are you to continue using Acme in the next 12 months?', type: 'rating', options: [], methodology: 'retention' },
  { id: 'q10', text: 'Which of these have you experienced in the past 90 days?', type: 'multi', options: ['App crashed', 'Slow load times', "Couldn't reach support"], methodology: 'specific_issues' },
];

const R = (p, q, answer) => ({ persona_id: p, question_id: q, answer });

// 10 personas. Hand-computed targets:
//  NPS [10,9,9,10,7,8,7,6,3,0] → 4 promoters / 3 passives / 3 detractors → NPS 10.
//  CSAT 3×Very satisfied + 3×Satisfied + 2×Neutral + 1×Dissatisfied +
//       1×Very dissatisfied → top-2 = 6/10 = 60%.
//  CES [7,7,6,6,'6',5,4,3,2,1] → 6-or-7 = 5/10 = 50% (string '6' coerces).
//  Retention [5,5,4,4,4,3,3,2,5,4] → mean 3.9, sd 0.9944 (var 8.9/9).
const NPS_ANSWERS = [10, 9, 9, 10, 7, 8, 7, 6, 3, 0];
const CSAT_ANSWERS = ['Very satisfied', 'Very satisfied', 'Very satisfied', 'Satisfied', 'Satisfied', 'Satisfied', 'Neutral', 'Neutral', 'Dissatisfied', 'Very dissatisfied'];
const CES_ANSWERS = [7, 7, 6, 6, '6', 5, 4, 3, 2, 1];
const RETENTION_ANSWERS = [5, 5, 4, 4, 4, 3, 3, 2, 5, 4];

function buildRows() {
  const rows = [];
  for (let i = 1; i <= 10; i += 1) {
    const p = `p${i}`;
    rows.push(R(p, 'q1', 'Yes'));
    rows.push(R(p, 'q2', NPS_ANSWERS[i - 1]));
    rows.push(R(p, 'q3', `NPS reason ${i}`));
    rows.push(R(p, 'q4', CSAT_ANSWERS[i - 1]));
    rows.push(R(p, 'q6', CES_ANSWERS[i - 1]));
    // Attribute sub-answer objects (the prompt's "sub-row" shape):
    // Quality 4 for p1-p5, 5 for p6-p10 → mean 4.5; Value all 3 → mean 3,
    // sd 0; Reliability 2 for p1-p5, 4 for p6-p10 → mean 3, sd 1.0541;
    // Customer service only p1 (=5) → n 1; Ease of use never → null.
    const attr = { Quality: i <= 5 ? 4 : 5, Value: 3, Reliability: i <= 5 ? 2 : 4 };
    if (i === 1) attr['Customer service'] = 5;
    rows.push(R(p, 'q8', attr));
    rows.push(R(p, 'q9', RETENTION_ANSWERS[i - 1]));
  }
  // CSAT / CES driver verbatims (3 and 2 respondents).
  rows.push(R('p1', 'q5', 'Cheaper plans'));
  rows.push(R('p2', 'q5', 'Faster support replies'));
  rows.push(R('p3', 'q5', 'More integrations'));
  rows.push(R('p1', 'q7', 'The app was intuitive'));
  rows.push(R('p2', 'q7', 'Setup took ages'));
  // specific_issues multi: respondents = p1..p6 (p7 empty array and p8
  // null are NOT respondents). Counts: App crashed 4, Slow load times 2,
  // Couldn't reach support 1 → selections 7, respondent base 6.
  rows.push(R('p1', 'q10', ['App crashed', 'Slow load times']));
  rows.push(R('p2', 'q10', ['App crashed']));
  rows.push(R('p3', 'q10', ['Slow load times']));
  rows.push(R('p4', 'q10', ['App crashed']));
  rows.push(R('p5', 'q10', ["Couldn't reach support"]));
  rows.push(R('p6', 'q10', ['App crashed']));
  rows.push(R('p7', 'q10', []));
  rows.push(R('p8', 'q10', null));
  return rows;
}

test('NPS: 4 promoters / 3 passives / 3 detractors of 10 → score 10, segment pcts 40/30/30', () => {
  const out = computeSatisfaction(buildRows(), QUESTIONS, {});
  expect(out.methodology).toBe('satisfaction');
  expect(out.n).toBe(10);
  expect(out.nps.score).toBe(10); // round((4-3)/10×100)
  expect(out.nps.n).toBe(10);
  expect(out.nps.segments).toEqual({
    promoters:  { count: 4, pct: 40 },
    passives:   { count: 3, pct: 30 },
    detractors: { count: 3, pct: 30 },
  });
});

test('CSAT: top-2-box ("Satisfied"+"Very satisfied") = 6/10 = 60%, with distribution + base n', () => {
  const out = computeSatisfaction(buildRows(), QUESTIONS, {});
  expect(out.csat.top2_pct).toBe(60);
  expect(out.csat.n).toBe(10);
  expect(out.csat.distribution).toEqual({
    'Very satisfied': 3, Satisfied: 3, Neutral: 2, Dissatisfied: 1, 'Very dissatisfied': 1,
  });
});

test('CES: top-2-box (6+7 of 7-pt) = 5/10 = 50%; string "6" coerces into base and box', () => {
  const out = computeSatisfaction(buildRows(), QUESTIONS, {});
  expect(out.ces.top2_pct).toBe(50);
  expect(out.ces.n).toBe(10);
  expect(out.ces.distribution).toEqual({ 1: 1, 2: 1, 3: 1, 4: 1, 5: 1, 6: 3, 7: 2 });
});

test('attributes: per-attribute ratingStats from sub-answer objects, in option order', () => {
  const out = computeSatisfaction(buildRows(), QUESTIONS, {});
  expect(out.attributes.map((a) => a.label)).toEqual(
    ['Quality', 'Value', 'Reliability', 'Customer service', 'Ease of use'],
  );
  const [quality, value, reliability, cs, ease] = out.attributes;
  expect(quality.stats.mean).toBe(4.5);                 // five 4s + five 5s
  expect(quality.stats.n).toBe(10);
  expect(quality.stats.stddev).toBeCloseTo(0.527, 3);   // sqrt(2.5/9)
  expect(value.stats).toMatchObject({ mean: 3, stddev: 0, n: 10 });
  expect(reliability.stats.mean).toBe(3);               // five 2s + five 4s
  expect(reliability.stats.stddev).toBeCloseTo(1.0541, 3); // sqrt(10/9)
  expect(cs.stats).toEqual({ mean: 5, stddev: 0, n: 1, ci_low: 5, ci_high: 5 });
  expect(ease.stats).toBeNull();                        // no sub-answers at all
});

test('attributes fallback: numeric-only answers (simulate.js:49 shape) → single honest Overall entry', () => {
  const rows = [R('p1', 'q8', 4), R('p2', 'q8', 5)];
  const out = computeSatisfaction(rows, QUESTIONS, {});
  expect(out.attributes).toEqual([
    { label: 'Overall', stats: { mean: 4.5, stddev: expect.any(Number), n: 2, ci_low: expect.any(Number), ci_high: expect.any(Number) } },
  ]);
});

test('retention (1-5 rating): mean 3.9, sd 0.9944, distribution, n 10', () => {
  const out = computeSatisfaction(buildRows(), QUESTIONS, {});
  expect(out.retention.n).toBe(10);
  expect(out.retention.stats.mean).toBe(3.9); // sum 39 / 10
  expect(out.retention.stats.stddev).toBeCloseTo(0.9944, 3); // sqrt(8.9/9)
  expect(out.retention.distribution).toEqual({ 2: 1, 3: 2, 4: 4, 5: 3 });
});

test('specific_issues: ranked by count, pct over RESPONDENT base (6), selections stated (7)', () => {
  const out = computeSatisfaction(buildRows(), QUESTIONS, {});
  expect(out.issues.n).toBe(6);          // p7 ([]) and p8 (null) are not respondents
  expect(out.issues.selections).toBe(7); // total picks across respondents
  expect(out.issues.ranked).toEqual([
    { option: 'App crashed',           count: 4, pct_of_respondents: 66.6667 },
    { option: 'Slow load times',       count: 2, pct_of_respondents: 33.3333 },
    { option: "Couldn't reach support", count: 1, pct_of_respondents: 16.6667 },
  ]);
});

test('drivers: one entry per is_driver/_driver question with verbatims in row order', () => {
  const out = computeSatisfaction(buildRows(), QUESTIONS, {});
  expect(out.drivers.map((d) => d.kind)).toEqual(['nps_driver', 'csat_driver', 'ces_driver']);
  expect(out.drivers[0].verbatims).toHaveLength(10);
  expect(out.drivers[0].verbatims[0]).toBe('NPS reason 1');
  expect(out.drivers[1].verbatims).toEqual(['Cheaper plans', 'Faster support replies', 'More integrations']);
  expect(out.drivers[2].n).toBe(2);
});

test('drivers: verbatims capped at 30, total n stays honest', () => {
  const rows = [];
  for (let i = 1; i <= 35; i += 1) rows.push(R(`p${i}`, 'q3', `reason ${i}`));
  const out = computeSatisfaction(rows, QUESTIONS, {});
  const npsDriver = out.drivers.find((d) => d.kind === 'nps_driver');
  expect(npsDriver.verbatims).toHaveLength(30);
  expect(npsDriver.n).toBe(35);
});

test('NPS junk handling: out-of-range (11) and non-numeric excluded from base; negative score rounds', () => {
  const rows = [
    R('p1', 'q2', 9), R('p2', 'q2', 5), R('p3', 'q2', 4),
    R('p4', 'q2', 'junk'), R('p5', 'q2', 11),
  ];
  const out = computeSatisfaction(rows, QUESTIONS, {});
  expect(out.nps.n).toBe(3); // 9, 5, 4 only
  expect(out.nps.score).toBe(-33); // round((1-2)/3×100)
  expect(out.nps.segments.promoters.count).toBe(1);
  expect(out.nps.segments.detractors.count).toBe(2);
});

test('incomputable → null, never throw: empty rows, null args, garbage answers', () => {
  const empty = computeSatisfaction([], QUESTIONS, {});
  expect(empty).toMatchObject({
    methodology: 'satisfaction', n: 0, nps: null, csat: null, ces: null,
    attributes: null, retention: null, issues: null, drivers: [
      expect.objectContaining({ kind: 'nps_driver', verbatims: [] }),
      expect.objectContaining({ kind: 'csat_driver', verbatims: [] }),
      expect.objectContaining({ kind: 'ces_driver', verbatims: [] }),
    ],
  });
  expect(() => computeSatisfaction(null, null, null)).not.toThrow();
  expect(computeSatisfaction(null, null, null).n).toBe(0);
  const garbage = [
    { persona_id: 'p1', question_id: 'q2', answer: { weird: true } },
    { persona_id: 'p2', question_id: 'q4', answer: ['not', 'a', 'scalar'] },
    { persona_id: 'p3' }, null,
  ];
  expect(() => computeSatisfaction(garbage, QUESTIONS, {})).not.toThrow();
});

test('deterministic: identical input → identical JSON', () => {
  const a = JSON.stringify(computeSatisfaction(buildRows(), QUESTIONS, {}));
  const b = JSON.stringify(computeSatisfaction(buildRows(), QUESTIONS, {}));
  expect(a).toBe(b);
});

test('questions fallback: pulled from mission.questions when arg missing', () => {
  const out = computeSatisfaction(buildRows(), null, { questions: QUESTIONS });
  expect(out.nps.score).toBe(10);
});
