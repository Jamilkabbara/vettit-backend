#!/usr/bin/env node
/**
 * scripts/backfillAllInsights.js
 *
 * Re-runs synthesizeInsights for completed missions whose analysis is missing
 * or stamped with an analysis_error. The persona simulation step is expensive
 * and already done; only the synthesis layer needs a redo.
 *
 * Targets missions where:
 *   - status = 'completed'
 *   - executive_summary is null/empty OR mission_assets.analysis_error is set
 *
 * Usage:
 *   node scripts/backfillAllInsights.js          # DRY RUN — lists candidates
 *   EXECUTE=1 node scripts/backfillAllInsights.js  # actually re-synthesize + write
 *
 * Optional env:
 *   BATCH_DELAY_MS=2000  — delay between missions (default: 2000ms)
 *   LIMIT=10             — max missions to process (default: unlimited)
 */

require('dotenv').config();

const { createClient } = require('@supabase/supabase-js');
const { synthesizeInsights } = require('../src/services/ai/insights');

if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
  console.error('❌ SUPABASE_URL and SUPABASE_SERVICE_KEY must be set.');
  process.exit(1);
}

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY,
);

const EXECUTE = process.env.EXECUTE === '1';
const DELAY   = parseInt(process.env.BATCH_DELAY_MS || '2000', 10);
const LIMIT   = parseInt(process.env.LIMIT || '0', 10);

function needsBackfill(mission) {
  const summary = (mission.executive_summary || '').trim();
  const hasAnalysisError = Boolean(mission.mission_assets?.analysis_error);
  // "Real prose" threshold: anything under 40 chars is almost certainly missing/stub.
  return !summary || summary.length < 40 || hasAnalysisError;
}

(async () => {
  console.log('');
  console.log('═══════════════════════════════════════════════════════════');
  console.log('  VETT — Backfill Mission Insights');
  console.log(`  Mode: ${EXECUTE ? 'EXECUTE (will write)' : 'DRY RUN (no writes)'}`);
  console.log(`  Delay between missions: ${DELAY}ms`);
  if (LIMIT > 0) console.log(`  Limit: ${LIMIT} missions`);
  console.log('═══════════════════════════════════════════════════════════');
  console.log('');

  // Survey-style missions only — creative_attention follows a different pipeline.
  let query = supabase
    .from('missions')
    .select('id, user_id, title, brief, goal_type, respondent_count, questions, executive_summary, mission_assets')
    .eq('status', 'completed')
    .neq('goal_type', 'creative_attention')
    .order('completed_at', { ascending: false });

  if (LIMIT > 0) query = query.limit(LIMIT * 4); // overfetch — we filter client-side

  const { data: allMissions, error } = await query;
  if (error) {
    console.error('❌ Supabase query failed:', error.message);
    process.exit(1);
  }

  const candidates = (allMissions || []).filter(needsBackfill);
  const targets = LIMIT > 0 ? candidates.slice(0, LIMIT) : candidates;

  if (targets.length === 0) {
    console.log('✅ No completed missions need insights backfill.');
    return;
  }

  console.log(`Found ${targets.length} mission(s) needing reanalysis:\n`);
  for (const m of targets) {
    const reason = m.mission_assets?.analysis_error
      ? `analysis_error: ${(m.mission_assets.analysis_error.message || '').slice(0, 60)}`
      : `summary len=${(m.executive_summary || '').length}`;
    console.log(`  • ${m.id.slice(0, 8)} — "${(m.title || '').slice(0, 50)}" — ${reason}`);
  }
  console.log('');

  if (!EXECUTE) {
    console.log('DRY RUN — no writes. Re-run with EXECUTE=1 to actually backfill.');
    return;
  }

  let succeeded = 0;
  let failed    = 0;

  for (const mission of targets) {
    process.stdout.write(`  Processing ${mission.id.slice(0, 8)} — "${(mission.title || '').slice(0, 50)}"… `);

    try {
      const { data: responses, error: rErr } = await supabase
        .from('mission_responses')
        .select('persona_id, persona_profile, question_id, answer, screened_out')
        .eq('mission_id', mission.id);

      if (rErr) throw rErr;
      if (!responses || responses.length === 0) {
        console.log('✗ — no responses found');
        failed++;
        continue;
      }

      const insights = await synthesizeInsights(mission, responses);

      const cleanedAssets = { ...(mission.mission_assets || {}) };
      delete cleanedAssets.analysis_error;

      const { error: uErr } = await supabase
        .from('missions')
        .update({
          executive_summary: insights?.executive_summary || null,
          insights:          insights || null,
          mission_assets:    cleanedAssets,
        })
        .eq('id', mission.id);

      if (uErr) throw uErr;

      const len = (insights?.executive_summary || '').length;
      console.log(`✓ (summary ${len} chars)`);
      succeeded++;
    } catch (err) {
      console.log(`✗ — ${err.message}`);
      failed++;
    }

    if (DELAY > 0) await new Promise(r => setTimeout(r, DELAY));
  }

  console.log('');
  console.log(`═══════════════════════════════════════════════════════════`);
  console.log(`  Done: ${succeeded} succeeded, ${failed} failed`);
  console.log(`═══════════════════════════════════════════════════════════`);
})();
