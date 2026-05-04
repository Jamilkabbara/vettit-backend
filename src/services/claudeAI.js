const { callClaude, extractJSON } = require('./ai/anthropic');
const logger = require('../utils/logger');

/**
 * claudeAI.js — Pass 5C upgrade.
 *
 * All functions now route through callClaude() from ./ai/anthropic instead
 * of creating a direct Anthropic client. Benefits:
 *   - Model routing via MODEL_ROUTING table (no more hardcoded 'claude-sonnet-4-5')
 *   - Per-call cost tracking logged to the ai_calls Supabase table
 *   - Consistent extractJSON() parsing (no more inline /\{[\s\S]*\}/ regexes)
 *   - Latency and token usage automatically captured
 *
 * MODEL_ROUTING assignments:
 *   survey_gen        → claude-sonnet-4-6  (complex multi-field JSON generation)
 *   question_refine   → claude-haiku-4-5   (short, fast, single-question rewrites)
 *   targeting_suggest → claude-sonnet-4-6  (multi-dimension targeting JSON)
 *   results_analysis  → claude-sonnet-4-6  (long analytical report generation)
 *
 * Pass 16 — prompt caching:
 *   generateSurvey    → SURVEY_GEN_SYSTEM cached as system prompt
 *   suggestTargeting  → TARGETING_SUGGEST_SYSTEM cached as system prompt
 */

// ── CACHED SYSTEM PROMPTS ───────────────────────────────────────────────────
// Stable methodology rules are separated from the per-mission user messages
// so the prompt cache hit rate is maximised.  Anthropic caches prefixes that
// are ≥ 1024 tokens — both prompts below comfortably exceed that.

