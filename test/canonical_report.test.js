/**
 * Pass 48 — canonical report: renderer registry + per-question data shaping.
 * Proves the "7/5" (0-10 through a 5-star widget) and "0/5" (1-7 / attribute
 * battery collapsing to empty 1-5 buckets) classes are impossible by
 * construction — every question gets its TRUE scale.
 */
const {
  buildCanonicalReport, pickRenderer, shapeQuestionData, numericScale, buildDataQualityNotes,
} = require('../src/services/report/buildReport');

const opts = (min, max) => Array.from({ length: max - min + 1 }, (_, i) => String(min + i));

test('pickRenderer maps every question type to the correct renderer', () => {
  expect(pickRenderer({ type: 'rating', options: opts(0, 10) })).toBe('scale_0_10');
  expect(pickRenderer({ type: 'rating', options: opts(1, 7) })).toBe('scale_1_7');
  expect(pickRenderer({ type: 'rating', options: opts(1, 5) })).toBe('scale_1_5_star');
  expect(pickRenderer({ type: 'rating', options: [] })).toBe('scale_1_5_star');
  expect(pickRenderer({ type: 'rating', options: opts(1, 100) })).toBe('scale_generic');
  expect(pickRenderer({ type: 'single', options: ['A', 'B'] })).toBe('single_select');
  expect(pickRenderer({ type: 'opinion', options: ['A', 'B'] })).toBe('single_select');
  expect(pickRenderer({ type: 'multi', options: ['A', 'B'] })).toBe('multi_select');
  expect(pickRenderer({ type: 'multi', brand_id: 'our_brand', options: ['x'] })).toBe('attribute_battery');
  expect(pickRenderer({ type: 'text' })).toBe('open_text_verbatims');
  expect(pickRenderer({ type: 'max_diff_set', options: ['a', 'b', 'c', 'd'] })).toBe('max_diff');
  expect(pickRenderer({ type: 'single', methodology: 'kano' })).toBe('kano');
  expect(pickRenderer({ type: 'single', is_paired_comparison: true })).toBe('paired_comparison');
  expect(pickRenderer({ type: 'single', is_final_choice: true })).toBe('forced_choice');
  expect(pickRenderer({ type: 'single', isScreening: true, options: ['Yes', 'No'] })).toBe('screener');
});

test('NO non-1-5 scale ever resolves to the 1-5 star widget', () => {
  // The exact bug: 0-10 NPS and 1-7 CES must NOT be scale_1_5_star.
  expect(pickRenderer({ type: 'rating', options: opts(0, 10) })).not.toBe('scale_1_5_star');
  expect(pickRenderer({ type: 'rating', options: opts(1, 7) })).not.toBe('scale_1_5_star');
});

test('REAL-WORLD: NPS/CES with EMPTY options resolve by text + observed answers (the production bug)', () => {
  // Production NPS question carries no numeric options — scale is in the text + answers.
  const npsQ = { id: 'q', type: 'rating', options: [], text: 'How likely are you to recommend SwiftEats on a scale of 0 to 10?' };
  const npsAns = [9, 10, 7, 6, 0];
  expect(pickRenderer(npsQ, npsAns)).toBe('scale_0_10'); // NOT scale_1_5_star
  const cesQ = { id: 'q', type: 'rating', options: [], text: 'How easy was it? (1 to 7)' };
  expect(pickRenderer(cesQ, [7, 6, 5])).toBe('scale_1_7');
  // Pure observed-answer fallback: no options, no scale words, but a 9 appears → cannot be 1-5 star.
  const bareQ = { id: 'q', type: 'rating', options: [], text: 'rate this' };
  expect(pickRenderer(bareQ, [9, 8, 7])).not.toBe('scale_1_5_star');
  // metadata path: methodology nps
  expect(pickRenderer({ id: 'q', type: 'rating', options: [], methodology: 'nps', text: 'recommend?' }, [8])).toBe('scale_0_10');
});

test('attribute_matrix (rating-type battery) → attribute_battery, never a scalar 5-star', () => {
  expect(pickRenderer({ id: 'q', type: 'rating', methodology: 'attribute_matrix', options: [] })).toBe('attribute_battery');
  // object answers {attr: rating} → per-attribute averages
  const q = { id: 'q', type: 'rating', methodology: 'attribute_matrix' };
  const responses = [
    { question_id: 'q', answer: { Quality: 4, Value: 3 } },
    { question_id: 'q', answer: { Quality: 5, Value: 2 } },
  ];
  const data = shapeQuestionData(q, 'attribute_battery', responses, null);
  expect(data.shape).toBe('matrix');
  expect(data.per_attribute.find((a) => a.attribute === 'Quality').average).toBe(4.5);
});

test('numericScale rejects labelled options (mixed text)', () => {
  expect(numericScale(['Very dissatisfied', 'Neutral', 'Very satisfied'])).toBeNull();
  expect(numericScale(opts(0, 10))).toEqual({ min: 0, max: 10 });
});

