/**
 * Narrative figure guard - "the prose may reference computed figures, never
 * invent them".
 *
 * WHY THIS EXISTS
 * ---------------
 * reportSummaries.generateReportSummaries() asks an LLM for a 1-2 sentence
 * "what this means" per question. The only guard it had (referencesData) checks
 * that the sentence mentions SOME token from the question's data. It cannot tell
 * a correct figure from a wrong one - and worse, dataTokens() adds the raw
 * distribution COUNTS to the accepted-token set, so a sentence that prints a
 * count with a "%" glued to it sails straight through.
 *
 * Live example, mission 3fc15087 (market_entry, n=80), q3 distribution
 * {"Probably would buy":57, "Definitely would buy":3, "Might or might not":1,
 *  "Probably would NOT buy":16, "Definitely would NOT buy":3}:
 *
 *   "57% say they probably would buy, and a further 3% say they definitely
 *    would buy, giving a combined positive intent of 60%, while only 19
 *    respondents (roughly 24%) lean toward not buying."
 *
 * 57 respondents is 71.25%, not 57%. 3 is 3.75%, not 3%. The combined figure is
 * 75%, not 60%. The "19 respondents (roughly 24%)" clause in the SAME sentence
 * is correct - the model is inconsistent within one sentence, which is what a
 * purely generative figure is.
 *
 * WHAT THIS MODULE DOES
 * ---------------------
 * Given a question's computed data it derives the set of figures that COULD
 * honestly be stated about that question, then checks every numeric claim in a
 * candidate sentence against it.
 *
 *   R1 "count_as_percent": the claimed percentage is verbatim one of the raw
 *      counts and is NOT any correctly-derived percentage. This is the exact
 *      observed failure mode, and the second half of the rule exonerates a
 *      legitimate percentage that merely coincides with a count.
 *
 *   R2 "underivable_percent": the claimed percentage is not within 1 point of
 *      ANY achievable subset of the distribution over the question's base.
 *      Subsets are allowed because "combined positive intent" legitimately sums
 *      two options; the achievable-sum set is computed exactly by DP so this
 *      stays cheap at any option count.
 *
 *   R3 "underivable_count" / "wrong_base": "N respondents" / "N of M" /
 *      "N out of M" - N must be an achievable subset sum, and M when stated
 *      must be the question's base.
 *
 * ENFORCING vs ADVISORY  (added after a live false positive - read this)
 * ----------------------------------------------------------------------
 * A validator that suppresses a CORRECT sentence is worse than one that lets a
 * wrong one through: the suppression is silent, and it degrades output that was
 * already right. So the rules are tiered by their MEASURED error rate against
 * raw `mission_responses` on 66 completed production missions:
 *
 *   ENFORCING (may replace the sentence) - 18 flags, 18 confirmed, 0 wrong:
 *     count_as_percent, underivable_percent
 *
 *   ADVISORY (logs only, never replaces) - 25 flags, 3 wrong or undetermined:
 *     wrong_base, underivable_count
 *
 * Every false positive found came from the advisory pair; none from the
 * enforcing pair. The advisory rules depend on the exact bucketing of the
 * distribution, and the pipeline legitimately merges option labels differing
 * only in dash style ("SAR 26-35 / EGP 131-185" absorbing a bare
 * "EGP 131-185"), so a narrative quoting an unmerged raw count reads as
 * underivable while being true (mission b8f5abce q4). They still surface in the
 * log, where a human can act; they never silently rewrite a deliverable.
 *
 * On top of the tier, enforcement requires a POSITIVELY CONFIRMED base: the
 * counts must sum exactly to the base AND the mission sample n must agree. If a
 * base cannot be corroborated the sentence is left alone and logged - never
 * substituted against a denominator we are not sure of. This is what would have
 * stopped the one regression found in review: mission 0a494ef7 carries 300
 * personas and 2400 response rows, and an audit that read it through an
 * unpaginated 1000-row query saw a base of 125 and called a TRUE sentence
 * ("All 300 respondents confirmed...") a fabrication.
 *
 * WHAT IT DOES NOT CATCH (read this before trusting it)
 * ----------------------------------------------------
 *   - A figure that is right but ATTACHED TO THE WRONG OPTION ("71% would NOT
 *     buy" when 71% would). The arithmetic is checkable; the referent is not.
 *   - Numeric collisions. With base 80 a count of 8 is exactly 10%, so a
 *     sentence saying "10%" when it meant the count 10 is indistinguishable
 *     from a correct statement. Measured: this rule set catches 5 of the 6
 *     wrong figures on mission 3fc15087; the miss is exactly this collision.
 *   - Count claims that are coincidentally achievable sums. "38 respondents
 *     scored 6 or above" on 3fc15087 q2 is wrong (the true count is 40) but
 *     20+18 is an achievable subset, so R3 passes it.
 *   - Figure-free assertions. "a significant loyalty deficit" on NPS -20 at n=5
 *     (mission 30e1de33) contains no number, so nothing here fires. That is a
 *     statistical-hedging problem, not an arithmetic one, and belongs to the
 *     stat gate.
 *   - Narrative that contradicts a computed figure without restating it
 *     ("review individual responses to identify the ceiling" on 34c57e35, whose
 *     report headlines a computed Van Westendorp OPP). No number, no check.
 *   - Renderers with no single honest denominator (attribute_battery matrices,
 *     max_diff best/worst) are returned UNCHECKED rather than guessed at.
 *   - Anything the sentence says about a DIFFERENT question or about the mission
 *     as a whole. Scope is one question's own computed data.
 *
 * Because of those holes this is a leak-catcher, not the fix. The fix is that
 * the prompt now RECEIVES the percentages (compactQuestionForPrompt in
 * reportSummaries.js) so it never has to derive one.
 */

