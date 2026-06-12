/**
 * Pass 46 Phase 3 — pricing analysis (Van Westendorp + Gabor-Granger),
 * hand-computed fixtures. Every expected number below is derived by
 * hand in the comments; if computePricing drifts, the report drifts.
 */

const { computePricing, parsePrice } = require('../src/services/analysis/pricing');

// Question fixtures mirror PRICING_SURVEY_GEN_SYSTEM output
// (src/services/claudeAI.js L592-L620): VW questions type="text" with
// vw_band, GG questions type="single" with gg_anchor_index + the price
// in the text, WTP ceiling type="text".
const GG_OPTS = [
  'Definitely would buy', 'Probably would buy', 'Might buy',
  'Probably would NOT buy', 'Definitely would NOT buy',
];
const QUESTIONS = [
  { id: 'q1', methodology: 'screener', type: 'single', options: ['Yes', 'No'] },
  { id: 'q3', methodology: 'van_westendorp', vw_band: 'too_expensive', type: 'text', currency: 'USD' },
  { id: 'q4', methodology: 'van_westendorp', vw_band: 'expensive', type: 'text', currency: 'USD' },
  { id: 'q5', methodology: 'van_westendorp', vw_band: 'bargain', type: 'text', currency: 'USD' },
  { id: 'q6', methodology: 'van_westendorp', vw_band: 'too_cheap', type: 'text', currency: 'USD' },
  { id: 'q7', methodology: 'gabor_granger', gg_anchor_index: 0, currency: 'USD', type: 'single', text: 'At $9, would you buy SnapLens Pro?', options: GG_OPTS },
  { id: 'q8', methodology: 'gabor_granger', gg_anchor_index: 1, currency: 'USD', type: 'single', text: 'At $19, would you buy SnapLens Pro?', options: GG_OPTS },
  { id: 'q9', methodology: 'gabor_granger', gg_anchor_index: 2, currency: 'USD', type: 'single', text: 'At $39, would you buy SnapLens Pro?', options: GG_OPTS },
  { id: 'q10', methodology: 'gabor_granger', gg_anchor_index: 3, currency: 'USD', type: 'single', text: 'At $79, would you buy SnapLens Pro?', options: GG_OPTS },
  { id: 'q11', methodology: 'gabor_granger', gg_anchor_index: 4, currency: 'USD', type: 'single', text: 'At $149, would you buy SnapLens Pro?', options: GG_OPTS },
  { id: 'q12', methodology: 'wtp_ceiling', type: 'text', currency: 'USD', text: "What's the absolute most you'd pay for SnapLens Pro?" },
];

const row = (persona_id, question_id, answer) => ({ persona_id, question_id, answer });

/**
 * VW FIXTURE — 4 respondents, band marginals chosen so all four
 * intersection points are exact by hand. (Per-respondent ordering across
 * bands is irrelevant: the curves are marginal cumulatives.)
 *
 *   too_cheap  (q6): {40, 80, 100, 140}
 *   bargain    (q5): {100, 120, 140, 160}
 *   expensive  (q4): {40, 60, 80, 100}
 *   too_expensive (q3): {40, 80, 100, 140}
 *
 * Union grid (16 stated prices, deduped): {40,60,80,100,120,140,160}.
 * Cumulative % of n=4 at each grid point:
 *   too_cheap(p)=%≥p :     100, 75, 75, 50, 25, 25,  0
 *   bargain(p)=%≥p :       100,100,100,100, 75, 50, 25
 *   expensive(p)=%≤p :      25, 50, 75,100,100,100,100
 *   too_expensive(p)=%≤p :  25, 25, 50, 75, 75,100,100
 *
 * Intersections (linear interpolation on the sign change of A−B):
 *   PMC = too_cheap × expensive:      diffs +75,+25,0 → root at x=80
 *   OPP = too_cheap × too_expensive:  diffs ...,+25(@80),−25(@100) → t=25/50=0.5 → 80+0.5·20 = 90
 *   PME = bargain × too_expensive:    diffs ...,+25(@100),0(@120) → root at x=120
 *   IPP = bargain × expensive:        diffs ...,+25(@80),0(@100) → root at x=100
 * → acceptable_range = {low: 80, high: 120}; OPP = 90 exactly.
 *
 * Answers are formatted strings to exercise parsePrice ('$40', '80', ...).
 */
const VW_ROWS = [
  // p1: tc 40, ba 100, ex 40, te 40
  row('p1', 'q6', '$40'), row('p1', 'q5', '$100'), row('p1', 'q4', '40'), row('p1', 'q3', '$40'),
  // p2: tc 80, ba 120, ex 60, te 80
  row('p2', 'q6', '80'), row('p2', 'q5', '120'), row('p2', 'q4', '$60'), row('p2', 'q3', '80'),
  // p3: tc 100, ba 140, ex 80, te 100
  row('p3', 'q6', '$100'), row('p3', 'q5', '$140'), row('p3', 'q4', '80'), row('p3', 'q3', '$100'),
  // p4: tc 140, ba 160, ex 100, te 140 — prose answer exercises parsePrice
  row('p4', 'q6', 'I would say $140'), row('p4', 'q5', '160'), row('p4', 'q4', '100'), row('p4', 'q3', '140'),
];

