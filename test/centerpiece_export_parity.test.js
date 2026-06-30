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

describe('creative_attention export centerpiece + headline', () => {
  // CA's signature lives in mission.creative_analysis (a vision analysis), NOT
  // the survey `analysis` — so it's wired in via the mission, not the param.
  const renderCA = (creative_analysis) => {
    const mission = { id: 't', title: 'T', goal_type: 'creative_attention', questions: {}, creative_analysis };
    return buildRenderModel(buildCanonicalReport(mission, null, []));
  };
  const ca = {
    summary: {
      overall_engagement_score: 70,
      vs_benchmark: 'Performs above the luxury benchmark on engagement.',
      strengths: ['Trust and pride dominate.'], weaknesses: ['Joy runs low.'],
      recommendations: ['Add a typographic anchor.', 'Introduce warmth.'],
      emotion_peaks: [{ emotion: 'trust', peak_value: 65 }, { emotion: 'pride', peak_value: 55 }],
      best_platform_fit: [
        { platform: 'Instagram Feed', fit_score: 88, predicted_creative_attention_seconds: 1.7, platform_norm_active_attention_seconds: 1.2, delta_vs_norm_pct: 42 },
        { platform: 'Print', fit_score: 90, predicted_creative_attention_seconds: 3.2, platform_norm_active_attention_seconds: 2.5, delta_vs_norm_pct: 28 },
      ],
    },
    attention: { active_attention_pct: 60, passive_attention_pct: 40, non_attention_pct: 0, distinctive_brand_asset_score: 74, predicted_active_attention_seconds: 1.8 },
  };

  test('centerpiece = per-channel fit grid, sorted by fit desc', () => {
    const cp = renderCA(ca).centerpiece;
    expect(cp).not.toBeNull();
    expect(cp.title).toMatch(/channel fit/i);
    expect(cp.columns).toHaveLength(5);
    expect(cp.rows).toHaveLength(2);
    expect(cp.rows[0]).toEqual(['Print', '90', '3.2s', '2.5s', '+28%']); // highest fit first
    expect(cp.rows[1]).toEqual(['Instagram Feed', '88', '1.7s', '1.2s', '+42%']);
  });

  test('headline carries the attention scorecard (no empty headline for CA)', () => {
    const h = renderCA(ca).headline;
    expect(h).not.toBeNull();
    expect(h.primary.label).toBe('Overall engagement (0-100)');
    expect(h.all).toEqual(expect.arrayContaining([
      { label: 'Active attention', value: '60%' },
      { label: 'Distinctive brand asset (0-100)', value: '74' },
      { label: 'Strongest emotion', value: 'Trust (65)' },
      { label: 'Best channel fit', value: 'Print (90/100)' },
    ]));
  });

  test('narrative + recs + key findings come from creative_analysis (insights null)', () => {
    const m = renderCA(ca);
    expect(m.synthesis).toMatch(/above the luxury benchmark/i);
    expect(m.recommendations).toEqual(['Add a typographic anchor.', 'Introduce warmth.']);
    // D7 — the render model scrubs the em-dash AI tell: " — " becomes ", ".
    expect(m.keyFindings.map((f) => f.title)).toEqual(['Strength, Trust and pride dominate.', 'Watch-out, Joy runs low.']);
    expect(m.gate).toBeNull(); // CA skips the survey stat-gate
  });

  test('no channel fit → falls back to the attention scorecard table', () => {
    const cp = renderCA({ summary: { overall_engagement_score: 70 }, attention: ca.attention }).centerpiece;
    expect(cp.title).toMatch(/scorecard/i);
    expect(cp.rows).toEqual(expect.arrayContaining([['Active attention', '60%'], ['Distinctive brand asset (0-100)', '74']]));
  });

  test('no creative_analysis data → centerpiece null (graceful)', () => {
    expect(renderCA({ summary: {}, attention: {} }).centerpiece).toBeNull();
  });
});

