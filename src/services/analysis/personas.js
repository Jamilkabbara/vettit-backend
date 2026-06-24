/**
 * §8 — deterministic "who responded" personas.
 *
 * Describes the ACHIEVED sample by grouping the synthetic respondent profiles on
 * the most informative categorical dimension, with real shares and grounded
 * name / role / description derived from each group's modal traits. This is
 * purely DESCRIPTIVE (not inferential): no LLM, no recomputed statistics — so it
 * renders correctly by construction and is verifiable on real data. The optional
 * LLM prose layer (richer names/copy) is a future enrichment that would replace
 * these strings; the shares + grouping always come from here.
 *
 * Consumers read { name, role, share, description, n } (web persona cards, PDF
 * persona rows, pptx/xlsx). Returns [] when the sample is too thin or no
 * dimension yields a clean grouping — the empty section is already hidden on
 * every surface, so [] is the safe, honest default.
 */

const norm = (v) => {
  if (v == null) return null;
  const s = String(v).trim();
  return s.length ? s : null;
};
const titleCase = (s) => String(s).replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());

/** Most frequent non-empty value in a list (ties broken by first-seen). */
function modal(list) {
  const counts = new Map();
  for (const v of list) { const k = norm(v); if (!k) continue; counts.set(k, (counts.get(k) || 0) + 1); }
  let best = null; let bestC = 0;
  for (const [k, c] of counts) if (c > bestC) { best = k; bestC = c; }
  return best;
}

/** Top-N most frequent values. */
function topN(list, n) {
  const counts = new Map();
  for (const v of list) { const k = norm(v); if (!k) continue; counts.set(k, (counts.get(k) || 0) + 1); }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, n).map(([k]) => k);
}

/** Natural-language join: ["a","b","c"] → "a, b and c". */
function listText(arr) {
  if (arr.length <= 1) return arr[0] || '';
  return `${arr.slice(0, -1).join(', ')} and ${arr[arr.length - 1]}`;
}

// Candidate grouping dimensions, in priority order (gender intentionally omitted —
// it rarely makes a meaningful "who responded" archetype).
const DIMENSIONS = ['decision_style', 'seniority', 'occupation', 'industry', 'income_band'];

const NAME_BY_DIM = {
  decision_style: (v) => `${titleCase(v)} Decision-Makers`,
  seniority: (v) => ({
    junior: 'Early-Career Professionals', entry: 'Early-Career Professionals',
    mid: 'Mid-Career Professionals', senior: 'Senior Professionals',
    lead: 'Team Leads', exec: 'Executives', executive: 'Executives', c_level: 'Executives',
  }[String(v).toLowerCase()] || `${titleCase(v)} Professionals`),
  occupation: (v) => `${titleCase(v)}s`,
  industry: (v) => `${titleCase(v)} Professionals`,
  income_band: (v) => `${titleCase(v)}-Income Respondents`,
};

function buildPersona(dim, value, members, total) {
  const n = members.length;
  const share = Math.round((n / total) * 100);
  const name = value === '__other__' ? 'Other Respondents' : (NAME_BY_DIM[dim] ? NAME_BY_DIM[dim](value) : titleCase(value));

  // Role = modal occupation, else seniority · industry.
  const occ = modal(members.map((m) => m.occupation));
  const sen = modal(members.map((m) => m.seniority));
  const ind = modal(members.map((m) => m.industry));
  const role = occ || [sen && titleCase(sen), ind].filter(Boolean).join(' · ') || null;

  // Description from modal traits: top values, decision style, age range.
  const vals = topN(members.flatMap((m) => (Array.isArray(m.values) ? m.values : [])), 2);
  const ds = modal(members.map((m) => m.decision_style));
  const ages = members.map((m) => Number(m.age)).filter((a) => Number.isFinite(a));
  const ageRange = ages.length ? `ages ${Math.min(...ages)}–${Math.max(...ages)}` : null;
  const parts = [];
  if (vals.length) parts.push(`prioritise ${listText(vals)}`);
  if (ds) parts.push(`${ds} decision-makers`);
  if (ageRange) parts.push(ageRange);
  const description = parts.length
    ? `${parts.join('; ').replace(/^./, (c) => c.toUpperCase())}.`
    : `A ${share}% segment of the sample.`;

  return { name, role, share: `${share}%`, n, description };
}

/**
 * @param {Array} responses mission_responses rows (each may carry persona_profile)
 * @param {object} mission  the mission (unused today; kept for parity + future use)
 * @returns {Array<{name,role,share,description,n}>}
 */
function computePersonas(responses, mission) { // eslint-disable-line no-unused-vars
  // Dedupe respondents by persona_id; drop screened-out; require a profile.
  const seen = new Map();
  for (const r of (Array.isArray(responses) ? responses : [])) {
    if (!r) continue;
    const p = r.persona_profile;
    if (!p || typeof p !== 'object') continue;
    if (r.screened_out === true || p.screened_out === true) continue;
    if (!seen.has(r.persona_id)) seen.set(r.persona_id, p);
  }
  const profiles = [...seen.values()];
  const total = profiles.length;
  if (total < 3) return []; // too few respondents to archetype honestly

  // Pick the dimension whose TOP values cover the most of the sample. Real
  // synthetic profiles carry high-cardinality, free-text dimension values
  // (decision_style "impulse-driven with quality threshold", 50+ distinct
  // occupations, even seniority/income_band spill long-tail variants like
  // "mid-high"/"entry") — so the old "reject any dimension with >6 distinct
  // values" rule left EVERY real mission with zero personas. Instead we group by
  // the dominant values (a real group of >=2 and >=MIN_SHARE) and fold the long
  // tail into "Other", scoring each dimension by how much of the sample its top
  // groups cover.
  const MIN_SHARE = 0.08;     // a shown persona needs >=8% of the sample
  const MIN_COVERAGE = 0.5;   // the chosen dimension's top groups must cover >=50%
  const groupsForDim = (dim) => {
    const byVal = new Map();
    for (const p of profiles) { const v = norm(p[dim]); if (!v) continue; if (!byVal.has(v)) byVal.set(v, []); byVal.get(v).push(p); }
    return [...byVal.entries()]
      .map(([value, members]) => ({ value, members }))
      .filter((g) => g.members.length >= 2 && g.members.length / total >= MIN_SHARE)
      .sort((a, b) => b.members.length - a.members.length)
      .slice(0, 4);
  };
  let best = null; let bestScore = -1;
  for (const dim of DIMENSIONS) {
    const groups = groupsForDim(dim);
    if (groups.length < 2) continue; // need >=2 real archetypes
    const coverage = groups.reduce((sum, g) => sum + g.members.length, 0) / total;
    if (coverage < MIN_COVERAGE) continue;
    const score = coverage + 0.01 * groups.length; // tiebreak: prefer more groups
    if (score > bestScore) { bestScore = score; best = { dim, groups }; }
  }
  if (!best) return [];

  // Build personas from the top groups; fold everyone else (long tail + missing)
  // into "Other" when that remainder is itself a real group (>=2).
  const shownValues = new Set(best.groups.map((g) => g.value));
  const tailMembers = profiles.filter((p) => { const v = norm(p[best.dim]); return !v || !shownValues.has(v); });
  const personas = best.groups.map((g) => buildPersona(best.dim, g.value, g.members, total));
  if (tailMembers.length >= 2) personas.push(buildPersona(best.dim, '__other__', tailMembers, total));
  // A single persona covering ~the whole sample says nothing — need >=2 to be useful.
  return personas.length >= 2 ? personas : [];
}

module.exports = { computePersonas };
