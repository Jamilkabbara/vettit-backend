/**
 * Pass 46 Phase 3 — marketing (ad_effectiveness) deterministic analysis.
 *
 * Doctrine: the LLM does NOT compute methodology math. Every number in
 * the ad-effectiveness report block is computed here, deterministically,
 * from clean mission_responses rows. The narrator LLM only writes prose
 * ABOUT the object this module returns. No LLM calls, no new deps.
 *
 * Metadata contract — quoted from src/services/claudeAI.js
 * MARKETING_SURVEY_GEN_SYSTEM (Pass 30 B5, ~lines 1288-1351). Each
 * generated question carries:
 *   "methodology": "ad_effectiveness"
 *   "funnel_stage": "screener|recall|exposure|attribution|message|
 *       likeability|stopping|distinctiveness|emotional|persuasion|
 *       message_match|sharing"
 * Fixed battery order (validateMarketingSurvey enforces it):
 *   q1  screener        — single, qualifies category buyers
 *   q2  recall          — UNAIDED recall, type="text"
 *   q3  exposure        — creative acknowledgement, type="text" (no metric)
 *   q4  recall          — AIDED recall, type="single",
 *                         options=["Yes","No","Not sure"]
 *   q5  attribution     — "Whose ad is this?" type="text"
 *   q6  message         — "What's the main message?" type="text"
 *   q7  likeability     — rating 1-7
 *   q8  stopping        — rating 1-7   (emitted as funnel.stopping_power)
 *   q9  distinctiveness — rating 1-7
 *   q10 emotional       — multi (Amused/Inspired/Curious/…)
 *   q11 persuasion      — rating 1-7
 *   q12 message_match   — single ["Yes","Somewhat","No"], ONLY when
 *                         intended_message was supplied
 *   q13 sharing         — single ["Yes","Maybe","No"]
 *
 * Note the 'recall' stage holds TWO questions (q2 unaided text + q4 aided
 * single); they are disambiguated by question type below. Stages absent
 * from the data are emitted as null — never invented.
 */

const {
  byQuestion,
  distribution,
  ratingStats,
  round4,
  isSkip,
  norm,
  resolveBoxSet,
  offScaleCount,
  auditZeroBox,
} = require('./shared');

/**
 * Pass 51 — affirmative-option fallback, used only when a question is not the
 * canonical shape. Options whose text contains 'yes' count as affirmative.
 * This used to be the ONLY rule; it is now the backstop behind positional
 * resolution (see positiveRateBlock).
 */
function yesLikeOptions(options) {
  return (options || [])
    .map((o) => String(o))
    .filter((o) => o.toLowerCase().includes('yes'));
}

/** Scalar answer for single-choice rows; stray arrays use their first element. */
function scalarAnswer(answer) {
  const a = Array.isArray(answer) ? answer[0] : answer;
  // A 'not_applicable' skip is excluded (returns null) so it never lands in a
  // rate denominator — e.g. aided ad-recall skipped by non-recallers must not
  // deflate the recall rate.
  if (a === null || a === undefined || a === '' || isSkip(a)) return null;
  return String(a);
}

/**
 * Positive-rate block for a Yes-anchored single-choice battery question
 * (aided recall "Yes"/"No"/"Not sure", sharing "Yes"/"Maybe"/"No",
 * message_match "Yes"/"Somewhat"/"No"). An answer is positive when it
 * equals (case-insensitive) an option containing 'Yes'; with no options
 * metadata, falls back to the answer text containing 'yes'.
 * @returns {{n:number, positive_rate:number}|null} null when no usable answers
 */
function positiveRateBlock(entries, stageTag) {
  let n = 0;
  let positive = 0;
  let offScale = 0;
  let sawOptions = false;
  const bases = new Set();
  let questionId = null;
  for (const { q, rows } of entries) {
    // Pass 51 — every canonical Yes-anchored battery question in this
    // methodology is a 3-option single whose AFFIRMATIVE IS THE FIRST OPTION:
    //   q4  aided recall  ["Yes","No","Not sure"]     (claudeAI.js:1329)
    //   q12 message match ["Yes","Somewhat","No"]     (claudeAI.js:1337)
    //   q13 sharing       ["Yes","Maybe","No"]        (claudeAI.js:1338)
    // so the affirmative is read POSITIONALLY, guarded on funnel_stage + type
    // + option count. Anything off that shape falls back to the historic
    // 'contains yes' rule rather than trusting an order we cannot vouch for.
    const box = resolveBoxSet({
      question: q,
      tag: stageTag ? { key: 'funnel_stage', value: stageTag } : null,
      type: 'single',
      size: 1,
      expectedLength: 3,
      from: 'head',
      fallbackLabels: yesLikeOptions(q.options),
    });
    bases.add(box.basis);
    if (box.optionSet) sawOptions = true;
    if (questionId === null) questionId = q.id ?? q.question_id ?? null;
    const answers = [];
    for (const r of rows) {
      const a = scalarAnswer(r.answer);
      if (a === null) continue;
      n += 1;
      answers.push(a);
      // With no options metadata at all there is nothing positional or literal
      // to match, so the last-resort answer-text rule stands.
      const hit = box.set.size > 0 ? box.set.has(norm(a)) : norm(a).includes('yes');
      if (hit) positive += 1;
    }
    const off = offScaleCount(answers, box.optionSet);
    if (off != null) offScale += off;
  }
  if (n === 0) return null;
  const offTotal = sawOptions ? offScale : null;
  const basis = bases.size === 1 ? [...bases][0] : 'mixed';
  return {
    n,
    positive_rate: round4(positive / n),
    scale_basis: basis,
    off_scale_n: offTotal,
    zero_box_flag: auditZeroBox({
      metric: `marketing_${stageTag || 'positive'}_rate`,
      questionId,
      count: positive,
      base: n,
      basis,
      offScale: offTotal,
    }),
  };
}

