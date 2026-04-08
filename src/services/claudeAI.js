const Anthropic = require('@anthropic-ai/sdk');
const logger = require('../utils/logger');

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const MODEL = 'claude-sonnet-4-5';

/**
 * Generate a complete survey from a user's mission description
 */
async function generateSurvey({ goal, description, targetingHints = {} }) {
  const prompt = `You are a senior market researcher at a top-tier research consultancy. 
A client has come to you with the following brief:

Mission Goal: ${goal}
Description: "${description}"
${targetingHints.countries?.length ? `Target Markets: ${targetingHints.countries.join(', ')}` : ''}

Your job is to design a professional survey. Return ONLY a valid JSON object with this exact structure:

{
  "missionStatement": "A clear, one-sentence research objective starting with 'To understand...' or 'To determine...' or 'To validate...'",
  "questions": [
    {
      "id": "q1",
      "text": "Question text here",
      "type": "single",
      "options": ["Option A", "Option B", "Option C"],
      "isScreening": true,
      "qualifyingAnswer": "Option A",
      "aiRefined": true
    }
  ],
  "targetingSuggestions": {
    "recommendedCountries": ["US", "UK"],
    "recommendedAgeRanges": ["25-34", "35-44"],
    "recommendedGenders": [],
    "reasoning": "Brief explanation of why this targeting makes sense"
  },
  "suggestedRespondentCount": 200
}

Rules:
- Generate exactly 5 questions (the first MUST be a screening question)
- Question types: "single" (single choice), "multi" (multiple choice), "rating" (1-10 scale), "text" (open-ended), "nps" (0-10 net promoter), "yesno" (Yes/No), "opinion" (Yes/No/Maybe)
- For "single", "multi", "opinion", "yesno" types: always include "options" array
- For "rating" and "nps" types: options array can be empty
- For "text" type: options array can be empty
- Questions must be specific, unbiased, and professionally worded
- The screening question should filter for the most relevant respondents
- Make questions flow logically from broad to specific`;

  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 2000,
    messages: [{ role: 'user', content: prompt }],
  });

  const text = response.content[0].text.trim();
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error('Claude returned invalid JSON for survey generation');

  return JSON.parse(jsonMatch[0]);
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

  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 500,
    messages: [{ role: 'user', content: prompt }],
  });

  const text = response.content[0].text.trim();
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error('Claude returned invalid JSON for question refinement');

  return JSON.parse(jsonMatch[0]);
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

  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 500,
    messages: [{ role: 'user', content: prompt }],
  });

  const text = response.content[0].text.trim();
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error('Claude returned invalid JSON for description refinement');

  return JSON.parse(jsonMatch[0]);
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

  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 3000,
    messages: [{ role: 'user', content: prompt }],
  });

  const text = response.content[0].text.trim();
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error('Claude returned invalid JSON for results analysis');

  return JSON.parse(jsonMatch[0]);
}

/**
 * Suggest optimal Pollfish targeting based on mission description
 */
async function suggestTargeting({ missionStatement, description, goal }) {
  const prompt = `You are a market research targeting specialist. Based on this research mission, suggest the optimal audience targeting.

Mission: "${missionStatement}"
Description: "${description}"
Goal: ${goal}

Return ONLY a JSON object:
{
  "geography": {
    "recommendedCountries": ["US", "UK"],
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

  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 1000,
    messages: [{ role: 'user', content: prompt }],
  });

  const text = response.content[0].text.trim();
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error('Claude returned invalid JSON for targeting suggestions');

  return JSON.parse(jsonMatch[0]);
}

module.exports = {
  generateSurvey,
  refineQuestion,
  refineMissionDescription,
  analyseResults,
  suggestTargeting,
};
