/**
 * Pass 48 — idempotent mission_responses persistence.
 *
 * WHY THIS EXISTS
 * ---------------
 * Both write paths into `mission_responses` were unconditional inserts:
 *
 *   - src/jobs/runMission.js  (legacy batch path, chunked bulk insert)
 *   - src/services/ai/recruitLoop.js (per-persona incremental insert)
 *
 * Neither asked "is this (persona, question) already stored?". A second
 * runMission invocation for the same mission therefore appends a WHOLE
 * SECOND COPY of the dataset. That is not a harmless double-count: the
 * two copies come from two independent generate+simulate runs, so the
 * same persona_id carries a DIFFERENT persona_profile and DIFFERENT
 * answers in each copy. Every distribution, mean and derived metric read
 * back out of the table is corrupted, not merely doubled.
 *
 * The second invocation is reachable because runMission's idempotency
 * claim is deliberately bypassed for `resume: true` (runMission.js ~L93)
 * and missionRecovery Job 3 re-enters every mission sitting in
 * status='processing' with resume:true — including one that is still
 * actively running on another pod.
 *
 * THE TWO LAYERS OF DEFENCE
 * -------------------------
 *   1. Application-level skip (this module): read the (persona_id,
 *      question_id) keys already stored for the mission and never
 *      re-send a row whose key is present. Correct for the sequential
 *      resume case and cheap — the recruit loop already reads its prior
 *      rows to rebuild state, so it hands us the key set for free.
 *
 *   2. Database-level guarantee: a UNIQUE index on
 *      (mission_id, persona_id, question_id) plus INSERT ... ON CONFLICT
 *      DO NOTHING (supabase-js `upsert` + `ignoreDuplicates`). Layer 1
 *      alone loses the concurrent-run race — two runs can both read
 *      "not present" before either writes. Only the DB constraint closes
 *      that window, and DO NOTHING (rather than a bare insert, which
 *      would 23505 and fail the whole chunk) makes the losing racer a
 *      no-op instead of a mission failure.
 *
 * MIGRATION ORDERING — READ THIS
 * ------------------------------
 * The unique index (migrations/pass-48/01_mission_responses_unique_key.sql)
 * CANNOT be applied while duplicates exist in production. It must be
 * applied AFTER scripts/dedupe-mission-responses.js --execute. Until then
 * layer 2 is absent, so every upsert call here falls back to a plain
 * insert when Postgres reports there is no matching constraint (42P10).
 * That makes this module safe to deploy BEFORE the migration: it degrades
 * to layer 1 only, which already stops the observed sequential-resume and
 * batch-rerun duplication.
 *
 * SECOND TABLE: persona_response_reasoning
 * ----------------------------------------
 * runMission writes the per-persona "why" traces from the SAME in-memory
 * `responses` array, in the same completion block, through a second
 * unconditional chunked insert. It shares the same natural key, so a
 * duplicated run duplicated it too. Survey 2026-08-31 (read-only):
 * 15 duplicate rows on af36a36d-401d-48e6-b94b-257e215613e2 (37 rows /
 * 22 distinct keys) out of 1865 rows across 42 missions.
 *
 * It is much narrower than mission_responses for a structural reason:
 * reasoning is only persisted for missions with <= 50 personas (Pass 22
 * Bug 22.14 cap) and only for rows the simulator actually emitted a
 * reasoning string for. The other two duplicated missions have zero
 * reasoning rows, so they cannot be affected.
 *
 * The generic core below is shared; only the table name and conflict
 * target differ. persistResponseRows / persistReasoningRows are the two
 * public entry points.
 */

const logger = require('../../utils/logger');

/** Matches RESPONSE_INSERT_CHUNK in runMission.js. */
const INSERT_CHUNK = 200;

/** PostgREST caps an unbounded select at 1000 rows; page explicitly. */
const KEY_PAGE_SIZE = 1000;

/**
 * Conflict target for ON CONFLICT DO NOTHING. Must match the columns of
 * the unique index created by migrations/pass-48/01.
 */
