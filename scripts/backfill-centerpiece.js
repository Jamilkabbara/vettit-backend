#!/usr/bin/env node
/*
 * Fix-forward #2 §B2 — recompute missions.analysis (canonical centerpiece data)
 * for completed missions, so type heroes show real numbers (not nulls) on
 * existing missions. Deterministic (no Anthropic key). Thin wrapper over
 * src/services/backfills/centerpiece.js.
 *
 * Usage:
 *   node scripts/backfill-centerpiece.js --dry-run   # count completed, no writes
 *   node scripts/backfill-centerpiece.js             # recompute + persist
 *   node scripts/backfill-centerpiece.js --limit=5
 * Reports per-goal-type populated counts.
 */

require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const { runCenterpieceBackfill } = require('../src/services/backfills/centerpiece');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY;
if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY / SUPABASE_SERVICE_KEY env vars');
  process.exit(1);
}
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const limitArg = args.find((a) => a.startsWith('--limit='));
const limit = limitArg ? parseInt(limitArg.split('=')[1], 10) : null;

async function main() {
  console.log(`[backfill-centerpiece] starting (dryRun=${dryRun}, limit=${limit ?? 'all'})`);
  if (dryRun) {
    let q = supabase.from('missions').select('id, goal_type').eq('status', 'completed');
    if (limit) q = q.limit(limit);
    const { data, error } = await q;
    if (error) { console.error('fetch failed', error.message); process.exit(1); }
    const byType = {};
    (data || []).forEach((m) => { byType[m.goal_type || 'unknown'] = (byType[m.goal_type || 'unknown'] || 0) + 1; });
    console.log(`[backfill-centerpiece] DRY: ${(data || []).length} completed missions by type:`, byType);
    return;
  }
  const result = await runCenterpieceBackfill(supabase, {
    limit,
    onProgress: (done, total) => { if (done % 10 === 0 || done === total) console.log(`[backfill-centerpiece] ${done}/${total}`); },
  });
  console.log(`[backfill-centerpiece] complete: ${result.succeeded}/${result.processed} recomputed`);
  console.log('[backfill-centerpiece] per goal_type:', JSON.stringify(result.byType, null, 2));
}

main().catch((err) => { console.error('backfill-centerpiece crashed', err); process.exit(1); });
