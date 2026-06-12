/**
 * Pass 46 Phase 3 — deterministic NAMING & MESSAGING analysis
 * (monadic evaluation + paired comparison + TURF).
 *
 * Doctrine (Pass 46, Jamil's explicit decision): the LLM does NOT
 * compute methodology math. This module turns clean mission_responses
 * rows ({persona_id, question_id, answer}) into every number the
 * naming report shows; the narrator LLM only writes prose ABOUT the
 * returned object. Deterministic, never throws, incomputable → null.
 *
 * Question metadata contract — quoted from the generator prompt
 * NAMING_SURVEY_GEN_SYSTEM (src/services/claudeAI.js:1542-1595):
 *
 *  - MONADIC ratings (claudeAI.js:1571-1574): one question per
 *    candidate × criterion. Fields: `methodology="monadic"`,
 *    `candidate_id=<id>` ("use the supplied id ... verbatim", e.g.
 *    "n1"), `criterion` carries the slug — the slug→label map at
 *    claudeAI.js:1585-1591 is: memorable | distinctive | relevant |
 *    positive | easy_to_pronounce | modern. `type="rating"`, text
 *    'On a 1-7 scale, how <label> is [<candidate text>]?' — the
 *    candidate's verbatim text rides inside [brackets], which is our
 *    label fallback when mission.naming_candidates is absent.
 *    ANSWER SHAPE: a number (simulate.js:67 → `"answer": 4`).
 *  - WORD ASSOCIATION (claudeAI.js:1573): criterion="word_association",
 *    type="text" — free text; EXCLUDED from all rating math here.
 *  - PAIRED COMPARISON (claudeAI.js:1578): `is_paired_comparison=true`,
 *    methodology="paired_comparison", candidate_id=null, type="single",
 *    text 'Which would you choose: [<A text>] OR [<B text>]?',
 *    `options=[<A text>, <B text>]` — candidates appear as VERBATIM
 *    TEXTS, not ids. ANSWER SHAPE: one option string = the chosen
 *    candidate's text (simulate.js:47,65), so answer→candidate mapping
 *    is a case-insensitive trimmed label match.
 *  - FORCED CHOICE + WHY (claudeAI.js:1576-1577): carry
 *    methodology="monadic_plus_paired" with is_paired_comparison=false
 *    and candidate_id=null — deliberately NOT counted in pairwise win
 *    rates (only is_paired_comparison questions are).
 *  - TURF (claudeAI.js:1579, only when test_type includes taglines):
 *    `is_turf=true`, methodology="turf", type="multi",
 *    options=[<each candidate text>]. ANSWER SHAPE: array of selected
 *    option strings (simulate.js:48,66).
 *
 * Candidate source of truth: mission.naming_candidates — a JSON TEXT
 * column (missionSchema.js 'naming_candidates') holding
 * [{id, text|name, description?}] (cf. buildNamingUserPrompt,
 * claudeAI.js:1623,1637-1638).
 */

const { ratingStats, round4, personaCount } = require('./shared');

/** Case-insensitive trimmed key for candidate-text matching. */
const norm = (v) => String(v ?? '').trim().toLowerCase();

const BRACKET_RE = /\[([^\]]+)\]/;

/** Mission JSON columns are TEXT — tolerate an array or a JSON string. */
function parseMaybeJSONArray(v) {
  if (Array.isArray(v)) return v;
  if (typeof v === 'string' && v.trim()) {
    try {
      const p = JSON.parse(v);
      return Array.isArray(p) ? p : [];
    } catch { return []; }
  }
  return [];
}

function safePersonaCount(rows) {
  try { return personaCount(Array.isArray(rows) ? rows : []); } catch { return 0; }
}

/**
 * Pass 46 Phase 3 — naming & messaging analysis.
 * @param {Array<{persona_id, question_id, answer}>} rows clean mission_responses
 * @param {Array<object>} questions mission questions (carry the metadata above)
 * @param {object} mission mission row (naming_candidates used for labels)
 */
function computeNaming(rows, questions, mission) {
  try {
    return computeNamingInner(
      Array.isArray(rows) ? rows : [],
      Array.isArray(questions) ? questions : [],
      mission && typeof mission === 'object' ? mission : {},
    );
  } catch (err) {
    // Contract: never throw — degrade to an inert object the renderer
    // can null-check.
    return {
      methodology: 'naming',
      n: safePersonaCount(rows),
      candidates: [],
      pairwise: null,
      turf: null,
      winner: null,
      error: `naming_analysis_failed: ${err.message}`,
    };
  }
}

