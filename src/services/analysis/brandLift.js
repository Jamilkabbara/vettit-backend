/**
 * Pass 46 Phase 3 — brand_lift deterministic analysis.
 *
 * Doctrine: the LLM does NOT compute methodology math. Every number in
 * the brand-lift report block is computed here, deterministically, from
 * clean mission_responses rows. The narrator LLM only writes prose ABOUT
 * the object this module returns. No LLM calls, no new dependencies.
 *
 * Metadata contract — quoted from src/services/claudeAI.js
 * BRAND_LIFT_SURVEY_GEN_SYSTEM (Pass 28 B, ~lines 215-275). Each
 * generated question carries:
 *   "funnel_stage": "screening|unaided_ad_recall|aided_ad_recall|
 *       unaided_brand_awareness|aided_brand_awareness|brand_familiarity|
 *       brand_favorability|brand_consideration|purchase_intent|nps|
 *       message_association|channel_specific_recall"
 *   "kpi_category": "screening|ad_recall|awareness|perception|
 *       consideration|intent|advocacy"
 *   "is_lift_question": true   (false ONLY on the q1 screener:
 *       'Question 1 MUST be a screening question with
 *        funnel_stage="screening", kpi_category="screening",
 *        is_lift_question=false. All other questions:
 *        is_lift_question=true.')
 *   "channel_id": null | <channel id on channel_specific_recall>
 *
 * Exposure cells — rows carry exposure_status ∈
 * {'exposed','control','not_applicable'} (src/jobs/runMission.js Pass 27
 * propagation; src/services/ai/recruitLoop.js loop path). Rows that are
 * neither 'exposed' nor 'control' are ignored for lift math but counted
 * in cells.not_applicable.
 */

const {
  byQuestion,
  ratingStats,
  twoProportionTest,
  normalCdf,
  round4,
  personaCount,
  num,
  isSkip,
} = require('./shared');

// Pass 46 Phase 3 — multi-select brand-contains math only applies to the
// aided recall/awareness batteries, whose options "must include the brand
// + every supplied competitor" (BRAND_LIFT_SURVEY_GEN_SYSTEM: 'aided_ad_recall /
// aided_brand_awareness → "multi" (options must include the brand + every
// supplied competitor)'). message_association options are message takeaways
// and channel_specific_recall options are channel names, so a brand-contains
// rate there would be meaningless — those multis get a null block instead.
const AIDED_BRAND_STAGES = new Set(['aided_ad_recall', 'aided_brand_awareness']);
// Legacy fallback when funnel_stage is missing but kpi_category survived.
const AIDED_BRAND_KPIS = new Set(['ad_recall', 'awareness']);

/**
 * Welch z-test for two independent means (unequal variances).
 * z = (m1 − m2) / √(s1²/n1 + s2²/n2), two-sided p via the shared
 * normal CDF, significance at 90/95% (|z| ≥ 1.6449 / 1.96).
 *
 * Pass 46 Phase 3 — implemented locally (shared.js only has the
 * two-proportion test); unit-tested with hand-computed fixtures in
 * test/brand_lift_analysis.test.js.
 *
 * Edge rules (JSON-safe, never NaN/Infinity):
 *  - either side empty → null
 *  - se === 0 with equal means → { z: 0, p: 1, sig90: false, sig95: false }
 *  - se === 0 with different means (zero-variance separation) → null
 *
 * @param {Array<number>} numsA exposed-cell numeric answers
 * @param {Array<number>} numsB control-cell numeric answers
 * @returns {{z:number,p:number,sig90:boolean,sig95:boolean}|null}
 */
function welchZTest(numsA, numsB) {
  const a = (numsA || []).map((v) => num(v)).filter((v) => v !== null);
  const b = (numsB || []).map((v) => num(v)).filter((v) => v !== null);
  const n1 = a.length;
  const n2 = b.length;
  if (n1 === 0 || n2 === 0) return null;
  const m1 = a.reduce((s, v) => s + v, 0) / n1;
  const m2 = b.reduce((s, v) => s + v, 0) / n2;
  const v1 = n1 > 1 ? a.reduce((s, v) => s + (v - m1) ** 2, 0) / (n1 - 1) : 0;
  const v2 = n2 > 1 ? b.reduce((s, v) => s + (v - m2) ** 2, 0) / (n2 - 1) : 0;
  const se = Math.sqrt(v1 / n1 + v2 / n2);
  if (se === 0) {
    return m1 === m2 ? { z: 0, p: 1, sig90: false, sig95: false } : null;
  }
  const z = (m1 - m2) / se;
  const p = 2 * (1 - normalCdf(Math.abs(z)));
  return {
    z: round4(z),
    p: round4(p),
    sig90: Math.abs(z) >= 1.6449,
    sig95: Math.abs(z) >= 1.96,
  };
}

