/**
 * Pass 50 B3 — chart_data is a PROJECTION of the canonical report.
 *
 * The fork these tests lock shut: chart_data used to be recomputed by its own
 * loop while the web "full survey" + exports read buildCanonicalReport, so the
 * same question could show different numbers on the same page. computeChartData
 * now derives every per-question distribution from the canonical report, so the
 * two can never disagree. These tests assert that invariant directly and pin
 * the two behaviours that make the projection safe:
 *   - free-text questions are NEVER charted (a "Why?" must not become bars), and
 *   - endorsement batteries ARE charted (the old loop silently dropped them).
 */
const { computeChartData } = require('../src/services/backfills/chartData');
const { buildCanonicalReport } = require('../src/services/report/buildReport');

const opts = (min, max) => Array.from({ length: max - min + 1 }, (_, i) => String(min + i));

function mkMission() {
  return {
    id: 'm1', title: 'Test', brief: 'A real brief about the product', goal_type: 'satisfaction',
    qualified_respondent_count: 4, completed_at: '2026-06-14T00:00:00Z',
    insights: { executive_summary: 'x', kpis: [] },
    questions: [
      { id: 'q1', text: 'NPS 0-10', type: 'rating', options: opts(0, 10) },
      { id: 'q2', text: 'Pick one', type: 'single', options: ['A', 'B', 'C'] },
      { id: 'q3', text: 'Pick many', type: 'multi', options: ['X', 'Y', 'Z'] },
      { id: 'q4', text: 'Why?', type: 'text' },
    ],
  };
}

// 4 personas answer every question.
const responses = [
  { persona_id: 'p1', question_id: 'q1', answer: 9 }, { persona_id: 'p2', question_id: 'q1', answer: 10 },
  { persona_id: 'p3', question_id: 'q1', answer: 7 }, { persona_id: 'p4', question_id: 'q1', answer: 6 },
  { persona_id: 'p1', question_id: 'q2', answer: 'A' }, { persona_id: 'p2', question_id: 'q2', answer: 'A' },
  { persona_id: 'p3', question_id: 'q2', answer: 'B' }, { persona_id: 'p4', question_id: 'q2', answer: 'C' },
  { persona_id: 'p1', question_id: 'q3', answer: ['X', 'Y'] }, { persona_id: 'p2', question_id: 'q3', answer: ['X'] },
  { persona_id: 'p3', question_id: 'q3', answer: ['X', 'Z'] }, { persona_id: 'p4', question_id: 'q3', answer: ['Y'] },
  { persona_id: 'p1', question_id: 'q4', answer: 'It was fine.' }, { persona_id: 'p2', question_id: 'q4', answer: 'Loved it.' },
];

test('chart_data never charts a free-text question (the "Why?" → bars regression)', () => {
  const cd = computeChartData(mkMission(), responses);
  const ids = cd.per_question_distributions.map((d) => d.question_id);
  expect(ids).not.toContain('q4');          // text question is excluded
  expect(ids).toEqual(['q1', 'q2', 'q3']);  // every charted question is non-text
});

test('chart_data distributions are the canonical report, projected (no drift)', () => {
  const mission = mkMission();
  const cd = computeChartData(mission, responses);
  const report = buildCanonicalReport(mission, null, responses);
  const byId = new Map(cd.per_question_distributions.map((d) => [d.question_id, d]));
  const surveyById = new Map(report.survey.map((q) => [q.id, q]));

  // scale: rating bars come straight from the canonical 0..10 distribution.
  const q1 = byId.get('q1');
  const q1c = surveyById.get('q1').data;
  expect(q1.type).toBe('rating');
  expect(q1.scale_min).toBe(0);
  expect(q1.scale_max).toBe(10);
  expect(q1.buckets['9']).toBe(q1c.distribution['9']); // 1
  expect(q1.buckets['10']).toBe(q1c.distribution['10']); // 1
  expect(q1.mean).toBeCloseTo(q1c.average, 2);

  // single choice: counts + % match the canonical choice distribution.
  const q2 = byId.get('q2');
  const q2c = surveyById.get('q2').data;
  expect(q2.type).toBe('single_choice');
  const q2count = (o) => q2.counts[q2.options.indexOf(o)];
  expect(q2count('A')).toBe(q2c.distribution.A); // 2
  expect(q2.percentages[q2.options.indexOf('A')]).toBe(50); // 2/4

  // multi select: % is over RESPONDENTS, matching the canonical MultiDist.
  const q3 = byId.get('q3');
  const q3c = surveyById.get('q3').data;
  expect(q3.type).toBe('multi_select');
  expect(q3.n_respondents).toBe(q3c.n_respondents); // 4
  const q3count = (o) => q3.counts[q3.options.indexOf(o)];
  expect(q3count('X')).toBe(3);
  expect(q3.percentages[q3.options.indexOf('X')]).toBe(75); // 3 of 4 respondents
});

test('chart_data charts an endorsement battery the old scalar loop dropped', () => {
  const mission = {
    id: 'm2', title: 'Battery', goal_type: 'compare',
    questions: [{ id: 'qb', text: 'Which apply to Brand?', type: 'multi', brand_id: 'our_brand', options: ['Fast', 'Cheap', 'Reliable'] }],
  };
  const rows = [
    { persona_id: 'p1', question_id: 'qb', answer: ['Fast', 'Reliable'] },
    { persona_id: 'p2', question_id: 'qb', answer: ['Fast'] },
    { persona_id: 'p3', question_id: 'qb', answer: ['Cheap', 'Reliable'] },
  ];
  const cd = computeChartData(mission, rows);
  const qb = cd.per_question_distributions.find((d) => d.question_id === 'qb');
  expect(qb).toBeTruthy();                 // charted, not dropped
  expect(qb.type).toBe('multi_select');
  expect(qb.counts[qb.options.indexOf('Fast')]).toBe(2);
});
