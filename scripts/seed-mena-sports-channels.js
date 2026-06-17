#!/usr/bin/env node
/*
 * WO §2.2 — seed the two MENA sports broadcasters the brand-lift channel
 * catalog (channels_master) is missing: SSC (Saudi Sports Company) and
 * beIN Sports. Everything else on the owner-confirmed list (all MBC variants,
 * Al Arabiya, Dubai/Abu Dhabi TV, Rotana, Al Jazeera, Shahid, TOD, OSN+,
 * StarzPlay, Netflix, Prime Video, and the social set) already exists.
 *
 * Idempotent: skips any channel already present (matched by display_name).
 * Field-scoped: only INSERTS new rows into channels_master; never updates or
 * deletes existing channels.
 *
 * Usage:
 *   node scripts/seed-mena-sports-channels.js --dry-run   # report, no writes
 *   node scripts/seed-mena-sports-channels.js             # insert missing
 */

require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY;
if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY / SUPABASE_SERVICE_KEY');
  process.exit(1);
}
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
const dryRun = process.argv.slice(2).includes('--dry-run');

// markets:['MENA'] + is_mena_specific mirrors the existing MENA TV rows
// (e.g. "MBC 1"). display_order placed just after the MBC block.
const CHANNELS = [
  { id: 'ssc', display_name: 'SSC (Saudi Sports)', category: 'tv', markets: ['MENA'], is_global: false, is_mena_specific: true, display_order: 95 },
  { id: 'bein_sports', display_name: 'beIN Sports', category: 'tv', markets: ['MENA'], is_global: false, is_mena_specific: true, display_order: 96 },
];

async function main() {
  console.log(`[seed-mena-sports] starting (dryRun=${dryRun})`);
  const { data: existing, error } = await supabase
    .from('channels_master').select('id, display_name');
  if (error) { console.error('fetch failed', error.message); process.exit(1); }
  const norm = (s) => String(s).toLowerCase().replace(/[^a-z0-9]/g, '');
  const have = new Set((existing || []).flatMap((c) => [norm(c.id), norm(c.display_name)]));

  const toInsert = CHANNELS.filter((c) => !have.has(norm(c.id)) && !have.has(norm(c.display_name)));
  if (toInsert.length === 0) {
    console.log('[seed-mena-sports] nothing to do — both channels already present.');
    return;
  }
  console.log(`[seed-mena-sports] ${toInsert.length} to insert: ${toInsert.map((c) => c.display_name).join(', ')}`);
  if (dryRun) { console.log('[seed-mena-sports] DRY RUN — no writes.'); return; }

  const { error: insErr } = await supabase.from('channels_master').insert(toInsert);
  if (insErr) { console.error('insert failed', insErr.message); process.exit(1); }
  console.log(`[seed-mena-sports] inserted ${toInsert.length} channel(s).`);
}

main().catch((err) => { console.error('seed-mena-sports crashed', err); process.exit(1); });
