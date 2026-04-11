const axios = require('axios');
const logger = require('../utils/logger');

const CINT_BASE_URL = 'https://api.cint.com/v1';
const CINT_API_VERSION = '2025-12-18';

/**
 * CINT EXCHANGE SERVICE
 * ─────────────────────────────────────────────────────────────
 * Replaces the previous Pollfish integration.
 * Uses the Cint Exchange API (Bearer token auth).
 *
 * Required environment variables:
 *   CINT_API_KEY       — Bearer token from Cint dashboard
 *   CINT_ACCOUNT_ID    — Your Cint account/buyer ID
 *
 * When CINT_API_KEY is not set, mock mode is active and all
 * functions return simulated data so the rest of the app works.
 */

const IS_MOCK = !process.env.CINT_API_KEY || process.env.CINT_API_KEY === 'your-cint-api-key-here';

function cintHeaders() {
  return {
    Authorization: `Bearer ${process.env.CINT_API_KEY}`,
    'Cint-API-Version': CINT_API_VERSION,
    'Content-Type': 'application/json',
  };
}

// ─── Public API ───────────────────────────────────────────────

/**
 * Create a survey project + target group on Cint Exchange.
 * Returns { pollfishSurveyId, status, estimatedCostUsd, mock }
 * (field kept as pollfishSurveyId for backwards compatibility with callers)
 */
async function createSurvey({ missionId, questions, targeting, respondentCount, missionStatement }) {
  if (IS_MOCK) {
    logger.warn('CINT MOCK MODE: Simulating survey creation');
    return {
      pollfishSurveyId: `mock_cint_${missionId}_${Date.now()}`,
      status: 'active',
      estimatedCostUsd: respondentCount * 1.50,
      mock: true,
    };
  }

  // Step 1 — Create the project
  const projectPayload = {
    name: `Vettit Mission: ${missionStatement?.substring(0, 80)}`,
    account_id: process.env.CINT_ACCOUNT_ID,
    survey_url: `https://vettit-backend-production.up.railway.app/api/cint/survey/${missionId}`,
    completes_required: respondentCount,
    loi: estimateLOI(questions),
    ir: 50, // assumed incidence rate — update once you have historical data
    questions: buildCintQuestions(questions),
  };

  const projectRes = await axios.post(`${CINT_BASE_URL}/projects`, projectPayload, {
    headers: cintHeaders(),
  });

  const projectId = projectRes.data.id;

  // Step 2 — Create the target group on the project
  const targetGroupPayload = buildCintTargetGroup(targeting, respondentCount);

  const targetGroupRes = await axios.post(
    `${CINT_BASE_URL}/projects/${projectId}/target-groups`,
    targetGroupPayload,
    { headers: cintHeaders() }
  );

  const targetGroupId = targetGroupRes.data.id;
  const surveyId = `${projectId}:${targetGroupId}`;

  logger.info('Cint survey created', { missionId, projectId, targetGroupId });

  return {
    pollfishSurveyId: surveyId,
    status: 'active',
    estimatedCostUsd: targetGroupRes.data.estimated_cost_usd ?? respondentCount * 1.50,
    mock: false,
  };
}

/**
 * Check completion progress of a Cint survey.
 * Returns { status, completedResponses, mock }
 */
async function getSurveyStatus(surveyId) {
  if (IS_MOCK || surveyId?.startsWith('mock_')) {
    const createdAt = parseInt(surveyId?.split('_')[3] || Date.now());
    const elapsed = Date.now() - createdAt;
    const mockTotal = 200;
    const mockProgress = Math.min(Math.floor((elapsed / 1000 / 60) * 10), mockTotal);
    return {
      status: mockProgress >= mockTotal ? 'completed' : 'active',
      completedResponses: mockProgress,
      mock: true,
    };
  }

  const [projectId, targetGroupId] = surveyId.split(':');

  const res = await axios.get(
    `${CINT_BASE_URL}/projects/${projectId}/target-groups/${targetGroupId}`,
    { headers: cintHeaders() }
  );

  const tg = res.data;
  const completedResponses = tg.completes ?? 0;
  const required = tg.completes_required ?? 1;
  const isDone = completedResponses >= required || tg.status === 'closed';

  return {
    status: isDone ? 'completed' : tg.status ?? 'active',
    completedResponses,
    mock: false,
  };
}

/**
 * Fetch completed survey results from Cint.
 * Returns normalised results matching the old Pollfish shape.
 */
async function getSurveyResults(surveyId) {
  if (IS_MOCK || surveyId?.startsWith('mock_')) {
    return generateMockResults();
  }

  const [projectId, targetGroupId] = surveyId.split(':');

  const res = await axios.get(
    `${CINT_BASE_URL}/projects/${projectId}/target-groups/${targetGroupId}/responses`,
    { headers: cintHeaders() }
  );

  return normaliseCintResults(res.data);
}

