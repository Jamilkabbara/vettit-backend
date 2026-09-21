#!/usr/bin/env node
/**
 * Flag the studies produced before the quality fixes of 20 September.
 *
 * Four defects were live at various points before that date. Each is decided
 * from the study's OWN stored data, not from a date, so the flag says what is
 * actually wrong with that study:
 *
 *   wrong_country      respondents outside the markets the study targeted
 *                      (services/missions/effectiveTargeting.js; the setup page
 *                      never saved targeting, so personas came back "Global")
 *   duplicate_people   the panel repeats the same person
 *                      (services/ai/panelDistinctness.js)
 *   undeclinable_q     a multi-select nobody could decline: no "none of these"
 *                      (services/ai/multiSelectHygiene.js)
 *   misfiled_answers   an answer filed under a question that never offered it
 *                      (services/ai/simulate.js answerFitsQuestion)
 *
 * Nothing is deleted and nothing is rewritten. The only write is the flag
 * itself, so the studies stay exactly as they were delivered.
 *
 * Dry run by default; --run applies. Both share selectFlagged(), so the
 * preview cannot drift from what executes.
 *
 *   railway run node scripts/flag-pre-fix-studies.js
 *   railway run node scripts/flag-pre-fix-studies.js --run
 */
'use strict';

const supabase = require('../src/db/supabase');
const fetchAllResponses = require('../src/db/fetchAllResponses');
const { measurePanel } = require('../src/services/ai/panelDistinctness');
const { findViolations } = require('../src/services/ai/multiSelectHygiene');
const { answerFitsQuestion } = require('../src/services/ai/simulate');
const { resolveEffectiveTargeting } = require('../src/services/missions/effectiveTargeting');

const DO_RUN = process.argv.includes('--run');

/** ISO country code of a persona, if it recorded one. */
const countryOf = (p) => String((p && (p.country || p.country_code)) || '').trim().toUpperCase();

/**
 * One selection, used by the preview and by the write.
 * @returns {Promise<Array<{id, flags: string[], evidence: object}>>}
 */
async function selectFlagged() {
  const { data: missions, error } = await supabase
    .from('missions')
    .select('id, title, goal_type, status, created_at, completed_at, respondent_count, questions, targeting, target_audience, quality_flags')
    .eq('status', 'completed')
    .order('created_at', { ascending: true });
  if (error) throw error;

  const out = [];
  for (const m of missions) {
    const { data: rows, error: rErr } = await fetchAllResponses(supabase, {
      missionId: m.id,
      columns: 'persona_id, persona_profile, question_id, answer',
      eq: { screened_out: false },
      label: 'flag-pre-fix-studies',
    });
    if (rErr) throw rErr;
    if (!rows || rows.length === 0) continue;          // nothing was delivered

    const personas = new Map();
    const answers = {};
    for (const r of rows) {
      if (!personas.has(r.persona_id)) personas.set(r.persona_id, { ...(r.persona_profile || {}), id: r.persona_id });
      (answers[r.persona_id] = answers[r.persona_id] || {})[r.question_id] = r.answer;
    }
    const panel = [...personas.values()];
    const flags = [];
    const evidence = {};

    // 1. Respondents outside the targeted markets.
    const effective = resolveEffectiveTargeting(m);
    const wanted = (effective.countries || []).map((c) => String(c).toUpperCase()).filter(Boolean);
    if (wanted.length) {
      const strays = panel.filter((p) => countryOf(p) && !wanted.includes(countryOf(p)));
      if (strays.length) {
        flags.push('wrong_country');
        evidence.wrong_country = { targeted: wanted, outside: strays.length, of: panel.length };
      }
    }

    // 2. The panel repeats the same people.
    const distinct = measurePanel(panel, { answersByPersona: answers });
    if (!distinct.pass) {
      flags.push('duplicate_people');
      evidence.duplicate_people = { distinct: distinct.distinct, of: distinct.n, reasons: distinct.reasons };
    }

    // 3. A question nobody could decline.
    const qViolations = findViolations(Array.isArray(m.questions) ? m.questions : []);
    const noEscape = qViolations.filter((v) => v.rule === 'missing_escape_option');
    if (noEscape.length) {
      flags.push('undeclinable_q');
      evidence.undeclinable_q = { questions: [...new Set(noEscape.map((v) => v.questionId))] };
    }

    // 4. An answer filed under a question that never offered it.
    const byId = Object.fromEntries((m.questions || []).map((q) => [q.id, q]));
    let misfiled = 0;
    const misfiledQs = new Set();
    for (const r of rows) {
      const q = byId[r.question_id];
      if (!q) continue;
      if (!answerFitsQuestion(q, r.answer)) { misfiled += 1; misfiledQs.add(r.question_id); }
    }
    if (misfiled) {
      flags.push('misfiled_answers');
      evidence.misfiled_answers = { answers: misfiled, of: rows.length, questions: [...misfiledQs] };
    }

    if (flags.length) {
      out.push({
        id: m.id,
        title: m.title,
        goal_type: m.goal_type,
        completed: (m.completed_at || m.created_at || '').slice(0, 10),
        n: panel.length,
        flags,
        evidence,
        already: Array.isArray(m.quality_flags) ? m.quality_flags : [],
      });
    }
  }
  return out;
}

