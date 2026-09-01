/**
 * VETT — Per-persona question ORDER randomization (hardening item 2).
 *
 * WHY
 * ───
 * Order effects are a real bias in survey research: a question's position
 * changes the answer (anchoring, priming, fatigue, acquiescence, straight-
 * lining). Today every simulated respondent sees the questions in one fixed
 * order, so whatever order effect exists is baked UNIFORMLY into the whole
 * sample — it does not average out, it compounds. Rotating the order per
 * respondent turns a systematic bias into noise that cancels across n.
 *
 * WHAT THIS MODULE DOES *NOT* DO
 * ──────────────────────────────
 * It changes ONLY the order questions are PRESENTED IN THE PROMPT. It does
 * not reorder `mission.questions`, does not reorder the returned response
 * rows, and does not touch persistence. Answers come back keyed by
 * `question_id` (simulate.js parseInto / answersById) and simulate.js
 * re-emits them via `questions.map((q) => answersById.get(q.id))` — i.e.
 * in the ORIGINAL question order, re-KEYED by id, never re-indexed.
 * That invariant is what makes this safe against the
 * (mission_id, persona_id, question_id) UNIQUE index added in pass 48.
 *
 * DETERMINISM
 * ───────────
 * `src/services/ai/anthropic.js` (~L109-111) documents that the Anthropic
 * Messages API has no seed parameter, so bit-exact re-simulation is not
 * achievable. Question ORDER, however, CAN be made deterministic — and is:
 * the permutation is a pure function of (mission.id, persona.id) through a
 * FNV-1a seed + mulberry32 PRNG. No Math.random anywhere in this file.
 * Re-running the same mission for the same persona yields the same order.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * THE ZONE MODEL
 * ─────────────────────────────────────────────────────────────────────────
 * The asked order is built in three zones:
 *
 *   ZONE 1 — PINNED. Every question with `isScreening === true`, kept at the
 *            front in its original relative order. Screening gates
 *            qualification (simulate.js passesScreening, personas.js, and
 *            recruitLoop.js all walk responses and stop at the first
 *            screen-fail), so moving a screener changes WHO QUALIFIES.
 *            Screeners are never shuffled and never demoted.
 *
 *   ZONE 2 — ORDER-LOCKED BLOCKS. Groups of questions whose ORDER IS THE
 *            INSTRUMENT. Emitted as a single atomic unit at the slot of the
 *            block's first member, internally in original relative order,
 *            and ANCHORED (the unit itself never moves). See BLOCK DECISIONS.
 *
 *   ZONE 3 — SHUFFLE-SAFE. Two flavours:
 *              (a) ROTATABLE blocks — the block's members are atomic units
 *                  that may permute AMONG THAT BLOCK'S OWN SLOTS. A Kano
 *                  pair rotates as an intact, internally-ordered pair; it
 *                  never fragments and never leaves the Kano footprint.
 *              (b) FREE questions — carry no methodology/stage metadata at
 *                  all (the generic 5-question survey). Permute among the
 *                  free slots.
 *
 * Permutation is SLOT-PRESERVING: each permutation group shuffles only the
 * units already sitting in that group's slots, and writes them back into
 * those same slots. A locked block therefore keeps its exact position
 * relative to everything else, and a rotatable block keeps its footprint.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * PER-METHODOLOGY DECISIONS (justified from the analysis code, not intuition)
 * ─────────────────────────────────────────────────────────────────────────
 * DEFAULT = LOCKED. Any question carrying methodology/stage/kind metadata is
 * order-locked unless it is on the ROTATABLE allow-list below. "When unsure,
 * do not shuffle" is encoded as the default branch, not as a comment.
 *
 * LOCKED — Van Westendorp (`vw_band`, methodology='van_westendorp')
 *   analysis/pricing.js L117 selects the four band questions by `vw_band`
 *   ("first question per band wins"), so analysis would not CRASH on a
 *   shuffle — but L138 keeps only personas with all four bands present and
 *   L144-154 builds cumulative curves whose intersections (PMC/PME/OPP/IPP)
 *   are only meaningful if the respondent produced an internally consistent
 *   too_cheap < bargain < expensive < too_expensive ladder. The canonical
 *   presentation sequence is what produces that consistency. LOCKED.
 *
 * LOCKED — Gabor-Granger (`gg_anchor_index`, methodology='gabor_granger')
 *   analysis/pricing.js L175-176 sorts the rungs by `gg_anchor_index` and
 *   L203 sorts the ladder by price before computing the demand curve and
 *   revenue-maximising point. The instrument IS the ASCENDING ladder:
 *   acceptance is expected to fall monotonically as price climbs. Asking
 *   $149 before $9 anchors high and inverts the curve. LOCKED.
 *
 * ROTATABLE (as intact pairs) — Kano (methodology='kano')
 *   analysis/roadmap.js L228-235 pairs questions by `feature_id` +
 *   `kano_type`, keyed on metadata with no positional reference, and
 *   excludes any persona missing either half. Each FEATURE's pair is
 *   independent of every other feature's pair. So: the functional and
 *   dysfunctional halves must stay ADJACENT and functional-first (the
 *   "WAS in / WAS NOT in" contrast is the measurement), but whole pairs
 *   may rotate among the Kano slots — standard Kano battery practice.
 *
 * ROTATABLE (as whole sets) — MaxDiff (methodology='max_diff')
 *   The design's balance requirement is an APPEARANCE COUNT over
 *   `feature_set` membership (claudeAI.js L791 `counts[fid] += 1`), which is
 *   invariant to set order. analysis/roadmap.js L169-208 aggregates
 *   best/worst/appearances across all sets with no positional reference.
 *   The `options[i] ↔ feature_set[i]` positional mapping (roadmap.js L151)
 *   is WITHIN one question and is untouched here — a set is one question and
 *   is never split. Sets rotate among the MaxDiff slots.
 *
 * ROTATABLE — audience-profiling attitudinal battery
 *   (`kind==='attitudinal'` + `dimension`)
 *   claudeAI.js ~L2125 declares a canonical dimension slot order (q2-q7), but
 *   that is a GENERATION convention: analysis/audienceProfiling.js L153 finds
 *   each dimension with `qs.find(qq => qq.kind==='attitudinal' && qq.dimension===d)`
 *   while ITERATING `ATTITUDE_DIMENSIONS` (L137), so the segmentation vector
 *   is assembled in canonical dimension order regardless of array position.
 *   Position does not matter to the consumer. A 1-7 agree/disagree Likert
 *   battery is the textbook case for item-order rotation (acquiescence and
 *   straight-lining). Each statement is an independent unit.
 *
 * ROTATABLE — paired comparisons (`is_paired_comparison === true`)
 *   analysis/naming.js L255 selects them by the flag and L275 resolves the
 *   answer through the option index WITHIN the question. Head-to-heads are
 *   mutually independent, so they rotate among their own slots.
 *
 * LOCKED — every funnel/stage survey (`funnel_stage` present)
 *   Covers brand_lift, ad_effectiveness, concept_test, sequential_monadic,
 *   brand_health_tracker. Two independent reasons:
 *     1. Measurement validity: UNAIDED recall/awareness must be asked BEFORE
 *        AIDED (claudeAI.js L125 enumerates unaided_* then aided_*;
 *        analysis/brandLift.js L180 AIDED_BRAND_STAGES exists because aided
 *        is a different measurement). Asking aided first contaminates the
 *        unaided measure in BOTH cells and destroys the exposed-vs-control
 *        lift estimate. ad_effectiveness q3 is literally an EXPOSURE step
 *        ("Please review the ad above before answering the next questions",
 *        claudeAI.js L1321) — everything after it is post-exposure BY
 *        CONSTRUCTION.
 *     2. The generators' own validators assert POSITIONAL stage order:
 *        claudeAI.js L1095 and L1352-1353 both reject a survey where
 *        `qs[i].funnel_stage !== expectedStages[i]`.
 *   LOCKED.
 *
 * LOCKED — sequential-monadic concept batteries (`concept_id`,
 *   `is_final_choice`)
 *   analysis/compare.js L188-190 contains a POSITIONAL FALLBACK:
 *   `VALID_STAGES.has(q.funnel_stage) ? q.funnel_stage : POSITIONAL_STAGES[i]`
 *   — when `funnel_stage` is missing the stage is inferred from the
 *   question's INDEX WITHIN ITS CONCEPT BATTERY (L93). Concept rotation is
 *   otherwise the classic sequential-monadic randomization, but this
 *   fallback makes any order change one propagation-bug away from silently
 *   mislabelling appeal/relevance/uniqueness. LOCKED. The forced-choice
 *   block (`is_final_choice`) must also stay last — it is only answerable
 *   after every concept has been seen.
 *
 * LOCKED — churn (`churn_stage`) and every remaining `methodology` value
 *   (monadic, monadic_plus_paired, turf, nps, csat, ces, *_driver,
 *   attribute_matrix, wtp_ceiling, switching_cost, retention, behavior,
 *   specific_issues, screener, brand_health_tracker, concept_test,
 *   ad_effectiveness, sequential_monadic) and every remaining `kind` value
 *   (market_entry's screener/appeal/intent/wtp/barrier/competitive/
 *   localisation; audience_profiling's behavioural/media/needs). These are
 *   staged instruments with no evidence that rotation is safe, so they take
 *   the LOCKED default.
 *
 * SHUFFLED FREELY — questions with none of the above metadata: the generic
 *   SURVEY_GEN_SYSTEM output (claudeAI.js L30-79), which is a flat list of
 *   independent attitude/behaviour questions after the screener. This is
 *   where the order-effect win actually lands for most missions.
 *
 * LEGACY-SHAPE SAFETY NET
 *   Classification is metadata-driven, and metadata is not guaranteed. An
 *   audit of the real mission corpus turned up surveys stored under an
 *   order-sensitive goal_type that carry NO methodology tags at all —
 *   including a pricing mission whose q3/q4 are a Van Westendorp battery in
 *   plain prose ("At what price would <product> be SO EXPENSIVE you would
 *   not consider buying it?") with no `vw_band` and no `methodology`. A
 *   purely metadata-driven classifier would call those FREE and shuffle a
 *   Van Westendorp ladder — exactly the corruption this module exists to
 *   prevent. So: untagged questions are only treated as FREE when the
 *   mission's goal_type is the GENERIC one ('research', or absent — the only
 *   surveys the flat SURVEY_GEN_SYSTEM generator produces). Under every
 *   other goal_type an untagged question is LOCKED. For modern surveys this
 *   is a no-op (they are fully tagged); it only bites on legacy shapes,
 *   where not shuffling is the right answer.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * DOWNSTREAM SAFETY AUDIT (checked, nothing assumes ASKED position)
 * ─────────────────────────────────────────────────────────────────────────
 *  - services/report/buildReport.js L414 `questions.map((q, i) => …)` sets the
 *    display `number: i + 1` from `mission.questions` — the stored survey
 *    definition, which this module never mutates.
 *  - `aggregated_by_question` (jobs/runMission.js L675-694) is keyed by
 *    question id.
 *  - Every analysis module keys off metadata (vw_band, gg_anchor_index,
 *    feature_id, funnel_stage, kind+dimension, churn_stage, methodology) and
 *    reads `mission.questions`, never an asked order. The only positional
 *    reads found anywhere are WITHIN a question's own `options` array
 *    (roadmap.js L95, naming.js L275) or within a concept battery of
 *    `mission.questions` (compare.js L190) — neither is touched.
 *  - Prompt caching is unaffected: anthropic.js L120-121 attaches
 *    `cache_control` to the SYSTEM block only; the user message that carries
 *    the question list was never cached, so per-persona orders cost no
 *    cache hit rate.
 */

