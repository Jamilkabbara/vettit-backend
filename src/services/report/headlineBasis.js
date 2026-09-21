/**
 * A headline figure is a whole-study figure. A subgroup figure says whose.
 *
 * Mission 3fc15087 (market_entry, n=80, Saudi Arabia and Egypt) opened its
 * delivered report with "a demand index of 62/100 and purchase intent of
 * 82.5%". 82.5% is the SAUDI figure (33 of 40). The whole study was 75%
 * (60 of 80). Nothing was invented - the number existed in the analysis, which
 * is exactly why the existing tile check passed it: that check asks whether a
 * figure is derivable, not what it is a figure OF. A reader was told the study
 * found 82.5% intent. It did not; half of it did.
 *
 * Two sets, and the difference between them is the whole point:
 *   - fullSampleFigures(): everything computed over ALL respondents.
 *   - subgroupFigures():   everything computed over a slice (per market, per
 *                          segment, exposed vs control, a screened base).
 *
 * A figure that is only in the second set may still be used - subgroups are
 * often the interesting part - but the sentence carrying it has to say which
 * slice it describes. Unlabelled, it reads as the study's finding.
 *
 * This is a BASIS check, not a truth check: narrativeFigures.js already asks
 * whether a per-question figure is real. This asks which population it belongs
 * to, which is a different way to mislead with true numbers.
 */
'use strict';

const { computedFigureUniverse, figuresIn } = require('./tileFigures');

/** Containers whose numbers describe a slice of the panel, not the panel. */
const SUBGROUP_KEY_RE = /market|country|geo|segment|cluster|cohort|persona|exposed|control|group|split|by_|per_|subgroup|breakdown|region|city|gender|age_|tier|band/i;

const round = (v, dp) => Number(Number(v).toFixed(dp));

function addNumber(set, v) {
  if (!Number.isFinite(v)) return;
  for (const dp of [0, 1, 2]) set.add(round(v, dp));
  if (v >= -1 && v <= 1) for (const dp of [0, 1, 2]) set.add(round(v * 100, dp));
}

/**
 * Figures computed over every respondent: the survey's own whole-sample
 * distributions, averages and bases. Deliberately does NOT read the analysis
 * object, because that is where the subgroup numbers live.
 */
function fullSampleFigures(report) {
  return computedFigureUniverse(
    { header: report && report.header, survey: (report && report.survey) || [] },
    null,
  );
}

/** Figures that exist only inside a per-market, per-segment or per-group block. */
function subgroupFigures(analysis) {
  const set = new Set();
  const walk = (node, inSubgroup) => {
    if (node == null) return;
    if (Array.isArray(node)) { for (const v of node) walk(v, inSubgroup); return; }
    if (typeof node === 'number') { if (inSubgroup) addNumber(set, node); return; }
    if (typeof node === 'string') {
      if (inSubgroup) for (const n of figuresIn(node)) addNumber(set, n);
      return;
    }
    if (typeof node !== 'object') return;
    for (const [k, v] of Object.entries(node)) walk(v, inSubgroup || SUBGROUP_KEY_RE.test(k));
  };
  walk(analysis, false);
  return set;
}

/** Names a sentence can use to say which slice it means. */
function subgroupLabels(analysis, report) {
  const labels = new Set();
  const add = (v) => {
    const s = String(v == null ? '' : v).trim();
    if (s.length >= 2 && s.length <= 40 && /[a-z]/i.test(s)) labels.add(s.toLowerCase());
  };
  const walk = (node, inSubgroup) => {
    if (node == null || typeof node !== 'object') return;
    if (Array.isArray(node)) { for (const v of node) walk(v, inSubgroup); return; }
    for (const [k, v] of Object.entries(node)) {
      const here = inSubgroup || SUBGROUP_KEY_RE.test(k);
      if (here && typeof v === 'string') add(v);
      walk(v, here);
    }
  };
  walk(analysis, false);
  const markets = (report && report.header && report.header.markets) || null;
  if (typeof markets === 'string') for (const m of markets.split(/,| and /)) add(m);
  return labels;
}

/** Sentences, kept whole so a label and its figure stay together. */
function sentencesOf(text) {
  return String(text || '')
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

const LABEL_HINT_RE = /\b(among|within|in the|for the|of those|respondents in|market|segment|cohort|group|exposed|control|subgroup|n\s*=\s*\d+|\d+\s+of\s+\d+)\b/i;

/** Percentages a sentence states. Only percentages: a bare count is not a headline claim. */
function percentagesIn(sentence) {
  const out = [];
  for (const m of String(sentence || '').matchAll(/(-?\d+(?:\.\d+)?)\s*(?:%|per cent|percent)/gi)) {
    const n = Number(m[1]);
    if (Number.isFinite(n)) out.push(n);
  }
  return out;
}

const inSet = (set, n) => [0, 1, 2].some((dp) => set.has(round(n, dp)));

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * A sentence names its slice if it uses a label, or a distinctive word from
 * one: a report says "of Saudi respondents", not "of Saudi Arabia respondents".
 * Matched on word boundaries, so a two-letter market code like "SA" cannot
 * match inside "same".
 */
function labelMatcher(labels) {
  const parts = new Set();
  for (const label of labels) {
    parts.add(label);
    for (const word of String(label).split(/[\s,/-]+/)) {
      if (word.length >= 4) parts.add(word);
    }
  }
  if (!parts.size) return () => false;
  const re = new RegExp(`\\b(${[...parts].map(escapeRe).join('|')})\\b`, 'i');
  return (sentence) => re.test(sentence);
}

/**
 * Does this prose present a subgroup figure as the study's own?
 *
 * @param {string} text   the headline, executive summary or tile value
 * @param {object} ctx    { full: Set, subgroup: Set, labels: Set }
 * @returns {Array<{figure:number, sentence:string, reason:string}>}
 */
function checkHeadlineBasis(text, ctx = {}) {
  const full = ctx.full || new Set();
  const subgroup = ctx.subgroup || new Set();
  const labels = ctx.labels || new Set();
  const out = [];
  const namesASlice = labelMatcher(labels);
  for (const sentence of sentencesOf(text)) {
    const labelled = LABEL_HINT_RE.test(sentence) || namesASlice(sentence);
    for (const pct of percentagesIn(sentence)) {
      if (inSet(full, pct)) continue;        // a whole-study figure: fine
      if (!inSet(subgroup, pct)) continue;   // not this check's business (narrativeFigures covers invention)
      if (labelled) continue;                // a subgroup figure that says so: fine
      out.push({
        figure: pct,
        sentence: sentence.slice(0, 240),
        reason: 'subgroup figure presented as a whole-study figure',
      });
    }
  }
  return out;
}

/** Build the sets from a report plus analysis and check one piece of prose. */
function checkAgainstReport(text, report, analysis) {
  return checkHeadlineBasis(text, {
    full: fullSampleFigures(report),
    subgroup: subgroupFigures(analysis),
    labels: subgroupLabels(analysis, report),
  });
}

module.exports = {
  fullSampleFigures,
  subgroupFigures,
  subgroupLabels,
  checkHeadlineBasis,
  checkAgainstReport,
  percentagesIn,
  sentencesOf,
};
