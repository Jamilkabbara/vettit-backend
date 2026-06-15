/*
 * Pass 50 P2-1 — backfill: cluster open-end themes onto completed missions that
 * ran before theme clustering existed (so their text questions render a visual,
 * not a verbatims punt). New missions auto-cluster via runMission; this lifts
 * the old ones.
 *
 * Mirrors backfills/reportKpis.js: core here (shareable by a CLI / admin
 * endpoint), thin wrapper in scripts/. Idempotent — skips any mission that
 * already has insights.open_end_themes. Requires a live Anthropic key (the
 * clustering is an LLM call); a mission whose clustering fails is left rendering
 * verbatims (never a partial/empty write).
 */

const logger = require('../../utils/logger');
const { buildCanonicalReport } = require('../report/buildReport');
const { clusterOpenEndThemes } = require('../ai/openEndThemes');

/** Process one mission: cluster each text question's verbatims, persist. */
async function backfillOne(supabase, mission) {
  if (mission.insights && mission.insights.open_end_themes
      && Object.keys(mission.insights.open_end_themes).length) return false; // idempotent

  const { data: responses, error } = await supabase
    .from('mission_responses')
    .select('question_id, answer, persona_profile, screened_out')
    .eq('mission_id', mission.id);
  if (error || !responses || !responses.length) return false;

  const clean = responses.filter(
    (r) => r && !r.screened_out && !((r.persona_profile || {}).screened_out));
  const report = buildCanonicalReport(mission, mission.analysis || null, clean.length ? clean : responses);

  const open_end_themes = {};
  for (const q of report.survey || []) {
    if (q.renderer !== 'open_text_verbatims') continue;
    const verbatims = q.data && Array.isArray(q.data.verbatims) ? q.data.verbatims : [];
    if (verbatims.length < 3) continue;
    try {
      const r = await clusterOpenEndThemes({ id: q.id, text: q.text }, verbatims, { missionId: mission.id });
      if (r && Array.isArray(r.themes) && r.themes.length) open_end_themes[q.id] = r;
    } catch (e) {
      logger.warn('[backfill:open-end-themes] cluster failed', { missionId: mission.id, qid: q.id, err: e.message });
    }
  }
  if (!Object.keys(open_end_themes).length) return false;

  const newInsights = { ...(mission.insights || {}), open_end_themes };
  const { error: updErr } = await supabase.from('missions').update({ insights: newInsights }).eq('id', mission.id);
  if (updErr) {
    logger.warn('[backfill:open-end-themes] update failed', { missionId: mission.id, err: updErr.message });
    return false;
  }
  return true;
}

/**
 * Backfill every completed mission that has a text question but no themes yet.
 * @returns {{candidates:number, processed:number, succeeded:number}}
 */
async function runOpenEndThemesBackfill(supabase, opts = {}) {
  const { limit = null, onProgress = null } = opts;
  let q = supabase
    .from('missions')
    .select('id, analysis, insights, goal_type, questions, completed_at, title, brief, qualified_respondent_count')
    .eq('status', 'completed')
    .order('created_at', { ascending: false });
  if (limit) q = q.limit(limit);
  const { data: missions, error } = await q;
  if (error) {
    logger.error('[backfill:open-end-themes] fetch missions failed', { err: error.message });
    return { candidates: 0, processed: 0, succeeded: 0 };
  }
  // Candidate = has a text question + no themes cached.
  const needs = (missions || []).filter((m) => {
    const hasText = Array.isArray(m.questions) && m.questions.some((x) => x && (x.type === 'text' || x.type === 'open'));
    const hasThemes = m.insights && m.insights.open_end_themes && Object.keys(m.insights.open_end_themes).length;
    return hasText && !hasThemes;
  });
  let processed = 0; let succeeded = 0;
  for (const m of needs) {
    processed += 1;
    try { if (await backfillOne(supabase, m)) succeeded += 1; } catch (e) {
      logger.warn('[backfill:open-end-themes] mission errored', { missionId: m.id, err: e.message });
    }
    if (onProgress) onProgress(processed, needs.length);
  }
  logger.info('[backfill:open-end-themes] complete', { candidates: needs.length, processed, succeeded });
  return { candidates: needs.length, processed, succeeded };
}

module.exports = { backfillOne, runOpenEndThemesBackfill };