/** Pool the response rows of every question in a stage entry list. */
function poolRows(entries) {
  const out = [];
  for (const { rows } of entries) out.push(...rows);
  return out;
}

/** Up to `cap` trimmed non-empty string answers (verbatims for the narrator). */
function verbatims(entries, cap = 30) {
  const out = [];
  for (const r of poolRows(entries)) {
    if (typeof r.answer === 'string' && r.answer.trim().length > 0) {
      out.push(r.answer.trim());
      if (out.length >= cap) return out;
    }
  }
  return out;
}

/**
 * Compute the full marketing / ad_effectiveness block for a mission.
 *
 * @param {Array<{persona_id:string,question_id:string,answer:any,exposure_status:string,persona_profile:object}>} rows
 *        clean mission_responses rows (exposure_status is unused — ad
 *        effectiveness has no exposed/control split)
 * @param {Array<object>} questions mission.questions array (funnel_stage metadata above)
 * @param {{brand_name?:string}} mission the missions row (brand_name anchors attribution correctness)
 * @returns {object} JSON-serializable block. Rates are 0-1 fractions; every
 *          rate/mean carries its base n; absent stages are null.
 */
function computeMarketing(rows, questions, mission) {
  const all = (Array.isArray(rows) ? rows : []).filter((r) => r && typeof r === 'object');
  const byQ = byQuestion(all);

  // stage → [{q, rows}] (a stage can hold several questions, e.g. 'recall').
  const stages = new Map();
  for (const q of Array.isArray(questions) ? questions : []) {
    if (!q || typeof q.funnel_stage !== 'string' || q.funnel_stage.length === 0) continue;
    const qid = q.id ?? q.question_id;
    if (!stages.has(q.funnel_stage)) stages.set(q.funnel_stage, []);
    stages.get(q.funnel_stage).push({ q, rows: byQ.get(qid) || [] });
  }
  const stage = (name, predicate) => {
    const entries = stages.get(name) || [];
    return predicate ? entries.filter(({ q }) => predicate(q)) : entries;
  };

  // ── recall (aided): the funnel_stage="recall" question with type="single"
  // (q4 "Have you seen this ad before?" options ["Yes","No","Not sure"]).
  const recallAided = positiveRateBlock(stage('recall', (q) => q.type !== 'text'), 'recall');

  // ── attribution: funnel_stage="attribution" free text ("Whose ad is
  // this?"). Correct = answer contains mission.brand_name (case-insensitive
  // substring) — only computable when the mission carries a brand anchor.
  const brand = mission && typeof mission.brand_name === 'string' && mission.brand_name.trim().length > 0
    ? mission.brand_name.trim().toLowerCase()
    : null;
  let attribution = null;
  if (brand) {
    let n = 0;
    let correct = 0;
    for (const r of poolRows(stage('attribution'))) {
      const a = scalarAnswer(r.answer);
      if (a === null) continue;
      n += 1;
      if (a.toLowerCase().includes(brand)) correct += 1;
    }
    attribution = n > 0 ? { n, correct_rate: round4(correct / n) } : null;
  }

  // ── rating stages: funnel_stage="likeability" / "stopping" /
  // "distinctiveness" / "persuasion", all rating 1-7. ratingStats → null
  // when the stage is absent or has no numeric answers.
  const ratingStage = (name) => ratingStats(poolRows(stage(name)));

  // ── emotional: funnel_stage="emotional" multi; distribution counts each
  // selection, n is the respondent base the shares are read against.
  const emoRows = poolRows(stage('emotional')).filter((r) => {
    const a = r.answer;
    return !(a === null || a === undefined || a === '' || (Array.isArray(a) && a.length === 0));
  });
  const emotional = emoRows.length > 0
    ? { n: emoRows.length, distribution: distribution(emoRows) }
    : null;

  return {
    methodology: 'marketing',
    funnel: {
      recall_aided: recallAided,
      attribution,
      likeability: ratingStage('likeability'),
      // funnel_stage value is "stopping"; report key is stopping_power.
      stopping_power: ratingStage('stopping'),
      distinctiveness: ratingStage('distinctiveness'),
      persuasion: ratingStage('persuasion'),
      emotional,
      // funnel_stage="message_match" single ["Yes","Somewhat","No"] — only
      // generated when intended_message was supplied; null otherwise.
      message_match: positiveRateBlock(stage('message_match', (q) => q.type !== 'text'), 'message_match'),
      sharing: positiveRateBlock(stage('sharing', (q) => q.type !== 'text'), 'sharing'),
    },
    // Pass 46 Phase 3 — no benchmark DB yet; Phase 4 copy labels these
    // unbenchmarked. Kept as an explicit null so the shape is stable.
    norms: null,
    openEnded: {
      // funnel_stage="recall" type="text" = q2 unaided recall verbatims.
      recall_unaided_verbatims: verbatims(stage('recall', (q) => q.type === 'text')),
      // funnel_stage="message" type="text" = q6 main-message verbatims.
      message_verbatims: verbatims(stage('message')),
    },
  };
}

module.exports = { computeMarketing };
