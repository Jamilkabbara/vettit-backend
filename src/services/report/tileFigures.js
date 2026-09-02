/**
 * Tile figure derivability - "a hero stat tile may only display a number the
 * server computed".
 *
 * WHY THIS EXISTS
 * ---------------
 * buildCanonicalReport sets `key_findings = insights.kpis`, and the results page
 * renders key_findings as the three hero stat tiles. insights.kpis starts as
 * deterministicKpis(report) - a slice of analysisHeadlines(analysis), grounded by
 * construction - but generateReportSummaries then lets the LLM REPLACE the whole
 * array, validating only that each entry has a non-empty label and value. Nothing
 * checks the value against the analysis. A model-authored string therefore lands
 * directly in a 46px numeral on a paid deliverable.
 *
 * Measured on 66 completed production missions: 184 of 223 stored KPI values are
 * not byte-equal to any analysisHeadlines() value, and cases like
 * "34.375%" (mission bdae4d45, where the analysis carries 53.3% / 46.7%) are
 * outright fabrications rather than reformattings.
 *
 * THE INVARIANT
 * -------------
 * Every NUMBER rendered in a tile must appear in the computed data the report
 * was built from - the deterministic `analysis` object, or the canonical
 * survey's own computed per-question figures. Formatting is free ("4.0 / 5" and
 * "4" agree); invention is not.
 *
 * This is deliberately stated over NUMBERS rather than over whole strings,
 * because it must hold under either render path:
 *   - origin/main renders `key_findings[i].value` verbatim (PremiumResults.tsx),
 *   - held PR #93 renders `buildCenterpiece(report).view.cells[i].value` sourced
 *     from `report.centerpiece.data` (= analysis),
 * and a label/format difference between the two must not read as a violation
 * while a fabricated figure must.
 *
 * WHAT IT DOES NOT CATCH
 * ----------------------
 *   - A real number wearing the wrong label ("NPS" over the CSAT figure). The
 *     universe is a set, so provenance per-number is not tracked.
 *   - Small integers. 0-10 and other common values are almost always present
 *     somewhere in a real analysis object, so a fabricated single-digit figure
 *     passes. The rule bites on distinctive values (34.375, 233, 300).
 *   - Purely verbal tiles ("No data", "Nutrition / Ingredients"). A value with
 *     no digits is vacuously derivable; only figures are policed.
 *   - Bare-string key_findings. creative_attention fills key_findings with
 *     "Strength - ..." / "Watch-out - ..." prose rather than {label,value} tiles;
 *     those are paragraphs, not stat tiles, and are skipped.
 */

const { analysisHeadlines } = require('../exports/analysisHeadlines');

/** Round to `dp` and drop float noise, so 43.75000000000001 -> 43.75. */
function r(v, dp) {
  const f = 10 ** dp;
  return Math.round(v * f) / f;
}

/** Add a number and the display roundings a renderer might apply to it. */
function addNumber(set, v) {
  if (!Number.isFinite(v)) return;
  for (const dp of [0, 1, 2, 3]) set.add(r(v, dp));
  set.add(Math.abs(r(v, 2)));
  // Analysis modules store rates as proportions (0.7125) but surfaces render
  // percents (71.25 / 71). Admit both readings of the same computed number.
  if (v >= -1 && v <= 1) for (const dp of [0, 1, 2]) set.add(r(v * 100, dp));
}

/** Every numeric leaf of an arbitrarily nested object, with rounding variants. */
function harvestNumbers(node, set, depth = 0) {
  if (node == null || depth > 12) return;
  if (typeof node === 'number') { addNumber(set, node); return; }
  if (typeof node === 'string') {
    // Analysis strings sometimes carry the figure ("+12 pts", "53.3% (n=32)").
    const re = /(?<![\w.])(-?\d+(?:\.\d+)?)/g;
    for (let m = re.exec(node); m; m = re.exec(node)) addNumber(set, Number(m[1]));
    return;
  }
  if (Array.isArray(node)) { for (const v of node) harvestNumbers(v, set, depth + 1); return; }
  if (typeof node === 'object') { for (const v of Object.values(node)) harvestNumbers(v, set, depth + 1); }
}

