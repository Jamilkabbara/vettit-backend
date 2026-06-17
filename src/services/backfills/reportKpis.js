/*
 * Pass 50 B1 — backfill: populate insights.kpis + insights.recommendations
 * on completed missions that ran before the dedicated grounded generator
 * existed (the Phase-3 regression left these empty).
 *
 * Mirrors backfills/chartData.js: the core lives here so a CLI script (and,
 * if wanted, an admin endpoint) share ONE implementation. Values come from
 * the SAME deterministic floor the live generator uses (deterministicKpis /
 * deterministicRecommendations over the canonical report), so a backfilled
 * mission is grounded by construction — no LLM, no hallucination risk. New
 * missions already get the full (floor + LLM-enriched) generator via
 * runMission; this only lifts the pre-existing ones off an empty state.
 *
 * Idempotent. Re-running skips any mission that already has kpis.
 */

const logger = require('../../utils/logger');
const { buildCanonicalReport } = require('../report/buildReport');
const { deterministicKpis, deterministicRecommendations } = require('../ai/reportSummaries');

/** Pure compute: grounded KPIs + recommendations from a mission + responses. */
function computeReportKpis(mission, responses) {
  const clean = (responses || []).filter(
    (r) => r && !r.screened_out && !((r.persona_profile || {}).screened_out));
  const report = buildCanonicalReport(mission, mission.analysis || null, clean.length ? clean : (responses || []));
  return {
    kpis: deterministicKpis(report),
    recommendations: deterministicRecommendations(report),
  };
}

/**
 * Process a single mission: fetch responses, compute, persist (merging into
 * existing insights so executive_summary / per-question insights are kept).
 * Returns true if kpis were written, false if skipped.
 */
async function backfillOne(supabase, mission) {
  const hasKpis = Array.isArray(mission.insights?.kpis) && mission.insights.kpis.length > 0;
  const existingRecs = Array.isArray(mission.insights?.recommendations)
    ? mission.insights.recommendations.filter((r) => typeof r === 'string' && r.trim()) : [];

  const { data: responses, error } = await supabase
    .from('mission_responses')
    .select('question_id, answer, persona_profile, screened_out')
    .eq('mission_id', mission.id);
  if (error) {
    logger.warn('[backfill:report-kpis] fetch responses failed', { missionId: mission.id, err: error.message });
    return false;
  }
  if (!responses || responses.length === 0) return false;

  const { kpis, recommendations } = computeReportKpis(mission, responses);

  const patch = {};
  // KPIs: fill ONLY when missing — never overwrite an existing good set.
  if (!hasKpis && Array.isArray(kpis) && kpis.length > 0) patch.kpis = kpis;
  // Recommendations: restore a fuller grounded set ONLY when the stored set is
  // thinner than the computed floor — never shrink a richer (e.g. LLM) set.
  // Repairs the earlier regression where a 1-line floor clobbered richer recs.
  if (Array.isArray(recommendations) && recommendations.length > existingRecs.length) patch.recommendations = recommendations;

  if (Object.keys(patch).length === 0) return false; // nothing to repair
  const newInsights = { ...(mission.insights || {}), ...patch };
  const { error: updErr } = await supabase.from('missions').update({ insights: newInsights }).eq('id', mission.id);
  if (updErr) {
    logger.warn('[backfill:report-kpis] update failed', { missionId: mission.id, err: updErr.message });
    return false;
  }
  return true;
}

/**
 * Backfill every completed mission missing kpis.
 * @returns {{candidates:number, processed:number, succeeded:number}}
 */
async function runReportKpisBackfill(supabase, opts = {}) {
  const { limit = null, onProgress = null } = opts;
  let q = supabase
    .from('missions')
    .select('id, analysis, insights, goal_type, questions, targeting, target_audience, qualified_respondent_count, completed_at, title, brief')
    .eq('status', 'completed')
    .order('created_at', { ascending: false });
  if (limit) q = q.limit(limit);
  const { data: missions, error } = await q;
  if (error) {
    logger.error('[backfill:report-kpis] fetch missions failed', { err: error.message });
    return { candidates: 0, processed: 0, succeeded: 0 };
  }
  const needs = (missions || []).filter((m) => {
    if (!m.insights) return false;
    const hasKpis = Array.isArray(m.insights.kpis) && m.insights.kpis.length > 0;
    const recs = Array.isArray(m.insights.recommendations)
      ? m.insights.recommendations.filter((r) => typeof r === 'string' && r.trim()) : [];
    return !hasKpis || recs.length < 3; // missing KPIs OR thin recs (clobber repair)
  });
  let processed = 0;
  let succeeded = 0;
  for (const m of needs) {
    processed += 1;
    try {
      if (await backfillOne(supabase, m)) succeeded += 1;
    } catch (e) {
      logger.warn('[backfill:report-kpis] mission errored', { missionId: m.id, err: e.message });
    }
    if (onProgress) onProgress(processed, needs.length);
  }
  logger.info('[backfill:report-kpis] complete', { candidates: needs.length, processed, succeeded });
  return { candidates: needs.length, processed, succeeded };
}

module.exports = { computeReportKpis, backfillOne, runReportKpisBackfill };
