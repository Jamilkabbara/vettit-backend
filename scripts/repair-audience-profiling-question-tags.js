#!/usr/bin/env node
/*
 * repair-audience-profiling-question-tags.js
 * -----------------------------------------------------------------------------
 * Owner-run, SINGLE-MISSION hand repair for the one mission whose per-question
 * analysis tags demonstrably existed and were then destroyed by the frontend
 * question-metadata strip.
 *
 * DRY RUN IS THE DEFAULT. It prints the exact before/after question tags and a
 * full preview of the analysis it would recompute, and writes NOTHING. Writing
 * requires BOTH the --execute flag AND a typed confirmation, so it cannot happen
 * by accident. The owner runs --execute themselves; the build agent never does.
 *
 *   node scripts/repair-audience-profiling-question-tags.js            # DRY RUN (safe, default)
 *   node scripts/repair-audience-profiling-question-tags.js --execute  # WRITE (prompts for typed confirm)
 *   node scripts/repair-audience-profiling-question-tags.js --execute --force  # WRITE, skip prompt
 *
 * ── WHY THIS MISSION, AND ONLY THIS MISSION ─────────────────────────────────
 * Two frontend functions rebuilt every question as a closed object literal and
 * silently DELETED every key they did not name:
 *   - aiService.mapQuestion       (mission create)  — the older, primary strip
 *   - DashboardPage.normaliseQuestions (dashboard load -> first edit -> write-back)
 * Both are fixed forward in the frontend PR that accompanies this script. That
 * fix stops the bleeding; it does not restore rows already overwritten.
 *
 * 0a494ef7 is the ONLY mission where the tags can be restored honestly:
 *   - goal_type audience_profiling, status completed, paid 2026-08-25,
 *     300 recruited personas, 2400 mission_responses rows.
 *   - It was created 2026-08-25, i.e. AFTER the commit that made mapQuestion
 *     carry `kind` + `dimension` through mission create. So it WAS created with
 *     tags.
 *   - Its stored questions now carry exactly the eight keys of the
 *     normaliseQuestions literal (id/text/type/options/aiRefined/hasPIIError/
 *     isScreening) and no tags at all. That key shape is the fingerprint of the
 *     dashboard strip: created tagged, then flattened on a dashboard edit.
 *   - Its stored `analysis` is degraded RIGHT NOW as a direct consequence:
 *       posture "aggregate", segments null, segment_count 0, key_dimension null,
 *       aggregate.attitudes {}, media/needs/behaviours [], reason
 *       "Fewer than two attitudinal dimensions were measured".
 *
 * Deliberately OUT OF SCOPE (owner decision) — this script is NOT a generic
 * backfill and must not become one:
 *   - brand_lift missions: funnel_stage/kpi_category are not derivable from
 *     question text, and the one affected draft was generated with brand_name
 *     null. Not inferable, not repaired.
 *   - the PRE_GENERATOR-era missions, the "[AUDIT-PASS]" / "Pass 4x test"
 *     script rows, and research / creative_attention missions (correctly
 *     untagged by design). Not touched.
 *
 * ── HOW THE TAGS ARE RE-DERIVED (text-corroborated, not positional) ──────────
 * The audience_profiling generator (src/services/claudeAI.js,
 * AUDIENCE_PROFILING_SURVEY_GEN_SYSTEM) emits a FIXED 12-question instrument:
 *   q1                screener       (kind="screener", isScreening=true)
 *   q2..q7            attitudinal    (kind="attitudinal", one per dimension, in
 *                                     the exact AP_DIMENSIONS order, type=rating,
 *                                     options=[], 1-7 agree/disagree)
 *   q8, q9, q10       behavioural    (usage frequency / spend / brand repertoire)
 *   q11               media
 *   q12               needs
 * This mission retains q1,q2,q3,q4,q5,q6,q8,q10 — the user deleted q7, q9, q11
 * and q12 in the editor, so sustainability, category spend, media and needs are
 * genuinely unmeasured and stay that way. Nothing is invented for them.
 *
 * Position alone is NOT trusted. Every mapping below carries a `corroborate`
 * predicate that must match the ACTUAL stored question text and shape, and the
 * script ABORTS (writing nothing) if any single one fails. The generator's own
 * example wording for each dimension is quoted next to the guard so a reviewer
 * can check the derivation without running anything.
 *
 * ── WHY THE ANALYSIS IS RECOMPUTED HERE RATHER THAN BY THE BACKFILL ──────────
 * src/services/backfills/analysis.js only fills rows where `analysis IS NULL`.
 * This mission's analysis is a NON-null, degraded object, so the backfill would
 * skip it forever. This script therefore recomputes and writes it directly,
 * through the same computeAnalysis() the backfill uses, after nulling the stale
 * object. mission_responses.question_id is NOT touched by this repair, so the
 * existing 2400 response rows stay response-compatible with the questions.
 *
 * Env (.env): SUPABASE_URL + SUPABASE_SERVICE_KEY (server-side service key --
 * never a client/anon key).
 */
