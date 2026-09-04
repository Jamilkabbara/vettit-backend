#!/usr/bin/env node
/**
 * P0-3 — purge test/seed data from production.
 *
 *   node scripts/purge-test-seed-data.js                      # DRY RUN
 *   node scripts/purge-test-seed-data.js --apply              # delete the SAFE seed
 *   node scripts/purge-test-seed-data.js --apply --delete-test-missions
 *                                                             # also delete the
 *                                                             # [UN-GATE TEST] missions
 *
 * SAFE seed (deleted on --apply — unambiguous demo/seed rows, no real users):
 *   - crm_leads: demo+pmf@vettit.ai, demo+pricing@vettit.ai
 *   - support_tickets: the "System test ..." seed ticket
 *
 * REPORTED ONLY (never auto-deleted — needed data or destructive; you decide):
 *   - [UN-GATE TEST] missions: these are your un-gate VERIFICATION runs
 *     (aaabc834 is the clean n=80 mission for the D1-D9 visual pass). Delete
 *     them ONLY after un-gating, with --delete-test-missions.
 *   - test users ("Test one", "d d") and the DUPLICATE "Jamil Kabbara"
 *     (non-admin) account: deleting an auth user cascades to their missions +
 *     payments; the Jamil duplicate holds a real $9 mission. Handle by hand.
 *
 * Env (.env): SUPABASE_URL, SUPABASE_SERVICE_KEY[,_ROLE_KEY].
 */
require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

const APPLY = process.argv.includes('--apply');
const DELETE_TEST_MISSIONS = process.argv.includes('--delete-test-missions');
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'kabbarajamil@gmail.com';

// ── [UN-GATE TEST] mission selection (ported from purge-audit-pass-missions.js) ──
// Single source of truth for the mission marker: BOTH the dry-run listing and
// the --apply delete route through selectTestMissions() so the filter can never
// drift between "what it says it will do" and "what it does".
// In Postgres ILIKE only % and _ are wildcards — the brackets are literal — so
// '[UN-GATE TEST]%' is a prefix-anchored match.
const MISSION_MARKER = '[UN-GATE TEST]%';

// Safety ceiling. Un-gate verification runs number in the single digits; if the
// match set ever exceeds this, something is wrong with the marker — abort
// rather than risk a mass delete of real missions.
const MAX_EXPECTED_MISSIONS = 25;

async function selectTestMissions(db) {
  const { data, error } = await db.from('missions').select('id,title,status')
    .ilike('title', MISSION_MARKER)
    .order('created_at', { ascending: false });
  if (error) throw new Error(`missions select failed: ${error.message}`);
  const rows = data || [];
  // Defense in depth: every selected row must literally start with the marker.
  const bad = rows.filter((m) => !String(m.title || '').startsWith('[UN-GATE TEST]'));
  if (bad.length) {
    throw new Error(`ABORT: ${bad.length} selected mission(s) do not start with "[UN-GATE TEST]" — marker mismatch, refusing to proceed.`);
  }
  if (rows.length > MAX_EXPECTED_MISSIONS) {
    throw new Error(`ABORT: matched ${rows.length} missions, above the ${MAX_EXPECTED_MISSIONS} safety ceiling. Re-verify the marker before proceeding.`);
  }
  return rows;
}

