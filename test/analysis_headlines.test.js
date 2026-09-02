/**
 * Pass 47 Phase 4 — analysisHeadlines() unit tests.
 *
 * Fixtures are hand-built analysis objects in the EXACT shape the Pass-46
 * Phase-3 modules emit (field paths mirror src/services/ai/insights.js
 * buildComputedSummary). We assert the key computed metrics surface as
 * { label, value } rows so every export format carries the research-grade
 * centerpiece numbers.
 */

const { analysisHeadlines, brandLiftStageTable } = require('../src/services/exports/analysisHeadlines');

// Helper — find a row by a substring of its label, return its value.
const valOf = (rows, labelSub) => {
  const r = rows.find((x) => x.label.includes(labelSub));
  return r ? r.value : undefined;
};

describe('analysisHeadlines — null / unknown', () => {
  test('null → []', () => expect(analysisHeadlines(null)).toEqual([]));
  test('undefined → []', () => expect(analysisHeadlines(undefined)).toEqual([]));
  test('non-object → []', () => expect(analysisHeadlines('x')).toEqual([]));
  test('unknown methodology → []', () => {
    expect(analysisHeadlines({ methodology: 'made_up', n: 5 })).toEqual([]);
  });
  test('every row is {label,value} strings', () => {
    const rows = analysisHeadlines({
      methodology: 'pricing',
      currency: 'USD',
      van_westendorp: { n: 4, points: { opp: 95, pmc: 72, pme: 110, ipp: 88 } },
      gabor_granger: { optimal_price: 79 },
      acceptable_range: { low: 72, high: 110 },
    });
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) {
      expect(typeof r.label).toBe('string');
      expect(typeof r.value).toBe('string');
    }
  });
});

describe('analysisHeadlines — pricing', () => {
  const analysis = {
    methodology: 'pricing',
    currency: 'USD',
    n: 8,
    van_westendorp: { n: 4, points: { opp: 95, pmc: 72, pme: 110, ipp: 88 } },
    gabor_granger: { optimal_price: 79 },
    wtp_ceiling: { mean: 102.5 },
    acceptable_range: { low: 72, high: 110 },
  };
  test('OPP + acceptable range + Gabor-Granger', () => {
    const rows = analysisHeadlines(analysis);
    expect(valOf(rows, 'Optimal price (Van Westendorp OPP)')).toBe('95');
    expect(valOf(rows, 'Acceptable price range')).toBe('72-110'); // D7: en-dash range → hyphen
    expect(valOf(rows, 'Gabor-Granger')).toBe('79');
    expect(valOf(rows, 'WTP ceiling')).toBe('102.5');
    expect(valOf(rows, 'Currency')).toBe('USD');
  });
  test('null sections are skipped, never thrown', () => {
    const rows = analysisHeadlines({ methodology: 'pricing', currency: 'USD', van_westendorp: null, gabor_granger: null, acceptable_range: null });
    // currency still surfaces; no price rows.
    expect(valOf(rows, 'Currency')).toBe('USD');
    expect(valOf(rows, 'Optimal price')).toBeUndefined();
  });
});

describe('analysisHeadlines — satisfaction', () => {
  const analysis = {
    methodology: 'satisfaction',
    n: 10,
    nps: { score: -20, n: 10, segments: {} },
    csat: { top2_pct: 80, n: 10 },
    ces: { top2_pct: 60, n: 10 },
    retention: { stats: { mean: 3.4 }, n: 10 },
    issues: { ranked: [{ option: 'Price', count: 5, pct_of_respondents: 50 }], n: 10, selections: 7 },
  };
  test('NPS / CSAT / CES / retention / top issue', () => {
    const rows = analysisHeadlines(analysis);
    expect(valOf(rows, 'NPS')).toBe('-20');
    expect(valOf(rows, 'CSAT')).toBe('80%');
    expect(valOf(rows, 'CES')).toBe('60%');
    expect(valOf(rows, 'Retention')).toBe('3.4');
    expect(valOf(rows, 'Top issue: Price')).toBe('50%');
  });
});

