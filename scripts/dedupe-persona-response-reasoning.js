#!/usr/bin/env node
/*
 * dedupe-persona-response-reasoning.js
 * -----------------------------------------------------------------------------
 * Owner-run cleanup for duplicate rows in persona_response_reasoning.
 *
 * BACKGROUND
 * ----------
 * (mission_id, persona_id, question_id) is the natural key of this table — at
 * most one "why" trace per persona per question — and nothing enforced it.
 * runMission's completion block builds `reasoningRows` from the SAME in-memory
 * `responses` array that feeds mission_responses and pushed it through a
 * second UNCONDITIONAL chunked insert, so every mechanism that duplicated
 * mission_responses (a run re-entered with {resume:true}, which bypasses the
 * idempotency claim by design and is triggered by missionRecovery Job 3)
 * duplicated this table in lockstep.
 *
 * Survey 2026-08-31 (read-only): 1865 rows across 42 missions, 15 duplicates
 * in ONE mission — af36a36d-401d-48e6-b94b-257e215613e2, 37 rows / 22 distinct
 * keys, the SAME shape that mission_responses shows for that mission.
 *
 * Far narrower than mission_responses for a structural reason: reasoning is
 * only written for missions with <= 50 personas (Pass 22 Bug 22.14) and only
 * where the simulator emitted a reasoning string. The other two duplicated
 * missions have zero reasoning rows and cannot be affected.
 *
 * The copies are NOT identical: 10/10 duplicated keys carry divergent
 * reasoning_text and 8/10 divergent response_value. GET /api/results/
 * :missionId/reasoning filters by response_value and orders created_at
 * DESCENDING, so today that modal shows the same persona several times giving
 * contradictory reasons, latest-run-first — the run that should never have run.
 *
 * DRY RUN IS THE DEFAULT. It prints exactly which rows it would delete and
 * writes NOTHING. Deleting requires BOTH --execute AND a typed confirmation.
 * The owner runs --execute themselves; the build agent never does.
 *
 *   node scripts/dedupe-persona-response-reasoning.js                    # DRY RUN (safe, default)
 *   node scripts/dedupe-persona-response-reasoning.js --execute          # DELETE (prompts for typed confirm)
 *   node scripts/dedupe-persona-response-reasoning.js --execute --force  # DELETE, skip prompt (scripted)
 *
 * ORDERING — this script must run BEFORE
 * migrations/pass-48/02_persona_response_reasoning_unique_key.sql, which
 * cannot be applied while duplicates exist (23505). It has NO ordering
 * relationship to the mission_responses dedupe or to 01_*.sql: different
 * table, independent cleanup.
 *
 * WHICH ROW SURVIVES, AND WHY
 * ---------------------------
 * `id` is a UUID, so "lowest id" says nothing about insertion order.
 * `created_at` is the insert timestamp and IS the ordering signal — and here
 * it does more than order: every row of one chunked insert carries the SAME
 * created_at, so created_at IS the run identifier. Verified on af36a36d,
 * which has exactly three distinct values, one per run:
 *
 *   20:01:20.376564   5 rows  (P001-P005)
 *   20:01:50.593281  22 rows  (P001-P010)
 *   20:02:24.638777  10 rows  (P001-P010)
 *
 * That makes this the exact analogue of the mission_responses rule, which
 * groups by persona_profile to identify a run's "incarnation" of a persona.
 * This table has no persona_profile column; created_at is the discriminator
 * that is available, and it identifies the same runs. The rule:
 *
 *   1. Group a mission's rows by persona_id. Within a persona, group by
 *      created_at — each distinct value is one run's incarnation.
 *   2. The WINNING incarnation is the earliest created_at (ties broken
 *      deterministically by id).
 *   3. For each question_id, keep the winning incarnation's row. If the
 *      winning incarnation has no row for that question, fall back to the
 *      earliest row overall so no (persona, question) key is ever lost.
 *
 * Why earliest wins: the first copy belongs to the run that legitimately
 * claimed the mission (status paid -> processing); the later copies belong to
 * runs that bypassed that claim via resume. Neither is "more accurate" (both
 * are simulated), so the tie-break that matters is COHERENCE — picking
 * per-incarnation rather than per-key stops a persona's surviving traces from
 * being stitched together out of two different simulated people.
 *
 * PROVEN COHERENT WITH mission_responses. Because both tables are written
 * from one array per run, choosing the earliest run per persona selects the
 * SAME run in both. Verified against production before this script shipped:
 * all 22 surviving reasoning rows carry exactly the response_value of the
 * mission_responses row that survives the pass-48 mission_responses rule
 * (22 match / 0 mismatch), and both rules independently leave the same two
 * personas (P003, P005) spanning more than one run. The script re-checks
 * this at runtime and reports it (informational, never blocking — it holds
 * whether or not the mission_responses dedupe has been run yet).
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

// Safety ceilings. The survey on 2026-08-31 found 15 duplicate rows in 1
// mission out of 1865 total. If the selection ever balloons past these, the
// selection logic is wrong — abort rather than mass-delete real data.
const MAX_DELETE_ROWS = 500;
const MAX_DELETE_FRACTION = 0.25;

const TABLE = 'persona_response_reasoning';

function chunk(arr, n) {
  const out = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

/** Insertion order: created_at first, id as a deterministic tie-break. */
function byInsertOrder(a, b) {
  const ta = String(a.created_at || '');
  const tb = String(b.created_at || '');
  if (ta !== tb) return ta < tb ? -1 : 1;
  return String(a.id) < String(b.id) ? -1 : 1;
}

