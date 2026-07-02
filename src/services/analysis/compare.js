/**
 * Pass 46 Phase 3 — deterministic COMPARE CONCEPTS analysis
 * (sequential monadic battery + forced choice).
 *
 * Doctrine (Pass 46): the LLM does NOT compute methodology math. This
 * module turns clean mission_responses rows ({persona_id, question_id,
 * answer}) into every number the compare report shows. Deterministic,
 * never throws, incomputable → null.
 *
 * Question metadata contract — quoted from the generator prompt
 * COMPARE_SURVEY_GEN_SYSTEM (src/services/claudeAI.js:1160-1201):
 *
 *  - PER-CONCEPT battery (claudeAI.js:1187-1192): 5 questions per
 *    concept, each carrying `concept_id=<id>` (the supplied id, e.g.
 *    "c1"), emitted in this fixed order:
 *      APPEAL     — funnel_stage="appeal",     type="rating" 1-10,
 *                   text 'Considering [<concept name>]: [<concept
 *                   description>]. How appealing is this concept?'
 *                   (the first [bracketed] token = our label fallback)
 *      RELEVANCE  — funnel_stage="relevance",  type="rating" 1-7
 *      UNIQUENESS — funnel_stage="uniqueness", type="rating" 1-7
 *      INTENT     — funnel_stage="intent", type="single", 5 options:
 *                   ["Definitely would buy","Probably would buy",
 *                    "Might or might not","Probably would NOT buy",
 *                    "Definitely would NOT buy"] — ordered most→least
 *                   positive, so TOP-2 BOX = options[0] + options[1]
 *      BEST/WORST — funnel_stage="qualitative", type="text" (no math)
 *    The validator (validateCompareSurvey, claudeAI.js:1203-1222) does
 *    NOT enforce funnel_stage, so when the flag is missing we fall back
 *    to the prompt's positional order within the concept block.
 *  - FINAL block (claudeAI.js:1193-1195): "two final questions
 *    (concept_id=null, is_final_choice=true)" —
 *      FORCED CHOICE — type="single",
 *        options=[<each concept name>, "None of these"]
 *      WHY — type="text"
 *    BOTH carry is_final_choice=true, so the forced-choice question is
 *    identified as the is_final_choice question whose type is NOT
 *    "text" (validateCompareSurvey checks the penultimate question,
 *    claudeAI.js:1220-1221).
 *
 *  ANSWER SHAPES (simulate.js:47-50,65-68): rating → number, single →
 *  the chosen option string, text → free string. Final-choice answers
 *  are concept NAMES (or "None of these") — mapped to concept ids by
 *  case-insensitive trimmed label match.
 *
 * Concept source of truth: mission.concepts — JSON TEXT column
 * (missionSchema.js 'concepts') holding [{id, name, description,
 * price_usd?}] (cf. buildCompareUserPrompt, claudeAI.js:1228,1238).
 */

const {
  ratingStats, round4, personaCount, shares, distribution, isSkip,
} = require('./shared');

const norm = (v) => String(v ?? '').trim().toLowerCase();

// Label recovery from a battery question's text. Two real-world shapes:
//   1. bracketed  — 'Considering [<name>]: <desc>. How appealing…'
//   2. unbracketed — 'Considering <name>: <desc>. How appealing…'
// (the live generator emits #2; cf. mission 86d4b8c6's q2/q7). The first
// [bracketed] token wins when present; otherwise we take the run between
// 'Considering ' and the first ':' .
const BRACKET_RE = /\[([^\]]+)\]/;
const CONSIDERING_RE = /considering\s+(.+?)\s*:/i;

// Answers that mean "no concept" in a forced choice — kept in a separate
// bucket so concept shares + none sum to 100%.
const NONE_RE = /^(none|none of these|neither|no preference|n\/a)$/i;
const isNoneAnswer = (v) => {
  const s = norm(v);
  return s === '' || NONE_RE.test(s);
};

/**
 * Recover a concept's display name from its battery questions when the
 * mission.concepts registry has no usable name. Tries the APPEAL text
 * first (it carries the name per claudeAI.js:1188), then any battery
 * question. Returns null when nothing parseable is found.
 */
function labelFromBattery(qs) {
  for (const q of qs) {
    const t = String(q.text || '');
    const b = BRACKET_RE.exec(t);
    if (b && b[1].trim()) return b[1].trim();
    const c = CONSIDERING_RE.exec(t);
    if (c && c[1].trim()) return c[1].trim();
  }
  return null;
}

