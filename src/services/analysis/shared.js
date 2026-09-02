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
const logger = require('../../utils/logger');

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


// ── Ordered-scale resolution (Pass 51) ────────────────────────────────────
//
// Six analysis modules used to re-derive meaning by string-matching ENGLISH
// option labels ('Satisfied', 'Definitely would buy', answer === 'yes', an
// option .includes('yes')). The generators emit exactly those labels today, so
// nothing is currently mis-scored — but the coupling is silent. If a prompt is
// reworded, localised, or a model paraphrases, the off-scale answers stay in
// the DENOMINATOR while never counting as top-box, and the module reports a
// confident 0.0% against a full, healthy-looking n. Kano and Gabor-Granger
// fail loudly in the same situation (they null the block out); this family
// failed silently and wrongly.
//
// The template is compare.js:207-211, which scores positional top-2 against
// the question's OWN options array and guards on opts.length === 5. Positional
// order is only meaningful when the question really is the canonical scale, so
// resolveBoxSet checks three things before trusting position: the question
// carries the expected methodology tag, it has the expected type, and its
// options array has the expected length. Anything else falls back to the
// literal labels that were hard-coded before — same numbers as today, but the
// basis is now recorded rather than assumed.

/** Normalize a label or answer for comparison (matches simulate.js:142). */
function norm(v) {
  return String(v ?? '').trim().toLowerCase();
}

/** Non-empty option labels, in the order the generator emitted them. */
function cleanOptions(options) {
  if (!Array.isArray(options)) return [];
  return options.filter((o) => o !== null && o !== undefined && String(o).trim() !== '');
}

/**
 * Resolve the set of answers that count as "top box" for an ordered-scale
 * question, preferring position over prose.
 *
 * @param {object}   spec
 * @param {object}   spec.question       the mission question
 * @param {object}   spec.tag            {key, value} methodology tag the question MUST carry
 * @param {string|Array<string>} spec.type  the question type(s) position is valid for
 * @param {number}   spec.size           how many boxes (2 for top-2, 1 for a Yes head)
 * @param {number}   spec.expectedLength the canonical option count
 * @param {'head'|'tail'} spec.from      which end is MOST positive — 'head' when
 *                                       options run most→least positive
 *                                       ("Definitely would buy" first), 'tail'
 *                                       when they run least→most ("Very
 *                                       satisfied" last). Getting this wrong
 *                                       inverts the metric, so it is required.
 * @param {Array<string>} spec.fallbackLabels literal labels used when the shape
 *                                       is not the canonical scale.
 * @returns {{set:Set<string>, basis:string, labels:Array<string>, optionSet:Set<string>|null}}
 */
function resolveBoxSet({ question, tag, type, size, expectedLength, from, fallbackLabels = [] }) {
  const q = question || {};
  const opts = cleanOptions(q.options);
  const optionSet = opts.length > 0 ? new Set(opts.map(norm)) : null;

  const tagOk = !tag || norm(q[tag.key]) === norm(tag.value);
  const types = type == null ? null : (Array.isArray(type) ? type : [type]);
  const typeOk = !types || types.some((t) => norm(q.type) === norm(t));
  const lenOk = opts.length === expectedLength;

  if (tagOk && typeOk && lenOk) {
    const picked = from === 'tail' ? opts.slice(opts.length - size) : opts.slice(0, size);
    return {
      set: new Set(picked.map(norm)),
      basis: 'positional',
      labels: picked.map((o) => String(o)),
      optionSet,
    };
  }
  return {
    set: new Set(fallbackLabels.map(norm)),
    basis: opts.length > 0 ? 'label_fallback' : 'label_only',
    labels: fallbackLabels.map((o) => String(o)),
    optionSet,
  };
}

/**
 * How many answers do not appear in the question's own options list? This is
 * the drift detector: off-scale answers are exactly the ones that sit in a
 * top-box denominator while being unable to reach the numerator. Returns null
 * when the question carries no options metadata (nothing to check against).
 * The answers are NOT dropped from the base — removing them would change
 * today's numbers; stating them does not.
 */
function offScaleCount(answers, optionSet) {
  if (!optionSet || optionSet.size === 0) return null;
  let off = 0;
  for (const a of answers || []) {
    if (!optionSet.has(norm(a))) off += 1;
  }
  return off;
}

/** A base below this is legitimately allowed to produce a zero top box. */
const ZERO_BOX_HEALTHY_BASE = 10;

/**
 * Loud-fail assertion for the silent-0% failure mode.
 *
 * A top box of EXACTLY zero against a healthy base is far more often a scoring
 * bug than a finding, and it is indistinguishable from a real 0% once it
 * reaches a chart. This surfaces it — a machine-readable flag on the emitted
 * block plus a warn log — rather than letting it be reported as fact. It
 * deliberately does NOT suppress the number: the renderer decides whether to
 * withhold, and a genuine 0% stays visible with its caveat attached.
 *
 * It stays quiet on the one combination that makes a zero trustworthy:
 * positional scoring (the box came from the question's own options) with every
 * answer on that option list.
 *
 * @returns {object|null} the flag to attach, or null when nothing is suspicious
 */
function auditZeroBox({ metric, questionId, count, base, basis, offScale }) {
  if (count !== 0) return null;
  if (!(base >= ZERO_BOX_HEALTHY_BASE)) return null;
  // A zero is a genuine FINDING only when we know we read the right scale:
  // the box came from the question's own options (positional) AND every answer
  // was on that option list. Any other combination means the zero could just as
  // easily be a scoring artefact, so it gets surfaced.
  if (basis === 'positional' && offScale === 0) return null;
  const flag = {
    reason: 'zero_top_box_against_healthy_base',
    metric: metric || null,
    question_id: questionId ?? null,
    base,
    scale_basis: basis || null,
    off_scale_n: offScale ?? null,
    // off_scale_n > 0 is the smoking gun: answers fell outside the question's
    // own option list, so they sat in the denominator unable to reach the
    // numerator. A null off_scale_n means the question carried no options at
    // all and the zero is simply unverifiable.
    likely_label_drift: offScale != null && offScale > 0,
    unverifiable: offScale == null,
  };
  logger.warn('analysis: top-box of 0 against a healthy base — verify scale labels', flag);
  return flag;
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
  norm,
  cleanOptions,
  resolveBoxSet,
  offScaleCount,
  auditZeroBox,
  ZERO_BOX_HEALTHY_BASE,
};
