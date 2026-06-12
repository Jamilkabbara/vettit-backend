/**
 * Pass 46 Phase 3 — brand_lift deterministic analysis, hand-computed
 * fixtures. The LLM never computes these numbers; if this module drifts,
 * every brand-lift report number drifts.
 *
 * Headline fixture math (10 exposed vs 10 control personas):
 *  - aided recall single: exposed 8/10 Yes vs control 4/10 Yes
 *      lift_abs = 0.4 (40pts); pooled p = 12/20 = 0.6
 *      se = √(0.6·0.4·(1/10+1/10)) = √0.048 = 0.219089
 *      z  = 0.4 / 0.219089 ≈ 1.8257 → sig90 true, sig95 false
 *  - favorability rating: exposed five 4s + five 5s (mean 4.5, s² = 2.5/9)
 *      vs control five 3s + five 4s (mean 3.5, same s²)
 *      Welch z = 1 / √(2·0.027778) = 1 / 0.235702 ≈ 4.2426 → sig95 true
 *  - aided awareness multi: exposed 7/10 vs control 5/10 select the brand
 *      z = 0.2 / 0.219089 ≈ 0.9129 → not significant
 */

const { computeBrandLift, welchZTest } = require('../src/services/analysis/brandLift');

const mk = (persona, qid, answer, exposure) => ({
  persona_id: persona,
  question_id: qid,
  answer,
  exposure_status: exposure,
  persona_profile: {},
});

const QUESTIONS = [
  { id: 'q1', text: 'Do you drink soda?', type: 'single', options: ['Yes', 'No'], isScreening: true, funnel_stage: 'screening', kpi_category: 'screening', is_lift_question: false },
  { id: 'q2', text: 'Have you seen an ad for Acme Cola recently?', type: 'single', options: ['Yes', 'No', 'Not sure'], funnel_stage: 'aided_ad_recall', kpi_category: 'ad_recall', is_lift_question: true },
  { id: 'q3', text: 'How favorable is your opinion of Acme Cola?', type: 'rating', options: [], funnel_stage: 'brand_favorability', kpi_category: 'perception', is_lift_question: true },
  { id: 'q4', text: 'Which of these soda brands have you heard of?', type: 'multi', options: ['Acme Cola', 'Brand X', 'Brand Y'], funnel_stage: 'aided_brand_awareness', kpi_category: 'awareness', is_lift_question: true },
  { id: 'q5', text: 'Which messages do you associate with Acme Cola?', type: 'multi', options: ['Tasty', 'Cheap'], funnel_stage: 'message_association', kpi_category: 'perception', is_lift_question: true },
  { id: 'q6', text: 'Would you consider Acme Cola next time?', type: 'single', options: ['Yes', 'No'], funnel_stage: 'brand_consideration', kpi_category: 'consideration', is_lift_question: true },
  { id: 'q7', text: 'What soda ads do you remember seeing?', type: 'text', options: [], funnel_stage: 'unaided_ad_recall', kpi_category: 'ad_recall', is_lift_question: true },
];

const MISSION = { brand_name: 'Acme Cola' };

