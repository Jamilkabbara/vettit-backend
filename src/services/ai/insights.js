/**
 * VETT — Insight synthesis.
 * Aggregates all simulated responses and turns them into an executive report.
 * Uses Sonnet (needs reasoning and writing quality).
 */

const { callClaude, extractJSON } = require('./anthropic');
const { WRITING_STYLE } = require('./writingStyle');
const logger = require('../../utils/logger');
const { computePersonas } = require('../analysis/personas');

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

SCREENER INSIGHT RULE (Pass 26 Bug B): For per_question_insights on a screener question,
when 100% of respondents qualified (no funnel signal), the data has no information beyond the
filter itself. Set headline and body to the empty string for that question_id; the export
renderers replace it with a sample-composition note. Never write "All N respondents are X,
making the sample directly qualified" or similar tautological prose — that text is dead content
for any downstream consumer.

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
 * Pass 47 — build a factual executive summary from the deterministic
 * analysis object when the LLM narrator fails. Methodology-aware,
 * fully null-safe (any missing field is skipped). Returns a string, or
 * null when there's nothing computable to say.
 */
function buildComputedSummary(analysis, mission) {
  if (!analysis || typeof analysis !== 'object') return null;
  const n = analysis.n != null ? `n=${analysis.n}` : null;
  const parts = [];
  try {
    switch (analysis.methodology) {
      case 'brand_lift': {
        const ex = analysis.cells?.exposed?.n, co = analysis.cells?.control?.n;
        const big = (analysis.funnel || []).filter((f) => f && f.lift_abs != null)
          .sort((a, b) => Math.abs(b.lift_abs) - Math.abs(a.lift_abs))[0];
        parts.push(`Brand lift measured across an exposed cell (n=${ex ?? '?'}) versus a control cell (n=${co ?? '?'}).`);
        if (big) {
          const pts = big.type === 'mean' ? `${big.lift_abs}` : `${Math.round(big.lift_abs * 100)} pts`;
          const sig = big.significance?.sig95 ? 'significant at 95%' : big.significance?.sig90 ? 'significant at 90%' : 'directional';
          parts.push(`The largest movement was on "${big.text || big.funnel_stage}" (+${pts}, ${sig}).`);
        }
        break;
      }
      case 'pricing': {
        const opp = analysis.van_westendorp?.points?.opp;
        const range = analysis.acceptable_range;
        const gg = analysis.gabor_granger?.optimal_price;
        if (opp != null) parts.push(`The Van Westendorp optimal price point is ${opp}${range ? ` (acceptable range ${range.low}–${range.high})` : ''}.`);
        if (gg != null) parts.push(`Gabor-Granger revenue is maximized at ${gg}.`);
        break;
      }
      case 'satisfaction': {
        if (analysis.nps?.score != null) parts.push(`NPS is ${analysis.nps.score}.`);
        if (analysis.csat?.top2_pct != null) parts.push(`CSAT top-2-box is ${analysis.csat.top2_pct}%.`);
        if (analysis.ces?.top2_pct != null) parts.push(`CES top-2-box is ${analysis.ces.top2_pct}%.`);
        break;
      }
      case 'validate': {
        if (analysis.scores?.reaction?.mean != null) parts.push(`Concept reaction scores ${analysis.scores.reaction.mean}/10.`);
        if (analysis.intent?.top2_pct != null) parts.push(`Top-2-box purchase intent is ${analysis.intent.top2_pct}%.`);
        break;
      }
      case 'roadmap': {
        const top = analysis.maxdiff?.features?.[0];
        if (top) parts.push(`"${top.label || top.feature_id}" ranks highest on MaxDiff utility (${top.utility}).`);
        const must = (analysis.kano?.features || []).filter((f) => f.classification === 'must_be').map((f) => f.label || f.feature_id);
        if (must.length) parts.push(`Kano must-haves: ${must.join(', ')}.`);
        break;
      }
      case 'naming': {
        const w = analysis.winner?.candidate_id;
        const wc = (analysis.candidates || []).find((c) => c.candidate_id === w);
        if (wc) parts.push(`"${wc.label || w}" is the preferred name (${wc.pairwise_win_rate?.pct ?? wc.composite}${wc.pairwise_win_rate ? '% win rate' : ' composite'}).`);
        break;
      }
      case 'compare': {
        const w = analysis.overall_winner?.concept_id;
        const wc = (analysis.concepts || []).find((c) => c.concept_id === w);
        if (wc) parts.push(`"${wc.label || w}" is the preferred concept (${wc.final_choice_pct?.pct ?? '?'}% forced choice).`);
        break;
      }
      case 'competitor': {
        if (analysis.focal_brand) parts.push(`Competitive position assessed for ${analysis.focal_brand}.`);
        const gap = (analysis.gaps || [])[0];
        if (gap) parts.push(`Largest attribute gap vs ${gap.best_competitor}: "${gap.attribute}" (${gap.gap} pts).`);
        break;
      }
      case 'churn': {
        const d = analysis.drivers?.ranked?.[0];
        if (d) parts.push(`The leading churn driver is "${d.reason}" (${d.pct_of_respondents}% of respondents).`);
        if (analysis.winback?.winnable_pct != null) parts.push(`${analysis.winback.winnable_pct}% appear winnable.`);
        break;
      }
      case 'audience_profiling': {
        if (analysis.posture === 'segmented' && Array.isArray(analysis.segments)) {
          const primary = analysis.segments.find((s) => s.is_primary) || analysis.segments[0];
          parts.push(`${analysis.segment_count} distinct segments emerged.`);
          if (primary) parts.push(`The primary target is "${primary.name}" (${primary.size_pct}% of the audience).`);
        } else {
          parts.push('The sample was too small to segment reliably; an aggregate profile is reported.');
        }
        break;
      }
      case 'market_entry': {
        const m = (analysis.markets || [])[0];
        if (m) parts.push(`${m.market} shows the strongest demand (index ${m.demand_index}/100, ${m.purchase_intent_pct}% intent — ${String(m.signal || '').replace('_', '-')}).`);
        if (analysis.top_barrier) parts.push(`The top adoption barrier is "${analysis.top_barrier}".`);
        break;
      }
      default:
        break;
    }
  } catch { /* fully defensive — fall through to the generic line */ }
  // Pass 49 — NO hedge strings. A clean computed summary reads as a complete
  // finding, not an apology. (The dedicated reportSummaries generator is the
  // primary path; this stays a clean last resort.)
  if (parts.length === 0) {
    return n ? `The computed results below summarise responses from ${n}.` : null;
  }
  return `${parts.join(' ')}${n ? ` (${n})` : ''}`.trim();
}

