/**
 * Response-answer value handling — the ONE place that defines how a
 * "not applicable" / skip answer is represented and how it is excluded from
 * analysis.
 *
 * WHY: `mission_responses.answer` is `JSONB NOT NULL`. The simulator encodes a
 * legitimate skip on a conditional/skip-logic question (e.g. aided ad-recall
 * when no ad was recalled) as a null answer. A null against a NOT NULL JSONB
 * column fails the whole chunk insert (Postgres 23502), which — before the
 * fail-loud guard in runMission — silently produced a "completed" mission with
 * zero persisted responses and a report built on nothing.
 *
 * FIX: store the sentinel STRING 'not_applicable' instead of SQL null (keeps the
 * column contract intact + makes the analysis-layer skip explicit), and teach
 * the aggregation layers to treat that sentinel (and any residual null/empty) as
 * a SKIP — excluded from distributions, means, and percentage denominators — so
 * it never pollutes the numbers. 'not_applicable' is already the established
 * sentinel for `exposure_status` in this codebase, so the value is consistent.
 */

const NOT_APPLICABLE = 'not_applicable';

/**
 * Coerce a simulated answer into a storage-safe value: never SQL null against
 * the NOT NULL column. Arrays (multi-select) and objects (max_diff best/worst)
 * pass through; an empty array, null/undefined/'', or an explicit "not
 * applicable" / "n/a" string collapses to the sentinel. Real answers — including
 * the number 0 and legitimate options like "None of the above" — are preserved.
 */
function normalizeAnswerForStorage(answer) {
  // Arrays are valid JSONB and pass through unchanged, INCLUDING [] — an empty
  // multi-select is "answered, endorsed nothing" (a real respondent in the
  // denominator), NOT a skip.
  if (Array.isArray(answer)) return answer;
  if (answer && typeof answer === 'object') return answer;
  if (answer === null || answer === undefined) return NOT_APPLICABLE;
  const s = String(answer).trim();
  if (s === '') return NOT_APPLICABLE;
  // Only the explicit skip markers the simulator emits — NOT "none" / "no
  // answer", which can be legitimate distinct options.
  if (/^(not[\s_-]?applicable|n\/a|n\.a\.?)$/i.test(s)) return NOT_APPLICABLE;
  return answer;
}

/**
 * True when an answer is a skip (the sentinel, or a residual null/empty). Used
 * by the aggregation layers to drop it from distributions + denominators. The
 * number 0 is a real answer, never a skip.
 */
function isSkip(answer) {
  if (answer === null || answer === undefined) return true;
  // An array is never a skip: a non-empty array has selections, and [] is
  // "endorsed nothing" — a real respondent who still counts in the denominator.
  if (Array.isArray(answer)) return false;
  if (typeof answer === 'string') return normalizeAnswerForStorage(answer) === NOT_APPLICABLE;
  return false;
}

module.exports = { NOT_APPLICABLE, normalizeAnswerForStorage, isSkip };
