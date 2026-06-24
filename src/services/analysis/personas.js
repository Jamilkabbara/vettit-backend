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

  // Choose the dimension giving the cleanest 2–4-way split: covers most of the
  // sample, not too sparse, reasonably balanced.
  const scoreDim = (dim) => {
    const counts = {};
    let known = 0;
    for (const p of profiles) { const v = norm(p[dim]); if (v) { counts[v] = (counts[v] || 0) + 1; known += 1; } }
    if (known < total * 0.6) return -1;
    const groups = Object.values(counts);
    const k = groups.length;
    if (k < 2 || k > 6) return -1;
    const minShare = Math.min(...groups) / total;
    return (k >= 2 && k <= 4 ? 2 : 1) + minShare; // prefer 2–4 balanced groups
  };
  let best = null; let bestScore = -1;
  for (const d of DIMENSIONS) { const s = scoreDim(d); if (s > bestScore) { bestScore = s; best = d; } }
  if (!best || bestScore < 0) return [];

  // Group, sort by size, keep top 4, fold any tail into "Other".
  const groups = new Map();
  for (const p of profiles) { const v = norm(p[best]); if (!v) continue; if (!groups.has(v)) groups.set(v, []); groups.get(v).push(p); }
  const arr = [...groups.entries()].map(([value, members]) => ({ value, members }))
    .sort((a, b) => b.members.length - a.members.length);
  // A persona must describe a GROUP (>=2 respondents), never an individual. Keep
  // the top 4 such groups; fold the long tail (incl. singletons) into "Other".
  const significant = arr.filter((g) => g.members.length >= 2);
  const top = significant.slice(0, 4);
  const shown = new Set(top.map((g) => g.value));
  const tailMembers = arr.filter((g) => !shown.has(g.value)).flatMap((g) => g.members);
  const personas = top.map((g) => buildPersona(best, g.value, g.members, total));
  if (tailMembers.length >= 2) personas.push(buildPersona(best, '__other__', tailMembers, total));
  // A single persona covering ~the whole sample says nothing — need >=2 to be useful.
  return personas.length >= 2 ? personas : [];
}

module.exports = { computePersonas };
