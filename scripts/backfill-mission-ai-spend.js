#!/usr/bin/env node
/**
 * Rebuild missions.ai_cost_usd / ai_spend_usd_actual from the ai_calls log.
 *
 *   node scripts/backfill-mission-ai-spend.js          # DRY RUN (no writes)
 *   node scripts/backfill-mission-ai-spend.js --apply  # write the corrected totals
 *
 * WHY. Claude vision is called directly rather than through callClaude, because
 * it needs raw image blocks. The rollup onto the mission lived INSIDE
 * callClaude, so every vision call logged its cost to ai_calls and then never
 * reached the mission total. That total is what the admin cost panel reads and
 * what the recruit loop compares its ceiling against, so it has been
 * understating creative-attention missions by up to 20x.
 *
 * The code path is fixed going forward (recordMissionAiSpend, PR #154). This
 * repairs the rows written before that.
 *
 * ai_calls is the record of truth: one row per call, written at the call site
 * with the tokens and cost that call actually incurred. The mission columns are
 * a denormalised running sum of it. Where they disagree, ai_calls is right.
 *
 * SAFETY
 *   - selectCandidates() is the ONE selection function. The dry run and the
 *     apply run both call it, so the set reported can never drift from the set
 *     written. (A previous backfill in this repo reported 1 candidate and wrote
 *     17 because the dry run had its own inline filter.)
 *   - Missions still running are SKIPPED. ai_spend_usd_actual is live input to
 *     the recruit loop's ceiling check; rewriting it mid-run would move the
 *     budget under a mission that is spending against it.
 *   - Writes are per-row and report their own failure. Some historical rows
 *     violate a NOT VALID CHECK constraint (the creative-attention respondent
 *     floor), and Postgres re-checks those on ANY update, including one that
 *     touches unrelated columns. Those rows are expected to fail and are
 *     listed, not retried.
 *   - Nothing is deleted and no cost is invented. A mission with no ai_calls
 *     rows is left exactly as it is.
 */
require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

const APPLY = process.argv.includes('--apply');

/** Statuses whose ai_spend_usd_actual is live input to a running loop. */
const RUNNING = new Set(['processing']);

const round4 = (v) => Math.round(v * 10000) / 10000;

/** Page a table fully; PostgREST caps an unbounded select at 1000 rows. */
async function fetchAll(supabase, table, columns, tweak = (q) => q) {
  const out = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await tweak(
      supabase.from(table).select(columns).order('id').range(from, from + 999),
    );
    if (error) throw new Error(`${table}: ${error.message}`);
    out.push(...data);
    if (data.length < 1000) return out;
  }
}

/**
 * THE selection function. Both modes call this and nothing else decides what
 * gets written.
 *
 * @returns {Promise<{candidates: Array, skippedRunning: Array, noCalls: number}>}
 */
async function selectCandidates(supabase) {
  const missions = await fetchAll(
    supabase, 'missions', 'id, goal_type, status, ai_cost_usd, ai_spend_usd_actual',
  );
  const calls = await fetchAll(supabase, 'ai_calls', 'mission_id, cost_usd');

  const realByMission = new Map();
  for (const c of calls) {
    if (!c.mission_id) continue;
    realByMission.set(c.mission_id, (realByMission.get(c.mission_id) || 0) + Number(c.cost_usd || 0));
  }

  const candidates = [];
  const skippedRunning = [];
  let noCalls = 0;

  for (const m of missions) {
    if (!realByMission.has(m.id)) { noCalls += 1; continue; }
    const real = round4(realByMission.get(m.id));
    const recordedSpend = Number(m.ai_spend_usd_actual || 0);
    const recordedCost = Number(m.ai_cost_usd || 0);
    // Only rows that actually disagree, beyond float noise.
    if (Math.abs(real - recordedSpend) < 0.00005 && Math.abs(real - recordedCost) < 0.00005) continue;
    const row = {
      id: m.id, goal_type: m.goal_type, status: m.status,
      recordedSpend, recordedCost, real, delta: round4(real - recordedSpend),
    };
    if (RUNNING.has(m.status)) { skippedRunning.push(row); continue; }
    candidates.push(row);
  }

  candidates.sort((a, b) => b.delta - a.delta);
  return { candidates, skippedRunning, noCalls };
}

