/*
 * THE TILE INVARIANT — what a hero stat tile displays must equal what the
 * analysis object holds.
 *
 * On origin/main the results page renders `report.key_findings` as the three
 * hero tiles (PremiumResults.tsx: `const kpis = (report.key_findings||[]).slice(0,3)`,
 * then `parseMetric(k.value)` into a 46px numeral). buildCanonicalReport sets
 * `key_findings = insights.kpis`, and generateReportSummaries lets the LLM
 * REPLACE that array wholesale — validating only that label and value are
 * non-empty. Nothing checked the value against the analysis, so a model-authored
 * figure went straight onto a paid deliverable.
 *
 * Held PR #93 (claude/results-v2-redesign) fixes the DISPLAY side: it drops the
 * count-up and sources tiles from buildCenterpiece(report).view.cells, which
 * reads report.centerpiece.data (= analysis). This test is deliberately written
 * as the invariant that survives EITHER render path, because it is stated over
 * the report the server produces rather than over any component:
 *
 *     every NUMBER in a hero tile must be present in the computed data
 *     (the `analysis` object, or the canonical survey's own computed figures)
 *
 * Numbers rather than whole strings, because "4.0 / 5" and "4" are the same
 * finding differently formatted — but "38% (10 of 26 collected)" on a mission
 * with no 26 anywhere is an invention, and only invention should fail.
 *
 * Fixtures are real completed production missions (test/fixtures/completed_missions.json),
 * spanning market_entry, pricing, satisfaction, validate, marketing,
 * audience_profiling, research, brand_lift, roadmap, competitor and compare.
 */

const { auditTiles, computedFigureUniverse, tileValueDerivable, figuresIn } = require('../src/services/report/tileFigures');
const { deterministicKpis } = require('../src/services/ai/reportSummaries');
const { analysisHeadlines } = require('../src/services/exports/analysisHeadlines');

const FIXTURES = require('./fixtures/completed_missions.json');
const byPrefix = (p) => FIXTURES.find((f) => f.mission_id_prefix === p);

describe('the invariant holds for every analysis-derived tile', () => {
  test.each(FIXTURES.map((f) => [f.mission_id_prefix, f.goal_type]))(
    '%s (%s): deterministicKpis() produces only derivable figures',
    (prefix) => {
      const f = byPrefix(prefix);
      const report = { ...f.report, key_findings: deterministicKpis(f.report) };
      expect(auditTiles(report, f.analysis)).toEqual([]);
    },
  );

  test('analysisHeadlines() — the source the v2 centerpiece reads — is derivable by construction', () => {
    for (const f of FIXTURES) {
      const report = {
        ...f.report,
        key_findings: analysisHeadlines(f.analysis).map((h) => ({ label: h.label, value: h.value })),
      };
      const bad = auditTiles(report, f.analysis);
      if (bad.length) throw new Error(`${f.mission_id_prefix}: ${JSON.stringify(bad)}`);
    }
  });
});

describe('the invariant catches the tiles that actually shipped wrong', () => {
  // Verified by hand against each mission's stored analysis. These are the
  // model-authored figures the old label-and-value-non-empty check let through.
  const KNOWN_BAD = [
    ['e18c9802', '38% (10 of 26 collected)', [38, 26]], // invented a 26-respondent base
    ['23389bb1', '10 / 50 (20%)', [50]],                // invented a target of 50
    ['077b6e23', 'n=10 of 50 reported', [50]],          // same invented target
  ];

  test.each(KNOWN_BAD)('%s: "%s" is rejected', (prefix, value, expectedUndrivable) => {
    const f = byPrefix(prefix);
    const universe = computedFigureUniverse(f.report, f.analysis);
    const v = tileValueDerivable(value, universe);
    expect(v.derivable).toBe(false);
    expect(v.undrivable).toEqual(expect.arrayContaining(expectedUndrivable));
  });

  test('the stored key_findings of those missions fail the audit as shipped', () => {
    for (const [prefix] of KNOWN_BAD) {
      const f = byPrefix(prefix);
      expect(auditTiles(f.report, f.analysis).length).toBeGreaterThan(0);
    }
  });
});

