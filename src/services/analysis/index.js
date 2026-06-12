/**
 * Pass 46 Phase 3 — deterministic methodology analysis dispatcher.
 *
 * Doctrine (Jamil's explicit decision): the LLM does NOT compute
 * methodology math. computeAnalysis() produces every number the
 * methodology reports show, deterministically, from response rows;
 * the synthesis LLM receives the computed object and writes prose
 * ABOUT it (insights.js injects it with a no-recompute instruction),
 * and the Phase 4 centerpiece renderers read it from
 * missions.analysis.
 *
 * Each module: compute<X>(rows, questions, mission) → JSON-safe object
 * with top-level `methodology`, every percentage carrying its base n,
 * nulls (never NaN/undefined/throw) for incomputable blocks. All ten
 * have hand-fixture unit tests (test/*_analysis.test.js).
 */

const logger = require('../../utils/logger');
const { byQuestion, distribution, ratingStats, shares, personaCount } = require('./shared');

const { computeBrandLift }    = require('./brandLift');
const { computeMarketing }    = require('./marketing');
const { computePricing }      = require('./pricing');
const { computeRoadmap }      = require('./roadmap');
const { computeSatisfaction } = require('./satisfaction');
const { computeChurn }        = require('./churn');
const { computeValidate }     = require('./validate');
const { computeNaming }       = require('./naming');
const { computeCompare }      = require('./compare');
const { computeCompetitor }   = require('./competitor');

const ANALYSIS_VERSION = 1;

/**
 * Generic block for goal_type='research' (and any unmapped type):
 * per-question distributions / rating stats — the deterministic
 * counterpart of what the universal charts show.
 */
function computeResearch(rows, questions) {
  const qmap = byQuestion(rows);
  const perQuestion = [];
  for (const q of questions || []) {
    const qRows = qmap.get(q.id) || [];
    if (qRows.length === 0) {
      perQuestion.push({ question_id: q.id, text: q.text || null, n: 0, block: null });
      continue;
    }
    if (q.type === 'rating' || q.type === 'nps' || q.type === 'scale') {
      perQuestion.push({ question_id: q.id, text: q.text || null, n: personaCount(qRows), stats: ratingStats(qRows) });
    } else if (q.type === 'text' || q.type === 'open') {
      const verbatims = qRows.map((r) => (typeof r.answer === 'string' ? r.answer : null)).filter(Boolean).slice(0, 30);
      perQuestion.push({ question_id: q.id, text: q.text || null, n: personaCount(qRows), verbatims });
    } else {
      const dist = distribution(qRows);
      perQuestion.push({ question_id: q.id, text: q.text || null, n: personaCount(qRows), ...shares(dist, personaCount(qRows)) });
    }
  }
  return { methodology: 'research', n: personaCount(rows), per_question: perQuestion };
}

const DISPATCH = {
  brand_lift:       computeBrandLift,
  marketing:        computeMarketing,
  pricing:          computePricing,
  roadmap:          computeRoadmap,
  satisfaction:     computeSatisfaction,
  churn_research:   computeChurn,
  validate:         computeValidate,
  naming_messaging: computeNaming,
  compare:          computeCompare,
  competitor:       computeCompetitor,
};

/**
 * @param {object} mission   mission row (goal_type, brand_name, …)
 * @param {Array}  rows      clean response rows ({persona_id, question_id,
 *                           answer, exposure_status?, persona_profile?})
 * @returns {object|null}    the analysis object, or null on total failure
 *                           (callers persist null and the renderer falls
 *                           back — analysis is additive, never blocking)
 */
function computeAnalysis(mission, rows) {
  try {
    const questions = Array.isArray(mission.questions) ? mission.questions : [];
    const fn = DISPATCH[mission.goal_type];
    const core = fn
      ? fn(rows, questions, mission)
      : computeResearch(rows, questions);
    return {
      ...core,
      analysis_version: ANALYSIS_VERSION,
      computed_at: new Date().toISOString(),
    };
  } catch (err) {
    logger.error('computeAnalysis failed (non-fatal)', {
      missionId: mission.id, goalType: mission.goal_type, err: err.message,
    });
    return null;
  }
}

module.exports = { computeAnalysis, computeResearch, ANALYSIS_VERSION };
