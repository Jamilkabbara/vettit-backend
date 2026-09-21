/**
 * Multi-select questions must let a respondent say "none".
 *
 * Mission 3fc15087 asked "What factors would make you hesitate ... Select all
 * that apply." over nine concerns, with no "none of these", no cap, and the
 * first option merging two separate worries ("halal certification OR religious
 * compliance"). Respondents ticked 4.6 of 9 options each, and the top option
 * came back at 98%. That number measured the question, not the market: a
 * respondent with no hesitation had nothing to click, so every respondent had
 * to contribute concerns.
 *
 * Four rules, applied to every generated survey:
 *
 *   1. ESCAPE OPTION. Every multi-select ends with a way out ("None of these").
 *      Without it the question presumes its own premise.
 *   2. CAP. Concern-style batteries cap at 3 selections, so the answer ranks
 *      what matters instead of listing everything plausible. Awareness and
 *      recall batteries are exempt: "which of these have you heard of" is a
 *      count, and capping it would under-report awareness.
 *   3. ONE CONCERN PER OPTION. An option that merges two concerns with "or"
 *      collects the ticks of both and can be read as either. This one is a
 *      PROMPT RULE plus an advisory list for whoever reviews the survey, not an
 *      automated rule: no text rule can tell "halal certification or religious
 *      compliance" (two concerns) from "supermarkets or delivery apps" (one).
 *      Auto-splitting is never done - it would change what was asked.
 *   4. ROTATION. Option order rotates per respondent, so the first item does
 *      not collect the extra ticks that first items always collect. Only
 *      unordered lists rotate: scales, price bands and frequency ladders keep
 *      their order, and the escape option stays last.
 *
 * Nothing here rewrites a question a customer already approved: generation is
 * normalised, and an existing survey is only inspected and reported.
 */
'use strict';

const DEFAULT_ESCAPE = 'None of these';
const DEFAULT_MAX_SELECTIONS = 3;

/** An option that means "nothing here applies to me". */
const ESCAPE_RE = /^(none\b|no(ne)? of (these|the above|them)|nothing\b|not applicable\b|n\/a\b|no concerns?\b|no hesitations?\b)/i;

/** Counting batteries: capping them would under-report the thing being counted. */
const COUNTING_METHODOLOGY_RE = /aided|unaided|recall|awareness|mindshare|consideration|brand_list/i;
const COUNTING_TEXT_RE = /heard of|aware of|seen or heard|recognise|recognize|which .*(brands|channels|platforms|retailers).*(know|use|shop|buy)/i;

/** Ordered lists keep their order: a rotated scale is a broken scale. */
const ORDERED_WORD_RE = /\b(strongly|somewhat|definitely|probably|neutral|agree|disagree|never|rarely|sometimes|often|always|daily|weekly|monthly|yearly|less than|more than|very |extremely |not at all)\b/i;
const NUMERIC_RANGE_RE = /\d+\s*(?:-|–|to)\s*\d+|\d+\s*\+|\bunder \d|\bover \d|\bup to \d/i;

const text = (q) => String((q && (q.text || q.question || q.title)) || '');
const optionsOf = (q) => (Array.isArray(q && q.options) ? q.options.filter((o) => o != null).map(String) : []);
const isMulti = (q) => q && (q.type === 'multi' || q.type === 'multiple' || q.type === 'multi_select');

function hasEscapeOption(q) {
  return optionsOf(q).some((o) => ESCAPE_RE.test(o.trim()));
}

/** True when the battery counts things the respondent knows, not things they feel. */
function isCountingBattery(q) {
  const m = String((q && (q.methodology || q.kpi_category || q.funnel_stage)) || '');
  return COUNTING_METHODOLOGY_RE.test(m) || COUNTING_TEXT_RE.test(text(q));
}

/**
 * ADVISORY ONLY. Options that MIGHT merge two concerns.
 *
 * This cannot be decided from the text. Of the nine options in the question
 * that prompted this module, a word-level rule flags five, and only one is
 * genuinely two concerns:
 *
 *   "halal certification or religious compliance"            two concerns
 *   "local supermarkets or online delivery platforms"        one: availability
 *   "home-cooked or traditionally prepared meals"            one: home cooking
 *   "similar or cheaper options"                             one: competition
 *
 * So this list is a prompt for a human reading the survey, never a rule that
 * blocks anything: findViolations() deliberately leaves it out. What actually
 * prevents merged options is the instruction in MULTI_SELECT_PROMPT_RULES, and
 * the author reviewing the survey before they pay for it.
 */
function doubleBarrelledOptions(q) {
  return optionsOf(q).filter((o) => {
    if (ESCAPE_RE.test(o.trim())) return false;
    const parts = o.split(/\s+or\s+/i);
    if (parts.length !== 2) return false;
    // "meal kits or prepared foods" is one idea in two words; "halal
    // certification or religious compliance" is two ideas. The signal is
    // whether each side stands alone as a phrase of its own.
    return parts.every((p) => p.trim().split(/\s+/).length >= 2);
  });
}

