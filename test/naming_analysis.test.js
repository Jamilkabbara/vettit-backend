/**
 * Pass 46 Phase 3 — naming & messaging analysis, hand-computed fixtures.
 *
 * Question metadata mirrors NAMING_SURVEY_GEN_SYSTEM
 * (src/services/claudeAI.js:1542-1595): monadic Qs carry
 * methodology="monadic" + candidate_id + criterion; paired Qs carry
 * is_paired_comparison=true with options=[<A text>, <B text>] and the
 * ANSWER is the chosen candidate's verbatim text; the TURF Q carries
 * is_turf=true, type="multi", options=[<each candidate text>] and the
 * ANSWER is an array of selected texts (simulate.js:47-50,65-67).
 */

const { computeNaming } = require('../src/services/analysis/naming');

const row = (persona_id, question_id, answer) => ({ persona_id, question_id, answer });

const QUESTIONS = [
  { id: 'q1', text: 'Do you buy smart lighting?', type: 'single', isScreening: true, methodology: 'monadic_plus_paired', options: ['Yes', 'No'] },
  // monadic block — candidate n1 "Lumio"
  { id: 'q_n1_mem', text: 'On a 1-7 scale, how memorable is [Lumio]?', type: 'rating', methodology: 'monadic', candidate_id: 'n1', criterion: 'memorable' },
  { id: 'q_n1_dis', text: 'On a 1-7 scale, how distinctive is [Lumio]?', type: 'rating', methodology: 'monadic', candidate_id: 'n1', criterion: 'distinctive' },
  { id: 'q_n1_wa', text: 'What does [Lumio] make you think of? Up to 5 words.', type: 'text', methodology: 'monadic', candidate_id: 'n1', criterion: 'word_association' },
  // candidate n2 "Brightly"
  { id: 'q_n2_mem', text: 'On a 1-7 scale, how memorable is [Brightly]?', type: 'rating', methodology: 'monadic', candidate_id: 'n2', criterion: 'memorable' },
  { id: 'q_n2_dis', text: 'On a 1-7 scale, how distinctive is [Brightly]?', type: 'rating', methodology: 'monadic', candidate_id: 'n2', criterion: 'distinctive' },
  // candidate n3 "Glowex"
  { id: 'q_n3_mem', text: 'On a 1-7 scale, how memorable is [Glowex]?', type: 'rating', methodology: 'monadic', candidate_id: 'n3', criterion: 'memorable' },
  { id: 'q_n3_dis', text: 'On a 1-7 scale, how distinctive is [Glowex]?', type: 'rating', methodology: 'monadic', candidate_id: 'n3', criterion: 'distinctive' },
  // forced choice + why (monadic_plus_paired, is_paired_comparison=false → NOT pairwise)
  { id: 'q_forced', text: 'Which candidate did you find most appealing overall?', type: 'single', methodology: 'monadic_plus_paired', is_paired_comparison: false, options: ['Lumio', 'Brightly', 'Glowex'] },
  { id: 'q_why', text: 'Why?', type: 'text', methodology: 'monadic_plus_paired' },
  // paired comparisons — ceil(3/2) = 2
  { id: 'qp1', text: 'Which would you choose: [Lumio] OR [Brightly]?', type: 'single', methodology: 'paired_comparison', is_paired_comparison: true, options: ['Lumio', 'Brightly'] },
  { id: 'qp2', text: 'Which would you choose: [Brightly] OR [Glowex]?', type: 'single', methodology: 'paired_comparison', is_paired_comparison: true, options: ['Brightly', 'Glowex'] },
  // TURF
  { id: 'qt', text: 'Which of these taglines do you find compelling? Select all that apply.', type: 'multi', methodology: 'turf', is_turf: true, options: ['Lumio', 'Brightly', 'Glowex'] },
];

const MISSION = {
  naming_candidates: JSON.stringify([
    { id: 'n1', text: 'Lumio' },
    { id: 'n2', text: 'Brightly' },
    { id: 'n3', text: 'Glowex' },
  ]),
};