/**
 * GG FIXTURE — anchors 9/19/39/79/149 parsed from the question text
 * ("At $<price>, would you ..."), demand = top-2-box of 4 answers:
 *   $9  : 4/4 = 100% → revenue 9 × 1.00 = 9
 *   $19 : 4/4 = 100% → 19 × 1.00 = 19
 *   $39 : 3/4 =  75% → 39 × 0.75 = 29.25   ← max revenue → optimal
 *   $79 : 1/4 =  25% → 79 × 0.25 = 19.75
 *   $149: 0/4 =   0% → 0
 */
const GG_ROWS = [
  row('p1', 'q7', 'Definitely would buy'), row('p2', 'q7', 'Definitely would buy'),
  row('p3', 'q7', 'Definitely would buy'), row('p4', 'q7', 'Definitely would buy'),
  row('p1', 'q8', 'Definitely would buy'), row('p2', 'q8', 'Probably would buy'),
  row('p3', 'q8', 'Definitely would buy'), row('p4', 'q8', 'Probably would buy'),
  row('p1', 'q9', 'Probably would buy'), row('p2', 'q9', 'Definitely would buy'),
  row('p3', 'q9', 'Probably would buy'), row('p4', 'q9', 'Might buy'), // Might buy ≠ demand
  row('p1', 'q10', 'Might buy'), row('p2', 'q10', 'Probably would NOT buy'),
  row('p3', 'q10', 'Probably would buy'), row('p4', 'q10', 'Definitely would NOT buy'),
  row('p1', 'q11', 'Definitely would NOT buy'), row('p2', 'q11', 'Definitely would NOT buy'),
  row('p3', 'q11', 'Probably would NOT buy'), row('p4', 'q11', 'Probably would NOT buy'),
];

/**
 * WTP FIXTURE — parsed values 50, 60, 70, 80:
 *   mean = 65; deviations ±15, ±5 → Σsq = 225+25+25+225 = 500;
 *   var = 500/3 = 166.6667; sd = √166.6667 = 12.9099;
 *   SEM = sd/√4 = 6.4550; half = 1.96 × 6.4550 = 12.6517;
 *   CI = [52.3483, 77.6517].
 */
const WTP_ROWS = [
  row('p1', 'q12', '$50'), row('p2', 'q12', '60'),
  row('p3', 'q12', '$70.00'), row('p4', 'q12', '80'),
];

const ALL_ROWS = [...VW_ROWS, ...GG_ROWS, ...WTP_ROWS];

test('VW: hand-built symmetric fixture → OPP=90, PMC=80, PME=120, IPP=100', () => {
  const out = computePricing(ALL_ROWS, QUESTIONS, null);
  expect(out.methodology).toBe('pricing');
  expect(out.currency).toBe('USD');
  expect(out.n).toBe(4);

  const vw = out.van_westendorp;
  expect(vw).not.toBeNull();
  expect(vw.n).toBe(4);
  expect(out.van_westendorp_degenerate_reason).toBeNull();

  // Full hand-computed curves on the union grid {40..160}.
  expect(vw.curves.too_cheap).toEqual([
    { x: 40, y: 100 }, { x: 60, y: 75 }, { x: 80, y: 75 }, { x: 100, y: 50 },
    { x: 120, y: 25 }, { x: 140, y: 25 }, { x: 160, y: 0 },
  ]);
  expect(vw.curves.bargain).toEqual([
    { x: 40, y: 100 }, { x: 60, y: 100 }, { x: 80, y: 100 }, { x: 100, y: 100 },
    { x: 120, y: 75 }, { x: 140, y: 50 }, { x: 160, y: 25 },
  ]);
  expect(vw.curves.expensive).toEqual([
    { x: 40, y: 25 }, { x: 60, y: 50 }, { x: 80, y: 75 }, { x: 100, y: 100 },
    { x: 120, y: 100 }, { x: 140, y: 100 }, { x: 160, y: 100 },
  ]);
  expect(vw.curves.too_expensive).toEqual([
    { x: 40, y: 25 }, { x: 60, y: 25 }, { x: 80, y: 50 }, { x: 100, y: 75 },
    { x: 120, y: 75 }, { x: 140, y: 100 }, { x: 160, y: 100 },
  ]);

  expect(vw.points).toEqual({ pmc: 80, pme: 120, opp: 90, ipp: 100 });
  expect(out.acceptable_range).toEqual({ low: 80, high: 120 });
});