// ─── Helpers ──────────────────────────────────────────────────

function buildCintQuestions(questions) {
  return (questions || []).map((q, index) => ({
    position: index + 1,
    text: q.text,
    type: mapQuestionType(q.type),
    options: (q.options || []).map((opt, i) => ({ position: i + 1, text: opt })),
    required: true,
  }));
}

function mapQuestionType(vettitType) {
  const map = {
    single: 'SINGLE_CHOICE',
    multi: 'MULTIPLE_CHOICE',
    rating: 'RATING_SCALE',
    text: 'OPEN_ENDED',
    nps: 'NPS',
    yesno: 'SINGLE_CHOICE',
    opinion: 'SINGLE_CHOICE',
  };
  return map[vettitType] || 'SINGLE_CHOICE';
}

function buildCintTargetGroup(targeting, respondentCount) {
  const quotas = [];

  // Geography
  const countries = targeting?.geography?.countries || [];
  if (countries.length) {
    quotas.push({
      type: 'COUNTRY',
      values: countries, // ISO 2-letter codes, e.g. ["AE", "GB"]
    });
  }

  // Gender
  const genders = targeting?.demographics?.genders || [];
  if (genders.length) {
    quotas.push({
      type: 'GENDER',
      values: genders.map(g => g.toLowerCase()), // 'male' | 'female'
    });
  }

  // Age
  const ageRanges = targeting?.demographics?.ageRanges || [];
  if (ageRanges.length) {
    const { min, max } = parseAgeRanges(ageRanges);
    quotas.push({ type: 'AGE', min_value: min, max_value: max });
  }

  return {
    name: 'Primary Audience',
    completes_required: respondentCount,
    quotas,
  };
}

function parseAgeRanges(ranges) {
  const allAges = ranges.flatMap(r => {
    const parts = r.split('-').map(Number);
    return parts.filter(n => !isNaN(n));
  });
  return {
    min: allAges.length ? Math.min(...allAges) : 18,
    max: allAges.length ? Math.max(...allAges) : 65,
  };
}

/** Estimate length-of-interview in minutes based on question count */
function estimateLOI(questions) {
  const count = (questions || []).length;
  if (count <= 5) return 3;
  if (count <= 10) return 6;
  return 10;
}

/** Normalise Cint response format to the shape the rest of the app expects */
function normaliseCintResults(cintData) {
  const responses = cintData.responses || [];
  const questionMap = {};

  for (const response of responses) {
    for (const answer of response.answers || []) {
      const qId = answer.question_id;
      if (!questionMap[qId]) questionMap[qId] = {};
      const val = answer.value ?? answer.text ?? 'Unknown';
      questionMap[qId][val] = (questionMap[qId][val] || 0) + 1;
    }
  }

  return {
    totalResponses: responses.length,
    completionRate: cintData.completion_rate ?? 0.92,
    avgCompletionTimeSeconds: cintData.avg_loi_seconds ?? 180,
    responses: Object.entries(questionMap).map(([questionId, answers]) => ({
      questionId,
      answers,
    })),
    demographics: cintData.demographics ?? {},
  };
}

function generateMockResults() {
  return {
    totalResponses: 200,
    completionRate: 0.94,
    avgCompletionTimeSeconds: 187,
    responses: [
      { questionId: 'q1', answers: { 'Yes': 156, 'No': 44 } },
      { questionId: 'q2', answers: { 'Very satisfied': 89, 'Satisfied': 67, 'Neutral': 31, 'Dissatisfied': 13 } },
      { questionId: 'q3', answers: { 'Feature A': 120, 'Feature B': 95, 'Feature C': 74, 'Feature D': 43 } },
      { questionId: 'q4', answers: { '1': 3, '2': 7, '3': 18, '4': 41, '5': 58, '6': 33, '7': 24, '8': 10, '9': 4, '10': 2 } },
      { questionId: 'q5', texts: [
        'The product idea is interesting but pricing needs work.',
        'Would definitely use this if it were easier to set up.',
        'Great concept, needs more features.',
        'Very innovative approach to the problem.',
      ]},
    ],
    demographics: {
      genderSplit: { Male: 48, Female: 52 },
      ageSplit: { '18-24': 15, '25-34': 32, '35-44': 28, '45-54': 16, '55+': 9 },
      countryBreakdown: { US: 45, UK: 30, AU: 25 },
    },
  };
}

module.exports = { createSurvey, getSurveyStatus, getSurveyResults };