/**
 * A question enters the lift funnel when is_lift_question === true, or —
 * for legacy rows generated before the flag existed — when it carries a
 * non-screening funnel_stage. is_lift_question === false (the screener)
 * is always excluded.
 */
function isLiftQuestion(q) {
  if (!q) return false;
  if (q.is_lift_question === true) return true;
  if (q.is_lift_question === false) return false;
  return typeof q.funnel_stage === 'string'
    && q.funnel_stage.length > 0
    && q.funnel_stage !== 'screening'
    && q.funnel_stage !== 'screener';
}

/** Options whose text contains 'yes' (case-insensitive) count as affirmative. */
function yesLikeOptions(options) {
  return (options || [])
    .map((o) => String(o).toLowerCase())
    .filter((o) => o.includes('yes'));
}

/** Scalar answer for single-choice rows; stray arrays use their first element. */
function scalarAnswer(answer) {
  const a = Array.isArray(answer) ? answer[0] : answer;
  // A 'not_applicable' skip is excluded (null) so it never sits in a funnel-rate
  // denominator.
  if (a === null || a === undefined || a === '' || isSkip(a)) return null;
  return String(a);
}

/**
 * Count Yes-like answers in a cell for a single-choice question.
 * With options present, an answer is positive when it equals (case-
 * insensitive) an option containing 'Yes'; with no options, fall back
 * to the answer text itself containing 'yes'.
 */
function countYes(rows, options) {
  const yes = yesLikeOptions(options);
  let n = 0;
  let positive = 0;
  for (const r of rows || []) {
    const a = scalarAnswer(r.answer);
    if (a === null) continue;
    n += 1;
    const low = a.toLowerCase();
    const hit = yes.length > 0 ? yes.includes(low) : low.includes('yes');
    if (hit) positive += 1;
  }
  return { n, positive };
}

/**
 * Count brand-containing answers in a cell for an aided multi-select.
 * Positive = the answer array contains an element whose text contains
 * mission.brand_name (case-insensitive substring match).
 */
function countBrand(rows, brandLower) {
  let n = 0;
  let positive = 0;
  for (const r of rows || []) {
    const a = r.answer;
    if (a === null || a === undefined || (Array.isArray(a) && a.length === 0) || a === '') continue;
    n += 1;
    const arr = Array.isArray(a) ? a : [a];
    if (arr.some((el) => String(el).toLowerCase().includes(brandLower))) positive += 1;
  }
  return { n, positive };
}

/** Numeric answers in a cell (raw, unrounded — feeds the Welch test). */
function numericAnswers(rows) {
  return (rows || []).map((r) => num(r.answer)).filter((v) => v !== null);
}

/**
 * Classify a lift question into the math it supports.
 * @returns {{kind:'proportion_yes'|'proportion_brand'|'mean'}|{kind:null,reason:string}}
 */
function classify(q, brandLower) {
  const type = q.type;
  if (type === 'rating') return { kind: 'mean' };
  if (type === 'multi') {
    const aided = AIDED_BRAND_STAGES.has(q.funnel_stage)
      || (!q.funnel_stage && AIDED_BRAND_KPIS.has(q.kpi_category));
    if (!aided) return { kind: null, reason: 'no_positive_definition' };
    if (!brandLower) return { kind: null, reason: 'no_brand_anchor' };
    return { kind: 'proportion_brand' };
  }
  if (type === 'single' || type === 'opinion') {
    const hasOptions = Array.isArray(q.options) && q.options.length > 0;
    if (hasOptions && yesLikeOptions(q.options).length === 0) {
      return { kind: null, reason: 'no_affirmative_option' };
    }
    return { kind: 'proportion_yes' };
  }
  if (type === 'text') return { kind: null, reason: 'unsupported_type_text' };
  return { kind: null, reason: 'unsupported_type' };
}

