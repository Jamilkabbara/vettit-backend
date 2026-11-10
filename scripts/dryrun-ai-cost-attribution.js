#!/usr/bin/env node
/**
 * AI cost attribution — what can and cannot be attributed retroactively.
 *
 * THE PROBLEM (measured 2026-11-10)
 * ---------------------------------
 * ai_calls holds 4,902 rows / $36.15. 1,931 rows / $15.26 have mission_id
 * NULL, so the admin per-mission cost figure sees only $20.89 of real spend.
 *
 * There are TWO causes and they need different answers. This script proves
 * which rows fall under which, and refuses to invent an attribution.
 *
 * CAUSE A — the call runs BEFORE a mission row exists (still live today).
 *   survey_gen, targeting_suggest, subject_extract, adaptive_clarify,
 *   question_refine. These are setup-page calls: the customer is describing
 *   a study that does not exist yet. mission_id CANNOT be set at call time.
 *   Worse, until the fix that ships with this script they also dropped
 *   user_id, so most carry NO attribution evidence at all.
 *
 * CAUSE B — internal rehearsal and measurement runs (historical, stopped).
 *   response_sim / persona_gen / insight_synth / targeting_brief /
 *   report_summary rows with mission_id NULL cluster on 11 discrete days
 *   between 2026-06-12 and 2026-09-19, and 10 of those 11 days are entirely
 *   the owner's own account. The largest single day (2026-09-19, 526 rows,
 *   $2.21) is scripts/measure-panel-distinctness.js, which says in its own
 *   header that it hands the loop an in-memory stand-in for the database and
 *   logs "with no mission attached, so the spend stays visible".
 *   These calls never had a mission. There is nothing to attribute them to.
 *
 * WHY THE WINDOW METHOD IS TRUSTED HERE
 * -------------------------------------
 * Positive control: run the same "is this call inside a mission's run
 * window" test against rows that ARE attributed and it finds the row's own
 * mission for 1,634/1,817 response_sim and 829/862 persona_gen rows (90% /
 * 96%). Run it against the unattributed pipeline rows and 691 of 696
 * response_sim rows have no mission window at all. The absence is real, not
 * a search that does not work.
 *
 * CLASSIFICATION
 * --------------
 *   ATTRIBUTABLE        a pre-mission call where exactly one mission was
 *                       created in the following window AND the call carries
 *                       the same user_id. Two independent facts agree.
 *   TIME_ONLY           same, but user_id is NULL — the only evidence is
 *                       "a mission appeared shortly afterwards". NOT written.
 *   AMBIGUOUS           more than one candidate mission. NOT written.
 *   NO_MISSION          no mission followed / no run window contains it.
 *                       Cause B lives here. NOT written.
 *   BY_DESIGN           admin_insights, chat_dashboard, chat_admin_crm,
 *                       blog_gen — admin and account-wide surfaces that are
 *                       not about one mission. NOT written, ever.
 *
 * Only ATTRIBUTABLE is ever written, and only with --apply.
 *
 * USAGE
 *   railway run node scripts/dryrun-ai-cost-attribution.js            # preview
 *   railway run node scripts/dryrun-ai-cost-attribution.js --apply    # write
 *
 * Dry run and apply share ONE selection function (selectCandidates) so the
 * preview cannot drift from the execution.
 */

'use strict';

const { createClient } = require('@supabase/supabase-js');

const APPLY = process.argv.includes('--apply');

/** How long after a setup call a mission may appear and still be "its" mission. */
const FOLLOW_WINDOW_MINUTES = 10;

/** Calls that run before a mission row can exist. */
const PRE_MISSION_TYPES = new Set([
  'survey_gen', 'targeting_suggest', 'subject_extract',
  'adaptive_clarify', 'question_refine', 'brief_clarify',
]);

/** Account-wide / admin surfaces. Never belong to a single mission. */
const BY_DESIGN_TYPES = new Set([
  'admin_insights', 'chat_dashboard', 'chat_admin_crm', 'blog_gen',
]);

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