(async () => {
  const url = process.env.SUPABASE_URL;
  const service = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !service) throw new Error('Need SUPABASE_URL + SUPABASE_SERVICE_KEY in .env');
  const db = createClient(url, service, { auth: { persistSession: false } });

  console.log(`\nMODE: ${APPLY ? 'APPLY' : 'DRY RUN (no writes)'}${DELETE_TEST_MISSIONS ? ' + delete-test-missions' : ''}\n`);

  // ── SAFE SEED 1: demo CRM leads ──────────────────────────────────────────
  const { data: leads } = await db.from('crm_leads').select('id,email,name')
    .or('email.eq.demo+pmf@vettit.ai,email.eq.demo+pricing@vettit.ai');
  console.log(`Demo CRM leads (${(leads || []).length}):`);
  for (const l of (leads || [])) {
    if (APPLY) { const { error } = await db.from('crm_leads').delete().eq('id', l.id);
      console.log(`  ${error ? 'ERROR ' + error.message : 'DELETED'}  ${l.email} (${l.name || ''})`); }
    else console.log(`  WOULD DELETE  ${l.email} (${l.name || ''})`);
  }

  // ── SAFE SEED 2: System-test support ticket ──────────────────────────────
  const { data: tickets } = await db.from('support_tickets').select('id,subject,status')
    .ilike('subject', 'System test%');
  console.log(`\nSeed support tickets (${(tickets || []).length}):`);
  for (const t of (tickets || [])) {
    if (APPLY) { const { error } = await db.from('support_tickets').delete().eq('id', t.id);
      console.log(`  ${error ? 'ERROR ' + error.message : 'DELETED'}  "${t.subject}"`); }
    else console.log(`  WOULD DELETE  "${t.subject}"`);
  }

  // ── REPORT / OPTIONAL: [UN-GATE TEST] missions ───────────────────────────
  // Dry-run and --apply share the SAME selection (selectTestMissions) — no drift.
  const missions = await selectTestMissions(db);
  console.log(`\n[UN-GATE TEST] missions (${missions.length}) — un-gate verification data:`);
  for (const m of missions) {
    if (DELETE_TEST_MISSIONS && APPLY) {
      // FK map for missions.id (verified against prod, see purge-audit-pass-missions.js):
      //   ai_calls / chat_sessions -> ON DELETE NO ACTION (BLOCK the delete — clear first)
      //   mission_responses        -> ON DELETE CASCADE   (auto)
      const { error: eAi } = await db.from('ai_calls').delete().eq('mission_id', m.id);
      if (eAi) { console.log(`  ERROR ai_calls delete ${m.id.slice(0, 8)}: ${eAi.message} — skipping mission`); continue; }
      const { error: eChat } = await db.from('chat_sessions').delete().eq('mission_id', m.id);
      if (eChat) { console.log(`  ERROR chat_sessions delete ${m.id.slice(0, 8)}: ${eChat.message} — skipping mission`); continue; }
      const { error } = await db.from('missions').delete().eq('id', m.id);
      console.log(`  ${error ? 'ERROR (FK? handle by hand) ' + error.message : 'DELETED'}  ${m.id.slice(0, 8)} "${m.title}"`);
    } else {
      console.log(`  KEEP (needed until un-gate) ${m.id.slice(0, 8)} "${m.title}" ${m.status}`);
    }
  }
  if ((missions || []).length && !DELETE_TEST_MISSIONS) {
    console.log('  -> run with --delete-test-missions AFTER un-gating to remove these.');
  }

  // ── REPORT ONLY: test users + duplicate Jamil ────────────────────────────
  const { data: profiles } = await db.from('profiles')
    .select('id,first_name,last_name,full_name,is_admin,created_at')
    .or('full_name.ilike.%test%,full_name.eq.d d,full_name.ilike.Jamil%');
  const suspects = (profiles || []).filter((p) => {
    const name = (p.full_name || `${p.first_name || ''} ${p.last_name || ''}`).trim();
    if (/^(test|d d)\b/i.test(name)) return true;
    if (/jamil/i.test(name) && !p.is_admin) return true; // duplicate, non-admin
    return false;
  });
  console.log(`\nTest users / duplicate account (${suspects.length}) — REPORT ONLY (deleting a user cascades to missions + payments; do this by hand in Supabase Auth):`);
  for (const p of suspects) {
    const name = (p.full_name || `${p.first_name || ''} ${p.last_name || ''}`).trim();
    const { count } = await db.from('missions').select('id', { count: 'exact', head: true }).eq('user_id', p.id);
    console.log(`  ${p.id}  "${name}"  admin=${p.is_admin}  missions=${count || 0}  created=${p.created_at ? p.created_at.slice(0, 10) : '?'}`);
  }
  console.log(`  (the admin ${ADMIN_EMAIL} account is the real owner — keep it.)`);

  console.log(`\n${APPLY ? 'APPLIED (safe seed).' : 'DRY RUN complete — re-run with --apply.'}`);
  process.exit(0);
})().catch((e) => { console.error('ERROR', e.message); process.exit(1); });
