/**
 * VETT — Insight synthesis.
 * Aggregates all simulated responses and turns them into an executive report.
 * Uses Sonnet (needs reasoning and writing quality).
 */

const { callClaude, extractJSON } = require('./anthropic');
const { WRITING_STYLE } = require('./writingStyle');
const logger = require('../../utils/logger');

// Pass 22 Bug 22.13 — narrative 4-paragraph executive summary replaces the
// 3-5-sentence under-750-char shape. Pass 22 Bug 22.16 — contradictions array
// added to output. Pass 22 Bug 22.27 — em-dash + writing-style ban appended.
const INSIGHT_SYSTEM_PROMPT = `You are VETT's lead quantitative and qualitative research analyst. You read survey data from hundreds of respondents and distill the signal from the noise.

Your deliverable style:
- Executive summary: a four-paragraph narrative (250-800 words total). Structure:
    Paragraph 1: Headline finding. One strong opening sentence stating the single most important takeaway, followed by 3-4 supporting context sentences.
    Paragraph 2: Notable distributions and patterns across personas. Two to three sentences with specific percentages and counts.
    Paragraph 3: Tensions, contradictions, surprises. Two to three sentences identifying what was unexpected about the results, or where personas disagreed in interesting ways.
    Paragraph 4: Recommended next move. One strong forward-looking sentence the operator can act on this week.
- Per-question insights: call out the KPI (majority answer, split, or average), then the "so what."
- Recommendations: concrete, action-oriented, ranked by impact.
- Follow-ups: suggest 2 to 3 next research questions worth running.
- Contradictions: flag the 1 to 3 most striking tensions across questions, if any exist. If the data is internally consistent, return an empty array.

Be honest. If the data is weak, say so. Never fabricate numbers that aren't in the data.

STRICT DROPOUT RULE: The ONLY valid way to report drop-off is from the "completed" count in the
sample_metrics object provided in the user message. NEVER infer completion rates or dropout from
raw response_records_total. That number counts question rows, not people, and is NOT a dropout metric.
If you use response_records_total as a dropout figure you will produce a false and harmful report.

SCREENER DESIGN RULE: If screened_out > 30% of total_respondents, assess whether the screener
captured the intended segment. Do not praise its effectiveness. State plainly whether the screened-out
group represents a valuable or irrelevant segment based on the question data.

KPI RULE: Return EXACTLY 3 KPIs, the three most decision-relevant metrics for this mission.
No more, no fewer.

Output must be STRICTLY VALID JSON, no commentary outside the JSON.
${WRITING_STYLE}`;

/**
 * Pass 22 Bug 22.17 — Compute 95% CI for an array of rating numbers.
 * Returns { avg, stddev, n, ci_low, ci_high }. Uses 1.96 for 95%.
 * For n < 2, stddev and CI are both null (uncertainty undefined).
 */
function computeRatingStats(nums) {
  const n = nums.length;
  if (n === 0) return { avg: 0, stddev: null, n: 0, ci_low: null, ci_high: null };
  const avg = nums.reduce((a, b) => a + b, 0) / n;
  if (n < 2) {
    return { avg: Math.round(avg * 100) / 100, stddev: null, n, ci_low: null, ci_high: null };
  }
  const variance = nums.reduce((sum, x) => sum + (x - avg) ** 2, 0) / (n - 1);
  const stddev = Math.sqrt(variance);
  const sem = stddev / Math.sqrt(n);
  const margin = 1.96 * sem;
  return {
    avg:     Math.round(avg * 100) / 100,
    stddev:  Math.round(stddev * 100) / 100,
    n,
    ci_low:  Math.round((avg - margin) * 100) / 100,
    ci_high: Math.round((avg + margin) * 100) / 100,
  };
}

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
      // Pass 22 Bug 22.17 — persist 95% CI alongside the average so the
      // ResultsPage can render "3.8 ± 0.4 (95% CI: 3.4-4.2, n=4)".
      const stats = computeRatingStats(nums);
      const dist = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
      for (const n of nums) if (dist[n] !== undefined) dist[n]++;
      byQ[q.id].average    = stats.avg;
      byQ[q.id].stddev     = stats.stddev;
      byQ[q.id].ci_low     = stats.ci_low;
      byQ[q.id].ci_high    = stats.ci_high;
      // n is already on the row above (= ans.length); rating-only nums may differ
      // if some answers were non-numeric, so expose both for transparency.
      byQ[q.id].rating_n   = stats.n;
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
 * @returns {Promise<object>} { executive_summary, kpis, per_question_insights, recommendations, follow_ups, contradictions }
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

  // Pass 22 Bug 22.15 — build a compact per-persona summary so the model can
  // identify cross-cut segmentation axes. Dedup by persona_id and pull only
  // demographic-ish fields to keep the prompt size bounded; full persona
  // profiles are 5-10x larger and not needed for axis identification.
  const personaSummaries = [];
  const seenPersonaIds = new Set();
  for (const r of responses) {
    if (seenPersonaIds.has(r.persona_id)) continue;
    seenPersonaIds.add(r.persona_id);
    const p = r.persona_profile || {};
    const summary = { id: r.persona_id };
    // Whitelist of demographic-ish keys; ignore the rest. The model is
    // instructed to pick whichever 2-3 axes are most informative.
    for (const k of [
      'age', 'age_bracket', 'gender', 'role', 'occupation', 'industry',
      'income', 'income_bracket', 'location', 'country', 'city',
      'family_status', 'tech_savvy', 'lifestage', 'segment',
    ]) {
      if (p[k] != null) summary[k] = p[k];
    }
    if (p.screened_out === true) summary.screened_out = true;
    personaSummaries.push(summary);
  }

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

