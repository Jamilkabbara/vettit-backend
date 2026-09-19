#!/usr/bin/env node
/**
 * Historical audit: how many different people did each delivered study contain?
 *
 * Read-only. For every completed mission, rebuilds the delivered panel from
 * mission_responses (qualified rows only) and judges it with
 * panelDistinctness.measurePanel - the same rule the generator guard, the
 * tests and the live measurement use.
 *
 *   railway run node scripts/audit-panel-distinctness.js > audit.jsonl
 */
'use strict';

const supabase = require('../src/db/supabase');
const fetchAllResponses = require('../src/db/fetchAllResponses');
const { measurePanel } = require('../src/services/ai/panelDistinctness');

(async () => {
  const { data: missions, error } = await supabase
    .from('missions')
    .select('id, user_id, goal_type, created_at, respondent_count')
    .eq('status', 'completed')
    .order('created_at', { ascending: true });
  if (error) throw error;

  let failed = 0;
  for (const m of missions) {
    const { data: rows, error: rErr } = await fetchAllResponses(supabase, {
      missionId: m.id,
      columns: 'persona_id, persona_profile, question_id, answer',
      eq: { screened_out: false },
      label: 'audit-panel-distinctness',
    });
    if (rErr) { console.error(m.id, rErr.message); continue; }
    const personas = new Map(); const answers = {};
    for (const r of rows || []) {
      if (!personas.has(r.persona_id)) personas.set(r.persona_id, { ...(r.persona_profile || {}), id: r.persona_id });
      (answers[r.persona_id] = answers[r.persona_id] || {})[r.question_id] = r.answer;
    }
    const x = measurePanel([...personas.values()], { answersByPersona: answers });
    if (!x.pass) failed += 1;
    console.log(JSON.stringify({
      id: m.id, user_id: m.user_id, goal_type: m.goal_type, created: m.created_at.slice(0, 10),
      n: x.n, distinct: x.distinct, nearDuplicates: x.nearDuplicates, allowed: x.allowedNearDuplicates,
      topName: x.topName, topNameCount: x.topNameCount, names: x.distinctNames, ages: x.distinctAges,
      cities: x.distinctCities, occupations: x.distinctOccupations, opinions: x.distinctOpinions,
      pass: x.pass, reasons: x.reasons,
    }));
  }
  console.error(`${missions.length} completed missions, ${failed} fail the distinctness threshold`);
})().catch((e) => { console.error(e); process.exit(2); });