function isOrderedList(q) {
  const opts = optionsOf(q);
  if (opts.length < 3) return false;
  const ordered = opts.filter((o) => ORDERED_WORD_RE.test(o) || NUMERIC_RANGE_RE.test(o));
  return ordered.length >= Math.ceil(opts.length / 2);
}

/**
 * Option order for one respondent. Rotation (not a shuffle) keeps the list
 * readable and is deterministic per respondent, so a re-run reproduces it.
 * Ordered lists are returned untouched; the escape option stays last.
 */
function optionsForRespondent(q, respondentKey) {
  const opts = optionsOf(q);
  if (!isMulti(q) || opts.length < 3 || isOrderedList(q)) return opts;
  const escape = opts.filter((o) => ESCAPE_RE.test(o.trim()));
  const body = opts.filter((o) => !ESCAPE_RE.test(o.trim()));
  if (body.length < 2) return opts;
  let h = 2166136261;
  const seed = `${respondentKey || ''}|${q.id || text(q)}`;
  for (let i = 0; i < seed.length; i += 1) { h ^= seed.charCodeAt(i); h = Math.imul(h, 16777619); }
  const shift = (h >>> 0) % body.length;
  return [...body.slice(shift), ...body.slice(0, shift), ...escape];
}

/**
 * What is DEMONSTRABLY wrong with a question set, without changing it. Every
 * rule here is decidable from the question alone, so it can gate a release.
 * Possible merged options are advisory and excluded on purpose - see
 * doubleBarrelledOptions().
 * @returns {Array<{questionId: string, rule: string, detail: string}>}
 */
function findViolations(questions) {
  const out = [];
  for (const q of (questions || [])) {
    if (!isMulti(q)) continue;
    const opts = optionsOf(q);
    if (opts.length < 2) continue;
    if (!hasEscapeOption(q)) {
      out.push({ questionId: q.id || text(q).slice(0, 40), rule: 'missing_escape_option', detail: `${opts.length} options, none of them "none of these"` });
    }
    if (!isCountingBattery(q) && !Number(q.maxSelections) && opts.length > DEFAULT_MAX_SELECTIONS) {
      out.push({ questionId: q.id || text(q).slice(0, 40), rule: 'uncapped_selections', detail: `${opts.length} options, no maximum` });
    }
  }
  return out;
}

/**
 * Fix what can be fixed safely, on generation only: add the escape option, and
 * cap the batteries that should be capped. Double-barrelled options are left
 * alone and reported, because splitting one changes what was asked.
 * @returns {{questions: Array, changes: Array, remaining: Array}}
 */
function normalizeQuestions(questions, opts = {}) {
  const escapeLabel = opts.escapeLabel || DEFAULT_ESCAPE;
  const cap = Number(opts.maxSelections) || DEFAULT_MAX_SELECTIONS;
  const changes = [];
  const next = (questions || []).map((q) => {
    if (!isMulti(q)) return q;
    const options = optionsOf(q);
    if (options.length < 2) return q;
    const out = { ...q };
    if (!hasEscapeOption(q)) {
      out.options = [...options, escapeLabel];
      changes.push({ questionId: q.id || text(q).slice(0, 40), change: 'added_escape_option', detail: escapeLabel });
    }
    if (!isCountingBattery(q) && !Number(q.maxSelections) && optionsOf(out).length > cap) {
      out.maxSelections = cap;
      changes.push({ questionId: q.id || text(q).slice(0, 40), change: 'capped_selections', detail: `max ${cap}` });
    }
    return out;
  });
  const advisories = [];
  for (const q of next) {
    for (const o of doubleBarrelledOptions(q)) {
      advisories.push({ questionId: q.id || text(q).slice(0, 40), note: 'option may merge two concerns; split it if so', detail: o });
    }
  }
  return { questions: next, changes, remaining: findViolations(next), advisories };
}

/** Prompt text for the generators, so the model produces this shape first time. */
const MULTI_SELECT_PROMPT_RULES = `
MULTI-SELECT RULES (type="multi") — a battery of concerns that cannot be declined measures the question, not the market:
- The LAST option must always be an escape: "${DEFAULT_ESCAPE}" (or "Nothing would stop me" for hesitation questions). A respondent with no concerns must have something to choose.
- Set "maxSelections": ${DEFAULT_MAX_SELECTIONS} on concern, barrier, driver and motivation batteries, so the answer ranks what matters. Leave it off for awareness and recall batteries ("which of these have you heard of"), where the count is the measure.
- ONE idea per option. Never merge two concerns with "or": "Uncertainty about halal certification" and "religious compliance" are two options, not one.
- Do not imply that every respondent must have a concern: phrase the stem neutrally ("Which, if any, of these would make you hesitate?").`;

module.exports = {
  DEFAULT_ESCAPE,
  DEFAULT_MAX_SELECTIONS,
  MULTI_SELECT_PROMPT_RULES,
  hasEscapeOption,
  isCountingBattery,
  isOrderedList,
  doubleBarrelledOptions,
  optionsForRespondent,
  findViolations,
  normalizeQuestions,
};
