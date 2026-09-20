#!/usr/bin/env node
/**
 * Re-run a delivered study on the current code, keeping the original.
 *
 * Why this exists: studies delivered between 2026-06-12 and 2026-09-19 were
 * built from panels that repeated the same person (see
 * scripts/audit-panel-distinctness.js). Re-running is the remedy - there are no
 * re-run credits and the policy is re-delivery, not money back.
 *
 * What it does NOT do: lose the original. Before anything is deleted, the
 * mission row, every response and its per-persona reasoning are written to a
 * JSON file on the machine running the script. The run aborts if that file
 * cannot be written and read back. Deleting is unavoidable: the responses table
 * has no run column, and the incremental writer de-duplicates by
 * (persona_id, question_id), so old rows would block new ones under the same
 * persona ids rather than sit beside them.
 *
 * The payment is untouched and is what lets the run proceed: the payment gate
 * prices the study as it will run and compares it to what Stripe captured, so a
 * re-run of a study the customer paid for passes on the original payment.
 *
 * Dry run by default; --run does it. Both share plan() so the preview cannot
 * drift from what executes.
 *
 *   railway run node scripts/rerun-mission.js <missionId>
 *   railway run node scripts/rerun-mission.js <missionId> --run --archive ~/vett-archives
 */
'use strict';

require('dotenv').config();
const fs = require('fs');
const os = require('os');
const path = require('path');
const supabase = require('../src/db/supabase');
const fetchAllResponses = require('../src/db/fetchAllResponses');
const { measurePanel } = require('../src/services/ai/panelDistinctness');

const argv = process.argv.slice(2);
const missionId = argv.find((a) => !a.startsWith('--'));
const DO_RUN = argv.includes('--run');
const archiveDirArg = (() => {
  const i = argv.indexOf('--archive');
  return i >= 0 ? argv[i + 1] : null;
})();
const ARCHIVE_DIR = (archiveDirArg || path.join(os.homedir(), 'vett-archives')).replace(/^~(?=$|\/)/, os.homedir());

if (!missionId) {
  console.error('usage: rerun-mission.js <missionId> [--run] [--archive <dir>]');
  process.exit(2);
}

/** The state a re-run needs. Written by the real run, printed by the dry run. */
const RESET_PATCH = {
  status: 'paid',
  completed_at: null,
  failure_reason: null,
  recruitment_status: null,
  recruited_persona_count: 0,
  recruitment_completed_at: null,
  ai_spend_usd_actual: 0,
  executive_summary: null,
  insights: null,
  analysis: null,
  aggregated_by_question: null,
  brand_lift_kpis: null,
};

/** One selection, used by the preview and the execution. */
async function plan(id) {
  const { data: mission, error } = await supabase.from('missions').select('*').eq('id', id).single();
  if (error || !mission) throw new Error(`mission not found: ${id}`);
  const { data: rows, error: rErr } = await fetchAllResponses(supabase, {
    missionId: id,
    columns: 'id, persona_id, persona_profile, question_id, answer, screened_out, exposure_status',
    label: 'rerun-mission:archive',
  });
  if (rErr) throw rErr;
  const { data: reasoning } = await supabase
    .from('persona_response_reasoning').select('*').eq('mission_id', id);
  const qualified = (rows || []).filter((r) => !r.screened_out);
  const personas = new Map(); const answers = {};
  for (const r of qualified) {
    if (!personas.has(r.persona_id)) personas.set(r.persona_id, { ...(r.persona_profile || {}), id: r.persona_id });
    (answers[r.persona_id] = answers[r.persona_id] || {})[r.question_id] = r.answer;
  }
  return {
    mission,
    rows: rows || [],
    reasoning: reasoning || [],
    before: measurePanel([...personas.values()], { answersByPersona: answers }),
    archivePath: path.join(ARCHIVE_DIR, `${id}-original-${new Date().toISOString().slice(0, 10)}.json`),
  };
}

