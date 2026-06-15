#!/usr/bin/env node
/*
 * Pass 50 P2-1 — one-time backfill: cluster open-end themes onto completed
 * missions that ran before theme clustering existed, so their text questions
 * render a visual (theme bars) instead of a verbatims punt. Thin wrapper over
 * src/services/backfills/openEndThemes.js.
 *
 * Requires a LIVE Anthropic key (clustering is an LLM call) and the Supabase
 * service key. Idempotent — skips any mission that already has themes; a
 * mission whose clustering fails is left rendering verbatims (no empty write).
 *
 * Usage:
 *   node scripts/backfill-open-end-themes.js --dry-run   # count candidates, no LLM/writes
 *   node scripts/backfill-open-end-themes.js             # cluster + write
 *   node scripts/backfill-open-end-themes.js --limit=3   # cap scope (cost control)
 */

require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const { runOpenEndThemesBackfill } = require('../src/services/backfills/openEndThemes');

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
  console.log(`[backfill-open-end-themes] starting (dryRun=${dryRun}, limit=${limit ?? 'all'})`);
  if (dryRun) {
    let q = supabase.from('missions').select('id, insights, questions').eq('status', 'completed');
    if (limit) q = q.limit(limit);
    const { data, error } = await q;
    if (error) { console.error('fetch failed', error.message); process.exit(1); }
    const candidates = (data || []).filter((m) => {
      const hasText = Array.isArray(m.questions) && m.questions.some((x) => x && (x.type === 'text' || x.type === 'open'));
      const hasThemes = m.insights && m.insights.open_end_themes && Object.keys(m.insights.open_end_themes).length;
      return hasText && !hasThemes;
    });
    console.log(`[backfill-open-end-themes] DRY: ${candidates.length} candidates (text question, no themes yet)`);
    return;
  }
  const result = await runOpenEndThemesBackfill(supabase, {
    limit,
    onProgress: (done, total) => console.log(`[backfill-open-end-themes] ${done}/${total} processed`),
  });
  console.log(`[backfill-open-end-themes] complete: ${result.succeeded}/${result.processed} written (${result.candidates} candidates)`);
}

main().catch((err) => { console.error('backfill-open-end-themes crashed', err); process.exit(1); });