describe('analysisHeadlines — brand_lift', () => {
  const analysis = {
    methodology: 'brand_lift',
    cells: { exposed: { n: 20 }, control: { n: 18 }, not_applicable: { n: 2 } },
    funnel: [
      {
        question_id: 'q2', text: 'Aided awareness', funnel_stage: 'aided_brand_awareness',
        type: 'proportion',
        exposed: { n: 20, positive: 14, rate: 0.7 },
        control: { n: 18, positive: 9, rate: 0.5 },
        lift_abs: 0.2, lift_rel_pct: 40,
        significance: { z: 1.99, p: 0.04, sig90: true, sig95: true },
      },
      {
        question_id: 'q5', text: 'Purchase intent', funnel_stage: 'purchase_intent',
        type: 'mean',
        exposed: { mean: 4.1, n: 20 },
        control: { mean: 3.6, n: 18 },
        lift_abs: 0.5, lift_rel_pct: 13.9,
        significance: { z: 1.5, p: 0.13, sig90: false, sig95: false },
      },
    ],
    summary: { stages_lifted: 2, stages_sig95: 1, biggest_lift: { question_id: 'q2', lift_abs: 0.2 } },
  };
  test('cells + per-stage exposed/control/lift/sig', () => {
    const rows = analysisHeadlines(analysis);
    expect(valOf(rows, 'Exposed cell')).toBe('20');
    expect(valOf(rows, 'Control cell')).toBe('18');
    expect(valOf(rows, 'Aided awareness')).toBe('exposed 70% vs control 50% (+20 pts, significant at 95%)');
    expect(valOf(rows, 'Purchase intent')).toBe('exposed 4.1 vs control 3.6 (+0.5, directional)');
    expect(valOf(rows, 'Funnel stages lifted')).toBe('2');
    expect(valOf(rows, 'Stages significant at 95%')).toBe('1');
  });
  test('brandLiftStageTable returns structured rows', () => {
    const t = brandLiftStageTable(analysis);
    expect(t).toHaveLength(2);
    expect(t[0]).toMatchObject({ stage: 'Aided awareness', exposed: '70%', control: '50%', lift: '+20 pts', significance: 'significant at 95%', n: '20 / 18' });
    expect(t[1]).toMatchObject({ stage: 'Purchase intent', exposed: '4.1', control: '3.6', lift: '+0.5' });
  });
  test('brandLiftStageTable empty for non-brand_lift', () => {
    expect(brandLiftStageTable({ methodology: 'pricing' })).toEqual([]);
  });
});

describe('analysisHeadlines — roadmap', () => {
  const analysis = {
    methodology: 'roadmap',
    n: 12,
    maxdiff: {
      n: 12,
      features: [
        { feature_id: 'f1', label: 'Offline mode', utility: 0.42, best: 8, worst: 1, appearances: 12 },
        { feature_id: 'f2', label: 'Dark theme', utility: 0.1, best: 4, worst: 3, appearances: 12 },
        { feature_id: 'f3', label: 'CSV export', utility: -0.3, best: 1, worst: 6, appearances: 12 },
      ],
      ranking: ['f1', 'f2', 'f3'],
    },
    kano: {
      features: [
        { feature_id: 'f1', label: 'Offline mode', classification: 'must_be', n: 10, counts: {} },
        { feature_id: 'f2', label: 'Dark theme', classification: 'attractive', n: 10, counts: {} },
      ],
    },
  };
  test('top MaxDiff utilities + Kano must-haves', () => {
    const rows = analysisHeadlines(analysis);
    expect(valOf(rows, 'MaxDiff: Offline mode')).toBe('utility 0.42');
    expect(valOf(rows, 'MaxDiff: Dark theme')).toBe('utility 0.1');
    expect(valOf(rows, 'Kano must-haves')).toBe('Offline mode');
    expect(valOf(rows, 'MaxDiff base')).toBe('12');
  });
});

describe('analysisHeadlines — naming', () => {
  const analysis = {
    methodology: 'naming',
    n: 15,
    candidates: [
      { candidate_id: 'c1', label: 'Lumen', composite: 4.1, pairwise_win_rate: { pct: 62, wins: 31, appearances: 50 } },
      { candidate_id: 'c2', label: 'Nimbus', composite: 3.7, pairwise_win_rate: { pct: 38, wins: 19, appearances: 50 } },
    ],
    winner: { candidate_id: 'c1', by: 'pairwise_win_rate' },
  };
  test('candidates ranked with win-rate + winner tag', () => {
    const rows = analysisHeadlines(analysis);
    expect(valOf(rows, 'Lumen (winner)')).toBe('62% win rate');
    expect(valOf(rows, 'Nimbus')).toBe('38% win rate');
  });
});

describe('analysisHeadlines — compare', () => {
  const analysis = {
    methodology: 'compare',
    n: 20,
    concepts: [
      { concept_id: 'a', label: 'Concept A', dimensions: { appeal: { mean: 4.2 } }, final_choice_pct: { pct: 55, count: 11, base: 20 } },
      { concept_id: 'b', label: 'Concept B', dimensions: { appeal: { mean: 3.5 } }, final_choice_pct: { pct: 35, count: 7, base: 20 } },
    ],
    final_choice: { none: { count: 2, pct: 10 } },
    overall_winner: { concept_id: 'a', by: 'final_choice' },
  };
  test('forced-choice shares + winner + none', () => {
    const rows = analysisHeadlines(analysis);
    expect(valOf(rows, 'Concept A (winner)')).toBe('55% forced choice');
    expect(valOf(rows, 'Concept B')).toBe('35% forced choice');
    expect(valOf(rows, 'None of these')).toBe('10%');
  });
});

