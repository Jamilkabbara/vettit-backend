// Pass 25 Phase 0.1 — unit tests for the export integrity util.
// Validates schema-drift detection, option-overlap detection, and the
// substring-overlap helper. The PATCH 409 guard is integration-shaped and
// tested via the live route; this file covers the pure-function surface.

const {
  detectSchemaDrift,
  detectOptionOverlap,
  buildIntegrityWarnings,
  substringOverlap,
} = require('../src/services/exports/integrity');

describe('integrity.detectSchemaDrift', () => {
  it('flags distribution keys not in schema options', () => {
    const m = { questions: [{ id: 'q1', type: 'multi', text: 't', options: ['A', 'B'] }] };
    const agg = { q1: { distribution: { 'A': 2, 'C': 1 } } };
    const w = detectSchemaDrift(m, agg);
    expect(w).toHaveLength(1);
    expect(w[0].type).toBe('unknown_distribution_key');
    expect(w[0].drifted_keys).toEqual(['C']);
  });

  it('returns no warnings when all keys are canonical', () => {
    const m = { questions: [{ id: 'q1', type: 'single', text: 't', options: ['A', 'B'] }] };
    const agg = { q1: { distribution: { 'A': 5, 'B': 3 } } };
    expect(detectSchemaDrift(m, agg)).toEqual([]);
  });

  it('skips text and rating questions', () => {
    const m = { questions: [
      { id: 'q1', type: 'rating', text: 't', options: [] },
      { id: 'q2', type: 'text', text: 't', options: [] },
    ]};
    const agg = { q1: { distribution: { 5: 4 } }, q2: { verbatims: ['nope'] } };
    expect(detectSchemaDrift(m, agg)).toEqual([]);
  });

  it('skips questions whose options array is empty', () => {
    const m = { questions: [{ id: 'q1', type: 'single', text: 't', options: [] }] };
    const agg = { q1: { distribution: { 'X': 1 } } };
    expect(detectSchemaDrift(m, agg)).toEqual([]);
  });
});

describe('integrity.substringOverlap', () => {
  it('returns 1 when one option is a substring of the other', () => {
    expect(substringOverlap('Apple', 'Apple pie')).toBe(1);
  });

  it('returns 0 for unrelated strings', () => {
    expect(substringOverlap('cats', 'mortgage')).toBe(0);
  });

  it('matches the rewarded video ads case (>= 0.6)', () => {
    expect(substringOverlap('Rewarded video ads', 'Interstitial and rewarded video ads')).toBeGreaterThanOrEqual(0.6);
  });
});

describe('integrity.detectOptionOverlap', () => {
  it('flags pairs above threshold', () => {
    const m = { questions: [{ id: 'q1', type: 'multi', text: 't', options: ['Apple', 'Apple pie', 'Orange'] }] };
    const w = detectOptionOverlap(m);
    expect(w).toHaveLength(1);
    expect(w[0].type).toBe('semantic_option_overlap');
  });

  it('returns empty when options are distinct', () => {
    const m = { questions: [{ id: 'q1', type: 'multi', text: 't', options: ['Cats', 'Dogs', 'Fish'] }] };
    expect(detectOptionOverlap(m)).toEqual([]);
  });
});

describe('integrity.buildIntegrityWarnings', () => {
  it('combines drift + overlap into one list', () => {
    const m = { questions: [{ id: 'q1', type: 'multi', text: 't', options: ['Apple', 'Apple pie'] }] };
    const agg = { q1: { distribution: { 'Apple': 2, 'Mango': 1 } } };
    const w = buildIntegrityWarnings(m, agg);
    expect(w.length).toBeGreaterThanOrEqual(2);
    expect(w.some(x => x.type === 'unknown_distribution_key')).toBe(true);
    expect(w.some(x => x.type === 'semantic_option_overlap')).toBe(true);
  });
});
