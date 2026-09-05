/**
 * n=0 must be the MOST suppressed state, not the least.
 *
 * computeStatGate's small-base branch reads `if (N > 0 && N < SOFT_THRESHOLD)`.
 * Zero fails the `N > 0` test and fell all the way through to the final
 * `return { posture: 'authoritative' }`. Measured on origin/main:
 *
 *     validate n=5  -> directional
 *     validate n=0  -> AUTHORITATIVE, headline shown
 *
 * The gate was strictly less honest with no data than with five responses.
 *
 * Reachable today: any mission whose responses all fail to persist lands
 * here. Hard-gated methodologies (pricing, roadmap, market_entry,
 * audience_profiling) were protected only by accident, because
 * `hard && N < hard` happens to catch zero first - so the hole was invisible
 * wherever anyone thought to look.
 *
 * `test/stat_gate.test.js` has nine tests and none of them passes n=0.
 */
const { computeStatGate, HARD_GATES } = require('../src/services/report/statGate');

const SOFT_GATED = 'validate';          // no entry in HARD_GATES
const HARD_GATED = 'pricing';           // HARD_GATES.pricing = 30
const UNKNOWN    = 'document_analysis'; // an unmapped methodology

describe('no sample is the weakest posture, not the strongest', () => {
  test('the fixture methodologies are what this test thinks they are', () => {
    // Guards against the suite going vacuous if HARD_GATES is reorganised.
    expect(HARD_GATES[SOFT_GATED]).toBeUndefined();
    expect(HARD_GATES[HARD_GATED]).toBeGreaterThan(0);
    expect(HARD_GATES[UNKNOWN]).toBeUndefined();
  });

  test.each([
    ['soft-gated', SOFT_GATED],
    ['hard-gated', HARD_GATED],
    ['unmapped',   UNKNOWN],
  ])('%s methodology at n=0 is directional AND suppressed', (_label, methodology) => {
    const g = computeStatGate(methodology, {}, 0);
    expect(g.posture).toBe('directional');
    expect(g.suppress_headline).toBe(true);
    expect(g.n).toBe(0);
    expect(g.note).toMatch(/no respondent data/i);
  });

  test.each([[null], [undefined], [NaN], ['']])(
    'a missing count (%p) is treated as no sample, not as authority', (n) => {
      const g = computeStatGate(SOFT_GATED, {}, n);
      expect(g.posture).toBe('directional');
      expect(g.suppress_headline).toBe(true);
    });

  test('n=0 is never MORE authoritative than n=5 - the actual inversion', () => {
    const zero = computeStatGate(SOFT_GATED, {}, 0);
    const five = computeStatGate(SOFT_GATED, {}, 5);
    // Both directional now. The bug was zero='authoritative', five='directional'.
    expect(zero.posture).toBe('directional');
    expect(five.posture).toBe('directional');
    // And zero must suppress where five does not: less evidence, more caution.
    expect(zero.suppress_headline).toBe(true);
    expect(five.suppress_headline).toBe(false);
  });

  test('a real sample is still authoritative - positive control', () => {
    const g = computeStatGate(SOFT_GATED, {}, 50);
    expect(g.posture).toBe('authoritative');
    expect(g.suppress_headline).toBe(false);
    expect(g.reason).toBeNull();
  });

  test('the small-base branch still fires between 1 and the soft threshold', () => {
    const g = computeStatGate(SOFT_GATED, {}, 5);
    expect(g.reason).toBe('small_base');
  });

  test('analysis.n is used when the n argument is absent', () => {
    expect(computeStatGate(SOFT_GATED, { n: 50 }, null).posture).toBe('authoritative');
    expect(computeStatGate(SOFT_GATED, { n: 0 }, null).suppress_headline).toBe(true);
  });
});
