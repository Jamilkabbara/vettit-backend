#!/usr/bin/env node
/*
 * dedupe-mission-responses.js
 * -----------------------------------------------------------------------------
 * Owner-run cleanup for duplicate rows in mission_responses.
 *
 * BACKGROUND
 * ----------
 * (mission_id, persona_id, question_id) is the natural key of the table — one
 * row per persona per question — but nothing enforced it. runMission is
 * re-enterable with {resume:true} (the idempotency claim is bypassed for
 * resume by design, and missionRecovery Job 3 re-enters every mission sitting
 * in status='processing'), and BOTH write paths inserted unconditionally. A
 * second invocation therefore appended a complete second copy of the dataset.
 *
 * The copies are NOT identical. Each came from its own generate+simulate run,
 * so the same persona_id carries a different persona_profile and different
 * answers in each copy (measured: 69-80% of duplicated keys have divergent
 * answers; 100% have divergent persona_profile). Reading the table back
 * therefore corrupts distributions and means — it is not a clean double-count
 * that cancels out in percentages.
 *
 * DRY RUN IS THE DEFAULT. It prints exactly which rows it would delete and
 * writes NOTHING. Deleting requires BOTH --execute AND a typed confirmation.
 * The owner runs --execute themselves; the build agent never does.
 *
 *   node scripts/dedupe-mission-responses.js                    # DRY RUN (safe, default)
 *   node scripts/dedupe-mission-responses.js --execute          # DELETE (prompts for typed confirm)
 *   node scripts/dedupe-mission-responses.js --execute --force  # DELETE, skip prompt (scripted)
 *
 * ORDERING — this script must run BEFORE
 * migrations/pass-48/01_mission_responses_unique_key.sql. That migration
 * creates a UNIQUE index on the natural key and CANNOT be applied while
 * duplicates exist (23505).
 *
 * WHICH ROW SURVIVES, AND WHY
 * ---------------------------
 * `id` is a UUID, so "lowest id" says nothing about insertion order.
 * `answered_at` is the insert timestamp and IS the ordering signal. The rule:
 *
 *   1. Group a mission's rows by persona_id. Within a persona, group by the
 *      exact persona_profile JSON — each distinct profile is one run's
 *      incarnation of that persona.
 *   2. The WINNING incarnation is the one whose earliest answered_at is
 *      earliest (ties broken deterministically by profile hash).
 *   3. For each question_id, keep the winning incarnation's row (earliest
 *      answered_at, then id, if it somehow has more than one). If the winning
 *      incarnation has no row for that question, fall back to the earliest row
 *      overall so no (persona, question) key is ever lost.
 *
 * Why earliest wins: the first copy belongs to the run that legitimately
 * claimed the mission (status paid -> processing). The later copy belongs to
 * the run that bypassed that claim via resume — the one that should never have
 * existed. Neither copy is "more accurate" (both are simulated), so the
 * tie-break that matters is COHERENCE: picking per-incarnation rather than
 * per-key stops the survivor set from stitching one persona out of two
 * different people's answers.
 *
 * Env (.env): SUPABASE_URL + SUPABASE_SERVICE_KEY (server-side service key --
 * never a client/anon key).
 */
require('dotenv').config();
const readline = require('readline');
const { createClient } = require('@supabase/supabase-js');

const APPLY = process.argv.includes('--execute');
const FORCE = process.argv.includes('--force');

const PAGE = 1000;
const DELETE_CHUNK = 100;

// Safety ceilings. The survey on 2026-08-31 found 785 duplicate rows across 3
// missions out of 9064 total. If the selection ever balloons past these, the
// selection logic is wrong — abort rather than mass-delete real data.
const MAX_DELETE_ROWS = 3000;
const MAX_DELETE_FRACTION = 0.25;