/** Build one funnel entry for a lift question. Never throws, never emits NaN. */
function funnelEntry(q, eRows, cRows, brandLower) {
  const base = {
    question_id: q.id ?? q.question_id ?? null,
    text: q.text ?? null,
    funnel_stage: q.funnel_stage ?? null,
    kpi_category: q.kpi_category ?? null,
  };
  const cls = classify(q, brandLower);

  if (cls.kind === null) {
    return {
      ...base,
      type: null,
      exposed: { n: eRows.length },
      control: { n: cRows.length },
      lift_abs: null,
      lift_rel_pct: null,
      significance: null,
      reason: cls.reason,
    };
  }

  if (cls.kind === 'mean') {
    const eNums = numericAnswers(eRows);
    const cNums = numericAnswers(cRows);
    const exposed = ratingStats(eRows) || { n: 0 };
    const control = ratingStats(cRows) || { n: 0 };
    // Pass 46 Phase 3 — a cell with n=0 → significance null + lift null.
    if (eNums.length === 0 || cNums.length === 0) {
      return {
        ...base, type: 'mean', exposed, control,
        lift_abs: null, lift_rel_pct: null, significance: null, reason: 'empty_cell',
      };
    }
    // Lift from raw (unrounded) means so round4 happens exactly once.
    const m1 = eNums.reduce((s, v) => s + v, 0) / eNums.length;
    const m2 = cNums.reduce((s, v) => s + v, 0) / cNums.length;
    return {
      ...base,
      type: 'mean',
      exposed,
      control,
      lift_abs: round4(m1 - m2),
      lift_rel_pct: m2 !== 0 ? round4(((m1 - m2) / m2) * 100) : null,
      significance: welchZTest(eNums, cNums),
    };
  }

  // proportion_yes / proportion_brand
  const counter = cls.kind === 'proportion_brand'
    ? (rows) => countBrand(rows, brandLower)
    : (rows) => countYes(rows, q.options);
  const e = counter(eRows);
  const c = counter(cRows);
  const exposed = { n: e.n, positive: e.positive, rate: e.n > 0 ? round4(e.positive / e.n) : null };
  const control = { n: c.n, positive: c.positive, rate: c.n > 0 ? round4(c.positive / c.n) : null };
  // Pass 46 Phase 3 — a cell with n=0 → significance null + lift null.
  if (e.n === 0 || c.n === 0) {
    return {
      ...base, type: 'proportion', exposed, control,
      lift_abs: null, lift_rel_pct: null, significance: null, reason: 'empty_cell',
    };
  }
  const p1 = e.positive / e.n;
  const p2 = c.positive / c.n;
  return {
    ...base,
    type: 'proportion',
    exposed,
    control,
    lift_abs: round4(p1 - p2),
    lift_rel_pct: p2 > 0 ? round4(((p1 - p2) / p2) * 100) : null,
    significance: twoProportionTest(e.positive, e.n, c.positive, c.n),
  };
}

/**
 * Compute the full brand-lift block for a mission.
 *
 * @param {Array<{persona_id:string,question_id:string,answer:any,exposure_status:string,persona_profile:object}>} rows
 *        clean mission_responses rows
 * @param {Array<object>} questions mission.questions array (brand-lift metadata above)
 * @param {{brand_name?:string}} mission the missions row (brand_name anchors aided multi math)
 * @returns {object} JSON-serializable block — see shape in tests. Rates are
 *          0-1 fractions; every rate/mean carries its base n; incomputable
 *          blocks are null with a machine-readable reason.
 */
function computeBrandLift(rows, questions, mission) {
  const all = (Array.isArray(rows) ? rows : []).filter((r) => r && typeof r === 'object');
  const exposedRows = all.filter((r) => r.exposure_status === 'exposed');
  const controlRows = all.filter((r) => r.exposure_status === 'control');
  // 'not_applicable' (and legacy null/unknown statuses) are ignored for
  // lift math but counted so the report can state the exclusion.
  const naRows = all.filter((r) => r.exposure_status !== 'exposed' && r.exposure_status !== 'control');

  // Pass 46 Phase 3 — legacy missions with no exposure cells at all can't
  // do lift math. Return the degenerate shape; Phase 4 copy explains it.
  if (exposedRows.length === 0 && controlRows.length === 0) {
    return {
      methodology: 'brand_lift',
      cells: { exposed: { n: 0 }, control: { n: 0 }, not_applicable: { n: personaCount(naRows) } },
      funnel: [],
      summary: null,
      degenerate_reason: 'no_exposure_cells',
    };
  }

  const cells = {
    exposed: { n: personaCount(exposedRows) },
    control: { n: personaCount(controlRows) },
    not_applicable: { n: personaCount(naRows) },
  };

  const brand = mission && typeof mission.brand_name === 'string' && mission.brand_name.trim().length > 0
    ? mission.brand_name.trim().toLowerCase()
    : null;

  const eByQ = byQuestion(exposedRows);
  const cByQ = byQuestion(controlRows);
  const funnel = (Array.isArray(questions) ? questions : [])
    .filter(isLiftQuestion)
    .map((q) => {
      const qid = q.id ?? q.question_id;
      return funnelEntry(q, eByQ.get(qid) || [], cByQ.get(qid) || [], brand);
    });

  const computed = funnel.filter((f) => f.lift_abs !== null);
  let biggest = null;
  for (const f of computed) {
    if (!biggest || f.lift_abs > biggest.lift_abs) {
      biggest = { question_id: f.question_id, lift_abs: f.lift_abs };
    }
  }
  const summary = {
    // "stages" = funnel entries (one question per funnel stage by design).
    stages_lifted: computed.filter((f) => f.lift_abs > 0).length,
    stages_sig95: funnel.filter((f) => f.significance && f.significance.sig95 === true).length,
    biggest_lift: biggest,
  };

  return { methodology: 'brand_lift', cells, funnel, summary };
}

module.exports = { computeBrandLift, welchZTest };
