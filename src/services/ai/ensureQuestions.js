/**
 * Pass 46 Phase 2 — empty-survey guard (audit P0-5).
 *
 * Pass 45's scale test v1 proved the hole live: an API-created mission
 * with questions:[] ran the full paid pipeline against an EMPTY survey
 * — 100 personas simulated zero questions, $0.39 burned, garbage
 * insights, status 'completed'. The UI flow is safe (questions are
 * generated pre-payment via POST /api/ai/generate-survey) but nothing
 * guarded the pipeline itself.
 *
 * This module is called at the top of runMission's survey path: when
 * the mission row has no questions it generates them with the SAME
 * generator the UI uses (claudeAI.generateSurvey, which includes the
 * Pass 45 extractSubject wiring) and persists them to the row so
 * renderers, exports, and backfills see them. If generation cannot
 * produce a usable survey the caller must FAIL the mission — a paid
 * pipeline must never run an empty survey.
 */

const logger = require('../../utils/logger');
const { updateMission } = require('../../db/missionSchema');

/**
 * @param {object} supabase service client (passed through to updateMission)
 * @param {object} mission  full mission row
 * @returns {Promise<Array>} a non-empty questions array (persisted)
 * @throws when the mission has no usable brief or generation fails/returns empty
 */
async function ensureMissionQuestions(supabase, mission) {
  if (Array.isArray(mission.questions) && mission.questions.length > 0) {
    return mission.questions;
  }

  const description = (mission.brief || mission.title || '').trim();
  if (description.length < 20) {
    throw new Error(
      `mission has no questions and no usable brief to generate from (brief length ${description.length})`,
    );
  }

  logger.warn('ensureMissionQuestions: mission has no questions — generating at run time', {
    missionId: mission.id, goalType: mission.goal_type,
  });

  // Lazy require avoids a module cycle (claudeAI is heavy) and lets
  // tests mock it cleanly.
  const ai = require('../claudeAI');
  const result = await ai.generateSurvey({
    goal:          mission.goal_type || 'research',
    description,
    clarify:       {},
    missionAssets: [],
  });

  const questions = Array.isArray(result?.questions) ? result.questions : [];
  if (questions.length === 0) {
    throw new Error('generateSurvey returned no questions');
  }

  await updateMission(supabase, mission.id, { questions }, {
    caller: 'ensureMissionQuestions: run-time generation',
  });
  logger.info('ensureMissionQuestions: generated + persisted questions', {
    missionId: mission.id, count: questions.length,
  });
  return questions;
}

module.exports = { ensureMissionQuestions };