// ── Seeded PRNG ──────────────────────────────────────────────────────────

/**
 * FNV-1a (32-bit). Deterministic, dependency-free, well-dispersed for the
 * short ASCII keys we build. Returns an unsigned 32-bit integer.
 * @param {string} str
 * @returns {number}
 */
function fnv1a32(str) {
  let h = 0x811c9dc5;
  const s = String(str);
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i) & 0xff;
    // h *= 16777619, kept in 32-bit range via shift-adds (Math.imul is exact)
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/**
 * The seed for one (mission, persona) pair. Same mission + same persona →
 * same seed → same order, for ever. Different personas → different seeds.
 * @param {object} mission
 * @param {object} persona
 * @returns {number} uint32
 */
function seedFor(mission, persona) {
  const missionId = String((mission && mission.id) ?? '');
  const personaId = String((persona && (persona.id ?? persona.persona_id)) ?? '');
  // The separator prevents ('ab','c') and ('a','bc') colliding.
  return fnv1a32(`vett:qorder:v1|${missionId}|${personaId}`);
}

/**
 * mulberry32 — a small, fast, well-tested 32-bit PRNG. Deterministic given
 * the seed. Returns a function producing floats in [0, 1).
 * @param {number} seed uint32
 * @returns {() => number}
 */
function makeRng(seed) {
  let a = (seed >>> 0) || 1; // a zero seed degenerates; nudge it
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Fisher-Yates on a copy, driven by the supplied PRNG. Pure.
 * @param {Array} arr
 * @param {() => number} rng
 * @returns {Array} new array
 */
function shuffled(arr, rng) {
  const out = arr.slice();
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1));
    const tmp = out[i];
    out[i] = out[j];
    out[j] = tmp;
  }
  return out;
}

