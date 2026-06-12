/**
 * Pass 46 Phase 3 — churn (driver tree + win-back) module, hand-computed
 * fixtures. The 11-question battery mirrors CHURN_SURVEY_GEN_SYSTEM
 * exactly (src/services/claudeAI.js:1748-1758): churn_stage tags
 * screener|reason|satisfaction|win_back|switch|warning|tenure.
 */

const { computeChurn } = require('../src/services/analysis/churn');

const QUESTIONS = [
  { id: 'q1', text: 'Have you cancelled Acme in the past 30 days?', type: 'single', options: ['Yes', 'No'], isScreening: true, qualifying_answers: ['Yes'], methodology: 'churn_driver', churn_stage: 'screener' },
  // Reason options verbatim from claudeAI.js:1749
  { id: 'q2', text: 'What was the reason you stopped using Acme? Select all that apply.', type: 'multi', options: ['Price', 'Product fit', 'Customer service', 'Competition', 'Life change', 'Quality', 'Features', 'Trust', 'Other'], methodology: 'churn_driver', churn_stage: 'reason' },
  { id: 'q3', text: 'Tell us more about the main reason in your own words.', type: 'text', methodology: 'churn_driver', churn_stage: 'reason' },
  // Satisfaction options verbatim from claudeAI.js:1751
  { id: 'q4', text: 'How satisfied were you with Acme at the time you stopped?', type: 'single', options: ['Very dissatisfied', 'Dissatisfied', 'Neutral', 'Satisfied', 'Very satisfied'], methodology: 'churn_driver', churn_stage: 'satisfaction' },
  { id: 'q5', text: 'At the time you stopped, how likely were you to recommend Acme?', type: 'rating', options: [], methodology: 'churn_driver', churn_stage: 'satisfaction' },
  // Win-back options verbatim from claudeAI.js:1753
  { id: 'q6', text: 'Would you reconsider using Acme in the future?', type: 'single', options: ['Yes', 'Maybe', 'No'], methodology: 'churn_driver', churn_stage: 'win_back' },
  // Trigger options verbatim from claudeAI.js:1754
  { id: 'q7', text: 'What would bring you back? Select all that apply.', type: 'multi', options: ['Price discount or promo', 'New feature or improvement', 'Better service', 'Personal outreach', 'New product offering', 'Change in my situation', 'Other'], methodology: 'churn_driver', churn_stage: 'win_back' },
  { id: 'q8', text: 'Did you switch to a competitor? If so, which one?', type: 'text', methodology: 'churn_driver', churn_stage: 'switch' },
  { id: 'q9', text: 'How easy or difficult was it to cancel Acme?', type: 'rating', options: [], methodology: 'churn_driver', churn_stage: 'switch' },
  { id: 'q10', text: "Looking back, what was the first sign you'd leave Acme?", type: 'text', methodology: 'churn_driver', churn_stage: 'warning' },
  // Tenure options verbatim from claudeAI.js:1758
  { id: 'q11', text: 'How long were you an Acme customer before you left?', type: 'single', options: ['Less than 1 month', '1-3 months', '3-12 months', '1-3 years', 'More than 3 years'], methodology: 'churn_driver', churn_stage: 'tenure' },
];

const R = (p, q, answer) => ({ persona_id: p, question_id: q, answer });