describe('analysisHeadlines — competitor', () => {
  const analysis = {
    methodology: 'competitor',
    n: 25,
    focal_brand: 'Acme',
    brands: [
      { brand_id: 'Acme', label: 'Acme', is_focal: true, preference_pct: 30 },
      { brand_id: 'Globex', label: 'Globex', is_focal: false, preference_pct: 45 },
    ],
    gaps: [
      { attribute: 'Reliability', focal_mean: 3.1, best_competitor: 'Globex', best_competitor_mean: 4.2, gap: -1.1 },
      { attribute: 'Price', focal_mean: 3.8, best_competitor: 'Globex', best_competitor_mean: 4.0, gap: -0.2 },
    ],
  };
  test('focal + per-brand preference + biggest gaps', () => {
    const rows = analysisHeadlines(analysis);
    expect(valOf(rows, 'Focal brand')).toBe('Acme');
    expect(valOf(rows, 'Acme (focal) preference')).toBe('30%'); // D7: dropped em-dash from label
    expect(valOf(rows, 'Globex preference')).toBe('45%');
    expect(valOf(rows, 'Gap on "Reliability" vs Globex')).toBe('-1.1 pts');
  });
});

describe('analysisHeadlines — churn', () => {
  const analysis = {
    methodology: 'churn',
    n: 18,
    // Real churn analysis labels each driver `reason` (not `option`).
    drivers: { ranked: [
      { reason: 'Too expensive', count: 9, pct_of_respondents: 50 },
      { reason: 'Missing features', count: 5, pct_of_respondents: 27.8 },
    ] },
    winback: { winnable_pct: 33.3, n: 18, distribution: {} },
  };
  test('ranked drivers + winnable %', () => {
    const rows = analysisHeadlines(analysis);
    expect(valOf(rows, 'Churn driver: Too expensive')).toBe('50%');
    expect(valOf(rows, 'Churn driver: Missing features')).toBe('27.8%');
    expect(valOf(rows, 'Winnable')).toBe('33.3%');
  });
});

describe('analysisHeadlines — validate', () => {
  const analysis = {
    methodology: 'validate',
    n: 14,
    scores: { reaction: { mean: 7.2 }, relevance: { mean: 5.1 }, uniqueness: { mean: 4.4 }, believability: { mean: 5.8 } },
    intent: { top2_pct: 64, n: 14, distribution: {} },
  };
  test('stage scores + intent top-2-box', () => {
    const rows = analysisHeadlines(analysis);
    expect(valOf(rows, 'Concept reaction')).toBe('7.2');
    expect(valOf(rows, 'Relevance')).toBe('5.1');
    expect(valOf(rows, 'Purchase intent (top-2-box)')).toBe('64%');
  });
});

describe('analysisHeadlines — research (generic)', () => {
  const analysis = {
    methodology: 'research',
    n: 9,
    per_question: [
      { question_id: 'q1', text: 'How often do you cook?', n: 9 },
      { question_id: 'q2', text: 'Favorite cuisine?', n: 8 },
    ],
  };
  test('per-question n surfaces', () => {
    const rows = analysisHeadlines(analysis);
    expect(rows.length).toBeGreaterThanOrEqual(2);
    expect(rows[0].value).toBe('9');
  });
});

