#!/usr/bin/env node
/**
 * scripts/backfillTargetingBriefs.js
 *
 * Generates targeting briefs for completed missions that don't have one yet.
 * Run this once after deploying the targeting_brief feature.
 *
 * Usage:
 *   node scripts/backfillTargetingBriefs.js
 *
 * Optional env:
 *   BATCH_DELAY_MS=2000  — delay between missions (default: 2000ms)
 *   LIMIT=10             — max missions to process in one run (default: unlimited)
 */

require('dotenv').config();

const { createClient } = require('@supabase/supabase-js');
const { generateTargetingBrief } = require('../src/services/ai/targetingBrief');

if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
  console.error('❌ SUPABASE_URL and SUPABASE_SERVICE_KEY must be set.');
  process.exit(1);
}

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY,
);

const DELAY  = parseInt(process.env.BATCH_DELAY_MS || '2000', 10);
const LIMIT  = parseInt(process.env.LIMIT || '0', 10); // 0 = unlimited

(async () => {
  console.log('');
  console.log('═══════════════════════════════════════════════════════════');
  console.log('  VETT — Backfill Targeting Briefs');
  console.log(`  Delay between missions: ${DELAY}ms`);
  if (LIMIT > 0) console.log(`  Limit: ${LIMIT} missions`);
  console.log('═══════════════════════════════════════════════════════════');
  console.log('');

  // ── Fetch missions needing a brief ──────────────────────────────────────

  let query = supabase
    .from('missions')
    .select('id, user_id, title, brief, goal_type, respondent_count, ai_insights')
    .eq('status', 'completed')
    .is('targeting_brief', null)
    .order('completed_at', { ascending: false });

  if (LIMIT > 0) query = query.limit(LIMIT);

  const { data: missions, error } = await query;

  if (error) {
    console.error('❌ Supabase query failed:', error.message);
    process.exit(1);
  }

  if (!missions || missions.length === 0) {
    console.log('✅ All completed missions already have a targeting brief. Nothing to do.');
    return;
  }

  console.log(`Found ${missions.length} completed mission(s) without a targeting brief.\n`);

  let succeeded = 0;
  let failed    = 0;

  for (const mission of missions) {
    process.stdout.write(`  Processing ${mission.id.slice(0, 8)} — "${(mission.title || '').slice(0, 50)}"… `);

    try {
      // Fetch response persona profiles
      const { data: responses } = await supabase
        .from('mission_responses')
        .select('persona_profile')
        .eq('mission_id', mission.id);

      const brief = await generateTargetingBrief({
        mission,
        responses: responses || [],
        insights:  mission.ai_insights,
      });

      await supabase
        .from('missions')
        .update({ targeting_brief: brief })
        .eq('id', mission.id);

      console.log('✓');
      succeeded++;
    } catch (err) {
      console.log(`✗ — ${err.message}`);
      failed++;
    }

    // Rate-limit to avoid hammering the AI API
    if (DELAY > 0) await new Promise(r => setTimeout(r, DELAY));
  }

  console.log('');
  console.log(`═══════════════════════════════════════════════════════════`);
  console.log(`  Done: ${succeeded} succeeded, ${failed} failed`);
  console.log(`═══════════════════════════════════════════════════════════`);
})();
