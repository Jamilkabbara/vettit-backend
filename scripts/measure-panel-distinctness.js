#!/usr/bin/env node
/**
 * Live measurement: generate real panels and count the different people.
 *
 * Runs the real recruit loop (the production path) with real AI calls for
 * persona generation and survey answers, at several panel sizes, then judges
 * each panel with panelDistinctness.measurePanel.
 *
 * Writes nothing to missions or mission_responses: the loop is handed an
 * in-memory stand-in for the database. The AI calls themselves are logged to
 * ai_calls as usual, with no mission attached, so the spend stays visible.
 *
 *   railway run node scripts/measure-panel-distinctness.js --sizes 10,50,100
 *   railway run node scripts/measure-panel-distinctness.js --code ../other-checkout --label main
 *
 * --code  run another checkout's generator and loop (to measure the old code)
 *         while judging with THIS checkout's measure.
 * Exits 1 if any panel fails the threshold.
 */
'use strict';

const path = require('path');

const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, all) => {
  if (a.startsWith('--')) acc.push([a.slice(2), all[i + 1] && !all[i + 1].startsWith('--') ? all[i + 1] : 'true']);
  return acc;
}, []));
const sizes = String(args.sizes || '10,50,100').split(',').map(Number).filter((n) => n > 0);
const codeRoot = path.resolve(args.code || path.join(__dirname, '..'));
const label = args.label || path.basename(codeRoot);

const { measurePanel } = require('../src/services/ai/panelDistinctness');

// Count spend per call type by wrapping the target checkout's client BEFORE
// its generator and loop take their reference to it.
const anthropic = require(path.join(codeRoot, 'src/services/ai/anthropic'));
const spend = {};
const calls = {};
const realCall = anthropic.callClaude;
anthropic.callClaude = async (opts) => {
  const r = await realCall(opts);
  spend[opts.callType] = (spend[opts.callType] || 0) + (r.costUsd || 0);
  calls[opts.callType] = (calls[opts.callType] || 0) + 1;
  return r;
};
const { runRecruitmentLoop } = require(path.join(codeRoot, 'src/services/ai/recruitLoop'));

function memoryDb() {
  const rows = [];
  return {
    rows,
    from(table) {
      const chain = {
        select: () => chain, eq: () => chain, update: () => chain, order: () => chain, range: () => chain,
        single: async () => ({ data: { ai_spend_usd_actual: 0, status: 'processing', ai_spend_ceiling_usd: 1000 }, error: null }),
        insert: async () => ({ error: null }),
        upsert: async (r) => { if (table === 'mission_responses') rows.push(...[].concat(r)); return { error: null }; },
        then: (resolve) => resolve({ data: table === 'mission_responses' ? [] : null, error: null }),
      };
      return chain;
    },
  };
}

// A synthetic study shaped like a real customer brief. Not tied to any
// mission in the database.
const mission = (n) => ({
  id: null,
  user_id: null,
  goal_type: 'research',
  title: 'Imported honey in the UAE',
  brief: 'I want to import honey from Lebanon to sell in the UAE. Who buys premium honey, where, and what would make them try a new origin?',
  target_qualified_count: n,
  ai_spend_ceiling_usd: 1000,
  targeting: { geography: { countries: ['AE'] }, demographics: { ageRanges: ['25-34', '35-44', '45-54'] } },
  questions: [
    { id: 'q1', text: 'How often do you buy honey?', type: 'single', options: ['Weekly', 'Monthly', 'A few times a year', 'Rarely or never'] },
    { id: 'q2', text: 'Where do you usually buy it?', type: 'single', options: ['Supermarket', 'Specialty or organic store', 'Online', 'Market or direct from producer'] },
    { id: 'q3', text: 'Which matters most when choosing honey?', type: 'single', options: ['Price', 'Origin', 'Purity or certification', 'Brand', 'Taste'] },
    { id: 'q4', text: 'How likely are you to try Lebanese honey at a 20% premium over your usual?', type: 'rating', min: 1, max: 5 },
    { id: 'q5', text: 'What would make you trust a new honey brand?', type: 'text' },
  ],
});

(async () => {
  const results = [];
  for (const n of sizes) {
    for (const k of Object.keys(spend)) { spend[k] = 0; calls[k] = 0; }
    const db = memoryDb();
    const t0 = Date.now();
    const loop = await runRecruitmentLoop(mission(n), db);
    const personas = new Map(); const answers = {};
    for (const r of db.rows) {
      personas.set(r.persona_id, r.persona_profile);
      (answers[r.persona_id] = answers[r.persona_id] || {})[r.question_id] = r.answer;
    }
    const m = measurePanel([...personas.values()], { answersByPersona: answers });
    const total = Object.values(spend).reduce((a, b) => a + b, 0);
    results.push({
      label, size: n, delivered: m.n, distinct: m.distinct, nearDuplicates: m.nearDuplicates, allowed: m.allowedNearDuplicates,
      topName: `${m.topName} ${m.topNameCount}/${m.n}`, names: m.distinctNames, ages: m.distinctAges,
      cities: m.distinctCities, occupations: m.distinctOccupations, opinions: m.distinctOpinions,
      pass: m.pass, reasons: m.reasons, loopExit: loop.breakReason || loop.terminalStatus,
      personaGenCalls: calls.persona_gen || 0,
      personaGenUsd: +(spend.persona_gen || 0).toFixed(4),
      totalUsd: +total.toFixed(4), usdPerRespondent: m.n ? +(total / m.n).toFixed(4) : null,
      personaGenUsdPerRespondent: m.n ? +((spend.persona_gen || 0) / m.n).toFixed(5) : null,
      seconds: Math.round((Date.now() - t0) / 1000),
      sample: [...personas.values()].slice(0, 5).map((p) => `${p.first_name}, ${p.age}, ${p.city}, ${p.occupation}`),
    });
    console.log(JSON.stringify(results[results.length - 1]));
  }
  // let fire-and-forget ai_calls inserts land
  await new Promise((r) => setTimeout(r, 3000));
  process.exit(results.every((r) => r.pass) ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(2); });
