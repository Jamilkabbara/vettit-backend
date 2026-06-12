#!/usr/bin/env node
/*
 * Pass 45 T1c — CLI wrapper for the aggregated_by_question backfill.
 * Core logic in src/services/backfills/aggregations.js (shared with
 * POST /api/admin/backfill/aggregations).
 *
 * Usage: node scripts/backfill-aggregations.js [--limit=N]
 */
require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const { runAggregationsBackfill } = require('../src/services/backfills/aggregations');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY;
if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY/SUPABASE_SERVICE_KEY env vars');
  process.exit(1);
}
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

const limitArg = process.argv.slice(2).find((a) => a.startsWith('--limit='));
const limit = limitArg ? parseInt(limitArg.split('=')[1], 10) : null;

runAggregationsBackfill(supabase, {
  limit,
  onProgress: (done, total) => console.log(`[backfill-aggregations] ${done}/${total}`),
}).then((r) => {
  console.log(`[backfill-aggregations] complete: ${r.succeeded}/${r.processed} written (${r.candidates} candidates)`);
}).catch((err) => {
  console.error('backfill-aggregations crashed', err);
  process.exit(1);
});
