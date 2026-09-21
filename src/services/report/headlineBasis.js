/**
 * A headline figure is a whole-study figure. A subgroup figure says whose.
 *
 * A study of 80 people across two markets computes a figure per market. Both
 * are true; only one is the study's finding. "Purchase intent is 82.5%" and
 * "purchase intent reaches 82.5% in Saudi Arabia" differ by the only thing
 * that matters to a reader deciding whether to enter a market.
 *
 * Nothing catches this today. narrativeFigures.js asks whether a figure is
 * real, and tileFigures.js asks whether it is derivable from the data. A
 * subgroup figure passes both: it IS real and it IS derivable. What neither
 * asks is which population it describes.
 *
 * Provenance, stated honestly: this module was written after I claimed mission
 * 3fc15087 had published its Saudi figure (82.5%) as the whole study's. It had
 * not. The delivered sentence was "Saudi Arabia is the clear market to enter
 * first, scoring a demand index of 62/100 and purchase intent of 82.5%, well
 * ahead of Egypt's ...", which attributes it correctly. I had read a fragment
 * of that sentence out of context. The audit's positive control is what caught
 * my error - see scripts/audit-report-headlines.js. The guard is kept because
 * the failure it prevents is real and cheap to prevent, not because it has
 * ever fired on a delivered report.
 *
 * Two sets, and the difference between them is the whole point:
 *   - fullSampleFigures(): everything computed over ALL respondents.
 *   - subgroupFigureMap(): figures carried by a NAMED slice (a market, a
 *     segment, exposed vs control), mapped back to the slice that owns them.
 *     The name is required: a number that merely appears somewhere inside a
 *     per-market container is a coincidence, not a misattribution, and
 *     treating it as one produced a false positive on a real report
 *     ("the screener filtered out 80% of respondents").
 *
 * A figure owned by a slice may still be used - subgroups are often the
 * interesting part - but the sentence carrying it has to say which slice it
 * describes. Unlabelled, it reads as the study's finding.
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

/** The name a block of numbers belongs to: "Saudi Arabia", "Heavy users", "exposed". */
function blockName(node) {
  if (!node || typeof node !== 'object' || Array.isArray(node)) return null;
  for (const k of ['market', 'segment', 'name', 'label', 'country', 'group', 'cohort', 'cluster', 'code']) {
    const v = node[k];
    if (typeof v === 'string' && v.trim().length >= 2 && v.trim().length <= 40) return v.trim();
  }
  return null;
}

/**
 * Figures that belong to a NAMED slice, mapped figure -> the slices that carry
 * it. The name matters: without it there is nothing to accuse the prose of
 * hiding, and a bare number that happens to appear somewhere inside a
 * per-market container is a coincidence, not a misattribution.
 *
 * A screening rate ("80% were screened out") is exactly that coincidence, and
 * it is why the earlier version of this function - which collected every number
 * under a subgroup key - produced a false positive on a delivered report.
 */
function subgroupFigureMap(analysis) {
  const map = new Map();
  const attach = (v, name) => {
    if (!Number.isFinite(v) || !name) return;
    const keys = new Set();
    addNumber(keys, v);
    for (const k of keys) {
      if (!map.has(k)) map.set(k, new Set());
      map.get(k).add(name.toLowerCase());
    }
  };
  const walk = (node, name) => {
    if (node == null) return;
    if (Array.isArray(node)) { for (const v of node) walk(v, name); return; }
    if (typeof node !== 'object') return;
    const here = blockName(node) || name;
    for (const [k, v] of Object.entries(node)) {
      if (typeof v === 'number') { if (here) attach(v, here); continue; }
      if (typeof v === 'string') { if (here) for (const n of figuresIn(v)) attach(n, here); continue; }
      walk(v, SUBGROUP_KEY_RE.test(k) ? (blockName(v) || here) : here);
    }
  };
  walk(analysis, null);
  return map;
}

/** Back-compat: the set of figures carried by a named slice. */
function subgroupFigures(analysis) {
  return new Set(subgroupFigureMap(analysis).keys());
}

/**
 * Names a sentence can use to say which slice it means.
 *
 * Read from the SAME source as subgroupFigureMap: every name that can own a
 * figure is a name that can label one. When the two disagreed, a naming study's
 * tile ("Brightly", "50% win rate") was flagged for hiding a slice it had named
 * in its own label, because candidate names reached the figure map but not this
 * list. One walk now feeds both.
 */
function subgroupLabels(analysis, report) {
  const labels = new Set();
  const add = (v) => {
    const s = String(v == null ? '' : v).trim();
    if (s.length >= 2 && s.length <= 40 && /[a-z]/i.test(s)) labels.add(s.toLowerCase());
  };
  for (const owners of subgroupFigureMap(analysis).values()) for (const o of owners) add(o);
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
  const map = ctx.subgroupMap || new Map();
  const labels = ctx.labels || new Set();
  const out = [];
  const namesASlice = labelMatcher(labels);
  const ownersOf = (pct) => {
    for (const dp of [0, 1, 2]) {
      const hit = map.get(round(pct, dp));
      if (hit && hit.size) return [...hit];
    }
    return null;
  };
  for (const sentence of sentencesOf(text)) {
    const labelled = LABEL_HINT_RE.test(sentence) || namesASlice(sentence);
    if (labelled) continue;                  // the sentence says which slice it means
    for (const pct of percentagesIn(sentence)) {
      if (inSet(full, pct)) continue;        // a whole-study figure: fine
      const owners = ownersOf(pct);
      if (!owners) continue;                 // belongs to no named slice: not this check's business
      out.push({
        figure: pct,
        belongsTo: owners,
        sentence: sentence.slice(0, 240),
        reason: `figure belongs to ${owners.join(' / ')}, presented as a whole-study figure`,
      });
    }
  }
  return out;
}

/** Build the sets from a report plus analysis and check one piece of prose. */
function checkAgainstReport(text, report, analysis) {
  return checkHeadlineBasis(text, {
    full: fullSampleFigures(report),
    subgroupMap: subgroupFigureMap(analysis),
    labels: subgroupLabels(analysis, report),
  });
}

module.exports = {
  fullSampleFigures,
  subgroupFigures,
  subgroupFigureMap,
  subgroupLabels,
  checkHeadlineBasis,
  checkAgainstReport,
  percentagesIn,
  sentencesOf,
};
