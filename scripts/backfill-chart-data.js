#!/usr/bin/env node
/*
 * Pass 42 B3 / Pass 43 T3a — one-time backfill: populate
 * insights.chart_data on every completed mission that doesn't have it.
 *
 * Pass 43 T3a refactored the core logic into
 * src/services/backfills/chartData.js so the admin endpoint
 * (POST /api/admin/backfill/chart-data) and this CLI share one
 * implementation. This script is now a thin wrapper.
 *
 * Idempotent. Re-running skips rows that already have chart_data.
 *
 * Usage:
 *   node scripts/backfill-chart-data.js [--limit=N] [--dry-run]
 */

require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const { runChartDataBackfill } = require('../src/services/backfills/chartData');

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

async function main() {
  console.log(`[backfill-chart-data] starting (dryRun=${dryRun}, limit=${limit ?? 'all'})`);
  if (dryRun) {
    // Dry-run: count candidates only, no writes.
    let q = supabase.from('missions').select('id, insights').eq('status', 'completed');
    if (limit) q = q.limit(limit);
    const { data, error } = await q;
    if (error) { console.error('fetch failed', error.message); process.exit(1); }
    const candidates = (data || []).filter((m) => {
      const cd = m.insights?.chart_data;
      return !cd || typeof cd !== 'object' || Object.keys(cd).length === 0;
    });
    console.log(`[backfill-chart-data] DRY: ${candidates.length} candidates would be processed`);
    return;
  }
  const result = await runChartDataBackfill(supabase, {
    limit,
    onProgress: (done, total) => console.log(`[backfill-chart-data] ${done}/${total} processed`),
  });
  console.log(`[backfill-chart-data] complete: ${result.succeeded}/${result.processed} written (${result.candidates} candidates)`);
}

main().catch((err) => {
  console.error('backfill-chart-data crashed', err);
  process.exit(1);
});