// 10 personas. Hand-computed driver math (q2 multi):
//   p1 [Price,Quality] p2 [Price] p3 [Price,Competition] p4 [Customer service]
//   p5 [Price] p6 [Competition] p7 [Quality] p8 "Price" (bare-scalar drift)
//   p9 [] p10 null
// → respondents 8 (p9/p10 don't count), selections 10.
// Counts: Price 5, Competition 2, Quality 2, Customer service 1.
// pct_of_RESPONDENTS: 62.5 / 25 / 25 / 12.5 (NOT pct of 10 selections).
// Tie Competition-vs-Quality broken alphabetically.
function buildRows() {
  const rows = [];
  const reason = [
    ['Price', 'Quality'], ['Price'], ['Price', 'Competition'], ['Customer service'],
    ['Price'], ['Competition'], ['Quality'], 'Price', [], null,
  ];
  const sat = ['Very dissatisfied', 'Very dissatisfied', 'Very dissatisfied', 'Very dissatisfied', 'Dissatisfied', 'Dissatisfied', 'Dissatisfied', 'Neutral', 'Neutral', 'Satisfied'];
  const npsAtChurn = [0, 1, 2, 3, 4, 5, 6, 7, 2, 0]; // sum 30 → mean 3.0
  const winback = ['Yes', 'Yes', 'Yes', 'Maybe', 'Maybe', 'Maybe', 'Maybe', 'No', 'No', 'No'];
  const tenure = ['1-3 months', '1-3 months', '1-3 months', '1-3 months', '3-12 months', '3-12 months', '3-12 months', 'Less than 1 month', 'Less than 1 month', '1-3 years'];
  for (let i = 1; i <= 10; i += 1) {
    const p = `p${i}`;
    rows.push(R(p, 'q1', 'Yes'));
    rows.push(R(p, 'q2', reason[i - 1]));
    if (i <= 8) rows.push(R(p, 'q3', `Reason detail ${i}`));
    rows.push(R(p, 'q4', sat[i - 1]));
    rows.push(R(p, 'q5', npsAtChurn[i - 1]));
    rows.push(R(p, 'q6', winback[i - 1]));
    rows.push(R(p, 'q11', tenure[i - 1]));
  }
  // q7 win-back triggers: respondents 3, selections 4.
  rows.push(R('p1', 'q7', ['Price discount or promo']));
  rows.push(R('p2', 'q7', ['Price discount or promo', 'Better service']));
  rows.push(R('p3', 'q7', ['New feature or improvement']));
  // q8 switch destination (free text → exact-string distribution).
  rows.push(R('p1', 'q8', 'CompetitorX'));
  rows.push(R('p2', 'q8', 'CompetitorX'));
  rows.push(R('p3', 'q8', 'CompetitorX'));
  rows.push(R('p4', 'q8', 'CompetitorY'));
  rows.push(R('p5', 'q8', 'CompetitorY'));
  rows.push(R('p6', 'q8', 'No, just stopped'));
  // q9 CES at final interaction (1-7): [2,2,3] → mean 2.3333.
  rows.push(R('p1', 'q9', 2));
  rows.push(R('p2', 'q9', 2));
  rows.push(R('p3', 'q9', 3));
  // q10 warning signs.
  rows.push(R('p1', 'q10', 'Support stopped replying'));
  rows.push(R('p2', 'q10', 'Price hikes'));
  rows.push(R('p3', 'q10', 'Price hikes'));
  return rows;
}

test('drivers: ranked by count with alphabetical tie-break; base = respondents (8), selections stated (10)', () => {
  const out = computeChurn(buildRows(), QUESTIONS, {});
  expect(out.methodology).toBe('churn');
  expect(out.n).toBe(10);
  expect(out.drivers.n).toBe(8);          // p9 ([]) and p10 (null) are not respondents
  expect(out.drivers.selections).toBe(10); // multi-select picks counted separately
  expect(out.drivers.ranked).toEqual([
    { reason: 'Price',            count: 5, pct_of_respondents: 62.5 }, // 5/8, NOT 5/10
    { reason: 'Competition',      count: 2, pct_of_respondents: 25 },
    { reason: 'Quality',          count: 2, pct_of_respondents: 25 },
    { reason: 'Customer service', count: 1, pct_of_respondents: 12.5 },
  ]);
});

test('satisfaction at churn: per-question distribution + ratingStats only when numeric-ish', () => {
  const out = computeChurn(buildRows(), QUESTIONS, {});
  expect(out.satisfaction_at_churn).toHaveLength(2);
  const [q4, q5] = out.satisfaction_at_churn;
  expect(q4.question_id).toBe('q4');
  expect(q4.distribution).toEqual({
    'Very dissatisfied': 4, Dissatisfied: 3, Neutral: 2, Satisfied: 1,
  });
  expect(q4.stats).toBeNull(); // labeled options aren't numeric
  expect(q4.n).toBe(10);
  expect(q5.question_id).toBe('q5');
  expect(q5.stats.mean).toBe(3); // [0,1,2,3,4,5,6,7,2,0] sum 30 / 10
  expect(q5.stats.stddev).toBeCloseTo(2.4495, 3); // sqrt(54/9)
  expect(q5.n).toBe(10);
});