function buildRows() {
  const rows = [];
  const E = Array.from({ length: 10 }, (_, i) => `e${i + 1}`);
  const C = Array.from({ length: 10 }, (_, i) => `c${i + 1}`);

  // q1 screener — everyone qualifies (excluded from funnel: is_lift_question=false)
  E.forEach((p) => rows.push(mk(p, 'q1', 'Yes', 'exposed')));
  C.forEach((p) => rows.push(mk(p, 'q1', 'Yes', 'control')));

  // q2 aided recall — exposed 8/10 Yes, control 4/10 Yes
  E.forEach((p, i) => rows.push(mk(p, 'q2', i < 8 ? 'Yes' : 'No', 'exposed')));
  C.forEach((p, i) => rows.push(mk(p, 'q2', i < 4 ? 'Yes' : 'No', 'control')));

  // q3 favorability — exposed mean 4.5, control mean 3.5 (same spread)
  E.forEach((p, i) => rows.push(mk(p, 'q3', i < 5 ? 4 : 5, 'exposed')));
  C.forEach((p, i) => rows.push(mk(p, 'q3', i < 5 ? 3 : 4, 'control')));

  // q4 aided awareness multi — exposed 7/10 contain brand (e7 is a stray
  // non-array, lowercase answer: coercion + case-insensitivity), control 5/10
  E.forEach((p, i) => {
    if (i < 6) rows.push(mk(p, 'q4', ['Acme Cola', 'Brand X'], 'exposed'));
    else if (i === 6) rows.push(mk(p, 'q4', 'acme cola', 'exposed'));
    else rows.push(mk(p, 'q4', ['Brand X'], 'exposed'));
  });
  C.forEach((p, i) => rows.push(mk(p, 'q4', i < 5 ? ['Acme Cola'] : ['Brand X'], 'control')));

  // q5 message association multi — no deterministic positive definition
  rows.push(mk('e1', 'q5', ['Tasty'], 'exposed'));
  rows.push(mk('c1', 'q5', ['Cheap'], 'control'));

  // q6 consideration — exposed-only answers → empty control cell
  E.forEach((p, i) => rows.push(mk(p, 'q6', i < 5 ? 'Yes' : 'No', 'exposed')));

  // q7 unaided recall text — verbatim, not deterministically liftable
  rows.push(mk('e1', 'q7', 'I saw an Acme Cola billboard', 'exposed'));
  rows.push(mk('c1', 'q7', 'none', 'control'));

  // not_applicable row — counted, but excluded from all lift math
  rows.push(mk('x1', 'q2', 'Yes', 'not_applicable'));

  return rows;
}

// ── welchZTest (implemented locally in brandLift.js) ────────────────────

test('welchZTest: hand-computed equal-variance fixture → z≈4.2426, sig95', () => {
  const t = welchZTest([4, 4, 4, 4, 4, 5, 5, 5, 5, 5], [3, 3, 3, 3, 3, 4, 4, 4, 4, 4]);
  expect(t.z).toBeCloseTo(4.2426, 3);
  expect(t.sig90).toBe(true);
  expect(t.sig95).toBe(true);
  expect(t.p).toBeLessThan(0.001);
});

test('welchZTest: small unequal fixture → z = 1/√0.5 ≈ 1.4142, not sig', () => {
  // means 4.5 vs 3.5, both s²=0.5 → se = √(0.25+0.25) = 0.7071
  const t = welchZTest(['4', '5'], [3, 4]); // string coercion via num()
  expect(t.z).toBeCloseTo(1.4142, 3);
  expect(t.sig90).toBe(false);
  expect(t.sig95).toBe(false);
});

test('welchZTest edges: identical constants → z=0; separated zero-variance → null; empty → null', () => {
  expect(welchZTest([4, 4], [4, 4])).toEqual({ z: 0, p: 1, sig90: false, sig95: false });
  expect(welchZTest([5, 5], [3, 3])).toBeNull();
  expect(welchZTest([], [3, 4])).toBeNull();
  expect(welchZTest([3, 4], [])).toBeNull();
});

// ── computeBrandLift: headline fixture ──────────────────────────────────

