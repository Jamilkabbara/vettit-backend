#!/usr/bin/env node
/**
 * scripts/backfillQualificationCounts.js
 *
 * Pass 21 Bug 5 backfill — populates the missions columns
 *   total_simulated_count
 *   qualified_respondent_count
 *   qualification_rate
 *
 * for every completed mission where they're currently NULL. The values are
 * recomputed from mission_responses (the source of truth) using the same
 * rule that runMission.js now applies on completion: a persona is qualified
 * iff zero of their answers carry screened_out=true (column or persona_profile
 * fallback).
 *
 * Usage:
 *   node scripts/backfillQualificationCounts.js                # DRY RUN
 *   EXECUTE=1 node scripts/backfillQualificationCounts.js      # write
 *
 * Optional env:
 *   FORCE=1   — recompute even when columns are already non-NULL
 *   LIMIT=N   — cap missions processed (default: unlimited)
 */

require('dotenv').config();

const { createClient } = require('@supabase/supabase-js');

if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
  console.error('❌ SUPABASE_URL and SUPABASE_SERVICE_KEY must be set.');
  process.exit(1);
}

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY,
);

const EXECUTE = process.env.EXECUTE === '1';
const FORCE   = process.env.FORCE === '1';
const LIMIT   = parseInt(process.env.LIMIT || '0', 10);

function needsBackfill(m) {
  if (FORCE) return true;
  return m.total_simulated_count == null
      || m.qualified_respondent_count == null
      || m.qualification_rate == null;
}

(async () => {
  console.log('');
  console.log('═══════════════════════════════════════════════════════════');
  console.log('  VETT — Backfill Mission Qualification Counts (Pass 21 Bug 5)');
  console.log(`  Mode: ${EXECUTE ? 'EXECUTE (will write)' : 'DRY RUN (no writes)'}`);
  if (FORCE) console.log('  Force: recomputing even already-populated rows');
  if (LIMIT > 0) console.log(`  Limit: ${LIMIT} missions`);
  console.log('═══════════════════════════════════════════════════════════');
  console.log('');

  let query = supabase
    .from('missions')
    .select('id, brief, status, total_simulated_count, qualified_respondent_count, qualification_rate')
    .eq('status', 'completed')
    .order('completed_at', { ascending: false });
  if (LIMIT > 0) query = query.limit(LIMIT);

  const { data: missions, error } = await query;
  if (error) {
    console.error('❌ Failed to load missions:', error);
    process.exit(1);
  }

  const candidates = (missions || []).filter(needsBackfill);
  console.log(`  Total completed missions: ${(missions || []).length}`);
  console.log(`  Needing backfill:         ${candidates.length}`);
  console.log('');

  let touched = 0;
  for (const m of candidates) {
    // Pull all mission_responses for this mission, retrieving both the column
    // and the persona_profile fallback so the rule matches runMission.js.
    const { data: responses, error: respErr } = await supabase
      .from('mission_responses')
      .select('persona_id, persona_profile, screened_out')
      .eq('mission_id', m.id);
    if (respErr) {
      console.error(`  [skip] ${m.id} — failed to load responses:`, respErr.message);
      continue;
    }

    const allPersonaIds       = new Set();
    const screenedOutPersonas = new Set();
    for (const r of responses || []) {
      if (!r.persona_id) continue;
      allPersonaIds.add(r.persona_id);
      const screened = r.screened_out === true
        || Boolean((r.persona_profile || {}).screened_out);
      if (screened) screenedOutPersonas.add(r.persona_id);
    }

    const totalSimulated      = allPersonaIds.size;
    const qualifiedRespondent = Math.max(0, totalSimulated - screenedOutPersonas.size);
    const qualificationRate   = totalSimulated > 0
      ? Number((qualifiedRespondent / totalSimulated).toFixed(4))
      : null;

    const briefSnippet = (m.brief || '(no brief)').slice(0, 60);
    console.log(`  ${m.id}  ${totalSimulated}/${qualifiedRespondent}  rate=${qualificationRate}  — ${briefSnippet}`);

    if (EXECUTE) {
      const { error: updErr } = await supabase
        .from('missions')
        .update({
          total_simulated_count:      totalSimulated,
          qualified_respondent_count: qualifiedRespondent,
          qualification_rate:         qualificationRate,
        })
        .eq('id', m.id);
      if (updErr) {
        console.error(`    ❌ update failed: ${updErr.message}`);
      } else {
        touched++;
      }
    }
  }

  console.log('');
  console.log(`  Done. ${EXECUTE ? `Updated ${touched} rows.` : 'DRY RUN — no writes.'}`);
  console.log('');
})().catch(err => {
  console.error('❌ Fatal:', err);
  process.exit(1);
});