/**
 * Page the whole table. Unlike the mission_responses dedupe (which walks
 * mission by mission because that table is ~9k rows and growing), this table
 * is ~1.9k rows total, so one ordered pass is cheaper than a head-count per
 * mission. The explicit .order() is not cosmetic: without a deterministic
 * total order PostgREST paging can silently drop or repeat rows.
 */
async function fetchAllRows(db) {
  const rows = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await db
      .from(TABLE)
      .select('id, mission_id, persona_id, question_id, response_value, reasoning_text, created_at')
      .order('created_at', { ascending: true })
      .order('id', { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) throw new Error(`${TABLE} select failed: ${error.message}`);
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
  const all = await fetchAllRows(db);

  // Cross-check the paged read against the server's own count. A short read
  // here would make the script under-delete and silently leave duplicates
  // that then fail the migration.
  const { count, error: cErr } = await db.from(TABLE).select('id', { count: 'exact', head: true });
  if (cErr) throw new Error(`${TABLE} count failed: ${cErr.message}`);
  if (count != null && all.length !== count) {
    throw new Error(`ABORT: paged ${all.length} rows but the table reports ${count}. Refusing to act on a partial read.`);
  }

  const { data: missionMeta, error: mErr } = await db
    .from('missions')
    .select('id, title, status');
  if (mErr) throw new Error(`missions select failed: ${mErr.message}`);
  const meta = new Map((missionMeta || []).map((m) => [m.id, m]));

  const byMission = new Map();
  for (const r of all) {
    if (!byMission.has(r.mission_id)) byMission.set(r.mission_id, []);
    byMission.get(r.mission_id).push(r);
  }

  const report = [];
  const deleteIds = [];

  for (const [missionId, rows] of byMission) {
    const keys = new Set(rows.map((r) => `${r.persona_id}::${r.question_id}`));
    if (keys.size === rows.length) continue; // clean mission

    // ── per-persona incarnation selection (see header) ───────────────────
    const byPersona = new Map();
    for (const r of rows) {
      if (!byPersona.has(r.persona_id)) byPersona.set(r.persona_id, []);
      byPersona.get(r.persona_id).push(r);
    }

    const doomed = [];
    const survivors = [];
    let incarnationsDropped = 0;
    let fallbackKeys = 0;
    for (const [, personaRows] of byPersona) {
      const byRun = new Map();
      for (const r of personaRows) {
        const k = String(r.created_at);
        if (!byRun.has(k)) byRun.set(k, []);
        byRun.get(k).push(r);
      }
      let winner = null;
      let winnerFirst = null;
      for (const [k, rs] of byRun) {
        const first = rs.slice().sort(byInsertOrder)[0];
        if (winner === null
          || byInsertOrder(first, winnerFirst) < 0
          || (byInsertOrder(first, winnerFirst) === 0 && k < winner)) {
          winner = k; winnerFirst = first;
        }
      }
      if (byRun.size > 1) incarnationsDropped += byRun.size - 1;

      const byQuestion = new Map();
      for (const r of personaRows) {
        if (!byQuestion.has(r.question_id)) byQuestion.set(r.question_id, []);
        byQuestion.get(r.question_id).push(r);
      }
      for (const [, qrows] of byQuestion) {
        const fromWinner = qrows.filter((r) => String(r.created_at) === winner);
        const pool = fromWinner.length ? fromWinner : qrows;
        if (!fromWinner.length) fallbackKeys += 1;
        const keep = pool.slice().sort(byInsertOrder)[0];
        survivors.push(keep);
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
    let dupKeys = 0; let divergentReasoning = 0; let divergentValues = 0;
    for (const [, g] of groups) {
      hist[g.length] = (hist[g.length] || 0) + 1;
      if (g.length > 1) {
        dupKeys += 1;
        if (new Set(g.map((r) => r.reasoning_text)).size > 1) divergentReasoning += 1;
        if (new Set(g.map((r) => String(r.response_value))).size > 1) divergentValues += 1;
      }
    }

    // Coherence with mission_responses (informational). Every surviving
    // reasoning row should quote an answer that mission_responses actually
    // holds for that key. True regardless of whether the mission_responses
    // dedupe has run, so it is safe to check in any order.
    const mrRows = [];
    for (let from = 0; ; from += PAGE) {
      const { data, error } = await db
        .from('mission_responses')
        .select('persona_id, question_id, answer')
        .eq('mission_id', missionId)
        .order('id', { ascending: true })
        .range(from, from + PAGE - 1);
      if (error) throw new Error(`mission_responses select failed (${missionId}): ${error.message}`);
      const page = data || [];
      mrRows.push(...page);
      if (page.length < PAGE) break;
    }
    const norm = (a) => (Array.isArray(a) ? a.join(', ') : (a == null ? null : String(a)));
    const answersByKey = new Map();
    for (const r of mrRows) {
      const k = `${r.persona_id}::${r.question_id}`;
      if (!answersByKey.has(k)) answersByKey.set(k, new Set());
      answersByKey.get(k).add(norm(r.answer));
    }
    let coherent = 0; let incoherent = 0; let unknownKey = 0;
    for (const s of survivors) {
      const k = `${s.persona_id}::${s.question_id}`;
      if (!answersByKey.has(k)) { unknownKey += 1; continue; }
      if (answersByKey.get(k).has(s.response_value)) coherent += 1; else incoherent += 1;
    }

    const m = meta.get(missionId) || {};
    report.push({
      missionId,
      title: m.title || '',
      status: m.status || '?',
      rows: rows.length,
      distinctKeys: keys.size,
      toDelete: doomed.length,
      hist,
      dupKeys,
      divergentReasoning,
      divergentValues,
      incarnationsDropped,
      fallbackKeys,
      coherent,
      incoherent,
      unknownKey,
    });
    for (const r of doomed) deleteIds.push(r.id);

    // Per-mission invariant: survivors must equal the distinct key count.
    if (rows.length - doomed.length !== keys.size) {
      throw new Error(
        `ABORT: mission ${missionId} — survivors ${rows.length - doomed.length} != distinct keys ${keys.size}. Selection logic is wrong.`,
      );
    }
  }

  return {
    missions: report,
    deleteIds,
    totalRowsScanned: all.length,
    missionsWithRows: byMission.size,
  };
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
  console.log(`TABLE: ${TABLE}`);
  console.log('KEY : (mission_id, persona_id, question_id) — keep 1 row per key');
  console.log('RULE: earliest created_at run wins per persona; earliest row within it\n');

  const sel = await selectDuplicateRows(db);

  console.log(`Scanned ${sel.missionsWithRows} mission(s) with reasoning rows, ${sel.totalRowsScanned} row(s) total.`);
  console.log(`Missions containing duplicates: ${sel.missions.length}`);

  if (sel.deleteIds.length === 0) {
    console.log(`\nNo duplicate rows found. Nothing to do — migrations/pass-48/02_persona_response_reasoning_unique_key.sql can be applied.`);
    process.exit(0);
  }

  for (const r of sel.missions) {
    console.log('');
    console.log(`  mission ${r.missionId}  [${r.status}]  "${r.title.slice(0, 55)}"`);
    console.log(`    rows=${r.rows}  distinct keys=${r.distinctKeys}  TO DELETE=${r.toDelete}  survivors=${r.rows - r.toDelete}`);
    console.log(`    multiplicity (copies -> #keys): ${JSON.stringify(r.hist)}`);
    console.log(`    duplicated keys=${r.dupKeys}  divergent reasoning_text=${r.divergentReasoning}  divergent response_value=${r.divergentValues}`);
    console.log(`    run incarnations dropped=${r.incarnationsDropped}  keys needing fallback=${r.fallbackKeys}`);
    console.log(`    coherence vs mission_responses: ${r.coherent} match, ${r.incoherent} mismatch, ${r.unknownKey} key absent`);
    if (r.incoherent > 0) {
      console.log('    NOTE: mismatches mean a surviving trace quotes an answer mission_responses does not hold for that key.');
    }
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
    console.log('Re-run with --execute (owner only), THEN apply migrations/pass-48/02_persona_response_reasoning_unique_key.sql.');
    process.exit(0);
  }

  // ---- EXECUTE path ----
  const phrase = `DELETE ${sel.deleteIds.length} DUPLICATE REASONING`;
  const ok = await confirmTyped(phrase);
  if (!ok) {
    console.log('\nAborted — no rows deleted.');
    process.exit(1);
  }

  console.log('\nDeleting...');
  let deleted = 0;
  for (const ids of chunk(sel.deleteIds, DELETE_CHUNK)) {
    const { error, count } = await db
      .from(TABLE)
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
    console.log('Table is clean. Now apply migrations/pass-48/02_persona_response_reasoning_unique_key.sql.');
  }
  process.exit(after.deleteIds.length === 0 ? 0 : 2);
})().catch((e) => { console.error('ERROR', e.message); process.exit(1); });
