#!/usr/bin/env node
/*
 * backfill-mission-category.js
 * -----------------------------------------------------------------------------
 * Owner-run backfill for missions.category — the benchmark key.
 *
 * Going forward POST /api/ai/clarify stamps a normalised category on new
 * missions (rider on an AI call the setup flow already makes). This script
 * closes the historical gap: every mission created before that, plus the small
 * number carrying user-typed free text, gets a key from the SAME closed
 * taxonomy in src/services/ai/missionCategory.js. Same taxonomy, same prompt
 * text, same normalizeCategory() coercion — so a backfilled row and a
 * newly-created row are directly comparable. That is the whole point.
 *
 * DRY RUN IS THE DEFAULT, and the dry run spends NOTHING: it selects, applies
 * the exclusions, prints the exact set with its reasons, and makes zero AI
 * calls and zero writes. Classification only happens on --execute (or on the
 * opt-in --preview-ai sample, which still writes nothing).
 *
 *   node scripts/backfill-mission-category.js                  # DRY RUN (default, free)
 *   node scripts/backfill-mission-category.js --preview-ai 5   # DRY RUN + classify 5 for a real preview
 *   node scripts/backfill-mission-category.js --execute        # WRITE (typed confirmation)
 *   node scripts/backfill-mission-category.js --execute --limit 25
 *   node scripts/backfill-mission-category.js --execute --force # skip prompt (scripted)
 *
 * ONE SELECTION FUNCTION
 * ──────────────────────
 * selectCandidates() below is the ONLY thing that decides what is in scope, and
 * both the dry-run preview and the --execute run call it. This is deliberate: a
 * previous backfill kept an inline filter in its dry run that drifted from the
 * real run — the preview said 1 candidate and the run touched 17. Do not add a
 * second filter anywhere in this file.
 *
 * SELECTION: a mission is a candidate when its category is not already a valid
 * taxonomy key — i.e. NULL, empty, or legacy user-typed free text (production
 * held 15 such rows across 14 distinct strings, which is exactly the
 * uncomparable state this replaces). Rows already holding a valid key are
 * skipped, so the script is idempotent and safe to re-run.
 *
 * EXCLUSIONS (see EXCLUSION_RULES): internal probe / harness / audit missions,
 * identified by an anchored TITLE PREFIX only — never by a substring, never by
 * status or user, so a real customer mission cannot be swept up by accident:
 *   · "[UN-GATE TEST]"  — un-gate verification runs        (required exclusion)
 *   · "[AUDIT-PASS]"    — scripts/test-run-all-types.js    (required exclusion)
 *   · "Pass <N> ..."    — Pass 42/44/45 internal probes
 *   · "P<NN> test|audit|probe|smoke|— ..." — P46/P47 harness sweeps
 * Plus rows with too little text to classify honestly (see MIN_SIGNAL_CHARS):
 * spending an AI call to produce a guaranteed `other` is waste, and leaving
 * them NULL is the truthful record.
 *
 * PAGINATION: PostgREST silently caps an unbounded SELECT at 1000 rows — no
 * error, no flag. Every read here pages with a deterministic .order() so the
 * candidate set can never be a silent truncation.
 *
 * Env (.env): SUPABASE_URL + SUPABASE_SERVICE_KEY (service key, never anon) and
 * ANTHROPIC_API_KEY (only needed for --execute / --preview-ai).
 */
require('dotenv').config();
const readline = require('readline');
const { createClient } = require('@supabase/supabase-js');

const {
  CATEGORY_PROMPT_BLOCK,
  normalizeCategory,
  isMissionCategory,
  CATEGORY_KEYS,
} = require('../src/services/ai/missionCategory');
const { updateMission } = require('../src/db/missionSchema');

// anthropic.js constructs its SDK client at require time and throws without
// ANTHROPIC_API_KEY. Required lazily so a DRY RUN works on a machine that only
// has database credentials — the dry run makes no AI calls at all.
let _anthropic = null;
const anthropic = () => (_anthropic || (_anthropic = require('../src/services/ai/anthropic')));

// ─── knobs ───────────────────────────────────────────────────────────────────