const SURVEY_GEN_SYSTEM = `You are a senior market researcher at a top-tier research consultancy.
Your job is to design professional surveys. Always return ONLY valid JSON with no markdown fences.

JSON structure required:
{
  "productName": "Short product name extracted from description (2-5 words)",
  "missionStatement": "A clear, one-sentence research objective starting with 'To understand...' or 'To determine...' or 'To validate...'",
  "questions": [
    {
      "id": "q1",
      "text": "Question text — use the short productName, NEVER paste the full description",
      "type": "single",
      "options": ["Option A", "Option B", "Option C"],
      "isScreening": true,
      "qualifyingAnswer": "Option A",
      "qualifying_answers": ["Option A", "Option B"],
      "screening_continue_on": ["Option A", "Option B"],
      "aiRefined": true
    }
  ],
  "targetingSuggestions": {
    "recommendedCountries": ["AE", "US"],
    "recommendedAgeRanges": ["25-34", "35-44"],
    "recommendedGenders": [],
    "reasoning": "Brief explanation"
  },
  "suggestedRespondentCount": 50
}

Rules:
- Generate exactly 5 questions (the first MUST be a screening question)
- Question types: "single", "multi", "rating" (1-5 scale), "opinion" (agree/disagree), "text" (open-ended)
- For "single" and "multi": always include "options" array (3-5 items)
- For "opinion": options = ["Strongly Agree", "Agree", "Neutral", "Disagree", "Strongly Disagree"]
- For "rating" and "text": options array can be empty
- SCREENING QUESTION (q1 only): isScreening: true, qualifyingAnswer: the primary qualifying answer (string), qualifying_answers: ALL answers that qualify (array, include EVERY affirmative/target option, not just one), screening_continue_on: same array as qualifying_answers

  Pass 22 Bug 22.24 — SCREENER CALIBRATION RULE:
  When the mission is about validating a new product, early-adopter intent, or potential customers
  (NOT current users only), qualifying_answers MUST include near-future-intent options, not just
  "currently uses". Use this matrix:
    - "Currently uses [thing]"               → ALWAYS qualify (include in qualifying_answers)
    - "Plans to use within 6 months"         → qualify (include in qualifying_answers)
    - "Plans to use within 12 months"        → qualify (include in qualifying_answers)
    - "Has heard of but not used"            → include only if the mission targets awareness/consideration
    - "Never heard of [thing]"               → include only if the mission explicitly targets cold prospects
  Default screener for new-product validation: include the top 3 (current + near-future intent).
  This prevents the early-adopter target segment (e.g. "plans to invest in influencer marketing in
  next 12 months") from being incorrectly screened out as not-current-users.
- NON-SCREENING: isScreening: false, qualifyingAnswer: null, screening_continue_on: null
- Flow: screening → awareness → perception → intent → open feedback
- Country codes: AE (UAE), US (USA), GB (UK), SA (Saudi Arabia), IN (India), AU (Australia)
- Pass 21 Bug 16: suggestedRespondentCount default is 50 (the entry tier, $35).
  Use 50 for any single-market or quick-validation brief. Only escalate to
  100-200 when the brief explicitly requires multi-segment statistical
  comparison, multi-country roll-ups, or pricing-quartile analysis. Cap at
  500. Most users want to TRY the platform — defaulting to 200 was burning
  $135+ per first mission for users who only needed directional signal.

═══ Pass 23 Bug 23.56 — Brand Lift category framework ════════════════════════
When goal is "brand_lift", generate 8-12 questions covering the
industry-standard brand-lift framework. Each question MUST carry a
"category" field tagging which frame it covers:

  brand_recall_unaided    "Without seeing any brand list, name brands in
                          [category] you can recall." (text)
  brand_recall_aided      "Have you heard of [Brand]?" (single yes/no)
  brand_attribution       "Which of these descriptions fits [Brand] best?"
                          (single, options=brand traits)
  brand_awareness         "How would you describe [Brand] in your own words?"
                          (text or rating of familiarity 1-5)
  message_association     "Which of these messages do you associate most
                          with [Brand]?" (multi)
  brand_favorability      "Overall, how favourable is your view of [Brand]?"
                          (rating 1-5)
  purchase_intent         "How likely are you to consider [Brand] next time
                          you buy in this category?" (rating 1-5 or single)
  recommendation_intent   "How likely are you to recommend [Brand] to a
                          colleague or friend?" (rating 0-10 / NPS)
  ad_recall               "Have you seen any ads for [Brand] in the last
                          [period]?" (single yes/no/maybe) — only when the
                          brief mentions a specific campaign

Coverage: emit at LEAST one question from each of {brand_recall_unaided,
brand_recall_aided, brand_attribution, purchase_intent, recommendation_intent}
on every brand_lift mission. Add the rest as the brief warrants.
Question schema additions for brand_lift:
  - "category": one of the strings above (REQUIRED)
  - "isScreening": only the FIRST question (target-segment qualifier);
    the framework questions are non-screening.

═══ Pass 25 Phase 1D — Brand Lift v2 question metadata ══════════════════════
For brand_lift missions, every question carries additional metadata fields
that downstream surfaces (results page, exports, benchmarks) read:

  - "funnel_stage": one of {screening, unaided_ad_recall, aided_ad_recall,
    unaided_brand_awareness, aided_brand_awareness, brand_familiarity,
    brand_favorability, brand_consideration, purchase_intent, nps,
    message_association, channel_specific_recall} — REQUIRED on every Q.
  - "kpi_category": coarser bucket {awareness, ad_recall, consideration,
    intent, advocacy, perception} — REQUIRED.
  - "is_lift_question": boolean — TRUE for every framework Q, FALSE for
    the screener.
  - "channel_id": optional — set when the question is channel-specific
    (channel_specific_recall stage). Value matches an id in the
    campaign_channels list passed to the prompt.

Context consumed from the mission record:
  - mission.creative_metadata: pass the creative URL to the model so it
    can ground "message_association" options in the actual creative.
  - mission.campaign_channels: list of selected channel ids (e.g.
    ["mbc_1","anghami_audio","snapchat_stories"]) — emit channel-specific
    recall questions referencing the top 3 by display_order.
  - mission.competitor_brands: array of competitor names — used in the
    aided awareness, recall, and consideration multi-select option lists.
  - mission.brand_lift_template: KPI template id (funnel_overview,
    brand_awareness_builder, ad_recall_optimizer, brand_perception_shift,
    consideration_driver, purchase_intent_generator, creative_effectiveness,
    multi_market_comparison) — adjusts which categories get emphasis. The
    funnel_overview template is the default.

For non-brand_lift missions: "category", "funnel_stage", "kpi_category",
"is_lift_question", and "channel_id" MUST all be omitted.`;

