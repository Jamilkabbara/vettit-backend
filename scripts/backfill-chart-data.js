#!/usr/bin/env node
/*
 * Pass 42 B3 — one-time backfill: populate insights.chart_data on
 * every completed mission that doesn't already have it.
 *
 * Idempotent. Re-running is safe; rows with chart_data already
 * populated are skipped.
 *
 * Usage:
 *   node scripts/backfill-chart-data.js [--limit=N] [--dry-run]
 *
 * Strategy:
 *   1. Page through missions where status IN ('completed') AND
 *      insights->>'chart_data' IS NULL.
 *   2. For each: call the internal compute path directly (same logic
 *      as routes/missions.js GET /:id/chart_data). Avoids HTTP loop.
 *   3. Persist chart_data back via supabase.update().
 *   4. Log progress every 10 missions.
 *
 * Notes:
 *   - Reads SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY from env (matches
 *     the runtime backend config).
 *   - No HTTP server boot required; this is a one-shot script.
 */

require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const logger = require('../src/utils/logger');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY env vars');
  process.exit(1);
}
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const limitArg = args.find((a) => a.startsWith('--limit='));
const limit = limitArg ? parseInt(limitArg.split('=')[1], 10) : null;

// Pure-function port of the compute path from routes/missions.js so
// this script doesn't need to spin up Express.
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
      const counts = new Map();
      for (const a of answers) {
        const values = Array.isArray(a) ? a : [a];
        for (const v of values) {
          if (v == null) continue;
          counts.set(String(v), (counts.get(String(v)) || 0) + 1);
        }
      }
      const options = Array.from(counts.keys());
      const countsArr = options.map((o) => counts.get(o));
      const total = countsArr.reduce((s, c) => s + c, 0);
      const percentages = total > 0
        ? countsArr.map((c) => Math.round((c / total) * 1000) / 10)
        : countsArr.map(() => 0);
      per_question_distributions.push({
        question_id: qid,
        question: q.text || q.question || qid,
        type: q.type === 'multi' || q.type === 'multi_select' ? 'multi_select' : 'single_choice',
        options,
        counts: countsArr,
        percentages,
      });
      continue;
    }

    if (q.type === 'rating' || q.type === 'scale') {
      const buckets = {};
      const numeric = [];
      for (const a of answers) {
        const n = Number(a);
        if (!Number.isFinite(n)) continue;
        numeric.push(n);
        buckets[String(n)] = (buckets[String(n)] || 0) + 1;
      }
      if (numeric.length === 0) continue;
      const sum = numeric.reduce((s, n) => s + n, 0);
      const mean = Math.round((sum / numeric.length) * 100) / 100;
      const sorted = [...numeric].sort((a, b) => a - b);
      const median = sorted.length % 2 === 0
        ? (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2
        : sorted[Math.floor(sorted.length / 2)];
      const scale_max = q.scale_max || q.max || Math.max(...numeric, 5);
      per_question_distributions.push({
        question_id: qid,
        question: q.text || q.question || qid,
        type: 'rating',
        scale_max,
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

async function processOne(mission) {
  const { data: responses, error } = await supabase
    .from('mission_responses')
    .select('question_id, answer, persona_profile')
    .eq('mission_id', mission.id)
    .eq('screened_out', false);
  if (error) {
    console.error(`[${mission.id}] fetch responses failed`, error.message);
    return false;
  }
  if (!responses || responses.length === 0) {
    console.log(`[${mission.id}] no responses; skipping`);
    return false;
  }
  const chart_data = computeChartData(mission, responses);
  if (chart_data.per_question_distributions.length === 0) {
    console.log(`[${mission.id}] no chartable questions; skipping`);
    return false;
  }
  if (dryRun) {
    console.log(`[${mission.id}] DRY: would set chart_data with ${chart_data.per_question_distributions.length} distributions`);
    return true;
  }
  const newInsights = { ...(mission.insights || {}), chart_data };
  const { error: updateErr } = await supabase
    .from('missions')
    .update({ insights: newInsights })
    .eq('id', mission.id);
  if (updateErr) {
    console.error(`[${mission.id}] update failed`, updateErr.message);
    return false;
  }
  return true;
}

async function main() {
  console.log(`[backfill-chart-data] starting (dryRun=${dryRun}, limit=${limit ?? 'all'})`);

  // Pull all completed missions without chart_data. Supabase doesn't expose
  // `insights->>'chart_data' IS NULL` filter directly via PostgREST without
  // some-feature flags, so we fetch the candidates and check in JS.
  let query = supabase
    .from('missions')
    .select('id, questions, insights')
    .eq('status', 'completed');
  if (limit) query = query.limit(limit);

  const { data: missions, error } = await query;
  if (error) {
    console.error('fetch missions failed', error.message);
    process.exit(1);
  }

  const needsBackfill = missions.filter((m) => {
    const cd = m.insights?.chart_data;
    return !cd || typeof cd !== 'object' || Object.keys(cd).length === 0;
  });

  console.log(`[backfill-chart-data] ${missions.length} completed total; ${needsBackfill.length} need backfill`);

  let processed = 0;
  let succeeded = 0;
  for (const m of needsBackfill) {
    processed += 1;
    const ok = await processOne(m);
    if (ok) succeeded += 1;
    if (processed % 10 === 0) {
      console.log(`[backfill-chart-data] ${processed}/${needsBackfill.length} processed (${succeeded} written)`);
    }
  }

  console.log(`[backfill-chart-data] complete: ${succeeded}/${processed} written`);
  if (logger?.info) logger.info('chart_data backfill complete', { processed, succeeded });
}

main().catch((err) => {
  console.error('backfill-chart-data crashed', err);
  process.exit(1);
});