test('shapeQuestionData: 0-10 NPS builds 0..10 buckets + real mean (no 7/5)', () => {
  const q = { id: 'q1', type: 'rating', options: opts(0, 10) };
  const responses = [9, 10, 7, 6, 0].map((v, i) => ({ persona_id: `p${i}`, question_id: 'q1', answer: v }));
  const data = shapeQuestionData(q, 'scale_0_10', responses, null);
  expect(data.scale_min).toBe(0);
  expect(data.scale_max).toBe(10);
  expect(Object.keys(data.distribution)).toHaveLength(11); // 0..10
  expect(data.distribution['9']).toBe(1);
  expect(data.distribution['10']).toBe(1);
  expect(data.average).toBeCloseTo(6.4, 1);
  expect(data.n).toBe(5);
});

test('shapeQuestionData: 1-7 CES builds 1..7 buckets (no 0/5 collapse)', () => {
  const q = { id: 'q1', type: 'rating', options: opts(1, 7) };
  const responses = [7, 6, 6, 5, 1].map((v, i) => ({ persona_id: `p${i}`, question_id: 'q1', answer: v }));
  const data = shapeQuestionData(q, 'scale_1_7', responses, null);
  expect(Object.keys(data.distribution)).toHaveLength(7); // 1..7, not 1..5
  expect(data.distribution['7']).toBe(1);
  expect(data.distribution['6']).toBe(2);
  expect(data.average).toBeCloseTo(5, 1);
});

test('shapeQuestionData: max_diff produces best/worst counts', () => {
  const q = { id: 'q1', type: 'max_diff_set', feature_set: ['f1', 'f2', 'f3', 'f4'] };
  const responses = [
    { persona_id: 'p1', question_id: 'q1', answer: { best: 'f1', worst: 'f4' } },
    { persona_id: 'p2', question_id: 'q1', answer: { best: 'f1', worst: 'f3' } },
  ];
  const data = shapeQuestionData(q, 'max_diff', responses, null);
  expect(data.best.f1).toBe(2);
  expect(data.worst.f4).toBe(1);
});

test('data-quality notes: NO false positive on a graded Likert scale; one-per-question max', () => {
  // CSAT 5-option Likert — adjacent graded options are correct, not a defect.
  const survey = [{
    number: 1, id: 'q1', renderer: 'single_select',
    options: ['Very dissatisfied', 'Dissatisfied', 'Neutral', 'Satisfied', 'Very satisfied'],
  }];
  const responses = [
    { question_id: 'q1', answer: 'Satisfied' }, { question_id: 'q1', answer: 'Very satisfied' },
  ];
  expect(buildDataQualityNotes(survey, responses)).toEqual([]); // no spam, no overlap flag
});

test('data-quality notes: flags genuine option drift, once', () => {
  const survey = [{ number: 3, id: 'q3', renderer: 'single_select', options: ['Yes', 'No'] }];
  const responses = [
    { question_id: 'q3', answer: 'Yes' },
    { question_id: 'q3', answer: 'Maybe later' }, // not in the saved option list
  ];
  const notes = buildDataQualityNotes(survey, responses);
  expect(notes).toHaveLength(1);
  expect(notes[0].question_number).toBe(3);
  expect(notes[0].note).toMatch(/not in the saved option list/);
});

test('buildCanonicalReport: uniform shape; survey carries correct renderers; exec hedge stripped', () => {
  const mission = {
    id: 'm1', title: 'Test', brief: 'A real brief about something', goal_type: 'satisfaction',
    qualified_respondent_count: 5, completed_at: '2026-06-14T00:00:00Z',
    insights: { executive_summary: 'NPS is -20. A fuller written narrative was unavailable for this run; the computed results below are complete and accurate.', kpis: [] },
    questions: [
      { id: 'q1', text: 'NPS', type: 'rating', options: opts(0, 10) },
      { id: 'q2', text: 'CES', type: 'rating', options: opts(1, 7) },
      { id: 'q3', text: 'Why?', type: 'text' },
    ],
  };
  const analysis = { methodology: 'satisfaction', n: 5, nps: { score: -20 }, csat: { top2_pct: 80 } };
  const responses = [
    { persona_id: 'p1', question_id: 'q1', answer: 9 }, { persona_id: 'p1', question_id: 'q2', answer: 6 },
    { persona_id: 'p1', question_id: 'q3', answer: 'It was fine.' },
  ];
  const report = buildCanonicalReport(mission, analysis, responses);
  expect(report.header.brief).toBe('A real brief about something');
  expect(report.header.methodology_label).toBe('Customer Satisfaction');
  expect(report.survey).toHaveLength(3);
  expect(report.survey[0].renderer).toBe('scale_0_10');
  expect(report.survey[1].renderer).toBe('scale_1_7');
  expect(report.survey[2].renderer).toBe('open_text_verbatims');
  expect(report.centerpiece.data.nps.score).toBe(-20);
  // hedge tail stripped, real content kept
  expect(report.exec_summary).toContain('NPS is -20');
  expect(report.exec_summary).not.toMatch(/fuller written narrative/i);
});