describe('computeBrandLift headline fixture (10 exposed / 10 control)', () => {
  const out = computeBrandLift(buildRows(), QUESTIONS, MISSION);
  const entry = (qid) => out.funnel.find((f) => f.question_id === qid);

  test('top-level shape: methodology, cells, funnel (screener excluded)', () => {
    expect(out.methodology).toBe('brand_lift');
    expect(out.cells.exposed.n).toBe(10);
    expect(out.cells.control.n).toBe(10);
    expect(out.cells.not_applicable.n).toBe(1);
    expect(out.funnel.map((f) => f.question_id)).toEqual(['q2', 'q3', 'q4', 'q5', 'q6', 'q7']);
    expect(out.degenerate_reason).toBeUndefined();
  });

  test('q2 proportion: 8/10 vs 4/10 → lift 0.4, z≈1.8257, sig90 only', () => {
    const e = entry('q2');
    expect(e.type).toBe('proportion');
    expect(e.funnel_stage).toBe('aided_ad_recall');
    expect(e.kpi_category).toBe('ad_recall');
    // not_applicable persona x1 answered 'Yes' but must not inflate the cell
    expect(e.exposed).toEqual({ n: 10, positive: 8, rate: 0.8 });
    expect(e.control).toEqual({ n: 10, positive: 4, rate: 0.4 });
    expect(e.lift_abs).toBeCloseTo(0.4, 4);
    expect(e.lift_rel_pct).toBeCloseTo(100, 4); // (0.8-0.4)/0.4 × 100
    expect(e.significance.z).toBeCloseTo(1.8257, 3);
    expect(e.significance.p).toBeCloseTo(0.068, 2);
    expect(e.significance.sig90).toBe(true);
    expect(e.significance.sig95).toBe(false);
  });

  test('q3 mean: 4.5 vs 3.5 → lift 1, Welch z≈4.2426, sig95', () => {
    const e = entry('q3');
    expect(e.type).toBe('mean');
    expect(e.exposed.n).toBe(10);
    expect(e.exposed.mean).toBeCloseTo(4.5, 4);
    expect(e.exposed.stddev).toBeCloseTo(0.527, 3); // √(2.5/9)
    expect(e.control.mean).toBeCloseTo(3.5, 4);
    expect(e.lift_abs).toBeCloseTo(1, 4);
    expect(e.lift_rel_pct).toBeCloseTo(28.5714, 3); // 1/3.5 × 100
    expect(e.significance.z).toBeCloseTo(4.2426, 3);
    expect(e.significance.sig95).toBe(true);
  });

  test('q4 multi brand-contains: 7/10 vs 5/10 → lift 0.2, z≈0.9129, not sig', () => {
    const e = entry('q4');
    expect(e.type).toBe('proportion');
    expect(e.exposed).toEqual({ n: 10, positive: 7, rate: 0.7 });
    expect(e.control).toEqual({ n: 10, positive: 5, rate: 0.5 });
    expect(e.lift_abs).toBeCloseTo(0.2, 4);
    expect(e.significance.z).toBeCloseTo(0.9129, 3);
    expect(e.significance.sig90).toBe(false);
  });

  test('q5 non-aided multi and q7 text → null blocks with reasons', () => {
    const q5 = entry('q5');
    expect(q5.type).toBeNull();
    expect(q5.lift_abs).toBeNull();
    expect(q5.significance).toBeNull();
    expect(q5.reason).toBe('no_positive_definition');
    expect(q5.exposed.n).toBe(1);

    const q7 = entry('q7');
    expect(q7.type).toBeNull();
    expect(q7.reason).toBe('unsupported_type_text');
  });

  test('q6 empty control cell → lift null + significance null, n still stated', () => {
    const e = entry('q6');
    expect(e.exposed).toEqual({ n: 10, positive: 5, rate: 0.5 });
    expect(e.control.n).toBe(0);
    expect(e.control.rate).toBeNull();
    expect(e.lift_abs).toBeNull();
    expect(e.lift_rel_pct).toBeNull();
    expect(e.significance).toBeNull();
    expect(e.reason).toBe('empty_cell');
  });

  test('summary: 3 lifted, 1 sig95, biggest lift = q3 (+1.0)', () => {
    expect(out.summary).toEqual({
      stages_lifted: 3,
      stages_sig95: 1,
      biggest_lift: { question_id: 'q3', lift_abs: 1 },
    });
  });

  test('output is JSON-serializable with no undefined/NaN/Infinity', () => {
    expect(JSON.parse(JSON.stringify(out))).toStrictEqual(out);
  });
});

