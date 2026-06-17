/* WO §4 export parity — market_entry + audience_profiling must emit a
 * signature centerpiece TABLE in the canonical render model, so the exports
 * (PDF/PPTX/XLSX) carry the same per-market / per-segment grid the web heroes
 * show. Regression guard: before this, buildCenterpiece returned null for both
 * and the exports silently dropped the hero. */
const { buildCanonicalReport } = require('../src/services/report/buildReport');
const { buildRenderModel } = require('../src/services/report/reportRenderModel');

function centerpieceFor(goal_type, analysis) {
  const mission = { id: 't', title: 'T', goal_type, questions: [], respondent_count: analysis.n || 0 };
  return buildRenderModel(buildCanonicalReport(mission, analysis, [])).centerpiece;
}

describe('market_entry export centerpiece', () => {
  const analysis = {
    methodology: 'market_entry', n: 72,
    markets: [
      { market: 'Saudi Arabia', n: 40, directional: false, demand_index: 77, signal: 'go', purchase_intent_pct: 70, appeal_mean: 6.35, wtp: 150, barriers: [{ label: 'Lack of awareness', pct: 35 }], competitors: [] },
      { market: 'Egypt', n: 32, directional: false, demand_index: 47, signal: 'caution', purchase_intent_pct: 40.6, appeal_mean: 4.34, wtp: 89.06, barriers: [{ label: 'Prefer local brands', pct: 56.25 }], competitors: [] },
    ],
    recommended_market: 'Saudi Arabia', best_demand_index: 77, top_barrier: 'Lack of awareness',
  };

  test('emits a per-market scorecard table', () => {
    const cp = centerpieceFor('market_entry', analysis);
    expect(cp).not.toBeNull();
    expect(cp.title).toMatch(/scorecard/i);
    expect(cp.columns).toHaveLength(8);
    expect(cp.columns).toEqual(expect.arrayContaining(['Market', 'Demand (0-100)', 'Signal', 'WTP', 'Top barrier']));
    expect(cp.rows).toHaveLength(2);
    expect(cp.rows[0]).toEqual(['Saudi Arabia', '77', 'GO', '70%', '6.35', '150', 'Lack of awareness (35%)', '40']);
    expect(cp.rows[1][2]).toBe('CAUTION');
  });

  test('flags a directional (small-n) market in its label', () => {
    const small = { ...analysis, markets: [{ ...analysis.markets[0], n: 12, directional: true }] };
    const cp = centerpieceFor('market_entry', small);
    expect(cp.rows[0][0]).toBe('Saudi Arabia (directional)');
  });

  test('no markets → no table (falls back to headline)', () => {
    expect(centerpieceFor('market_entry', { methodology: 'market_entry', n: 0, markets: [] })).toBeNull();
  });
});

describe('audience_profiling export centerpiece', () => {
  const analysis = {
    methodology: 'audience_profiling', n: 60, posture: 'segmented',
    segments: [
      { id: 's1', name: 'Value Seekers', size_pct: 55, n: 33, is_primary: true,
        signature: [{ dimension: 'price_sensitivity', label: 'Price sensitivity', mean: 5.2, delta: 1.4 },
                    { dimension: 'novelty_seeking', label: 'Novelty seeking', mean: 3.1, delta: -0.8 }] },
      { id: 's2', name: 'Premium Loyalists', size_pct: 45, n: 27, is_primary: false,
        signature: [{ dimension: 'brand_loyalty', label: 'Brand loyalty', mean: 6.0, delta: 1.9 }] },
    ],
    primary_segment_id: 's1', segment_count: 2,
  };

  test('emits a per-segment table with size + defining trait', () => {
    const cp = centerpieceFor('audience_profiling', analysis);
    expect(cp).not.toBeNull();
    expect(cp.title).toMatch(/segments/i);
    expect(cp.rows).toHaveLength(2);
    // defining trait = the signature dimension with the largest |delta|
    expect(cp.rows[0]).toEqual(['Value Seekers', '55%', '33', 'Price sensitivity (+1.4)', 'Yes']);
    expect(cp.rows[1][4]).toBe(''); // not primary
  });

  test('aggregate-only (segments null) → no table', () => {
    expect(centerpieceFor('audience_profiling', { methodology: 'audience_profiling', n: 20, segments: null })).toBeNull();
  });
});

describe('types without a dedicated centerpiece still return null', () => {
  test('pricing centerpiece is null (headline carries VW/GG)', () => {
    expect(centerpieceFor('pricing', { methodology: 'pricing', n: 50, van_westendorp: {} })).toBeNull();
  });
});