describe('the invariant is not a blanket fail', () => {
  test('reformatting is free: "60% (3 of 5)" agrees with an analysis holding 60', () => {
    const f = byPrefix('86d4b8c6'); // compare; analysis carries "60% forced choice"
    const universe = computedFigureUniverse(f.report, f.analysis);
    expect(tileValueDerivable('60% (3 of 5)', universe).derivable).toBe(true);
    expect(tileValueDerivable('60.0%', universe).derivable).toBe(true);
  });

  test('a value with no digits is vacuously derivable', () => {
    const universe = computedFigureUniverse(byPrefix('3fc15087').report, byPrefix('3fc15087').analysis);
    expect(tileValueDerivable('No data', universe).derivable).toBe(true);
    expect(tileValueDerivable('Saudi Arabia', universe).derivable).toBe(true);
  });

  test('proportions in the analysis are readable as percents (0.7125 satisfies 71%)', () => {
    const universe = computedFigureUniverse({ survey: [] }, { rate: 0.7125 });
    expect(tileValueDerivable('71%', universe).derivable).toBe(true);
    expect(tileValueDerivable('71.25%', universe).derivable).toBe(true);
    expect(tileValueDerivable('72%', universe).derivable).toBe(false);
  });

  test('digits inside identifiers are not figures', () => {
    expect(figuresIn('q3 and COVID19')).toEqual([]);
    expect(figuresIn('38% (10 of 26)')).toEqual([38, 10, 26]);
  });

  test('creative_attention prose key_findings are not policed as stat tiles', () => {
    // CA fills key_findings with "Strength — ..." paragraphs, not {label,value}.
    const report = { survey: [], key_findings: ['Strength — Trust scores 75 here.'] };
    expect(auditTiles(report, {})).toEqual([]);
  });
});

/*
 * ---------------------------------------------------------------------------
 * SIGNIFICANCE IS A FIGURE TOO.
 *
 * Stacked on held PR #120, which puts a minimum cell-size floor on brand-lift
 * significance: below it, brandLift.js returns `significance: null` with a
 * machine-readable `reason`, because "we did not test this" and "we tested this
 * and found nothing" are different claims.
 *
 * #120 fixed the exporters. It could not fix the two consumers inside this
 * agent's files, both of which mapped null onto 'directional' — a completed
 * weak test. That is the same defect class as a fabricated percentage: the
 * surface asserts something the analysis object explicitly declines to say.
 *
 * Fixture is real: mission 191455e8 stores q11 as a 3-vs-2 mean comparison
 * carrying {"p":0,"z":5,"sig90":true,"sig95":true}, and that rendered on the
 * live report as "exposed 7 vs control 4.5 (+2.5, significant at 95%)".
 * ---------------------------------------------------------------------------
 */
const BL = require('./fixtures/brand_lift_191455e8.json');
const { buildRenderModel } = require('../src/services/report/reportRenderModel');
const { buildComputedSummary } = require('../src/services/ai/insights');
const { sigLabel } = require('../src/services/exports/analysisHeadlines');

/** Every string a surface renders for brand-lift stages, keyed by stage id. */
function renderedStageStrings(analysis) {
  const byStage = {};
  const add = (id, s) => { (byStage[id] = byStage[id] || []).push(String(s)); };

  for (const h of analysisHeadlines(analysis)) {
    const f = (analysis.funnel || []).find((x) => (x.text || x.funnel_stage || x.question_id) === h.label);
    if (f) add(f.question_id, h.value);
  }
  const rm = buildRenderModel({
    header: { title: 't', methodology: 'brand_lift', methodology_label: 'Brand Lift', sample: { n: 5 } },
    headline: null, centerpiece: { methodology: 'brand_lift', data: analysis },
    key_findings: [], survey: [], data_quality_notes: [], methodology_disclaimer: '',
  });
  // The web/export centerpiece table: rows are positional arrays whose columns
  // are named in cp.columns; find the Significance column rather than assuming.
  const cp = rm && rm.centerpiece;
  if (cp && Array.isArray(cp.rows)) {
    const sigCol = (cp.columns || []).findIndex((c) => /significance/i.test(String(c)));
    for (const row of cp.rows) {
      const f = (analysis.funnel || []).find((x) => (x.text || x.funnel_stage || x.question_id) === row[0]);
      if (f && sigCol >= 0 && row[sigCol]) add(f.question_id, row[sigCol]);
    }
  }
  return byStage;
}

