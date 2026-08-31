#!/usr/bin/env node
/*
 * regenerate-untagged-draft-surveys.js
 * -----------------------------------------------------------------------------
 * Owner-run regeneration of the 14 draft/expired missions whose stored questions
 * lost every per-question analysis tag to the frontend question-metadata strip.
 *
 * *** THIS DISCARDS THE USER'S MANUAL EDITS TO THOSE DRAFTS. ***
 * Each targeted mission's `questions` array is REPLACED wholesale with a freshly
 * generated, properly tagged instrument. Any wording the user changed, any
 * question they added, reordered or deleted in the editor is GONE. That is the
 * deliberate trade: these are unpaid drafts with zero responses, so a genuinely
 * tagged instrument is worth more than preserved edits on an instrument whose
 * analysis would come back empty. The dry run prints the full existing questions
 * array for every mission, and --execute writes a timestamped JSON backup of all
 * of them to disk BEFORE the first write, so the discarded edits are recoverable
 * by hand if the owner changes their mind.
 *
 * DRY RUN IS THE DEFAULT. It re-verifies every safety precondition, prints what
 * it would replace, and writes NOTHING. It also makes NO AI calls, so a dry run
 * is free. Writing requires BOTH the --execute flag AND a typed confirmation.
 * The owner runs --execute themselves; the build agent never does.
 *
 *   node scripts/regenerate-untagged-draft-surveys.js            # DRY RUN (safe, default, no AI spend)
 *   node scripts/regenerate-untagged-draft-surveys.js --execute  # REGENERATE (prompts for typed confirm)
 *   node scripts/regenerate-untagged-draft-surveys.js --execute --force  # skip prompt (scripted)
 *
 * ── WHY REGENERATE RATHER THAN BACKFILL ─────────────────────────────────────
 * Two frontend functions (aiService.mapQuestion and
 * DashboardPage.normaliseQuestions) rebuilt every question as a closed object
 * literal and silently deleted every key they did not name, so no UI-created
 * mission ever persisted the full tag set. The analysis and results pages filter
 * on those tags with NO fallback, so an untagged instrument yields empty output.
 *
 * For these 14 the tags cannot be honestly inferred from question text (unlike
 * the one audience_profiling mission handled by
 * scripts/repair-audience-profiling-question-tags.js, whose generator emits a
 * fixed, text-identifiable battery). But all 14 are draft/expired, unpaid, and
 * have ZERO mission_responses rows -- so regeneration is clean: it produces a
 * genuinely tagged instrument from the shipped generator instead of an inferred
 * one, and there is no response data to desync.
 *
 * ── THE RULE THIS SCRIPT EXISTS TO NOT BREAK ────────────────────────────────
 * NEVER regenerate questions on a mission that HAS responses.
 * mission_responses.question_id references the question ids in the stored
 * survey; replacing the survey under existing responses desyncs them
 * permanently. Every mission is re-checked for a zero response count
 * IMMEDIATELY BEFORE its own write, not just during selection, so a mission that
 * starts collecting responses between the preview and the write is skipped
 * rather than corrupted.
 *
 * Deliberately OUT OF SCOPE (owner decision) -- this is NOT a generic backfill:
 * the PRE_GENERATOR-era missions, the "[AUDIT-PASS]" / "Pass 4x test" script
 * rows, and research / creative_attention missions (correctly untagged by
 * design) are not touched. No tags are inferred for anything.
 *
 * Env (.env): SUPABASE_URL + SUPABASE_SERVICE_KEY (server-side service key --
 * never a client/anon key) + ANTHROPIC_API_KEY (generation costs real money:
 * roughly one survey-generation call per mission).
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { createClient } = require('@supabase/supabase-js');

const { ensureMissionQuestions } = require('../src/services/ai/ensureQuestions');

// ── Selection markers ───────────────────────────────────────────────────────
// The 14 short ids from the metadata-loss survey. Short prefixes are resolved
// against the full missions table and MUST each resolve to exactly one row.
const TARGET_PREFIXES = [
  'a912f5ab', '021fc78c', 'd1924a17', '6ab80b7f', 'e4729142', '3de79ffe', 'f1356e86',
  '1558bc91', 'aa79a556', '197818bd', 'c540ef5e', '63589b0a', 'd2e7b9f2', '10f558a4',
];

// ── Safety ceilings ─────────────────────────────────────────────────────────
const MAX_MISSIONS = TARGET_PREFIXES.length; // never touch more rows than we named
const ALLOWED_STATUSES = ['draft', 'expired'];
const MIN_BRIEF_LEN = 20; // ensureMissionQuestions' own floor; checked up front so we fail in preview, not mid-run

const APPLY = process.argv.includes('--execute');
const FORCE = process.argv.includes('--force');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

/** PostgREST silently caps unbounded reads at 1000 rows; page with a deterministic order. */
async function pageAllMissions() {
  const out = [];
  const SIZE = 1000;
  for (let from = 0; ; from += SIZE) {
    const { data, error } = await supabase
      .from('missions')
      .select('id,title,brief,goal_type,status,paid_at,paid_amount_cents,questions')
      .order('id', { ascending: true })
      .range(from, from + SIZE - 1);
    if (error) throw new Error(`missions read failed: ${error.message}`);
    out.push(...data);
    if (data.length < SIZE) break;
  }
  return out;
}

