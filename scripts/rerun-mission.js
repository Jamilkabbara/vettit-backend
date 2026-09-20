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
const {
  calculateMissionPrice, extractCountriesFromMission, listPriceUsd, aiSpendCeilingUsd,
} = require('../src/utils/pricingEngine');

const argv = process.argv.slice(2);
const missionId = argv.find((a) => !a.startsWith('--'));
const DO_RUN = argv.includes('--run');
const flagValue = (name) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : null;
};
const archiveDirArg = flagValue('archive');
// An internal study of our own (a marketing study, an un-gate proof) was never
// charged, so the payment gate - which prices the study as it will run and
// compares that to what Stripe captured - refuses it. --promo is the platform's
// own answer: a free-type code prices the study at zero, so the gate is
// SATISFIED rather than bypassed, exactly as the free-launch route does it. The
// use is claimed and recorded like any other redemption, so the code stays
// bounded. A customer study never needs this; their own payment covers it.
const PROMO = flagValue('promo');
const ARCHIVE_DIR = (archiveDirArg || path.join(os.homedir(), 'vett-archives')).replace(/^~(?=$|\/)/, os.homedir());

if (!missionId) {
  console.error('usage: rerun-mission.js <missionId> [--run] [--archive <dir>] [--promo <CODE>]');
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
  // What the study must carry to be runnable, beyond clearing the old results.
  const extraPatch = {};
  let promo = null;
  let pricing = null;
  if (PROMO) {
    const { data: row, error: pErr } = await supabase
      .from('promo_codes').select('*').eq('code', PROMO.toUpperCase().trim()).maybeSingle();
    if (pErr) throw pErr;
    if (!row) throw new Error(`promo code not found: ${PROMO}`);
    promo = row;
    extraPatch.promo_code = row.code;
  }
  // The run refuses a study with no positive spend ceiling, and an old internal
  // study has none: it predates the rule. Derive it the way every create path
  // does, from a fraction of the LIST price - the work is the same work whether
  // or not it was charged for, so the bound comes from the list price, not $0.
  if (!Number(mission.ai_spend_ceiling_usd)) {
    pricing = calculateMissionPrice({
      respondentCount: mission.respondent_count,
      targeting:       mission.targeting || {},
      questionCount:   (mission.questions || []).length,
      countries:       extractCountriesFromMission(mission),
      goalType:        mission.goal_type,
      mediaType:       mission.media_type,
      promoCode:       promo,
    });
    extraPatch.ai_spend_ceiling_usd = aiSpendCeilingUsd(pricing);
    if (!extraPatch.ai_spend_ceiling_usd) throw new Error('could not derive a spend ceiling; refusing to run uncapped');
  }
  return {
    mission,
    rows: rows || [],
    reasoning: reasoning || [],
    promo,
    pricing,
    extraPatch,
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
  const fullPatch = { ...RESET_PATCH, ...p.extraPatch };
  console.log(`  4. UPDATE missions SET ${Object.entries(fullPatch).map(([k, v]) => `${k} = ${v === null ? 'NULL' : `'${v}'`}`).join(', ')}`);
  console.log(`     WHERE id = '${m.id}';`);
  const cap = fullPatch.ai_spend_ceiling_usd != null ? fullPatch.ai_spend_ceiling_usd : m.ai_spend_ceiling_usd;
  if (p.promo) {
    console.log(`  5. claim one use of ${p.promo.code} (now ${p.promo.uses_count} of ${p.promo.max_uses == null ? 'unlimited' : p.promo.max_uses}) and record the redemption`);
    console.log(`  6. runMission('${m.id}')   -- real AI spend, capped at $${cap}`);
    if (!p.promo.active) console.log(`\nBLOCKED: ${p.promo.code} is not active. The gate only honours an active, unexpired code.`);
    if (p.promo.type !== 'free') console.log(`\nBLOCKED: ${p.promo.code} is type '${p.promo.type}', not 'free', so it does not price this study at zero.`);
    if (p.pricing) console.log(`\nPriced with ${p.promo.code}: list $${listPriceUsd(p.pricing)}, charged $${p.pricing.total}, ceiling $${p.extraPatch.ai_spend_ceiling_usd}`);
  } else {
    console.log(`  5. runMission('${m.id}')   -- real AI spend, capped at $${cap}`);
  }
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

  // A code that is inactive, expired or not free-type leaves the study owing
  // money, and the run would refuse it after the old delivery was already
  // deleted. The archive has to come first, so this is checked before the
  // reset and stops here.
  if (p.promo && (!p.promo.active || p.promo.type !== 'free')) {
    throw new Error(`${p.promo.code} is ${p.promo.active ? `type '${p.promo.type}'` : 'inactive'}; the run would be refused for non-payment`);
  }

  // 4. Put the mission back into a runnable state.
  const { error: updErr } = await supabase.from('missions').update({ ...RESET_PATCH, ...p.extraPatch }).eq('id', m.id);
  if (updErr) throw updErr;
  const { data: after } = await supabase.from('missions').select('status, executive_summary, recruited_persona_count').eq('id', m.id).single();
  console.log(`[3/5] mission reset: status=${after.status}, summary=${after.executive_summary === null ? 'null' : 'STILL SET'}`);

  // 5. Claim the promo use BEFORE the run, the order the free-launch route
  // uses: a use spent on a run that then fails is a bounded loss, a run that
  // happened without spending one is not bounded at all. Conditional on the
  // count that was read, so two runs cannot both take the last use.
  if (p.promo) {
    const next = Number(p.promo.uses_count || 0) + 1;
    if (p.promo.max_uses != null && next > Number(p.promo.max_uses)) {
      throw new Error(`${p.promo.code} has no uses left (${p.promo.uses_count} of ${p.promo.max_uses})`);
    }
    const { data: claimed, error: claimErr } = await supabase
      .from('promo_codes').update({ uses_count: next })
      .eq('code', p.promo.code).eq('uses_count', p.promo.uses_count)
      .select('code, uses_count');
    if (claimErr) throw claimErr;
    if (!claimed || claimed.length !== 1) throw new Error(`could not claim a use of ${p.promo.code}; another run may have taken it`);
    const { error: redErr } = await supabase.from('promo_redemptions')
      .insert({ code: p.promo.code, mission_id: m.id, source: 'rerun_script', redeemed_at: new Date().toISOString() });
    if (redErr) console.error(`  WARNING: redemption row not recorded: ${redErr.message}`);
    console.log(`[3b/5] claimed one use of ${p.promo.code} (now ${claimed[0].uses_count} of ${p.promo.max_uses == null ? 'unlimited' : p.promo.max_uses})`);
  }

  // 6. Run it.
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
