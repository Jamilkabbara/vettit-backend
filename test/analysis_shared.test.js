/**
 * Pass 46 Phase 3 — shared analysis primitives, hand-computed fixtures.
 * These primitives underpin every methodology module; if they drift,
 * every report number drifts.
 */

const {
  num, byQuestion, distribution, ratingStats,
  twoProportionTest, normalCdf, curveIntersection, shares, personaCount,
} = require('../src/services/analysis/shared');

test('num coercion: junk → null, numerics pass', () => {
  expect(num('')).toBeNull();
  expect(num(null)).toBeNull();
  expect(num('abc')).toBeNull();
  expect(num('4')).toBe(4);
  expect(num(3.5)).toBe(3.5);
});

test('distribution counts multi-select answers per selection', () => {
  const rows = [
    { persona_id: 'p1', question_id: 'q', answer: ['A', 'B'] },
    { persona_id: 'p2', question_id: 'q', answer: ['A'] },
    { persona_id: 'p3', question_id: 'q', answer: 'C' },
    { persona_id: 'p4', question_id: 'q', answer: null },
  ];
  expect(distribution(rows)).toEqual({ A: 2, B: 1, C: 1 });
});

test('ratingStats: hand-computed mean/sd/CI for [4,5,3,4,4]', () => {
  const s = ratingStats([4, 5, 3, 4, 4].map((v, i) => ({ persona_id: `p${i}`, answer: v })));
  expect(s.n).toBe(5);
  expect(s.mean).toBe(4);
  expect(s.stddev).toBeCloseTo(0.7071, 3);
  expect(s.ci_low).toBeCloseTo(4 - 1.96 * (0.70711 / Math.sqrt(5)), 3);
  expect(s.ci_high).toBeCloseTo(4 + 1.96 * (0.70711 / Math.sqrt(5)), 3);
});

test('ratingStats: empty and single-value edges', () => {
  expect(ratingStats([])).toBeNull();
  const one = ratingStats([{ persona_id: 'p1', answer: 7 }]);
  expect(one).toEqual({ mean: 7, stddev: 0, n: 1, ci_low: 7, ci_high: 7 });
});

test('normalCdf sanity: Φ(0)=0.5, Φ(1.96)≈0.975', () => {
  expect(normalCdf(0)).toBeCloseTo(0.5, 6);
  expect(normalCdf(1.96)).toBeCloseTo(0.975, 3);
  expect(normalCdf(-1.96)).toBeCloseTo(0.025, 3);
});

test('twoProportionTest: 52% vs 38% at n=50/50 → z≈1.407, NOT sig at 90/95', () => {
  const t = twoProportionTest(26, 50, 19, 50);
  expect(t.p1).toBeCloseTo(0.52, 4);
  expect(t.p2).toBeCloseTo(0.38, 4);
  expect(t.z).toBeCloseTo(1.407, 2);
  expect(t.sig90).toBe(false);
  expect(t.sig95).toBe(false);
});

test('twoProportionTest: 80% vs 40% at n=50/50 → z≈4.08, sig at both levels', () => {
  const t = twoProportionTest(40, 50, 20, 50);
  expect(t.z).toBeCloseTo(4.082, 2);
  expect(t.sig90).toBe(true);
  expect(t.sig95).toBe(true);
  expect(t.p).toBeLessThan(0.001);
});

test('twoProportionTest: degenerate cells → null; identical proportions → z=0', () => {
  expect(twoProportionTest(5, 0, 5, 10)).toBeNull();
  const same = twoProportionTest(5, 10, 5, 10);
  expect(same.z).toBe(0);
  expect(same.sig90).toBe(false);
});

test('curveIntersection: y=x crosses y=10-x at x=5', () => {
  const a = [{ x: 0, y: 0 }, { x: 10, y: 10 }];
  const b = [{ x: 0, y: 10 }, { x: 10, y: 0 }];
  expect(curveIntersection(a, b)).toBeCloseTo(5, 4);
});

test('curveIntersection: non-crossing curves → null', () => {
  const a = [{ x: 0, y: 0 }, { x: 10, y: 1 }];
  const b = [{ x: 0, y: 5 }, { x: 10, y: 6 }];
  expect(curveIntersection(a, b)).toBeNull();
});

test('curveIntersection: interpolates between grid points', () => {
  // A: flat 50. B: rises 0→100 over x∈[0,10] → crosses at x=5 even
  // with no grid point at 5.
  const a = [{ x: 0, y: 50 }, { x: 10, y: 50 }];
  const b = [{ x: 0, y: 0 }, { x: 10, y: 100 }];
  expect(curveIntersection(a, b)).toBeCloseTo(5, 4);
});

test('shares + personaCount + byQuestion', () => {
  const rows = [
    { persona_id: 'p1', question_id: 'q1', answer: 'A' },
    { persona_id: 'p2', question_id: 'q1', answer: 'B' },
    { persona_id: 'p1', question_id: 'q2', answer: 4 },
  ];
  const m = byQuestion(rows);
  expect([...m.keys()].sort()).toEqual(['q1', 'q2']);
  expect(personaCount(rows)).toBe(2);
  const s = shares({ A: 1, B: 3 });
  expect(s.total).toBe(4);
  expect(s.shares.B.pct).toBe(75);
});