async function responseCount(missionId) {
  const { count, error } = await supabase
    .from('mission_responses')
    .select('id', { count: 'exact', head: true })
    .eq('mission_id', missionId);
  if (error) throw new Error(`response count failed for ${missionId}: ${error.message}`);
  return count;
}

/**
 * THE ONE SELECTION FUNCTION.
 *
 * Both the dry-run preview and the --execute run call this and nothing else, so
 * the filter cannot drift between "what it says it will do" and "what it does".
 * Returns { targets, rejected }. A non-empty `rejected` is fatal: if any named
 * mission fails a precondition, something has changed since the survey and the
 * whole batch is refused rather than silently shrunk.
 */
async function selectTargets() {
  const all = await pageAllMissions();
  const targets = [];
  const rejected = [];

  for (const prefix of TARGET_PREFIXES) {
    const matches = all.filter((m) => String(m.id).startsWith(prefix));
    if (matches.length === 0) { rejected.push(`${prefix}: not found`); continue; }
    if (matches.length > 1) { rejected.push(`${prefix}: ambiguous, matched ${matches.length} missions`); continue; }
    const m = matches[0];

    if (!ALLOWED_STATUSES.includes(m.status)) {
      rejected.push(`${prefix}: status "${m.status}" not in [${ALLOWED_STATUSES.join(', ')}]`); continue;
    }
    if (m.paid_at || m.paid_amount_cents) {
      rejected.push(`${prefix}: mission is PAID (paid_at=${m.paid_at}) — refusing to touch`); continue;
    }
    const n = await responseCount(m.id);
    if (n !== 0) {
      rejected.push(`${prefix}: has ${n} mission_responses rows — regenerating would desync question_id. REFUSED.`); continue;
    }
    const brief = String(m.brief || m.title || '').trim();
    if (brief.length < MIN_BRIEF_LEN) {
      rejected.push(`${prefix}: brief is ${brief.length} chars, generator needs >= ${MIN_BRIEF_LEN}`); continue;
    }
    targets.push({ ...m, _responseCount: n, _briefLen: brief.length });
  }

  if (rejected.length) {
    throw new Error(`selection preconditions FAILED — no mission processed:\n  - ${rejected.join('\n  - ')}`);
  }
  if (targets.length > MAX_MISSIONS) {
    throw new Error(`selection ceiling: ${targets.length} targets, max ${MAX_MISSIONS}`);
  }
  return targets;
}

