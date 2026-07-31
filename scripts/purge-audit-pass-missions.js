#!/usr/bin/env node
/*
 * purge-audit-pass-missions.js
 * -----------------------------------------------------------------------------
 * Owner-run teardown for the [AUDIT-PASS] live-e2e test missions. These are the
 * throwaway missions the audit runner (scripts/test-run-all-types.js) inserts,
 * each titled "[AUDIT-PASS] <goal> ...". This script sweeps them out of prod
 * along with every child row that would otherwise block or dangle.
 *
 * DRY RUN IS THE DEFAULT. It prints the exact COUNT it would delete plus a
 * sample (ids + titles) and writes NOTHING. Deleting requires BOTH the
 * --execute flag AND a typed confirmation (interactive), so it cannot happen by
 * accident. The owner runs --execute themselves; the build agent never does.
 *
 *   node scripts/purge-audit-pass-missions.js              # DRY RUN (safe, default)
 *   node scripts/purge-audit-pass-missions.js --execute    # DELETE (prompts for typed confirm)
 *   node scripts/purge-audit-pass-missions.js --execute --force   # DELETE, skip prompt (scripted)
 *
 * MARKER (verified against prod): missions whose title starts with the literal
 * "[AUDIT-PASS]". In Postgres ILIKE only % and _ are wildcards -- the brackets
 * are literal -- so '[AUDIT-PASS]%' is a prefix-anchored match and cannot catch
 * a real customer mission unless its title literally begins with "[AUDIT-PASS]".
 *
 * FK MAP (verified against prod information_schema for missions.id):
 *   mission_responses          -> ON DELETE CASCADE   (auto, ~21k rows)
 *   persona_response_reasoning -> ON DELETE CASCADE   (auto)
 *   admin_alerts               -> ON DELETE SET NULL  (auto-nulled)
 *   funnel_events              -> ON DELETE SET NULL  (auto-nulled)
 *   payment_errors             -> ON DELETE SET NULL  (auto-nulled)
 *   support_tickets            -> ON DELETE SET NULL  (auto-nulled)
 *   ai_calls                   -> ON DELETE NO ACTION (BLOCKS delete -- must clear first)
 *   chat_sessions              -> ON DELETE NO ACTION (BLOCKS delete -- must clear first)
 * The two NO ACTION children are why a naive "delete the mission" fails: audit
 * missions accrue thousands of ai_calls rows, and that FK would reject the
 * delete. This script deletes ai_calls + chat_sessions for the target missions
 * first, then the missions (CASCADE handles responses + reasoning).
 *
 * Env (.env): SUPABASE_URL + SUPABASE_SERVICE_KEY (server-side service key --
 * never a client/anon key).
 */
require('dotenv').config();
const readline = require('readline');
const { createClient } = require('@supabase/supabase-js');

// Single source of truth for the selection marker. Both the dry-run preview and
// the --execute delete route through selectTargets() so the filter can never
// drift between "what it says it will do" and "what it does".
const TITLE_MARKER = '[AUDIT-PASS]%';

// Safety ceiling. The audit runner creates ~13-40 missions per pass; a real
// backlog is dozens, not hundreds. If the match set ever exceeds this, or the
// match set is the ENTIRE missions table, something is wrong with the marker --
// abort rather than risk a mass delete of real data.
const MAX_EXPECTED = 300;

const APPLY = process.argv.includes('--execute');
const FORCE = process.argv.includes('--force');