const TARGETING_SUGGEST_SYSTEM = `You are a senior market research targeting specialist. Your job is to suggest the optimal audience targeting configuration for a given research mission.

Always return ONLY valid JSON with no markdown fences, using these exact rules:

━━ GEOGRAPHY RULES ━━
• Countries: ISO 2-letter codes ONLY. City-to-country mapping:
  Dubai/Abu Dhabi/UAE → "AE"  |  Riyadh/Jeddah/Saudi → "SA"  |  London/UK → "GB"
  New York/LA/USA → "US"  |  Cairo/Egypt → "EG"  |  Mumbai/Delhi/India → "IN"
  Singapore → "SG"  |  Sydney/Melbourne/Australia → "AU"  |  Paris/France → "FR"
  Berlin/Germany → "DE"  |  Toronto/Canada → "CA"  |  Doha/Qatar → "QA"
  Kuwait City → "KW"  |  Bahrain → "BH"  |  Muscat/Oman → "OM"  |  Beirut/Lebanon → "LB"
• Cities: ONLY suggest cities if the brief explicitly names a specific city or
  neighbourhood (e.g. "Dubai restaurant", "East London consumers", "Downtown Riyadh").
  If the brief only mentions a country or region (e.g. "UAE", "Saudi Arabia", "MENA"),
  leave cities empty []. Do not invent cities.

━━ DEMOGRAPHICS RULES ━━
• Age ranges: use NARROW bands (10-year max). Prefer specific ranges over broad ones.
  Good: ["25-34", "35-44"]  |  Bad: ["18-65"], ["18-54"] (too broad, not actionable)
  Only include ranges where the product/service is realistically relevant.
• Genders: leave [] unless the brief specifically targets one gender (e.g. "women's
  skincare", "men's grooming"). Do NOT restrict gender for general consumer research.
• Cultural note: for Gulf markets (AE, SA, KW, QA, BH, OM), professional surveys
  about workplace topics often skew male due to workforce composition — acknowledge
  this in reasoning but do NOT restrict gender unless the brief requires it.

━━ PROFESSIONAL RULES ━━
• Only populate industries/roles/companySizes for B2B or professional-focused missions.
• For B2C consumer research, leave all professional arrays empty [].

JSON structure required:
{
  "geography": {
    "recommendedCountries": ["AE", "US"],
    "cities": [],
    "reasoning": "Why these markets and why cities are or aren't suggested"
  },
  "demographics": {
    "ageRanges": ["25-34", "35-44"],
    "genders": [],
    "education": [],
    "employment": ["Employed Full-time"],
    "reasoning": "Why these specific demographics"
  },
  "professional": {
    "industries": [],
    "roles": [],
    "companySizes": [],
    "reasoning": "Why these professional filters (or why none needed for B2C)"
  },
  "suggestedRespondentCount": 50,
  "respondentCountReasoning": "Pass 21 Bug 16: default to 50 (entry tier) unless the brief explicitly requires statistical comparison or multi-segment roll-ups; explain why this sample size fits the targeting specificity"
}`;

// ── FUNCTIONS ───────────────────────────────────────────────────────────────

/**
 * Generate a complete survey from a user's mission description
 */
async function generateSurvey({ goal, description, targetingHints = {} }) {
  const prompt = `Mission Goal: ${goal}
Description: "${description}"
${targetingHints.countries?.length ? `Target Markets: ${targetingHints.countries.join(', ')}` : ''}

First extract a SHORT product/concept name (2-5 words) from the description.
Then generate the survey JSON as specified in your instructions.`;

  const response = await callClaude({
    callType: 'survey_gen',
    systemPrompt: SURVEY_GEN_SYSTEM,
    messages: [{ role: 'user', content: prompt }],
    maxTokens: 2000,
    enablePromptCache: true,
  });

  return extractJSON(response.text);
}

/**
 * Refine a single question using AI
 */