/* Hand math —
 * monadic (p1..p4):
 *   n1 memorable  [6,7,5,6] → mean 6.0   n1 distinctive [5,5,6,4] → mean 5.0
 *     composite n1 = (6+5)/2 = 5.5
 *   n2 memorable  [4,5,4,3] → mean 4.0   n2 distinctive [6,7,6,5] → mean 6.0
 *     composite n2 = (4+6)/2 = 5.0
 *   n3 memorable  [3,4,2,3] → mean 3.0   n3 distinctive [4,3,4,5] → mean 4.0
 *     composite n3 = (3+4)/2 = 3.5
 * paired:
 *   qp1 (Lumio vs Brightly): Lumio, ' lumio ' (case test), Brightly, Lumio
 *     → Lumio 3, Brightly 1 (base 4)
 *   qp2 (Brightly vs Glowex): Brightly, Glowex, Brightly, Brightly
 *     → Brightly 3, Glowex 1 (base 4)
 *   win rates: Lumio 3/4 = 75%, Brightly (1+3)/8 = 50%, Glowex 1/4 = 25%
 * TURF (p1..p8, base 8):
 *   p1 [Lumio,Brightly] p2 [Lumio,Brightly] p3 [Lumio,Brightly] p4 [Lumio]
 *   p5 [Brightly] p6 [Glowex] p7 [Glowex] p8 [Lumio,Glowex]
 *   individual reach: Lumio 5/8=62.5%, Brightly 4/8=50%, Glowex 3/8=37.5%
 *   greedy: Lumio (5) → +Glowex adds p6,p7 (+2=25pp, vs +Brightly only p5
 *   +1=12.5pp) → 7/8=87.5% → +Brightly adds p5 → 8/8=100%.
 *   NAIVE top-2 by individual reach (Lumio+Brightly) reaches only
 *   6/8 = 75% < 87.5% — proves the greedy increment step.
 */
const ROWS = [
  // n1 memorable / distinctive
  row('p1', 'q_n1_mem', 6), row('p2', 'q_n1_mem', 7), row('p3', 'q_n1_mem', 5), row('p4', 'q_n1_mem', 6),
  row('p1', 'q_n1_dis', 5), row('p2', 'q_n1_dis', 5), row('p3', 'q_n1_dis', 6), row('p4', 'q_n1_dis', 4),
  // word association (text — must be excluded from rating math)
  row('p1', 'q_n1_wa', 'light, warm, lamp'), row('p2', 'q_n1_wa', 'glow'),
  // n2
  row('p1', 'q_n2_mem', 4), row('p2', 'q_n2_mem', 5), row('p3', 'q_n2_mem', 4), row('p4', 'q_n2_mem', 3),
  row('p1', 'q_n2_dis', 6), row('p2', 'q_n2_dis', 7), row('p3', 'q_n2_dis', 6), row('p4', 'q_n2_dis', 5),
  // n3
  row('p1', 'q_n3_mem', 3), row('p2', 'q_n3_mem', 4), row('p3', 'q_n3_mem', 2), row('p4', 'q_n3_mem', 3),
  row('p1', 'q_n3_dis', 4), row('p2', 'q_n3_dis', 3), row('p3', 'q_n3_dis', 4), row('p4', 'q_n3_dis', 5),
  // forced choice — is_paired_comparison=false, must NOT count toward win rates
  row('p1', 'q_forced', 'Lumio'), row('p2', 'q_forced', 'Lumio'),
  row('p3', 'q_forced', 'Brightly'), row('p4', 'q_forced', 'Glowex'),
  row('p1', 'q_why', 'It sounds warm.'),
  // paired
  row('p1', 'qp1', 'Lumio'), row('p2', 'qp1', ' lumio '), row('p3', 'qp1', 'Brightly'), row('p4', 'qp1', 'Lumio'),
  row('p1', 'qp2', 'Brightly'), row('p2', 'qp2', 'Glowex'), row('p3', 'qp2', 'Brightly'), row('p4', 'qp2', 'Brightly'),
  // TURF
  row('p1', 'qt', ['Lumio', 'Brightly']), row('p2', 'qt', ['Lumio', 'Brightly']),
  row('p3', 'qt', ['Lumio', 'Brightly']), row('p4', 'qt', ['Lumio']),
  row('p5', 'qt', ['Brightly']), row('p6', 'qt', ['Glowex']),
  row('p7', 'qt', ['Glowex']), row('p8', 'qt', ['Lumio', 'Glowex']),
];

const byId = (res, id) => res.candidates.find((c) => c.candidate_id === id);

test('monadic: per-criterion ratingStats + unweighted composite (word_association excluded)', () => {
  const res = computeNaming(ROWS, QUESTIONS, MISSION);
  expect(res.methodology).toBe('naming');
  expect(res.n).toBe(8); // p1..p8 distinct personas

  const n1 = byId(res, 'n1');
  expect(n1.label).toBe('Lumio');
  expect(n1.criteria.memorable.mean).toBe(6);
  expect(n1.criteria.memorable.n).toBe(4);
  expect(n1.criteria.distinctive.mean).toBe(5);
  expect(n1.composite).toBe(5.5);
  // word_association is text (claudeAI.js:1573) → never a criterion key
  expect(Object.keys(n1.criteria).sort()).toEqual(['distinctive', 'memorable']);

  expect(byId(res, 'n2').composite).toBe(5);
  expect(byId(res, 'n3').composite).toBe(3.5);
});

