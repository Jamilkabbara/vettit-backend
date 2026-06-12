/**
 * Pass 46 Phase 3 — roadmap analysis (MaxDiff + Kano), hand-computed
 * fixtures. Every expected number below is derived by hand in the
 * comments; if computeRoadmap drifts, the report drifts.
 */

const { computeRoadmap, parseMaxDiffAnswer } = require('../src/services/analysis/roadmap');

// Question fixtures mirror ROADMAP_SURVEY_GEN_SYSTEM output
// (src/services/claudeAI.js L729-L761): max_diff questions carry
// feature_set (ids, display order) with options listing the feature
// names verbatim at the SAME positions; kano questions carry feature_id
// + kano_type with the canonical 5 options.
const KANO_OPTS = ['I like it', 'I expect it', 'Neutral', 'I can live with it', 'I dislike it'];
const mdQ = (id, feature_set, options) => ({
  id,
  type: 'max_diff_set',
  methodology: 'max_diff',
  text: 'Of these 4 features, which is MOST important to you, and which is LEAST important?',
  feature_set,
  options,
});
const kanoQ = (id, feature_id, kano_type) => ({
  id, type: 'single', methodology: 'kano', feature_id, kano_type, options: KANO_OPTS,
});

const QUESTIONS = [
  { id: 'q1', methodology: 'screener', type: 'single', options: ['Yes', 'No'] },
  mdQ('md1', ['f1', 'f2', 'f3', 'f4'], ['Speed boost', 'Offline mode', 'Dark theme', 'CSV export']),
  mdQ('md2', ['f1', 'f2', 'f3', 'f5'], ['Speed boost', 'Offline mode', 'Dark theme', 'API access']),
  mdQ('md3', ['f1', 'f4', 'f5', 'f2'], ['Speed boost', 'CSV export', 'API access', 'Offline mode']),
  kanoQ('kfA', 'fA', 'functional'), kanoQ('kdA', 'fA', 'dysfunctional'),
  kanoQ('kfB', 'fB', 'functional'), kanoQ('kdB', 'fB', 'dysfunctional'),
  kanoQ('kfC', 'fC', 'functional'), kanoQ('kdC', 'fC', 'dysfunctional'),
  kanoQ('kfD', 'fD', 'functional'), kanoQ('kdD', 'fD', 'dysfunctional'),
  kanoQ('kfE', 'fE', 'functional'), kanoQ('kdE', 'fE', 'dysfunctional'),
];

const MISSION = {
  clarify_answers: {
    roadmap_features: JSON.stringify([
      { id: 'f1', name: 'Speed boost' }, { id: 'f2', name: 'Offline mode' },
      { id: 'f3', name: 'Dark theme' }, { id: 'f4', name: 'CSV export' },
      { id: 'f5', name: 'API access' },
    ]),
  },
};

const row = (persona_id, question_id, answer) => ({ persona_id, question_id, answer });

/**
 * MAXDIFF FIXTURE — 3 personas × 3 sets, all three answer encodings:
 * p1 = object {best,worst} ids, p2 = JSON strings, p3 = option LABELS
 * resolved to ids positionally. p4 contributes one unparseable row
 * (no signal → no appearances) but still counts in top-level n.
 *
 * Picks (best/worst by feature id):
 *   p1: md1 f1/f4, md2 f1/f5, md3 f1/f5
 *   p2: md1 f1/f4, md2 f2/f5, md3 f1/f4
 *   p3: md1 f2/f4, md2 f3/f5, md3 f2/f5
 *
 * Tallies (9 valid rows; each valid row gives 4 appearances):
 *   f1: in md1,md2,md3 → appearances 9; best 5 (p1×3 + p2 md1,md3); worst 0 → 5/9 = 0.5556
 *   f2: in md1,md2,md3 → appearances 9; best 3 (p2 md2, p3 md1,md3); worst 0 → 3/9 = 0.3333
 *   f3: in md1,md2     → appearances 6; best 1 (p3 md2); worst 0          → 1/6 = 0.1667
 *   f4: in md1,md3     → appearances 6; best 0; worst 4 (p1 md1, p2 md1+md3, p3 md1) → −4/6 = −0.6667
 *   f5: in md2,md3     → appearances 6; best 0; worst 5 (p1 md2+md3, p2 md2, p3 md2+md3) → −5/6 = −0.8333
 *   (checks: Σbest = 5+3+1 = 9 = Σworst = 4+5)
 * Ranking: f1 > f2 > f3 > f4 > f5.
 */