describe('analysisHeadlines — display rounding (Pass 50)', () => {
  // The exact ugly-float classes observed on real 2026-06-13 missions:
  // brand_lift "exposed 2.6667", roadmap "utility 0.1778", pricing "…–234.9999".
  test('brand_lift means + lift round to 2 dp (no x.6667 tails)', () => {
    const rows = analysisHeadlines({
      methodology: 'brand_lift',
      funnel: [{
        question_id: 'q', text: 'Familiarity', type: 'mean',
        exposed: { mean: 2.6666666667, n: 3 }, control: { mean: 2, n: 3 },
        lift_abs: 0.6666666667, significance: { sig90: false, sig95: false },
      }],
    });
    expect(valOf(rows, 'Familiarity')).toBe('exposed 2.67 vs control 2 (+0.67, directional)');
    const t = brandLiftStageTable({
      methodology: 'brand_lift',
      funnel: [{ question_id: 'q', text: 'Familiarity', type: 'mean', exposed: { mean: 2.6666667, n: 3 }, control: { mean: 2, n: 3 }, lift_abs: 0.6666667, significance: {} }],
    });
    expect(t[0]).toMatchObject({ exposed: '2.67', control: '2', lift: '+0.67' });
  });
  test('roadmap MaxDiff utility rounds to 2 dp; clean values unchanged', () => {
    const rows = analysisHeadlines({
      methodology: 'roadmap',
      maxdiff: { n: 5, features: [
        { feature_id: 'f1', label: 'Shared Wallets', utility: 1 },
        { feature_id: 'f2', label: 'Bill Reminders', utility: 0.1777777778 },
      ] },
    });
    expect(valOf(rows, 'Shared Wallets')).toBe('utility 1');
    expect(valOf(rows, 'Bill Reminders')).toBe('utility 0.18');
  });
  test('pricing range + corners round (no 234.9999)', () => {
    const rows = analysisHeadlines({
      methodology: 'pricing',
      van_westendorp: { n: 5, points: { opp: 180, pmc: 159.9999999, pme: 234.9999999 } },
      acceptable_range: { low: 160, high: 234.9999999 },
    });
    expect(valOf(rows, 'Acceptable price range')).toBe('160-235'); // D7: en-dash range → hyphen
    expect(valOf(rows, 'Optimal price (Van Westendorp OPP)')).toBe('180');
    expect(valOf(rows, 'Point of marginal cheapness')).toBe('160');
    expect(valOf(rows, 'Point of marginal expensiveness')).toBe('235');
  });
  test('naming win-rate to 1 dp; compare share to 1 dp; competitor gap to 2 dp', () => {
    const naming = analysisHeadlines({
      methodology: 'naming',
      candidates: [{ candidate_id: 'c1', label: 'Lumio', pairwise_win_rate: { pct: 66.66667 } }],
      winner: { candidate_id: 'c1' },
    });
    expect(valOf(naming, 'Lumio')).toBe('66.7% win rate');
    const compare = analysisHeadlines({
      methodology: 'compare',
      concepts: [{ concept_id: 'a', label: 'A', final_choice_pct: { pct: 33.33333 } }],
      overall_winner: { concept_id: 'a' },
    });
    expect(valOf(compare, 'A')).toBe('33.3% forced choice');
    const comp = analysisHeadlines({
      methodology: 'competitor', focal_brand: 'X',
      gaps: [{ attribute: 'Trust', best_competitor: 'Y', gap: -1.166667 }],
    });
    expect(valOf(comp, 'Gap on "Trust" vs Y')).toBe('-1.17 pts');
  });
});

// Pass 51 — a refused significance test must not render as "directional".
describe('analysisHeadlines — refused significance reads as not tested', () => {
  const analysis = {
    methodology: 'brand_lift',
    min_cell_n: 10,
    cells: { exposed: { n: 3 }, control: { n: 2 }, not_applicable: { n: 0 } },
    funnel: [
      {
        question_id: 'q2', text: 'Aided awareness', type: 'proportion',
        exposed: { n: 3, positive: 3, rate: 1 }, control: { n: 2, positive: 0, rate: 0 },
        lift_abs: 1, lift_rel_pct: null,
        significance: null, reason: 'below_min_cell_n', min_cell_n: 10,
      },
    ],
    summary: {
      stages_lifted: 1, stages_sig95: 0, stages_tested: 0, stages_untested: 1,
      biggest_lift: { question_id: 'q2', lift_abs: 1 },
    },
  };

  test('headline says not tested, never directional', () => {
    const rows = analysisHeadlines(analysis);
    const v = valOf(rows, 'Aided awareness');
    expect(v).toContain('not tested');
    expect(v).not.toContain('directional');
    expect(v).not.toContain('significant at');
  });

  test('untested stage count is surfaced next to the sig95 count', () => {
    const rows = analysisHeadlines(analysis);
    expect(valOf(rows, 'Stages significant at 95%')).toBe('0');
    expect(valOf(rows, 'Stages not tested (base too small)')).toBe('1 (needs n>=10 per cell)');
  });

  test('stage table carries the same refusal wording', () => {
    const t = brandLiftStageTable(analysis);
    expect(t[0].significance).toBe('not tested — cell below the minimum base');
  });

  test("a tested-but-weak result still reads 'directional'", () => {
    const rows = analysisHeadlines({
      methodology: 'brand_lift',
      funnel: [{
        question_id: 'q', text: 'Familiarity', type: 'mean',
        exposed: { mean: 4, n: 20 }, control: { mean: 3.8, n: 20 },
        lift_abs: 0.2, significance: { z: 0.5, p: 0.6, sig90: false, sig95: false },
      }],
    });
    expect(valOf(rows, 'Familiarity')).toContain('directional');
  });
});
