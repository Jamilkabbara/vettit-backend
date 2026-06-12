/**
 * Pass 42 A2 — recruit-until-qualified loop with 70% margin ceiling.
 *
 * Replaces the batch flow (generate N personas → simulate all → apply
 * screening → retry rounds) with a streaming loop:
 *
 *   while qualifiedCount < target_qualified_count AND ai_spend < ceiling:
 *     generate 1 persona
 *     simulate all survey questions for that persona
 *     if screened-out: discard responses, increment recruited_count, loop
 *     if qualified: persist responses, increment qualifiedCount + recruited_count
 *
 * Why streaming instead of batch:
 *   1. We need precise screener-pass-rate semantics. A customer who
 *      paid for 10 qualified completes gets exactly 10 (or fewer if
 *      the ceiling is hit). Batch flow could over-generate.
 *   2. The 70% margin floor is per-mission, not per-batch. Streaming
 *      lets us check ai_spend_usd_actual against ai_spend_ceiling_usd
 *      between every persona; batch flow could over-run by a whole
 *      batch's worth of cost before noticing.
 *   3. The customer-facing progress UI ("8 of 10 qualified, 47 personas
 *      generated") needs a steady incrementing stream, not bursty
 *      batch updates.
 *
 * Policy: NO REFUNDS. When ceiling_hit terminates the loop, the
 * mission still runs synthesis on whatever qualified, sets status=
 * completed, and the customer sees "X of Y qualified — strict
 * screener" honest copy. The customer agreed to this at checkout
 * (Pass 42 G4 microcopy).
 *
 * Wiring: runMission.js calls runRecruitmentLoop(mission) when
 * RECRUIT_LOOP_ENABLED=true is set in env. Otherwise falls through
 * to the existing batch flow. Once the loop is validated in
 * production (Pass 42 A5 tests + a few real paid runs), the env
 * gate can be removed in Pass 43.
 */

const logger = require('../../utils/logger');
const { generatePersonas } = require('./personas');
const { simulateResponses, passesScreening } = require('./simulate');
const { updateMission } = require('../../db/missionSchema');

/**
 * Returns true if the env flag is set and the mission has the
 * Pass 42 columns populated. Pass 42 A1 backfill sets these for
 * existing missions, so this is purely an env gate.
 */
function shouldUseRecruitLoop(mission) {
  if (process.env.RECRUIT_LOOP_ENABLED !== 'true') return false;
  if (!mission?.target_qualified_count) return false;
  if (!mission?.ai_spend_ceiling_usd) return false;
  // Creative attention has no respondents-per-mission semantics.
  if (mission.goal_type === 'creative_attention') return false;
  return true;
}

/**
 * Conservative estimate of the marginal cost of running a full
 * survey for one persona. Used pre-emptively to avoid breaching the
 * ceiling on the *next* call. Sourced from Pass 27 vendor cost
 * audit p95 + 50% headroom.
 */
const ESTIMATED_FULL_SURVEY_COST_USD = 0.15;

/**
 * Hard cap on iterations regardless of ceiling. Prevents runaway
 * loops if both `target_qualified_count` is large and the ceiling
 * is somehow not enforcing (env misconfiguration, etc.). Equal to
 * "20 personas per qualified-target" — at 5% screener pass rate
 * we'd need 20 personas to qualify 1, so this allows the worst
 * realistic case before bailing.
 */
const MAX_PERSONAS_PER_TARGET = 20;

/**
 * Throttle progress writes. Writing recruited_persona_count after
 * every persona would hammer Supabase. Write every N personas, plus
 * once on terminal state.
 */
const PROGRESS_WRITE_EVERY_N = 5;

/**
 * Main entry. Returns the flat array of `{persona_id, persona_profile,
 * question_id, answer, reasoning}` for downstream insertion +
 * synthesis. Mutates the mission's recruitment_status field along
 * the way.
 */