const ms = (t) => new Date(t).getTime();

/**
 * THE selection function. Both modes call this and nothing else decides what
 * gets written.
 *
 * @returns {Promise<{buckets: Object, rows: Array, totals: Object}>}
 */
async function selectCandidates(supabase) {
  const calls = await fetchAll(
    supabase, 'ai_calls', 'id, mission_id, user_id, call_type, cost_usd, created_at',
  );
  const missions = await fetchAll(
    supabase, 'missions', 'id, user_id, created_at, started_at, completed_at, heartbeat_at',
  );

  // Index missions by user for the window tests, plus a global list ordered by
  // creation for the "a mission appeared shortly afterwards" test.
  const byUser = new Map();
  for (const m of missions) {
    if (!m.user_id) continue;
    if (!byUser.has(m.user_id)) byUser.set(m.user_id, []);
    byUser.get(m.user_id).push(m);
  }
  const allByCreated = [...missions].sort((a, b) => ms(a.created_at) - ms(b.created_at));

  const windowStart = (m) => ms(m.started_at || m.created_at);
  const windowEnd = (m) => ms(m.completed_at || m.heartbeat_at || (windowStart(m) + 6 * 3600 * 1000));

  const rows = [];
  for (const c of calls) {
    if (c.mission_id) continue; // already attributed, nothing to do

    const cost = Number(c.cost_usd || 0);
    const at = ms(c.created_at);
    const base = {
      id: c.id, call_type: c.call_type, user_id: c.user_id,
      cost, created_at: c.created_at,
    };

    if (BY_DESIGN_TYPES.has(c.call_type)) {
      rows.push({ ...base, verdict: 'BY_DESIGN', missionId: null, evidence: 'account-wide or admin surface' });
      continue;
    }

    if (PRE_MISSION_TYPES.has(c.call_type)) {
      // Which missions were created in the window just after this call?
      const limit = at + FOLLOW_WINDOW_MINUTES * 60 * 1000;
      const pool = c.user_id ? (byUser.get(c.user_id) || []) : allByCreated;
      const following = pool.filter((m) => {
        const t = ms(m.created_at);
        return t >= at && t < limit;
      });
      if (following.length === 1) {
        rows.push({
          ...base,
          verdict: c.user_id ? 'ATTRIBUTABLE' : 'TIME_ONLY',
          missionId: following[0].id,
          evidence: c.user_id
            ? `same user_id + mission created ${Math.round((ms(following[0].created_at) - at) / 1000)}s later`
            : `mission created ${Math.round((ms(following[0].created_at) - at) / 1000)}s later; NO user_id to corroborate`,
        });
      } else if (following.length > 1) {
        rows.push({ ...base, verdict: 'AMBIGUOUS', missionId: null, evidence: `${following.length} missions in the window` });
      } else {
        rows.push({ ...base, verdict: 'NO_MISSION', missionId: null, evidence: 'no mission created in the window' });
      }
      continue;
    }

    // Pipeline types (response_sim, persona_gen, insight_synth, ...). These
    // only ever run for a mission, so the test is whether any mission's RUN
    // window contains the call.
    const pool = c.user_id ? (byUser.get(c.user_id) || []) : [];
    const containing = pool.filter((m) => at >= windowStart(m) && at <= windowEnd(m));
    if (containing.length === 1) {
      rows.push({
        ...base, verdict: 'ATTRIBUTABLE', missionId: containing[0].id,
        evidence: 'same user_id + inside exactly one mission run window',
      });
    } else if (containing.length > 1) {
      rows.push({ ...base, verdict: 'AMBIGUOUS', missionId: null, evidence: `${containing.length} overlapping run windows` });
    } else {
      rows.push({
        ...base, verdict: 'NO_MISSION', missionId: null,
        evidence: c.user_id ? 'no mission run window contains this call' : 'no user_id and no mission',
      });
    }
  }

  const buckets = {};
  for (const r of rows) {
    const b = (buckets[r.verdict] ||= { verdict: r.verdict, rows: 0, spend: 0, byType: {} });
    b.rows += 1;
    b.spend += r.cost;
    const t = (b.byType[r.call_type] ||= { rows: 0, spend: 0 });
    t.rows += 1;
    t.spend += r.cost;
  }

  const totals = {
    unattributedRows: rows.length,
    unattributedSpend: rows.reduce((s, r) => s + r.cost, 0),
    writableRows: rows.filter((r) => r.verdict === 'ATTRIBUTABLE').length,
    writableSpend: rows.filter((r) => r.verdict === 'ATTRIBUTABLE').reduce((s, r) => s + r.cost, 0),
  };

  return { buckets, rows, totals };
}