const RESPONSE_CONFLICT_TARGET = 'mission_id,persona_id,question_id';

/** Tables sharing the (mission_id, persona_id, question_id) natural key. */
const RESPONSE_TABLE  = 'mission_responses';
const REASONING_TABLE = 'persona_response_reasoning';

/**
 * Conflict target for persona_response_reasoning. Same natural key, so the
 * same column list; kept as its own constant so the two migrations and the
 * two upsert calls can never be silently pointed at the wrong index.
 */
const REASONING_CONFLICT_TARGET = 'mission_id,persona_id,question_id';

/** Natural key of a response row. */
function responseKey(missionId, personaId, questionId) {
  return `${missionId}::${personaId}::${questionId}`;
}

/**
 * True when Postgres/PostgREST rejected the ON CONFLICT clause because
 * the unique index does not exist yet (pre-migration deploys).
 */
function isMissingConflictTarget(err) {
  if (!err) return false;
  if (err.code === '42P10') return true;
  const msg = String(err.message || '').toLowerCase();
  return msg.includes('no unique or exclusion constraint')
    || msg.includes('there is no unique constraint')
    || msg.includes('on conflict specification');
}

/**
 * Load every (persona_id, question_id) key already stored for a mission.
 * Paginated — a 1000-respondent mission has ~12k rows and an unbounded
 * select would silently return only the first 1000, which would make the
 * skip-set lie and re-insert everything past row 1000.
 *
 * Returns { keys, error }. A read error is surfaced, never swallowed:
 * callers must decide whether inserting without the skip-set is safe.
 */
async function loadKeys(supabase, table, missionId) {
  const keys = new Set();
  for (let from = 0; ; from += KEY_PAGE_SIZE) {
    const { data, error } = await supabase
      .from(table)
      .select('persona_id, question_id')
      .eq('mission_id', missionId)
      .order('id', { ascending: true })
      .range(from, from + KEY_PAGE_SIZE - 1);
    if (error) return { keys, error };
    const page = Array.isArray(data) ? data : [];
    for (const r of page) keys.add(responseKey(missionId, r.persona_id, r.question_id));
    if (page.length < KEY_PAGE_SIZE) break;
  }
  return { keys, error: null };
}

/** mission_responses keys already stored for a mission. */
function loadPersistedResponseKeys(supabase, missionId) {
  return loadKeys(supabase, RESPONSE_TABLE, missionId);
}

/** persona_response_reasoning keys already stored for a mission. */
function loadPersistedReasoningKeys(supabase, missionId) {
  return loadKeys(supabase, REASONING_TABLE, missionId);
}

/**
 * Insert response rows idempotently.
 *
 * @param {object} supabase   supabase client
 * @param {string} missionId
 * @param {Array}  rows       fully-formed mission_responses rows
 * @param {object} [opts]
 * @param {Set}    [opts.knownKeys]  pre-loaded key set (from responseKey()).
 *                 When supplied no DB read happens and the set is MUTATED
 *                 with the keys actually sent, so a caller looping
 *                 persona-by-persona stays accurate without re-reading.
 * @param {string} [opts.caller]     log context
 * @returns {Promise<{attempted:number, skipped:number, sent:number, error:object|null}>}
 */