/** Percent claims: "57%", "23.75 %", "60 percent", "24 per cent". */
const PERCENT_RE = /(?<![\d.])(\d+(?:\.\d+)?)\s*(?:%|per\s?cents?\b|percents?\b)/gi;

/**
 * Count claims. Word-number forms ("thirty verbatims") are deliberately not
 * parsed - they carry no arithmetic risk worth the false-positive surface.
 */
const COUNT_OF_RE = /(?<![\w.])(\d+)\s+(?:of|out\s+of)\s+(\d+)(?![\d.])/gi;
const COUNT_UNIT_RE = /(?<![\w.])(\d+)\s+(respondents?|people|persons?|answers?|responses?|participants?)\b/gi;

/**
 * A percent immediately followed by statistical vocabulary is a CONFIDENCE
 * LEVEL, not a share of respondents: "a 95% confidence interval of 6.38 to
 * 7.62". Without this, every sentence quoting the CI that computeRatingStats
 * already produced gets flagged.
 */
const STAT_LEVEL_AFTER_RE = /^\s*(?:confidence|ci\b|c\.i\.|significan|margin\s+of\s+error|certain|sure\b)/i;

/**
 * Rules whose flags may REPLACE a sentence. Everything else logs only.
 * See the ENFORCING vs ADVISORY block above for the measured justification.
 */
const ENFORCING_RULES = new Set(['count_as_percent', 'underivable_percent']);

/** Renderers whose data has no single honest denominator - skip, never guess. */
const UNCHECKABLE_RENDERERS = new Set(['attribute_battery', 'max_diff', 'open_text_verbatims']);

