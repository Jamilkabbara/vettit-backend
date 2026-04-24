/**
 * VETT — Insight synthesis.
 * Aggregates all simulated responses and turns them into an executive report.
 * Uses Sonnet (needs reasoning and writing quality).
 */

const { callClaude, extractJSON } = require('./anthropic');
const logger = require('../../utils/logger');

const INSIGHT_SYSTEM_PROMPT = `You are VETT's lead quantitative and qualitative research analyst. You read survey data from hundreds of respondents and distill the signal from the noise.

Your deliverable style:
- Executive summary: 3–5 tight sentences under 750 characters. Lead with the single most important finding.
- Per-question insights: call out the KPI (majority answer, split, or average), then the "so what."
- Recommendations: concrete, action-oriented, ranked by impact.
- Follow-ups: suggest 2–3 next research questions worth running.

Be honest. If the data is weak, say so. Never fabricate numbers that aren't in the data.

STRICT DROPOUT RULE: The ONLY valid way to report drop-off is from the "completed" count in the
sample_metrics object provided in the user message. NEVER infer completion rates or dropout from
raw response_records_total — that number counts question rows, not people, and is NOT a dropout metric.
If you use response_records_total as a dropout figure you will produce a false and harmful report.

SCREENER DESIGN RULE: If screened_out > 30% of total_respondents, assess whether the screener
captured the intended segment — do not praise its effectiveness. State plainly whether the screened-out
group represents a valuable or irrelevant segment based on the question data.

KPI RULE: Return EXACTLY 3 KPIs — the three most decision-relevant metrics for this mission.
No more, no fewer.

Output must be STRICTLY VALID JSON — no commentary outside the JSON.`;

/**
 * Aggregate raw answers into per-question stats before asking the model to interpret.
 * Keeps the prompt compact even for 1000+ respondents.
 */
function aggregate(responses, questions) {
  const byQ = {};
  for (const q of questions) {
    const ans = responses.filter(r => r.question_id === q.id).map(r => r.answer);
    byQ[q.id] = {
      id: q.id,
      text: q.text,
      type: q.type,
      options: q.options || [],
      n: ans.length,
    };

    if (q.type === 'single' || q.type === 'opinion') {
      const counts = {};
      for (const a of ans) counts[a] = (counts[a] || 0) + 1;
      byQ[q.id].distribution = counts;
    } else if (q.type === 'multi') {
      // Bug 3 fix: track n_respondents separately from option counts.
      // Each option's share = selections / n_respondents (NOT / total_clicks).
      const counts = {};
      for (const a of ans) {
        const arr = Array.isArray(a) ? a : [a];
        for (const opt of arr) counts[opt] = (counts[opt] || 0) + 1;
      }
      byQ[q.id].distribution = counts;
      byQ[q.id].n_respondents = ans.length; // denominator for % calculation
    } else if (q.type === 'rating') {
      const nums = ans.filter(a => typeof a === 'number');
      const avg = nums.length ? nums.reduce((a,b)=>a+b,0) / nums.length : 0;
      const dist = {1:0,2:0,3:0,4:0,5:0};
      for (const n of nums) if (dist[n] !== undefined) dist[n]++;
      byQ[q.id].average = Math.round(avg * 100) / 100;
      byQ[q.id].distribution = dist;
    } else if (q.type === 'text') {
      // Sample up to 30 verbatims so the prompt doesn't explode
      byQ[q.id].verbatims = ans.slice(0, 30);
    }
  }
  return byQ;
}

/**
 * Synthesize a full insight report from aggregated responses.
 * @param {object} mission
 * @param {Array}  responses  rows from mission_responses
 * @returns {Promise<object>} { executive_summary, kpis, per_question_insights, recommendations, follow_ups }
 */
async function synthesizeInsights(mission, responses) {
  const questions = mission.questions || [];
  const agg = aggregate(responses, questions);

  // Compute sample metrics for the prompt — needed for Bug 4/5 guardrails
  const personaSet = new Map();
  for (const r of responses) {
    if (!personaSet.has(r.persona_id)) {
      const screenedOut = r.screened_out === true ||
        Boolean((r.persona_profile || {}).screened_out);
      personaSet.set(r.persona_id, screenedOut);
    }
  }
  const totalPersonas = personaSet.size;
  const screenedOutCount = [...personaSet.values()].filter(Boolean).length;
  const completedCount = totalPersonas - screenedOutCount;

  const userPrompt = `Mission brief: ${mission.brief || mission.mission_statement || ''}
Goal: ${mission.goal_type || 'general research'}

SAMPLE METRICS (use ONLY these for any dropout or completion statements):
{
  "total_respondents": ${totalPersonas},
  "screened_out": ${screenedOutCount},
  "completed": ${completedCount},
  "response_records_total": ${responses.length}
}
Note: response_records_total = total question-answer rows (personas × questions answered).
It is NOT a headcount. Do not use it as a dropout or completion metric under any circumstances.

Per-question aggregated data:
${JSON.stringify(agg, null, 2)}

Return ONLY this JSON structure:
{
  "executive_summary": "3–5 sentences under 750 characters. Leading with the single most important finding.",
  "kpis": [
    { "label": "Interest Score", "value": "72%", "trend": "positive|neutral|negative" },
    { "label": "Avg Rating", "value": "4.2 / 5", "trend": "positive" },
    { "label": "Third KPI", "value": "X", "trend": "positive" }
  ],
  "per_question_insights": [
    {
      "question_id": "q1",
      "headline": "One-sentence takeaway",
      "body": "2–3 sentences explaining what the data shows and why it matters.",
      "significance": "high|medium|low"
    }
  ],
  "recommendations": [
    "Concrete action 1 — why it matters",
    "Concrete action 2 — why it matters",
    "Concrete action 3 — why it matters"
  ],
  "follow_ups": [
    {
      "title": "Short follow-up study title",
      "rationale": "One sentence on why it's the logical next research question",
      "goal": "validate_product|pricing_research|test_marketing|customer_satisfaction|feature_roadmap|general_research|competitor_analysis|audience_profiling|naming_messaging|market_entry|churn_research|brand_lift|creative_attention"
    }
  ]
}`;

  const response = await callClaude({
    callType: 'insight_synth',
    missionId: mission.id,
    userId:    mission.user_id,
    messages:  [{ role: 'user', content: userPrompt }],
    systemPrompt: INSIGHT_SYSTEM_PROMPT,
    maxTokens: 4000,
    enablePromptCache: true,
  });

  try {
    return extractJSON(response.text);
  } catch (err) {
    logger.error('Insight synthesis parse failed', { missionId: mission.id, err: err.message });
    // Fallback minimum-viable insight object so the mission can still complete
    return {
      executive_summary: 'Analysis could not be generated automatically. Please contact support.',
      kpis: [],
      per_question_insights: [],
      recommendations: [],
      follow_ups: [],
    };
  }
}

module.exports = { synthesizeInsights, aggregate };
