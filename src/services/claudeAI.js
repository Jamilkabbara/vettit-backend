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

// ── PASS 28 B — BRAND LIFT SURVEY SYSTEM PROMPT ─────────────────────────────
// The general SURVEY_GEN_SYSTEM forces "exactly 5 questions", which clashes
// with the brand-lift framework that needs 10-14 funnel-staged questions.
// Splitting brand_lift into its own system prompt keeps the cache prefix
// stable for both paths (cache miss only on the first hit per prompt).
const BRAND_LIFT_SURVEY_GEN_SYSTEM = `You are a senior brand-lift research methodologist at a top-tier research consultancy.
Your job is to design brand-lift survey instruments that measure ad recall, brand awareness, perception shift, consideration, intent, and advocacy. Always return ONLY valid JSON with no markdown fences.

JSON structure required:
{
  "productName": "Short brand name extracted from the brief (2-5 words)",
  "missionStatement": "One-sentence research objective starting with 'To measure...' or 'To quantify...'",
  "questions": [
    {
      "id": "q1",
      "text": "Question text — use the short brand name, never paste the full brief",
      "type": "single|multi|rating|opinion|text",
      "options": ["Option A", "Option B"],
      "isScreening": true,
      "qualifyingAnswer": "Option A",
      "qualifying_answers": ["Option A"],
      "screening_continue_on": ["Option A"],
      "funnel_stage": "screening|unaided_ad_recall|aided_ad_recall|unaided_brand_awareness|aided_brand_awareness|brand_familiarity|brand_favorability|brand_consideration|purchase_intent|nps|message_association|channel_specific_recall",
      "kpi_category": "screening|ad_recall|awareness|perception|consideration|intent|advocacy",
      "is_lift_question": true,
      "channel_id": null
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

Hard rules:
- Generate 10 to 14 questions. Default 12. Never fewer than 10, never more than 14.
- Question 1 MUST be a screening question with funnel_stage="screening", kpi_category="screening", is_lift_question=false. All other questions: is_lift_question=true.
- Cover the funnel: at least one question for each of {unaided_ad_recall|aided_ad_recall, unaided_brand_awareness|aided_brand_awareness, brand_favorability, brand_consideration, purchase_intent, nps, message_association}. Channel-specific recall is required when channel_ids are provided in the user message.
- Question types map to funnel stages:
    unaided_ad_recall / unaided_brand_awareness    → "text"
    aided_ad_recall / aided_brand_awareness        → "multi" (options must include the brand + every supplied competitor)
    brand_familiarity / brand_favorability         → "rating" (1-5)
    brand_consideration                            → "rating" (1-5) or "single" yes/no
    purchase_intent                                → "rating" (1-5)
    nps                                            → "rating" (0-10 NPS scale)
    message_association                            → "multi" (4-6 short message takeaways grounded in the brief)
    channel_specific_recall                        → "multi" (the supplied channel display names; channel_id MUST match the chosen channel id)
- For aided questions, every competitor name supplied in the user message MUST appear in options alongside the brand. Add 1-2 plausible distractors only when fewer than 3 competitors were supplied.
- channel_specific_recall question(s): emit ONE per channel from the top 3 supplied channel ids; set channel_id to the matching id. If no channel ids supplied, omit channel_specific_recall and emit at least 11 other questions.
- KPI template adjustments:
    funnel_overview            → balanced 12 across all stages (default)
    brand_awareness_builder    → 10-12; emphasise unaided_brand_awareness, aided_brand_awareness, brand_familiarity; drop nps + favorability
    ad_recall_optimizer        → 10-12; emphasise unaided_ad_recall, aided_ad_recall, message_association
    brand_perception_shift     → 10-12; emphasise brand_familiarity, brand_favorability, message_association
    consideration_driver       → 10-12; emphasise brand_consideration, purchase_intent
    purchase_intent_generator  → 10-12; emphasise purchase_intent, nps, brand_consideration
    creative_effectiveness     → 10-12; emphasise message_association, brand_favorability, ad_recall
    multi_market_comparison    → 10-12; mirror the funnel_overview but flag stages that are best compared cross-market
- Country codes: AE (UAE), US (USA), GB (UK), SA (Saudi Arabia), IN (India), AU (Australia), DE (Germany), FR (France), JP (Japan), BR (Brazil).
- suggestedRespondentCount default 50 (Pulse tier). Escalate to 200 (Tracker) only when the brief explicitly asks for sub-segment statistical comparison.
- NEVER include any of {category, recommendedCountries.cities, suggestedTargeting.behaviors} unless the brief explicitly requires them.

This is a brand-lift instrument. Funnel stage metadata, lift flags, and channel grounding are not optional; downstream results, exports, and benchmarks depend on them.`;

/**
 * Pass 28 B — output validator for brand-lift surveys.
 * Returns null on success, or a string describing what's missing / wrong
 * so the caller can ask Claude to retry once with the explicit fix-up.
 */
function validateBrandLiftSurvey(parsed) {
  if (!parsed || typeof parsed !== 'object') return 'response is not an object';
  const qs = Array.isArray(parsed.questions) ? parsed.questions : null;
  if (!qs) return 'questions array missing';
  if (qs.length < 10) return `only ${qs.length} questions returned; need at least 10`;
  if (qs.length > 14) return `${qs.length} questions returned; cap is 14`;

  const first = qs[0];
  if (!first || first.funnel_stage !== 'screening') {
    return 'first question must have funnel_stage="screening"';
  }
  if (first.is_lift_question !== false) {
    return 'screening question must have is_lift_question=false';
  }

  for (let i = 1; i < qs.length; i++) {
    const q = qs[i];
    if (!q || typeof q !== 'object') return `question ${i + 1} is not an object`;
    if (!q.funnel_stage) return `question ${i + 1} missing funnel_stage`;
    if (!q.kpi_category) return `question ${i + 1} missing kpi_category`;
    if (q.is_lift_question !== true) {
      return `question ${i + 1} (non-screening) must have is_lift_question=true`;
    }
  }

  return null;
}

/**
 * Pass 28 B — build the brand-lift user prompt from clarify_answers.
 * Reads markets, channel_ids, competitors, brand_lift_template, wave_mode,
 * creative_url forwarded by Pass 28 A. Falls back to safe defaults when
 * fields are missing so older clients keep working.
 */