const MAXDIFF_ROWS = [
  row('p1', 'md1', { best: 'f1', worst: 'f4' }),
  row('p1', 'md2', { best: 'f1', worst: 'f5' }),
  row('p1', 'md3', { best: 'f1', worst: 'f5' }),
  row('p2', 'md1', '{"best":"f1","worst":"f4"}'),
  row('p2', 'md2', '{"best":"f2","worst":"f5"}'),
  row('p2', 'md3', '{"best":"f1","worst":"f4"}'),
  row('p3', 'md1', { best: 'Offline mode', worst: 'CSV export' }), // labels → f2/f4
  row('p3', 'md2', { best: 'Dark theme', worst: 'API access' }), //   labels → f3/f5
  row('p3', 'md3', { best: 'Offline mode', worst: 'API access' }), // labels → f2/f5
  row('p4', 'md1', 'honestly they all matter to me'), // unparseable → excluded
];

/**
 * KANO FIXTURE — 3 personas; canonical table cells exercised:
 *   fA: functional "I expect it" + dysfunctional "I dislike it" ×3 → must_be (3)
 *       (p1's dysfunctional is UPPERCASE to verify normalization)
 *   fB: functional "I like it" + dysfunctional "Neutral" ×3 → attractive (3)
 *       (p2's functional is lowercase to verify normalization)
 *   fC: functional "I like it" + dysfunctional "I dislike it" ×3 → performance (3)
 *   fD: p1,p2 Neutral/Neutral → indifferent (2); p3 like/expect → attractive (1)
 *       → modal classification indifferent
 *   fE: functional answers only (no dysfunctional) → no pairs → omitted
 */
const KANO_ROWS = [
  row('p1', 'kfA', 'I expect it'), row('p1', 'kdA', 'I DISLIKE IT'),
  row('p2', 'kfA', 'I expect it'), row('p2', 'kdA', 'I dislike it'),
  row('p3', 'kfA', 'I expect it'), row('p3', 'kdA', 'I dislike it'),
  row('p1', 'kfB', 'I like it'), row('p1', 'kdB', 'Neutral'),
  row('p2', 'kfB', 'i like it'), row('p2', 'kdB', 'Neutral'),
  row('p3', 'kfB', 'I like it'), row('p3', 'kdB', 'Neutral'),
  row('p1', 'kfC', 'I like it'), row('p1', 'kdC', 'I dislike it'),
  row('p2', 'kfC', 'I like it'), row('p2', 'kdC', 'I dislike it'),
  row('p3', 'kfC', 'I like it'), row('p3', 'kdC', 'I dislike it'),
  row('p1', 'kfD', 'Neutral'), row('p1', 'kdD', 'Neutral'),
  row('p2', 'kfD', 'Neutral'), row('p2', 'kdD', 'Neutral'),
  row('p3', 'kfD', 'I like it'), row('p3', 'kdD', 'I expect it'),
  row('p1', 'kfE', 'I like it'), row('p3', 'kfE', 'Neutral'),
];

const ALL_ROWS = [...MAXDIFF_ROWS, ...KANO_ROWS];

test('MaxDiff: hand-tallied utilities and ranking across 3 encodings', () => {
  const out = computeRoadmap(ALL_ROWS, QUESTIONS, MISSION);
  expect(out.methodology).toBe('roadmap');
  expect(out.n).toBe(4); // p4's junk row still marks the persona as present

  const md = out.maxdiff;
  expect(md).not.toBeNull();
  expect(out.maxdiff_degenerate_reason).toBeNull();
  expect(md.n).toBe(3); // personas with ≥1 VALID MaxDiff answer
  expect(md.ranking).toEqual(['f1', 'f2', 'f3', 'f4', 'f5']);
  expect(md.features).toEqual([
    { feature_id: 'f1', label: 'Speed boost', utility: 0.5556, best: 5, worst: 0, appearances: 9 },
    { feature_id: 'f2', label: 'Offline mode', utility: 0.3333, best: 3, worst: 0, appearances: 9 },
    { feature_id: 'f3', label: 'Dark theme', utility: 0.1667, best: 1, worst: 0, appearances: 6 },
    { feature_id: 'f4', label: 'CSV export', utility: -0.6667, best: 0, worst: 4, appearances: 6 },
    { feature_id: 'f5', label: 'API access', utility: -0.8333, best: 0, worst: 5, appearances: 6 },
  ]);
});