(async () => {
  const flagged = await selectFlagged();
  const byFlag = {};
  for (const f of flagged) for (const flag of f.flags) byFlag[flag] = (byFlag[flag] || 0) + 1;

  console.log(`\n${flagged.length} completed studies carry at least one defect.\n`);
  console.log('By defect:', JSON.stringify(byFlag));
  console.log('');
  for (const f of flagged) {
    console.log(`  ${f.id.slice(0, 8)}  ${f.completed}  n=${String(f.n).padStart(3)}  ${f.flags.join(', ')}`);
  }

  console.log('\nStatements this will run (one per study, nothing else touched):');
  console.log('  (and a flag is CLEARED from any study whose data no longer shows a defect,');
  console.log('   which is what a re-run on the fixed code produces)');
  for (const f of flagged.slice(0, 3)) {
    console.log(`  UPDATE missions SET quality_flags = '{${f.flags.join(',')}}', quality_flagged_at = now() WHERE id = '${f.id}';`);
  }
  if (flagged.length > 3) console.log(`  ... and ${flagged.length - 3} more of the same shape`);
  console.log('\nNo response, answer, persona or report row is touched.');

  if (!DO_RUN) {
    console.log('\nDRY RUN. Nothing was changed. Re-run with --run to apply.');
    process.exit(0);
  }

  // A study that has been re-run on the fixed code is clean, and must not keep
  // a flag that is no longer true. The flag describes the data as it stands.
  const flaggedIds = new Set(flagged.map((f) => f.id));
  const { data: stale, error: staleErr } = await supabase
    .from('missions').select('id').not('quality_flags', 'is', null);
  if (staleErr) throw staleErr;
  const toClear = (stale || []).filter((m) => !flaggedIds.has(m.id));
  for (const m of toClear) {
    const { error } = await supabase
      .from('missions').update({ quality_flags: null, quality_flagged_at: null }).eq('id', m.id);
    if (error) { console.error(`FAILED to clear ${m.id}: ${error.message}`); continue; }
    console.log(`  cleared the flag on ${m.id.slice(0, 8)}: its data no longer shows any defect`);
  }

  let written = 0;
  for (const f of flagged) {
    const { error } = await supabase
      .from('missions')
      .update({ quality_flags: f.flags, quality_flagged_at: new Date().toISOString() })
      .eq('id', f.id);
    if (error) { console.error(`FAILED ${f.id}: ${error.message}`); continue; }
    written += 1;
  }
  const { count } = await supabase
    .from('missions').select('id', { count: 'exact', head: true }).not('quality_flags', 'is', null);
  console.log(`\nflagged ${written} studies; ${count} studies now carry a quality flag.`);
  process.exit(0);
})().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });

module.exports = { selectFlagged };