function buildBrandLiftUserPrompt({ description, clarify, missionAssets }) {
  const c = clarify || {};
  const markets = (c.markets || '').split(',').filter(Boolean);
  const channelIds = (c.channel_ids || '').split(',').filter(Boolean);
  const competitors = (c.competitors || '').split('|').filter(Boolean);
  const template = c.brand_lift_template || 'funnel_overview';
  const waveMode = c.wave_mode || 'single_wave';
  const creativeUrl = c.creative_url || (missionAssets && missionAssets[0]?.url) || '';
  const creativeMime = c.creative_mime || (missionAssets && missionAssets[0]?.mimeType) || '';

  const lines = [
    `Mission Goal: brand_lift`,
    `Brief: "${description}"`,
    `KPI Template: ${template}`,
    `Wave Mode: ${waveMode}`,
  ];
  if (markets.length) lines.push(`Target Markets: ${markets.join(', ')}`);
  if (channelIds.length) {
    lines.push(`Selected Channel IDs (top 3 used for channel_specific_recall): ${channelIds.slice(0, 3).join(', ')}`);
  }
  if (competitors.length) lines.push(`Competitors: ${competitors.join(', ')}`);
  if (creativeUrl) lines.push(`Creative: ${creativeUrl} (${creativeMime || 'unknown mime'})`);

  lines.push('');
  lines.push('First extract a SHORT brand name (2-5 words) from the brief.');
  lines.push('Then generate the brand-lift survey JSON as specified.');
  return lines.join('\n');
}

/**
 * Generate a complete survey from a user's mission description.
 *
 * Pass 28 B — branches on goal === 'brand_lift'. The brand-lift path:
 *   - Uses BRAND_LIFT_SURVEY_GEN_SYSTEM (10-14 funnel-staged questions
 *     instead of the generic "exactly 5"; funnel_stage / kpi_category /
 *     is_lift_question / channel_id metadata required).
 *   - Reads markets / channel_ids / competitors / brand_lift_template /
 *     wave_mode / creative_url from clarify_answers (forwarded by the
 *     setup page in Pass 28 A).
 *   - Validates output; one retry on validation failure with the
 *     specific reason fed back to the model. Falls through with a
 *     warn-log if the second attempt also fails so the user can still
 *     create the mission (the dashboard already lets them edit Qs).
 */