test('pairwise: win rate = wins / comparisons-appeared-in; forced choice excluded; case-insensitive answers', () => {
  const res = computeNaming(ROWS, QUESTIONS, MISSION);
  // Lumio appears only in qp1 (4 valid answers) — q_forced must not inflate this
  expect(byId(res, 'n1').pairwise_win_rate).toEqual({ pct: 75, wins: 3, appearances: 4 });
  // ' lumio ' (trimmed, lowercased) counted as a Lumio win
  expect(byId(res, 'n2').pairwise_win_rate).toEqual({ pct: 50, wins: 4, appearances: 8 });
  expect(byId(res, 'n3').pairwise_win_rate).toEqual({ pct: 25, wins: 1, appearances: 4 });

  expect(res.pairwise.comparisons).toHaveLength(2);
  const qp1 = res.pairwise.comparisons.find((c) => c.question_id === 'qp1');
  expect(qp1.base).toBe(4);
  expect(qp1.results.find((r) => r.candidate_id === 'n1')).toEqual(
    { candidate_id: 'n1', label: 'Lumio', wins: 3, win_pct: 75 },
  );

  expect(res.winner).toEqual({ candidate_id: 'n1', by: 'pairwise_win_rate' });
});

test('TURF: greedy ladder beats naive top-2 (Glowex jumps ahead of higher-reach Brightly)', () => {
  const res = computeNaming(ROWS, QUESTIONS, MISSION);
  expect(res.turf.base).toBe(8);
  expect(res.turf.ladder.map((s) => s.option)).toEqual(['Lumio', 'Glowex', 'Brightly']);
  expect(res.turf.ladder.map((s) => s.cumulative_reach_pct)).toEqual([62.5, 87.5, 100]);
  expect(res.turf.ladder.map((s) => s.incremental_reach_pct)).toEqual([62.5, 25, 12.5]);
  // The greedy proof: Brightly has HIGHER individual reach (50%) than
  // Glowex (37.5%), yet Glowex is the 2nd pick because Brightly overlaps
  // Lumio. Naive top-2 {Lumio, Brightly} reaches only 75% < 87.5%.
  expect(res.turf.ladder[1].option).toBe('Glowex');
  expect(res.turf.ladder[1].candidate_id).toBe('n3');
});

test('no paired questions → winner falls back to composite; pairwise and turf null', () => {
  const monadicQs = QUESTIONS.filter((q) => q.methodology === 'monadic' || q.id === 'q1');
  const monadicRows = ROWS.filter((r) => r.question_id.startsWith('q_n'));
  const res = computeNaming(monadicRows, monadicQs, MISSION);
  expect(res.pairwise).toBeNull();
  expect(res.turf).toBeNull();
  // composites: n1 5.5 > n2 5.0 > n3 3.5
  expect(res.winner).toEqual({ candidate_id: 'n1', by: 'composite' });
});

test('no mission context: labels recovered from [bracketed] candidate text in question wording', () => {
  const res = computeNaming(ROWS, QUESTIONS, null);
  const n1 = byId(res, 'n1');
  expect(n1.label).toBe('Lumio'); // from 'On a 1-7 scale, how memorable is [Lumio]?'
  expect(n1.pairwise_win_rate.pct).toBe(75); // paired options still map onto n1
  expect(res.winner).toEqual({ candidate_id: 'n1', by: 'pairwise_win_rate' });
});

test('incomputable → null, never throw (empty + junk inputs)', () => {
  expect(computeNaming([], [], null)).toEqual({
    methodology: 'naming',
    n: 0,
    candidates: [],
    pairwise: null,
    turf: null,
    winner: null,
  });
  expect(() => computeNaming(null, undefined, 42)).not.toThrow();
  expect(computeNaming(null, undefined, 42).methodology).toBe('naming');
  // junk paired answer matches neither option → excluded from base AND appearances
  const res = computeNaming(
    [row('p1', 'qp1', 'Lumio'), row('p2', 'qp1', 'not a real option')],
    QUESTIONS,
    MISSION,
  );
  expect(byId(res, 'n1').pairwise_win_rate).toEqual({ pct: 100, wins: 1, appearances: 1 });
});