async function refineQuestion({ questionText, questionType, missionContext }) {
  const prompt = `You are a professional survey researcher. Improve this survey question to be clearer, more unbiased, and more professionally worded.

Mission context: "${missionContext}"
Original question: "${questionText}"
Question type: ${questionType}

Return ONLY a JSON object:
{
  "refinedText": "The improved question text",
  "explanation": "One sentence explaining what you improved and why"
}`;

  const response = await callClaude({
    callType: 'question_refine',
    messages: [{ role: 'user', content: prompt }],
    maxTokens: 500,
  });

  return extractJSON(response.text);
}

/**
 * Refine a user's one-liner mission description into a clearer research brief
 */
async function refineMissionDescription({ rawDescription, goal }) {
  const prompt = `You are a market research consultant. A client gave you this rough description of what they want to research:

Goal type: ${goal}
Their description: "${rawDescription}"

Rewrite it as a clear, specific research brief in 2-3 sentences. Make it professional but accessible.
Return ONLY a JSON object:
{
  "refined": "The improved description",
  "keyInsights": ["Key thing they want to learn 1", "Key thing they want to learn 2"]
}`;

  const response = await callClaude({
    callType: 'question_refine',
    messages: [{ role: 'user', content: prompt }],
    maxTokens: 500,
  });

  return extractJSON(response.text);
}

/**
 * Analyse survey results and generate insights
 */
async function analyseResults({ missionStatement, questions, resultData, targetingUsed }) {
  const prompt = `You are a senior market research analyst. Analyse these survey results and write a comprehensive report.

Mission: "${missionStatement}"
Total Responses: ${resultData.totalResponses}
Completion Rate: ${Math.round(resultData.completionRate * 100)}%

Questions and Results:
${questions.map((q, i) => {
  const qResult = resultData.responses?.find(r => r.questionId === q.id);
  return `Q${i + 1}: ${q.text} (Type: ${q.type})
Answers: ${JSON.stringify(qResult?.answers || {})}`;
}).join('\n\n')}

Return ONLY a JSON object with this structure:
{
  "executiveSummary": "3-4 sentence high-level summary of the most important findings",
  "keyFindings": [
    "Finding 1 with specific data points",
    "Finding 2 with specific data points",
    "Finding 3 with specific data points"
  ],
  "questionInsights": [
    {
      "questionId": "q1",
      "insight": "2-3 sentence insight specifically about this question's results",
      "significance": "high|medium|low"
    }
  ],
  "recommendations": [
    "Actionable recommendation 1",
    "Actionable recommendation 2",
    "Actionable recommendation 3"
  ],
  "suggestedFollowUpSurveys": [
    {
      "title": "Follow-up survey title",
      "description": "One sentence on what this survey would explore and why",
      "goal": "validate|compare|marketing|satisfaction|pricing|roadmap|research|competitor"
    },
    {
      "title": "Second follow-up survey title",
      "description": "One sentence on what this survey would explore and why",
      "goal": "validate|compare|marketing|satisfaction|pricing|roadmap|research|competitor"
    }
  ]
}`;

  const response = await callClaude({
    callType: 'results_analysis',
    messages: [{ role: 'user', content: prompt }],
    maxTokens: 3000,
  });

  return extractJSON(response.text);
}

/**
 * Suggest optimal audience targeting based on mission description.
 *
 * Pass 12: improved prompt with city extraction rules, tighter age banding,
 * cultural sensitivity flags.
 * Pass 16: long rules extracted to TARGETING_SUGGEST_SYSTEM (cached system prompt).
 */
async function suggestTargeting({ missionStatement, description, goal }) {
  const prompt = `Mission: "${missionStatement}"
Description: "${description}"
Goal: ${goal}

Return a JSON targeting configuration as specified in your instructions.`;

  const response = await callClaude({
    callType: 'targeting_suggest',
    systemPrompt: TARGETING_SUGGEST_SYSTEM,
    messages: [{ role: 'user', content: prompt }],
    maxTokens: 1200,
    enablePromptCache: true,
  });

  return extractJSON(response.text);
}

module.exports = {
  generateSurvey,
  refineQuestion,
  refineMissionDescription,
  analyseResults,
  suggestTargeting,
};