test('GG: ladder parsed from question text, demand top-2-box, optimal=$39', () => {
  const out = computePricing(ALL_ROWS, QUESTIONS, null);
  const gg = out.gabor_granger;
  expect(gg).not.toBeNull();
  expect(out.gabor_granger_degenerate_reason).toBeNull();
  expect(gg.ladder).toEqual([
    { price: 9, n: 4, demand_pct: 100, revenue_index: 9 },
    { price: 19, n: 4, demand_pct: 100, revenue_index: 19 },
    { price: 39, n: 4, demand_pct: 75, revenue_index: 29.25 },
    { price: 79, n: 4, demand_pct: 25, revenue_index: 19.75 },
    { price: 149, n: 4, demand_pct: 0, revenue_index: 0 },
  ]);
  expect(gg.optimal_price).toBe(39);
});

test('GG: revenue tie goes to the LOWER price', () => {
  // $10 × 100% = 10 and $20 × 50% = 10 → tie → optimal 10.
  const qs = [
    { id: 'g1', methodology: 'gabor_granger', gg_anchor_index: 0, currency: 'USD', type: 'single', text: 'At $10, would you buy it?', options: GG_OPTS },
    { id: 'g2', methodology: 'gabor_granger', gg_anchor_index: 1, currency: 'USD', type: 'single', text: 'At $20, would you buy it?', options: GG_OPTS },
  ];
  const rows = [
    row('p1', 'g1', 'Definitely would buy'), row('p2', 'g1', 'Probably would buy'),
    row('p1', 'g2', 'Definitely would buy'), row('p2', 'g2', 'Definitely would NOT buy'),
  ];
  const out = computePricing(rows, qs, null);
  expect(out.gabor_granger.ladder.map((r) => r.revenue_index)).toEqual([10, 10]);
  expect(out.gabor_granger.optimal_price).toBe(10);
});

test('WTP ceiling: ratingStats over parsed prices (mean 65, CI 52.3483-77.6517)', () => {
  const out = computePricing(ALL_ROWS, QUESTIONS, null);
  expect(out.wtp_ceiling).toEqual({
    mean: 65, stddev: 12.9099, n: 4, ci_low: 52.3483, ci_high: 77.6517,
  });
});

test('VW degenerate: <2 complete respondents → null with degenerate_reason', () => {
  // p1 answers all 4 bands; p2 answers only 2 → complete-case n = 1.
  const rows = [
    row('p1', 'q6', '$50'), row('p1', 'q5', '$60'), row('p1', 'q4', '$80'), row('p1', 'q3', '$100'),
    row('p2', 'q6', '$40'), row('p2', 'q5', '$70'),
  ];
  const out = computePricing(rows, QUESTIONS.slice(0, 5), null); // screener + 4 VW only
  expect(out.van_westendorp).toBeNull();
  expect(out.van_westendorp_degenerate_reason).toMatch(/n=1/);
  expect(out.acceptable_range).toBeNull();
  expect(out.gabor_granger).toBeNull();
  expect(out.gabor_granger_degenerate_reason).toMatch(/no gabor_granger questions/);
  expect(out.wtp_ceiling).toBeNull();
  expect(out.n).toBe(2);
});

test('parsePrice: currency symbols, commas, prose, junk', () => {
  expect(parsePrice(40)).toBe(40);
  expect(parsePrice('$1,299.99')).toBe(1299.99);
  expect(parsePrice("I'd say around $40, maybe $50")).toBe(40); // first number wins
  expect(parsePrice('USD 2,000')).toBe(2000);
  expect(parsePrice('no idea')).toBeNull();
  expect(parsePrice(null)).toBeNull();
  expect(parsePrice('')).toBeNull();
});

test('VW with comma-formatted prices: grid parses, OPP interpolates (1800)', () => {
  // tc {1000, 2000}, ba {1200, 2200}, ex {1500, 2500}, te {1800, 2800}; n=2.
  // too_cheap %≥p on grid: 1000:100, 1200:50 ... 2000:50, 2200:0.
  // too_expensive %≤p: ...1500:0, 1800:50 → diff +50(@1500), 0(@1800) → OPP=1800.
  const rows = [
    row('pA', 'q6', '$1,000'), row('pA', 'q5', '$1,200'), row('pA', 'q4', '$1,500'), row('pA', 'q3', '$1,800'),
    row('pB', 'q6', '$2,000'), row('pB', 'q5', '$2,200'), row('pB', 'q4', '$2,500'), row('pB', 'q3', '$2,800'),
  ];
  const out = computePricing(rows, QUESTIONS, null);
  expect(out.van_westendorp.n).toBe(2);
  expect(out.van_westendorp.curves.too_cheap[0]).toEqual({ x: 1000, y: 100 });
  expect(out.van_westendorp.points.opp).toBe(1800);
});

test('never throws: empty / malformed inputs → all-null sections', () => {
  const out = computePricing([], [], null);
  expect(out.methodology).toBe('pricing');
  expect(out.currency).toBe('USD');
  expect(out.n).toBe(0);
  expect(out.van_westendorp).toBeNull();
  expect(out.gabor_granger).toBeNull();
  expect(out.wtp_ceiling).toBeNull();
  expect(out.acceptable_range).toBeNull();
  expect(() => computePricing(null, undefined, undefined)).not.toThrow();
  expect(() => computePricing([{ bogus: true }, null], [null, 7], { clarify_answers: null })).not.toThrow();
});