function finite(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * Every subset sum reachable from `counts`, as a Set of integers.
 * Exact, via boolean DP over 0..total - O(options x total), so a 12-option
 * n=1000 question is ~12k writes. Always contains 0.
 */
function achievableSums(counts) {
  const total = counts.reduce((a, b) => a + b, 0);
  const reach = new Uint8Array(total + 1);
  reach[0] = 1;
  for (const c of counts) {
    if (!Number.isInteger(c) || c <= 0) continue;
    for (let s = total - c; s >= 0; s--) if (reach[s]) reach[s + c] = 1;
  }
  const out = new Set();
  for (let s = 0; s <= total; s++) if (reach[s]) out.add(s);
  return out;
}

/**
 * The figures a sentence about this question may honestly state.
 * @param {object} qdata     canonical q.data (buildCanonicalReport survey entry)
 * @param {string} renderer  canonical q.renderer
 * @returns {null|{base:number, counts:number[], countSet:Set<number>,
 *                 sums:Set<number>, exactPcts:Set<number>}}
 *          null when the question offers no honest denominator.
 */
function buildFigureSet(qdata, renderer) {
  if (!qdata || typeof qdata !== 'object') return null;
  if (UNCHECKABLE_RENDERERS.has(renderer)) return null;

  const dist = qdata.distribution;
  if (!dist || typeof dist !== 'object' || Array.isArray(dist)) return null;

  const counts = Object.values(dist)
    .map(finite)
    .filter((v) => v !== null && Number.isInteger(v) && v >= 0);
  if (!counts.length) return null;

  const sum = counts.reduce((a, b) => a + b, 0);
  // The headline denominator: respondents where the shape defines them.
  const base = finite(qdata.n_respondents) ?? finite(qdata.n) ?? sum;
  if (!base || base <= 0) return null;

  // ...but more than one denominator can be honest for the same question, and
  // the product itself uses both. deterministicQuestionInsight's default branch
  // denominates on the SUM OF SELECTIONS ("led with 22% (59 of 274)") while
  // q.data.n counts respondents (125) - a real gap wherever a question's answers
  // overlap. Admitting every computed base keeps the guard from flagging the
  // product's own grounded prose, and costs nothing against fabrication: an
  // invented sample size (mission 0a494ef7's "233 of 300", where the computed
  // bases are 125 and 274) still matches none of them.
  const bases = new Set([finite(qdata.n_respondents), finite(qdata.n), sum]
    .filter((b) => Number.isFinite(b) && b > 0));

  // Achievable subsets, PLUS their complements against each base. A multi-select
  // narrative legitimately says "2 of 5 respondents did NOT recognize it" when
  // the brand scored 3 of 5 - and 2 is not a subset sum of overlapping option
  // counts, so without complements that correct sentence is flagged. For
  // single-select the counts already partition the base, so complements add
  // nothing and the rule loses no power.
  const subsets = achievableSums(counts);
  const sums = new Set(subsets);
  for (const s of subsets) for (const b of bases) if (b - s >= 0) sums.add(b - s);

  const exactPcts = new Set();
  for (const s of sums) for (const b of bases) exactPcts.add(Math.round((s / b) * 100));

  return { base, bases, counts, countSet: new Set(counts), sums, exactPcts };
}

/**
 * Character ranges in `text` occupied by a verbatim option label. A label like
 * "SAR 39-50 / EGP 201-270 per meal" or "10% off" carries digits that belong to
 * the QUESTION, not to a claim by the narrator - claims landing inside one of
 * these ranges are ignored.
 */
function labelRanges(text, qdata) {
  const ranges = [];
  const labels = Object.keys((qdata && qdata.distribution) || {})
    .filter((l) => typeof l === 'string' && /\d/.test(l) && l.length >= 3);
  const lc = text.toLowerCase();
  for (const label of labels) {
    const needle = label.toLowerCase();
    let from = 0;
    for (;;) {
      const at = lc.indexOf(needle, from);
      if (at === -1) break;
      ranges.push([at, at + needle.length]);
      from = at + 1;
    }
  }
  return ranges;
}

function inAnyRange(idx, ranges) {
  return ranges.some(([a, b]) => idx >= a && idx < b);
}

/**
 * Numbers that belong to the QUESTION rather than to its answers: anything
 * written into the question text, an option label, or the scale bounds.
 *
 * A pricing question that asks about "a 20% price increase" makes "20%" part of
 * the stimulus - a sentence repeating it is quoting the question, not asserting
 * a share of respondents. Without this exclusion the guard flags mission
 * 34c57e35 q13 ("a 20% price increase ... averages 3.4 out of 5") purely for
 * echoing its own question.
 */
function stimulusNumbers(question, qdata) {
  const out = new Set();
  const harvest = (s) => {
    const re = /(?<![\d.])(\d+(?:\.\d+)?)/g;
    for (let m = re.exec(String(s)); m; m = re.exec(String(s))) out.add(Number(m[1]));
  };
  if (question && question.text) harvest(question.text);
  for (const label of Object.keys((qdata && qdata.distribution) || {})) harvest(label);
  for (const o of (question && question.options) || []) {
    harvest(typeof o === 'string' ? o : (o && (o.label || o.text)) || '');
  }
  if (qdata && qdata.scale_max != null) out.add(Number(qdata.scale_max));
  if (qdata && qdata.scale_min != null) out.add(Number(qdata.scale_min));
  return out;
}

/**
 * True when `d` is a rating-scale ceiling rather than a sample base - i.e. the
 * "4 out of 5 stars" / "7 out of 10" idiom. Distribution keys of a scale
 * question ARE the rating values, so a stated denominator matching scale_max
 * (or being a rating key) is scale talk, not a base claim.
 */
function isScaleCeiling(d, qdata) {
  if (!qdata) return false;
  if (qdata.scale_max != null && Number(qdata.scale_max) === d) return true;
  return Object.prototype.hasOwnProperty.call(qdata.distribution || {}, String(d));
}

/**
 * Check one narrative sentence against one question's computed figures.
 *
 * @param {string} text      the candidate insight sentence
 * @param {object} question  canonical survey question ({ renderer, data, text, options })
 * @param {number|null} sampleN  the mission's own sample size (report.header.sample.n),
 *        used to CORROBORATE the question's base. Without corroboration nothing
 *        is ever substituted, only logged.
 * @returns {{checked:boolean, ok:boolean, violations:Array<{rule,claim,value,reason}>}}
 *          checked=false means the question offered no honest denominator; treat
 *          that as "no opinion", not as a pass. `substitutable` is the ONLY flag
 *          a caller may act on destructively; `ok` and `violations` are for
 *          reporting and logging.
 */
function checkNarrativeFigures(text, question, sampleN = null) {
  const empty = {
    checked: false, ok: true, violations: [], baseConfirmed: false, substitutable: false,
  };
  if (typeof text !== 'string' || !text.trim()) return empty;
  const qdata = question && question.data;
  const fig = buildFigureSet(qdata, question && question.renderer);
  if (!fig) return empty;

  const { base, bases, countSet, sums, exactPcts } = fig;
  const violations = [];
  const skip = labelRanges(text, qdata);
  const stimulus = stimulusNumbers(question, qdata);

  /** True when `p` is within 1 point of some achievable subset's share of SOME computed base. */
  const percentDerivable = (p) => {
    for (const b of bases) for (const s of sums) if (Math.abs(p - (s / b) * 100) <= 1) return true;
    return false;
  };

  PERCENT_RE.lastIndex = 0;
  for (let m = PERCENT_RE.exec(text); m; m = PERCENT_RE.exec(text)) {
    if (inAnyRange(m.index, skip)) continue;
    const value = Number(m[1]);
    if (!Number.isFinite(value)) continue;
    if (stimulus.has(value)) continue;
    if (STAT_LEVEL_AFTER_RE.test(text.slice(m.index + m[0].length))) continue;
    if (countSet.has(value) && !exactPcts.has(value)) {
      violations.push({
        rule: 'count_as_percent',
        claim: m[0].trim(),
        value,
        reason: `${value} is a raw respondent count for this question; as a share of ${base} it is ${((value / base) * 100).toFixed(1)}%`,
      });
      continue;
    }
    if (!percentDerivable(value)) {
      violations.push({
        rule: 'underivable_percent',
        claim: m[0].trim(),
        value,
        reason: `no combination of this question's answers is ${value}% of ${base}`,
      });
    }
  }

  COUNT_OF_RE.lastIndex = 0;
  for (let m = COUNT_OF_RE.exec(text); m; m = COUNT_OF_RE.exec(text)) {
    if (inAnyRange(m.index, skip)) continue;
    const n = Number(m[1]);
    const d = Number(m[2]);
    if (isScaleCeiling(d, qdata)) continue; // "4 out of 5 stars", not "4 of 5 people"
    if (!bases.has(d)) {
      violations.push({
        rule: 'wrong_base',
        claim: m[0].trim(),
        value: d,
        reason: `stated denominator ${d} is not a computed base for this question (${[...bases].join(' or ')})`,
      });
    } else if (!sums.has(n)) {
      violations.push({
        rule: 'underivable_count',
        claim: m[0].trim(),
        value: n,
        reason: `no combination of this question's answers totals ${n}`,
      });
    }
  }

  COUNT_UNIT_RE.lastIndex = 0;
  for (let m = COUNT_UNIT_RE.exec(text); m; m = COUNT_UNIT_RE.exec(text)) {
    if (inAnyRange(m.index, skip)) continue;
    const n = Number(m[1]);
    if (stimulus.has(n)) continue;
    if (!sums.has(n)) {
      violations.push({
        rule: 'underivable_count',
        claim: m[0].trim(),
        value: n,
        reason: `no combination of this question's answers totals ${n} (base ${base})`,
      });
    }
  }

  for (const v of violations) v.enforceable = ENFORCING_RULES.has(v.rule);

  // A base is trustworthy only when the distribution ACCOUNTS FOR IT EXACTLY
  // and the mission's own sample size agrees.
  //
  // NB `bases` deliberately contains the selection sum, so `bases.has(distSum)`
  // is true by construction and proves nothing - an earlier cut of this check
  // did exactly that and confirmed every base it was handed, including
  // af36a36d q1 where 25 selections sit under a stated base of 10. Compare
  // against the DECLARED respondent base instead.
  const distSum = fig.counts.reduce((a, b) => a + b, 0);
  const declaredBase = finite(qdata.n_respondents) ?? finite(qdata.n);
  const isMulti = question && question.renderer === 'multi_select';
  const accountsForBase = isMulti
    // Multi-select answers overlap, so selections legitimately exceed the base;
    // what corroborates it is that the pipeline tracked respondents separately.
    ? finite(qdata.n_respondents) != null && distSum >= declaredBase
    : declaredBase != null && distSum === declaredBase;
  const sampleAgrees = sampleN == null || bases.has(Number(sampleN));
  const baseConfirmed = Boolean(accountsForBase && sampleAgrees);

  return {
    checked: true,
    ok: violations.length === 0,
    violations,
    base,
    baseConfirmed,
    // The ONLY condition under which a caller may replace the sentence.
    substitutable: baseConfirmed && violations.some((v) => v.enforceable),
  };
}

/**
 * Percentages, pre-computed, for a question's distribution - the figures the
 * prompt is handed so it never has to derive one.
 * @returns {null|{base:number, pct:Object<string,number>}} integer percentages
 *          of `base`, keyed by the same option labels as the distribution.
 */
function distributionPercentages(qdata, renderer) {
  const fig = buildFigureSet(qdata, renderer);
  if (!fig) return null;
  const pct = {};
  for (const [k, v] of Object.entries(qdata.distribution)) {
    const n = finite(v);
    if (n === null) continue;
    pct[k] = Math.round((n / fig.base) * 100);
  }
  return { base: fig.base, pct };
}

module.exports = {
  checkNarrativeFigures,
  distributionPercentages,
  buildFigureSet,
  achievableSums,
};
