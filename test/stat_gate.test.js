/* WO §2.4 — statistical-integrity gate unit tests. */
const { computeStatGate, RECOMMENDED_N } = require('../src/services/report/statGate');

describe('computeStatGate', () => {
  test('pricing below n=30 is directional and suppresses the headline OPP', () => {
    const g = computeStatGate('pricing', { methodology: 'pricing', n: 5, van_westendorp: { points: { opp: 95 } } }, 5);
    expect(g.posture).toBe('directional');
    expect(g.suppress_headline).toBe(true);
    expect(g.reason).toBe('below_threshold');
    expect(g.note).toMatch(/price point/i);
  });

  test('pricing at n>=30 is authoritative', () => {
    const g = computeStatGate('pricing', { methodology: 'pricing', n: 40 }, 40);
    expect(g.posture).toBe('authoritative');
    expect(g.suppress_headline).toBe(false);
    expect(g.note).toBeNull();
  });

  test('roadmap below n=30 suppresses the ranking headline', () => {
    const g = computeStatGate('roadmap', { methodology: 'roadmap', n: 12 }, 12);
    expect(g.posture).toBe('directional');
    expect(g.suppress_headline).toBe(true);
    expect(g.note).toMatch(/priority order/i);
  });

  test('audience_profiling needs n>=50 to cluster', () => {
    expect(computeStatGate('audience_profiling', { n: 40 }, 40).suppress_headline).toBe(true);
    expect(computeStatGate('audience_profiling', { n: 60 }, 60).posture).toBe('authoritative');
  });

  test('satisfaction is soft-gated: number stands, note added, never suppressed', () => {
    const g = computeStatGate('satisfaction', { methodology: 'satisfaction', n: 8 }, 8);
    expect(g.posture).toBe('directional');
    expect(g.suppress_headline).toBe(false);
    expect(g.reason).toBe('small_base');
    expect(g.note).toMatch(/n=8/);
  });

  test('incomputable analysis is always directional regardless of n', () => {
    const g = computeStatGate('pricing', { methodology: 'pricing', n: 200, van_westendorp_degenerate_reason: 'fewer than 2 respondents with all 4 VW answers' }, 200);
    expect(g.posture).toBe('directional');
    expect(g.reason).toBe('incomputable');
    expect(g.note).toMatch(/^Fewer than 2/);
  });

  test('healthy large sample is authoritative with no note', () => {
    const g = computeStatGate('satisfaction', { n: 120 }, 120);
    expect(g.posture).toBe('authoritative');
    expect(g.note).toBeNull();
  });

  test('falls back to analysis.n when n arg missing', () => {
    expect(computeStatGate('pricing', { n: 5 }, null).n).toBe(5);
  });

  test('RECOMMENDED_N exposes per-method setup guidance', () => {
    expect(RECOMMENDED_N.pricing).toBe(30);
    expect(RECOMMENDED_N.audience_profiling).toBe(50);
  });
});