const tagCount = (qs) => (Array.isArray(qs) ? qs : []).filter(
  (q) => q && (q.kind || q.dimension || q.methodology || q.funnel_stage || q.kpi_category
    || q.churn_stage || q.vw_band || q.feature_id || q.kano_type || q.concept_id || q.brand_id),
).length;

function confirm(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((res) => rl.question(question, (ans) => { rl.close(); res(ans); }));
}

(async () => {
  console.log(`\n${APPLY ? '*** EXECUTE MODE — this REPLACES questions and DISCARDS manual edits ***' : 'DRY RUN (default) — nothing will be written, no AI calls made'}\n`);

  const targets = await selectTargets();
  console.log(`${targets.length} mission(s) selected. All verified: unpaid, draft/expired, ZERO responses.\n`);
  console.log('  short    | goal             | status  | resp | questions (tagged)  | title');
  console.log('  ---------+------------------+---------+------+---------------------+------');
  for (const m of targets) {
    const qs = Array.isArray(m.questions) ? m.questions : [];
    console.log(`  ${m.id.slice(0, 8)} | ${String(m.goal_type).padEnd(16)} | ${String(m.status).padEnd(7)} | ${String(m._responseCount).padStart(4)} | ${String(qs.length).padStart(2)} (${tagCount(qs)} tagged)${' '.repeat(9)} | ${String(m.title || '').slice(0, 50)}`);
  }

  const backup = targets.map((m) => ({ id: m.id, title: m.title, goal_type: m.goal_type, status: m.status, questions: m.questions }));
  const backupPath = path.resolve(__dirname, `../regenerate-backup-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);

  if (!APPLY) {
    console.log('\n--- EXISTING questions that --execute would DISCARD (full JSON) ---');
    console.log(JSON.stringify(backup, null, 2));
    console.log(`\nDRY RUN complete. Nothing written, no AI spend. Re-run with --execute to regenerate.`);
    console.log(`On --execute this array is saved to ${backupPath}\n`);
    return;
  }

  if (!FORCE) {
    const ans = await confirm(`\nThis DISCARDS the user's manual edits on ${targets.length} drafts.\nType exactly "regenerate ${targets.length}" to proceed: `);
    if (ans.trim() !== `regenerate ${targets.length}`) {
      console.log('Confirmation did not match. Aborted. Nothing written.');
      process.exit(1);
    }
  }

  fs.writeFileSync(backupPath, JSON.stringify(backup, null, 2));
  console.log(`\nBackup of the discarded questions written to ${backupPath}`);

  let ok = 0;
  const failures = [];
  for (const m of targets) {
    // Re-check IMMEDIATELY before this mission's own write. A mission that began
    // collecting responses since the preview must be skipped, never corrupted.
    const n = await responseCount(m.id);
    if (n !== 0) {
      failures.push(`${m.id.slice(0, 8)}: gained ${n} responses since preview — SKIPPED (would desync question_id)`);
      continue;
    }
    try {
      // ensureMissionQuestions regenerates + persists when the row has no
      // questions. Handing it a copy with questions:[] reuses the shipped
      // generation path (and its updateMission audit logging) verbatim rather
      // than re-implementing it here.
      const qs = await ensureMissionQuestions(supabase, { ...m, questions: [] });
      console.log(`  ${m.id.slice(0, 8)} ${String(m.goal_type).padEnd(16)} -> ${qs.length} questions, ${tagCount(qs)} tagged`);
      ok += 1;
    } catch (err) {
      failures.push(`${m.id.slice(0, 8)} (${m.goal_type}): ${err.message}`);
    }
  }

  console.log(`\nRegenerated ${ok}/${targets.length}.`);
  if (failures.length) {
    console.log(`\n${failures.length} failure(s) — these missions were left UNCHANGED:`);
    for (const f of failures) console.log(`  - ${f}`);
    process.exit(1);
  }
  console.log('');
})().catch((err) => {
  console.error(`\nABORTED: ${err.message}\n`);
  process.exit(1);
});