require('dotenv').config();
const readline = require('readline');
const { createClient } = require('@supabase/supabase-js');

const fetchAllResponses = require('../src/db/fetchAllResponses');
const { computeAnalysis } = require('../src/services/analysis');

// ── Safety ceilings ─────────────────────────────────────────────────────────
// This is a hand repair of ONE mission, by id. Anything that does not match the
// fingerprint below is a sign the world moved under us -- abort, never guess.
const MISSION_ID = '0a494ef7-9903-497a-a649-9924458f840b';
const EXPECT_GOAL_TYPE = 'audience_profiling';
const EXPECT_STATUS = 'completed';
const EXPECT_QUESTION_IDS = ['q1', 'q2', 'q3', 'q4', 'q5', 'q6', 'q8', 'q10'];
const MAX_MISSIONS = 1;        // hard ceiling: this script may never touch more than one row
const MIN_EXPECTED_RESPONSES = 2000; // a repair worth doing has the full response set behind it

const APPLY = process.argv.includes('--execute');
const FORCE = process.argv.includes('--force');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

// ── The mapping, with its text corroboration ────────────────────────────────
// `example` is the generator's own illustrative wording for that dimension,
// quoted from AUDIENCE_PROFILING_SURVEY_GEN_SYSTEM. `corroborate` is the guard
// that must hold against the REAL stored question. `why` is the evidence a
// reviewer reads.
const norm = (s) => String(s || '').toLowerCase();