/**
 * Synthesize a full insight report from aggregated responses.
 * @param {object} mission
 * @param {Array}  responses  rows from mission_responses
 * @param {object} [analysis] deterministic methodology analysis (Pass 46 Phase 3)
 * @returns {Promise<object>} { executive_summary, kpis, per_question_insights, recommendations, follow_ups, contradictions }
 */
async function synthesizeInsights(mission, responses, analysis = null) {
  const questions = mission.questions || [];
  const agg = aggregate(responses, questions);

  // §8 — "who responded" personas, computed DETERMINISTICALLY from the achieved
  // respondent profiles (real shares + modal traits; no LLM, no recomputed stats).
  // Attached to every return path so insights.personas is always grounded; a
  // future LLM prose layer may enrich the strings but never the shares/grouping.
  const personas = computePersonas(responses, mission);

  // Pass 46 Phase 3 — computed-analysis injection. When runMission hands
  // us the deterministic methodology analysis (src/services/analysis/),
  // the narrator writes prose ABOUT those numbers and NEVER recomputes
  // them. Capped so a long VW curve can't blow the prompt budget.
  let analysisBlock = '';
  if (analysis) {
    let analysisJson = JSON.stringify(analysis, null, 2);
    if (analysisJson.length > 9000) analysisJson = `${analysisJson.slice(0, 9000)}\n…(truncated)`;
    analysisBlock = `
COMPUTED METHODOLOGY ANALYSIS (authoritative, computed server-side):
${analysisJson}

RULE: every methodology number in your output (lift points, significance,
optimal price, NPS, utilities, win rates…) MUST come verbatim from the
COMPUTED METHODOLOGY ANALYSIS block above. Do NOT recompute, re-derive,
estimate, or round differently. If a number is null/missing there, say the
data does not support it — never invent it.
`;
  }

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

  // Pass 42 A4 — partial-delivery acknowledgement. When the recruit
  // loop terminated via the 70% margin ceiling (recruitment_status
  // === 'ceiling_hit'), tell the synthesis model so the Executive
  // Summary opens honestly. NO REFUNDS policy means we cannot offer
  // a re-run, but we also can't ignore the under-delivery — the
  // synthesis pretending it's a normal full sample would be a lie.
  const targetCount = mission.target_qualified_count
    || mission.respondent_count
    || 0;
  const isPartial = mission.recruitment_status === 'ceiling_hit'
    || (targetCount > 0 && completedCount > 0 && completedCount < targetCount);
  const partialNotice = isPartial
    ? `\nIMPORTANT — PARTIAL DELIVERY: This mission was paid for ${targetCount} qualified respondents but only ${completedCount} qualified within the customer's screener constraints. Open the Executive Summary with one honest sentence acknowledging this (e.g. "Your screener was strict — we surfaced N qualified responses out of the M you requested."). Do not apologize. Do not recommend a re-run — the customer agreed at checkout that strict screeners may produce partial delivery. Frame the remaining insights as the directional signal they are.\n`
    : '';

  // Pass 44 — methodology-specific chart_data instructions. The Pass 42
  // B1 prompt never asked for chart_data.methodology_specific, so the
  // D1-D4 frontend charts (BrandLift pre/post, Pricing WTP/demand,
  // Naming head-to-head, Roadmap quadrant) had no data on new missions.
  // Conditional per goal_type so unrelated methodologies don't pay the
  // tokens or risk hallucinated blocks.
  const METHODOLOGY_CHART_INSTR = {
    brand_lift: `

Pass 44 — ALSO emit chart_data.methodology_specific.brand_lift when the responses support it:
"methodology_specific": { "brand_lift": { "pre": {"recall": <0-100>, "awareness": <0-100>, "intent": <0-100>}, "post": {...same keys}, "lift_pct": {...same keys, post minus pre} } }
Derive pre/post from control vs exposed respondent groups when exposure_status is present; otherwise estimate baseline vs current from the response content. Omit the block if neither is derivable.`,
    pricing: `

Pass 44 — ALSO emit chart_data.methodology_specific.pricing when the responses support it:
"methodology_specific": { "pricing": { "wtp_buckets": {"<price>": <count>, ...}, "demand_at_price": [{"price": <number>, "demand_pct": <0-100>}, ...], "optimal_price": <number> } }
Derive from any willingness-to-pay / price-rating answers. Omit if no price signal exists in the responses.`,
    naming_messaging: `

Pass 44 — ALSO emit chart_data.methodology_specific.naming when the responses support it:
"methodology_specific": { "naming": [ {"name": "<candidate>", "love": <count>, "like": <count>, "neutral": <count>, "dislike": <count>, "top_phrase": "<short verbatim>"}, ... ] }
Derive per name candidate mentioned in the questions/responses. Omit if no name candidates appear.`,
    roadmap: `

Pass 44 — ALSO emit chart_data.methodology_specific.roadmap when the responses support it:
"methodology_specific": { "roadmap": [ {"feature": "<short name>", "importance": <1-5>, "feasibility": <1-5>, "mentions": <count>}, ... ] }
Derive per feature mentioned in the questions/responses. Use respondent-implied importance; estimate feasibility only when respondents address it, else 3. Omit if no features appear.`,
  };
  const methodologySpecificInstr = METHODOLOGY_CHART_INSTR[mission.goal_type] || '';

  const userPrompt = `${partialNotice}Mission brief: ${mission.brief || mission.mission_statement || ''}
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
${analysisBlock}
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
  ],
  "chart_data": {
    "per_question_distributions": [
      {
        "question_id": "q1",
        "question": "Verbatim question text",
        "type": "multi_select | single_choice | rating | text",
        "options": ["Option A", "Option B"],
        "counts": [3, 4],
        "percentages": [42.9, 57.1]
      },
      {
        "question_id": "q2",
        "question": "Verbatim rating question",
        "type": "rating",
        "scale_max": 5,
        "buckets": {"1": 1, "2": 2, "3": 4, "4": 2, "5": 1},
        "mean": 3.0,
        "median": 3
      }
    ],
    "sentiment_breakdown": {
      "positive": 4,
      "neutral": 5,
      "negative": 1
    },
    "segment_distributions": [
      {
        "segment_name": "18-29",
        "n": 6,
        "key_metric_values": {"purchase_intent_mean": 4.2}
      }
    ]
  }
}

Identify the 2 to 3 most informative segmentation axes from the persona profiles. For each axis, return per-segment counts (n) and one to two sentences calling out where that segment diverges from the overall result. Skip axes that don't produce meaningful differentiation. If the sample is too small or homogeneous to segment usefully, return an empty array.

Pass 42 B1 — also emit the chart_data block. Frontend renders charts (distribution bars, sentiment donut, segment comparison) from this structure. Per-question rules:
- For multi_select / single_choice questions: emit options[] (parallel arrays), counts[] of length(options), percentages[] of length(options). Percentages should sum to ~100 (rounding allowed).
- For rating questions: emit scale_max (the top of the rating scale, usually 5 or 10), buckets (object keyed by string rating value -> count), mean, median.
- For text questions: omit from per_question_distributions. They go through sentiment_breakdown instead.
- sentiment_breakdown is a single aggregate across all open-text responses in the mission. If there are no text responses, omit this field entirely.
- segment_distributions echoes segment_breakdowns but with a single key_metric_values object per segment (key = metric name like "purchase_intent_mean", value = numeric). If no good aggregable metric exists for a segment, omit that segment.

If chart_data cannot be reliably emitted (very small sample, malformed responses), omit the whole chart_data block. Frontend treats absence as "no charts" not "broken charts".${methodologySpecificInstr}`;

  // Scale the synthesis token budget to the survey length. The OLD floor (4000)
  // truncated LOW-question-count but output-rich methodologies: market_entry has
  // only ~7 questions → it hit the 4000 floor, yet its JSON carries a per-market
  // exec summary + a large chart_data block (per-question distributions × every
  // segment) → "Unexpected end of JSON input" → computed fallback on a clean n=80
  // run. The output budget scales with question COUNT but the real output scales
  // with segments too, so the floor must be generous. insight_synth runs on
  // sonnet-4-6 (large max output), so floor 8000 (2× the prior truncation point)
  // / cap 12000 is safe. NB chart_data here is DISCARDED — runMission always
  // overwrites insights.chart_data with the deterministic computeChartData — so a
  // follow-up could drop the chart_data ask from this prompt to cut cost ~⅓.
  const synthMaxTokens = Math.min(12000, Math.max(8000, (questions.length || 0) * 500));

  // Pass 47 — retry once on a parse failure (truncation/hiccup) before
  // giving up. Returns a parsed object or null.
  const callAndParse = async () => {
    const response = await callClaude({
      callType: 'insight_synth',
      missionId: mission.id,
      userId:    mission.user_id,
      messages:  [{ role: 'user', content: userPrompt }],
      systemPrompt: INSIGHT_SYSTEM_PROMPT,
      maxTokens: synthMaxTokens,
      enablePromptCache: true,
    });
    try {
      return extractJSON(response.text);
    } catch (err) {
      logger.warn('Insight synthesis parse failed (will assess retry)', {
        missionId: mission.id, err: err.message,
      });
      return null;
    }
  };

  try {
    let parsed = await callAndParse();
    if (!parsed) {
      logger.info('Insight synthesis: retrying once', { missionId: mission.id });
      parsed = await callAndParse();
    }
    if (!parsed) {
      // Both attempts failed to parse. Throw into the catch below, which
      // now builds a COMPUTED fallback from the deterministic analysis
      // instead of the useless "contact support" string.
      throw new Error('synthesis JSON unparseable after retry');
    }
    // Defensive defaults in case the model omits these optional fields.
    if (!Array.isArray(parsed.contradictions))     parsed.contradictions     = [];
    if (!Array.isArray(parsed.segment_breakdowns)) parsed.segment_breakdowns = [];
    // Pass 42 B1 — chart_data validation. The block is optional. If
    // present but malformed, log + discard rather than failing the
    // whole synthesis (Doctrine #19: don't crash on schema drift).
    if (parsed.chart_data && typeof parsed.chart_data === 'object') {
      const cd = parsed.chart_data;
      if (cd.per_question_distributions && !Array.isArray(cd.per_question_distributions)) {
        logger.warn('Insight synthesis: chart_data.per_question_distributions not an array; dropping', {
          missionId: mission.id,
        });
        delete cd.per_question_distributions;
      }
      if (cd.segment_distributions && !Array.isArray(cd.segment_distributions)) {
        logger.warn('Insight synthesis: chart_data.segment_distributions not an array; dropping', {
          missionId: mission.id,
        });
        delete cd.segment_distributions;
      }
      if (cd.sentiment_breakdown && typeof cd.sentiment_breakdown !== 'object') {
        logger.warn('Insight synthesis: chart_data.sentiment_breakdown not an object; dropping', {
          missionId: mission.id,
        });
        delete cd.sentiment_breakdown;
      }
      // If chart_data is now empty after pruning, drop the whole block
      // so the frontend's "no chart_data" branch fires cleanly rather
      // than an empty-object branch.
      if (Object.keys(cd).length === 0) delete parsed.chart_data;
    } else if (parsed.chart_data != null) {
      logger.warn('Insight synthesis: chart_data not an object; dropping', { missionId: mission.id });
      delete parsed.chart_data;
    }
    // Pass 23 — em-dash sanitizer (post-generation). Pre-prompt swap was
    // insufficient: production audit found em-dashes on every page checked
    // (Bali, General Research, Recommended Next Step, AI Insights). The
    // sanitizer is the canonical defense — applied before persistence so
    // every JSONB field stamped to missions.insights is clean.
    // Deterministic personas win unless a future LLM path supplies its own.
    if (!Array.isArray(parsed.personas) || !parsed.personas.length) parsed.personas = personas;
    return sanitizeAIOutputDeep(parsed);
  } catch (err) {
    logger.error('Insight synthesis failed; using computed fallback', { missionId: mission.id, err: err.message });
    // Pass 47 — NEVER overwrite a successful deterministic analysis with a
    // "contact support" string. When the LLM narrator can't produce
    // parseable JSON, synthesize a factual executive summary from the
    // computed analysis object (the numbers are real and already
    // persisted to mission.analysis) so the result page shows genuine
    // content + its centerpiece instead of an error. The narrator is a
    // nice-to-have prose layer; the computed analysis is the product.
    const computedSummary = buildComputedSummary(analysis, mission);
    return {
      executive_summary: computedSummary
        || 'A full written summary is being finalized. Your computed results below are complete and accurate.',
      narration_failed: true, // signal for ops/telemetry; renderer ignores
      kpis: [],
      per_question_insights: [],
      recommendations: [],
      follow_ups: [],
      contradictions: [],
      segment_breakdowns: [],
      personas,
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
  // Pass 47 — exported for the narrator-fallback unit test.
  buildComputedSummary,
};
