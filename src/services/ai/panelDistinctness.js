/**
 * Is this panel made of different people?
 *
 * The recruit loop asked the model for one persona at a time with an
 * identical prompt, so it got the model's single most likely persona back
 * again and again: 10ecb820 delivered 239 "Marcus" out of 240, 0a494ef7
 * delivered 300 out of 300, and a paying customer received five copies of
 * "Marcus, 41, London". One opinion, sold as a panel.
 *
 * This module is the one definition of "the same person" used everywhere:
 * the generation guard (personas.js), the unit tests, the live measurement
 * script and the historical audit. Change it here and every one of them moves.
 *
 * DEFINITION
 *   Identity fields: first name, age, city, occupation. Opinion: the
 *   respondent's answers to every closed question, as one signature.
 *
 *   A respondent is a NEAR-DUPLICATE of an earlier one when they share a first
 *   name AND at least two of: age within 2 years, city, occupation, opinion.
 *   The name is required because it is the model's own label for "who this
 *   is"; the two further matches stop two unrelated Mohammeds in a Gulf panel
 *   from counting. Differing answers do NOT make a clone distinct: the same
 *   Marcus answering with different random draws is still one person
 *   (see the pass-48 note in recruitLoop.js).
 *
 *   DISTINCT = respondents that are not a near-duplicate of anyone before them.
 *
 * THRESHOLD (a panel fails when either is exceeded)
 *   1. Near-duplicates <= floor(n x min(5%, half the 95% margin of error)).
 *      Half the margin of error is 0.49/sqrt(n). A duplicate can move a
 *      reported share by at most its own weight, so this caps what copies can
 *      do at half the error the sample already carries: they cannot create a
 *      difference the report would call real. Allowed: n=10 -> 0, n=50 -> 2,
 *      n=100 -> 4, n=300 -> 8, n=1000 -> 15.
 *   2. The most common first name <= max(2, ceil(20% of n)). The commonest
 *      given name in any market we sell into is ~10-12% of ONE gender
 *      (Mohammed among Gulf men), so 20% leaves room for a male-only,
 *      single-country panel and still fails every collapse we have seen
 *      (5/5, 45/50, 239/240, 300/300).
 */
'use strict';

const NEAR_DUP_AGE_YEARS = 2;
const MAX_DUP_SHARE = 0.05;
const MAX_TOP_NAME_SHARE = 0.2;

const norm = (v) => String(v == null ? '' : v).trim().toLowerCase().replace(/\s+/g, ' ');

function firstName(p) {
  const raw = p.first_name || p.firstName || p.name || '';
  return norm(String(raw).split(/\s+/)[0]);
}

function ageOf(p) {
  const n = Number(p.age);
  return Number.isFinite(n) ? Math.round(n) : null;
}

function identity(p) {
  return {
    name: firstName(p),
    age: ageOf(p),
    city: norm(p.city || p.location || ''),
    occupation: norm(p.occupation || p.job_title || p.role || ''),
  };
}

/** How many of the non-name fields match. Unknown values never match. */
function sharedTraits(a, b) {
  let k = 0;
  if (a.age != null && b.age != null && Math.abs(a.age - b.age) <= NEAR_DUP_AGE_YEARS) k += 1;
  if (a.city && a.city === b.city) k += 1;
  if (a.occupation && a.occupation === b.occupation) k += 1;
  if (a.opinion && a.opinion === b.opinion) k += 1;
  return k;
}

function isNearDuplicate(a, b) {
  return !!a.name && a.name === b.name && sharedTraits(a, b) >= 2;
}

/** Answers to closed questions, as one comparable string. */
function opinionSignature(answers) {
  if (!answers || typeof answers !== 'object') return '';
  const keys = Object.keys(answers).sort();
  const parts = [];
  for (const k of keys) {
    const v = answers[k];
    if (v == null) continue;
    if (typeof v === 'string' && v.length > 60) continue; // open text: not a closed answer
    parts.push(`${k}=${Array.isArray(v) ? [...v].map(String).sort().join('+') : String(v)}`);
  }
  return parts.join('|');
}

function allowedNearDuplicates(n) {
  if (n <= 0) return 0;
  const halfMoe = 0.49 / Math.sqrt(n);
  return Math.floor(n * Math.min(MAX_DUP_SHARE, halfMoe) + 1e-9);
}

function allowedTopName(n) {
  return Math.max(2, Math.ceil(n * MAX_TOP_NAME_SHARE));
}

/**
 * @param {Array<object>} personas  persona profiles
 * @param {object} [opts]
 * @param {object} [opts.answersByPersona]  { [persona_id]: { [question_id]: answer } }
 */
function measurePanel(personas, opts = {}) {
  const answersBy = opts.answersByPersona || {};
  const kept = [];
  let nearDuplicates = 0;
  const nameCounts = new Map();
  for (const p of personas || []) {
    const id = p && (p.persona_id || p.id);
    const me = { ...identity(p || {}), opinion: opinionSignature(answersBy[id]) };
    if (me.name) nameCounts.set(me.name, (nameCounts.get(me.name) || 0) + 1);
    if (kept.some((k) => isNearDuplicate(me, k))) nearDuplicates += 1;
    else kept.push(me);
  }
  const n = (personas || []).length;
  let topName = null; let topNameCount = 0;
  for (const [name, c] of nameCounts) if (c > topNameCount) { topName = name; topNameCount = c; }
  const distinctOf = (f) => new Set((personas || []).map((p) => f(p || {})).filter((v) => v !== '' && v != null)).size;
  const result = {
    n,
    distinct: n - nearDuplicates,
    nearDuplicates,
    allowedNearDuplicates: allowedNearDuplicates(n),
    topName,
    topNameCount,
    allowedTopName: allowedTopName(n),
    distinctNames: distinctOf((p) => identity(p).name),
    distinctAges: distinctOf((p) => identity(p).age),
    distinctCities: distinctOf((p) => identity(p).city),
    distinctOccupations: distinctOf((p) => identity(p).occupation),
    distinctOpinions: new Set((personas || []).map((p) => opinionSignature(answersBy[p && (p.persona_id || p.id)]))).size,
  };
  result.reasons = [];
  if (result.nearDuplicates > result.allowedNearDuplicates) {
    result.reasons.push(`${result.nearDuplicates} near-duplicate respondents (allowed ${result.allowedNearDuplicates} at n=${n})`);
  }
  if (n >= 3 && result.topNameCount > result.allowedTopName) {
    result.reasons.push(`"${result.topName}" is ${result.topNameCount} of ${n} respondents (allowed ${result.allowedTopName})`);
  }
  result.pass = result.reasons.length === 0;
  return result;
}

module.exports = {
  measurePanel,
  isNearDuplicate,
  identity,
  opinionSignature,
  allowedNearDuplicates,
  allowedTopName,
  NEAR_DUP_AGE_YEARS,
};