(async () => {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) { console.error('Missing SUPABASE_URL / SUPABASE_SERVICE_KEY in .env'); process.exit(1); }
  const supabase = createClient(url, key);

  const { candidates, skippedRunning, noCalls } = await selectCandidates(supabase);

  console.log(APPLY ? '=== APPLY ===' : '=== DRY RUN (no writes) ===');
  console.log(`missions with ai_calls but a wrong total : ${candidates.length}`);
  console.log(`skipped, still running                   : ${skippedRunning.length}`);
  console.log(`missions with no ai_calls (left alone)   : ${noCalls}`);
  console.log();

  if (candidates.length) {
    const understated = candidates.filter((c) => c.delta > 0);
    const overstated = candidates.filter((c) => c.delta < 0);
    const sumRec = candidates.reduce((a, c) => a + c.recordedSpend, 0);
    const sumReal = candidates.reduce((a, c) => a + c.real, 0);
    console.log(`recorded total across them : $${sumRec.toFixed(4)}`);
    console.log(`real total from ai_calls   : $${sumReal.toFixed(4)}`);
    console.log(`net correction             : ${sumReal >= sumRec ? '+' : ''}$${(sumReal - sumRec).toFixed(4)}`);
    console.log(`understated ${understated.length}, overstated ${overstated.length}`);
    // Three separate causes are mixed together in this set, and ai_calls is the
    // truth for all three, which is why one rebuild fixes them all:
    //   1. vision calls never rolled up at all (creative attention, PR #154)
    //   2. ai_spend_usd_actual was added later and never backfilled, so it sits
    //      at the clarify-call cost while the legacy ai_cost_usd is correct
    //   3. float rounding, a hundredth of a cent
    const material = candidates.filter((c) => Math.abs(c.delta) >= 0.001);
    console.log(`material (>= $0.001) ${material.length}, rounding-only ${candidates.length - material.length}`);
    console.log(`material correction  ${material.reduce((a, c) => a + c.delta, 0) >= 0 ? '+' : ''}$${material.reduce((a, c) => a + c.delta, 0).toFixed(4)}`);
    console.log();
    console.log('id        goal_type            status       recorded      real       delta   x');
    for (const c of candidates) {
      const x = c.recordedSpend > 0 ? (c.real / c.recordedSpend).toFixed(1) + 'x' : 'n/a';
      console.log(
        `${c.id.slice(0, 8)}  ${(c.goal_type || '').padEnd(20)} ${(c.status || '').padEnd(11)}` +
        `${('$' + c.recordedSpend.toFixed(4)).padStart(11)}${('$' + c.real.toFixed(4)).padStart(11)}` +
        `${((c.delta >= 0 ? '+' : '') + '$' + c.delta.toFixed(4)).padStart(12)}  ${x}`,
      );
    }
    console.log();
  }

  if (skippedRunning.length) {
    console.log('SKIPPED (still running — their ceiling is live):');
    for (const c of skippedRunning) console.log(`  ${c.id.slice(0, 8)}  ${c.goal_type}  recorded $${c.recordedSpend.toFixed(4)}  real $${c.real.toFixed(4)}`);
    console.log();
  }

  if (!APPLY) {
    console.log('Dry run only. Re-run with --apply to write these totals.');
    return;
  }

  let ok = 0;
  const failed = [];
  for (const c of candidates) {
    const { error } = await supabase
      .from('missions')
      .update({ ai_cost_usd: c.real, ai_spend_usd_actual: c.real })
      .eq('id', c.id)
      // Do not write over a mission that started running since selection.
      .not('status', 'eq', 'processing');
    if (error) failed.push({ id: c.id, msg: error.message });
    else ok += 1;
  }
  console.log(`written: ${ok}/${candidates.length}`);
  if (failed.length) {
    console.log(`failed : ${failed.length} (expected for rows that violate the creative-attention respondent floor — Postgres re-checks a NOT VALID constraint on any update)`);
    for (const f of failed) console.log(`  ${f.id.slice(0, 8)}  ${f.msg.slice(0, 90)}`);
  }
})().catch((e) => { console.error(e); process.exit(1); });