test('MaxDiff labels fall back to options↔feature_set positions without mission', () => {
  const out = computeRoadmap(ALL_ROWS, QUESTIONS, null);
  const f1 = out.maxdiff.features.find((f) => f.feature_id === 'f1');
  expect(f1.label).toBe('Speed boost'); // from md1.options[0] ↔ md1.feature_set[0]
});

test('parseMaxDiffAnswer: invalid shapes → null', () => {
  const q = mdQ('x', ['f1', 'f2', 'f3', 'f4'], ['A', 'B', 'C', 'D']);
  expect(parseMaxDiffAnswer({ best: 'f1', worst: 'f1' }, q)).toBeNull(); // best === worst
  expect(parseMaxDiffAnswer({ best: 'f9', worst: 'f2' }, q)).toBeNull(); // outside feature_set
  expect(parseMaxDiffAnswer('they are all fine', q)).toBeNull();
  expect(parseMaxDiffAnswer(null, q)).toBeNull();
  expect(parseMaxDiffAnswer(4, q)).toBeNull();
  // labeled-string fallback still resolves:
  expect(parseMaxDiffAnswer('best: B, worst: D', q)).toEqual({ best: 'f2', worst: 'f4' });
});

test('Kano: canonical table classification per feature (M/A/O/I covered)', () => {
  const out = computeRoadmap(ALL_ROWS, QUESTIONS, MISSION);
  const kano = out.kano;
  expect(kano).not.toBeNull();
  expect(out.kano_degenerate_reason).toBeNull();

  const byId = Object.fromEntries(kano.features.map((f) => [f.feature_id, f]));
  expect(byId.fA.classification).toBe('must_be');
  expect(byId.fA.n).toBe(3);
  expect(byId.fA.counts).toEqual({ attractive: 0, must_be: 3, performance: 0, indifferent: 0, reverse: 0, questionable: 0 });
  expect(byId.fB.classification).toBe('attractive');
  expect(byId.fB.counts.attractive).toBe(3);
  expect(byId.fC.classification).toBe('performance');
  expect(byId.fC.counts.performance).toBe(3);
  expect(byId.fD.classification).toBe('indifferent');
  expect(byId.fD.counts).toEqual({ attractive: 1, must_be: 0, performance: 0, indifferent: 2, reverse: 0, questionable: 0 });
  expect(byId.fD.n).toBe(3);
  expect(byId.fE).toBeUndefined(); // no functional+dysfunctional pair → omitted
});

test('Kano: modal tie resolves by M > O > A > I evaluation rule', () => {
  // px: like/neutral → attractive; py: expect/dislike → must_be → 1-1 tie → must_be.
  const qs = [kanoQ('kf', 'fT', 'functional'), kanoQ('kd', 'fT', 'dysfunctional')];
  const rows = [
    row('px', 'kf', 'I like it'), row('px', 'kd', 'Neutral'),
    row('py', 'kf', 'I expect it'), row('py', 'kd', 'I dislike it'),
  ];
  const out = computeRoadmap(rows, qs, null);
  expect(out.kano.features).toEqual([{
    feature_id: 'fT',
    label: null,
    classification: 'must_be',
    n: 2,
    counts: { attractive: 1, must_be: 1, performance: 0, indifferent: 0, reverse: 0, questionable: 0 },
  }]);
});

test('degenerate: no rows → both sections null with reasons; never throws', () => {
  const out = computeRoadmap([], QUESTIONS, MISSION);
  expect(out.methodology).toBe('roadmap');
  expect(out.n).toBe(0);
  expect(out.maxdiff).toBeNull();
  expect(out.maxdiff_degenerate_reason).toMatch(/no parseable MaxDiff/);
  expect(out.kano).toBeNull();
  expect(out.kano_degenerate_reason).toMatch(/no personas with paired/);

  const empty = computeRoadmap([], [], null);
  expect(empty.maxdiff).toBeNull();
  expect(empty.maxdiff_degenerate_reason).toMatch(/no max_diff questions/);
  expect(empty.kano_degenerate_reason).toMatch(/no kano questions/);
  expect(() => computeRoadmap(null, undefined, undefined)).not.toThrow();
  expect(() => computeRoadmap([{ bogus: 1 }, null], [null, 'x'], { clarify_answers: { roadmap_features: '{not json' } })).not.toThrow();
});