function computeNamingInner(rows, questions, mission) {
  const rowsByQ = new Map();
  for (const r of rows) {
    if (!r || !r.question_id) continue;
    if (!rowsByQ.has(r.question_id)) rowsByQ.set(r.question_id, []);
    rowsByQ.get(r.question_id).push(r);
  }
  const answered = (qid) => (rowsByQ.get(qid) || [])
    .filter((r) => r.answer !== null && r.answer !== undefined);

  // ── Candidate registry (insertion order = report order) ─────────────
  // mission.naming_candidates first, then any candidate_id discovered on
  // monadic questions; discovered labels come from the [bracketed]
  // candidate text in the question (claudeAI.js:1572).
  const registry = new Map(); // candidate_id → label
  for (const c of parseMaybeJSONArray(mission.naming_candidates)) {
    if (!c || typeof c !== 'object') continue;
    const label = String(c.text || c.name || '').trim();
    const id = String(c.id ?? label).trim();
    if (id) registry.set(id, label || id);
  }
  for (const q of questions) {
    if (!q || !q.candidate_id) continue;
    const id = String(q.candidate_id);
    if (!registry.has(id)) {
      const m = BRACKET_RE.exec(String(q.text || ''));
      registry.set(id, (m && m[1].trim()) || id);
    }
  }
  const idByLabel = new Map(); // norm(label) → candidate_id
  for (const [id, label] of registry) {
    if (!idByLabel.has(norm(label))) idByLabel.set(norm(label), id);
  }

  // ── Monadic: per candidate × criterion → ratingStats ────────────────
  // Keyed on candidate_id + criterion presence (the prompt's hard
  // contract); word_association is type="text" (claudeAI.js:1573) and
  // is excluded from rating math.
  const critRowsByCandidate = new Map(); // candidate_id → Map(criterion → rows)
  for (const q of questions) {
    if (!q || !q.candidate_id || !q.criterion) continue;
    if (q.criterion === 'word_association') continue;
    const id = String(q.candidate_id);
    if (!critRowsByCandidate.has(id)) critRowsByCandidate.set(id, new Map());
    const m = critRowsByCandidate.get(id);
    if (!m.has(q.criterion)) m.set(q.criterion, []);
    m.get(q.criterion).push(...answered(q.id));
  }

  // ── Paired comparisons: win rate = wins / comparisons-appeared-in ───
  // A "comparison appeared in" is one valid answered row of one
  // is_paired_comparison question whose options include the candidate.
  // Rows whose answer matches NEITHER option are junk: excluded from
  // both wins and appearances (no valid pick was made).
  const pairedQs = questions.filter((q) => q && q.is_paired_comparison === true);
  const wins = new Map(); // candidate_id → total wins
  const appearances = new Map(); // candidate_id → total valid comparisons featuring it
  const comparisons = [];
  for (const q of pairedQs) {
    const opts = Array.isArray(q.options) ? q.options : [];
    const optIds = opts.map((o) => {
      const known = idByLabel.get(norm(o));
      if (known) return known;
      // Option text not in the registry (e.g. no mission context and no
      // monadic block) — register the label as its own id so win rates
      // stay computable.
      const id = String(o).trim();
      registry.set(id, id);
      idByLabel.set(norm(o), id);
      return id;
    });
    let base = 0;
    const qWins = new Map(optIds.map((id) => [id, 0]));
    for (const r of answered(q.id)) {
      const idx = opts.findIndex((o) => norm(o) === norm(r.answer));
      if (idx === -1) continue; // junk answer → not a valid comparison
      base += 1;
      qWins.set(optIds[idx], (qWins.get(optIds[idx]) || 0) + 1);
    }
    for (const id of new Set(optIds)) {
      appearances.set(id, (appearances.get(id) || 0) + base);
      wins.set(id, (wins.get(id) || 0) + (qWins.get(id) || 0));
    }
    comparisons.push({
      question_id: q.id,
      base, // valid answers — the n behind every win_pct below
      results: optIds.map((id, i) => ({
        candidate_id: id,
        label: registry.get(id) ?? String(opts[i]),
        wins: qWins.get(id) || 0,
        win_pct: base > 0 ? round4(((qWins.get(id) || 0) / base) * 100) : null,
      })),
    });
  }

  // ── TURF: greedy reach ladder ────────────────────────────────────────
  // First pick = option with max INDIVIDUAL reach; each later pick =
  // option adding the most INCREMENTAL reach over the already-covered
  // personas. Greedy ≠ naive "top-k by individual reach" when the
  // high-reach options overlap (the unit fixture proves this). Ties
  // break by question option order — deterministic.
  const turfQ = questions.find((q) => q && q.is_turf === true) || null;
  let turf = null;
  if (turfQ) {
    const tRows = answered(turfQ.id);
    const byPersona = new Map(); // persona_id → Set(norm(selection))
    for (const r of tRows) {
      const pid = r.persona_id ?? `__row_${byPersona.size}`;
      if (byPersona.has(pid)) continue; // upstream dedupes (simulate.js Pass 32 X1); keep first
      const sel = Array.isArray(r.answer) ? r.answer : [r.answer];
      byPersona.set(pid, new Set(sel.map(norm)));
    }
    const base = byPersona.size;
    const options = (Array.isArray(turfQ.options) && turfQ.options.length > 0)
      ? [...turfQ.options]
      : [...new Set(tRows.flatMap((r) => (Array.isArray(r.answer) ? r.answer : [r.answer]).map((v) => String(v))))];
    if (base > 0 && options.length > 0) {
      const reached = new Set();
      const remaining = [...options];
      const ladder = [];
      while (remaining.length > 0) {
        let best = remaining[0];
        let bestGain = -1;
        for (const opt of remaining) {
          let gain = 0;
          for (const [pid, sel] of byPersona) {
            if (!reached.has(pid) && sel.has(norm(opt))) gain += 1;
          }
          if (gain > bestGain) { bestGain = gain; best = opt; } // strict > → ties keep option order
        }
        for (const [pid, sel] of byPersona) {
          if (sel.has(norm(best))) reached.add(pid);
        }
        remaining.splice(remaining.indexOf(best), 1);
        ladder.push({
          option: best,
          candidate_id: idByLabel.get(norm(best)) ?? null,
          incremental_reach_pct: round4((bestGain / base) * 100),
          cumulative_reach_pct: round4((reached.size / base) * 100),
        });
      }
      turf = { question_id: turfQ.id, base, ladder };
    }
  }

  // ── Candidate roll-up ────────────────────────────────────────────────
  const candidates = [];
  for (const [id, label] of registry) {
    const critMap = critRowsByCandidate.get(id) || new Map();
    const criteria = {};
    const means = [];
    for (const [crit, cRows] of critMap) {
      const stats = ratingStats(cRows);
      criteria[crit] = stats;
      if (stats) means.push(stats.mean);
    }
    // Composite = UNWEIGHTED mean of criterion means: each criterion
    // counts equally regardless of its per-criterion n. Stated here so
    // nobody mistakes it for a pooled per-answer mean.
    const composite = means.length > 0
      ? round4(means.reduce((s, v) => s + v, 0) / means.length)
      : null;
    const app = appearances.get(id) || 0;
    candidates.push({
      candidate_id: id,
      label,
      composite,
      criteria,
      pairwise_win_rate: app > 0
        ? {
          pct: round4(((wins.get(id) || 0) / app) * 100),
          wins: wins.get(id) || 0,
          appearances: app, // the n behind pct
        }
        : null,
    });
  }

  // ── Winner: pairwise win rate when pairwise data exists, else
  // composite. Ties break by composite, then registry order (stable
  // because we only replace on strict >). ──
  let winner = null;
  const withPair = candidates.filter((c) => c.pairwise_win_rate !== null);
  if (withPair.length > 0) {
    let best = withPair[0];
    for (const c of withPair.slice(1)) {
      const beats = c.pairwise_win_rate.pct > best.pairwise_win_rate.pct
        || (c.pairwise_win_rate.pct === best.pairwise_win_rate.pct
          && (c.composite ?? -Infinity) > (best.composite ?? -Infinity));
      if (beats) best = c;
    }
    winner = { candidate_id: best.candidate_id, by: 'pairwise_win_rate' };
  } else {
    const withComposite = candidates.filter((c) => c.composite !== null);
    if (withComposite.length > 0) {
      let best = withComposite[0];
      for (const c of withComposite.slice(1)) {
        if (c.composite > best.composite) best = c;
      }
      winner = { candidate_id: best.candidate_id, by: 'composite' };
    }
  }

  return {
    methodology: 'naming',
    n: personaCount(rows),
    candidates,
    pairwise: comparisons.length > 0 ? { comparisons } : null,
    turf,
    winner,
  };
}

module.exports = { computeNaming };
