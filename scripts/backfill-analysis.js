#!/usr/bin/env node
/*
 * Pass 46 Phase 3 — CLI wrapper for the missions.analysis backfill.
 * Usage: node scripts/backfill-analysis.js [--limit N]
 * Env: SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY (or SUPABASE_SERVICE_KEY).
 */
require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const { runAnalysisBackfill } = require('../src/services/backfills/analysis');

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY;
if (!url || !key) {
  console.error('SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY (or SUPABASE_SERVICE_KEY) required');
  process.exit(1);
}
const limitArg = process.argv.indexOf('--limit');
const limit = limitArg > -1 ? Number(process.argv[limitArg + 1]) : null;

const supabase = createClient(url, key, { auth: { persistSession: false } });
runAnalysisBackfill(supabase, {
  limit,
  onProgress: (done, total) => console.log(`[backfill-analysis] ${done}/${total}`),
}).then((r) => {
  console.log(`[backfill-analysis] complete: ${r.succeeded}/${r.processed} written (${r.candidates} candidates)`);
  process.exit(0);
}).catch((err) => {
  console.error('[backfill-analysis] failed:', err.message);
  process.exit(1);
});
