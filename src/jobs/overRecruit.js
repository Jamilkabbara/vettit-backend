/**
 * Pass 23 Bug 23.25 — over-recruit until qualified target is reached or cap.
 *
 * Production forensic showed 4 of 8 completed missions had
 * qualified_respondent_count < respondent_count because runMission stopped at
 * exactly N personas regardless of how many got dropped by the screener. This
 * module wraps the existing batched primitives (generatePersonas +
 * simulateAllResponses) in an outer loop that keeps generating batches until
 * either the qualified target is hit or a hard cap (5x) is reached.
 *
 * Cost guard: cap = respondent_count × MAX_OVER_RECRUIT_MULTIPLIER. A
 * 10-respondent mission with a strict 50% screener tops out at 50 simulated
 * personas (~$0.50/mission, vs current ~$0.14 average). If audit telemetry
 * shows mission cost climbing past $0.75 we'll scope down to 3x.
 *
 * Adaptive batch sizing:
 *   - Round 1: batch = respondent_count (the current behaviour, ie. one shot)
 *   - Round 2+: batch = max(remaining*2, ceil(remaining/pass_rate)), clamped
 *     to cap_left. The 2x floor handles "first batch yielded zero qualified"
 *     (pass_rate == 0) and protects against single-batch under-allocation.
 *
 * Persistence: every batch's responses (qualified + screened-out) get
 * persisted to mission_responses immediately. Crash-resumable; matches the
 * Pass 22 architecture where mission_responses is the durable artifact.
 *
 * Reporting:
 *   - returns { personas, responses, totalSimulated, qualifiedCount, rounds, capHit }
 *   - qualifiedCount is the raw count (may exceed targetQualified by up to a
 *     batch size). Caller decides whether to cap for display purposes.
 */

const supabase = require('../db/supabase');
const logger = require('../utils/logger');
const { generatePersonas } = require('../services/ai/personas');
const { simulateAllResponses } = require('../services/ai/simulate');

const MAX_OVER_RECRUIT_MULTIPLIER = 5;
const ABSOLUTE_FLOOR_BATCH = 5;        // never generate fewer than this in a round
const RESPONSE_INSERT_CHUNK = 200;

async function runOverRecruitedSurvey({ mission, missionId }) {
  const targetQualified = mission.respondent_count || 100;
  const cap = targetQualified * MAX_OVER_RECRUIT_MULTIPLIER;

  const allPersonas = [];
  const allResponses = [];
  let totalSimulated = 0;
  let qualifiedCount = 0;
  let round = 0;
  let capHit = false;

  while (qualifiedCount < targetQualified && totalSimulated < cap) {
    round += 1;
    const remaining = targetQualified - qualifiedCount;
    const capLeft = cap - totalSimulated;

    let batchSize;
    if (round === 1) {
      batchSize = Math.min(targetQualified, capLeft);
    } else {
      const passRate = totalSimulated > 0 ? qualifiedCount / totalSimulated : 0;
      const estimate = passRate > 0
        ? Math.ceil(remaining / Math.max(0.1, passRate))
        : remaining * 2;
      batchSize = Math.max(remaining * 2, estimate);
      batchSize = Math.min(batchSize, capLeft);
      batchSize = Math.max(batchSize, Math.min(ABSOLUTE_FLOOR_BATCH, capLeft));
    }

    if (batchSize <= 0) {
      capHit = true;
      break;
    }

    logger.info('Mission run: over-recruit batch starting', {
      missionId, round, batchSize, qualifiedCount, totalSimulated, cap, targetQualified,
      passRateSoFar: totalSimulated > 0 ? Number((qualifiedCount / totalSimulated).toFixed(3)) : null,
    });

    // Generate personas for this batch.
    const personas = await generatePersonas(mission, batchSize);
    if (!personas || personas.length === 0) {
      logger.warn('Mission run: over-recruit batch generated 0 personas, breaking', {
        missionId, round, batchSize,
      });
      break;
    }

    // Simulate responses. Progress callback intentionally a no-op — per-batch
    // progress logging is enough.
    const batchResponses = await simulateAllResponses(
      personas,
      mission.questions || [],
      mission,
      () => {},
    );

    // Compute qualified count for this batch. Screened-out flag lives on
    // r.persona_profile.screened_out OR r.screened_out (set inside simulate).
    const screenedOutPersonaIds = new Set(
      batchResponses
        .filter(r => Boolean((r.persona_profile || {}).screened_out) || r.screened_out === true)
        .map(r => r.persona_id),
    );
    const personaIdsInBatch = new Set(
      personas.map(p => p.persona_id || p.id).filter(Boolean),
    );
    const personaCount = personaIdsInBatch.size || personas.length;
    const qualifiedInBatch = Math.max(0, personaCount - screenedOutPersonaIds.size);

    // Persist responses incrementally (resumable on crash).
    const rows = batchResponses.map(r => ({
      mission_id:      missionId,
      persona_id:      r.persona_id,
      persona_profile: r.persona_profile,
      question_id:     r.question_id,
      answer:          r.answer,
      screened_out:    Boolean((r.persona_profile || {}).screened_out),
    }));
    for (let i = 0; i < rows.length; i += RESPONSE_INSERT_CHUNK) {
      const { error: insErr } = await supabase
        .from('mission_responses')
        .insert(rows.slice(i, i + RESPONSE_INSERT_CHUNK));
      if (insErr) {
        logger.warn('Mission run: over-recruit responses insert chunk failed', {
          missionId, round, err: insErr,
        });
      }
    }

    // 4b. Pass 22 Bug 22.14 reasoning capture — persist for missions ≤ 50
    // total personas across all rounds. Once we cross 50 we stop persisting
    // reasoning rows so cost stays bounded.
    if ((allPersonas.length + personas.length) <= 50) {
      const reasoningRows = batchResponses
        .filter(r => r.reasoning && typeof r.reasoning === 'string' && r.reasoning.trim().length > 0)
        .map(r => ({
          mission_id:     missionId,
          persona_id:     r.persona_id,
          question_id:    r.question_id,
          response_value: Array.isArray(r.answer)
            ? r.answer.join(', ')
            : (r.answer == null ? null : String(r.answer)),
          reasoning_text: r.reasoning.trim().slice(0, 1000),
        }));
      for (let i = 0; i < reasoningRows.length; i += RESPONSE_INSERT_CHUNK) {
        const { error: rErr } = await supabase
          .from('persona_response_reasoning')
          .insert(reasoningRows.slice(i, i + RESPONSE_INSERT_CHUNK));
        if (rErr) {
          logger.warn('Mission run: over-recruit reasoning insert chunk failed', {
            missionId, round, err: rErr,
          });
        }
      }
    }

    allPersonas.push(...personas);
    allResponses.push(...batchResponses);
    totalSimulated += personaCount;
    qualifiedCount += qualifiedInBatch;

    logger.info('Mission run: over-recruit batch done', {
      missionId, round, batchSize, qualifiedInBatch,
      totalSimulated, qualifiedCount, targetQualified, cap,
    });
  }

  capHit = capHit || (qualifiedCount < targetQualified && totalSimulated >= cap);

  logger.info('Mission run: over-recruit loop complete', {
    missionId, rounds: round, totalSimulated, qualifiedCount, targetQualified, cap, capHit,
  });

  return {
    personas: allPersonas,
    responses: allResponses,
    totalSimulated,
    qualifiedCount,
    rounds: round,
    capHit,
  };
}

module.exports = {
  runOverRecruitedSurvey,
  MAX_OVER_RECRUIT_MULTIPLIER,
};
