/*
 * Pass 46 Phase 3 — missions.analysis backfill core.
 *
 * Same split as the chartData/aggregations backfills: called by BOTH
 * the CLI (scripts/backfill-analysis.js) and the admin endpoint
 * (POST /api/admin/backfill/analysis).
 *
 * For every completed mission where analysis IS NULL, compute the
 * deterministic methodology analysis from mission_responses (clean
 * rows; ALL-rows fallback for legacy always-deliver data) and persist
 * it. Idempotent. Also the Phase 3 gate's validation vehicle: running
 * this against prod and hand-spot-checking the outputs proves the
 * modules against real data, not just fixtures.
 */

const logger = require('../../utils/logger');
const { computeAnalysis } = require('../analysis');
const fetchAllResponses = require('../../db/fetchAllResponses');

async function backfillOne(supabase, mission) {
  let { data: rows, error } = await fetchAllResponses(supabase, {
    missionId: mission.id,
    columns: 'persona_id, persona_profile, question_id, answer, exposure_status',
    eq: { screened_out: false },
    label: 'backfill:analysis',
  });
  if (error) {
    logger.warn('analysis backfill: responses fetch failed', {
      missionId: mission.id, err: error.message,
    });
    return false;
  }
  if (!rows || rows.length === 0) {
    const all = await fetchAllResponses(supabase, {
      missionId: mission.id,
      columns: 'persona_id, persona_profile, question_id, answer, exposure_status',
      label: 'backfill:analysis:legacy-fallback',
    });
    if (all.error || !all.data || all.data.length === 0) {
      logger.info('analysis backfill: no responses at all; skipping', {
        missionId: mission.id,
      });
      return false;
    }
    rows = all.data;
  }

  const analysis = computeAnalysis(mission, rows);
  if (!analysis) {
    logger.info('analysis backfill: computeAnalysis returned null; skipping', {
      missionId: mission.id,
    });
    return false;
  }

  const { error: updErr } = await supabase
    .from('missions')
    .update({ analysis })
    .eq('id', mission.id);
  if (updErr) {
    logger.warn('analysis backfill: update failed', {
      missionId: mission.id, err: updErr.message,
    });
    return false;
  }
  return true;
}

/**
 * @param {object} supabase  service-role client
 * @param {object} [opts]    { limit, onProgress }
 * @returns {Promise<{candidates: number, processed: number, succeeded: number}>}
 */
async function runAnalysisBackfill(supabase, opts = {}) {
  const { limit = null, onProgress = null } = opts;

  let q = supabase
    .from('missions')
    .select('*')
    .eq('status', 'completed');
  if (limit) q = q.limit(limit);
  const { data: missions, error } = await q;
  if (error) throw new Error(`analysis backfill: missions fetch failed: ${error.message}`);

  const candidates = (missions || []).filter((m) => !m.analysis);

  let processed = 0;
  let succeeded = 0;
  for (const m of candidates) {
    processed += 1;
    const ok = await backfillOne(supabase, m);
    if (ok) succeeded += 1;
    if (onProgress && processed % 5 === 0) onProgress(processed, candidates.length);
  }

  logger.info('analysis backfill complete', {
    candidates: candidates.length, processed, succeeded,
  });
  return { candidates: candidates.length, processed, succeeded };
}

module.exports = { runAnalysisBackfill };