test('winback: winnable_pct = share of the affirmative "Yes" (Maybe NOT counted), full distribution kept', () => {
  const out = computeChurn(buildRows(), QUESTIONS, {});
  expect(out.winback.winnable_pct).toBe(30); // 3 Yes / 10
  expect(out.winback.n).toBe(10);
  expect(out.winback.distribution).toEqual({ Yes: 3, Maybe: 4, No: 3 });
});

test('winback triggers: ranked multi over respondent base (3), selections 4', () => {
  const out = computeChurn(buildRows(), QUESTIONS, {});
  expect(out.winback_triggers.n).toBe(3);
  expect(out.winback_triggers.selections).toBe(4);
  expect(out.winback_triggers.ranked).toEqual([
    { reason: 'Price discount or promo',    count: 2, pct_of_respondents: 66.6667 },
    { reason: 'Better service',             count: 1, pct_of_respondents: 33.3333 },
    { reason: 'New feature or improvement', count: 1, pct_of_respondents: 33.3333 },
  ]);
});

test('switching: destination distribution (n 6) + CES at exit mean 2.3333 (n 3)', () => {
  const out = computeChurn(buildRows(), QUESTIONS, {});
  expect(out.switching.n).toBe(6);
  expect(out.switching.distribution).toEqual({
    CompetitorX: 3, CompetitorY: 2, 'No, just stopped': 1,
  });
  expect(out.ces_at_exit.mean).toBeCloseTo(2.3333, 3); // (2+2+3)/3
  expect(out.ces_at_exit.n).toBe(3);
  expect(out.ces_at_exit.stddev).toBeCloseTo(0.5774, 3);
});

test('warning signs + tenure distributions', () => {
  const out = computeChurn(buildRows(), QUESTIONS, {});
  expect(out.warning_signs).toEqual({
    distribution: { 'Support stopped replying': 1, 'Price hikes': 2 },
    n: 3,
  });
  expect(out.tenure).toEqual({
    distribution: { '1-3 months': 4, '3-12 months': 3, 'Less than 1 month': 2, '1-3 years': 1 },
    n: 10,
  });
});

test('reason_verbatims: free-text detail in row order', () => {
  const out = computeChurn(buildRows(), QUESTIONS, {});
  expect(out.reason_verbatims).toHaveLength(8);
  expect(out.reason_verbatims[0]).toBe('Reason detail 1');
  expect(out.reason_verbatims[7]).toBe('Reason detail 8');
});

test('reason_verbatims capped at 30', () => {
  const rows = [];
  for (let i = 1; i <= 35; i += 1) rows.push(R(`p${i}`, 'q3', `detail ${i}`));
  const out = computeChurn(rows, QUESTIONS, {});
  expect(out.reason_verbatims).toHaveLength(30);
  expect(out.reason_verbatims[29]).toBe('detail 30');
});

test('incomputable → null, never throw: empty rows, null args, garbage answers', () => {
  const empty = computeChurn([], QUESTIONS, {});
  expect(empty).toMatchObject({
    methodology: 'churn', n: 0, drivers: null, satisfaction_at_churn: null,
    winback: null, winback_triggers: null, switching: null, ces_at_exit: null,
    warning_signs: null, tenure: null, reason_verbatims: [],
  });
  expect(() => computeChurn(null, null, null)).not.toThrow();
  expect(computeChurn(null, null, null).n).toBe(0);
  const garbage = [
    { persona_id: 'p1', question_id: 'q2', answer: { weird: true } },
    { persona_id: 'p2', question_id: 'q6', answer: ['Yes', 'No'] },
    { persona_id: 'p3', question_id: 'q9', answer: 'very hard' },
    { persona_id: 'p4' }, null,
  ];
  expect(() => computeChurn(garbage, QUESTIONS, {})).not.toThrow();
});

test('deterministic: identical input → identical JSON', () => {
  const a = JSON.stringify(computeChurn(buildRows(), QUESTIONS, {}));
  const b = JSON.stringify(computeChurn(buildRows(), QUESTIONS, {}));
  expect(a).toBe(b);
});

test('questions fallback: pulled from mission.questions when arg missing', () => {
  const out = computeChurn(buildRows(), null, { questions: QUESTIONS });
  expect(out.winback.winnable_pct).toBe(30);
});