(async () => {
  const p = await plan(missionId);
  const m = p.mission;

  console.log(`\nMission ${m.id}`);
  console.log(`  title:          ${m.title}`);
  console.log(`  owner:          ${m.user_id}`);
  console.log(`  status:         ${m.status}   paid: ${m.paid_amount_cents} cents   refunded: ${m.refunded_amount_cents || 0} cents`);
  console.log(`  respondents:    ${m.respondent_count} (target qualified ${m.target_qualified_count || m.respondent_count})`);
  console.log(`  spend ceiling:  $${m.ai_spend_ceiling_usd}   spent so far: $${m.ai_spend_usd_actual}`);
  console.log(`\nPanel as delivered: ${p.before.distinct} of ${p.before.n} respondents are different people`);
  console.log(`  most common first name: ${p.before.topName} x${p.before.topNameCount}`);
  for (const r of p.before.reasons) console.log(`  FAILS: ${r}`);

  console.log('\nStatements this will run:');
  console.log(`  1. write ${p.rows.length} responses + ${p.reasoning.length} reasoning rows + the mission row to`);
  console.log(`     ${p.archivePath}`);
  console.log(`  2. DELETE FROM persona_response_reasoning WHERE mission_id = '${m.id}';   -- ${p.reasoning.length} rows`);
  console.log(`  3. DELETE FROM mission_responses WHERE mission_id = '${m.id}';            -- ${p.rows.length} rows`);
  console.log(`  4. UPDATE missions SET ${Object.entries(RESET_PATCH).map(([k, v]) => `${k} = ${v === null ? 'NULL' : `'${v}'`}`).join(', ')}`);
  console.log(`     WHERE id = '${m.id}';`);
  console.log(`  5. runMission('${m.id}')   -- real AI spend, capped at $${m.ai_spend_ceiling_usd}`);
  console.log('\nNothing about the payment is touched.');

  if (!DO_RUN) {
    console.log('\nDRY RUN. Nothing was changed. Re-run with --run to execute.');
    process.exit(0);
  }

  // 1. Archive, and prove it landed before deleting anything.
  fs.mkdirSync(ARCHIVE_DIR, { recursive: true });
  const archive = {
    archived_at: new Date().toISOString(),
    reason: 'panel collapse (respondents were not different people); re-run on the fixed generator',
    mission: m,
    measured_before: p.before,
    responses: p.rows,
    reasoning: p.reasoning,
  };
  fs.writeFileSync(p.archivePath, JSON.stringify(archive, null, 2));
  const readBack = JSON.parse(fs.readFileSync(p.archivePath, 'utf8'));
  if (readBack.responses.length !== p.rows.length || readBack.mission.id !== m.id) {
    throw new Error('archive did not read back intact; nothing was deleted');
  }
  console.log(`\n[1/5] archived ${readBack.responses.length} responses to ${p.archivePath}`);

  // 2-3. Delete the old delivery.
  const { error: delReasonErr } = await supabase.from('persona_response_reasoning').delete().eq('mission_id', m.id);
  if (delReasonErr) throw delReasonErr;
  const { error: delErr } = await supabase.from('mission_responses').delete().eq('mission_id', m.id);
  if (delErr) throw delErr;
  const { count: leftover } = await supabase
    .from('mission_responses').select('id', { count: 'exact', head: true }).eq('mission_id', m.id);
  console.log(`[2/5] old responses deleted (${leftover || 0} remain)`);

  // 4. Put the mission back into a runnable state.
  const { error: updErr } = await supabase.from('missions').update(RESET_PATCH).eq('id', m.id);
  if (updErr) throw updErr;
  const { data: after } = await supabase.from('missions').select('status, executive_summary, recruited_persona_count').eq('id', m.id).single();
  console.log(`[3/5] mission reset: status=${after.status}, summary=${after.executive_summary === null ? 'null' : 'STILL SET'}`);

  // 5. Run it.
  console.log('[4/5] running the full pipeline (minutes)...');
  const { runMission } = require('../src/jobs/runMission');
  const result = await runMission(m.id);

  const post = await plan(missionId);
  console.log(`[5/5] ${JSON.stringify(result || {})}`);
  console.log(`  status:     ${post.mission.status}${post.mission.failure_reason ? ` (${post.mission.failure_reason})` : ''}`);
  console.log(`  spend:      $${post.mission.ai_spend_usd_actual}`);
  console.log(`  panel now:  ${post.before.distinct} of ${post.before.n} respondents are different people`);
  console.log(`  names:      ${post.before.distinctNames} distinct, most common ${post.before.topName} x${post.before.topNameCount}`);
  console.log(`  cities:     ${post.before.distinctCities}   occupations: ${post.before.distinctOccupations}`);
  console.log(`  verdict:    ${post.before.pass ? 'PASS' : `FAIL - ${post.before.reasons.join('; ')}`}`);
  process.exit(post.before.pass && post.mission.status === 'completed' ? 0 : 1);
})().catch((e) => { console.error('FAILED:', e.message); process.exit(2); });
