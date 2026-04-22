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
- The screening question should filter for the most relevant respondents
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
 * Suggest optimal audience targeting based on mission description
 */
async function suggestTargeting({ missionStatement, description, goal }) {
  const prompt = `You are a market research targeting specialist. Based on this research mission, suggest the optimal audience targeting.

Mission: "${missionStatement}"
Description: "${description}"
Goal: ${goal}

Return ONLY a JSON object. Use proper ISO 2-letter country codes (AE=UAE/Dubai, GB=UK, US=USA, SA=Saudi Arabia, FR=France, DE=Germany, IN=India, AU=Australia, CA=Canada, SG=Singapore):
{
  "geography": {
    "recommendedCountries": ["AE", "US"],
    "reasoning": "Why these markets"
  },
  "demographics": {
    "ageRanges": ["25-34", "35-44"],
    "genders": [],
    "education": [],
    "employment": ["Employed Full-time"],
    "reasoning": "Why these demographics"
  },
  "professional": {
    "industries": [],
    "roles": [],
    "companySizes": [],
    "reasoning": "Why these professional filters (or why none needed)"
  },
  "suggestedRespondentCount": 200,
  "respondentCountReasoning": "Why this sample size is statistically appropriate"
}`;

  const response = await callClaude({
    callType: 'targeting_suggest',
    messages: [{ role: 'user', content: prompt }],
    maxTokens: 1000,
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