const TAG_PLAN = [
  {
    id: 'q1',
    tags: { kind: 'screener' },
    example: 'q1 SCREENER (isScreening=true, kind="screener") — qualifies category users from the brief.',
    corroborate: (q) => q.isScreening === true && q.type === 'single' && (q.options || []).length >= 2,
    why: 'stored isScreening is already true, type single with 3 options — the generator\'s screener slot.',
  },
  {
    id: 'q2',
    tags: { kind: 'attitudinal', dimension: 'price_sensitivity' },
    example: '"I always look for the best price or deals in this category."',
    corroborate: (q) => /\bprice|\bcost|cost-effective|cheap|deal/.test(norm(q.text)),
    why: 'text turns on comparing prices and the most cost-effective option.',
  },
  {
    id: 'q3',
    tags: { kind: 'attitudinal', dimension: 'novelty_seeking' },
    example: '"I love trying new products and brands before other people do."',
    corroborate: (q) => /\bnew\b|innovat/.test(norm(q.text)) && /before (others|other people|anyone)/.test(norm(q.text)),
    why: 'text is about adopting new/innovative approaches BEFORE others — the generator\'s novelty framing verbatim.',
  },
  {
    id: 'q4',
    tags: { kind: 'attitudinal', dimension: 'brand_loyalty' },
    example: '"Once I find a brand I like, I stick with it."',
    corroborate: (q) => /once i find/.test(norm(q.text)) && /(stick with|continue working|rather than switching|switch)/.test(norm(q.text)),
    why: 'text opens "Once I find ... I prefer to continue ... rather than switching" — the loyalty statement near-verbatim.',
  },
  {
    id: 'q5',
    tags: { kind: 'attitudinal', dimension: 'convenience' },
    example: '"Convenience matters more to me than getting the lowest price."',
    corroborate: (q) => /(convenien|fast turnaround|easy|speed)/.test(norm(q.text)) && /matters more/.test(norm(q.text)) && /(lowest price|price)/.test(norm(q.text)),
    why: 'text is "<ease/speed> matters more to me than achieving the lowest price" — the convenience statement\'s exact comparative structure.',
  },
  {
    id: 'q6',
    tags: { kind: 'attitudinal', dimension: 'status' },
    example: '"The brands I use say something about who I am."',
    corroborate: (q) => /(reputation|credibilit|status|prestige|say something about|who i am|image)/.test(norm(q.text)) && /(reflect|say something about)/.test(norm(q.text)),
    why: 'text says the partners used "reflect the professional reputation and credibility of my organisation" — identity-signalling, the status dimension.',
  },
  {
    id: 'q8',
    tags: { kind: 'behavioural' },
    example: 'q8 BEHAVIOURAL — usage frequency. type="single", 4-5 frequency options.',
    corroborate: (q) => /how (frequently|often)/.test(norm(q.text)) && q.type === 'single' && (q.options || []).length >= 4,
    why: 'text is "How frequently does your organisation commission..." with 5 frequency options, type single — the usage-frequency slot exactly.',
  },
  {
    id: 'q10',
    tags: { kind: 'behavioural' },
    example: 'q10 BEHAVIOURAL — brand repertoire ("which of these do you use?"). type="multi", real category brands.',
    corroborate: (q) => /(which of the following|select all that apply|used in the past)/.test(norm(q.text)) && q.type === 'multi' && (q.options || []).length >= 4,
    why: 'text is "Which of the following ... has your organisation used in the past 12 months? (Select all that apply)", type multi, real named providers — the brand-repertoire slot exactly.',
  },
];

// Dimensions the generator defines. q7 (sustainability) was deleted by the user
// and is therefore genuinely unmeasured; we do NOT fabricate it.
const AP_DIMENSIONS = ['price_sensitivity', 'novelty_seeking', 'brand_loyalty', 'convenience', 'status', 'sustainability'];

/**
 * THE ONE SELECTION FUNCTION.
 *
 * Both the dry-run preview and the --execute path call this and nothing else,
 * so "what it says it will do" and "what it does" cannot drift apart. It
 * returns the mission plus the fully-built repaired questions array, or throws
 * with the reason it refuses to proceed.
 */