describe('§3 signature export parity — every methodology emits its instrument table', () => {
  test('pricing — Van Westendorp + Gabor-Granger', () => {
    const cp = centerpieceFor('pricing', {
      methodology: 'pricing', van_westendorp: { points: { opp: 49, pmc: 29, ipp: 45, pme: 79 } },
      acceptable_range: { low: 35, high: 69 }, gabor_granger: { optimal_price: 55 },
    });
    expect(cp).not.toBeNull();
    expect(cp.title).toMatch(/Van Westendorp/i);
    expect(cp.rows).toEqual(expect.arrayContaining([['Optimal price (OPP)', '49'], ['Acceptable range', '35-69']]));
  });

  test('satisfaction — NPS / CSAT / CES', () => {
    const cp = centerpieceFor('satisfaction', {
      methodology: 'satisfaction', nps: { score: 42, promoters_pct: 55, passives_pct: 32, detractors_pct: 13 },
      csat: { top2_pct: 78 }, ces: { top2_pct: 66 },
    });
    expect(cp.title).toMatch(/NPS/i);
    expect(cp.rows).toEqual(expect.arrayContaining([['NPS', '42'], ['CSAT (top-2-box)', '78%']]));
  });

  test('roadmap — MaxDiff utility + Kano class', () => {
    const cp = centerpieceFor('roadmap', {
      methodology: 'roadmap',
      maxdiff: { features: [{ feature_id: 'f1', label: 'Dark mode', utility: 2.1 }, { feature_id: 'f2', label: 'SSO', utility: 1.3 }] },
      kano: { features: [{ feature_id: 'f1', classification: 'attractive' }, { feature_id: 'f2', classification: 'must_be' }] },
    });
    expect(cp.title).toMatch(/MaxDiff/i);
    expect(cp.rows[0]).toEqual(['Dark mode', '2.1', 'Delighter']); // highest utility first
    expect(cp.rows[1]).toEqual(['SSO', '1.3', 'Must-have']);
  });

  test('naming — TURF reach when present', () => {
    const cp = centerpieceFor('naming', {
      methodology: 'naming',
      turf: { ladder: [{ option: 'Nimbus', incremental_reach_pct: 40, cumulative_reach_pct: 40 }, { option: 'Vortex', incremental_reach_pct: 25, cumulative_reach_pct: 65 }] },
    });
    expect(cp.title).toMatch(/TURF/i);
    expect(cp.rows[1]).toEqual(['Vortex', '25%', '65%']);
  });

  test('naming — win-rate ranking when no TURF', () => {
    const cp = centerpieceFor('naming', {
      methodology: 'naming',
      candidates: [{ candidate_id: 'c1', label: 'Nimbus', pairwise_win_rate: { pct: 62 } }, { candidate_id: 'c2', label: 'Vortex', pairwise_win_rate: { pct: 38 } }],
      winner: { candidate_id: 'c1' },
    });
    expect(cp.title).toMatch(/win rate/i);
    expect(cp.rows[0]).toEqual(['Nimbus', '62%', 'Yes']);
  });

  test('competitor — share of preference (sorted, focal flagged)', () => {
    const cp = centerpieceFor('competitor', {
      methodology: 'competitor', focal_brand: 'Acme',
      brands: [{ label: 'Acme', is_focal: true, preference_pct: 45, nps: { score: 30 } }, { label: 'Rival', preference_pct: 55, nps: { score: 10 } }],
    });
    expect(cp.title).toMatch(/preference/i);
    expect(cp.rows[0]).toEqual(['Rival', '55%', '10']);       // highest share first
    expect(cp.rows[1]).toEqual(['Acme (focal)', '45%', '30']);
  });

  test('churn — drivers + win-back', () => {
    const cp = centerpieceFor('churn', {
      methodology: 'churn',
      drivers: { ranked: [{ reason: 'Price', pct_of_respondents: 40 }, { reason: 'Support', pct_of_respondents: 25 }] },
      winback: { winnable_pct: 35 },
    });
    expect(cp.title).toMatch(/churn/i);
    expect(cp.rows[0]).toEqual(['Driver: Price', '40%']);
    expect(cp.rows[cp.rows.length - 1]).toEqual(['Winnable (would return)', '35%']);
  });

  test('compare — head-to-head forced choice', () => {
    const cp = centerpieceFor('compare', {
      methodology: 'compare',
      concepts: [{ concept_id: 'a', label: 'Concept A', final_choice_pct: { pct: 60 } }, { concept_id: 'b', label: 'Concept B', final_choice_pct: { pct: 30 } }],
      overall_winner: { concept_id: 'a' }, final_choice: { none: { pct: 10 } },
    });
    expect(cp.title).toMatch(/head-to-head/i);
    expect(cp.rows[0]).toEqual(['Concept A', '60%', 'Yes']);
    expect(cp.rows).toContainEqual(['None of these', '10%', '']);
  });
});

describe('§9 — directional (small n) softens false precision; authoritative keeps it', () => {
  const roadmap = (n) => ({
    methodology: 'roadmap', n,
    maxdiff: { features: [{ feature_id: 'f1', label: 'A', utility: 0.1778 }, { feature_id: 'f2', label: 'B', utility: -0.3556 }] },
    kano: { features: [] },
  });

  test('directional roadmap (n=5) rounds 2-dp utilities to 1 dp', () => {
    const cp = centerpieceFor('roadmap', roadmap(5));
    // D7 — the empty Kano-class cell renders "n/a", not a lone em-dash.
    expect(cp.rows[0]).toEqual(['A', '0.2', 'n/a']);   // 0.18 → 0.2
    expect(cp.rows[1]).toEqual(['B', '-0.4', 'n/a']);  // -0.36 → -0.4
  });

  test('authoritative roadmap (n=80) keeps full 2-dp precision', () => {
    const cp = centerpieceFor('roadmap', roadmap(80));
    expect(cp.rows[0]).toEqual(['A', '0.18', 'n/a']);  // unchanged
    expect(cp.rows[1]).toEqual(['B', '-0.36', 'n/a']);
  });

  test('directional softens decimal percentages to whole numbers', () => {
    const cp = centerpieceFor('satisfaction', {
      methodology: 'satisfaction', n: 6,
      nps: { score: 12, promoters_pct: 33.33, passives_pct: 33.33, detractors_pct: 33.34 },
      csat: { top2_pct: 66.7 },
    });
    // 33.33% → 34% (Promoters), 66.7% → 67% (CSAT) at directional n
    expect(cp.rows).toEqual(expect.arrayContaining([['Promoters', '33%'], ['CSAT (top-2-box)', '67%']]));
  });
});

describe('headline-only types + empty data fall back to the headline (centerpiece null)', () => {
  test('validate / marketing / research have no dedicated centerpiece', () => {
    expect(centerpieceFor('validate', { methodology: 'validate', scores: { reaction: { mean: 7 } } })).toBeNull();
    expect(centerpieceFor('marketing', { methodology: 'marketing', funnel: { likeability: { mean: 5 } } })).toBeNull();
    expect(centerpieceFor('research', { methodology: 'research', n: 50 })).toBeNull();
  });
  test('a signature type with no computed data falls back (no empty table)', () => {
    expect(centerpieceFor('pricing', { methodology: 'pricing', van_westendorp: {} })).toBeNull();
    expect(centerpieceFor('roadmap', { methodology: 'roadmap', maxdiff: { features: [] } })).toBeNull();
    expect(centerpieceFor('competitor', { methodology: 'competitor', brands: [] })).toBeNull();
  });
});
