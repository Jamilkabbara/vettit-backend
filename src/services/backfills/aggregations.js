/*
 * Pass 45 T1c — aggregated_by_question backfill core.
 *
 * Same split as the Pass 43 chartData backfill: this module is called
 * by BOTH the CLI script (scripts/backfill-aggregations.js) and the
 * admin endpoint (POST /api/admin/backfill/aggregations).
 *
 * For every completed mission where aggregated_by_question IS NULL,
 * recompute the per-question map from mission_responses using the
 * same aggregate() the synthesis pipeline uses, and persist it.
 *
 * Idempotent — re-running skips rows that already have the column
 * populated.
 *
 * NOTE on screened_out: the live pipeline aggregates the responses it
 * delivered. For backfill we take rows with screened_out=false; when a
 * mission has ZERO clean rows (e.g. the 430dc203 legacy data where
 * always-deliver marked everything screened_out) we fall back to ALL
 * rows — a populated map from flagged-but-delivered responses beats an
 * empty results page.
 */

const logger = require('../../utils/logger');
const { aggregate } = require('../ai/insights');
const fetchAllResponses = require('../../db/fetchAllResponses');

async function backfillOne(supabase, mission) {
  let { data: responses, error } = await fetchAllResponses(supabase, {
    missionId: mission.id,
    columns: 'question_id, answer, persona_id',
    eq: { screened_out: false },
    label: 'backfill:aggregations',
  });
  if (error) {
    logger.warn('aggregations backfill: responses fetch failed', {
      missionId: mission.id, err: error.message,
    });
    return false;
  }
  if (!responses || responses.length === 0) {
    // Fallback: legacy rows where always-deliver flagged everything.
    const all = await fetchAllResponses(supabase, {
      missionId: mission.id,
      columns: 'question_id, answer, persona_id',
      label: 'backfill:aggregations:legacy-fallback',
    });
    if (all.error || !all.data || all.data.length === 0) {
      logger.info('aggregations backfill: no responses at all; skipping', {
        missionId: mission.id,
      });
      return false;
    }
    responses = all.data;
  }

  let agg;
  try {
    agg = aggregate(responses, mission.questions || []);
  } catch (err) {
    logger.warn('aggregations backfill: aggregate() failed', {
      missionId: mission.id, err: err.message,
    });
    return false;
  }
  if (!agg || Object.keys(agg).length === 0) {
    logger.info('aggregations backfill: empty aggregation; skipping', {
      missionId: mission.id,
    });
    return false;
  }

  const { error: updErr } = await supabase
    .from('missions')
    .update({ aggregated_by_question: agg })
    .eq('id', mission.id);
  if (updErr) {
    logger.warn('aggregations backfill: update failed', {
      missionId: mission.id, err: updErr.message,
    });
    return false;
  }
  return true;
}

/**
 * @param {object} supabase  service-role client
 * @param {object} [opts]
 * @param {number} [opts.limit]
 * @param {function} [opts.onProgress]  (done, total) => void
 * @returns {Promise<{candidates: number, processed: number, succeeded: number}>}
 */
async function runAggregationsBackfill(supabase, opts = {}) {
  const { limit = null, onProgress = null } = opts;

  let q = supabase
    .from('missions')
    .select('id, questions, aggregated_by_question')
    .eq('status', 'completed');
  if (limit) q = q.limit(limit);
  const { data: missions, error } = await q;
  if (error) throw new Error(`aggregations backfill: missions fetch failed: ${error.message}`);

  const candidates = (missions || []).filter((m) => {
    const a = m.aggregated_by_question;
    return !a || typeof a !== 'object' || Object.keys(a).length === 0;
  });

  let processed = 0;
  let succeeded = 0;
  for (const m of candidates) {
    processed += 1;
    const ok = await backfillOne(supabase, m);
    if (ok) succeeded += 1;
    if (onProgress && processed % 5 === 0) onProgress(processed, candidates.length);
  }

  logger.info('aggregations backfill complete', {
    candidates: candidates.length, processed, succeeded,
  });
  return { candidates: candidates.length, processed, succeeded };
}

module.exports = { runAggregationsBackfill };