async function persistRows(supabase, table, conflictTarget, fnName, missionId, rows, opts = {}) {
  const attempted = Array.isArray(rows) ? rows.length : 0;
  if (attempted === 0) return { attempted: 0, skipped: 0, sent: 0, error: null };

  const caller = opts.caller || fnName;
  let keys = opts.knownKeys instanceof Set ? opts.knownKeys : null;
  if (!keys) {
    const loaded = await loadKeys(supabase, table, missionId);
    if (loaded.error) {
      // Do NOT fall through to a blind insert - that is exactly the bug
      // this module exists to prevent. Surface it; the caller treats a
      // persist error as fatal (runMission) or retriable (recruitLoop).
      logger.error(`${fnName}: could not read existing keys; refusing to insert blind`, {
        missionId, caller, err: loaded.error.message,
      });
      return { attempted, skipped: 0, sent: 0, error: loaded.error };
    }
    keys = loaded.keys;
  }

  // Filter against what is already stored AND against duplicates inside
  // this very batch (a retry round can hand us the same persona twice).
  const fresh = [];
  let skipped = 0;
  for (const row of rows) {
    const k = responseKey(missionId, row.persona_id, row.question_id);
    if (keys.has(k)) { skipped += 1; continue; }
    keys.add(k);
    fresh.push(row);
  }

  if (skipped > 0) {
    logger.warn(`${fnName}: skipped rows already persisted for this mission`, {
      missionId, caller, skipped, attempted,
    });
  }
  if (fresh.length === 0) return { attempted, skipped, sent: 0, error: null };

  let firstError = null;
  for (let i = 0; i < fresh.length; i += INSERT_CHUNK) {
    const chunk = fresh.slice(i, i + INSERT_CHUNK);
    let { error } = await supabase
      .from(table)
      .upsert(chunk, { onConflict: conflictTarget, ignoreDuplicates: true });
    if (error && isMissingConflictTarget(error)) {
      // Pre-migration deploy: the unique index is not there yet. Layer 1
      // (the skip-set above) still applies; we lose only the concurrent-
      // run guarantee, which is what the migration restores.
      logger.warn(`${fnName}: unique index absent - falling back to plain insert`, {
        missionId, caller, err: error.message,
      });
      ({ error } = await supabase.from(table).insert(chunk));
    }
    if (error && !firstError) firstError = error;
    if (error) {
      logger.error(`${fnName}: chunk insert failed`, {
        missionId, caller, chunkSize: chunk.length, err: error.message,
      });
    }
  }

  return { attempted, skipped, sent: fresh.length, error: firstError };
}

/**
 * Insert mission_responses rows idempotently.
 *
 * @param {object} supabase   supabase client
 * @param {string} missionId
 * @param {Array}  rows       fully-formed mission_responses rows
 * @param {object} [opts]
 * @param {Set}    [opts.knownKeys]  pre-loaded key set (from responseKey()).
 *                 When supplied no DB read happens and the set is MUTATED
 *                 with the keys actually sent, so a caller looping
 *                 persona-by-persona stays accurate without re-reading.
 * @param {string} [opts.caller]     log context
 * @returns {Promise<{attempted:number, skipped:number, sent:number, error:object|null}>}
 */
function persistResponseRows(supabase, missionId, rows, opts = {}) {
  return persistRows(supabase, RESPONSE_TABLE, RESPONSE_CONFLICT_TARGET,
    'persistResponseRows', missionId, rows, opts);
}

/**
 * Insert persona_response_reasoning rows idempotently.
 *
 * Same natural key and same two layers of defence as persistResponseRows.
 * Written from the same in-memory `responses` array by the same runMission
 * completion block, so a duplicated run duplicated this table too.
 *
 * Unlike mission_responses, a missing row here is legitimate: reasoning is
 * only persisted for missions with <= 50 personas and only when the
 * simulator emitted a non-empty reasoning string, so the caller must NOT
 * treat "fewer rows than responses" as an error.
 *
 * @returns {Promise<{attempted:number, skipped:number, sent:number, error:object|null}>}
 */
function persistReasoningRows(supabase, missionId, rows, opts = {}) {
  return persistRows(supabase, REASONING_TABLE, REASONING_CONFLICT_TARGET,
    'persistReasoningRows', missionId, rows, opts);
}

module.exports = {
  persistResponseRows,
  persistReasoningRows,
  loadPersistedResponseKeys,
  loadPersistedReasoningKeys,
  responseKey,
  RESPONSE_CONFLICT_TARGET,
  REASONING_CONFLICT_TARGET,
  RESPONSE_TABLE,
  REASONING_TABLE,
  INSERT_CHUNK,
};
