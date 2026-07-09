#!/usr/bin/env node
/*
 * Teardown for the [AUDIT-PASS] live e2e runner — sweep every audit mission
 * (and its responses) out of production in one pass, so prod is clean after the
 * un-gate audit. Same dry-run/apply + FK-safe pattern as P0-3
 * (scripts/purge-test-seed-data.js); self-contained so it does not depend on
 * that still-held PR. When P0-3 merges, fold this same "[AUDIT-PASS]%" title
 * match into it and retire this file.
 *
 *   node scripts/purge-audit-pass.js            # DRY RUN — list what would go
 *   node scripts/purge-audit-pass.js --apply    # delete [AUDIT-PASS] missions + responses
 *
 * Matches ONLY missions whose title starts with "[AUDIT-PASS]" — the exact
 * prefix the runner writes. Real customer missions are never touched.
 *
 * Env (.env): SUPABASE_URL, SUPABASE_SERVICE_KEY[,_ROLE_KEY].
 */
require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

const APPLY = process.argv.includes('--apply');

(async () => {
  const url = process.env.SUPABASE_URL;
  const service = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !service) throw new Error('Need SUPABASE_URL + SUPABASE_SERVICE_KEY in .env');
  const db = createClient(url, service, { auth: { persistSession: false } });

  console.log(`\nMODE: ${APPLY ? 'APPLY (deletes)' : 'DRY RUN (no writes)'}\n`);

  const { data: missions, error } = await db.from('missions')
    .select('id,title,status,user_id')
    .ilike('title', '[AUDIT-PASS]%');
  if (error) throw new Error(`missions query failed: ${error.message}`);

  console.log(`[AUDIT-PASS] missions (${(missions || []).length}):`);
  let deleted = 0; let respTotal = 0;
  for (const m of (missions || [])) {
    const { count: rc } = await db.from('mission_responses').select('id', { count: 'exact', head: true }).eq('mission_id', m.id);
    respTotal += rc || 0;
    if (APPLY) {
      // Children first to avoid FK errors, then the mission.
      await db.from('mission_responses').delete().eq('mission_id', m.id);
      const { error: delErr } = await db.from('missions').delete().eq('id', m.id);
      if (delErr) console.log(`  ERROR (handle by hand) ${m.id.slice(0, 8)} "${m.title}": ${delErr.message}`);
      else { deleted += 1; console.log(`  DELETED  ${m.id.slice(0, 8)} "${m.title}" (${rc || 0} responses)`); }
    } else {
      console.log(`  WOULD DELETE  ${m.id.slice(0, 8)} "${m.title}" ${m.status} (${rc || 0} responses)`);
    }
  }

  console.log(`\n${APPLY ? `APPLIED — deleted ${deleted} mission(s) + their responses (${respTotal} response rows swept).` : `DRY RUN — ${(missions || []).length} mission(s) / ${respTotal} response rows would be removed. Re-run with --apply.`}`);
  process.exit(0);
})().catch((e) => { console.error('ERROR', e.message); process.exit(1); });