async function runRecruitmentLoop(mission, supabase) {
  const missionId = mission.id;
  const target  = Number(mission.target_qualified_count);
  const ceiling = Number(mission.ai_spend_ceiling_usd);
  const maxPersonas = target * MAX_PERSONAS_PER_TARGET;

  logger.info('Recruitment loop: starting', {
    missionId,
    target,
    ceilingUsd: ceiling,
    maxPersonas,
    goalType: mission.goal_type,
  });

  await updateMission(supabase, missionId, {
    recruitment_status: 'recruiting',
    recruited_persona_count: 0,
    ai_spend_usd_actual: 0,
  }, { caller: 'recruitLoop: start' });

  const qualifiedResponses = []; // flat list, persona × question
  const qualifiedPersonas  = []; // persona objects, for downstream exposure tagging
  let recruitedCount = 0;
  let qualifiedCount = 0;
  // Pass 44 P0 — track WHY the loop exited so the terminal status is
  // honest. Pre-Pass-44, every non-target exit was labeled
  // 'ceiling_hit', including transient persona-gen failures (429s),
  // which produced partial deliveries blamed on "strict screener" at
  // 3% budget spend.
  let breakReason = null; // 'ceiling' | 'max_personas' | 'persona_gen_failed' | 'persona_gen_empty'

  while (qualifiedCount < target) {
    // ── Hard guard against runaway loops ───────────────────────────────
    if (recruitedCount >= maxPersonas) {
      logger.warn('Recruitment loop: max-personas guard tripped', {
        missionId, recruitedCount, qualifiedCount, target, maxPersonas,
      });
      breakReason = 'max_personas';
      break;
    }

    // ── Re-read mission for fresh ai_spend_usd_actual ──────────────────
    // The cost telemetry in anthropic.js updates the column via RPC
    // out-of-band; we re-read after every persona so the ceiling
    // check is honest. Single-row read on a UUID PK is cheap.
    const { data: fresh, error: readErr } = await supabase
      .from('missions')
      .select('ai_spend_usd_actual')
      .eq('id', missionId)
      .single();
    if (readErr) {
      logger.warn('Recruitment loop: failed to re-read ai_spend_usd_actual', {
        missionId, err: readErr.message,
      });
    }
    const spentUsd = Number(fresh?.ai_spend_usd_actual ?? 0);

    // ── Ceiling check #1: hard cap on accumulated spend ────────────────
    if (spentUsd >= ceiling) {
      logger.info('Recruitment loop: ceiling reached (post-spend)', {
        missionId, spentUsd, ceiling, recruitedCount, qualifiedCount,
      });
      breakReason = 'ceiling';
      break;
    }

    // ── Ceiling check #2: pre-emptive on next persona's worst-case cost
    // (persona gen + full survey). If even the next persona's worst-
    // case cost would breach, exit now without paying for a wasted
    // persona that we'd discard if it qualified.
    const worstCaseNext = spentUsd + ESTIMATED_FULL_SURVEY_COST_USD;
    if (worstCaseNext > ceiling && qualifiedCount > 0) {
      logger.info('Recruitment loop: ceiling reached (pre-emptive)', {
        missionId, spentUsd, worstCaseNext, ceiling,
        recruitedCount, qualifiedCount,
      });
      breakReason = 'ceiling';
      break;
    }

    // ── Generate ONE persona (with transient-failure retries) ──────────
    // generatePersonas() is batch-friendly internally but caps at the
    // requested count via .slice(0, count) so requesting 1 returns 1.
    //
    // Pass 44 P0 — retry with backoff instead of breaking on the first
    // failure. Forensics: 10 concurrent test missions hit Anthropic
    // rate limits; the old code broke the loop on the first 429 and
    // the terminal block mislabeled the exit 'ceiling_hit' at ~$0.06
    // spend vs a $2.70 ceiling. Customers got partial deliveries
    // (2/5) implicitly blamed on screener strictness when the cause
    // was OUR transient infra failure — unacceptable with NO REFUNDS.
    let personaBatch = null;
    for (let attempt = 0; attempt < 3 && !personaBatch; attempt += 1) {
      try {
        personaBatch = await generatePersonas(mission, 1, {
          startOffset: recruitedCount,
        });
      } catch (err) {
        const delayMs = [2000, 8000, 20000][attempt];
        logger.warn('Recruitment loop: persona generation failed (will retry)', {
          missionId, err: err.message, recruitedCount, attempt: attempt + 1, delayMs,
        });
        if (attempt < 2) await new Promise((r) => setTimeout(r, delayMs));
      }
    }
    if (!personaBatch) {
      logger.error('Recruitment loop: persona generation failed after 3 attempts', {
        missionId, recruitedCount, qualifiedCount,
      });
      breakReason = 'persona_gen_failed';
      break;
    }
    const persona = personaBatch[0];
    if (!persona) {
      logger.warn('Recruitment loop: persona generation returned empty', {
        missionId, recruitedCount,
      });
      breakReason = 'persona_gen_empty';
      break;
    }
    recruitedCount += 1;

    // ── Run the full survey for this persona ───────────────────────────
    // We don't separately run "screener only first" — simulateResponses
    // returns answers for all questions, then we check screening inline.
    // The cost of running the full survey on a screen-fail persona
    // is real but bounded by the ceiling check above. A separate
    // screener-only path is a Pass 43+ optimization.
    let responses;
    try {
      responses = await simulateResponses(persona, mission.questions || [], mission);
    } catch (err) {
      logger.warn('Recruitment loop: survey simulation failed; counting persona as wasted', {
        missionId, err: err.message, personaIndex: recruitedCount,
      });
      continue; // try the next persona
    }

    // ── Apply screening: walk responses in order, stop at first screen-fail
    const questionById = Object.fromEntries(
      (mission.questions || []).map((q) => [q.id, q]),
    );
    let screenedOut = false;
    const keptResponses = [];
    for (const r of responses) {
      const q = questionById[r.question_id];
      if (!screenedOut) {
        keptResponses.push(r);
        if (q && q.isScreening && !passesScreening(q, r.answer)) {
          screenedOut = true;
        }
      }
    }

    if (screenedOut) {
      logger.debug('Recruitment loop: persona screened out', {
        missionId, personaIndex: recruitedCount, qualifiedCount,
      });
      // Throttled progress write so the customer sees recruitment activity
      // even when nobody is qualifying.
      if (recruitedCount % PROGRESS_WRITE_EVERY_N === 0) {
        await writeProgress(supabase, missionId, {
          recruited_persona_count: recruitedCount,
        });
      }
      continue;
    }

    // ── Qualified! Capture responses + bump counts ─────────────────────
    qualifiedPersonas.push(persona);
    for (const r of keptResponses) {
      qualifiedResponses.push({
        persona_id:      persona.id,
        persona_profile: persona,
        question_id:     r.question_id,
        answer:          r.answer,
        reasoning:       typeof r.reasoning === 'string' ? r.reasoning : null,
      });
    }
    qualifiedCount += 1;

    // Always write progress on qualified-count change so the customer
    // UI ticks up live.
    await writeProgress(supabase, missionId, {
      recruited_persona_count: recruitedCount,
    });
  }

  // ── Terminal state ───────────────────────────────────────────────────
  // Pass 44 P0 — the status enum is {pending|recruiting|ceiling_hit|
  // target_hit} (schema CHECK), so non-target exits still record
  // 'ceiling_hit'. But when the exit was NOT a genuine ceiling trip
  // (transient persona-gen failure, empty batch, max-personas guard),
  // we now raise an admin alert so ops can re-run the mission for the
  // customer instead of the shortfall silently masquerading as a
  // strict-screener partial. NO REFUNDS makes this distinction a
  // customer-trust requirement, not a nicety.
  const reachedTarget = qualifiedCount >= target;
  const terminalStatus = reachedTarget ? 'target_hit' : 'ceiling_hit';
  await updateMission(supabase, missionId, {
    recruitment_status: terminalStatus,
    recruited_persona_count: recruitedCount,
    recruitment_completed_at: new Date().toISOString(),
  }, { caller: `recruitLoop: terminal=${terminalStatus}` });

  if (!reachedTarget && breakReason && breakReason !== 'ceiling') {
    try {
      await supabase.from('admin_alerts').insert({
        alert_type: 'recruitment_infra_partial',
        mission_id: missionId,
        user_id:    mission.user_id,
        payload: {
          break_reason:    breakReason,
          qualified_count: qualifiedCount,
          target,
          recruited_count: recruitedCount,
          action_required: 'Partial delivery caused by infra (NOT screener, NOT budget). Re-run the mission for the customer — no refund per policy, re-delivery is the remedy.',
        },
        resolved: false,
      });
    } catch (alertErr) {
      logger.warn('Recruitment loop: infra-partial alert insert failed (non-fatal)', {
        missionId, err: alertErr.message,
      });
    }
  }

  logger.info('Recruitment loop: exit', {
    missionId, qualifiedCount, target, recruitedCount,
    terminalStatus, breakReason, partial: !reachedTarget,
  });

  return {
    responses: qualifiedResponses,
    personas: qualifiedPersonas,
    recruitedCount,
    qualifiedCount,
    terminalStatus,
    partial: !reachedTarget,
  };
}

/**
 * Throttled progress writer. Single-column UPDATE on a UUID PK is
 * cheap but spamming it on every iteration would still produce
 * thousands of writes per minute for a strict-screener mission.
 */
async function writeProgress(supabase, missionId, patch) {
  try {
    await supabase
      .from('missions')
      .update(patch)
      .eq('id', missionId);
  } catch (err) {
    logger.warn('Recruitment loop: progress write failed (non-fatal)', {
      missionId, err: err.message,
    });
  }
}

module.exports = {
  runRecruitmentLoop,
  shouldUseRecruitLoop,
  // exported for tests
  ESTIMATED_FULL_SURVEY_COST_USD,
  MAX_PERSONAS_PER_TARGET,
};