// ── Classification ───────────────────────────────────────────────────────

/** Truthy-ish presence test that treats '' and null/undefined as absent. */
function has(v) {
  return v !== undefined && v !== null && v !== '';
}

/**
 * Classify one question into a zone.
 *
 * @param {object} q
 * @returns {{zone:'pinned'}
 *          |{zone:'locked', block:string}
 *          |{zone:'rotatable', block:string, unit:string}
 *          |{zone:'free'}}
 *   `block` groups questions that must travel together (locked) or that share
 *   a permutation pool (rotatable). `unit` is the atom that rotates — for
 *   Kano it is the feature pair, so both halves carry the same `unit`.
 */
function classifyQuestion(q) {
  if (!q || typeof q !== 'object') return { zone: 'free' };

  // ZONE 1 — screeners are pinned, whatever else they carry.
  if (q.isScreening === true) return { zone: 'pinned' };

  const methodology = has(q.methodology) ? String(q.methodology) : null;

  // ── ROTATABLE allow-list (each entry justified in the header) ──────────

  // Kano: the functional/dysfunctional pair is the atom.
  if (methodology === 'kano' || has(q.kano_type)) {
    const feature = has(q.feature_id) ? String(q.feature_id) : '_nofeature';
    return { zone: 'rotatable', block: 'kano', unit: `kano:${feature}` };
  }

  // MaxDiff: one balanced set per question; the set is the atom.
  if (methodology === 'max_diff' || q.type === 'max_diff_set') {
    return { zone: 'rotatable', block: 'max_diff', unit: `max_diff:${String(q.id)}` };
  }

  // Audience-profiling attitudinal Likert battery.
  if (q.kind === 'attitudinal' && has(q.dimension)) {
    return { zone: 'rotatable', block: 'attitudinal', unit: `attitudinal:${String(q.id)}` };
  }

  // Naming head-to-head paired comparisons.
  if (q.is_paired_comparison === true) {
    return { zone: 'rotatable', block: 'paired', unit: `paired:${String(q.id)}` };
  }

  // ── LOCKED blocks (explicit, most specific first) ──────────────────────

  // Van Westendorp — four bands in canonical sequence.
  if (methodology === 'van_westendorp' || has(q.vw_band)) {
    return { zone: 'locked', block: 'van_westendorp' };
  }

  // Gabor-Granger — ascending price ladder.
  if (methodology === 'gabor_granger' || has(q.gg_anchor_index)) {
    return { zone: 'locked', block: 'gabor_granger' };
  }

  // Sequential-monadic concept batteries + the forced-choice tail.
  if (has(q.concept_id) || q.is_final_choice === true) {
    return { zone: 'locked', block: 'concept_sequence' };
  }

  // Every staged funnel instrument (brand_lift, ad_effectiveness,
  // concept_test, brand_health_tracker, …). One block so the whole funnel
  // holds its shape.
  if (has(q.funnel_stage)) return { zone: 'locked', block: 'funnel' };

  // Churn stages.
  if (has(q.churn_stage)) return { zone: 'locked', block: 'churn' };

  // ── LOCKED default: any other methodology / kind / stage metadata ──────
  if (methodology) return { zone: 'locked', block: `methodology:${methodology}` };
  if (has(q.kind)) return { zone: 'locked', block: `kind:${String(q.kind)}` };
  if (has(q.kpi_category) || has(q.brand_id) || q.is_turf === true) {
    return { zone: 'locked', block: 'tagged' };
  }

  // ZONE 3b — genuinely independent.
  return { zone: 'free' };
}

