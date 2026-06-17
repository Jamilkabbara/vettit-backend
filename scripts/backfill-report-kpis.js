#!/usr/bin/env node
/*
 * Pass 50 B1 — one-time backfill: populate insights.kpis +
 * insights.recommendations on completed missions that ran before the
 * dedicated grounded generator existed (the Phase-3 regression left them
 * empty). Thin wrapper over src/services/backfills/reportKpis.js.
 *
 * Values are the deterministic, grounded floor (no LLM) — identical to what
 * the live generator falls back to — so the write is fully predictable. New
 * missions already auto-populate via runMission; this lifts the old ones.
 *
 * Idempotent. Re-running skips any mission that already has kpis. Missions
 * with no derivable headline metric are left untouched (no empty write).
 *
 * Usage:
 *   node scripts/backfill-report-kpis.js --dry-run     # count, no writes
 *   node scripts/backfill-report-kpis.js               # write
 *   node scripts/backfill-report-kpis.js --limit=5     # cap scope
 */

require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const { runReportKpisBackfill } = require('../src/services/backfills/reportKpis');

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
  console.log(`[backfill-report-kpis] starting (dryRun=${dryRun}, limit=${limit ?? 'all'})`);
  // Both paths go through runReportKpisBackfill so --dry-run reports the EXACT
  // candidate set the real run will write (an earlier inline dry filter omitted
  // the thin-recs repair clause and under-counted 17 → 1).
  const result = await runReportKpisBackfill(supabase, {
    limit,
    dryRun,
    onProgress: dryRun ? null : (done, total) => console.log(`[backfill-report-kpis] ${done}/${total} processed`),
  });
  if (dryRun) {
    console.log(`[backfill-report-kpis] DRY: ${result.candidates} candidates would be processed:`);
    for (const c of result.candidateDetail || []) {
      console.log(`  - ${c.id} [${c.goal_type}] recs=${c.recs} kpis=${c.kpis}`);
    }
    return;
  }
  console.log(`[backfill-report-kpis] complete: ${result.succeeded}/${result.processed} written (${result.candidates} candidates)`);
}

main().catch((err) => {
  console.error('backfill-report-kpis crashed', err);
  process.exit(1);
});