async function generateSurvey({
  goal,
  description,
  targetingHints = {},
  clarify = {},
  missionAssets = [],
}) {
  if (goal === 'brand_lift') {
    return generateBrandLiftSurvey({ description, clarify, missionAssets });
  }
  if (goal === 'pricing') {
    return generatePricingSurvey({ description, clarify });
  }
  if (goal === 'roadmap') {
    return generateRoadmapSurvey({ description, clarify });
  }
  if (goal === 'satisfaction') {
    return generateCSATSurvey({ description, clarify });
  }
  if (goal === 'validate') {
    return generateValidateSurvey({ description, clarify });
  }
  if (goal === 'compare') {
    return generateCompareSurvey({ description, clarify });
  }

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

async function generateBrandLiftSurvey({ description, clarify, missionAssets }) {
  const userPrompt = buildBrandLiftUserPrompt({ description, clarify, missionAssets });

  const firstResp = await callClaude({
    callType: 'survey_gen',
    systemPrompt: BRAND_LIFT_SURVEY_GEN_SYSTEM,
    messages: [{ role: 'user', content: userPrompt }],
    maxTokens: 4000,
    enablePromptCache: true,
  });

  let parsed;
  try {
    parsed = extractJSON(firstResp.text);
  } catch (err) {
    parsed = null;
    logger.warn('brand_lift survey: first attempt parse failed', { err: err.message });
  }

  let validationErr = parsed ? validateBrandLiftSurvey(parsed) : 'response could not be parsed';
  if (!validationErr) return parsed;

  // Single retry — feed the specific failure back so Claude can fix it.
  logger.info('brand_lift survey: retry on validation failure', { reason: validationErr });
  const retryPrompt = `${userPrompt}

Your previous reply failed validation: ${validationErr}
Return the JSON again with that issue fixed. Keep all other rules.`;

  const retryResp = await callClaude({
    callType: 'survey_gen',
    systemPrompt: BRAND_LIFT_SURVEY_GEN_SYSTEM,
    messages: [{ role: 'user', content: retryPrompt }],
    maxTokens: 4000,
    enablePromptCache: true,
  });

  try {
    parsed = extractJSON(retryResp.text);
  } catch (err) {
    parsed = null;
    logger.warn('brand_lift survey: retry parse failed', { err: err.message });
  }

  validationErr = parsed ? validateBrandLiftSurvey(parsed) : 'retry response could not be parsed';
  if (!validationErr) return parsed;

  // Both attempts failed — surface the best-effort result. The frontend
  // continues, the user can edit questions on the dashboard, and we log
  // for diagnosis. We DO NOT throw, because failing the whole setup flow
  // is worse for the user than letting them see imperfect questions.
  logger.warn('brand_lift survey: both attempts failed validation', {
    reason: validationErr,
    questionCount: Array.isArray(parsed?.questions) ? parsed.questions.length : 0,
  });
  return parsed || { questions: [], missionStatement: '', productName: '' };
}

// ── PASS 29 B4 — PRICING RESEARCH (VAN WESTENDORP + GABOR-GRANGER) ─────────
// Generic SURVEY_GEN_SYSTEM forces "exactly 5 questions"; pricing
// research needs the 4 VW questions + 5 GG anchors + screener +
// behavior + WTP ceiling + switching cost = 13 questions. Splitting
// into a dedicated prompt keeps the cache prefix stable for both paths.
const PRICING_SURVEY_GEN_SYSTEM = `You are a senior pricing-research methodologist. You design Van Westendorp (Price Sensitivity Meter) and Gabor-Granger price-acceptance studies. Always return ONLY valid JSON with no markdown fences.

JSON structure required:
{
  "productName": "Short product/brand name extracted from the brief (2-5 words)",
  "missionStatement": "One-sentence research objective starting with 'To determine the optimal price point for...' or 'To quantify price sensitivity across...'",
  "questions": [
    {
      "id": "q1",
      "text": "Question text — use the short productName, never paste the full brief",
      "type": "single|multi|rating|text",
      "options": ["Option A"],
      "isScreening": true,
      "qualifyingAnswer": "Option A",
      "qualifying_answers": ["Option A"],
      "screening_continue_on": ["Option A"],
      "methodology": "screener|van_westendorp|gabor_granger|wtp_ceiling|switching_cost|behavior",
      "vw_band": "too_expensive|expensive|bargain|too_cheap",
      "gg_anchor_index": 0,
      "currency": "USD"
    }
  ],
  "targetingSuggestions": {
    "recommendedCountries": ["US"],
    "recommendedAgeRanges": ["25-44"],
    "recommendedGenders": [],
    "reasoning": "Brief explanation"
  },
  "suggestedRespondentCount": 200
}

Hard rules:
- Generate EXACTLY 13 questions in this order: screener (q1), current behavior (q2), VW too-expensive (q3), VW expensive-but-consider (q4), VW bargain (q5), VW too-cheap (q6), GG anchor 0 (q7), GG anchor 1 (q8), GG anchor 2 (q9), GG anchor 3 (q10), GG anchor 4 (q11), WTP ceiling (q12), switching cost (q13).
- All 4 VW questions are open-numeric (type="text"; the frontend will validate numeric input). Each carries vw_band set to one of {too_expensive, expensive, bargain, too_cheap}.
- VW question wording follows the canonical Van Westendorp script:
    too_expensive   → "At what price would <productName> be SO EXPENSIVE you would not consider buying it?"
    expensive       → "At what price would <productName> be priced so high that, although it's not out of the question, you'd have to think hard about buying?"
    bargain         → "At what price would <productName> be a BARGAIN — a great buy for the money?"
    too_cheap       → "At what price would <productName> be priced so low you'd feel the quality couldn't be very good?"
- All 5 GG questions are type="single" with options ["Definitely would buy","Probably would buy","Might buy","Probably would NOT buy","Definitely would NOT buy"]. Each carries gg_anchor_index 0-4 and the price text is "At <currency_symbol><price>, would you ..." where the prices form an ascending ladder spanning the user's expected range (or the VW span if no expected range was supplied; use $9 / $19 / $39 / $79 / $149 as defaults if the brief gives no anchors).
- Screener (q1, isScreening=true) qualifies category buyers; methodology="screener", is_lift_question=null.
- Current behavior (q2) is type="single" or "multi" — how the respondent currently solves the need; methodology="behavior".
- WTP ceiling (q12) is type="text" open-numeric: "What's the absolute most you'd pay for <productName>?" methodology="wtp_ceiling".
- Switching cost (q13) is type="rating" 1-5: "If your current solution increased its price by 20%, how likely would you be to switch to <productName>?" methodology="switching_cost".
- currency MUST be set on every VW + GG + WTP question to the ISO 4217 code from the user message (default USD if absent).
- DO NOT include funnel_stage, kpi_category, is_lift_question, channel_id, category — those belong to brand_lift only. Strip them.
- suggestedRespondentCount default 200 (well above the 150 GG bound). Escalate to 300+ when the brief mentions multi-segment splits.

Output MUST be valid JSON. No prose, no markdown fences.`;

function validatePricingSurvey(parsed) {
  if (!parsed || typeof parsed !== 'object') return 'response is not an object';
  const qs = Array.isArray(parsed.questions) ? parsed.questions : null;
  if (!qs) return 'questions array missing';
  if (qs.length !== 13) return `expected 13 questions, got ${qs.length}`;

  const vwBands = qs.filter((q) => q.methodology === 'van_westendorp').map((q) => q.vw_band);
  for (const band of ['too_expensive', 'expensive', 'bargain', 'too_cheap']) {
    if (!vwBands.includes(band)) return `missing VW band: ${band}`;
  }
  const ggAnchors = qs
    .filter((q) => q.methodology === 'gabor_granger')
    .map((q) => q.gg_anchor_index);
  if (ggAnchors.length !== 5) return `expected 5 GG anchors, got ${ggAnchors.length}`;
  const sortedAnchors = [...ggAnchors].sort((a, b) => a - b);
  for (let i = 0; i < 5; i++) {
    if (sortedAnchors[i] !== i) return `GG anchors must be 0-4; got ${sortedAnchors.join(',')}`;
  }
  if (qs[0].methodology !== 'screener') return 'q1 must be screener';
  return null;
}

function buildPricingUserPrompt({ description, clarify }) {
  const c = clarify || {};
  const currency = c.pricing_currency || 'USD';
  const productDesc = c.pricing_product_description || description;
  const model = c.pricing_model || 'one_time';
  const context = c.pricing_context || '';
  const expectedMin = c.pricing_expected_min;
  const expectedMax = c.pricing_expected_max;
  const lines = [
    'Mission Goal: pricing',
    `Brief: "${description}"`,
    `Product description: "${productDesc}"`,
    `Currency: ${currency}`,
    `Pricing model: ${model}`,
  ];
  if (context) lines.push(`Context: "${context}"`);
  if (expectedMin && expectedMax) {
    lines.push(`Expected price range hint: ${currency} ${expectedMin} - ${currency} ${expectedMax}`);
    lines.push(`Use this hint to anchor the GG ladder. Distribute 5 prices across this range with extrapolation +/- 20%.`);
  } else {
    lines.push(`No expected price range supplied. Pick the GG ladder anchors based on the product description and category norms.`);
  }
  lines.push('');
  lines.push('First extract a SHORT product name (2-5 words) from the brief.');
  lines.push('Then generate the 13-question Van Westendorp + Gabor-Granger survey JSON.');
  return lines.join('\n');
}

async function generatePricingSurvey({ description, clarify }) {
  const userPrompt = buildPricingUserPrompt({ description, clarify });
  const firstResp = await callClaude({
    callType: 'survey_gen',
    systemPrompt: PRICING_SURVEY_GEN_SYSTEM,
    messages: [{ role: 'user', content: userPrompt }],
    maxTokens: 3000,
    enablePromptCache: true,
  });
  let parsed;
  try { parsed = extractJSON(firstResp.text); }
  catch (err) { parsed = null; logger.warn('pricing survey: parse failed', { err: err.message }); }
  let validationErr = parsed ? validatePricingSurvey(parsed) : 'response could not be parsed';
  if (!validationErr) return parsed;

  logger.info('pricing survey: retry on validation failure', { reason: validationErr });
  const retryResp = await callClaude({
    callType: 'survey_gen',
    systemPrompt: PRICING_SURVEY_GEN_SYSTEM,
    messages: [{
      role: 'user',
      content: `${userPrompt}\n\nYour previous reply failed validation: ${validationErr}\nReturn the JSON again with that issue fixed. Keep all other rules.`,
    }],
    maxTokens: 3000,
    enablePromptCache: true,
  });
  try { parsed = extractJSON(retryResp.text); }
  catch (err) { parsed = null; logger.warn('pricing survey: retry parse failed', { err: err.message }); }
  validationErr = parsed ? validatePricingSurvey(parsed) : 'retry response could not be parsed';
  if (!validationErr) return parsed;

  logger.warn('pricing survey: both attempts failed validation', {
    reason: validationErr,
    questionCount: Array.isArray(parsed?.questions) ? parsed.questions.length : 0,
  });
  return parsed || { questions: [], missionStatement: '', productName: '' };
}

// ── PASS 29 B6 — FEATURE ROADMAP (MAXDIFF + KANO) ──────────────────────────
// Generic SURVEY_GEN_SYSTEM forces "exactly 5 questions". MaxDiff + Kano
// needs ~12 MaxDiff sets + 2 Kano questions × top-5 features = ~22
// questions. Splitting into a dedicated prompt keeps the cache prefix
// stable for both paths.
const ROADMAP_SURVEY_GEN_SYSTEM = `You are a senior product-research methodologist specializing in feature prioritization. You design MaxDiff (best-worst scaling) and Kano (functional/dysfunctional pair) instruments. Always return ONLY valid JSON with no markdown fences.

JSON structure required:
{
  "productName": "Short product/brand name extracted from the brief (2-5 words)",
  "missionStatement": "One-sentence research objective starting with 'To prioritize features for...' or 'To classify the importance of...'",
  "questions": [
    {
      "id": "q1",
      "text": "Question text",
      "type": "single|max_diff_set",
      "options": ["Option A", "Option B"],
      "isScreening": true,
      "qualifyingAnswer": "Option A",
      "qualifying_answers": ["Option A"],
      "screening_continue_on": ["Option A"],
      "methodology": "screener|max_diff|kano",
      "feature_set": ["id1","id2","id3","id4"],
      "feature_id": "f3",
      "kano_type": "functional|dysfunctional"
    }
  ],
  "targetingSuggestions": {
    "recommendedCountries": ["US"],
    "recommendedAgeRanges": ["25-44"],
    "recommendedGenders": [],
    "reasoning": "Brief explanation"
  },
  "suggestedRespondentCount": 250
}

Hard rules:
- q1 is the screener (methodology="screener", isScreening=true) qualifying respondents to the product's category. Generate it from the user message context. Type "single", 2-3 options, qualify the most relevant.
- q2..qN are MaxDiff sets. Generate exactly 12 sets. Each set has 4 features drawn from the supplied feature list. Each feature should appear in at least 3 sets and at most 5 sets across the 12 sets (rough balance — exact balance is checked by the validator).
  - type="max_diff_set"
  - methodology="max_diff"
  - feature_set carries the 4 feature ids in display order
  - text="Of these 4 features, which is MOST important to you, and which is LEAST important?"
  - options should list the 4 feature names verbatim (the simulator interprets the answer as {best: id, worst: id})
- After the 12 MaxDiff sets come the Kano pairs. Pick the TOP 5 features from the supplied list (or all features if N<=5). For each top feature, emit TWO questions back-to-back:
  - Functional (methodology="kano", kano_type="functional"): text="How would you feel if [feature name] WAS in the product?" type="single", options=["I like it","I expect it","Neutral","I can live with it","I dislike it"]
  - Dysfunctional (methodology="kano", kano_type="dysfunctional"): text="How would you feel if [feature name] WAS NOT in the product?" same 5 options.
  - feature_id carries the feature id on both pair members.
- Total question count: 1 screener + 12 MaxDiff + (2 × min(5, feature_count)) Kano = 23 when feature_count >= 5, else 13 + 2*N.
- DO NOT include funnel_stage, kpi_category, is_lift_question, channel_id, vw_band, gg_anchor_index, currency, category — those belong to other methodologies.
- suggestedRespondentCount default 250 (well above the 150 MaxDiff bound). Escalate to 400+ when the brief mentions sub-segment splits.

Output MUST be valid JSON. No prose, no markdown fences.`;

function validateRoadmapSurvey(parsed, featureCount) {
  if (!parsed || typeof parsed !== 'object') return 'response is not an object';
  const qs = Array.isArray(parsed.questions) ? parsed.questions : null;
  if (!qs) return 'questions array missing';
  if (qs.length < 13) return `expected at least 13 questions (1 screener + 12 MaxDiff sets), got ${qs.length}`;

  if (qs[0].methodology !== 'screener') return 'q1 must be screener';

  const maxDiffs = qs.filter((q) => q.methodology === 'max_diff');
  if (maxDiffs.length !== 12) return `expected 12 MaxDiff sets, got ${maxDiffs.length}`;
  for (const m of maxDiffs) {
    if (!Array.isArray(m.feature_set) || m.feature_set.length !== 4) {
      return 'each MaxDiff set must carry feature_set of 4 ids';
    }
  }
  // Each feature should appear in at least 3 of the 12 sets (rough balance).
  const counts = {};
  for (const m of maxDiffs) for (const fid of m.feature_set) counts[fid] = (counts[fid] || 0) + 1;
  const min = Math.min(...Object.values(counts));
  if (min < 2) return `MaxDiff balance: at least one feature appears in < 2 sets (got ${min})`;

  const kanoPairs = qs.filter((q) => q.methodology === 'kano');
  const expectedKano = 2 * Math.min(5, featureCount || 6);
  if (kanoPairs.length !== expectedKano) {
    return `expected ${expectedKano} Kano questions (${expectedKano / 2} features × 2), got ${kanoPairs.length}`;
  }
  return null;
}

function buildRoadmapUserPrompt({ description, clarify }) {
  const c = clarify || {};
  const featuresJson = c.roadmap_features || '[]';
  let features;
  try { features = JSON.parse(featuresJson); }
  catch { features = []; }
  const featureCount = Array.isArray(features) ? features.length : 0;

  const lines = [
    'Mission Goal: roadmap',
    `Brief: "${description}"`,
    '',
    'Feature list (use these exact ids in feature_set / feature_id):',
  ];
  for (const f of features) {
    lines.push(`- id=${f.id} name="${f.name}"${f.description ? ` desc="${f.description}"` : ''}`);
  }
  lines.push('');
  lines.push(`Total features: ${featureCount}.`);
  lines.push('First extract a SHORT product name (2-5 words) from the brief.');
  lines.push('Generate the screener (q1), 12 balanced MaxDiff sets, and Kano pairs for the top 5 features (or all if fewer than 5 features supplied).');
  return lines.join('\n');
}

async function generateRoadmapSurvey({ description, clarify }) {
  const userPrompt = buildRoadmapUserPrompt({ description, clarify });
  let features;
  try { features = JSON.parse(clarify?.roadmap_features || '[]'); }
  catch { features = []; }
  const featureCount = Array.isArray(features) ? features.length : 0;

  const firstResp = await callClaude({
    callType: 'survey_gen',
    systemPrompt: ROADMAP_SURVEY_GEN_SYSTEM,
    messages: [{ role: 'user', content: userPrompt }],
    maxTokens: 4500,
    enablePromptCache: true,
  });
  let parsed;
  try { parsed = extractJSON(firstResp.text); }
  catch (err) { parsed = null; logger.warn('roadmap survey: parse failed', { err: err.message }); }
  let validationErr = parsed ? validateRoadmapSurvey(parsed, featureCount) : 'response could not be parsed';
  if (!validationErr) return parsed;

  logger.info('roadmap survey: retry on validation failure', { reason: validationErr });
  const retryResp = await callClaude({
    callType: 'survey_gen',
    systemPrompt: ROADMAP_SURVEY_GEN_SYSTEM,
    messages: [{
      role: 'user',
      content: `${userPrompt}\n\nYour previous reply failed validation: ${validationErr}\nReturn the JSON again with that issue fixed. Keep all other rules.`,
    }],
    maxTokens: 4500,
    enablePromptCache: true,
  });
  try { parsed = extractJSON(retryResp.text); }
  catch (err) { parsed = null; logger.warn('roadmap survey: retry parse failed', { err: err.message }); }
  validationErr = parsed ? validateRoadmapSurvey(parsed, featureCount) : 'retry response could not be parsed';
  if (!validationErr) return parsed;

  logger.warn('roadmap survey: both attempts failed validation', {
    reason: validationErr,
    questionCount: Array.isArray(parsed?.questions) ? parsed.questions.length : 0,
  });
  return parsed || { questions: [], missionStatement: '', productName: '' };
}

// ── PASS 29 B8 — CUSTOMER SATISFACTION (NPS + CSAT + CES + ATTRIBUTES) ────
// 10-question battery covering recommendation (NPS), satisfaction (CSAT),
// effort (CES), attribute matrix, retention intent, and specific issues.
// Each scoring Q has a free-text driver follow-up so the results page can
// theme verbatims by reason.
const CSAT_SURVEY_GEN_SYSTEM = `You are a senior customer-research methodologist. You design NPS (Net Promoter Score), CSAT (Customer Satisfaction), and CES (Customer Effort Score) instruments. Always return ONLY valid JSON with no markdown fences.

JSON structure required:
{
  "productName": "Short brand/product name extracted from the brief (2-5 words)",
  "missionStatement": "One-sentence research objective starting with 'To measure customer satisfaction with...' or 'To quantify NPS for...'",
  "questions": [
    {
      "id": "q1",
      "text": "Question text",
      "type": "single|multi|rating|text",
      "options": ["Option A"],
      "isScreening": true,
      "qualifyingAnswer": "Option A",
      "qualifying_answers": ["Option A"],
      "screening_continue_on": ["Option A"],
      "methodology": "screener|nps|nps_driver|csat|csat_driver|ces|ces_driver|attribute_matrix|retention|specific_issues",
      "is_driver": true
    }
  ],
  "targetingSuggestions": {
    "recommendedCountries": ["US"],
    "recommendedAgeRanges": ["25-44"],
    "recommendedGenders": [],
    "reasoning": "Brief explanation"
  },
  "suggestedRespondentCount": 200
}

Hard rules:
- Generate EXACTLY 10 questions in this order:
  q1  screener (isScreening=true, methodology="screener") — qualifies the customer type from the user message ("Have you [used / interacted with support / purchased from] <brand> in the past <recency_window>?"). Type "single" with yes/no options; qualifying_answers=["Yes"].
  q2  NPS (methodology="nps", type="rating", options=[]) — "How likely are you to recommend <brand> to a friend or colleague?" 0-10 scale.
  q3  NPS driver (methodology="nps_driver", is_driver=true, type="text") — "What's the main reason for your score?"
  q4  CSAT (methodology="csat", type="single") — "How satisfied are you with <brand>'s <touchpoint>?" Options: ["Very dissatisfied","Dissatisfied","Neutral","Satisfied","Very satisfied"].
  q5  CSAT driver (methodology="csat_driver", is_driver=true, type="text") — "What could <brand> do to improve?"
  q6  CES (methodology="ces", type="rating") — "How easy was it to <touchpoint action>?" Use a 7-point scale (1=Very difficult, 7=Very easy).
  q7  CES driver (methodology="ces_driver", is_driver=true, type="text") — "What made it easy or hard?"
  q8  Attribute matrix (methodology="attribute_matrix", type="rating") — "Rate <brand> on each: Quality / Value / Reliability / Customer service / Ease of use." Single rating Q with options=[] (1-5 scale); the options list each attribute as a sub-row (the simulator will iterate). Set "options" to ["Quality","Value","Reliability","Customer service","Ease of use"].
  q9  Retention intent (methodology="retention", type="rating") — "How likely are you to continue using <brand> in the next 12 months?" 1-5 scale.
  q10 Specific issues (methodology="specific_issues", type="multi") — "Which of these have you experienced in the past <recency_window>?" Generate 5-7 category-relevant issue options based on the brief (e.g. for SaaS: "App crashed/froze", "Slow load times", "Difficult to find a feature", "Got incorrect data", "Couldn't reach support").
- Touchpoint mapping in question text:
    product     → "<brand>'s product"
    support     → "<brand>'s customer support"
    purchase    → "<brand>'s purchase / checkout flow"
    onboarding  → "<brand>'s onboarding experience"
    overall     → "<brand> overall"
    custom      → "<brand>'s <csat_custom_touchpoint>"
- "<touchpoint action>" in CES (q6) — derive a verb-form from touchpoint:
    product     → "use <brand>'s product"
    support     → "get help from <brand>"
    purchase    → "complete the <brand> purchase"
    onboarding  → "get started with <brand>"
    overall     → "interact with <brand>"
    custom      → "<csat_custom_touchpoint>"
- Recency window in q1: insert the user-supplied window verbatim (30 days, 90 days, 12 months, all time).
- DO NOT include funnel_stage, kpi_category, is_lift_question, channel_id, vw_band, gg_anchor_index, currency, feature_id, kano_type, feature_set, category — those belong to other methodologies.
- suggestedRespondentCount default 200 (well above the 100 NPS bound). Escalate to 400+ when the brief mentions sub-segment splits.

Output MUST be valid JSON. No prose, no markdown fences.`;

function validateCSATSurvey(parsed) {
  if (!parsed || typeof parsed !== 'object') return 'response is not an object';
  const qs = Array.isArray(parsed.questions) ? parsed.questions : null;
  if (!qs) return 'questions array missing';
  if (qs.length !== 10) return `expected 10 questions, got ${qs.length}`;

  const expected = [
    'screener', 'nps', 'nps_driver', 'csat', 'csat_driver',
    'ces', 'ces_driver', 'attribute_matrix', 'retention', 'specific_issues',
  ];
  for (let i = 0; i < expected.length; i++) {
    if (qs[i].methodology !== expected[i]) {
      return `q${i + 1} expected methodology "${expected[i]}", got "${qs[i].methodology}"`;
    }
  }
  if (qs[0].isScreening !== true) return 'q1 must be a screener (isScreening=true)';
  if (qs[1].type !== 'rating') return 'q2 (NPS) must be type=rating';
  if (qs[3].type !== 'single' || !Array.isArray(qs[3].options) || qs[3].options.length !== 5) {
    return 'q4 (CSAT) must be single with 5 options';
  }
  if (qs[5].type !== 'rating') return 'q6 (CES) must be type=rating';
  return null;
}

function buildCSATUserPrompt({ description, clarify }) {
  const c = clarify || {};
  const touchpoint = c.csat_touchpoint || 'overall';
  const customTp = c.csat_custom_touchpoint || '';
  const customerType = c.csat_customer_type || 'all';
  const recency = c.csat_recency_window || '90 days';
  const lines = [
    'Mission Goal: satisfaction',
    `Brief: "${description}"`,
    `Touchpoint: ${touchpoint}${touchpoint === 'custom' && customTp ? ` (${customTp})` : ''}`,
    `Customer type: ${customerType}`,
    `Recency window: ${recency}`,
    '',
    'First extract the SHORT brand/product name (2-5 words) from the brief.',
    'Then generate the 10-question NPS + CSAT + CES survey JSON.',
  ];
  return lines.join('\n');
}

async function generateCSATSurvey({ description, clarify }) {
  const userPrompt = buildCSATUserPrompt({ description, clarify });
  const firstResp = await callClaude({
    callType: 'survey_gen',
    systemPrompt: CSAT_SURVEY_GEN_SYSTEM,
    messages: [{ role: 'user', content: userPrompt }],
    maxTokens: 2500,
    enablePromptCache: true,
  });
  let parsed;
  try { parsed = extractJSON(firstResp.text); }
  catch (err) { parsed = null; logger.warn('csat survey: parse failed', { err: err.message }); }
  let validationErr = parsed ? validateCSATSurvey(parsed) : 'response could not be parsed';
  if (!validationErr) return parsed;

  logger.info('csat survey: retry on validation failure', { reason: validationErr });
  const retryResp = await callClaude({
    callType: 'survey_gen',
    systemPrompt: CSAT_SURVEY_GEN_SYSTEM,
    messages: [{
      role: 'user',
      content: `${userPrompt}\n\nYour previous reply failed validation: ${validationErr}\nReturn the JSON again with that issue fixed. Keep all other rules.`,
    }],
    maxTokens: 2500,
    enablePromptCache: true,
  });
  try { parsed = extractJSON(retryResp.text); }
  catch (err) { parsed = null; logger.warn('csat survey: retry parse failed', { err: err.message }); }
  validationErr = parsed ? validateCSATSurvey(parsed) : 'retry response could not be parsed';
  if (!validationErr) return parsed;

  logger.warn('csat survey: both attempts failed validation', {
    reason: validationErr,
    questionCount: Array.isArray(parsed?.questions) ? parsed.questions.length : 0,
  });
  return parsed || { questions: [], missionStatement: '', productName: '' };
}

// ── PASS 30 B1 — VALIDATE PRODUCT (CONCEPT TEST) ────────────────────────────
const VALIDATE_SURVEY_GEN_SYSTEM = `You are a senior concept-test methodologist. You design single-concept evaluation surveys following the standard appeal / relevance / uniqueness / believability / intent battery. Always return ONLY valid JSON with no markdown fences.

JSON structure required:
{
  "productName": "Short product/concept name extracted from the brief (2-5 words)",
  "missionStatement": "One-sentence research objective starting with 'To validate...' or 'To measure appeal of...'",
  "questions": [
    {
      "id": "q1",
      "text": "Question text",
      "type": "single|multi|rating|text",
      "options": ["Option A"],
      "isScreening": true,
      "qualifyingAnswer": "Option A",
      "qualifying_answers": ["Option A"],
      "screening_continue_on": ["Option A"],
      "methodology": "concept_test",
      "funnel_stage": "screener|reaction|relevance|uniqueness|believability|intent|qualitative|price_fairness"
    }
  ],
  "targetingSuggestions": {
    "recommendedCountries": ["US"],
    "recommendedAgeRanges": ["25-44"],
    "recommendedGenders": [],
    "reasoning": "Brief explanation"
  },
  "suggestedRespondentCount": 200
}

Hard rules:
- Generate 9 or 10 questions in this fixed order:
  q1 SCREENER (isScreening=true, methodology="concept_test", funnel_stage="screener") — qualifies category buyers from the brief context. type="single", 2-3 options, qualify the most relevant.
  q2 REACTION — "What is your overall reaction to this concept?" type="rating" 1-10, options=[]. funnel_stage="reaction".
  q3 RELEVANCE — "How relevant is this concept to your needs?" type="rating" 1-7. funnel_stage="relevance".
  q4 UNIQUENESS — "How different is this from other <category> options?" type="rating" 1-7. funnel_stage="uniqueness".
  q5 BELIEVABILITY — "How believable are the claims about this concept?" type="rating" 1-7. funnel_stage="believability".
  q6 PURCHASE INTENT — "If this were available[ at $<price> if a price was supplied], how likely would you be to buy?" type="single" 5 options ["Definitely would buy","Probably would buy","Might or might not","Probably would NOT buy","Definitely would NOT buy"]. funnel_stage="intent".
  q7 WORD ASSOCIATION — "What words come to mind when you think about this concept? Up to 5 words." type="text". funnel_stage="qualitative".
  q8 BIGGEST CONCERN — "What's your biggest concern or hesitation about this concept?" type="text". funnel_stage="qualitative".
  q9 WHO WOULD BUY — "Who do you think this concept is for?" type="text". funnel_stage="qualitative".
  q10 PRICE FAIR (ONLY include when a concept_price was supplied; omit otherwise) — "Is $<price> a fair price for what's offered?" type="single", options=["Too low","Fair","Too high"]. funnel_stage="price_fairness".
- "<category>" in q4 — pull from the universal-inputs category supplied in the user message (or infer from the brief if absent).
- DO NOT include vw_band, gg_anchor_index, currency, feature_id, kano_type, kpi_category, is_lift_question, channel_id — those belong to other methodologies.
- Q1 isScreening MUST be true. All other questions MUST have isScreening=false.
- suggestedRespondentCount default 200 (well above the 100 concept_test bound). Escalate to 400+ when the brief mentions sub-segment splits.

Output MUST be valid JSON. No prose, no markdown fences.`;

function validateValidateSurvey(parsed, hasPrice) {
  if (!parsed || typeof parsed !== 'object') return 'response is not an object';
  const qs = Array.isArray(parsed.questions) ? parsed.questions : null;
  if (!qs) return 'questions array missing';
  const expected = hasPrice ? 10 : 9;
  if (qs.length !== expected) return `expected ${expected} questions, got ${qs.length}`;
  const expectedStages = [
    'screener', 'reaction', 'relevance', 'uniqueness', 'believability',
    'intent', 'qualitative', 'qualitative', 'qualitative',
  ];
  if (hasPrice) expectedStages.push('price_fairness');
  for (let i = 0; i < expectedStages.length; i++) {
    if (qs[i].funnel_stage !== expectedStages[i]) {
      return `q${i + 1} expected funnel_stage="${expectedStages[i]}", got "${qs[i].funnel_stage}"`;
    }
  }
  if (qs[0].isScreening !== true) return 'q1 must be isScreening=true';
  if (qs[1].type !== 'rating') return 'q2 (reaction) must be type=rating';
  if (qs[5].type !== 'single' || !Array.isArray(qs[5].options) || qs[5].options.length !== 5) {
    return 'q6 (intent) must be single with 5 options';
  }
  return null;
}

function buildValidateUserPrompt({ description, clarify }) {
  const c = clarify || {};
  const conceptDesc = c.concept_description || description;
  const price = c.concept_price_usd;
  const occasion = c.concept_use_occasion || '';
  const lines = [
    'Mission Goal: validate',
    `Brief: "${description}"`,
    `Concept description: "${conceptDesc}"`,
  ];
  if (price) lines.push(`Concept price: $${price}`);
  if (occasion) lines.push(`Use occasion: "${occasion}"`);
  lines.push('');
  lines.push('Extract a SHORT concept name (2-5 words) from the brief.');
  lines.push(`Generate the ${price ? 10 : 9}-question concept-test survey.`);
  if (price) lines.push('Include q10 PRICE FAIR since a price was supplied.');
  return lines.join('\n');
}

async function generateValidateSurvey({ description, clarify }) {
  const userPrompt = buildValidateUserPrompt({ description, clarify });
  const hasPrice = !!(clarify && clarify.concept_price_usd);
  const firstResp = await callClaude({
    callType: 'survey_gen',
    systemPrompt: VALIDATE_SURVEY_GEN_SYSTEM,
    messages: [{ role: 'user', content: userPrompt }],
    maxTokens: 2500,
    enablePromptCache: true,
  });
  let parsed;
  try { parsed = extractJSON(firstResp.text); }
  catch (err) { parsed = null; logger.warn('validate survey: parse failed', { err: err.message }); }
  let validationErr = parsed ? validateValidateSurvey(parsed, hasPrice) : 'response could not be parsed';
  if (!validationErr) return parsed;

  logger.info('validate survey: retry on validation failure', { reason: validationErr });
  const retryResp = await callClaude({
    callType: 'survey_gen',
    systemPrompt: VALIDATE_SURVEY_GEN_SYSTEM,
    messages: [{
      role: 'user',
      content: `${userPrompt}\n\nYour previous reply failed validation: ${validationErr}\nReturn the JSON again with that issue fixed. Keep all other rules.`,
    }],
    maxTokens: 2500,
    enablePromptCache: true,
  });
  try { parsed = extractJSON(retryResp.text); }
  catch (err) { parsed = null; logger.warn('validate survey: retry parse failed', { err: err.message }); }
  validationErr = parsed ? validateValidateSurvey(parsed, hasPrice) : 'retry response could not be parsed';
  if (!validationErr) return parsed;

  logger.warn('validate survey: both attempts failed validation', {
    reason: validationErr,
    questionCount: Array.isArray(parsed?.questions) ? parsed.questions.length : 0,
  });
  return parsed || { questions: [], missionStatement: '', productName: '' };
}

// ── PASS 30 B3 — COMPARE CONCEPTS (SEQUENTIAL MONADIC + FORCED CHOICE) ─────
const COMPARE_SURVEY_GEN_SYSTEM = `You are a senior research methodologist designing sequential-monadic concept comparison surveys (Drive Research / SurveyMonkey 2026 published guidance). Always return ONLY valid JSON with no markdown fences.

JSON structure required:
{
  "productName": "Short brand/category name extracted from the brief",
  "missionStatement": "One-sentence research objective: 'To compare N concepts on appeal, relevance, and purchase intent...'",
  "questions": [
    {
      "id": "q1",
      "text": "Question text",
      "type": "single|multi|rating|text",
      "options": ["Option A"],
      "isScreening": true,
      "qualifyingAnswer": "Option A",
      "qualifying_answers": ["Option A"],
      "screening_continue_on": ["Option A"],
      "methodology": "sequential_monadic",
      "concept_id": "c1",
      "is_final_choice": false
    }
  ],
  "targetingSuggestions": { "recommendedCountries": ["US"], "recommendedAgeRanges": ["25-44"], "recommendedGenders": [], "reasoning": "..." },
  "suggestedRespondentCount": 240
}

Hard rules:
- q1 is the screener (methodology="sequential_monadic", isScreening=true) qualifying category buyers. Options 2-3, qualify the most relevant.
- For each concept (in input order, the simulator handles per-respondent rotation), emit 5 questions in this order with concept_id set to that concept's id:
  - APPEAL — "Considering [<concept name>]: [<concept description>]. How appealing is this concept?" type="rating" 1-10. funnel_stage="appeal".
  - RELEVANCE — "How relevant is this concept to your needs?" type="rating" 1-7. funnel_stage="relevance".
  - UNIQUENESS — "How different is this from other <category> options?" type="rating" 1-7. funnel_stage="uniqueness".
  - PURCHASE INTENT — "If [<concept name>] were available[ at $<price> if a price was supplied], how likely would you be to buy?" type="single", 5 options ["Definitely would buy","Probably would buy","Might or might not","Probably would NOT buy","Definitely would NOT buy"]. funnel_stage="intent".
  - BEST/WORST — "What's the best thing and the worst thing about this concept?" type="text". funnel_stage="qualitative".
- After ALL concepts, two final questions (concept_id=null, is_final_choice=true):
  - FORCED CHOICE — "Which concept did you find most appealing overall?" type="single", options=[ <each concept name> , "None of these"]. methodology stays "sequential_monadic".
  - WHY — "Why?" type="text".
- Total questions = 1 (screener) + 5N (per-concept) + 2 (final) = 5N + 3.
  - 2 concepts → 13 Qs.  3 concepts → 18 Qs.  4 concepts → 23 Qs.  5 concepts → 28 Qs.
- DO NOT include funnel_stage on the screener or final-choice/why; only on the per-concept rows. Do not include vw_band, gg_anchor_index, kano_type, feature_set — those belong to other methodologies.
- suggestedRespondentCount = 80 × N (per-concept floor) at minimum, 150 × N preferred.

Output MUST be valid JSON. No prose, no markdown fences.`;

function validateCompareSurvey(parsed, conceptCount) {
  if (!parsed || typeof parsed !== 'object') return 'response is not an object';
  const qs = Array.isArray(parsed.questions) ? parsed.questions : null;
  if (!qs) return 'questions array missing';
  const expected = 1 + 5 * conceptCount + 2;
  if (qs.length !== expected) return `expected ${expected} questions for ${conceptCount} concepts, got ${qs.length}`;
  if (qs[0].isScreening !== true) return 'q1 must be isScreening=true';
  // Per-concept block validation — each concept should have 5 Qs.
  for (let c = 0; c < conceptCount; c++) {
    const block = qs.slice(1 + c * 5, 1 + (c + 1) * 5);
    if (block.length !== 5) return `concept block ${c + 1} missing questions`;
    const cid = block[0].concept_id;
    if (!cid) return `concept block ${c + 1} missing concept_id`;
    for (const q of block) {
      if (q.concept_id !== cid) return `concept block ${c + 1}: concept_id inconsistent`;
    }
  }
  const final = qs[qs.length - 2];
  if (!final || final.is_final_choice !== true) return 'final-choice question missing or not flagged is_final_choice=true';
  return null;
}

function buildCompareUserPrompt({ description, clarify }) {
  const c = clarify || {};
  let concepts = [];
  try { concepts = JSON.parse(c.concepts || '[]'); } catch { concepts = []; }
  const lines = [
    'Mission Goal: compare',
    `Brief: "${description}"`,
    `Total concepts: ${concepts.length}`,
    '',
    'Concepts (use these exact ids in concept_id):',
  ];
  for (const x of concepts) {
    const priceStr = x.price_usd ? ` price=$${x.price_usd}` : '';
    lines.push(`- id=${x.id} name="${x.name}" description="${x.description}"${priceStr}`);
  }
  lines.push('');
  lines.push('Generate the screener (q1), 5 questions per concept (5N), then the forced-choice + why (2). Total = 5N+3 questions.');
  return lines.join('\n');
}

async function generateCompareSurvey({ description, clarify }) {
  const userPrompt = buildCompareUserPrompt({ description, clarify });
  let concepts = [];
  try { concepts = JSON.parse(clarify?.concepts || '[]'); } catch { concepts = []; }
  const conceptCount = concepts.length || 2;

  const firstResp = await callClaude({
    callType: 'survey_gen',
    systemPrompt: COMPARE_SURVEY_GEN_SYSTEM,
    messages: [{ role: 'user', content: userPrompt }],
    maxTokens: 5000,
    enablePromptCache: true,
  });
  let parsed;
  try { parsed = extractJSON(firstResp.text); }
  catch (err) { parsed = null; logger.warn('compare survey: parse failed', { err: err.message }); }
  let validationErr = parsed ? validateCompareSurvey(parsed, conceptCount) : 'response could not be parsed';
  if (!validationErr) return parsed;

  logger.info('compare survey: retry on validation failure', { reason: validationErr });
  const retryResp = await callClaude({
    callType: 'survey_gen',
    systemPrompt: COMPARE_SURVEY_GEN_SYSTEM,
    messages: [{
      role: 'user',
      content: `${userPrompt}\n\nYour previous reply failed validation: ${validationErr}\nReturn the JSON again with that issue fixed. Keep all other rules.`,
    }],
    maxTokens: 5000,
    enablePromptCache: true,
  });
  try { parsed = extractJSON(retryResp.text); }
  catch (err) { parsed = null; logger.warn('compare survey: retry parse failed', { err: err.message }); }
  validationErr = parsed ? validateCompareSurvey(parsed, conceptCount) : 'retry response could not be parsed';
  if (!validationErr) return parsed;

  logger.warn('compare survey: both attempts failed validation', {
    reason: validationErr,
    questionCount: Array.isArray(parsed?.questions) ? parsed.questions.length : 0,
  });
  return parsed || { questions: [], missionStatement: '', productName: '' };
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