const usd = (v) => `$${v.toFixed(4)}`;
const pad = (s, n) => String(s).padEnd(n);
const lpad = (s, n) => String(s).padStart(n);

(async () => {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    console.error('Missing SUPABASE_URL / SUPABASE_SERVICE_KEY in the environment.');
    process.exit(1);
  }
  const supabase = createClient(url, key);

  const { buckets, rows, totals } = await selectCandidates(supabase);

  console.log(APPLY ? '=== APPLY (writes ai_calls.mission_id) ===' : '=== DRY RUN (no writes) ===');
  console.log(`unattributed rows : ${totals.unattributedRows}`);
  console.log(`unattributed spend: ${usd(totals.unattributedSpend)}`);
  console.log('');
  console.log(`${pad('VERDICT', 14)}${lpad('ROWS', 7)}${lpad('SPEND', 12)}  WRITTEN?`);
  console.log('-'.repeat(50));
  const order = ['ATTRIBUTABLE', 'TIME_ONLY', 'AMBIGUOUS', 'NO_MISSION', 'BY_DESIGN'];
  for (const v of order) {
    const b = buckets[v];
    if (!b) continue;
    console.log(`${pad(v, 14)}${lpad(b.rows, 7)}${lpad(usd(b.spend), 12)}  ${v === 'ATTRIBUTABLE' ? 'yes' : 'no'}`);
  }
  console.log('');

  for (const v of order) {
    const b = buckets[v];
    if (!b) continue;
    console.log(`${v} by call_type:`);
    for (const [t, s] of Object.entries(b.byType).sort((a, c) => c[1].spend - a[1].spend)) {
      console.log(`  ${pad(t, 22)}${lpad(s.rows, 6)} rows ${lpad(usd(s.spend), 12)}`);
    }
    console.log('');
  }

  const writable = rows.filter((r) => r.verdict === 'ATTRIBUTABLE');
  console.log(`WOULD MOVE: ${writable.length} rows, ${usd(totals.writableSpend)}`);
  for (const r of writable.slice(0, 40)) {
    console.log(`  ${r.call_type.padEnd(20)} ${usd(r.cost).padStart(10)}  -> ${r.missionId}  (${r.evidence})`);
  }
  if (writable.length > 40) console.log(`  ... and ${writable.length - 40} more`);

  if (!APPLY) {
    console.log('\nDRY RUN — nothing was written. Re-run with --apply to write the ATTRIBUTABLE rows.');
    return;
  }

  // Apply: set mission_id on the ATTRIBUTABLE rows only. Historical cost rows
  // are never edited beyond adding the attribution, and nothing else moves.
  let done = 0;
  for (const r of writable) {
    const { error } = await supabase.from('ai_calls').update({ mission_id: r.missionId }).eq('id', r.id);
    if (error) throw new Error(`ai_calls ${r.id}: ${error.message}`);
    done += 1;
  }
  console.log(`\nWROTE mission_id on ${done} ai_calls row(s), ${usd(totals.writableSpend)}.`);
  console.log('missions.ai_cost_usd is NOT touched here — re-run');
  console.log('scripts/backfill-mission-ai-spend.js afterwards to rebuild the mission totals.');
})().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
