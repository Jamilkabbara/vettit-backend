/*
 * Pass 43 T3a — chart_data backfill core.
 *
 * Extracted from scripts/backfill-chart-data.js so both the CLI script
 * AND the admin endpoint (POST /api/admin/backfill/chart-data) call the
 * same logic. The script becomes a thin wrapper; the endpoint runs this
 * async after responding 202.
 *
 * Computes insights.chart_data from mission_responses for any completed
 * mission that doesn't already have it. Idempotent — re-running skips
 * rows that already have chart_data.
 */

const logger = require('../../utils/logger');
const { detectScale, scaleNum } = require('../report/buildReport');

/**
 * Pure compute: distributions + segments from raw responses.
 * Mirrors the on-demand path in routes/missions.js GET /:id/chart_data.
 */
function computeChartData(mission, responses) {
  const questions = Array.isArray(mission.questions) ? mission.questions : [];
  const qById = new Map(questions.map((q) => [q.id, q]));
  const byQuestion = new Map();
  for (const r of responses) {
    if (!byQuestion.has(r.question_id)) byQuestion.set(r.question_id, []);
    byQuestion.get(r.question_id).push(r.answer);
  }

  const per_question_distributions = [];
  for (const [qid, answers] of byQuestion.entries()) {
    const q = qById.get(qid);
    if (!q) continue;

    if (q.type === 'single' || q.type === 'multi' || q.type === 'multi_select' || q.type === 'single_choice') {
      const isMulti = q.type === 'multi' || q.type === 'multi_select';
      const counts = new Map();
      let nRespondents = 0;
      for (const a of answers) {
        const values = (Array.isArray(a) ? a : [a]).filter((v) => v != null && v !== '');
        if (values.length) nRespondents += 1;
        for (const v of values) counts.set(String(v), (counts.get(String(v)) || 0) + 1);
      }
      const options = Array.from(counts.keys());
      const countsArr = options.map((o) => counts.get(o));
      // Pass 49 — multi-select % must be over RESPONDENTS (a person can pick
      // several), matching the canonical MultiDist. Was count/total-selections,
      // which disagreed with "The full survey" on the same page.
      const denom = isMulti ? nRespondents : (countsArr.reduce((s, c) => s + c, 0) || nRespondents);
      const percentages = denom > 0
        ? countsArr.map((c) => Math.round((c / denom) * 1000) / 10)
        : countsArr.map(() => 0);
      per_question_distributions.push({
        question_id: qid,
        question: q.text || q.question || qid,
        type: isMulti ? 'multi_select' : 'single_choice',
        options,
        counts: countsArr,
        percentages,
        n_respondents: nRespondents,
      });
      continue;
    }

    if (q.type === 'rating' || q.type === 'scale') {
      // Pass 49 — reuse the canonical scale detection so cached chart_data
      // shares ONE source of truth with the report + exports. Was: scale_max
      // defaulted to 5 (truncating 1-7 / 0-10) and buckets held only observed
      // values (no scale_min, no zero-count bars).
      const nums = answers.map((a) => scaleNum(a)).filter((v) => v !== null);
      if (nums.length === 0) continue;
      const scale = detectScale(q, nums);
      const buckets = {};
      for (let i = scale.min; i <= scale.max; i += 1) buckets[i] = 0;
      for (const v of nums) if (buckets[v] !== undefined) buckets[v] += 1;
      const sum = nums.reduce((s, n) => s + n, 0);
      const mean = Math.round((sum / nums.length) * 100) / 100;
      const sorted = [...nums].sort((a, b) => a - b);
      const median = sorted.length % 2 === 0
        ? (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2
        : sorted[Math.floor(sorted.length / 2)];
      per_question_distributions.push({
        question_id: qid,
        question: q.text || q.question || qid,
        type: 'rating',
        scale_min: scale.min,
        scale_max: scale.max,
        buckets,
        mean,
        median,
      });
    }
  }

  const personasByCountry = new Map();
  for (const r of responses) {
    const c = r.persona_profile?.country || r.persona_profile?.location;
    if (!c) continue;
    if (!personasByCountry.has(c)) personasByCountry.set(c, new Set());
    const pid = r.persona_profile?.persona_id;
    if (pid) personasByCountry.get(c).add(pid);
  }
  const segment_distributions = [];
  if (personasByCountry.size > 1) {
    for (const [country, ids] of personasByCountry.entries()) {
      segment_distributions.push({ segment_name: country, n: ids.size, key_metric_values: {} });
    }
  }

  return {
    per_question_distributions,
    ...(segment_distributions.length >= 2 ? { segment_distributions } : {}),
  };
}

/**
 * Process a single mission: fetch responses, compute, persist.
 * Returns true if chart_data was written, false if skipped.
 */
async function backfillOne(supabase, mission) {
  const { data: responses, error } = await supabase
    .from('mission_responses')
    .select('question_id, answer, persona_profile')
    .eq('mission_id', mission.id)
    .eq('screened_out', false);
  if (error) {
    logger.warn('[backfill:chart_data] fetch responses failed', { missionId: mission.id, err: error.message });
    return false;
  }
  if (!responses || responses.length === 0) return false;

  const chart_data = computeChartData(mission, responses);
  if (chart_data.per_question_distributions.length === 0) return false;

  const newInsights = { ...(mission.insights || {}), chart_data };
  const { error: updErr } = await supabase
    .from('missions')
    .update({ insights: newInsights })
    .eq('id', mission.id);
  if (updErr) {
    logger.warn('[backfill:chart_data] update failed', { missionId: mission.id, err: updErr.message });
    return false;
  }
  return true;
}

/**
 * Run the full backfill across all completed missions without chart_data.
 * Returns { processed, succeeded, candidates }.
 *
 * @param supabase service-role client
 * @param opts { limit?: number, onProgress?: (done, total) => void }
 */
async function runChartDataBackfill(supabase, opts = {}) {
  const { limit = null, onProgress = null } = opts;

  let query = supabase
    .from('missions')
    .select('id, questions, insights')
    .eq('status', 'completed');
  if (limit) query = query.limit(limit);

  const { data: missions, error } = await query;
  if (error) {
    logger.error('[backfill:chart_data] fetch missions failed', { err: error.message });
    throw error;
  }

  const needsBackfill = (missions || []).filter((m) => {
    const cd = m.insights?.chart_data;
    return !cd || typeof cd !== 'object' || Object.keys(cd).length === 0;
  });

  let processed = 0;
  let succeeded = 0;
  for (const m of needsBackfill) {
    processed += 1;
    const ok = await backfillOne(supabase, m);
    if (ok) succeeded += 1;
    if (onProgress && processed % 10 === 0) onProgress(processed, needsBackfill.length);
  }

  logger.info('[backfill:chart_data] complete', { candidates: needsBackfill.length, processed, succeeded });
  return { processed, succeeded, candidates: needsBackfill.length };
}

module.exports = { computeChartData, backfillOne, runChartDataBackfill };