describe('a refused significance test must not render as a finding', () => {
  const shipped = BL.analysis_as_shipped;
  const fixed = BL.analysis_after_min_cell_floor;

  test('the fixture is the real 3-vs-2 stage that claimed 95% significance', () => {
    const q11 = shipped.funnel.find((f) => f.question_id === 'q11');
    expect(q11.exposed.n).toBe(3);
    expect(q11.control.n).toBe(2);
    expect(q11.significance.sig95).toBe(true); // what shipped
    const after = fixed.funnel.find((f) => f.question_id === 'q11');
    expect(after.significance).toBeNull();      // what #120 computes
    expect(after.reason).toBe('below_min_cell_n');
  });

  test('sigLabel never turns a refusal into a completed test', () => {
    expect(sigLabel(null, 'below_min_cell_n')).toBe('not tested — cell below the minimum base');
    expect(sigLabel(null, 'below_min_cell_n')).not.toMatch(/directional|significant/);
    expect(sigLabel(null, 'empty_cell')).not.toMatch(/directional|significant/);
    expect(sigLabel(null)).not.toMatch(/directional|significant/);
    // 'directional' keeps its original meaning: tested, below both thresholds.
    expect(sigLabel({ sig95: false, sig90: false })).toBe('directional');
  });

  test('EVERY surface: a null-significance stage renders as not-tested', () => {
    const byStage = renderedStageStrings(fixed);
    const nulls = fixed.funnel.filter((f) => f.significance == null && f.lift_abs != null);
    expect(nulls.length).toBeGreaterThan(0);
    for (const f of nulls) {
      // Guard against a vacuous pass: BOTH the export headline and the render
      // model must actually have produced a string for this stage.
      expect((byStage[f.question_id] || []).length).toBe(2);
      for (const s of byStage[f.question_id] || []) {
        expect(s).toMatch(/not tested/);
        expect(s).not.toMatch(/\bdirectional\b/);
        expect(s).not.toMatch(/significant at \d/);
      }
    }
  });

  test('the narrator does not assert a finding the analysis refused', () => {
    const summary = buildComputedSummary(fixed, { goal_type: 'brand_lift' });
    expect(summary).toMatch(/not tested/);
    expect(summary).not.toMatch(/\bdirectional\b/);
    expect(summary).not.toMatch(/significant at \d/);
    // and it still states the lift itself, which IS computed
    expect(summary).toMatch(/2\.5/);
  });

  test('a genuinely significant stage still reads as significant', () => {
    const wellPowered = {
      methodology: 'brand_lift',
      cells: { exposed: { n: 200 }, control: { n: 200 } },
      funnel: [{
        question_id: 'q1', funnel_stage: 'awareness', text: 'Awareness', type: 'proportion',
        exposed: { rate: 0.62, n: 200 }, control: { rate: 0.41, n: 200 },
        lift_abs: 0.21, significance: { sig95: true, sig90: true },
      }],
    };
    const byStage = renderedStageStrings(wellPowered);
    expect(byStage.q1.length).toBe(2); // headline + render model, both present
    for (const s of byStage.q1) expect(s).toMatch(/significant at 95%/);
  });

  test('every significance claim rendered anywhere is derivable from the analysis', () => {
    for (const analysis of [shipped, fixed]) {
      const byStage = renderedStageStrings(analysis);
      for (const [qid, strings] of Object.entries(byStage)) {
        const f = analysis.funnel.find((x) => x.question_id === qid);
        for (const s of strings) {
          if (/significant at 95%/.test(s)) expect(f.significance && f.significance.sig95).toBe(true);
          if (/significant at 90%/.test(s)) expect(f.significance && f.significance.sig90).toBe(true);
          if (/\bdirectional\b/.test(s)) expect(f.significance).not.toBeNull();
        }
      }
    }
  });
});
