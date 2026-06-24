#!/usr/bin/env node
/*
 * Un-gate proof runner — create + complete a REAL mission of a gated goal_type
 * end-to-end, owned by the platform owner, at $0 (no Stripe; LLM spend only).
 *
 * Same trusted-script pattern as backfill-open-end-themes.js +
 * reconcile-pending-payments.js: a Railway-run script, NOT an admin HTTP
 * endpoint. It deliberately BYPASSES the HTTP create/checkout gate by inserting
 * the mission directly and calling runMission() in-process — exactly so we can
 * prove a Coming-Soon type produces a complete report BEFORE it is un-gated.
 *
 * It does NOT import, read, or modify src/config/comingSoon.js, and it un-gates
 * NOTHING. runMission has no Coming-Soon check (the gate lives only on the HTTP
 * doors), so a gated type runs fine here while staying gated for real customers.
 *
 * It mirrors the real flow: generateSurvey (same generator the UI calls) →
 * insert a paid mission (sanitised columns) → runMission (recruit + simulate
 * responses → deterministic analysis → synthesis incl. personas → canonical
 * report → open-end themes) → mark completed. Prints the mission ID + a summary.
 *
 * Run on Railway (needs Anthropic + Supabase keys):
 *   node scripts/test-run-mission.js market_entry
 *   node scripts/test-run-mission.js audience_profiling --respondents 80
 *   node scripts/test-run-mission.js market_entry --dry-run   # plan only, no spend
 *   node scripts/test-run-mission.js market_entry --brief "..."  # override brief
 */
require('dotenv').config();
const supabase = require('../src/db/supabase');
const ai = require('../src/services/claudeAI');
const { runMission } = require('../src/jobs/runMission');
const { sanitizeMissionPatch } = require('../src/db/missionSchema');

const OWNER_EMAIL = (process.env.TEST_MISSION_OWNER_EMAIL || 'kabbarajamil@gmail.com').toLowerCase();

// Realistic fixtures per gated goal_type. targeting.countries drives which
// markets the simulated respondents span (market_entry splits demand by the
// respondent's persona country); respondent defaults clear the analysis
// thresholds (market_entry MIN_RELIABLE_N=30 per market; audience_profiling
// needs >=50 qualified to segment rather than aggregate-only).
const FIXTURES = {
  market_entry: {
    respondents: 80, // 40 per market × 2 markets — above the 30/market reliability floor
    brief: 'Validate demand for a premium chilled plant-based ready-meal line as we consider entering Saudi Arabia and Egypt. We currently sell only in the UAE and want to know appeal, purchase intent, willingness to pay, and the local barriers + competitors in each new market.',
    clarify: {
      concept_description: 'A premium chilled plant-based ready-meal line (15-minute prep, restaurant-quality)',
      current_market: 'UAE',
      target_markets: 'Saudi Arabia, Egypt',
      price: 'AED 25–35 per meal',
      positioning: 'premium convenience',
    },
    targeting: { countries: ['SA', 'EG'] },
    targeted_markets: ['Saudi Arabia', 'Egypt'],
  },
  audience_profiling: {
    respondents: 60, // >=50 so the analysis segments rather than reporting aggregate-only
    brief: 'Profile and segment the audience for a mid-market men’s grooming subscription in the UAE so we can sharpen targeting and messaging. We want the distinct attitudinal + behavioural segments, their sizes, and what defines each.',
    clarify: {
      category: 'Men’s grooming subscription',
      segmentation_focus: 'attitudes toward premium vs value, convenience, novelty, and brand loyalty',
      markets: 'UAE',
    },
    targeting: { countries: ['AE'] },
  },
};

function parseArgs(argv) {
  const args = { goal: null, dryRun: false, respondents: null, brief: null };
  const rest = argv.slice(2);
  for (let i = 0; i < rest.length; i += 1) {
    const a = rest[i];
    if (a === '--dry-run') args.dryRun = true;
    else if (a === '--respondents') { args.respondents = parseInt(rest[i += 1], 10); }
    else if (a === '--brief') { args.brief = rest[i += 1]; }
    else if (!a.startsWith('--') && !args.goal) args.goal = a;
  }
  return args;
}

async function resolveOwnerId(email) {
  // Page through auth users (admin) to find the owner by email.
  for (let page = 1; page <= 20; page += 1) {
    const { data, error } = await supabase.auth.admin.listUsers({ page, perPage: 200 });
    if (error) throw new Error(`listUsers failed: ${error.message}`);
    const users = data?.users || [];
    const hit = users.find((u) => (u.email || '').toLowerCase() === email);
    if (hit) return hit.id;
    if (users.length < 200) break; // last page
  }
  throw new Error(`owner not found for email ${email} (set TEST_MISSION_OWNER_EMAIL?)`);
}

