/*
 * Fix-forward #2 §B2 — recompute missions.analysis (the canonical "centerpiece"
 * data) for completed missions that were analysed before the current
 * methodology math existed, so their type heroes (web + PDF) show real numbers
 * instead of nulls/blanks. Pure deterministic aggregation from the stored
 * responses — NO Anthropic key (same class as the KPI backfill). Idempotent:
 * recomputing a current analysis yields the same object.
 */

const logger = require('../../utils/logger');
const { computeAnalysis } = require('../analysis');
const fetchAllResponses = require('../../db/fetchAllResponses');

/** Recompute + persist analysis for one mission. Returns true if written. */
async function backfillOne(supabase, mission) {
  const { data: responses, error } = await fetchAllResponses(supabase, {
    missionId: mission.id,
    columns: 'question_id, answer, persona_id, persona_profile, screened_out',
    label: 'backfill:centerpiece',
  });
  if (error || !responses || responses.length === 0) return false;

  // Mirror runMission: carry exposure_status on each row (brand_lift lift math);
  // 'not_applicable' for every other methodology.
  const rows = responses.map((r) => ({
    ...r,
    exposure_status: (r.persona_profile && r.persona_profile._exposure_status) || 'not_applicable',
  }));

  let analysis;
  try {
    analysis = computeAnalysis(mission, rows);
  } catch (e) {
    logger.warn('[backfill:centerpiece] computeAnalysis threw', { missionId: mission.id, err: e.message });
    return false;
  }
  if (!analysis || typeof analysis !== 'object') return false;

  const { error: updErr } = await supabase.from('missions').update({ analysis }).eq('id', mission.id);
  if (updErr) {
    logger.warn('[backfill:centerpiece] update failed', { missionId: mission.id, err: updErr.message });
    return false;
  }
  return true;
}

/**
 * Recompute analysis for every completed mission.
 * @returns {{candidates:number, processed:number, succeeded:number, byType:object}}
 */
async function runCenterpieceBackfill(supabase, opts = {}) {
  const { limit = null, onProgress = null } = opts;
  let q = supabase.from('missions').select('*').eq('status', 'completed').order('created_at', { ascending: false });
  if (limit) q = q.limit(limit);
  const { data: missions, error } = await q;
  if (error) {
    logger.error('[backfill:centerpiece] fetch missions failed', { err: error.message });
    return { candidates: 0, processed: 0, succeeded: 0, byType: {} };
  }
  const byType = {};
  let processed = 0;
  let succeeded = 0;
  for (const m of (missions || [])) {
    processed += 1;
    let ok = false;
    try { ok = await backfillOne(supabase, m); } catch (e) {
      logger.warn('[backfill:centerpiece] mission errored', { missionId: m.id, err: e.message });
    }
    if (ok) { succeeded += 1; byType[m.goal_type || 'unknown'] = (byType[m.goal_type || 'unknown'] || 0) + 1; }
    if (onProgress) onProgress(processed, (missions || []).length);
  }
  logger.info('[backfill:centerpiece] complete', { processed, succeeded, byType });
  return { candidates: (missions || []).length, processed, succeeded, byType };
}

module.exports = { backfillOne, runCenterpieceBackfill };