/** Anchored title-prefix markers for internal probe/harness/audit missions. */
const EXCLUSION_RULES = [
  { name: 'un-gate test', test: (t) => t.startsWith('[UN-GATE TEST]') },
  { name: 'audit-pass',   test: (t) => t.startsWith('[AUDIT-PASS]') },
  { name: 'pass-N probe', test: (t) => /^Pass\s+\d+\b/i.test(t) },
  { name: 'PNN harness',  test: (t) => /^P\d{1,3}\s*(?:[—–-]|test\b|audit\b|probe\b|smoke\b)/i.test(t) },
];

/** Below this much combined title+brief+brand signal, classification is a coin
 *  flip that always lands on `other`. Skip and leave the row honest. */
const MIN_SIGNAL_CHARS = 25;

/** Safety ceiling. 119 missions existed on 2026-08-31; a legitimate backfill is
 *  dozens. Above this, something is wrong with selection — abort, don't write. */
const MAX_UPDATES = 300;

/** PostgREST page size (its hard per-request cap). */
const PAGE = 1000;

const APPLY = process.argv.includes('--execute');
const FORCE = process.argv.includes('--force');
const argVal = (flag) => {
  const i = process.argv.indexOf(flag);
  if (i === -1) return null;
  const n = Number(process.argv[i + 1]);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : null;
};
const LIMIT = argVal('--limit');
const PREVIEW_AI = APPLY ? null : argVal('--preview-ai');

// ─── selection (the ONE function; dry run and execute both call it) ──────────