function chunk(arr, n) {
  const out = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

const stable = (v) => { try { return JSON.stringify(v); } catch { return String(v); } };

/** Insertion order: answered_at first, id as a deterministic tie-break. */
function byInsertOrder(a, b) {
  const ta = String(a.answered_at || '');
  const tb = String(b.answered_at || '');
  if (ta !== tb) return ta < tb ? -1 : 1;
  return String(a.id) < String(b.id) ? -1 : 1;
}

async function fetchMissionRows(db, missionId) {
  const rows = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await db
      .from('mission_responses')
      .select('id, persona_id, persona_profile, question_id, answer, answered_at')
      .eq('mission_id', missionId)
      .order('answered_at', { ascending: true })
      .order('id', { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) throw new Error(`mission_responses select failed (${missionId}): ${error.message}`);
    const page = data || [];
    rows.push(...page);
    if (page.length < PAGE) break;
  }
  return rows;
}

/**
 * THE ONE SELECTION FUNCTION. Both the dry-run preview and the --execute
 * delete call this and nothing else, so the filter cannot drift between what
 * the script says it will do and what it does.
 *
 * Returns { missions: [...per-mission report...], deleteIds: [...] }.
 */
async function selectDuplicateRows(db) {
  const { data: missions, error } = await db
    .from('missions')
    .select('id, title, status')
    .order('created_at', { ascending: true });
  if (error) throw new Error(`missions select failed: ${error.message}`);

  const report = [];
  const deleteIds = [];
  let totalRowsScanned = 0;
  let missionsWithRows = 0;

  for (const m of (missions || [])) {
    const { count, error: cErr } = await db
      .from('mission_responses')
      .select('id', { count: 'exact', head: true })
      .eq('mission_id', m.id);
    if (cErr) throw new Error(`count failed (${m.id}): ${cErr.message}`);
    if (!count) continue;
    missionsWithRows += 1;
    totalRowsScanned += count;

    const rows = await fetchMissionRows(db, m.id);
    const keys = new Set(rows.map((r) => `${r.persona_id}::${r.question_id}`));
    if (keys.size === rows.length) continue; // clean mission

    // ── per-persona incarnation selection (see header) ───────────────────
    const byPersona = new Map();
    for (const r of rows) {
      if (!byPersona.has(r.persona_id)) byPersona.set(r.persona_id, []);
      byPersona.get(r.persona_id).push(r);
    }

    const doomed = [];
    let incarnationsDropped = 0;
    let fallbackKeys = 0;
    for (const [, personaRows] of byPersona) {
      const byProfile = new Map();
      for (const r of personaRows) {
        const p = stable(r.persona_profile);
        if (!byProfile.has(p)) byProfile.set(p, []);
        byProfile.get(p).push(r);
      }
      let winner = null;
      let winnerFirst = null;
      for (const [p, prows] of byProfile) {
        const first = prows.slice().sort(byInsertOrder)[0];
        if (winner === null
          || byInsertOrder(first, winnerFirst) < 0
          || (byInsertOrder(first, winnerFirst) === 0 && p < winner)) {
          winner = p; winnerFirst = first;
        }
      }
      if (byProfile.size > 1) incarnationsDropped += byProfile.size - 1;

      const byQuestion = new Map();
      for (const r of personaRows) {
        if (!byQuestion.has(r.question_id)) byQuestion.set(r.question_id, []);
        byQuestion.get(r.question_id).push(r);
      }
      for (const [, qrows] of byQuestion) {
        const fromWinner = qrows.filter((r) => stable(r.persona_profile) === winner);
        const pool = fromWinner.length ? fromWinner : qrows;
        if (!fromWinner.length) fallbackKeys += 1;
        const keep = pool.slice().sort(byInsertOrder)[0];
        for (const r of qrows) if (r.id !== keep.id) doomed.push(r);
      }
    }

    // Divergence stats for the operator (is this a clean double or a mess?).
    const groups = new Map();
    for (const r of rows) {
      const k = `${r.persona_id}::${r.question_id}`;
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(r);
    }
    const hist = {};
    let dupKeys = 0; let divergentAnswers = 0;
    for (const [, g] of groups) {
      hist[g.length] = (hist[g.length] || 0) + 1;
      if (g.length > 1) {
        dupKeys += 1;
        if (new Set(g.map((r) => stable(r.answer))).size > 1) divergentAnswers += 1;
      }
    }

    report.push({
      missionId: m.id,
      title: m.title || '',
      status: m.status,
      rows: rows.length,
      distinctKeys: keys.size,
      toDelete: doomed.length,
      hist,
      dupKeys,
      divergentAnswers,
      incarnationsDropped,
      fallbackKeys,
    });
    for (const r of doomed) deleteIds.push(r.id);

    // Per-mission invariant: survivors must equal the distinct key count.
    if (rows.length - doomed.length !== keys.size) {
      throw new Error(
        `ABORT: mission ${m.id} — survivors ${rows.length - doomed.length} != distinct keys ${keys.size}. Selection logic is wrong.`,
      );
    }
  }

  return { missions: report, deleteIds, totalRowsScanned, missionsWithRows };
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
  console.log('KEY : (mission_id, persona_id, question_id) — keep 1 row per key');
  console.log('RULE: earliest-inserted persona incarnation wins; earliest row within it\n');

  const sel = await selectDuplicateRows(db);

  console.log(`Scanned ${sel.missionsWithRows} mission(s) with responses, ${sel.totalRowsScanned} row(s) total.`);
  console.log(`Missions containing duplicates: ${sel.missions.length}`);

  if (sel.deleteIds.length === 0) {
    console.log('\nNo duplicate rows found. Nothing to do — the pass-48 unique index can be applied.');
    process.exit(0);
  }

  for (const r of sel.missions) {
    console.log('');
    console.log(`  mission ${r.missionId}  [${r.status}]  "${r.title.slice(0, 55)}"`);
    console.log(`    rows=${r.rows}  distinct keys=${r.distinctKeys}  TO DELETE=${r.toDelete}  survivors=${r.rows - r.toDelete}`);
    console.log(`    multiplicity (copies -> #keys): ${JSON.stringify(r.hist)}`);
    console.log(`    duplicated keys=${r.dupKeys}  of which DIVERGENT answers=${r.divergentAnswers}`);
    console.log(`    persona incarnations dropped=${r.incarnationsDropped}  keys needing fallback=${r.fallbackKeys}`);
  }

  // ── Safety ceilings ──────────────────────────────────────────────────
  const fraction = sel.deleteIds.length / Math.max(sel.totalRowsScanned, 1);
  console.log('');
  console.log(`TOTAL to delete: ${sel.deleteIds.length} of ${sel.totalRowsScanned} rows (${(100 * fraction).toFixed(2)}%)`);
  if (sel.deleteIds.length > MAX_DELETE_ROWS) {
    throw new Error(`ABORT: ${sel.deleteIds.length} rows selected, above the ${MAX_DELETE_ROWS} safety ceiling.`);
  }
  if (fraction > MAX_DELETE_FRACTION) {
    throw new Error(`ABORT: selection is ${(100 * fraction).toFixed(1)}% of all rows, above the ${100 * MAX_DELETE_FRACTION}% ceiling.`);
  }
  if (new Set(sel.deleteIds).size !== sel.deleteIds.length) {
    throw new Error('ABORT: duplicate ids in the delete set — selection logic is wrong.');
  }

  if (!APPLY) {
    console.log(`\nDRY RUN — ${sel.deleteIds.length} row(s) would be deleted. Nothing was written.`);
    console.log('Re-run with --execute (owner only), THEN apply migrations/pass-48/01_mission_responses_unique_key.sql.');
    process.exit(0);
  }

  // ---- EXECUTE path ----
  const phrase = `DELETE ${sel.deleteIds.length} DUPLICATE RESPONSES`;
  const ok = await confirmTyped(phrase);
  if (!ok) {
    console.log('\nAborted — no rows deleted.');
    process.exit(1);
  }

  console.log('\nDeleting...');
  let deleted = 0;
  for (const ids of chunk(sel.deleteIds, DELETE_CHUNK)) {
    const { error, count } = await db
      .from('mission_responses')
      .delete({ count: 'exact' })
      .in('id', ids);
    if (error) throw new Error(`delete failed: ${error.message}`);
    deleted += count == null ? ids.length : count;
  }
  console.log(`Deleted ${deleted} row(s).`);

  // ---- Verify by re-running the SAME selection ----
  const after = await selectDuplicateRows(db);
  console.log(`\nPost-delete re-scan: ${after.deleteIds.length} duplicate row(s) remain (expected 0).`);
  if (after.deleteIds.length === 0) {
    console.log('Table is clean. Now apply migrations/pass-48/01_mission_responses_unique_key.sql.');
  }
  process.exit(after.deleteIds.length === 0 ? 0 : 2);
})().catch((e) => { console.error('ERROR', e.message); process.exit(1); });