// ── edge cases ──────────────────────────────────────────────────────────

test('degenerate: no exposed/control rows at all → no_exposure_cells shape', () => {
  const rows = [mk('p1', 'q2', 'Yes', 'not_applicable')];
  const out = computeBrandLift(rows, QUESTIONS, MISSION);
  expect(out).toStrictEqual({
    methodology: 'brand_lift',
    cells: { exposed: { n: 0 }, control: { n: 0 }, not_applicable: { n: 1 } },
    funnel: [],
    summary: null,
    degenerate_reason: 'no_exposure_cells',
  });
});

test('degenerate: empty rows array → no_exposure_cells with zero counts', () => {
  const out = computeBrandLift([], QUESTIONS, MISSION);
  expect(out.degenerate_reason).toBe('no_exposure_cells');
  expect(out.cells).toEqual({ exposed: { n: 0 }, control: { n: 0 }, not_applicable: { n: 0 } });
  expect(out.funnel).toEqual([]);
  expect(out.summary).toBeNull();
});

test('multi-select without mission.brand_name → null block, reason no_brand_anchor', () => {
  const rows = [
    mk('e1', 'q4', ['Acme Cola'], 'exposed'),
    mk('c1', 'q4', ['Brand X'], 'control'),
  ];
  const out = computeBrandLift(rows, QUESTIONS, {});
  const e = out.funnel.find((f) => f.question_id === 'q4');
  expect(e.type).toBeNull();
  expect(e.lift_abs).toBeNull();
  expect(e.significance).toBeNull();
  expect(e.reason).toBe('no_brand_anchor');
  expect(e.exposed.n).toBe(1);
  expect(e.control.n).toBe(1);
});

test('single-choice without a Yes-like option → reason no_affirmative_option', () => {
  const qs = [{ id: 'qx', text: 'Pick one', type: 'single', options: ['Definitely', 'Never'], funnel_stage: 'brand_consideration', kpi_category: 'consideration', is_lift_question: true }];
  const rows = [mk('e1', 'qx', 'Definitely', 'exposed'), mk('c1', 'qx', 'Never', 'control')];
  const e = computeBrandLift(rows, qs, MISSION).funnel[0];
  expect(e.type).toBeNull();
  expect(e.reason).toBe('no_affirmative_option');
});

test('single-choice with no options metadata falls back to answer-contains-yes', () => {
  const qs = [{ id: 'qy', text: 'Seen it?', type: 'single', options: [], funnel_stage: 'aided_ad_recall', kpi_category: 'ad_recall', is_lift_question: true }];
  const rows = [
    mk('e1', 'qy', 'Yes', 'exposed'), mk('e2', 'qy', 'no', 'exposed'),
    mk('c1', 'qy', 'No', 'control'), mk('c2', 'qy', 'No', 'control'),
  ];
  const e = computeBrandLift(rows, qs, MISSION).funnel[0];
  expect(e.exposed).toEqual({ n: 2, positive: 1, rate: 0.5 });
  expect(e.control).toEqual({ n: 2, positive: 0, rate: 0 });
  expect(e.lift_abs).toBeCloseTo(0.5, 4);
  expect(e.lift_rel_pct).toBeNull(); // control rate 0 → relative lift undefined
});

test('legacy questions without is_lift_question still enter via funnel_stage', () => {
  const qs = [
    { id: 'q1', text: 'screener', type: 'single', options: ['Yes', 'No'], funnel_stage: 'screening' },
    { id: 'q2', text: 'recall', type: 'single', options: ['Yes', 'No'], funnel_stage: 'aided_ad_recall' },
  ];
  const rows = [mk('e1', 'q2', 'Yes', 'exposed'), mk('c1', 'q2', 'No', 'control')];
  const out = computeBrandLift(rows, qs, MISSION);
  expect(out.funnel.map((f) => f.question_id)).toEqual(['q2']);
});
