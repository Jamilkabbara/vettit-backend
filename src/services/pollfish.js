const axios = require('axios');
const logger = require('../utils/logger');

const POLLFISH_BASE_URL = 'https://www.pollfish.com/api/public/v2';

/**
 * POLLFISH SERVICE
 * ─────────────────────────────────────────────────────────────
 * NOTE FOR JAMIL:
 * Pollfish's researcher API (programmatic survey creation) requires
 * contacting their team for enterprise/white-label API access.
 * 
 * Steps to activate:
 * 1. Create your Pollfish account at pollfish.com
 * 2. Email their team at support@pollfish.com explaining you want
 *    researcher API access for a white-label integration
 * 3. Get your API key and secret from Account Information page
 * 4. Add POLLFISH_API_KEY and POLLFISH_SECRET_KEY to your .env
 *
 * Until then, the mock mode below simulates the full flow so
 * everything else in the app works perfectly.
 */

const IS_MOCK = !process.env.POLLFISH_API_KEY || process.env.POLLFISH_API_KEY === 'your-pollfish-api-key-here';

/**
 * Create and launch a survey on Pollfish
 */
async function createSurvey({ missionId, questions, targeting, respondentCount, missionStatement }) {
  if (IS_MOCK) {
    logger.warn('POLLFISH MOCK MODE: Simulating survey creation');
    return {
      pollfishSurveyId: `mock_survey_${missionId}_${Date.now()}`,
      status: 'active',
      estimatedCostUsd: respondentCount * 1.50, // placeholder until real pricing
      mock: true,
    };
  }

  // Map Vettit question types to Pollfish question types
  const pollfishQuestions = questions.map((q, index) => ({
    position: index + 1,
    question: q.text,
    type: mapQuestionType(q.type),
    answers: q.options?.map((opt, i) => ({ position: i + 1, answer: opt })) || [],
    required: true,
  }));

  // Map targeting to Pollfish format
  const pollfishTargeting = buildPollfishTargeting(targeting);

  const payload = {
    name: `Vettit Mission: ${missionStatement?.substring(0, 50)}`,
    requiredCompletes: respondentCount,
    questions: pollfishQuestions,
    targeting: pollfishTargeting,
    recontact: false,
  };

  const response = await axios.post(`${POLLFISH_BASE_URL}/surveys`, payload, {
    auth: {
      username: process.env.POLLFISH_API_KEY,
      password: process.env.POLLFISH_SECRET_KEY,
    },
    headers: { 'Content-Type': 'application/json' },
  });

  logger.info('Pollfish survey created:', { missionId, pollfishId: response.data.id });

  return {
    pollfishSurveyId: response.data.id,
    status: 'active',
    estimatedCostUsd: response.data.estimatedCost,
    mock: false,
  };
}

/**
 * Get survey status and current response count from Pollfish
 */
async function getSurveyStatus(pollfishSurveyId) {
  if (IS_MOCK || pollfishSurveyId?.startsWith('mock_')) {
    // Simulate gradual completion for demo
    const createdAt = parseInt(pollfishSurveyId?.split('_')[3] || Date.now());
    const elapsed = Date.now() - createdAt;
    const mockTotal = 200;
    const mockProgress = Math.min(Math.floor((elapsed / 1000 / 60) * 10), mockTotal); // 10/min

    return {
      status: mockProgress >= mockTotal ? 'completed' : 'active',
      completedResponses: mockProgress,
      mock: true,
    };
  }

  const response = await axios.get(`${POLLFISH_BASE_URL}/surveys/${pollfishSurveyId}`, {
    auth: {
      username: process.env.POLLFISH_API_KEY,
      password: process.env.POLLFISH_SECRET_KEY,
    },
  });

  return {
    status: response.data.status,
    completedResponses: response.data.completedResponses,
    mock: false,
  };
}

/**
 * Fetch completed survey results from Pollfish
 */
async function getSurveyResults(pollfishSurveyId) {
  if (IS_MOCK || pollfishSurveyId?.startsWith('mock_')) {
    return generateMockResults();
  }

  const response = await axios.get(`${POLLFISH_BASE_URL}/surveys/${pollfishSurveyId}/results`, {
    auth: {
      username: process.env.POLLFISH_API_KEY,
      password: process.env.POLLFISH_SECRET_KEY,
    },
  });

  return response.data;
}

// ─── Helpers ──────────────────────────────────────────────────

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

function buildPollfishTargeting(targeting) {
  const pollfishTarget = {};

  if (targeting?.geography?.countries?.length) {
    pollfishTarget.countries = targeting.geography.countries;
  }

  if (targeting?.demographics?.genders?.length) {
    pollfishTarget.gender = targeting.demographics.genders.includes('Male') && targeting.demographics.genders.includes('Female')
      ? 0 : targeting.demographics.genders.includes('Male') ? 1 : 2;
  }

  if (targeting?.demographics?.ageRanges?.length) {
    const ages = parseAgeRanges(targeting.demographics.ageRanges);
    pollfishTarget.ageMin = ages.min;
    pollfishTarget.ageMax = ages.max;
  }

  return pollfishTarget;
}

function parseAgeRanges(ranges) {
  const allAges = ranges.flatMap(r => {
    const [min, max] = r.split('-').map(Number);
    return [min, max];
  }).filter(Boolean);
  return { min: Math.min(...allAges), max: Math.max(...allAges) };
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