// claudeAI.js:1188-1192 — battery emission order, used as positional
// fallback when funnel_stage is missing.
const POSITIONAL_STAGES = ['appeal', 'relevance', 'uniqueness', 'intent', 'qualitative'];
const VALID_STAGES = new Set(POSITIONAL_STAGES);
const RATING_DIMS = ['appeal', 'relevance', 'uniqueness'];

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
 * Pass 46 Phase 3 — compare-concepts analysis.
 * @param {Array<{persona_id, question_id, answer}>} rows clean mission_responses
 * @param {Array<object>} questions mission questions (carry the metadata above)
 * @param {object} mission mission row (mission.concepts used for labels)
 */
function computeCompare(rows, questions, mission) {
  try {
    return computeCompareInner(
      Array.isArray(rows) ? rows : [],
      Array.isArray(questions) ? questions : [],
      mission && typeof mission === 'object' ? mission : {},
    );
  } catch (err) {
    // Contract: never throw.
    return {
      methodology: 'compare',
      n: safePersonaCount(rows),
      concepts: [],
      head_to_head: [],
      final_choice: null,
      overall_winner: null,
      error: `compare_analysis_failed: ${err.message}`,
    };
  }
}

function computeCompareInner(rows, questions, mission) {
  const rowsByQ = new Map();
  for (const r of rows) {
    if (!r || !r.question_id) continue;
    if (!rowsByQ.has(r.question_id)) rowsByQ.set(r.question_id, []);
    rowsByQ.get(r.question_id).push(r);
  }
  const answered = (qid) => (rowsByQ.get(qid) || [])
    .filter((r) => !isSkip(r.answer)); // excludes null/empty AND the 'not_applicable' skip

  // ── Concept registry (insertion order = report order): mission
  // concepts first, then concept_ids discovered on battery questions. ──
  const registry = new Map(); // concept_id → label|null
  for (const c of parseMaybeJSONArray(mission.concepts)) {
    if (!c || typeof c !== 'object') continue;
    const label = String(c.name || c.text || '').trim();
    const id = String(c.id ?? label).trim();
    if (id) registry.set(id, label || null);
  }

  // Battery questions: concept_id set and not part of the final block
  // (final block has concept_id=null per claudeAI.js:1193).
  const conceptQs = new Map(); // concept_id → [questions in array order]
  for (const q of questions) {
    if (!q || !q.concept_id || q.is_final_choice === true) continue;
    const id = String(q.concept_id);
    if (!conceptQs.has(id)) conceptQs.set(id, []);
    conceptQs.get(id).push(q);
    if (!registry.has(id)) registry.set(id, null);
  }
  // Label fallback: recover the concept name from its battery text — the
  // APPEAL question carries 'Considering <concept name>: …'
  // (claudeAI.js:1188), bracketed or not.
  for (const [id, qs] of conceptQs) {
    if (registry.get(id)) continue;
    registry.set(id, labelFromBattery(qs) || id);
  }
  for (const [id, label] of registry) {
    if (!label) registry.set(id, id); // mission entry without a usable name
  }

  // ── Per-concept dimensions ───────────────────────────────────────────
  const concepts = [];
  for (const [id, label] of registry) {
    const qs = conceptQs.get(id) || [];
    const dimRows = { appeal: [], relevance: [], uniqueness: [] };
    let intentQ = null;
    let intentRows = [];
    qs.forEach((q, i) => {
      const stage = VALID_STAGES.has(q.funnel_stage)
        ? q.funnel_stage
        : (POSITIONAL_STAGES[i] || null);
      if (stage === 'appeal' || stage === 'relevance' || stage === 'uniqueness') {
        dimRows[stage].push(...answered(q.id));
      } else if (stage === 'intent' && !intentQ) {
        intentQ = q;
        intentRows = answered(q.id);
      }
      // 'qualitative' (text) → narrative layer, no math here.
    });

    let intent = null;
    if (intentQ) {
      const base = personaCount(intentRows);
      const opts = Array.isArray(intentQ.options) ? intentQ.options : [];
      let top2 = null;
      // Top-2 box only when the intent question is the prompt's 5-point
      // purchase-intent scale (claudeAI.js:1191) — options are ordered
      // most→least positive, so top-2 = options[0] + options[1].
      if (opts.length === 5 && base > 0) {
        const topSet = new Set([norm(opts[0]), norm(opts[1])]);
        const count = intentRows.filter((r) => topSet.has(norm(r.answer))).length;
        top2 = { pct: round4((count / base) * 100), count, base };
      }
      intent = {
        base,
        distribution: distribution(intentRows),
        top2,
        options: opts,
      };
    }

    concepts.push({
      concept_id: id,
      label,
      dimensions: {
        appeal: ratingStats(dimRows.appeal),
        relevance: ratingStats(dimRows.relevance),
        uniqueness: ratingStats(dimRows.uniqueness),
        intent,
      },
      final_choice_pct: null, // filled below when the forced-choice question exists
    });
  }

  // ── Final choice (forced choice) ─────────────────────────────────────
  // Both final questions carry is_final_choice=true (claudeAI.js:1193);
  // the forced choice is the non-text one. Persisted answers are concept
  // NAMES (claudeAI.js:1194, simulate.js:47) — NOT concept_ids — so each
  // answer is resolved to a concept_id through a name→id map built from
  // the registry labels (case-insensitive, trimmed). Anything that maps
  // to no concept ("None of these"/blank/unknown) lands in a none bucket
  // so per-concept shares + none sum to 100%.
  const nameToId = new Map();
  // Map the bare id first, then the resolved label (label takes
  // precedence), so answers persisted as either the id or the name resolve.
  for (const [id] of registry) {
    if (id) nameToId.set(norm(id), id);
  }
  for (const [id, label] of registry) {
    if (label) nameToId.set(norm(label), id);
  }
  const resolveChoice = (answer) => {
    if (isNoneAnswer(answer)) return null; // explicit none / blank
    return nameToId.get(norm(answer)) || null; // unknown string → none bucket
  };

  const fcQ = questions.find((q) => q && q.is_final_choice === true && q.type !== 'text') || null;
  let finalChoice = null;
  if (fcQ) {
    const fRows = answered(fcQ.id);
    const base = personaCount(fRows);
    if (base > 0) {
      // Tally votes by resolved concept_id; everything unresolved → none.
      const votes = new Map(); // concept_id → count
      let noneCount = 0;
      for (const r of fRows) {
        const id = resolveChoice(r.answer);
        if (id && registry.has(id)) votes.set(id, (votes.get(id) || 0) + 1);
        else noneCount += 1;
      }
      for (const c of concepts) {
        const count = votes.get(c.concept_id) || 0;
        c.final_choice_pct = { pct: round4((count / base) * 100), count, base };
      }
      // options table: raw answer-string distribution (verbatim, incl.
      // "None of these") — keeps the Pass 46 shape for the renderer.
      const s = shares(distribution(fRows), base);
      finalChoice = {
        question_id: fcQ.id,
        base,
        options: s.shares,
        none: { count: noneCount, pct: round4((noneCount / base) * 100) },
      };
    }
  }

  // ── Head-to-head: per dimension, winner concept + delta vs runner-up.
  // Rating dims compare means; intent compares top-2 box shares
  // (delta in percentage points). Ties keep the earlier concept in
  // registry order (strict > replacement) — deterministic. ──
  const headToHead = [];
  const pushH2H = (dimension, entries, metric) => {
    if (entries.length < 2) return;
    let w = entries[0];
    let r = null;
    for (const e of entries.slice(1)) {
      if (e.value > w.value) { r = w; w = e; } else if (!r || e.value > r.value) r = e;
    }
    headToHead.push({
      dimension,
      winner_concept_id: w.id,
      runner_up_concept_id: r.id,
      delta: round4(w.value - r.value),
      metric,
    });
  };
  for (const dim of RATING_DIMS) {
    pushH2H(
      dim,
      concepts.filter((c) => c.dimensions[dim]).map((c) => ({ id: c.concept_id, value: c.dimensions[dim].mean })),
      'mean_diff',
    );
  }
  pushH2H(
    'intent',
    concepts.filter((c) => c.dimensions.intent && c.dimensions.intent.top2)
      .map((c) => ({ id: c.concept_id, value: c.dimensions.intent.top2.pct })),
    'top2_pp_diff',
  );

  // ── Overall winner: highest final-choice count. "None of these" maps
  // to no concept; if no concept got a single vote → null. Ties keep
  // the earlier concept in registry order. ──
  let overallWinner = null;
  if (finalChoice) {
    let bestId = null;
    let bestCount = 0;
    for (const c of concepts) {
      const count = c.final_choice_pct ? c.final_choice_pct.count : 0;
      if (count > bestCount) { bestCount = count; bestId = c.concept_id; }
    }
    if (bestId) overallWinner = { concept_id: bestId, by: 'final_choice' };
  }

  return {
    methodology: 'compare',
    n: personaCount(rows),
    concepts,
    head_to_head: headToHead,
    final_choice: finalChoice,
    overall_winner: overallWinner,
  };
}

module.exports = { computeCompare };