/**
 * Goal types whose UNTAGGED questions may be shuffled. Only the generic
 * survey generator (claudeAI.js SURVEY_GEN_SYSTEM) emits untagged questions
 * by design; every specialized generator is selected BY goal_type and tags
 * its output. An unrecognised or new goal_type is treated as order-sensitive
 * — the safe default is not to shuffle.
 */
const FREE_UNTAGGED_GOALS = new Set(['research']);

/**
 * @param {object} mission
 * @returns {boolean} true when questions with no methodology metadata are
 *   safe to shuffle for this mission.
 */
function untaggedAreFree(mission) {
  const g = mission && mission.goal_type != null ? String(mission.goal_type).trim() : '';
  return g === '' || FREE_UNTAGGED_GOALS.has(g);
}

// ── Zone assembly ────────────────────────────────────────────────────────

/**
 * Build the unit/slot structure for a question list. Exported for tests and
 * for anyone who needs to reason about the zones without a persona.
 *
 * @param {Array<object>} questions
 * @param {object} [opts]
 * @param {boolean} [opts.lockUntagged=false] when true, questions carrying no
 *   methodology metadata are locked instead of shuffled (legacy-shape safety
 *   net — see the header). Callers normally derive this from the mission's
 *   goal_type via `untaggedAreFree`.
 * @returns {{pinned:Array<object>, units:Array<{key:string, group:string|null, questions:Array<object>}>}}
 *   `units` is the non-screener sequence in ORIGINAL order. `group` is the
 *   permutation pool a unit belongs to (`null` = anchored, never moves).
 */
