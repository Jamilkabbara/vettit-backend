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
  const brandName = (c.brand_name || '').trim();

  const lines = [
    `Mission Goal: brand_lift`,
    `Brief: "${description}"`,
    // Pass 34 B2 — focal brand name now passed in explicitly so the
    // generator substitutes it into the funnel questions instead of
    // falling back to "this concept" / "the brand".
    `Focal brand name: ${brandName || '<missing — refuse to generate>'}`,
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
  lines.push(
    `Use the focal brand name "${brandName}" verbatim everywhere a funnel question references the brand. NEVER use "this concept" or "the brand" placeholders.`,
  );
  lines.push('Generate the brand-lift survey JSON as specified.');
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
/**
 * Pass 42 G1 — BUG-013 fix. Extract the subject of a brief as a
 * short noun phrase (≤8 words) via a single Haiku call so we never
 * concatenate raw verbose brief text into question templates.
 *
 * Before: "Are you interested in I want to validate a new AI-powered
 *          market research tool..."
 * After:  "Are you interested in an AI market research tool?"
 *
 * Cost: ~$0.005 per mission. Eliminates the most embarrassing
 * customer-facing wording bug.
 *
 * Defensive: returns the original brief truncated if the Haiku
 * call fails — question generation should never crash on this.
 */
async function extractSubject(brief) {
  if (!brief || typeof brief !== 'string') return '';
  const text = brief.trim();
  if (text.length === 0) return '';
  // Skip the Haiku roundtrip for already-short briefs (likely
  // already a noun phrase).
  if (text.split(/\s+/).length <= 8) return text;
  try {
    const response = await callClaude({
      callType: 'subject_extract',
      missionId: null,
      userId:    null,
      model:     'claude-haiku-4-5',
      maxTokens: 40,
      systemPrompt: 'You extract the subject of research briefs as short noun phrases.',
      messages: [{
        role: 'user',
        content:
          `Extract the subject of this research brief as a short noun phrase (max 8 words). ` +
          `Strip first-person phrasing like "I want to validate" or "We're testing". ` +
          `Return ONLY the noun phrase, no quotes, no preamble.\n\n` +
          `Brief:\n${text}`,
      }],
      enablePromptCache: false,
    });
    const out = (response.text || '').trim().replace(/^["']|["']$/g, '');
    if (!out || out.length > 80) {
      // Fallback: truncate the original brief.
      return text.split(/\s+/).slice(0, 8).join(' ');
    }
    return out;
  } catch (err) {
    logger?.warn?.('extractSubject failed; falling back to truncation', { err: err.message });
    return text.split(/\s+/).slice(0, 8).join(' ');
  }
}

async function generateSurvey({
  goal,
  description,
  targetingHints = {},
  clarify = {},
  missionAssets = [],
}) {
  // Pass 45 T4 (BUG-013, dormant since Pass 42) — extract the subject
  // noun phrase ONCE and append it to the description every generator
  // interpolates (all 11 specialized paths + the generic path embed
  // `Brief: "${description}"`). The system prompts already instruct
  // "use the short productName, never paste the full brief" — this
  // hands the model the exact phrase, eliminating the
  // "Are you interested in I want to validate..." class of question.
  // extractSubject self-skips briefs ≤8 words and falls back to
  // truncation on API failure, so this never blocks generation.
  try {
    const subject = await extractSubject(description);
    if (subject && subject.trim() && subject.trim() !== (description || '').trim()) {
      description = `${description}

SUBJECT (extracted noun phrase — use THIS short phrase when wording questions; NEVER paste the brief text above into question text): "${subject.trim()}"`;
    }
  } catch (subjErr) {
    logger?.warn?.('generateSurvey: extractSubject failed (continuing with raw brief)', {
      err: subjErr.message,
    });
  }

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
  if (goal === 'marketing') {
    return generateMarketingSurvey({ description, clarify });
  }
  if (goal === 'competitor') {
    return generateCompetitorSurvey({ description, clarify });
  }
  if (goal === 'naming_messaging') {
    return generateNamingSurvey({ description, clarify });
  }
  if (goal === 'churn_research') {
    return generateChurnSurvey({ description, clarify });
  }
  if (goal === 'audience_profiling') {
    return generateAudienceProfilingSurvey({ description, clarify });
  }
  if (goal === 'market_entry') {
    return generateMarketEntrySurvey({ description, clarify });
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
  // Pass 34 B2 — refuse if focal brand_name is missing. Production
  // audit (DRAFT a912f5ab) had brand_name=null and the generator emitted
  // 5 questions all using "this concept" because Claude had no brand
  // to substitute. The setup form now requires brand_name; this is
  // the defense-in-depth check.
  const brand = (clarify?.brand_name || '').trim();
  if (!brand) {
    const err = new Error(
      'brand_lift: focal brand_name is required (received empty). ' +
      'Add a brand name in the Brand Lift setup section before generating.',
    );
    err.code = 'BRAND_LIFT_MISSING_BRAND_NAME';
    err.statusCode = 400;
    throw err;
  }

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
  const brandName = (c.brand_name || '').trim();
  const lines = [
    'Mission Goal: satisfaction',
    `Brief: "${description}"`,
    // Pass 35 B3 — focal brand name forwarded explicitly so the
    // generator substitutes it into NPS/CSAT/CES + driver questions
    // instead of guessing from the brief.
    `Focal brand name: ${brandName || '<missing — refuse to generate>'}`,
    `Touchpoint: ${touchpoint}${touchpoint === 'custom' && customTp ? ` (${customTp})` : ''}`,
    `Customer type: ${customerType}`,
    `Recency window: ${recency}`,
    '',
    `Use the focal brand name "${brandName}" verbatim everywhere a question references the brand. NEVER use a guessed alternative or "the brand" placeholder.`,
    'Generate the 10-question NPS + CSAT + CES survey JSON.',
  ];
  return lines.join('\n');
}

async function generateCSATSurvey({ description, clarify }) {
  // Pass 35 B3 — refuse if brand_name missing (mirrors brand_lift B2).
  const brand = (clarify?.brand_name || '').trim();
  if (!brand) {
    const err = new Error(
      'satisfaction (CSAT): focal brand_name is required (received empty). ' +
      'Add a brand name in the CSAT setup section before generating.',
    );
    err.code = 'CSAT_MISSING_BRAND_NAME';
    err.statusCode = 400;
    throw err;
  }

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

// ── PASS 30 B5 — TEST MARKETING / ADS (AD EFFECTIVENESS) ──────────────────
const MARKETING_SURVEY_GEN_SYSTEM = `You are a senior advertising-research methodologist designing ad effectiveness studies in the Kantar Link / ASI tradition. Always return ONLY valid JSON with no markdown fences.

JSON structure required:
{
  "productName": "Short brand name extracted from the brief",
  "missionStatement": "One-sentence research objective",
  "questions": [
    {
      "id": "q1",
      "text": "...",
      "type": "single|multi|rating|text",
      "options": ["..."],
      "isScreening": true,
      "qualifyingAnswer": "...",
      "qualifying_answers": ["..."],
      "screening_continue_on": ["..."],
      "methodology": "ad_effectiveness",
      "funnel_stage": "screener|recall|exposure|attribution|message|likeability|stopping|distinctiveness|emotional|persuasion|message_match|sharing"
    }
  ],
  "targetingSuggestions": { "recommendedCountries": ["US"], "recommendedAgeRanges": ["25-44"], "recommendedGenders": [], "reasoning": "..." },
  "suggestedRespondentCount": 200
}

Hard rules — generate 12 or 13 questions in this fixed order:
  q1 SCREENER (isScreening=true, methodology="ad_effectiveness", funnel_stage="screener") — qualifies category buyers from the brief context. type="single", 2-3 options, qualify the most relevant.
  q2 UNAIDED RECALL (funnel_stage="recall") — "What ads have you seen recently for <category>?" type="text".
  q3 EXPOSURE — text="[<creative_url>] Please review the ad above before answering the next questions." type="text" with options=[]. Use funnel_stage="exposure". This is a soft acknowledgement step; the simulator will substitute the creative URL in the prompt.
  q4 AIDED RECALL (funnel_stage="recall") — "Have you seen this ad before?" type="single", options=["Yes","No","Not sure"].
  q5 BRAND ATTRIBUTION (funnel_stage="attribution") — "Whose ad is this?" type="text".
  q6 MAIN MESSAGE (funnel_stage="message") — "What's the main message of this ad?" type="text".
  q7 LIKEABILITY (funnel_stage="likeability") — "How much did you like this ad?" type="rating" 1-7.
  q8 STOPPING POWER (funnel_stage="stopping") — "On <campaign_channel>, would this ad get your attention?" type="rating" 1-7.
  q9 DISTINCTIVENESS (funnel_stage="distinctiveness") — "How different is this from other <category> ads?" type="rating" 1-7.
  q10 EMOTIONAL RESPONSE (funnel_stage="emotional") — "How does this ad make you feel?" type="multi", options=["Amused","Inspired","Curious","Surprised","Happy","Nostalgic","Annoyed","Bored","Confused","Skeptical","Indifferent","Other"].
  q11 PERSUASION (funnel_stage="persuasion") — "After seeing this, are you more or less likely to <campaign_objective>?" type="rating" 1-7 (1=Much less likely, 7=Much more likely).
  q12 MESSAGE MATCH (funnel_stage="message_match", ONLY include when intended_message was supplied — otherwise OMIT) — "Did the ad communicate <intended_message>?" type="single", options=["Yes","Somewhat","No"].
  q13 SHARING (funnel_stage="sharing") — "Would you share or recommend this ad to a friend?" type="single", options=["Yes","Maybe","No"].
- "<category>" / "<campaign_channel>" / "<campaign_objective>" / "<intended_message>" / "<creative_url>" — pull from the user message context. If a value is missing, use a sensible neutral phrasing.
- DO NOT include vw_band, gg_anchor_index, kano_type, feature_set, concept_id, kpi_category, is_lift_question, channel_id — those belong to other methodologies.
- suggestedRespondentCount default 200 (well above the 100 ad_effectiveness bound). Escalate to 400+ when the brief mentions sub-segment splits.

Output MUST be valid JSON. No prose, no markdown fences.`;

function validateMarketingSurvey(parsed, hasMessage) {
  if (!parsed || typeof parsed !== 'object') return 'response is not an object';
  const qs = Array.isArray(parsed.questions) ? parsed.questions : null;
  if (!qs) return 'questions array missing';
  const expected = hasMessage ? 13 : 12;
  if (qs.length !== expected) return `expected ${expected} questions, got ${qs.length}`;
  if (qs[0].isScreening !== true) return 'q1 must be isScreening=true';
  const expectedStages = [
    'screener', 'recall', 'exposure', 'recall', 'attribution', 'message',
    'likeability', 'stopping', 'distinctiveness', 'emotional', 'persuasion',
  ];
  if (hasMessage) expectedStages.push('message_match');
  expectedStages.push('sharing');
  for (let i = 0; i < expectedStages.length; i++) {
    if (qs[i].funnel_stage !== expectedStages[i]) {
      return `q${i + 1} expected funnel_stage="${expectedStages[i]}", got "${qs[i].funnel_stage}"`;
    }
  }
  return null;
}

function buildMarketingUserPrompt({ description, clarify }) {
  const c = clarify || {};
  const lines = [
    'Mission Goal: marketing',
    `Brief: "${description}"`,
    `Creative URL: ${c.creative_media_url || '<not provided>'}`,
    `Creative type: ${c.creative_media_type || 'image'}`,
    `Campaign channel: ${c.campaign_channel || 'social'}`,
    `Campaign format: ${c.campaign_format || 'static_image'}`,
    `Campaign objective: ${c.campaign_objective || 'awareness'}`,
  ];
  if (c.intended_message) lines.push(`Intended message: "${c.intended_message}"`);
  if (c.category) lines.push(`Category: ${c.category}`);
  if (c.brand_name) lines.push(`Brand: ${c.brand_name}`);
  lines.push('');
  lines.push('Generate the screener (q1) + 11 ad-effectiveness questions, plus q12 message-match if intended_message was supplied, plus q13 sharing.');
  return lines.join('\n');
}

async function generateMarketingSurvey({ description, clarify }) {
  const userPrompt = buildMarketingUserPrompt({ description, clarify });
  const hasMessage = !!(clarify && clarify.intended_message && clarify.intended_message.trim());

  const firstResp = await callClaude({
    callType: 'survey_gen',
    systemPrompt: MARKETING_SURVEY_GEN_SYSTEM,
    messages: [{ role: 'user', content: userPrompt }],
    maxTokens: 3000,
    enablePromptCache: true,
  });
  let parsed;
  try { parsed = extractJSON(firstResp.text); }
  catch (err) { parsed = null; logger.warn('marketing survey: parse failed', { err: err.message }); }
  let validationErr = parsed ? validateMarketingSurvey(parsed, hasMessage) : 'response could not be parsed';
  if (!validationErr) return parsed;

  logger.info('marketing survey: retry on validation failure', { reason: validationErr });
  const retryResp = await callClaude({
    callType: 'survey_gen',
    systemPrompt: MARKETING_SURVEY_GEN_SYSTEM,
    messages: [{
      role: 'user',
      content: `${userPrompt}\n\nYour previous reply failed validation: ${validationErr}\nReturn the JSON again with that issue fixed. Keep all other rules.`,
    }],
    maxTokens: 3000,
    enablePromptCache: true,
  });
  try { parsed = extractJSON(retryResp.text); }
  catch (err) { parsed = null; logger.warn('marketing survey: retry parse failed', { err: err.message }); }
  validationErr = parsed ? validateMarketingSurvey(parsed, hasMessage) : 'retry response could not be parsed';
  if (!validationErr) return parsed;

  logger.warn('marketing survey: both attempts failed validation', {
    reason: validationErr,
    questionCount: Array.isArray(parsed?.questions) ? parsed.questions.length : 0,
  });
  return parsed || { questions: [], missionStatement: '', productName: '' };
}

// ── PASS 31 B1 / PASS 47 — COMPETITOR ANALYSIS (BRAND HEALTH TRACKER) ──────
// 5-stage funnel (Awareness → Consideration → Preference → Use →
// Recommendation) per published 2026 industry guidance from YouGov
// BrandIndex / Hanover / Kantar.
//
// PASS 47 — the radar (perceptual map) requires every brand scored on the
// SAME attribute battery. The old prompt emitted ONE attribute question for
// the focal brand only (brand_id="our_brand"), so competitor.js found no
// shared axes and rendered no radar. The fixed prompt emits an attribute
// battery PER BRAND (focal + each named competitor) — identical options,
// brand_id set per brand, funnel_stage="attributes". The question count is
// therefore 10 fixed + (1 + numCompetitors) attribute questions, not a hard
// 11. The focal brand is ALWAYS identified by brand_id="our_brand" and its
// label is the FOCAL_BRAND_LABEL the user prompt enumerates (a real name
// when supplied, else "Our Brand"), so the parser anchors the focal brand
// even when mission.brand_name is empty/generic.
const COMPETITOR_SURVEY_GEN_SYSTEM = `You are a senior brand-research methodologist designing Brand Health Tracker studies (YouGov BrandIndex / Hanover / Kantar tradition). Always return ONLY valid JSON with no markdown fences.

JSON structure required:
{
  "productName": "Short focal brand name (2-5 words)",
  "missionStatement": "One-sentence research objective on brand health vs competitors",
  "questions": [
    {
      "id": "q1",
      "text": "...",
      "type": "single|multi|rating|text",
      "options": ["..."],
      "isScreening": true,
      "qualifyingAnswer": "...",
      "qualifying_answers": ["..."],
      "screening_continue_on": ["..."],
      "methodology": "brand_health_tracker",
      "funnel_stage": "screener|awareness|consideration|preference|use|recommendation|attributes|switching|wom",
      "brand_id": null
    }
  ],
  "targetingSuggestions": { "recommendedCountries": ["US"], "recommendedAgeRanges": ["25-44"], "recommendedGenders": [], "reasoning": "..." },
  "suggestedRespondentCount": 400
}

BRAND IDENTITY — the user prompt enumerates a "Brand list" = [FOCAL_BRAND_LABEL, ...competitor labels]. The FIRST entry is the focal brand; its brand_id is ALWAYS the literal "our_brand". Each competitor's brand_id is its EXACT label string (verbatim, e.g. "Careem"). Use FOCAL_BRAND_LABEL verbatim wherever <focal_brand> appears below — never substitute a generic placeholder.

Hard rules — generate the funnel in THIS order. There are 10 FIXED questions plus ONE attribute-battery question PER BRAND (focal + every competitor):
  q1 SCREENER (isScreening=true, methodology="brand_health_tracker", funnel_stage="screener", brand_id=null) — qualifies category buyers from the brief context. type="single", 2-3 options, qualify the most relevant.
  q2 UNAIDED AWARENESS (funnel_stage="awareness", brand_id=null) — "What <category> brands come to mind? List up to 5." type="text", options=[].
  q3 AIDED AWARENESS (funnel_stage="awareness", brand_id=null) — "Which of these brands have you heard of? Select all." type="multi", options = the full Brand list [FOCAL_BRAND_LABEL, ...competitors] in supplied order.
  q4 CONSIDERATION (funnel_stage="consideration", brand_id=null) — "Of the brands you've heard of, which would you consider buying next time you need a <category>?" type="multi", options = same as q3.
  q5 PREFERENCE (funnel_stage="preference", brand_id=null) — "Of the brands you'd consider, if you had to choose ONE, which would you pick?" type="single", options = same as q3.
  q6 CURRENT USE (funnel_stage="use", brand_id=null) — "Which of these brands do you use most often?" type="single", options = same as q3 + "None of these".
  q7 NPS — FOCAL (funnel_stage="recommendation", brand_id="our_brand") — "How likely are you to recommend [FOCAL_BRAND_LABEL] to a friend or colleague?" type="rating" 0-10.
  ATTRIBUTE BATTERIES — emit ONE question per brand in the Brand list, focal FIRST then each competitor in order, all with funnel_stage="attributes", type="multi", and IDENTICAL options = the supplied attribute battery (default 10 standard or user-specified). Each question's text = "Which of these attributes apply to <that brand's label>? Select all that apply." and brand_id = that brand's id ("our_brand" for focal; the exact competitor label otherwise). The options MUST be byte-for-byte identical across every battery so the brands share radar axes.
  SWITCHING INTENT (funnel_stage="switching", brand_id=null) — "How likely are you to switch from your current <category> brand to a different one in the next 6 months?" type="rating" 1-5.
  SWITCHING TARGET (funnel_stage="switching", brand_id=null) — "If you were to switch, which brand would you most likely switch to?" type="single", options = competitor labels (exclude the focal brand).
  WORD-OF-MOUTH (funnel_stage="wom", brand_id="our_brand") — "In the past 2 weeks, have you talked about [FOCAL_BRAND_LABEL] with friends, family, or colleagues?" type="single", options=["Yes - positively","Yes - negatively","No, but I've thought about them","No, not at all"].
- Give every question a unique sequential id (q1, q2, …). Funnel order: screener, awareness×2, consideration, preference, use, recommendation, the attribute batteries (focal first), switching×2, wom.
- DO NOT include vw_band, gg_anchor_index, kano_type, feature_set, concept_id — those belong to other methodologies.
- suggestedRespondentCount default 400 (well above the 200 brand_health_tracker bound). Per-brand cells get small below 200.

Output MUST be valid JSON. No prose, no markdown fences.`;

function validateCompetitorSurvey(parsed) {
  if (!parsed || typeof parsed !== 'object') return 'response is not an object';
  const qs = Array.isArray(parsed.questions) ? parsed.questions : null;
  if (!qs) return 'questions array missing';
  // PASS 47: count is no longer fixed at 11 — there is one attribute battery
  // per brand (focal + each competitor). Validate by funnel_stage presence
  // instead. Minimum: 10 fixed + 1 focal battery = 11.
  if (qs.length < 11) return `expected ≥11 questions (10 fixed + ≥1 attribute battery), got ${qs.length}`;
  if (qs[0].isScreening !== true) return 'q1 must be isScreening=true';
  if (qs[0].funnel_stage !== 'screener') return `q1 expected funnel_stage="screener", got "${qs[0].funnel_stage}"`;

  const byStage = (stage) => qs.filter((q) => q && q.funnel_stage === stage);
  const need = {
    awareness: 2, // unaided (text) + aided (multi)
    consideration: 1,
    preference: 1,
    use: 1,
    recommendation: 1,
    switching: 2, // intent (rating) + target (single)
    wom: 1,
  };
  for (const [stage, min] of Object.entries(need)) {
    const got = byStage(stage).length;
    if (got < min) return `expected ≥${min} funnel_stage="${stage}" question(s), got ${got}`;
  }

  // Attribute batteries: ≥1, focal carries brand_id="our_brand", and every
  // battery shares the SAME options so the radar has shared axes.
  const attributeQs = byStage('attributes');
  if (attributeQs.length < 1) return 'expected ≥1 funnel_stage="attributes" question';
  if (!attributeQs.some((q) => String(q.brand_id || '').toLowerCase() === 'our_brand')) {
    return 'focal attribute battery (brand_id="our_brand") missing';
  }
  const optsKey = (q) => JSON.stringify(Array.isArray(q.options) ? q.options : null);
  const firstOpts = optsKey(attributeQs[0]);
  if (firstOpts === 'null') return 'attribute batteries must carry an options array';
  if (!attributeQs.every((q) => optsKey(q) === firstOpts)) {
    return 'all attribute batteries must share IDENTICAL options (shared radar axes)';
  }

  // NPS must be a rating.
  if (!byStage('recommendation').some((q) => q.type === 'rating')) {
    return 'recommendation (NPS) question must be type=rating';
  }
  return null;
}

function buildCompetitorUserPrompt({ description, clarify }) {
  const c = clarify || {};
  // competitor_brands may arrive as a JSONB array, a JSON-string, or a
  // pipe/comma legacy string. Normalise to a clean label array.
  let competitors = [];
  if (Array.isArray(c.competitor_brands)) {
    competitors = c.competitor_brands;
  } else if (typeof c.competitor_brands === 'string' && c.competitor_brands.trim()) {
    try {
      const p = JSON.parse(c.competitor_brands);
      competitors = Array.isArray(p) ? p : [];
    } catch { competitors = c.competitor_brands.split(/[|,]/); }
  }
  if (!competitors.length && typeof c.competitors === 'string' && c.competitors) {
    competitors = c.competitors.split('|');
  }
  competitors = competitors
    .map((x) => (typeof x === 'string' ? x : String((x && (x.name || x.label || x.brand)) || '')))
    .map((s) => s.trim())
    .filter(Boolean);

  let attrs = [];
  if (Array.isArray(c.attribute_battery)) {
    attrs = c.attribute_battery;
  } else if (typeof c.attribute_battery === 'string' && c.attribute_battery.trim()) {
    try {
      const p = JSON.parse(c.attribute_battery);
      attrs = Array.isArray(p) ? p : [];
    } catch { attrs = c.attribute_battery.split(','); }
  }
  attrs = attrs.map((s) => String(s).trim()).filter(Boolean);

  // PASS 47: stable focal label even when brand_name is empty/generic so the
  // model has FOCAL_BRAND_LABEL to use verbatim and the parser can anchor it.
  // §2.3 — never emit the "Our Brand" placeholder; derive a real name from the
  // brief when brand_name is unset, else a neutral label.
  const { deriveFocalBrand } = require('../utils/focalBrand');
  const focalLabel = deriveFocalBrand(c.brand_name, description);
  const brandList = [focalLabel, ...competitors];

  const lines = [
    'Mission Goal: competitor',
    `Brief: "${description}"`,
    `Focal brand (FOCAL_BRAND_LABEL, brand_id="our_brand"): ${focalLabel}`,
    `Category: ${c.category || '<unknown>'}`,
    `Competitors (${competitors.length}): ${competitors.join(', ')}`,
    `Brand list [focal first] (${brandList.length}): ${brandList.join(', ')}`,
    `Attribute battery (${attrs.length}): ${attrs.join(', ')}`,
    '',
    'Generate the Brand Health Tracker survey JSON: 10 fixed funnel questions'
      + ` plus ONE attribute battery per brand (${brandList.length} batteries, focal first),`
      + ' every battery sharing IDENTICAL options.',
  ];
  return lines.join('\n');
}

async function generateCompetitorSurvey({ description, clarify }) {
  const userPrompt = buildCompetitorUserPrompt({ description, clarify });
  const firstResp = await callClaude({
    callType: 'survey_gen',
    systemPrompt: COMPETITOR_SURVEY_GEN_SYSTEM,
    messages: [{ role: 'user', content: userPrompt }],
    maxTokens: 3000,
    enablePromptCache: true,
  });
  let parsed;
  try { parsed = extractJSON(firstResp.text); }
  catch (err) { parsed = null; logger.warn('competitor survey: parse failed', { err: err.message }); }
  let validationErr = parsed ? validateCompetitorSurvey(parsed) : 'response could not be parsed';
  if (!validationErr) return parsed;

  logger.info('competitor survey: retry on validation failure', { reason: validationErr });
  const retryResp = await callClaude({
    callType: 'survey_gen',
    systemPrompt: COMPETITOR_SURVEY_GEN_SYSTEM,
    messages: [{
      role: 'user',
      content: `${userPrompt}\n\nYour previous reply failed validation: ${validationErr}\nReturn the JSON again with that issue fixed. Keep all other rules.`,
    }],
    maxTokens: 3000,
    enablePromptCache: true,
  });
  try { parsed = extractJSON(retryResp.text); }
  catch (err) { parsed = null; logger.warn('competitor survey: retry parse failed', { err: err.message }); }
  validationErr = parsed ? validateCompetitorSurvey(parsed) : 'retry response could not be parsed';
  if (!validationErr) return parsed;

  logger.warn('competitor survey: both attempts failed validation', {
    reason: validationErr,
    questionCount: Array.isArray(parsed?.questions) ? parsed.questions.length : 0,
  });
  return parsed || { questions: [], missionStatement: '', productName: '' };
}

// ── PASS 31 B3 — NAMING & MESSAGING (MONADIC + PAIRED + TURF) ──────────────
const NAMING_SURVEY_GEN_SYSTEM = `You are a senior naming-research methodologist designing monadic-evaluation + paired-comparison + (for taglines) TURF surveys. Always return ONLY valid JSON with no markdown fences.

JSON structure required:
{
  "productName": "Short brand/category name",
  "missionStatement": "One-sentence research objective",
  "questions": [
    {
      "id": "q1",
      "text": "...",
      "type": "single|multi|rating|text",
      "options": ["..."],
      "isScreening": true,
      "qualifyingAnswer": "...",
      "qualifying_answers": ["..."],
      "screening_continue_on": ["..."],
      "methodology": "monadic|paired_comparison|turf|monadic_plus_paired",
      "candidate_id": "n1",
      "criterion": "memorable",
      "is_paired_comparison": false,
      "is_turf": false
    }
  ],
  "targetingSuggestions": { "recommendedCountries": ["US"], "recommendedAgeRanges": ["25-44"], "recommendedGenders": [], "reasoning": "..." },
  "suggestedRespondentCount": 240
}

Hard rules (per-candidate count = N supplied; criteria count = M supplied):
- q1 SCREENER (methodology="monadic_plus_paired", isScreening=true) — qualifies category buyers from the brief context. type="single", 2-3 options.
- For each candidate (use the supplied id and text verbatim) emit (M+1) questions in this order:
  - For each criterion in the supplied criteria list: rating 1-7 type="rating", options=[]. text="On a 1-7 scale, how <criterion-label> is [<candidate text>]?" The criterion field carries the slug.
  - WORD ASSOCIATION (criterion="word_association"): type="text", text="What does [<candidate text>] make you think of? Up to 5 words."
  - All these per-candidate Qs share methodology="monadic" and candidate_id=<id>.
- After all candidates:
  - FORCED CHOICE (methodology="monadic_plus_paired"): "Which candidate did you find most appealing overall?" type="single", options=[<each candidate text>]. is_paired_comparison=false. candidate_id=null.
  - WHY (methodology="monadic_plus_paired"): "Why?" type="text". candidate_id=null.
  - PAIRED COMPARISONS: emit ceil(N/2) paired Qs (between 1 and 4). For each, methodology="paired_comparison", text="Which would you choose: [<candidate A text>] OR [<candidate B text>]?" type="single", options=[<A text>, <B text>]. is_paired_comparison=true. candidate_id=null.
- If test_type includes 'taglines' (test_type === 'taglines' OR test_type === 'both'): emit one final TURF question. methodology="turf", type="multi", text="Which of these taglines do you find compelling? Select all that apply.", options=[<each candidate text>]. is_turf=true. candidate_id=null.
- Total Q count: 1 + N*(M+1) + 2 + ceil(N/2) + (test_type==='names'?0:1).
- NEVER emit placeholder candidate names like "Name A", "Name B",
  "Tagline 1", or "Candidate X". If the supplied list is empty or
  has fewer than 2 entries, return {"error":"missing_candidates"}
  instead of a survey. Real candidate text only.
- Criterion slug → label mapping:
    memorable → "memorable"
    distinctive → "distinctive"
    relevant → "relevant to the category"
    positive → "positive in feeling"
    easy_to_pronounce → "easy to pronounce"
    modern → "modern"
- DO NOT include vw_band, gg_anchor_index, kano_type, feature_set, brand_id, funnel_stage — those belong to other methodologies.
- suggestedRespondentCount: 80 × N min, 150 × N best.

Output MUST be valid JSON. No prose, no markdown fences.`;

function validateNamingSurvey(parsed, candidateCount, criteriaCount, testType) {
  if (!parsed || typeof parsed !== 'object') return 'response is not an object';
  const qs = Array.isArray(parsed.questions) ? parsed.questions : null;
  if (!qs) return 'questions array missing';
  // Per spec: 1 screener + N*(M+1) + 2 + ceil(N/2) + (taglines? 1 : 0)
  const includesTaglines = testType === 'taglines' || testType === 'both';
  const expected = 1 + candidateCount * (criteriaCount + 1) + 2 + Math.ceil(candidateCount / 2) + (includesTaglines ? 1 : 0);
  if (qs.length !== expected) return `expected ${expected} questions for ${candidateCount} candidates × ${criteriaCount} criteria${includesTaglines ? ' + TURF' : ''}, got ${qs.length}`;
  if (qs[0].isScreening !== true) return 'q1 must be isScreening=true';
  const monadicCount = qs.filter((q) => q.methodology === 'monadic').length;
  if (monadicCount !== candidateCount * (criteriaCount + 1)) {
    return `expected ${candidateCount * (criteriaCount + 1)} monadic Qs, got ${monadicCount}`;
  }
  const pairedCount = qs.filter((q) => q.methodology === 'paired_comparison').length;
  const expectedPaired = Math.ceil(candidateCount / 2);
  if (pairedCount !== expectedPaired) return `expected ${expectedPaired} paired comparisons, got ${pairedCount}`;
  if (includesTaglines) {
    const turfCount = qs.filter((q) => q.methodology === 'turf').length;
    if (turfCount !== 1) return `expected 1 TURF Q, got ${turfCount}`;
  }
  return null;
}

function buildNamingUserPrompt({ description, clarify }) {
  const c = clarify || {};
  let candidates = [];
  try { candidates = JSON.parse(c.naming_candidates || '[]'); } catch { /* ignore */ }
  let criteria = [];
  try { criteria = JSON.parse(c.naming_criteria || '[]'); } catch { /* ignore */ }
  if (!criteria.length && typeof c.naming_criteria === 'string') {
    criteria = c.naming_criteria.split(',').filter(Boolean);
  }
  const testType = c.naming_test_type || 'names';
  const lines = [
    'Mission Goal: naming_messaging',
    `Brief: "${description}"`,
    `Test type: ${testType}`,
    `Brand personality: "${c.brand_personality || ''}"`,
    `Candidates (${candidates.length}):`,
  ];
  for (const x of candidates) {
    lines.push(`- id=${x.id} text="${x.text || x.name}"${x.description ? ` desc="${x.description}"` : ''}`);
  }
  lines.push(`Criteria (${criteria.length}): ${criteria.join(', ')}`);
  lines.push('');
  lines.push('Generate the naming survey JSON per the system rules.');
  return lines.join('\n');
}

async function generateNamingSurvey({ description, clarify }) {
  let candidates = [];
  try { candidates = JSON.parse(clarify?.naming_candidates || '[]'); } catch { /* ignore */ }
  let criteria = [];
  try { criteria = JSON.parse(clarify?.naming_criteria || '[]'); } catch { /* ignore */ }
  if (!criteria.length && typeof clarify?.naming_criteria === 'string') {
    criteria = clarify.naming_criteria.split(',').filter(Boolean);
  }

  // Pass 34 B1 — refuse empty candidate list. Production audit found
  // DRAFT fd10f13d had naming_candidates=[] and the generator emitted
  // placeholder "Name A / Name B / Name C" because Claude had nothing
  // to substitute. Better to fail loudly here so the setup form
  // surfaces the missing input rather than ship a broken survey.
  const validCandidates = candidates.filter(
    (c) => c && typeof (c.text || c.name) === 'string' && (c.text || c.name).trim(),
  );
  if (validCandidates.length < 2) {
    const err = new Error(
      'naming_messaging: at least 2 named candidates required (received ' +
      `${validCandidates.length}). Add candidate names in setup before generating.`,
    );
    err.code = 'NAMING_MISSING_CANDIDATES';
    err.statusCode = 400;
    throw err;
  }
  if (criteria.length < 1) {
    const err = new Error(
      'naming_messaging: at least 1 evaluation criterion required.',
    );
    err.code = 'NAMING_MISSING_CRITERIA';
    err.statusCode = 400;
    throw err;
  }

  const userPrompt = buildNamingUserPrompt({ description, clarify });
  const candidateCount = validCandidates.length;
  const criteriaCount = criteria.length;
  const testType = clarify?.naming_test_type || 'names';

  const firstResp = await callClaude({
    callType: 'survey_gen',
    systemPrompt: NAMING_SURVEY_GEN_SYSTEM,
    messages: [{ role: 'user', content: userPrompt }],
    maxTokens: 6000,
    enablePromptCache: true,
  });
  let parsed;
  try { parsed = extractJSON(firstResp.text); }
  catch (err) { parsed = null; logger.warn('naming survey: parse failed', { err: err.message }); }
  let validationErr = parsed ? validateNamingSurvey(parsed, candidateCount, criteriaCount, testType) : 'response could not be parsed';
  if (!validationErr) return parsed;

  logger.info('naming survey: retry on validation failure', { reason: validationErr });
  const retryResp = await callClaude({
    callType: 'survey_gen',
    systemPrompt: NAMING_SURVEY_GEN_SYSTEM,
    messages: [{
      role: 'user',
      content: `${userPrompt}\n\nYour previous reply failed validation: ${validationErr}\nReturn the JSON again with that issue fixed. Keep all other rules.`,
    }],
    maxTokens: 6000,
    enablePromptCache: true,
  });
  try { parsed = extractJSON(retryResp.text); }
  catch (err) { parsed = null; logger.warn('naming survey: retry parse failed', { err: err.message }); }
  validationErr = parsed ? validateNamingSurvey(parsed, candidateCount, criteriaCount, testType) : 'retry response could not be parsed';
  if (!validationErr) return parsed;

  logger.warn('naming survey: both attempts failed validation', {
    reason: validationErr,
    questionCount: Array.isArray(parsed?.questions) ? parsed.questions.length : 0,
  });
  return parsed || { questions: [], missionStatement: '', productName: '' };
}

// ── PASS 31 B5 — CHURN RESEARCH (DRIVER TREE + WIN-BACK) ───────────────────
const CHURN_SURVEY_GEN_SYSTEM = `You are a senior customer-research methodologist designing churn driver tree + win-back potential studies. Always return ONLY valid JSON with no markdown fences.

JSON structure required:
{
  "productName": "Short brand name",
  "missionStatement": "One-sentence research objective on churn drivers and win-back potential",
  "questions": [
    {
      "id": "q1",
      "text": "...",
      "type": "single|multi|rating|text",
      "options": ["..."],
      "isScreening": true,
      "qualifyingAnswer": "...",
      "qualifying_answers": ["..."],
      "screening_continue_on": ["..."],
      "methodology": "churn_driver",
      "churn_stage": "screener|reason|satisfaction|win_back|switch|warning|tenure"
    }
  ],
  "targetingSuggestions": { "recommendedCountries": ["US"], "recommendedAgeRanges": ["25-44"], "recommendedGenders": [], "reasoning": "..." },
  "suggestedRespondentCount": 200
}

Hard rules — generate EXACTLY 11 questions in this order:
  q1 SCREENER (isScreening=true, methodology="churn_driver", churn_stage="screener") — qualifies that the respondent matches the supplied churn definition for [<brand_name>] (e.g. "Have you cancelled <brand> in the past 30 days?"). type="single" with yes/no. qualifying_answers=["Yes"].
  q2 CHURN REASON CATEGORY (churn_stage="reason") — type="multi", text="What was the reason you stopped using <brand>? Select all that apply." options=["Price","Product fit","Customer service","Competition","Life change","Quality","Features","Trust","Other"].
  q3 CHURN REASON DETAIL (churn_stage="reason") — type="text", text="Tell us more about the main reason in your own words."
  q4 SATISFACTION AT CHURN (churn_stage="satisfaction") — type="single" 5-pt, options=["Very dissatisfied","Dissatisfied","Neutral","Satisfied","Very satisfied"].
  q5 NPS AT CHURN (churn_stage="satisfaction") — type="rating" 0-10. text="At the time you stopped, how likely were you to recommend <brand>?" options=[].
  q6 WIN-BACK PROBABILITY (churn_stage="win_back") — type="single" options=["Yes","Maybe","No"]. text="Would you reconsider using <brand> in the future?"
  q7 WIN-BACK TRIGGERS (churn_stage="win_back") — type="multi", text="What would bring you back? Select all that apply." options=["Price discount or promo","New feature or improvement","Better service","Personal outreach","New product offering","Change in my situation","Other"].
  q8 COMPETITIVE SWITCH (churn_stage="switch") — type="text", text="Did you switch to a competitor? If so, which one?"
  q9 CES AT FINAL INTERACTION (churn_stage="switch") — type="rating" 1-7, options=[]. text="How easy or difficult was it to <cancel/leave/stop using> <brand>?"
  q10 WARNING SIGNS (churn_stage="warning") — type="text", text="Looking back, what was the first sign you'd leave <brand>?"
  q11 TIME TO CHURN (churn_stage="tenure") — type="single", text="How long were you a <brand> customer before you left?", options=["Less than 1 month","1-3 months","3-12 months","1-3 years","More than 3 years"].
- "<brand>" placeholders pull from clarify.brand_name. If absent, use "the brand".
- Customer type from clarify.churn_customer_type tunes the verbs in q1 + q9 (e.g. "subscription" → "cancelled"; "one_time" → "stopped buying"; "recurring" → "stopped purchasing"; "b2b" → "ended your contract").
- Recency window from clarify.churn_definition is interpolated into q1 ("past 30 days" / "past 90 days" / "past 12 months" / etc).
- DO NOT include vw_band, gg_anchor_index, kano_type, feature_set, candidate_id, brand_id, funnel_stage — those belong to other methodologies.
- suggestedRespondentCount default 200 (well above the 100 churn_driver bound).

Output MUST be valid JSON. No prose, no markdown fences.`;

function validateChurnSurvey(parsed) {
  if (!parsed || typeof parsed !== 'object') return 'response is not an object';
  const qs = Array.isArray(parsed.questions) ? parsed.questions : null;
  if (!qs) return 'questions array missing';
  if (qs.length !== 11) return `expected 11 questions, got ${qs.length}`;
  if (qs[0].isScreening !== true) return 'q1 must be isScreening=true';
  const expectedStages = [
    'screener', 'reason', 'reason', 'satisfaction', 'satisfaction',
    'win_back', 'win_back', 'switch', 'switch', 'warning', 'tenure',
  ];
  for (let i = 0; i < expectedStages.length; i++) {
    if (qs[i].churn_stage !== expectedStages[i]) {
      return `q${i + 1} expected churn_stage="${expectedStages[i]}", got "${qs[i].churn_stage}"`;
    }
  }
  if (qs[3].type !== 'single' || (qs[3].options || []).length !== 5) {
    return 'q4 (satisfaction) must be single with 5 options';
  }
  if (qs[4].type !== 'rating') return 'q5 (NPS) must be type=rating';
  if (qs[8].type !== 'rating') return 'q9 (CES) must be type=rating';
  return null;
}

function buildChurnUserPrompt({ description, clarify }) {
  const c = clarify || {};
  const recencyMap = {
    cancelled_30d: 'past 30 days',
    cancelled_90d: 'past 90 days',
    cancelled_12m: 'past 12 months',
    inactive_30d:  'past 30 days (inactive)',
    inactive_90d:  'past 90 days (inactive)',
  };
  const recency = recencyMap[c.churn_definition] || c.churn_custom_definition || 'recent period';
  const brandName = (c.brand_name || '').trim();
  const lines = [
    'Mission Goal: churn_research',
    `Brief: "${description}"`,
    // Pass 35 B4 — brand name explicit. The system prompt template
    // uses "<brand>" placeholder; we replace at prompt-build time
    // rather than relying on Claude to extract from the brief.
    `Focal brand name: ${brandName || '<missing — refuse to generate>'}`,
    `Customer type: ${c.churn_customer_type || 'subscription'}`,
    `Churn definition / recency: ${recency}`,
    `Win-back possible: ${c.churn_winback_possible || 'unknown'}`,
    '',
    `Use the focal brand name "${brandName}" verbatim everywhere a question references the brand. NEVER use "the brand" placeholder.`,
    'Generate the 11-question Churn Driver Tree + Win-Back survey JSON.',
  ];
  return lines.join('\n');
}

async function generateChurnSurvey({ description, clarify }) {
  // Pass 35 B4 — refuse if brand_name missing.
  const brand = (clarify?.brand_name || '').trim();
  if (!brand) {
    const err = new Error(
      'churn_research: focal brand_name is required (received empty). ' +
      'Add a brand name in the Churn setup section before generating.',
    );
    err.code = 'CHURN_MISSING_BRAND_NAME';
    err.statusCode = 400;
    throw err;
  }

  const userPrompt = buildChurnUserPrompt({ description, clarify });
  const firstResp = await callClaude({
    callType: 'survey_gen',
    systemPrompt: CHURN_SURVEY_GEN_SYSTEM,
    messages: [{ role: 'user', content: userPrompt }],
    maxTokens: 2500,
    enablePromptCache: true,
  });
  let parsed;
  try { parsed = extractJSON(firstResp.text); }
  catch (err) { parsed = null; logger.warn('churn survey: parse failed', { err: err.message }); }
  let validationErr = parsed ? validateChurnSurvey(parsed) : 'response could not be parsed';
  if (!validationErr) return parsed;

  logger.info('churn survey: retry on validation failure', { reason: validationErr });
  const retryResp = await callClaude({
    callType: 'survey_gen',
    systemPrompt: CHURN_SURVEY_GEN_SYSTEM,
    messages: [{
      role: 'user',
      content: `${userPrompt}\n\nYour previous reply failed validation: ${validationErr}\nReturn the JSON again with that issue fixed. Keep all other rules.`,
    }],
    maxTokens: 2500,
    enablePromptCache: true,
  });
  try { parsed = extractJSON(retryResp.text); }
  catch (err) { parsed = null; logger.warn('churn survey: retry parse failed', { err: err.message }); }
  validationErr = parsed ? validateChurnSurvey(parsed) : 'retry response could not be parsed';
  if (!validationErr) return parsed;

  logger.warn('churn survey: both attempts failed validation', {
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

// ── WO §3.2 — AUDIENCE PROFILING (psychographic + behavioural segmentation) ──
const AUDIENCE_PROFILING_SURVEY_GEN_SYSTEM = `You are a senior segmentation methodologist. You design psychographic + behavioural audience-profiling surveys whose responses cluster into 2-4 segments. Always return ONLY valid JSON with no markdown fences.

JSON structure required:
{
  "productName": "Short category/brand name from the brief (2-5 words)",
  "missionStatement": "One sentence starting 'To profile and segment the target audience for ...'",
  "questions": [
    {
      "id": "q1",
      "text": "Question text",
      "type": "single|multi|rating",
      "options": ["Option A"],
      "isScreening": true,
      "kind": "screener|behavioural|attitudinal|needs|media",
      "dimension": "price_sensitivity|novelty_seeking|brand_loyalty|convenience|status|sustainability"
    }
  ],
  "targetingSuggestions": { "recommendedCountries": ["US"], "recommendedAgeRanges": ["25-44"], "recommendedGenders": [], "reasoning": "..." },
  "suggestedRespondentCount": 200
}

Hard rules — generate EXACTLY 12 questions in this fixed order:
  q1 SCREENER (isScreening=true, kind="screener") — qualifies category users from the brief. type="single", 2-3 options.
  q2-q7 ATTITUDINAL BATTERY (kind="attitudinal") — ONE 1-7 agree/disagree statement per dimension, type="rating", options=[], in EXACTLY this dimension order (reword the statement to fit the category but keep the dimension tag exact and the 1-7 scale):
    q2 dimension="price_sensitivity" — e.g. "I always look for the best price or deals in this category."
    q3 dimension="novelty_seeking" — e.g. "I love trying new products and brands before other people do."
    q4 dimension="brand_loyalty" — e.g. "Once I find a brand I like, I stick with it."
    q5 dimension="convenience" — e.g. "Convenience matters more to me than getting the lowest price."
    q6 dimension="status" — e.g. "The brands I use say something about who I am."
    q7 dimension="sustainability" — e.g. "I prefer brands that are ethical and sustainable."
  q8 BEHAVIOURAL — usage frequency. kind="behavioural", type="single", 4-5 frequency options.
  q9 BEHAVIOURAL — category spend or buying occasion. kind="behavioural", type="single".
  q10 BEHAVIOURAL — brand repertoire ("which of these do you use?"). kind="behavioural", type="multi", real category brands.
  q11 MEDIA — where they spend media time. kind="media", type="multi". MUST mix TV/VOD and social/digital options appropriate to the market (e.g. MBC, Shahid, Netflix, Instagram, TikTok, YouTube).
  q12 NEEDS — most important attributes when choosing. kind="needs", type="multi", 5-7 category attributes.

- Only attitudinal questions carry "dimension"; every other question omits it.
- Q1 isScreening MUST be true; all others false.
- Never include vw_band, funnel_stage, feature_id, kano_type, channel_id.
- suggestedRespondentCount default 200 (segmentation needs >=50 qualified; aim higher when sub-segments are mentioned).
Output MUST be valid JSON. No prose, no markdown fences.`;

const AP_DIMENSIONS = ['price_sensitivity', 'novelty_seeking', 'brand_loyalty', 'convenience', 'status', 'sustainability'];

function validateAudienceProfilingSurvey(parsed) {
  if (!parsed || typeof parsed !== 'object') return 'response is not an object';
  const qs = Array.isArray(parsed.questions) ? parsed.questions : null;
  if (!qs) return 'questions array missing';
  if (qs.length < 10) return `expected ~12 questions, got ${qs.length}`;
  const attDims = qs.filter((q) => q.kind === 'attitudinal').map((q) => q.dimension);
  for (const d of AP_DIMENSIONS) if (!attDims.includes(d)) return `missing attitudinal dimension "${d}"`;
  if (!qs.some((q) => q.kind === 'media')) return 'missing a media question';
  if (!qs.some((q) => q.kind === 'needs')) return 'missing a needs question';
  if (!qs.some((q) => q.kind === 'behavioural')) return 'missing behavioural questions';
  return null;
}

function buildAudienceProfilingUserPrompt({ description, clarify }) {
  const c = clarify || {};
  const lines = [
    'Mission Goal: audience_profiling',
    `Brief: "${description}"`,
    `Category / brand: ${c.category || c.brand_name || '<infer from brief>'}`,
  ];
  if (c.markets || c.target_market) lines.push(`Target market(s): ${c.markets || c.target_market}`);
  if (c.segmentation_focus) lines.push(`Segmentation focus: "${c.segmentation_focus}"`);
  lines.push('');
  lines.push('Generate the 12-question psychographic + behavioural profiling survey. Keep ONE attitudinal statement per dimension with the exact dimension tags.');
  return lines.join('\n');
}

async function generateAudienceProfilingSurvey({ description, clarify }) {
  const userPrompt = buildAudienceProfilingUserPrompt({ description, clarify });
  const first = await callClaude({
    callType: 'survey_gen', systemPrompt: AUDIENCE_PROFILING_SURVEY_GEN_SYSTEM,
    messages: [{ role: 'user', content: userPrompt }], maxTokens: 2800, enablePromptCache: true,
  });
  let parsed;
  try { parsed = extractJSON(first.text); } catch (err) { parsed = null; logger.warn('audience_profiling survey: parse failed', { err: err.message }); }
  let validationErr = parsed ? validateAudienceProfilingSurvey(parsed) : 'response could not be parsed';
  if (!validationErr) return parsed;
  logger.info('audience_profiling survey: retry on validation failure', { reason: validationErr });
  const retry = await callClaude({
    callType: 'survey_gen', systemPrompt: AUDIENCE_PROFILING_SURVEY_GEN_SYSTEM,
    messages: [{ role: 'user', content: `${userPrompt}\n\nYour previous reply failed validation: ${validationErr}\nReturn the JSON again with that fixed. Keep all other rules.` }],
    maxTokens: 2800, enablePromptCache: true,
  });
  try { parsed = extractJSON(retry.text); } catch (err) { parsed = null; logger.warn('audience_profiling survey: retry parse failed', { err: err.message }); }
  validationErr = parsed ? validateAudienceProfilingSurvey(parsed) : 'retry response could not be parsed';
  if (!validationErr) return parsed;
  logger.warn('audience_profiling survey: both attempts failed validation', { reason: validationErr });
  return parsed || { questions: [], missionStatement: '', productName: '' };
}

// ── WO §3.3 — MARKET ENTRY (geo demand validation) ───────────────────────────
const MARKET_ENTRY_SURVEY_GEN_SYSTEM = `You are a senior market-entry methodologist. You design geo demand-validation surveys: concept appeal + purchase intent + light willingness-to-pay + adoption barriers + the local competitive set, localised to a new target market. Always return ONLY valid JSON with no markdown fences.

JSON structure required:
{
  "productName": "Short concept name from the brief (2-5 words)",
  "missionStatement": "One sentence: 'To validate demand for <concept> in <target market>...'",
  "questions": [
    {
      "id": "q1", "text": "Question text", "type": "single|multi|rating|text",
      "options": ["Option A"], "isScreening": true,
      "kind": "screener|appeal|intent|wtp|barrier|competitive|localisation"
    }
  ],
  "targetingSuggestions": { "recommendedCountries": [], "recommendedAgeRanges": [], "recommendedGenders": [], "reasoning": "..." },
  "suggestedRespondentCount": 200
}

Hard rules — generate 7-8 questions in this order:
  q1 SCREENER (isScreening=true, kind="screener") — qualifies category buyers IN THE TARGET MARKET. type="single".
  q2 APPEAL (kind="appeal") — "How appealing is <concept> to you?" type="rating" 1-7, options=[].
  q3 INTENT (kind="intent") — "If <concept> were available in <market>, how likely would you be to buy?" type="single", 5 options ["Definitely would buy","Probably would buy","Might or might not","Probably would NOT buy","Definitely would NOT buy"].
  q4 WTP (kind="wtp") — willingness to pay. type="single" with 4-5 ASCENDING local-currency price-band options (cheapest to dearest); localise the currency to the target market.
  q5 BARRIERS (kind="barrier") — "What would make you hesitate?" type="multi"; options MUST cover regulatory/trust, cultural fit, logistics/delivery, local competition, and awareness.
  q6 COMPETITIVE (kind="competitive") — "Which of these do you currently use in <market>?" type="multi", real LOCAL competitors for that geography.
  q7 LOCALISATION (kind="localisation") — "What would this need to change to fit <market>?" type="text".

- Substitute the real <concept> name and <market> into every question; never leave angle-bracket placeholders.
- Q1 isScreening MUST be true; all others false. No vw_band/funnel_stage/feature_id/dimension.
- suggestedRespondentCount default 200 (aim for >=30 per target market for reliable demand/WTP).
Output MUST be valid JSON. No prose, no markdown fences.`;

function validateMarketEntrySurvey(parsed) {
  if (!parsed || typeof parsed !== 'object') return 'response is not an object';
  const qs = Array.isArray(parsed.questions) ? parsed.questions : null;
  if (!qs) return 'questions array missing';
  const kinds = qs.map((q) => q.kind);
  for (const k of ['screener', 'appeal', 'intent', 'barrier']) if (!kinds.includes(k)) return `missing a "${k}" question`;
  const intent = qs.find((q) => q.kind === 'intent');
  if (!intent || !Array.isArray(intent.options) || intent.options.length !== 5) return 'intent must be single with 5 options';
  const appeal = qs.find((q) => q.kind === 'appeal');
  if (!appeal || appeal.type !== 'rating') return 'appeal must be a rating question';
  return null;
}

function buildMarketEntryUserPrompt({ description, clarify }) {
  const c = clarify || {};
  const markets = c.target_markets || c.markets || c.target_market || '';
  const lines = [
    'Mission Goal: market_entry',
    `Brief: "${description}"`,
    `Concept: "${c.concept_description || c.product_description || description}"`,
  ];
  if (c.current_market) lines.push(`Current market: ${c.current_market}`);
  if (markets) lines.push(`Target market(s): ${markets}`);
  if (c.price || c.positioning) lines.push(`Price / positioning: ${[c.price, c.positioning].filter(Boolean).join(' / ')}`);
  lines.push('');
  lines.push('Generate the market-entry demand-validation survey, localised to the target market(s). Use real local competitors and local currency. Substitute the concept name and market into every question.');
  return lines.join('\n');
}

async function generateMarketEntrySurvey({ description, clarify }) {
  const userPrompt = buildMarketEntryUserPrompt({ description, clarify });
  const first = await callClaude({
    callType: 'survey_gen', systemPrompt: MARKET_ENTRY_SURVEY_GEN_SYSTEM,
    messages: [{ role: 'user', content: userPrompt }], maxTokens: 2500, enablePromptCache: true,
  });
  let parsed;
  try { parsed = extractJSON(first.text); } catch (err) { parsed = null; logger.warn('market_entry survey: parse failed', { err: err.message }); }
  let validationErr = parsed ? validateMarketEntrySurvey(parsed) : 'response could not be parsed';
  if (!validationErr) return parsed;
  logger.info('market_entry survey: retry on validation failure', { reason: validationErr });
  const retry = await callClaude({
    callType: 'survey_gen', systemPrompt: MARKET_ENTRY_SURVEY_GEN_SYSTEM,
    messages: [{ role: 'user', content: `${userPrompt}\n\nYour previous reply failed validation: ${validationErr}\nReturn the JSON again with that fixed. Keep all other rules.` }],
    maxTokens: 2500, enablePromptCache: true,
  });
  try { parsed = extractJSON(retry.text); } catch (err) { parsed = null; logger.warn('market_entry survey: retry parse failed', { err: err.message }); }
  validationErr = parsed ? validateMarketEntrySurvey(parsed) : 'retry response could not be parsed';
  if (!validationErr) return parsed;
  logger.warn('market_entry survey: both attempts failed validation', { reason: validationErr });
  return parsed || { questions: [], missionStatement: '', productName: '' };
}

module.exports = {
  generateSurvey,
  refineQuestion,
  refineMissionDescription,
  analyseResults,
  suggestTargeting,
  // Pass 42 G1 — exported for the synthesis pipeline / future
  // prompt templates that want clean subject text instead of the
  // raw brief.
  extractSubject,
  // WO §3.2/§3.3 — exported for contract tests (the live generators can't be
  // unit-tested without a valid Anthropic key; these guard their output shape).
  validateAudienceProfilingSurvey,
  validateMarketEntrySurvey,
  buildAudienceProfilingUserPrompt,
  buildMarketEntryUserPrompt,
};