/** Page through every mission with a deterministic sort. Never unbounded. */
async function fetchAllMissions(db) {
  const cols = 'id,title,brief,brand_name,category,goal_type,status,created_at';
  let from = 0;
  const out = [];
  for (;;) {
    const { data, error } = await db
      .from('missions')
      .select(cols)
      .order('created_at', { ascending: true })
      .order('id', { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) throw new Error(`missions select failed: ${error.message}`);
    out.push(...(data || []));
    if (!data || data.length < PAGE) break;
    from += PAGE;
    if (out.length > 200000) throw new Error('ABORT: pagination runaway');
  }
  return out;
}

/** Text handed to the classifier. Also what MIN_SIGNAL_CHARS measures. */
function classifierInput(m) {
  return [
    m.title ? `Title: ${m.title}` : '',
    m.brand_name ? `Brand: ${m.brand_name}` : '',
    m.category ? `User-typed category (free text, may be wrong): ${m.category}` : '',
    m.goal_type ? `Research type: ${m.goal_type}` : '',
    m.brief ? `Brief: ${m.brief}` : '',
  ].filter(Boolean).join('\n');
}

function signalLength(m) {
  return `${m.title || ''} ${m.brand_name || ''} ${m.category || ''} ${m.brief || ''}`.trim().length;
}

/**
 * THE selection function. Returns the full partition so the dry run can print
 * exactly why each row was kept or dropped, and --execute writes to precisely
 * the `candidates` array this returns. No caller may re-filter.
 */
async function selectCandidates(db) {
  const all = await fetchAllMissions(db);
  const candidates = [];
  const skipped = { alreadyClassified: [], excluded: [], tooLittleText: [] };

  for (const m of all) {
    const title = String(m.title || '');
    if (isMissionCategory(m.category)) { skipped.alreadyClassified.push(m); continue; }
    const rule = EXCLUSION_RULES.find((r) => r.test(title));
    if (rule) { skipped.excluded.push({ ...m, _rule: rule.name }); continue; }
    if (signalLength(m) < MIN_SIGNAL_CHARS) { skipped.tooLittleText.push(m); continue; }
    candidates.push(m);
  }

  // Defense in depth: nothing bearing an exclusion marker may survive into the
  // write set, whatever happens above.
  const leaked = candidates.filter((m) => EXCLUSION_RULES.some((r) => r.test(String(m.title || ''))));
  if (leaked.length) {
    throw new Error(`ABORT: ${leaked.length} excluded-marker row(s) leaked into the candidate set — refusing to proceed.`);
  }

  return { all, candidates, skipped };
}

// ─── classification (identical prompt to the live clarify rider) ─────────────

const BACKFILL_SYSTEM_PROMPT = [
  'You classify past market-research briefs into one market category, for benchmarking.',
  'Return ONLY strict JSON — no prose, no markdown fences.',
  '',
  CATEGORY_PROMPT_BLOCK,
  '',
  'Respond with exactly: { "category": "<key>" }',
].join('\n');

/**
 * One Claude call per mission. callType `brief_clarify` is already registered in
 * anthropic.js (MODEL_ROUTING + CALL_TYPE_TO_PURPOSE → purpose "clarify") but
 * had no call site anywhere in the codebase; this backfill is its first, so the
 * spend lands in the existing clarify cost bucket with no config change.
 * Returns a valid key, or null when the call/parse failed (leave the row NULL
 * rather than write a guess).
 */
async function classify(mission) {
  try {
    const { callClaude } = anthropic();
    const res = await callClaude({
      callType: 'brief_clarify',
      missionId: mission.id,
      systemPrompt: BACKFILL_SYSTEM_PROMPT,
      messages: [{ role: 'user', content: classifierInput(mission) }],
      maxTokens: 60,
    });
    const parsed = anthropic().extractJSON(res.text);
    return normalizeCategory(parsed && parsed.category);
  } catch (err) {
    console.log(`    ! classify failed for ${mission.id.slice(0, 8)}: ${err.message}`);
    return null;
  }
}

// ─── confirmation ────────────────────────────────────────────────────────────

function confirmTyped(expectedPhrase) {
  return new Promise((resolve) => {
    if (FORCE) return resolve(true);
    if (!process.stdin.isTTY) {
      console.log('\nRefusing to write: not an interactive terminal and --force not given.');
      return resolve(false);
    }
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(`\nType exactly  ${expectedPhrase}  to proceed (anything else aborts): `, (answer) => {
      rl.close();
      resolve(answer.trim() === expectedPhrase);
    });
  });
}

// ─── main ────────────────────────────────────────────────────────────────────

const short = (s, n) => (String(s || '').length > n ? `${String(s).slice(0, n - 1)}…` : String(s || ''));

(async () => {
  const url = process.env.SUPABASE_URL;
  const service = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !service) throw new Error('Need SUPABASE_URL + SUPABASE_SERVICE_KEY in .env');
  const db = createClient(url, service, { auth: { persistSession: false } });

  console.log(`\nMODE: ${APPLY ? 'EXECUTE (writes missions.category)' : 'DRY RUN (no writes)'}`);
  console.log(`TAXONOMY (${CATEGORY_KEYS.length} keys): ${CATEGORY_KEYS.join(', ')}`);
  console.log(`SELECT: missions whose category is not already one of those keys`);
  console.log(`EXCLUDE (anchored title prefix): ${EXCLUSION_RULES.map((r) => r.name).join(' · ')}`);
  console.log(`EXCLUDE: combined title+brand+category+brief shorter than ${MIN_SIGNAL_CHARS} chars\n`);

  const { all, candidates: selected, skipped } = await selectCandidates(db);
  const candidates = LIMIT ? selected.slice(0, LIMIT) : selected;

  console.log(`Total missions (paged, deterministic order): ${all.length}`);
  console.log(`  already a valid key (skipped, idempotent) : ${skipped.alreadyClassified.length}`);
  console.log(`  excluded as probe/test/harness            : ${skipped.excluded.length}`);
  console.log(`  too little text to classify honestly      : ${skipped.tooLittleText.length}`);
  console.log(`  CANDIDATES                                : ${selected.length}${LIMIT ? ` (--limit ${LIMIT} → ${candidates.length})` : ''}`);

  if (skipped.excluded.length) {
    console.log(`\nExcluded (${skipped.excluded.length}) — by rule:`);
    const byRule = {};
    for (const m of skipped.excluded) (byRule[m._rule] = byRule[m._rule] || []).push(m);
    for (const [rule, rows] of Object.entries(byRule)) {
      console.log(`  [${rule}] ${rows.length}`);
      for (const m of rows) console.log(`      ${m.id.slice(0, 8)}  ${short(m.title, 68)}`);
    }
  }
  if (skipped.tooLittleText.length) {
    console.log(`\nToo little text (${skipped.tooLittleText.length}) — left NULL on purpose:`);
    for (const m of skipped.tooLittleText) console.log(`  ${m.id.slice(0, 8)}  ${short(m.title, 68)}`);
  }
  if (skipped.alreadyClassified.length) {
    console.log(`\nAlready classified (${skipped.alreadyClassified.length}):`);
    for (const m of skipped.alreadyClassified) console.log(`  ${m.id.slice(0, 8)}  ${m.category}`);
  }

  if (candidates.length === 0) {
    console.log('\nNothing to backfill. Exiting cleanly.');
    process.exit(0);
  }

  // Anti-over-match guards.
  if (candidates.length > MAX_UPDATES) {
    throw new Error(`ABORT: ${candidates.length} candidates exceeds the ${MAX_UPDATES} safety ceiling. Re-verify selection (or pass --limit) before writing.`);
  }
  if (candidates.length === all.length && all.length > 0) {
    throw new Error(`ABORT: selection matched EVERY mission (${all.length}/${all.length}) — exclusions are not working. Refusing to write.`);
  }

  const legacyFreeText = candidates.filter((m) => m.category != null && String(m.category).trim() !== '');
  console.log(`\nCandidates (${candidates.length}) — ${legacyFreeText.length} carry legacy free text that will be REPLACED by a key:`);
  for (const m of candidates) {
    const from = m.category ? `"${short(m.category, 34)}"` : 'NULL';
    console.log(`  ${m.id.slice(0, 8)}  ${String(m.goal_type || '').padEnd(19)} ${from.padEnd(36)} ${short(m.title, 58)}`);
  }

  if (!APPLY) {
    if (PREVIEW_AI) {
      const n = Math.min(PREVIEW_AI, candidates.length);
      console.log(`\n--preview-ai ${PREVIEW_AI}: classifying the first ${n} candidate(s). Still writes NOTHING.`);
      for (const m of candidates.slice(0, n)) {
        const cat = await classify(m);
        console.log(`  ${m.id.slice(0, 8)}  ${short(m.title, 54).padEnd(56)} → ${cat === null ? '(failed — would stay NULL)' : cat}`);
      }
    }
    console.log(`\nDRY RUN — ${candidates.length} mission(s) would be classified and written. Nothing was read-modified, no AI calls were made${PREVIEW_AI ? ' beyond the explicit preview sample' : ''}.`);
    console.log('Re-run with --execute (OWNER ONLY) to write.');
    process.exit(0);
  }

  // ---- EXECUTE ----
  if (!process.env.ANTHROPIC_API_KEY) throw new Error('Need ANTHROPIC_API_KEY in .env for --execute');
  const phrase = `BACKFILL ${candidates.length} CATEGORY`;
  if (!(await confirmTyped(phrase))) {
    console.log('\nAborted — no rows written.');
    process.exit(1);
  }

  console.log('\nClassifying + writing...');
  let written = 0; let failed = 0; const tally = {};
  for (const m of candidates) {
    const category = await classify(m);
    if (category === null) { failed += 1; continue; }
    // Persisted columns MUST go through sanitizeMissionPatch or they are
    // silently dropped — updateMission() wraps it.
    const { error, rejected } = await updateMission(db, m.id, { category }, {
      caller: 'backfill-mission-category',
    });
    if (rejected && rejected.length) throw new Error(`ABORT: sanitizeMissionPatch rejected ${rejected.join(',')} — column not in the allow-list.`);
    if (error) { failed += 1; console.log(`    ! write failed ${m.id.slice(0, 8)}: ${error.message}`); continue; }
    tally[category] = (tally[category] || 0) + 1;
    written += 1;
    console.log(`  ${m.id.slice(0, 8)} → ${category}`);
  }

  console.log(`\nWROTE ${written} · FAILED ${failed}`);
  console.log('Distribution:');
  for (const [k, v] of Object.entries(tally).sort((a, b) => b[1] - a[1])) console.log(`  ${k.padEnd(30)} ${v}`);

  // Verify: re-select and confirm the candidate set shrank to (near) zero.
  const after = await selectCandidates(db);
  console.log(`\nPost-write check: ${after.candidates.length} candidate(s) remain (expected ${failed}).`);
  process.exit(after.candidates.length === failed ? 0 : 2);
})().catch((e) => { console.error('ERROR', e.message); process.exit(1); });