async function selectTarget() {
  const { data, error } = await supabase
    .from('missions')
    .select('id,title,goal_type,status,questions,analysis,recruited_persona_count,paid_at')
    .eq('id', MISSION_ID);
  if (error) throw new Error(`missions read failed: ${error.message}`);
  if (!data || data.length === 0) throw new Error(`mission ${MISSION_ID} not found`);
  if (data.length > MAX_MISSIONS) throw new Error(`selection ceiling: matched ${data.length} rows, max ${MAX_MISSIONS}`);

  const mission = data[0];
  if (mission.goal_type !== EXPECT_GOAL_TYPE) {
    throw new Error(`fingerprint: goal_type is "${mission.goal_type}", expected "${EXPECT_GOAL_TYPE}"`);
  }
  if (mission.status !== EXPECT_STATUS) {
    throw new Error(`fingerprint: status is "${mission.status}", expected "${EXPECT_STATUS}"`);
  }

  const qs = Array.isArray(mission.questions) ? mission.questions : [];
  const ids = qs.map((q) => q && q.id);
  if (JSON.stringify(ids) !== JSON.stringify(EXPECT_QUESTION_IDS)) {
    throw new Error(`fingerprint: question ids are ${JSON.stringify(ids)}, expected ${JSON.stringify(EXPECT_QUESTION_IDS)} — the survey changed under us, refusing to repair`);
  }

  // Refuse to run over questions that already carry tags: this repair is for
  // the stripped state only, and re-running it must not overwrite good data.
  const alreadyTagged = qs.filter((q) => q && (q.kind || q.dimension));
  if (alreadyTagged.length > 0) {
    throw new Error(`already repaired: ${alreadyTagged.length} question(s) already carry kind/dimension — nothing to do`);
  }

  // Build + corroborate. Any single failure aborts the whole repair.
  const problems = [];
  const repaired = qs.map((q) => {
    const plan = TAG_PLAN.find((p) => p.id === q.id);
    if (!plan) { problems.push(`${q.id}: no mapping defined`); return q; }
    if (!plan.corroborate(q)) {
      problems.push(`${q.id}: text/shape does NOT corroborate ${JSON.stringify(plan.tags)} — refusing to tag on position alone. Stored text: ${JSON.stringify(String(q.text || '').slice(0, 140))}`);
      return q;
    }
    // Passthrough spread, then the tags. Same discipline as the frontend fix:
    // never rebuild a question as a closed literal.
    return { ...q, ...plan.tags };
  });
  if (problems.length) {
    throw new Error(`text corroboration FAILED — no write attempted:\n  - ${problems.join('\n  - ')}`);
  }

  // Structural post-conditions on the repaired set.
  const dims = repaired.filter((q) => q.kind === 'attitudinal').map((q) => q.dimension);
  const unknown = dims.filter((d) => !AP_DIMENSIONS.includes(d));
  if (unknown.length) throw new Error(`repaired set has non-canonical dimension(s): ${unknown.join(', ')}`);
  if (new Set(dims).size !== dims.length) throw new Error(`repaired set assigns a dimension twice: ${dims.join(', ')}`);
  if (dims.length < 2) throw new Error(`repaired set has ${dims.length} attitudinal dimension(s); the segmentation gate needs >= 2 — repair would not fix the analysis`);

  return { mission, repaired, dims };
}

/** Recompute the analysis from the repaired questions. Shared by preview + write. */
async function computeFresh(mission, repairedQuestions) {
  const { data: rows, error } = await fetchAllResponses(supabase, {
    missionId: mission.id,
    columns: 'persona_id, persona_profile, question_id, answer, exposure_status',
    eq: { screened_out: false },
    label: 'repair-ap-tags',
  });
  if (error) throw new Error(`responses read failed: ${error.message}`);
  if (!rows || rows.length < MIN_EXPECTED_RESPONSES) {
    throw new Error(`safety ceiling: only ${rows ? rows.length : 0} response rows (expected >= ${MIN_EXPECTED_RESPONSES}); refusing to recompute an analysis from a short read`);
  }
  const analysis = computeAnalysis({ ...mission, questions: repairedQuestions }, rows);
  if (!analysis) throw new Error('computeAnalysis returned null — refusing to write');
  return { analysis, rowCount: rows.length };
}

function summarise(a) {
  if (!a) return '(null)';
  const dims = a.aggregate && a.aggregate.attitudes ? Object.keys(a.aggregate.attitudes) : [];
  return [
    `posture=${a.posture}`,
    `n=${a.n}`,
    `segments=${a.segments ? a.segments.length : 'null'}`,
    `segment_count=${a.segment_count}`,
    `key_dimension=${a.key_dimension}`,
    `attitudes_measured=[${dims.join(', ')}]`,
    `behaviours=${a.aggregate ? (a.aggregate.behaviours || []).length : 0}`,
    `media=${a.aggregate ? (a.aggregate.media || []).length : 0}`,
    `needs=${a.aggregate ? (a.aggregate.needs || []).length : 0}`,
    `reason=${JSON.stringify(a.reason)}`,
  ].join('\n    ');
}

