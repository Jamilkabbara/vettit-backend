#!/usr/bin/env node
/**
 * Historical audit: which delivered reports told the customer a subgroup figure
 * was the study's finding?
 *
 * Read-only. For every completed mission it rebuilds the whole-sample figures
 * from mission_responses, takes the subgroup figures from the stored analysis,
 * and checks the stored executive summary and hero tiles with
 * services/report/headlineBasis.js - the same rule now wired into synthesis.
 *
 *   railway run node scripts/audit-report-headlines.js
 */
'use strict';

const supabase = require('../src/db/supabase');
const fetchAllResponses = require('../src/db/fetchAllResponses');
const { aggregate } = require('../src/services/ai/insights');
const {
  checkHeadlineBasis, fullSampleFigures, subgroupFigureMap, subgroupLabels,
} = require('../src/services/report/headlineBasis');

function reportShape(agg, mission) {
  return {
    header: {
      sample: { n: mission.respondent_count || null },
      markets: mission.targeted_markets || null,
    },
    survey: Object.values(agg || {}).map((q) => ({
      id: q.id,
      type: q.type,
      data: {
        n: q.n,
        n_respondents: q.n_respondents != null ? q.n_respondents : q.n,
        distribution: q.distribution,
        average: q.average,
      },
    })),
  };
}

/**
 * POSITIVE CONTROL. An audit that reports "nothing found" has to show its
 * method finding something first, or it has only proved that the method does
 * not work. This is the real delivered sentence from mission 3fc15087 with the
 * market name taken out: the same true figure, presented as the study's.
 *
 * The labelled original must pass and the stripped version must fail. If
 * either does not, the audit stops rather than report a clean bill.
 */
function positiveControl() {
  const report = {
    header: { sample: { n: 80 }, markets: 'Saudi Arabia and Egypt' },
    survey: [{
      id: 'q3',
      type: 'single',
      data: {
        n: 80,
        n_respondents: 80,
        distribution: {
          'Definitely would buy': 3, 'Probably would buy': 57, 'Might or might not': 1,
          'Probably would NOT buy': 16, 'Definitely would NOT buy': 3,
        },
      },
    }],
  };
  const analysis = {
    n: 80,
    by_market: [
      { market: 'Saudi Arabia', n: 40, purchase_intent_pct: 82.5, demand_index: 62 },
      { market: 'Egypt', n: 40, purchase_intent_pct: 67.5, demand_index: 51 },
    ],
  };
  const ctx = {
    full: fullSampleFigures(report),
    subgroupMap: subgroupFigureMap(analysis),
    labels: subgroupLabels(analysis, report),
  };
  const asDelivered = "Saudi Arabia is the clear market to enter first, scoring a demand index of 62/100 and purchase intent of 82.5%, well ahead of Egypt's 51/100 demand index and 67.5% intent.";
  const stripped = 'The study shows real demand, scoring a demand index of 62/100 and purchase intent of 82.5%.';
  const deliveredHits = checkHeadlineBasis(asDelivered, ctx);
  const strippedHits = checkHeadlineBasis(stripped, ctx);
  return {
    ok: deliveredHits.length === 0 && strippedHits.length === 1,
    labelled_sentence_flags: deliveredHits.length,
    unlabelled_sentence_flags: strippedHits.length,
  };
}

(async () => {
  const control = positiveControl();
  console.error(`positive control: ${JSON.stringify(control)}`);
  if (!control.ok) {
    console.error('POSITIVE CONTROL FAILED - the method cannot tell the two apart, so a clean result would mean nothing.');
    process.exit(3);
  }

  const { data: missions, error } = await supabase
    .from('missions')
    .select('id, goal_type, created_at, respondent_count, targeted_markets, questions, analysis, insights, executive_summary')
    .eq('status', 'completed')
    .order('created_at', { ascending: true });
  if (error) throw error;

  const summary = { completed: missions.length, withAnalysis: 0, withSubgroups: 0, checked: 0, bad: 0, badTiles: 0 };
  for (const m of missions) {
    if (!m.analysis) continue;
    summary.withAnalysis += 1;
    const subgroupMap = subgroupFigureMap(m.analysis);
    if (!subgroupMap.size) continue;
    summary.withSubgroups += 1;

    const { data: rows, error: rErr } = await fetchAllResponses(supabase, {
      missionId: m.id,
      columns: 'persona_id, question_id, answer',
      eq: { screened_out: false },
      label: 'audit-report-headlines',
    });
    if (rErr) { console.error(m.id, rErr.message); continue; }
    if (!rows || !rows.length) continue;

    const agg = aggregate(rows, m.questions || []);
    const report = reportShape(agg, m);
    const ctx = { full: fullSampleFigures(report), subgroupMap, labels: subgroupLabels(m.analysis, report) };
    summary.checked += 1;

    const texts = [];
    if (m.executive_summary) texts.push(['executive_summary', m.executive_summary]);
    const ins = m.insights || {};
    if (ins.executive_summary && ins.executive_summary !== m.executive_summary) texts.push(['insights.executive_summary', ins.executive_summary]);
    const tiles = Array.isArray(ins.kpis) ? ins.kpis : [];

    const violations = [];
    for (const [where, text] of texts) {
      for (const v of checkHeadlineBasis(text, ctx)) violations.push({ where, ...v });
    }
    const tileViolations = [];
    for (const t of tiles) {
      if (!t || typeof t !== 'object') continue;
      for (const v of checkHeadlineBasis(`${t.label || ''} ${t.value || ''}`, ctx)) {
        tileViolations.push({ label: t.label, value: t.value, figure: v.figure });
      }
    }
    if (violations.length) summary.bad += 1;
    if (tileViolations.length) summary.badTiles += 1;
    if (violations.length || tileViolations.length) {
      console.log(JSON.stringify({
        id: m.id, goal_type: m.goal_type, created: m.created_at.slice(0, 10), n: m.respondent_count,
        prose: violations, tiles: tileViolations,
      }));
    }
  }
  console.error(JSON.stringify(summary));
})().catch((e) => { console.error(e); process.exit(2); });