function chunk(arr, n) {
  const out = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

async function selectTargets(db) {
  // The ONE query that defines the target set. Everything downstream uses this.
  const { data, error } = await db
    .from('missions')
    .select('id,title,status,goal_type,created_at,user_id')
    .ilike('title', TITLE_MARKER)
    .order('created_at', { ascending: false });
  if (error) throw new Error(`missions select failed: ${error.message}`);
  const rows = data || [];
  // Defense in depth: assert every returned row really does start with the
  // literal marker before we ever consider deleting it.
  const bad = rows.filter((m) => !String(m.title || '').startsWith('[AUDIT-PASS]'));
  if (bad.length) {
    throw new Error(`ABORT: ${bad.length} selected row(s) do not start with "[AUDIT-PASS]" -- marker mismatch, refusing to proceed.`);
  }
  return rows;
}

async function countChildren(db, ids) {
  const counts = { ai_calls: 0, chat_sessions: 0, mission_responses: 0 };
  for (const table of Object.keys(counts)) {
    let total = 0;
    for (const ids2 of chunk(ids, 100)) {
      const { count, error } = await db
        .from(table)
        .select('id', { count: 'exact', head: true })
        .in('mission_id', ids2);
      if (error) throw new Error(`${table} count failed: ${error.message}`);
      total += count || 0;
    }
    counts[table] = total;
  }
  return counts;
}

function confirmTyped(expectedPhrase) {
  return new Promise((resolve) => {
    if (FORCE) return resolve(true);
    if (!process.stdin.isTTY) {
      console.log('\nRefusing to delete: not an interactive terminal and --force not given.');
      return resolve(false);
    }
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(`\nType exactly  ${expectedPhrase}  to proceed (anything else aborts): `, (answer) => {
      rl.close();
      resolve(answer.trim() === expectedPhrase);
    });
  });
}

(async () => {
  const url = process.env.SUPABASE_URL;
  const service = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !service) throw new Error('Need SUPABASE_URL + SUPABASE_SERVICE_KEY in .env');
  const db = createClient(url, service, { auth: { persistSession: false } });

  console.log(`\nMODE: ${APPLY ? 'EXECUTE (deletes rows)' : 'DRY RUN (no writes)'}`);
  console.log(`MARKER: missions.title ILIKE '${TITLE_MARKER}'\n`);

  const targets = await selectTargets(db);
  const ids = targets.map((m) => m.id);

  // Anti-over-match guard.
  const { count: totalMissions, error: tErr } = await db
    .from('missions')
    .select('id', { count: 'exact', head: true });
  if (tErr) throw new Error(`total missions count failed: ${tErr.message}`);

  console.log(`Matched ${targets.length} of ${totalMissions} total missions.`);
  if (targets.length === 0) {
    console.log('Nothing matches the marker. Exiting cleanly.');
    process.exit(0);
  }
  if (targets.length === totalMissions) {
    throw new Error(`ABORT: marker matched EVERY mission (${targets.length}/${totalMissions}). That is not right -- refusing to delete.`);
  }
  if (targets.length > MAX_EXPECTED) {
    throw new Error(`ABORT: matched ${targets.length} missions, above the ${MAX_EXPECTED} safety ceiling. Re-verify the marker before proceeding.`);
  }

  const children = await countChildren(db, ids);
  console.log(`Child rows that go with them:`);
  console.log(`  mission_responses (CASCADE) : ${children.mission_responses}`);
  console.log(`  ai_calls (delete first)     : ${children.ai_calls}`);
  console.log(`  chat_sessions (delete first): ${children.chat_sessions}`);

  const sample = targets.slice(0, 20);
  console.log(`\nSample (up to 20 of ${targets.length}):`);
  for (const m of sample) {
    console.log(`  ${m.id.slice(0, 8)}  ${m.status.padEnd(10)}  ${m.title}`);
  }
  if (targets.length > sample.length) console.log(`  ... and ${targets.length - sample.length} more`);

  if (!APPLY) {
    console.log(`\nDRY RUN -- ${targets.length} mission(s) + ${children.mission_responses} responses + ${children.ai_calls} ai_calls would be removed. Nothing was written.`);
    console.log('Re-run with --execute (owner only) to delete.');
    process.exit(0);
  }

  // ---- EXECUTE path ----
  const phrase = `DELETE ${targets.length} AUDIT-PASS`;
  const ok = await confirmTyped(phrase);
  if (!ok) {
    console.log('\nAborted -- no rows deleted.');
    process.exit(1);
  }

  console.log('\nDeleting...');
  // 1) Clear the NO ACTION children that would otherwise block the mission delete.
  for (const ids2 of chunk(ids, 100)) {
    const { error: e1 } = await db.from('ai_calls').delete().in('mission_id', ids2);
    if (e1) throw new Error(`ai_calls delete failed: ${e1.message}`);
    const { error: e2 } = await db.from('chat_sessions').delete().in('mission_id', ids2);
    if (e2) throw new Error(`chat_sessions delete failed: ${e2.message}`);
  }
  // 2) Delete the missions. CASCADE removes mission_responses + persona_response_reasoning;
  //    SET NULL children (admin_alerts, funnel_events, payment_errors, support_tickets) auto-null.
  let deleted = 0;
  for (const ids2 of chunk(ids, 100)) {
    const { error: e3, count } = await db
      .from('missions')
      .delete({ count: 'exact' })
      .in('id', ids2);
    if (e3) throw new Error(`missions delete failed: ${e3.message}`);
    deleted += count || ids2.length;
  }

  // 3) Verify nothing matching the marker remains.
  const remaining = await selectTargets(db);
  console.log(`\nDELETED ${deleted} mission(s) + their responses/ai_calls/chat_sessions.`);
  console.log(`Post-delete marker check: ${remaining.length} [AUDIT-PASS] mission(s) remain (expected 0).`);
  process.exit(remaining.length === 0 ? 0 : 2);
})().catch((e) => { console.error('ERROR', e.message); process.exit(1); });