(async () => {
  const args = parseArgs(process.argv);
  const goal = args.goal;
  if (!goal || !FIXTURES[goal]) {
    console.error(`Usage: node scripts/test-run-mission.js <goal_type> [--respondents N] [--brief "..."] [--dry-run]`);
    console.error(`Supported goal_type: ${Object.keys(FIXTURES).join(', ')}`);
    process.exit(1);
  }
  const fx = FIXTURES[goal];
  const respondents = Number.isFinite(args.respondents) && args.respondents > 0 ? args.respondents : fx.respondents;
  const brief = args.brief || fx.brief;

  console.log(`\n=== test-run-mission: ${goal} ===`);
  console.log(`owner:        ${OWNER_EMAIL}`);
  console.log(`respondents:  ${respondents}`);
  console.log(`targeting:    ${JSON.stringify(fx.targeting)}`);
  if (fx.targeted_markets) console.log(`markets:      ${fx.targeted_markets.join(', ')}`);
  console.log(`brief:        ${brief.slice(0, 100)}…`);

  const ownerId = await resolveOwnerId(OWNER_EMAIL);
  console.log(`owner id:     ${ownerId}`);

  if (args.dryRun) {
    console.log('\nDRY RUN — no survey generated, no mission created, no LLM/Stripe spend. Re-run without --dry-run to execute.');
    process.exit(0);
  }

  // 1) Generate the survey with the SAME generator the UI calls.
  console.log('\n[1/3] generating survey…');
  const survey = await ai.generateSurvey({ goal, description: brief, clarify: fx.clarify, targetingHints: fx.targeting });
  const questions = Array.isArray(survey?.questions) ? survey.questions : [];
  if (!questions.length) { console.error('FAIL: survey generation returned no questions.'); process.exit(1); }
  console.log(`      ${questions.length} questions generated (product: ${survey.productName || '—'})`);

  // 2) Insert a PAID mission directly (bypasses the HTTP create/checkout gate by
  //    construction; does not touch comingSoon.js). $0 — no Stripe.
  const { patch, rejected } = sanitizeMissionPatch({
    user_id: ownerId,
    title: `[UN-GATE TEST] ${goal} — ${survey.productName || brief.slice(0, 40)}`,
    goal_type: goal,
    brief,
    mission_statement: survey.missionStatement || brief,
    questions,
    targeting: fx.targeting,
    targeted_markets: fx.targeted_markets,
    respondent_count: respondents,
    status: 'paid',
    paid_at: new Date().toISOString(),
    total_price_usd: 0,
    paid_amount_cents: 0,
  });
  if (rejected && rejected.length) console.log(`      (dropped non-column fields: ${rejected.join(', ')})`);
  const { data: inserted, error: insErr } = await supabase.from('missions').insert(patch).select('id').single();
  if (insErr || !inserted) { console.error('FAIL: mission insert failed:', insErr?.message); process.exit(1); }
  const missionId = inserted.id;
  console.log(`\n[2/3] created paid mission ${missionId} — running full pipeline (this takes minutes)…`);

  // 3) Run the full completion pipeline in-process.
  try {
    await runMission(missionId);
  } catch (e) {
    console.error('FAIL: runMission threw:', e.message);
  }

  // Summary — re-fetch and report what populated.
  const { data: m } = await supabase.from('missions').select('*').eq('id', missionId).single();
  const { count: respCount } = await supabase.from('mission_responses').select('persona_id', { count: 'exact', head: true }).eq('mission_id', missionId);
  const a = m?.analysis || {};
  const ins = m?.insights || {};
  console.log(`\n[3/3] DONE — mission ${missionId}`);
  console.log(`  status:            ${m?.status}${m?.failure_reason ? ` (failure: ${m.failure_reason})` : ''}`);
  console.log(`  responses:         ${respCount ?? '?'}`);
  console.log(`  analysis:          ${a.methodology ? `${a.methodology} (n=${a.n ?? '?'})` : 'NONE'}`);
  if (goal === 'market_entry') console.log(`  markets analysed:  ${(a.markets || []).map((x) => `${x.market}(n=${x.n},demand=${x.demand_index})`).join(', ') || 'none'}`);
  if (goal === 'audience_profiling') console.log(`  segments:          ${(a.segments || []).map((x) => `${x.name}(${x.size_pct}%)`).join(', ') || 'aggregate-only'}`);
  console.log(`  exec summary:      ${ins.executive_summary ? 'yes' : 'NO'}`);
  console.log(`  recommendations:   ${(ins.recommendations || []).length}`);
  console.log(`  personas:          ${(ins.personas || []).length}`);
  console.log(`  open-end themes:   ${ins.open_end_themes ? Object.keys(ins.open_end_themes).length : 0} question(s)`);
  console.log(`\n  → Review web + PDF + PPTX + XLSX for mission ${missionId}, then sign off before un-gating ${goal}.`);
  console.log('  (This script left the Coming-Soon gate untouched.)');
  process.exit(0);
})().catch((e) => { console.error('FATAL:', e.message, e.stack); process.exit(1); });