Persona summaries (for cross-cut segmentation; pick the 2-3 most informative axes):
${JSON.stringify(personaSummaries, null, 2)}

Return ONLY this JSON structure:
{
  "executive_summary": "Four paragraphs separated by blank lines, totalling 250-800 words. Paragraph 1 headline finding (1 strong sentence + 3-4 supporting). Paragraph 2 notable distributions (2-3 sentences with specific percentages). Paragraph 3 tensions and surprises (2-3 sentences). Paragraph 4 recommended next move (1 strong sentence).",
  "kpis": [
    { "label": "Interest Score", "value": "72%", "trend": "positive|neutral|negative" },
    { "label": "Avg Rating", "value": "4.2 / 5", "trend": "positive" },
    { "label": "Third KPI", "value": "X", "trend": "positive" }
  ],
  "per_question_insights": [
    {
      "question_id": "q1",
      "headline": "One-sentence takeaway",
      "body": "2-3 sentences explaining what the data shows and why it matters.",
      "significance": "high|medium|low"
    }
  ],
  "recommendations": [
    "Concrete action 1, why it matters",
    "Concrete action 2, why it matters",
    "Concrete action 3, why it matters"
  ],
  "follow_ups": [
    {
      "title": "Short follow-up study title",
      "rationale": "One sentence on why it's the logical next research question",
      "goal": "validate_product|pricing_research|test_marketing|customer_satisfaction|feature_roadmap|general_research|competitor_analysis|audience_profiling|naming_messaging|market_entry|churn_research|brand_lift|creative_attention"
    }
  ],
  "contradictions": [
    {
      "question_a": "q-id of one question",
      "question_b": "q-id of the other question that's in tension",
      "tension_description": "One to two sentences on what the two questions disagree about and why it matters.",
      "severity": "high|medium|low"
    }
  ],
  "segment_breakdowns": [
    {
      "axis": "age_bracket | income_bracket | role | location | family_status | tech_savvy | (whichever 2-3 axes are most informative)",
      "segments": [
        {
          "name": "18-29",
          "n": 12,
          "key_findings": "1-2 sentences on what this segment thinks differently from the rest, with specific question-level evidence."
        }
      ]
    }
  ]
}

Identify the 2 to 3 most informative segmentation axes from the persona profiles. For each axis, return per-segment counts (n) and one to two sentences calling out where that segment diverges from the overall result. Skip axes that don't produce meaningful differentiation. If the sample is too small or homogeneous to segment usefully, return an empty array.`;

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
    const parsed = extractJSON(response.text);
    // Defensive defaults in case the model omits these optional fields.
    if (!Array.isArray(parsed.contradictions))     parsed.contradictions     = [];
    if (!Array.isArray(parsed.segment_breakdowns)) parsed.segment_breakdowns = [];
    // Pass 23 — em-dash sanitizer (post-generation). Pre-prompt swap was
    // insufficient: production audit found em-dashes on every page checked
    // (Bali, General Research, Recommended Next Step, AI Insights). The
    // sanitizer is the canonical defense — applied before persistence so
    // every JSONB field stamped to missions.insights is clean.
    return sanitizeAIOutputDeep(parsed);
  } catch (err) {
    logger.error('Insight synthesis parse failed', { missionId: mission.id, err: err.message });
    // Fallback minimum-viable insight object so the mission can still complete
    return {
      executive_summary: 'Analysis could not be generated automatically. Please contact support.',
      kpis: [],
      per_question_insights: [],
      recommendations: [],
      follow_ups: [],
      contradictions: [],
      segment_breakdowns: [],
    };
  }
}

/**
 * Pass 23 — recursive em-dash + en-dash sanitizer for AI output.
 *
 * Walks every string in any nested structure and applies:
 *   U+2014 (em-dash) → ', '   (comma + space — flows naturally in prose)
 *   U+2013 (en-dash) → '-'    (hyphen-minus — preserves intent in ranges)
 *   '. , ' / ', ,'   → '. ' / ','   (cleanup of double-punctuation artifacts)
 *
 * Used by:
 *   - synthesizeInsights (return path)
 *   - creativeAttention synthesis (creative_analysis JSONB)
 *
 * Idempotent — safe to apply multiple times. Returns the same shape it
 * received; mutates only string leaves.
 */
function sanitizeAIString(s) {
  if (typeof s !== 'string') return s;
  return s
    .replace(/—/g, ', ')
    .replace(/–/g, '-')
    .replace(/\.\s*,\s*/g, '. ')
    .replace(/,\s+,/g, ',')
    .replace(/\s{2,}/g, ' ')
    .trim();
}
function sanitizeAIOutputDeep(value) {
  if (value == null) return value;
  if (typeof value === 'string') return sanitizeAIString(value);
  if (Array.isArray(value)) return value.map(sanitizeAIOutputDeep);
  if (typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = sanitizeAIOutputDeep(v);
    return out;
  }
  return value;
}

module.exports = {
  synthesizeInsights,
  aggregate,
  computeRatingStats,
  sanitizeAIString,
  sanitizeAIOutputDeep,
};
