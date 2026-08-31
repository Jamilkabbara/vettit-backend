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
const { buildCanonicalReport } = require('../report/buildReport');
const fetchAllResponses = require('../../db/fetchAllResponses');

/**
 * Pass 50 B3 — chart_data per-question distributions are now a PROJECTION of
 * the canonical report (buildCanonicalReport), not a second computation. This
 * collapses the long-standing fork: previously computeChartData re-derived
 * distributions with its own loop while the web "full survey" + exports read
 * the canonical report — two code paths that could (and did) drift. Now there
 * is ONE builder. The endpoint returns `_source: 'canonical'`.
 *
 * The projection maps each canonical survey question's already-correct `data`
 * into the chart_data shape the frontend charts consume:
 *   scale_*            → { type:'rating', scale_min, scale_max, buckets, mean }
 *   multi_select       → { type:'multi_select', options, counts, percentages, n_respondents }
 *   attribute_battery  → endorsement: multi_select bars (matrix: skipped — no single distribution)
 *   single/forced/paired/screener/kano → { type:'single_choice', ... }
 *
 * Free-text questions are NEVER charted: the canonical renderer can label a
 * "Why?" open-text as forced_choice, which would paint dozens of 1-count bars.
 * We gate on the ORIGINAL question type so that never reaches a chart. (Side
 * benefit: endorsement batteries like "rate X on each attribute", which the
 * old loop silently dropped because scaleNum() can't read an object answer,
 * now render correctly — identical coverage everywhere.)
 */
const TEXT_TYPES = new Set(['text', 'open', 'open_text', 'open_ended', 'textarea', 'freetext', 'free_text']);

function projectQuestion(sq, origType) {
  // Never chart free text (canonical may mis-render it as forced_choice bars).
  if (TEXT_TYPES.has(String(origType || '').toLowerCase())) return null;
  const r = sq.renderer || '';
  const d = sq.data || {};

  if (r.startsWith('scale_')) {
    const dist = d.distribution || {};
    const sm = Number(d.scale_min);
    const sx = Number(d.scale_max);
    const buckets = {};
    if (Number.isFinite(sm) && Number.isFinite(sx) && sx >= sm) {
      for (let i = sm; i <= sx; i += 1) buckets[i] = dist[i] != null ? dist[i] : (dist[String(i)] || 0);
    } else {
      for (const k of Object.keys(dist)) buckets[k] = dist[k];
    }
    if (Object.keys(buckets).length === 0) return null;
    return {
      question_id: sq.id,
      question: sq.text || sq.id,
      type: 'rating',
      scale_min: sm,
      scale_max: sx,
      buckets,
      // Match the old `mean` rounding (2dp) so the histogram label is unchanged.
      mean: d.average != null ? Math.round(Number(d.average) * 100) / 100 : null,
    };
  }

  if (r === 'multi_select' || (r === 'attribute_battery' && d.shape !== 'matrix')) {
    const dist = d.distribution || {};
    const options = Object.keys(dist);
    if (options.length === 0) return null;
    const counts = options.map((o) => dist[o]);
    const base = d.n_respondents || d.n || 0;
    return {
      question_id: sq.id,
      question: sq.text || sq.id,
      type: 'multi_select',
      options,
      counts,
      percentages: options.map((o) => (base > 0 ? Math.round((dist[o] / base) * 1000) / 10 : 0)),
      n_respondents: base,
    };
  }

  // matrix attribute battery / open_text_verbatims / max_diff → no single
  // distribution chart (the old loop didn't chart these either).
  if (r === 'attribute_battery' || r === 'open_text_verbatims' || r === 'max_diff') return null;

  // single_select / forced_choice / paired_comparison / screener / kano
  const dist = d.distribution || {};
  const options = Object.keys(dist);
  if (options.length === 0) return null;
  const counts = options.map((o) => dist[o]);
  const total = counts.reduce((s, c) => s + c, 0);
  return {
    question_id: sq.id,
    question: sq.text || sq.id,
    type: 'single_choice',
    options,
    counts,
    percentages: options.map((o) => (total > 0 ? Math.round((dist[o] / total) * 1000) / 10 : 0)),
    n_respondents: total,
  };
}

/**
 * Pure compute: distributions (projected from the canonical report) + country
 * segments from raw responses. The on-demand endpoint and the cache writer
 * both call this, so every chart_data surface shares one source of truth.
 */
function computeChartData(mission, responses) {
  const questions = Array.isArray(mission.questions) ? mission.questions : [];
  const qById = new Map(questions.map((q) => [q.id, q]));

  // ONE builder: the canonical report. analysis is only needed for the
  // centerpiece/headline, never for per-question distributions, so passing
  // null when a caller didn't load it is safe.
  const report = buildCanonicalReport(mission, mission.analysis || null, responses || []);
  const per_question_distributions = [];
  for (const sq of report.survey || []) {
    const orig = qById.get(sq.id);
    const proj = projectQuestion(sq, orig && orig.type);
    if (proj) per_question_distributions.push(proj);
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
  const { data: responses, error } = await fetchAllResponses(supabase, {
    missionId: mission.id,
    columns: 'question_id, answer, persona_profile',
    eq: { screened_out: false },
    label: 'backfill:chart_data',
  });
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