function confirm(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((res) => rl.question(question, (ans) => { rl.close(); res(ans); }));
}

(async () => {
  console.log(`\n${APPLY ? '*** EXECUTE MODE ***' : 'DRY RUN (default) — nothing will be written'}\n`);

  const { mission, repaired, dims } = await selectTarget();

  console.log(`Mission ${mission.id}`);
  console.log(`  title:   ${JSON.stringify(mission.title)}`);
  console.log(`  goal:    ${mission.goal_type} | status: ${mission.status} | personas: ${mission.recruited_persona_count}`);
  console.log('');
  console.log('Tag plan (each line was corroborated against the stored question text):');
  for (const q of repaired) {
    const plan = TAG_PLAN.find((p) => p.id === q.id);
    console.log(`  ${q.id.padEnd(4)} -> ${JSON.stringify(plan.tags)}`);
    console.log(`        text:     ${JSON.stringify(String(q.text || '').slice(0, 120))}`);
    console.log(`        generator: ${plan.example}`);
    console.log(`        evidence:  ${plan.why}`);
  }
  const missingDims = AP_DIMENSIONS.filter((d) => !dims.includes(d));
  if (missingDims.length) {
    console.log(`\n  NOT repaired (question deleted by the user, genuinely unmeasured): ${missingDims.join(', ')}`);
    console.log('  Also unmeasured: category spend (q9), media (q11), needs (q12). Nothing is invented for these.');
  }

  const { analysis, rowCount } = await computeFresh(mission, repaired);
  console.log(`\nAnalysis recompute preview (from ${rowCount} response rows, question_id untouched):`);
  console.log(`  BEFORE (stored, degraded):\n    ${summarise(mission.analysis)}`);
  console.log(`  AFTER  (recomputed):\n    ${summarise(analysis)}`);

  if (analysis.posture === 'aggregate' && /Fewer than two attitudinal dimensions/.test(analysis.reason || '')) {
    throw new Error('post-condition FAILED: recomputed analysis is still the degraded aggregate — refusing to write');
  }

  if (!APPLY) {
    console.log('\nDRY RUN complete. Nothing written. Re-run with --execute to apply.\n');
    return;
  }

  if (!FORCE) {
    const ans = await confirm(`\nType exactly "repair ${MISSION_ID}" to write the tags and recomputed analysis: `);
    if (ans.trim() !== `repair ${MISSION_ID}`) {
      console.log('Confirmation did not match. Aborted. Nothing written.');
      process.exit(1);
    }
  }

  // 1) re-attach the tags
  const { error: qErr } = await supabase.from('missions').update({ questions: repaired }).eq('id', mission.id);
  if (qErr) throw new Error(`questions write failed: ${qErr.message}`);
  console.log('  questions: tags written.');

  // 2) null the stale degraded analysis (backfills/analysis.js only fills NULLs,
  //    so this also leaves the row recoverable by the normal backfill if step 3
  //    were ever to fail)
  const { error: nErr } = await supabase.from('missions').update({ analysis: null }).eq('id', mission.id);
  if (nErr) throw new Error(`analysis null failed: ${nErr.message}`);
  console.log('  analysis: nulled.');

  // 3) write the recomputed analysis
  const { error: aErr } = await supabase.from('missions').update({ analysis }).eq('id', mission.id);
  if (aErr) throw new Error(`analysis write failed: ${aErr.message} (row left with analysis NULL — scripts/backfill-analysis.js will now pick it up)`);
  console.log('  analysis: recomputed and written.');

  console.log('\nDone. 1 mission repaired.\n');
})().catch((err) => {
  console.error(`\nABORTED: ${err.message}\n`);
  process.exit(1);
});