/**
 * The set of numbers a tile is allowed to display: everything the server
 * computed for this mission.
 * @param {object} report    canonical report (buildCanonicalReport output)
 * @param {object} analysis  the deterministic methodology analysis
 * @returns {Set<number>}
 */
function computedFigureUniverse(report, analysis) {
  const set = new Set();
  harvestNumbers(analysis, set);
  // analysisHeadlines() is a pure read of `analysis`, so anything it renders is
  // derivable by definition - including the significance levels it words as
  // "significant at 95%", which are not numeric leaves of the analysis object.
  try { harvestNumbers(analysisHeadlines(analysis), set); } catch { /* non-fatal */ }
  for (const lvl of [90, 95, 99]) set.add(lvl); // stated confidence levels

  const sample = report && report.header && report.header.sample;
  if (sample) { addNumber(set, sample.n); addNumber(set, sample.qualified); addNumber(set, sample.delivered); }

  for (const q of (report && report.survey) || []) {
    const d = (q && q.data) || {};
    for (const k of ['n', 'n_respondents', 'average', 'stddev', 'ci_low', 'ci_high', 'scale_min', 'scale_max']) {
      addNumber(set, Number(d[k]));
    }
    const dist = d.distribution;
    if (dist && typeof dist === 'object' && !Array.isArray(dist)) {
      const counts = Object.values(dist).map(Number).filter(Number.isFinite);
      const base = Number(d.n_respondents) || Number(d.n) || counts.reduce((a, b) => a + b, 0);
      for (const [k, v] of Object.entries(dist)) {
        addNumber(set, Number(k));     // rating values are legitimate figures
        addNumber(set, Number(v));     // option counts
        if (base > 0) addNumber(set, (Number(v) / base) * 100); // option shares
      }
      // Top/bottom-box shares are computed and routinely headlined.
      if (base > 0) for (const c of counts) addNumber(set, (c / base) * 100);
    }
    for (const a of d.per_attribute || []) addNumber(set, Number(a && a.average));
    for (const t of d.themes || []) { addNumber(set, Number(t && t.count)); addNumber(set, Number(t && t.pct)); }
  }
  return set;
}

/** Numbers a tile value asserts. Ignores digits inside words (q3, COVID19). */
function figuresIn(value) {
  const out = [];
  const re = /(?<![\w.])(-?\d+(?:\.\d+)?)/g;
  for (let m = re.exec(String(value == null ? '' : value)); m; m = re.exec(String(value))) {
    const n = Number(m[1]);
    if (Number.isFinite(n)) out.push(n);
  }
  return out;
}

/**
 * @returns {{derivable:boolean, figures:number[], undrivable:number[]}}
 *          A value with no digits is vacuously derivable.
 */
function tileValueDerivable(value, universe) {
  const figures = figuresIn(value);
  const undrivable = figures.filter((n) => !universe.has(r(n, 2)) && !universe.has(r(n, 0)));
  return { derivable: undrivable.length === 0, figures, undrivable };
}

/**
 * Audit a canonical report's hero tiles.
 * @returns {Array<{index:number, label:string, value:string, undrivable:number[]}>}
 *          one entry per offending tile; [] when the invariant holds.
 */
function auditTiles(report, analysis) {
  const universe = computedFigureUniverse(report, analysis);
  const out = [];
  const tiles = (report && report.key_findings) || [];
  tiles.forEach((kf, index) => {
    // Only {label, value} stat tiles are policed; bare prose strings
    // (creative_attention strengths / watch-outs) are not hero numerals.
    if (!kf || typeof kf !== 'object' || Array.isArray(kf)) return;
    const value = kf.value;
    if (value == null || !String(value).trim()) return;
    const v = tileValueDerivable(value, universe);
    if (!v.derivable) {
      out.push({
        index,
        label: (kf && kf.label) || null,
        value: String(value),
        undrivable: v.undrivable,
      });
    }
  });
  return out;
}

module.exports = { computedFigureUniverse, tileValueDerivable, auditTiles, figuresIn };
