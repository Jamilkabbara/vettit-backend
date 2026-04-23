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
 *   survey_gen       → claude-sonnet-4-6  (complex multi-field JSON generation)
 *   question_refine  → claude-haiku-4-5   (short, fast, single-question rewrites)
 *   targeting_suggest → claude-sonnet-4-6 (multi-dimension targeting JSON)
 *   results_analysis → claude-sonnet-4-6  (long analytical report generation)
 *
 * generateSurvey and analyseResults use inline prompts — model is
 * 'survey_gen' and 'results_analysis' respectively.
 */

/**
 * Generate a complete survey from a user's mission description
 */
async function generateSurvey({ goal, description, targetingHints = {} }) {
  const prompt = `You are a senior market researcher at a top-tier research consultancy.
A client has come to you with the following brief:

Mission Goal: ${goal}
Description: "${description}"
${targetingHints.countries?.length ? `Target Markets: ${targetingHints.countries.join(', ')}` : ''}

First, extract a SHORT product/concept name (2-5 words max) from the description to use in questions.
For example: "pineapple pizza" not "I want to validate pineapple pizza in dubai for my target customers".

Your job is to design a professional survey. Return ONLY a valid JSON object with this exact structure:

{
  "productName": "Short product name extracted from description (2-5 words)",
  "missionStatement": "A clear, one-sentence research objective starting with 'To understand...' or 'To determine...' or 'To validate...'",
  "questions": [
    {
      "id": "q1",
      "text": "Question text here — use the short productName, NEVER paste the full description",
      "type": "single",
      "options": ["Option A", "Option B", "Option C"],
      "isScreening": true,
      "qualifyingAnswer": "Option A",
      "screening_continue_on": ["Option A", "Option B"],
      "aiRefined": true
    },
    {
      "id": "q2",
      "text": "Non-screening question text",
      "type": "rating",
      "options": [],
      "isScreening": false,
      "qualifyingAnswer": null,
      "screening_continue_on": null,
      "aiRefined": true
    }
  ],
  "targetingSuggestions": {
    "recommendedCountries": ["AE", "US"],
    "recommendedAgeRanges": ["25-34", "35-44"],
    "recommendedGenders": [],
    "reasoning": "Brief explanation of why this targeting makes sense"
  },
  "suggestedRespondentCount": 200
}

Rules:
- Generate exactly 5 questions (the first MUST be a screening question)
- CRITICAL: In question text, ONLY use the short productName — never paste the raw description
- Question types: "single" (single choice), "multi" (multiple choice), "rating" (1-5 scale), "opinion" (agree/disagree scale), "text" (open-ended)
- For "single" and "multi" types: always include a relevant "options" array (3-5 options)
- For "opinion" type: options = ["Strongly Agree", "Agree", "Neutral", "Disagree", "Strongly Disagree"]
- For "rating" type: options array can be empty
- For "text" type: options array can be empty
- Questions must be specific, unbiased, and professionally worded
- SCREENING QUESTION RULES (question 1 only):
  • isScreening: true
  • qualifyingAnswer: the single "best" qualifying answer (string)
  • screening_continue_on: array of ALL answer options that qualify a respondent to continue
    (typically 1-3 options; anyone whose answer is NOT in this array is screened out)
  • Example: "Do you own a smartphone?" → options: ["Yes", "No"], screening_continue_on: ["Yes"]
  • Example: "How often do you shop online?" → screening_continue_on: ["Daily", "Weekly", "Monthly"]
- NON-SCREENING QUESTIONS: set isScreening: false, qualifyingAnswer: null, screening_continue_on: null
- Make questions flow logically: screening → awareness → perception → intent → open feedback
- CRITICAL for targetingSuggestions.recommendedCountries: use proper ISO 2-letter codes ONLY
  Examples: "AE" (UAE/Dubai), "US" (USA), "GB" (UK), "SA" (Saudi Arabia), "IN" (India), "AU" (Australia)
  If description mentions Dubai/UAE → use "AE". London/UK → "GB". USA/New York → "US"
- suggestedRespondentCount: recommend 100-500 based on specificity of targeting`;

  const response = await callClaude({
    callType: 'survey_gen',
    messages: [{ role: 'user', content: prompt }],
    maxTokens: 2000,
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
 * Part E — Pass 12: improved prompt with city extraction rules,
 * tighter age banding, cultural sensitivity flags.
 */
async function suggestTargeting({ missionStatement, description, goal }) {
  const prompt = `You are a senior market research targeting specialist. Based on this research mission, suggest the optimal audience targeting configuration.

Mission: "${missionStatement}"
Description: "${description}"
Goal: ${goal}

Return ONLY a JSON object using these exact rules:

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
  "suggestedRespondentCount": 200,
  "respondentCountReasoning": "Why this sample size is statistically appropriate for the targeting specificity"
}`;

  const response = await callClaude({
    callType: 'targeting_suggest',
    messages: [{ role: 'user', content: prompt }],
    maxTokens: 1200,
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
