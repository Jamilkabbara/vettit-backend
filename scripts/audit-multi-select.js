#!/usr/bin/env node
/**
 * Historical audit: how many studies asked a multi-select nobody could decline?
 *
 * Read-only. Applies the two decidable rules from
 * services/ai/multiSelectHygiene.js (an escape option, and a cap on
 * concern-style batteries) to every stored question set.
 *
 *   railway run node scripts/audit-multi-select.js
 */
'use strict';

const supabase = require('../src/db/supabase');
const {
  findViolations, hasEscapeOption, doubleBarrelledOptions, DEFAULT_ESCAPE,
} = require('../src/services/ai/multiSelectHygiene');

const isMulti = (q) => q && (q.type === 'multi' || q.type === 'multiple' || q.type === 'multi_select')
  && Array.isArray(q.options) && q.options.length > 1;

/**
 * POSITIVE CONTROL: the rule must find the question that prompted it, and must
 * pass the same question once an escape option is added. A count of zero from
 * an unproven method is not a clean bill.
 */
function positiveControl() {
  const shipped = {
    id: 'control', type: 'multi',
    text: 'What factors would make you hesitate? Select all that apply.',
    options: ['Halal certification', 'Trust in ingredients', 'Price', 'Availability'],
  };
  const fixed = { ...shipped, options: [...shipped.options, DEFAULT_ESCAPE], maxSelections: 3 };
  return {
    ok: findViolations([shipped]).length > 0 && findViolations([fixed]).length === 0,
    shipped_flags: findViolations([shipped]).map((v) => v.rule),
    fixed_flags: findViolations([fixed]).length,
  };
}

(async () => {
  const control = positiveControl();
  console.error(`positive control: ${JSON.stringify(control)}`);
  if (!control.ok) { console.error('POSITIVE CONTROL FAILED'); process.exit(3); }

  const { data, error } = await supabase
    .from('missions')
    .select('id, status, goal_type, created_at, questions, respondent_count');
  if (error) throw error;

  const tally = (rows) => {
    const t = { missions: 0, withMulti: 0, missingEscape: 0, uncapped: 0, clean: 0, multiQuestions: 0, questionsWithEscape: 0, adviseMergedOption: 0 };
    for (const m of rows) {
      t.missions += 1;
      const qs = Array.isArray(m.questions) ? m.questions : [];
      const multi = qs.filter(isMulti);
      if (!multi.length) continue;
      t.withMulti += 1;
      t.multiQuestions += multi.length;
      t.questionsWithEscape += multi.filter(hasEscapeOption).length;
      t.adviseMergedOption += multi.filter((q) => doubleBarrelledOptions(q).length).length;
      const v = findViolations(qs);
      if (v.some((x) => x.rule === 'missing_escape_option')) t.missingEscape += 1;
      if (v.some((x) => x.rule === 'uncapped_selections')) t.uncapped += 1;
      if (!v.length) t.clean += 1;
    }
    return t;
  };

  const all = tally(data);
  const delivered = tally(data.filter((m) => m.status === 'completed'));
  console.log(JSON.stringify({ all, delivered }, null, 2));
  for (const m of data.filter((x) => x.status === 'completed')) {
    const v = findViolations(Array.isArray(m.questions) ? m.questions : []);
    if (v.length) {
      console.log(JSON.stringify({
        id: m.id, goal_type: m.goal_type, created: m.created_at.slice(0, 10), n: m.respondent_count,
        violations: v,
      }));
    }
  }
})().catch((e) => { console.error(e); process.exit(2); });
