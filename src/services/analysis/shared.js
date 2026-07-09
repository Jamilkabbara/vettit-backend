/**
 * Pass 46 Phase 3 — shared statistical primitives for methodology
 * analysis modules.
 *
 * Doctrine (Jamil's explicit decision): the LLM does NOT compute
 * methodology math. Every number a report shows is computed here,
 * deterministically, from mission_responses rows; the narrator LLM
 * only writes prose ABOUT the computed object. Every helper has unit
 * tests with hand-computed fixtures (test/analysis_shared.test.js).
 */

const { isSkip } = require('../../utils/answerValue');

/** Numeric coercion that treats '', null, undefined, NaN as null. */
function num(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * Group response rows by question_id.
 * @param {Array<{question_id: string, answer: any, persona_id: string}>} rows
 * @returns {Map<string, Array>} question_id → rows
 */
function byQuestion(rows) {
  const m = new Map();
  for (const r of rows || []) {
    if (!r || !r.question_id) continue;
    if (!m.has(r.question_id)) m.set(r.question_id, []);
    m.get(r.question_id).push(r);
  }
  return m;
}

/** Distribution {answerValue: count} for a question's rows. Multi-select arrays count each selection. */
function distribution(rows) {
  const dist = {};
  for (const r of rows || []) {
    const a = r.answer;
    // A skip (the 'not_applicable' sentinel / null / empty) is not a value:
    // never a bar, and — since shares() defaults its base to the summed
    // distribution — never in the % denominator either.
    if (isSkip(a)) continue;
    const values = Array.isArray(a) ? a : [a];
    for (const v of values) {
      const key = String(v);
      dist[key] = (dist[key] || 0) + 1;
    }
  }
  return dist;
}

/**
 * Mean + 95% CI for numeric answers. Returns null when no numeric data.
 * Unbiased (n-1) variance; CI half-width 1.96 × SEM (z, not t — our n
 * is typically ≥ 5 and the renderer labels small-n as directional).
 */
function ratingStats(rows) {
  const nums = (rows || []).map((r) => num(r.answer)).filter((v) => v !== null);
  const n = nums.length;
  if (n === 0) return null;
  const mean = nums.reduce((s, v) => s + v, 0) / n;
  if (n === 1) return { mean, stddev: 0, n, ci_low: mean, ci_high: mean };
  const variance = nums.reduce((s, v) => s + (v - mean) ** 2, 0) / (n - 1);
  const stddev = Math.sqrt(variance);
  const half = 1.96 * (stddev / Math.sqrt(n));
  return {
    mean: round4(mean),
    stddev: round4(stddev),
    n,
    ci_low: round4(mean - half),
    ci_high: round4(mean + half),
  };
}

/**
 * Two-proportion z-test (pooled). Returns z, two-sided p approximation,
 * and significance flags at 90/95%. Degenerate cells (n=0) → null.
 *
 * Used for brand_lift exposed-vs-control deltas: x1/n1 = exposed
 * successes/total, x2/n2 = control.
 */
function twoProportionTest(x1, n1, x2, n2) {
  if (!n1 || !n2) return null;
  const p1 = x1 / n1;
  const p2 = x2 / n2;
  const pooled = (x1 + x2) / (n1 + n2);
  const se = Math.sqrt(pooled * (1 - pooled) * (1 / n1 + 1 / n2));
  if (se === 0) {
    return { z: 0, p: 1, sig90: false, sig95: false, p1: round4(p1), p2: round4(p2) };
  }
  const z = (p1 - p2) / se;
  const p = 2 * (1 - normalCdf(Math.abs(z)));
  return {
    z: round4(z),
    p: round4(p),
    sig90: Math.abs(z) >= 1.6449,
    sig95: Math.abs(z) >= 1.96,
    p1: round4(p1),
    p2: round4(p2),
  };
}

/** Standard normal CDF (Abramowitz–Stegun 7.1.26 erf approximation, |err| < 1.5e-7). */
function normalCdf(x) {
  const t = 1 / (1 + 0.3275911 * Math.abs(x) / Math.SQRT2);
  const erf = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-(x * x) / 2);
  return x >= 0 ? 0.5 * (1 + erf) : 0.5 * (1 - erf);
}

/**
 * Linear interpolation of the price at which two cumulative curves
 * cross. Curves are arrays of {x, y} sorted by x. Returns null when
 * they never cross in the shared domain. Used for the Van Westendorp
 * intersections (PMC / PME / OPP / IPP).
 */
function curveIntersection(curveA, curveB) {
  if (!Array.isArray(curveA) || !Array.isArray(curveB) || curveA.length < 2 || curveB.length < 2) return null;
  // Evaluate both on the union grid and find the sign change of (A - B).
  const xs = [...new Set([...curveA.map((p) => p.x), ...curveB.map((p) => p.x)])].sort((a, b) => a - b);
  const evalAt = (curve, x) => {
    if (x <= curve[0].x) return curve[0].y;
    if (x >= curve[curve.length - 1].x) return curve[curve.length - 1].y;
    for (let i = 1; i < curve.length; i += 1) {
      if (x <= curve[i].x) {
        const a = curve[i - 1];
        const b = curve[i];
        const t = b.x === a.x ? 0 : (x - a.x) / (b.x - a.x);
        return a.y + t * (b.y - a.y);
      }
    }
    return curve[curve.length - 1].y;
  };
  let prevX = null;
  let prevDiff = null;
  for (const x of xs) {
    const diff = evalAt(curveA, x) - evalAt(curveB, x);
    if (prevDiff !== null && ((prevDiff <= 0 && diff >= 0) || (prevDiff >= 0 && diff <= 0))) {
      // Linear root between prevX and x.
      if (diff === prevDiff) return round4(x);
      const t = Math.abs(prevDiff) / (Math.abs(prevDiff) + Math.abs(diff));
      return round4(prevX + t * (x - prevX));
    }
    prevX = x;
    prevDiff = diff;
  }
  return null;
}

/** Share map {key: count} → {key: {count, pct}} with a stated base. */
function shares(dist, base) {
  const total = base ?? Object.values(dist).reduce((s, v) => s + v, 0);
  const out = {};
  for (const [k, v] of Object.entries(dist)) {
    out[k] = { count: v, pct: total > 0 ? round4((v / total) * 100) : 0 };
  }
  return { total, shares: out };
}

function round4(v) {
  return Math.round(v * 10000) / 10000;
}

/** Distinct persona count — the honest n for persona-level metrics. */
function personaCount(rows) {
  return new Set((rows || []).map((r) => r.persona_id).filter(Boolean)).size;
}

module.exports = {
  isSkip,
  num,
  byQuestion,
  distribution,
  ratingStats,
  twoProportionTest,
  normalCdf,
  curveIntersection,
  shares,
  round4,
  personaCount,
};