function buildZones(questions, opts) {
  const lockUntagged = !!(opts && opts.lockUntagged);
  const qs = Array.isArray(questions) ? questions.filter((q) => q && typeof q === 'object') : [];

  const pinned = [];
  const rest = [];
  for (const q of qs) {
    if (classifyQuestion(q).zone === 'pinned') pinned.push(q);
    else rest.push(q);
  }

  const units = [];
  const unitIndexByKey = new Map(); // unit key → index into `units`

  for (const q of rest) {
    const c = classifyQuestion(q);

    if (c.zone === 'free') {
      if (lockUntagged) {
        // Anchored in place: one unit per question, no permutation pool.
        units.push({ key: `locked:untagged:${units.length}`, group: null, questions: [q] });
      } else {
        units.push({ key: `free:${units.length}`, group: 'free', questions: [q] });
      }
      continue;
    }

    // locked → one unit per block, anchored at the block's FIRST member.
    // rotatable → one unit per atom, all atoms of a block share a pool.
    const key = c.zone === 'locked' ? `locked:${c.block}` : c.unit;
    const group = c.zone === 'locked' ? null : `rot:${c.block}`;

    const existing = unitIndexByKey.get(key);
    if (existing !== undefined) {
      // Later members join the unit already anchored at its first member's
      // slot, preserving their original relative order inside it.
      units[existing].questions.push(q);
    } else {
      unitIndexByKey.set(key, units.length);
      units.push({ key, group, questions: [q] });
    }
  }

  return { pinned, units };
}

/**
 * The per-persona asked order.
 *
 * Returns the SAME question objects (same references, same count) in a
 * seeded permutation. Never mutates its inputs. Any unexpected input shape
 * degrades to "return the original order" rather than throwing — a bad
 * shuffle must never be able to take down a simulation run.
 *
 * @param {Array<object>} questions  mission.questions
 * @param {object} mission           needs `.id` for the seed
 * @param {object} persona           needs `.id` for the seed
 * @returns {Array<object>}
 */
function orderQuestionsForPersona(questions, mission, persona) {
  if (!Array.isArray(questions) || questions.length < 2) {
    return Array.isArray(questions) ? questions : [];
  }

  try {
    const { pinned, units } = buildZones(questions, { lockUntagged: !untaggedAreFree(mission) });

    // Slots, grouped by permutation pool. Anchored units (group === null)
    // never appear in a pool, so they keep their slot exactly.
    const slotsByGroup = new Map();
    units.forEach((u, i) => {
      if (!u.group) return;
      if (!slotsByGroup.has(u.group)) slotsByGroup.set(u.group, []);
      slotsByGroup.get(u.group).push(i);
    });

    const rng = makeRng(seedFor(mission, persona));
    const placed = units.slice();

    // Deterministic pool iteration: Map preserves insertion order, which is
    // first-appearance order of the group — a pure function of `questions`.
    for (const [, slots] of slotsByGroup) {
      if (slots.length < 2) continue;
      const pool = shuffled(slots.map((i) => units[i]), rng);
      slots.forEach((slot, k) => { placed[slot] = pool[k]; });
    }

    const out = pinned.slice();
    for (const u of placed) out.push(...u.questions);

    // Belt and braces: the asked order MUST be a permutation of the input.
    // If it somehow is not, fall back to the original order rather than
    // asking a persona a truncated or duplicated survey.
    const original = questions.filter((q) => q && typeof q === 'object');
    if (out.length !== original.length) return questions;

    return out;
  } catch (err) {
    return questions;
  }
}

module.exports = {
  orderQuestionsForPersona,
  buildZones,
  classifyQuestion,
  untaggedAreFree,
  FREE_UNTAGGED_GOALS,
  seedFor,
  makeRng,
  shuffled,
  fnv1a32,
};
