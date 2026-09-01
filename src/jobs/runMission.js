/**
 * VETT — Mission Run Job (the critical path).
 * Triggered by Stripe payment_intent.succeeded webhook.
 *
 * Flow (Pass 23 Bug 23.25 v2 — constraint-based always-deliver):
 *   1. Generate exactly N personas with screener criteria baked into the
 *      generation prompt — every persona is generated TO the spec, not
 *      filtered against it. The prior over-recruit loop (5x cap +
 *      adaptive batch sizing + partial-delivery refund branch) is gone.
 *   2. Simulate responses for the N personas. Screening still runs
 *      defensively in simulate.js as a belt-and-suspenders check.
 *   3. If any personas got flagged screened_out (constraint violation —
 *      shouldn't happen but model errors are real), generate
 *      replacements with stricter prompts. Single retry round, capped
 *      at 3x the violation count for safety.
 *   4. Synthesize insights, persist responses, mark complete with
 *      delivery_status='full'.
 *
 * Promise of purchase: "you set the number, we deliver it" — period.
 * No partial refunds, no admin alerts for partial delivery, no fallback.
 * The historic 4 partial-delivery missions stay labeled as 'partial' for
 * audit-trail accuracy; refunds were issued at the time.
 */

const supabase = require('../db/supabase');
const logger = require('../utils/logger');
const { generatePersonas } = require('../services/ai/personas');
const { simulateAllResponses } = require('../services/ai/simulate');
const { normalizeAnswerForStorage } = require('../utils/answerValue');
const { synthesizeInsights, aggregate } = require('../services/ai/insights');
const { buildSimMeta } = require('../services/ai/simMeta');
const { generateTargetingBrief } = require('../services/ai/targetingBrief');
const { analyzeCreative }       = require('../services/ai/creativeAttention');
const {
  updateMission,
  isHeartbeatColumnMissing,
  noteHeartbeatColumnMissing,
} = require('../db/missionSchema');
// Pass 42 A2 — recruit-until-qualified loop (env-gated). When
// RECRUIT_LOOP_ENABLED=true the new flow replaces the batch
// generate+simulate+retry path with a streaming per-persona loop
// that respects the 70% margin ceiling.
const { runRecruitmentLoop, shouldUseRecruitLoop } = require('../services/ai/recruitLoop');
// Pass 48 — idempotent mission_responses persistence (duplicate-run guard).
const { persistResponseRows, persistReasoningRows } = require('../services/ai/persistResponses');
// Pass 46 Phase 2 — empty-survey guard (audit P0-5).
const { ensureMissionQuestions } = require('../services/ai/ensureQuestions');
// Pass 46 Phase 3 — deterministic methodology analysis.
const { computeAnalysis } = require('../services/analysis');
const emailService = require('../services/email');

// Pass 23 Bug 23.12 — notification copy templates. Truncate long mission
// titles so the body stays scannable in the bell dropdown (max ~80 chars
// per spec).
function truncateTitle(title, max = 60) {
  const t = (title || '').trim();
  if (!t) return 'Your VETT mission';
  return t.length > max ? `${t.slice(0, max - 3)}...` : t;
}

// Chunk size for the bulk inserts now lives in persistResponses.js
// (INSERT_CHUNK); both write paths route through that helper.

/**
 * Pass 23 Bug 23.25 v2 — defensive constraint-violation retry.
 * Maximum number of retry rounds for any personas that got flagged
 * screened_out after constraint-based generation. The retry budget is
 * capped at 3× the violation count from the prior round so an
 * impossibly tight screener can't burn unbounded AI tokens.
 */
const MAX_VIOLATION_RETRY_ROUNDS = 1;

async function runMission(missionId, opts = {}) {
  // Pass 46 Phase 2 — resume mode (audit P1-3). The boot-time sweep in
  // missionRecovery re-enters missions stranded in status='processing'
  // by a process restart. Resume bypasses the idempotency skip + claim
  // (the mission is legitimately already claimed) and the recruit loop
  // reconstructs its state from the incrementally-persisted rows.
  const resume = opts.resume === true;
  logger.info('Mission run: starting', { missionId, resume });

  // 1. Fetch mission
  const { data: mission, error } = await supabase
    .from('missions')
    .select('*')
    .eq('id', missionId)
    .single();

  if (error || !mission) {
    logger.error('Mission run: not found', { missionId, error });
    return;
  }

  // ─── Idempotency guard ────────────────────────────────────────────────────
  // Both /api/payments/confirm and the payment_intent.succeeded webhook set
  // status='paid' before calling runMission(). Without this guard, a race
  // between the two paths (or two rapid webhook deliveries) would trigger
  // duplicate AI synthesis jobs, doubling cost for the same mission.
  const SKIP_STATUSES = ['processing', 'completed', 'failed'];
  if (SKIP_STATUSES.includes(mission.status) && !(resume && mission.status === 'processing')) {
    logger.info('Mission run: idempotency skip', { missionId, status: mission.status });
    return { skipped: true, reason: `already ${mission.status}` };
  }

  if (resume && mission.status === 'processing') {
    logger.warn('Mission run: RESUMING stranded processing mission', {
      missionId, started_at: mission.started_at,
    });
  } else {
    const { data: claimed, error: claimError } = await supabase
      .from('missions')
      .update({ status: 'processing', started_at: new Date().toISOString() })
      .eq('id', missionId)
      .eq('status', 'paid')
      .select('id');

    if (claimError || !claimed || claimed.length === 0) {
      logger.info('Mission run: idempotency claim lost', { missionId, claimError });
      return { skipped: true, reason: 'claim failed — another worker got it' };
    }
  }

  // ─── Pass 49 heartbeat ────────────────────────────────────────────────────
  // Stamped immediately after the claim (or the resume), so a live run is
  // NEVER sitting on a NULL heartbeat_at. That matters because the reapers
  // treat NULL as "this run never checked in" and fall back to the
  // pre-Pass-49 started_at thresholds; getting the first stamp down here
  // means the fallback only ever applies to rows that predate the deploy or
  // to runs that died before reaching this line.
  //
  // Deliberately NOT folded into the atomic claim above: that write is
  // load-bearing for idempotency, and a column that does not exist yet
  // (the migration is applied by hand) would turn a lost heartbeat into a
  // lost claim.
  const stampHeartbeat = async () => {
    if (isHeartbeatColumnMissing()) return;
    try {
      const { error } = await supabase
        .from('missions')
        .update({ heartbeat_at: new Date().toISOString() })
        .eq('id', missionId)
        // Only a run that still owns the mission may refresh its liveness.
        // Without this a zombie would keep the row looking alive, which is
        // the precise opposite of what the column is for.
        .eq('status', 'processing');
      if (error && !noteHeartbeatColumnMissing(error, 'runMission: stampHeartbeat')) {
        logger.warn('Mission run: heartbeat write failed (non-fatal)', {
          missionId, err: error.message, code: error.code,
        });
      }
    } catch (e) {
      logger.warn('Mission run: heartbeat write threw (non-fatal)', {
        missionId, err: e?.message,
      });
    }
  };
  await stampHeartbeat();

  try {
    // ─── Creative Attention bypass ──────────────────────────────────────────
    if (mission.goal_type === 'creative_attention') {
      // Resurrection track — persist the failure reason. Two PAID creative
      // runs failed leaving mission_assets:[] with no error, so the cause was
      // undiagnosable (a dead creative URL / unreadable image surfaces as a
      // bare "400 invalid_request"). Capture the stage + message before the
      // outer handler marks the mission failed.
      try {
        await analyzeCreative({ mission });
      } catch (caErr) {
        logger.error('Mission run: creative analysis failed', { missionId, err: caErr.message });
        try {
          const { data: existing } = await supabase
            .from('missions').select('mission_assets').eq('id', missionId).single();
          const prev = (existing && existing.mission_assets && !Array.isArray(existing.mission_assets))
            ? existing.mission_assets : {};
          await supabase.from('missions').update({
            mission_assets: { ...prev, analysis_error: { stage: 'creative_attention', message: caErr.message, ts: new Date().toISOString() } },
          }).eq('id', missionId);
        } catch (persistErr) {
          logger.warn('Mission run: failed to persist creative_attention error', { missionId, err: persistErr.message });
        }
        throw caErr; // outer handler marks the mission failed
      }
      logger.info('Mission run: creative analysis complete', { missionId });

      // Notification — Bug 23.12 templated copy. Bug 23.50 fix: use the
      // canonical await + destructure pattern instead of bare .insert(...).catch.
      try {
        const { error: notifErr } = await supabase
          .from('notifications')
          .insert({
            user_id: mission.user_id,
            type:    'mission_complete',
            title:   'Mission complete',
            body:    `Your "${truncateTitle(mission.title)}" creative analysis is ready.`,
            link:    `/creative-results/${missionId}`,
          });
        if (notifErr) {
          logger.warn('Mission run: creative_attention notification insert failed', {
            missionId, err: notifErr.message,
          });
        }
      } catch (notifThrow) {
        logger.warn('Mission run: creative_attention notification insert threw', {
          missionId, err: notifThrow.message,
        });
      }

      return;
    }

    // ─── Survey path — Pass 23 Bug 23.25 v2 constraint-based generation ────

    // Pass 46 Phase 2 — empty-survey guard (audit P0-5). A paid pipeline
    // must NEVER run an empty survey: generate questions at run time
    // (same generator as the UI) or fail the mission honestly.
    if (!Array.isArray(mission.questions) || mission.questions.length === 0) {
      try {
        mission.questions = await ensureMissionQuestions(supabase, mission);
      } catch (qErr) {
        logger.error('Mission run: empty-survey guard tripped — failing mission', {
          missionId, err: qErr.message,
        });
        await updateMission(supabase, missionId, {
          status:         'failed',
          failure_reason: `Mission has no survey questions and run-time generation failed: ${qErr.message}`,
          completed_at:   new Date().toISOString(),
        }, { caller: 'runMission: empty-survey guard' });
        try {
          await supabase.from('admin_alerts').insert({
            alert_type: 'empty_survey_blocked',
            mission_id: missionId,
            user_id:    mission.user_id,
            payload:    { error: qErr.message, goal_type: mission.goal_type },
            resolved:   false,
          });
        } catch (alertErr) {
          logger.warn('Mission run: empty_survey_blocked alert insert failed', {
            missionId, err: alertErr.message,
          });
        }
        return { failed: true, reason: 'empty_survey_blocked' };
      }
    }

    const targetCount = mission.respondent_count || 100;

    // Pass 42 A2 — env-gated streaming recruitment loop. When
    // RECRUIT_LOOP_ENABLED=true and the mission has the Pass 42 A1
    // columns populated (target_qualified_count + ai_spend_ceiling_usd),
    // the new flow runs persona-by-persona until target qualified
    // reached OR the 70% margin ceiling is hit. Otherwise, falls
    // through to the legacy batch flow below.
    let personas;
    let responses;
    let recruitmentPartial = false;
    // Batch-path fault tolerance — simulateAllResponses no longer lets a
    // single failed Anthropic call (one 429 / 529 / timeout) reject the
    // whole wave and fail a PAID mission. It drops the personas it could
    // not simulate and reports them here, so the shortfall reaches the
    // persisted counters instead of being silently rounded back up to the
    // paid-for target. Null on the recruit-loop path (the loop has always
    // had its own per-persona catch).
    let simFailureReport = null;
    // Pass 45 T2a — carry the loop's REAL counters to completion.
    // Pre-Pass-45, completion hardcoded qualified_respondent_count =
    // targetCount (Pass 23 always-deliver), which produced impossible
    // rows like recruited=2 / qualified=5 on partial missions.
    let loopQualifiedCount = null;
    let loopRecruitedCount = null;
    // Pass 46 Phase 2 — the recruit loop persists qualified rows
    // incrementally (resume support); the completion insert below must
    // not duplicate them. Legacy batch path keeps the bulk insert.
    let responsesAlreadyPersisted = false;
    let unpersistedLoopResponses = [];
    if (shouldUseRecruitLoop(mission)) {
      logger.info('Mission run: using Pass 42 A2 recruit loop', {
        missionId,
        target: mission.target_qualified_count,
        ceilingUsd: mission.ai_spend_ceiling_usd,
      });
      const loopResult = await runRecruitmentLoop(mission, supabase);

      // Pass 49 — the loop noticed mid-run that this mission left
      // 'processing'. Stop here: synthesis, persistence and the terminal
      // write would all be work on a row somebody else owns, and the
      // scoped write (PR 1) would no-op anyway. Return rather than throw —
      // a throw would reach the fatal handler and try to stamp 'failed'
      // over the other writer's terminal state.
      if (loopResult.claimRevoked) {
        logger.error('Mission run: loop path aborted — claim revoked mid-run', {
          missionId,
          qualified: loopResult.qualifiedCount,
          recruited: loopResult.recruitedCount,
        });
        return {
          aborted: true,
          reason: 'claim revoked mid-run',
          qualified: loopResult.qualifiedCount,
          recruited: loopResult.recruitedCount,
        };
      }

      personas  = loopResult.personas;
      responses = loopResult.responses;
      recruitmentPartial = loopResult.partial;
      loopQualifiedCount = loopResult.qualifiedCount;
      loopRecruitedCount = loopResult.recruitedCount;
      responsesAlreadyPersisted = loopResult.responsesAlreadyPersisted === true;
      unpersistedLoopResponses  = loopResult.unpersistedResponses || [];
      // Pass 46 Phase 2 — exposure is now tagged INSIDE the loop BEFORE
      // simulation (the old post-loop split here tagged personas AFTER
      // their answers were simulated, so simulate.js never saw
      // _exposure_status and loop-path brand_lift missions had no real
      // lift signal). Keep a fill-only-missing pass purely as a belt
      // for personas that somehow arrive untagged.
      if (mission.goal_type === 'brand_lift' && personas.length > 0) {
        personas = personas.map((p, i) => (
          p._exposure_status ? p : { ...p, _exposure_status: i % 2 === 0 ? 'exposed' : 'control' }
        ));
      }
    } else {
      // ── Legacy batch flow (pre-Pass-42 behaviour) ──────────────────────
      // Round 1: generate exactly N with screener constraints baked in.
      personas = await generatePersonas(mission, targetCount);

    // Pass 27 — Brand Lift incrementality. Split ~50/50 exposed vs control
    // and tag each persona so the simulator prompt can shift answers
    // realistically (exposed: lifted aided recall, awareness, message
    // association; control: baseline). Other goal types stay
    // 'not_applicable'.
    if (mission.goal_type === 'brand_lift') {
      const exposedCount = Math.ceil(personas.length / 2);
      personas = personas.map((p, i) => ({
        ...p,
        _exposure_status: i < exposedCount ? 'exposed' : 'control',
      }));
      logger.info('Mission run: brand_lift exposure split', {
        missionId, exposed: exposedCount, control: personas.length - exposedCount,
      });
    }
    // ── Pass 49 mid-run kill switch (legacy batch path) ───────────────────
    // The recruit loop gets this for free: it already re-reads the mission
    // every iteration for ai_spend_usd_actual, so `status` rides along on
    // an existing query. The batch path has no such read, so it does a
    // THROTTLED one — the same every-25-personas cadence the progress log
    // already uses. At the measured batch rate (~2.2s per persona) that is
    // roughly one extra single-row read per minute of simulation, ~40 reads
    // across a 1000-respondent run.
    //
    // The read is fired from onProgress and its result is latched into
    // `batchClaimRevoked`; shouldAbort (checked at each concurrency wave
    // boundary) just reads the latch, so no wave ever blocks on a query.
    let batchClaimRevoked = false;
    let claimCheckInFlight = false;
    const checkClaimStillOurs = async () => {
      if (claimCheckInFlight || batchClaimRevoked) return;
      claimCheckInFlight = true;
      try {
        const { data: cur, error: curErr } = await supabase
          .from('missions').select('status').eq('id', missionId).single();
        // A transient read error must never look like a revoked claim.
        if (!curErr && cur && cur.status !== 'processing') {
          batchClaimRevoked = true;
          logger.error('Mission run: ABORTING simulation — mission is no longer processing; our claim was revoked', {
            missionId, observedStatus: cur.status,
          });
        }
      } catch (e) {
        logger.warn('Mission run: mid-run claim check failed (non-fatal, continuing)', {
          missionId, err: e?.message,
        });
      } finally {
        claimCheckInFlight = false;
      }
    };

    const simResult = await simulateAllResponses(
      personas,
      mission.questions || [],
      mission,
      (completed, total) => {
        if (completed % 25 === 0) {
          logger.info('Mission run: progress', { missionId, completed, total });
          // Fire-and-forget: onProgress is synchronous and called from
          // inside a wave, so awaiting here would serialise the simulation.
          checkClaimStillOurs();
          // Pass 49 — the batch path's heartbeat. The recruit loop gets one
          // per persona for free (writeProgress already updates missions);
          // this path has no per-persona write, so it rides the same
          // every-25 throttle as the progress log: roughly 40 writes across
          // a 1000-respondent run, ~55s apart at the measured batch rate of
          // ~2.2s per persona. Comfortably inside the 15-minute threshold.
          stampHeartbeat();
        }
      },
      { shouldAbort: () => batchClaimRevoked },
    );
    responses = simResult.responses;

    // ── HONEST COUNTERS ───────────────────────────────────────────────
    // Every delivery column downstream is derived from `personas.length`
    // (totalSimulated → qualified_respondent_count cap →
    // qualification_rate → recruited_persona_count). If we leave the
    // personas we FAILED to simulate in that array, all four keep
    // claiming the paid-for N while only N-k respondents actually
    // exist in mission_responses — the exact "four of five delivery
    // columns still claimed 60" shape that already bit this codebase.
    // Prune here, once, so the shortfall propagates everywhere.
    if (simResult.failed > 0) {
      simFailureReport = simResult;
      const lost = new Set(simResult.failedPersonaIds);
      const beforePrune = personas.length;
      personas = personas.filter((p, i) => !lost.has(p.persona_id || p.id || `idx:${i}`));
      logger.error('Mission run: personas lost to simulation failures — counters pruned', {
        missionId,
        attempted: simResult.attempted,
        succeeded: simResult.succeeded,
        failed: simResult.failed,
        failureRatio: Number(simResult.failureRatio.toFixed(4)),
        personasBefore: beforePrune,
        personasAfter: personas.length,
        failedPersonaIds: simResult.failedPersonaIds,
      });
      // Best-effort quality signal for ops — same posture as the
      // constraint_violation alert below (never blocks the run).
      try {
        await supabase.from('admin_alerts').insert({
          alert_type: 'simulation_persona_failures',
          mission_id: missionId,
          user_id:    mission.user_id,
          payload: {
            attempted: simResult.attempted,
            succeeded: simResult.succeeded,
            failed:    simResult.failed,
            failure_ratio: Number(simResult.failureRatio.toFixed(4)),
            target_count:  targetCount,
            failures: simResult.failures.slice(0, 25),
          },
          resolved: false,
        });
      } catch (alertErr) {
        logger.warn('Mission run: simulation_persona_failures alert insert failed (non-fatal)', {
          missionId, err: alertErr.message,
        });
      }
    }

    // A revoked claim ends the batch path immediately. Falling through would
    // spend more money on synthesis for a mission we no longer own — and the
    // scoped terminal write (PR 1) would no-op anyway. Returning is a CLEAN
    // exit: no throw, so the fatal handler never gets the chance to stamp
    // 'failed' over the other writer's terminal state.
    if (batchClaimRevoked) {
      logger.error('Mission run: batch path aborted — claim revoked mid-simulation', {
        missionId, partialRows: (responses || []).length,
      });
      return { aborted: true, reason: 'claim revoked mid-run', partialRows: (responses || []).length };
    }

    // Defensive screener verification. Constraint-based generation should
    // produce 0 misses; the retry below catches the rare model error.
    const screenedOutPersonaIds = new Set(
      responses
        .filter((r) => Boolean((r.persona_profile || {}).screened_out) || r.screened_out === true)
        .map((r) => r.persona_id),
    );

    if (screenedOutPersonaIds.size > 0) {
      logger.warn('Mission run: constraint-based gen produced screened-out personas — retrying', {
        missionId, missed: screenedOutPersonaIds.size, target: targetCount,
      });
      // Best-effort admin alert for quality monitoring (no refund — this is
      // a quality signal, not a delivery failure).
      try {
        await supabase.from('admin_alerts').insert({
          alert_type: 'constraint_violation',
          mission_id: missionId,
          user_id:    mission.user_id,
          payload: {
            target_count: targetCount,
            missed_count: screenedOutPersonaIds.size,
            screener_criteria: mission.screener_criteria || null,
          },
          resolved: false,
        });
      } catch (alertErr) {
        logger.warn('Mission run: constraint_violation alert insert failed (non-fatal)', {
          missionId, err: alertErr.message,
        });
      }

      // Retry rounds — replace each missed persona with a fresh one
      // generated under the stricter prompt. Persona ids start above the
      // largest existing id so replacements don't collide.
      let retryRound = 0;
      while (screenedOutPersonaIds.size > 0 && retryRound < MAX_VIOLATION_RETRY_ROUNDS) {
        retryRound += 1;
        const replacementCount = screenedOutPersonaIds.size;
        // Pass 49 — startOffset is a HINT the model can ignore (ids are
        // model-assigned; see personas.js). Pass the ids we already hold so
        // generatePersonas can drop a collision and top up, rather than
        // handing simulate two different people under one persona_id.
        const heldPersonaIds = new Set(
          personas.map((p) => p && (p.persona_id || p.id)).filter(Boolean).map(String),
        );
        const replacementPersonas = await generatePersonas(
          mission,
          replacementCount,
          {
            stricter: true,
            startOffset: personas.length + retryRound * 1000,
            excludeIds: heldPersonaIds,
          },
        );
        // Replacements are already a best-effort top-up; a persona we
        // cannot simulate here simply doesn't become a replacement.
        const replacementSim = await simulateAllResponses(
          replacementPersonas,
          mission.questions || [],
          mission,
          () => {},
          // Tiny batch: one loss out of two replacements is 50% by
          // arithmetic. The ceiling must not fail a mission whose main
          // batch is healthy just because a top-up persona blipped.
          { enforceFailureCeiling: false },
        );
        const replacementResponses = replacementSim.responses;
        if (replacementSim.failed > 0) {
          logger.warn('Mission run: replacement personas lost to simulation failures', {
            missionId,
            round: retryRound,
            failed: replacementSim.failed,
            attempted: replacementSim.attempted,
          });
        }

        // Pick which replacements qualified.
        const replacementScreenedOut = new Set(
          replacementResponses
            .filter((r) => Boolean((r.persona_profile || {}).screened_out) || r.screened_out === true)
            .map((r) => r.persona_id),
        );
        const goodReplacementIds = new Set(
          replacementPersonas
            .map((p) => p.persona_id || p.id)
            .filter((pid) => pid && !replacementScreenedOut.has(pid)),
        );

        // Slot the qualifying replacements in for the screened-out originals.
        const personasToSwap = Array.from(screenedOutPersonaIds).slice(0, goodReplacementIds.size);
        for (const swappedId of personasToSwap) {
          screenedOutPersonaIds.delete(swappedId);
        }
        // Keep all responses (originals minus swapped + qualifying replacements)
        // for downstream insights — screening filter happens during the final
        // qualified-count computation below.
        const replacementGoodResponses = replacementResponses.filter(
          (r) => goodReplacementIds.has(r.persona_id),
        );
        // Drop original responses for personas we've swapped out.
        responses = responses
          .filter((r) => !personasToSwap.includes(r.persona_id))
          .concat(replacementGoodResponses);
        personas = personas
          .filter((p) => !personasToSwap.includes(p.persona_id || p.id))
          .concat(replacementPersonas.filter((p) => goodReplacementIds.has(p.persona_id || p.id)));
      }
      logger.info('Mission run: retry rounds complete', {
        missionId, residualMisses: screenedOutPersonaIds.size, rounds: retryRound,
      });
    }
    } // close Pass 42 A2 `else` (legacy batch flow)

    // Pass 27 — propagate exposure_status from persona to its responses
    // for brand_lift missions. Lookup map is small (≤ targetCount) so a
    // plain object is fine.
    const exposureByPersonaId = {};
    for (const p of personas) {
      const pid = p.persona_id || p.id;
      if (pid && p._exposure_status) exposureByPersonaId[pid] = p._exposure_status;
    }

    // Persist responses (chunked).
    // Pass 46 Phase 2 — loop path already wrote each qualified persona's
    // rows incrementally; only rows whose incremental insert failed get
    // a second chance here. Legacy batch path inserts everything.
    const rowsSource = responsesAlreadyPersisted ? unpersistedLoopResponses : responses;
    const rows = rowsSource.map((r) => ({
      mission_id:      missionId,
      persona_id:      r.persona_id,
      persona_profile: r.persona_profile,
      question_id:     r.question_id,
      // Never store SQL null against the NOT NULL JSONB column — a skip
      // (not_applicable) is stored as the sentinel string, not null.
      answer:          normalizeAnswerForStorage(r.answer),
      screened_out:    Boolean((r.persona_profile || {}).screened_out),
      exposure_status: exposureByPersonaId[r.persona_id] || 'not_applicable',
    }));
    //
    // Pass 48 — IDEMPOTENT. The old code here was an unconditional
    // chunked insert, and it is what put 785 duplicate rows across 3
    // production missions: runMission is re-enterable with {resume:true}
    // (the claim guard above is deliberately bypassed for resume, and
    // missionRecovery Job 3 re-enters every status='processing' mission),
    // so a second invocation regenerated and re-inserted the ENTIRE
    // dataset. Because the second copy came from an independent
    // generate+simulate run, the same persona_id carried a different
    // profile and different answers — corrupting distributions, not just
    // doubling counts. persistResponseRows skips keys already stored and
    // uses ON CONFLICT DO NOTHING once the pass-48 unique index is live.
    const persistResult = await persistResponseRows(supabase, missionId, rows, {
      caller: 'runMission: completion insert',
    });
    const responsePersistError = persistResult.error;
    if (persistResult.skipped > 0) {
      logger.warn('Mission run: skipped already-persisted response rows (duplicate run detected)', {
        missionId,
        attempted: persistResult.attempted,
        skipped: persistResult.skipped,
        inserted: persistResult.sent,
        resume,
      });
    }
    if (responsePersistError) {
      logger.error('Mission run: responses persist failed', { missionId, err: responsePersistError });
    }

    // FAIL LOUD — a survey mission that simulated responses but could not
    // persist them would otherwise complete "clean" over an EMPTY table: the
    // paying customer gets a report built on zero data, and the acceptance
    // harness reads it as fine. That silent false-clean is more dangerous than
    // the null itself. Refuse to complete: throwing routes to the fatal handler
    // below, which marks the mission FAILED, alerts ops for a re-run, and
    // notifies the customer. Ground truth is the DB count, never the in-memory
    // `responses` array (Doctrine #16 — a counter derived from memory lied here:
    // delivered=40 over 0 persisted rows).
    if (mission.goal_type !== 'creative_attention' && (responses || []).length > 0) {
      if (responsePersistError) {
        throw new Error(`response persistence failed (${responsePersistError.code || ''} ${responsePersistError.message || responsePersistError}); refusing to complete over unsaved responses`);
      }
      const { count: persistedCount, error: countErr } = await supabase
        .from('mission_responses')
        .select('id', { count: 'exact', head: true })
        .eq('mission_id', missionId);
      if (countErr) throw new Error(`could not verify persisted responses: ${countErr.message}`);
      if (!persistedCount) {
        throw new Error(`0 responses persisted for a survey mission that simulated ${(responses || []).length} rows; refusing to complete over an empty responses table`);
      }
    }

    // Per-persona reasoning — capped at 50 personas per Pass 22 Bug 22.14.
    if (responses.length > 0 && (personas?.length || 0) <= 50) {
      const reasoningRows = responses
        .filter((r) => r.reasoning && typeof r.reasoning === 'string' && r.reasoning.trim().length > 0)
        .map((r) => ({
          mission_id:     missionId,
          persona_id:     r.persona_id,
          question_id:    r.question_id,
          response_value: Array.isArray(r.answer)
            ? r.answer.join(', ')
            : (r.answer == null ? null : String(r.answer)),
          reasoning_text: r.reasoning.trim().slice(0, 1000),
        }));
      // Pass 48 — same natural key, same duplication. This table was written
      // from the same `responses` array by the same completion block through a
      // second unconditional insert, so a re-entered run duplicated it too
      // (survey: 15 duplicate rows on af36a36d). Route it through the same
      // idempotent helper. Non-fatal by design: reasoning is a "why" trace,
      // not the paid deliverable, so a failure here warns and never blocks
      // completion the way an unsaved mission_responses does.
      const reasoningResult = await persistReasoningRows(supabase, missionId, reasoningRows, {
        caller: 'runMission: reasoning insert',
      });
      if (reasoningResult.skipped > 0) {
        logger.warn('Mission run: skipped already-persisted reasoning rows (duplicate run detected)', {
          missionId,
          attempted: reasoningResult.attempted,
          skipped: reasoningResult.skipped,
          inserted: reasoningResult.sent,
          resume,
        });
      }
      if (reasoningResult.error) {
        logger.warn('Mission run: reasoning insert failed (non-fatal)', {
          missionId, err: reasoningResult.error.message || reasoningResult.error,
        });
      }
    }

    // ─── Deterministic methodology analysis (Pass 46 Phase 3) ─────────────
    // Computed BEFORE synthesis so the narrator LLM writes prose about
    // these numbers instead of inventing its own. exposure_status rides
    // on the rows for brand_lift lift math. Non-fatal: null analysis
    // never blocks completion.
    let analysis = null;
    try {
      const analysisRows = responses.map((r) => ({
        ...r,
        exposure_status: exposureByPersonaId[r.persona_id]
          || (r.persona_profile && r.persona_profile._exposure_status)
          || 'not_applicable',
      }));
      analysis = computeAnalysis(mission, analysisRows);
    } catch (computeErr) {
      logger.error('Mission run: computeAnalysis threw (non-fatal)', {
        missionId, err: computeErr.message,
      });
    }

    // ─── Synthesize insights (non-fatal) ──────────────────────────────────
    let insights = null;
    try {
      insights = await synthesizeInsights(mission, responses, analysis);
      // Simulation-honesty PR - audit stamp: which models answered, at what
      // temperature, under which sim version (see simMeta.js). Lives inside
      // the insights JSONB so no migration is needed and it persists with
      // the mission for later comparability checks (e.g. brand-lift missions
      // before/after the emergent-lift switch are not level-comparable).
      if (insights && typeof insights === 'object') {
        insights._sim_meta = buildSimMeta();
      }
    } catch (analysisErr) {
      logger.error('Mission run: synthesizeInsights failed (non-fatal)', {
        missionId, err: analysisErr.message,
      });
      const { data: existing } = await supabase
        .from('missions').select('mission_assets').eq('id', missionId).single();
      await supabase.from('missions').update({
        mission_assets: {
          ...(existing?.mission_assets || {}),
          analysis_error: { message: analysisErr.message, ts: new Date().toISOString() },
        },
      }).eq('id', missionId);
    }

    // ─── chart_data — projected from the canonical report (Pass 50 B3) ──────
    // computeChartData now builds the canonical report and projects its survey
    // into chart shapes, so the cached chart_data, the on-demand endpoint, and
    // the web "full survey" all share ONE builder (no fork). The LLM synthesis
    // may emit its own chart_data, but its scale buckets aren't trustworthy, so
    // we always overwrite. Clean responses only (drop screened-out), matching
    // how the report is built.
    if (insights) {
      try {
        const { computeChartData } = require('../services/backfills/chartData');
        const clean = (responses || []).filter(
          (r) => r && !r.screened_out && !((r.persona_profile || {}).screened_out));
        const cd = computeChartData(mission, clean.length ? clean : (responses || []));
        if (cd && Array.isArray(cd.per_question_distributions) && cd.per_question_distributions.length) {
          insights.chart_data = cd;
        }
      } catch (cdErr) {
        logger.warn('Mission run: deterministic chart_data override failed (non-fatal)', {
          missionId, err: cdErr.message,
        });
      }
    }

    // ─── Pass 49 — dedicated report summaries (exec + per-question) ─────────
    // The monolithic synthesis is unreliable (narration_failed). Generate the
    // audience-facing summaries directly from the canonical report so they're
    // always present, grounded, and hedge-free; cache onto insights so
    // web/export/chat read identical text.
    try {
      const { buildCanonicalReport } = require('../services/report/buildReport');
      const { generateReportSummaries } = require('../services/ai/reportSummaries');
      const cleanForReport = (responses || []).filter(
        (r) => r && !r.screened_out && !((r.persona_profile || {}).screened_out));
      const report = buildCanonicalReport(mission, analysis || null, cleanForReport.length ? cleanForReport : (responses || []));
      const summaries = await generateReportSummaries(report, { missionId, userId: mission.user_id });
      insights = insights || {};
      if (summaries.executive_summary) insights.executive_summary = summaries.executive_summary;
      insights.per_question_insights = summaries.per_question_insights;
      // B1 — the dedicated generator now also produces grounded KPI tiles +
      // recommendations (the old monolith's job). Only overwrite when we got
      // real content, so a mission that already has good kpis/recs isn't wiped.
      if (Array.isArray(summaries.kpis) && summaries.kpis.length) insights.kpis = summaries.kpis;
      if (Array.isArray(summaries.recommendations) && summaries.recommendations.length) insights.recommendations = summaries.recommendations;
      // P2-1 — open-end theme clusters, keyed by question_id, so text questions
      // render a visual (not a verbatims punt) on every surface.
      if (summaries.open_end_themes && Object.keys(summaries.open_end_themes).length) {
        insights.open_end_themes = summaries.open_end_themes;
      }
      insights.narration_failed = false;
    } catch (sumErr) {
      logger.warn('Mission run: report summaries failed (non-fatal)', { missionId, err: sumErr.message });
    }

    // Targeting brief (non-fatal).
    try {
      const brief = await generateTargetingBrief({ mission, responses, insights });
      await supabase.from('missions').update({ targeting_brief: brief }).eq('id', missionId);
    } catch (briefErr) {
      logger.warn('Mission run: targeting brief failed (non-fatal)', {
        missionId, err: briefErr.message,
      });
    }

    // ─── Aggregates + completion ───────────────────────────────────────────
    // Pass 23 Bug 23.25 v2 — always-deliver. Even if some personas residually
    // screened out after retry rounds, we count them as qualified for
    // delivery purposes (the admin_alerts row above is the quality signal).
    // The promise of purchase is absolute: paid_for == qualified == delivered.
    const totalSimulated = personas.length;
    // Pass 45 T2a — loop path reports the loop's actual qualified
    // count; legacy batch path keeps Pass 23 always-deliver semantics
    // (qualified = paid-for target). Invariant recruited >= qualified
    // enforced defensively: a violation is clamped + logged loudly
    // because it means the counters drifted again.
    let qualifiedRespondent = loopQualifiedCount != null ? loopQualifiedCount : targetCount;
    // (b) — never report more qualified respondents than were actually simulated.
    // The legacy batch path assumed "always deliver" (qualified = paid-for target),
    // but a dropped persona batch (e.g. a truncated generation) leaves fewer
    // personas. Cap at the real count + surface the shortfall LOUDLY instead of
    // silently overstating n (run a39ce46e: 70 simulated but reported 80).
    if (qualifiedRespondent > totalSimulated) {
      logger.error('Mission run: generation UNDER-DELIVERED — capping qualified to actual', {
        missionId, requested: qualifiedRespondent, simulated: totalSimulated,
        shortfall: qualifiedRespondent - totalSimulated,
      });
      qualifiedRespondent = totalSimulated;
    }
    if (loopRecruitedCount != null && qualifiedRespondent > loopRecruitedCount) {
      logger.error('Mission run: INVARIANT VIOLATION qualified > recruited — clamping', {
        missionId, qualified: qualifiedRespondent, recruited: loopRecruitedCount,
      });
      qualifiedRespondent = loopRecruitedCount;
    }
    const qualificationRate = totalSimulated > 0
      ? Number((qualifiedRespondent / totalSimulated).toFixed(4))
      : null;

    // Pass 32 X1 → Pass 33 W4 → Pass 36 A0 — delivered_respondent_count
    // = COUNT(DISTINCT persona_id) from responses. The Pass 33 W4
    // semantics counted ROWS (personas × questions) and the W4
    // verification was tautological (compared the lying column to its
    // own derivation). May 11 2026 demo failed because every paid
    // mission overstated respondents by 2-10x. Doctrine #16: SQL
    // invariants must compare to GROUND TRUTH not derived columns.
    //
    // CA missions stay at 0 (delivery_unit='creative_asset', no
    // respondent rows by design).
    //
    // Pass 41 BUG3 — additionally cap at targetCount. Live audit caught
    // brand_lift mission af36a36d with respondent_count=5 but
    // delivered_respondent_count=10. Root cause: the retry path
    // (screener constraint replacements) can leave the original
    // screened-out personas alongside the qualifying replacements in
    // the `responses` array if the swap-out filter doesn't catch
    // every screened-out persona_id. From the customer's view they
    // paid for 5; the column saying 10 created confusion ("did I get
    // double-charged? why does it say 10 if I requested 5?"). The
    // cap is a customer-trust safeguard: delivered ≤ requested
    // always. Over-delivery is a positive technical side-effect that
    // doesn't need to leak into the displayed number.
    const distinctPersonaCount = mission.goal_type === 'creative_attention'
      ? 0
      : new Set(responses.map((r) => r.persona_id).filter(Boolean)).size;
    const deliveredRespondentCount = mission.goal_type === 'creative_attention'
      ? 0
      : Math.min(distinctPersonaCount, targetCount);
    if (distinctPersonaCount > targetCount) {
      logger.info('Mission run: capping delivered_respondent_count at targetCount', {
        missionId,
        targetCount,
        distinctPersonaCount,
        goalType: mission.goal_type,
      });
    }

    // Pass 42 A2 — delivery_status reflects whether the recruitment
    // loop hit its target. recruitmentPartial=true only when the new
    // loop was used AND ceiling_hit terminated it. Legacy batch path
    // always reports 'full' per pre-Pass-42 semantics.
    const deliveryStatusFinal = recruitmentPartial ? 'partial' : 'full';

    // Pass 45 T1b — aggregated_by_question: the per-question map the 9
    // methodology renderers read ({distribution, average, n, verbatims}
    // keyed by question_id). Same aggregate() the synthesis prompt is
    // fed from, persisted so renderers don't recompute client-side.
    // Coexists with insights.chart_data (universal charts) by design.
    let aggregatedByQuestion = null;
    try {
      aggregatedByQuestion = aggregate(responses, mission.questions || []);
    } catch (aggErr) {
      logger.warn('Mission run: aggregated_by_question compute failed (non-fatal)', {
        missionId, err: aggErr.message,
      });
    }

    // ─── Terminal write: status-scoped ────────────────────────────────────
    // Pass 49 — this write used to be UNCONDITIONAL. A run that the Job 1
    // reaper had already marked 'failed' (or that an admin had
    // force-completed via PATCH /api/admin/missions/:id/force-complete)
    // kept executing and then wrote 'completed' straight back over that
    // terminal state, together with its own insights / analysis /
    // aggregated_by_question — all of which are built from this process's
    // in-memory arrays and are never re-read from the DB. Scoping to
    // status='processing' makes the write conditional on this process
    // still owning the claim it took at the top of runMission.
    const { error: completeErr, matched: completeMatched } = await updateMission(supabase, missionId, {
      status: 'completed',
      completed_at: new Date().toISOString(),
      executive_summary: insights?.executive_summary || null,
      insights: insights || null,
      aggregated_by_question: aggregatedByQuestion,
      // Pass 46 Phase 3 — deterministic methodology analysis (typed
      // object per src/services/analysis/; renderers + narrator both
      // consume it; LLM never computes these numbers).
      analysis,
      total_simulated_count:        totalSimulated,
      qualified_respondent_count:   qualifiedRespondent,
      qualification_rate:           qualificationRate,
      delivered_respondent_count:   deliveredRespondentCount,
      // Pass 45 T2a — legacy batch path never wrote recruited count;
      // persist personas.length so recruited >= qualified holds on
      // every path. Loop path already wrote it in its terminal update
      // (same value re-written here harmlessly).
      recruited_persona_count:      loopRecruitedCount != null ? loopRecruitedCount : totalSimulated,
      delivery_status:              deliveryStatusFinal,
      delivery_check_at:            new Date().toISOString(),
      // partial_refund_id and partial_refund_amount_cents stay NULL —
      // never populated for new missions under v2.
      // NOTE: Pass 42 policy — NO REFUNDS, EVER. partial delivery from
      // a hit margin ceiling is not a refundable event; customer
      // agreed to this at checkout (Pass 42 G4 microcopy).
    }, { caller: 'runMission: complete', scope: { status: 'processing' } });

    // 0 rows matched => the mission left 'processing' while we were still
    // working. We are the stale writer. Never silent: this is an incident.
    // Legitimate causes: the Job 1 reaper auto-failed a long-but-healthy
    // run, an admin force-completed it (src/routes/admin.js
    // PATCH /missions/:id/force-complete), or a second concurrent run
    // (Job 3 {resume:true} on a rolling deploy) finished first.
    const terminalWriteLost = !completeErr && completeMatched === 0;
    if (terminalWriteLost) {
      logger.error('Mission run: COMPLETION WRITE LOST — mission is no longer processing; another writer resolved it', {
        missionId,
        attempted: 'status=completed',
        qualifiedRespondent,
        totalSimulated,
        note: 'insights/analysis/aggregated_by_question from THIS process were NOT persisted; customer notification and completion email suppressed',
        // From PR #109 - a lost write on a short delivery is doubly important
        // to see: the run under-delivered AND its result was dropped.
        simulationFailures: simFailureReport ? simFailureReport.failed : 0,
        simulationAttempted: simFailureReport ? simFailureReport.attempted : totalSimulated,
      });
      // Ops-visible: the results this run computed exist only in memory
      // and are about to be dropped. Someone has to decide whether to
      // re-run or force-complete. admin_alerts is the existing channel.
      try {
        await supabase.from('admin_alerts').insert({
          alert_type: 'mission_terminal_write_lost',
          mission_id: missionId,
          user_id:    mission.user_id,
          payload: {
            attempted_status:   'completed',
            qualified:          qualifiedRespondent,
            total_simulated:    totalSimulated,
            action_required: 'A run finished but could not write its terminal state — the row had already left processing (reaper auto-fail, admin force-complete, or a concurrent run). Check the mission status and re-run or force-complete as appropriate.',
          },
          resolved: false,
        });
      } catch (alertErr) {
        logger.warn('Mission run: terminal_write_lost alert insert failed (non-fatal)', {
          missionId, err: alertErr.message,
        });
      }
    } else {
      logger.info('Mission run: complete', {
        missionId, qualifiedRespondent, totalSimulated,
        // Per-mission simulation-failure count (PR #109), carried all the way
        // to the completion line so a short delivery is never silent.
        simulationFailures: simFailureReport ? simFailureReport.failed : 0,
        simulationAttempted: simFailureReport ? simFailureReport.attempted : totalSimulated,
      });
    }

    // Funnel event.
    // Pass 34 C4 — was fire-and-forget with silent .catch(() => {});
    // production audit found 25/29 paid-completed missions never fired
    // mission_completed because failures were silently swallowed. Now
    // awaited + logged so transient failures surface in Railway logs
    // and the row gets retried on the next runMission attempt if the
    // worker is re-invoked (idempotent insert on the next pass via
    // the C4 backfill SQL — duplicates would no-op since the dedup
    // join uses event_type + mission_id).
    try {
      const { error: feErr } = await supabase.from('funnel_events').insert({
        user_id:    mission.user_id,
        event_type: 'mission_completed',
        mission_id: missionId,
        metadata:   {
          goal_type: mission.goal_type,
          delivery_status: 'full',
          qualified: qualifiedRespondent,
          paid_for: targetCount,
          total_simulated: totalSimulated,
          // Pass 49 — true when THIS process could not write the terminal
          // state (another writer owned the row). Kept in the funnel so
          // analytics can separate real completions from lost races.
          terminal_write_noop: terminalWriteLost,
        },
      });
      if (feErr) {
        logger.error('Mission run: funnel_events insert failed', {
          missionId, err: feErr.message, code: feErr.code,
        });
      }
    } catch (feCatch) {
      logger.error('Mission run: funnel_events insert threw', {
        missionId, err: feCatch?.message || 'unknown',
      });
    }

    // Notification — single 'mission_complete' branch (no partial branch v2).
    //
    // Pass 49 — SUPPRESSED when the terminal write was lost. A zombie run
    // must not tell a customer "your results are ready" about a mission
    // that somebody else already resolved (and whose row does NOT contain
    // this run's insights, because the scoped write above no-opped).
    if (terminalWriteLost) {
      logger.error('Mission run: suppressing customer notification + completion email (terminal write lost)', {
        missionId, userId: mission.user_id,
      });
    } else {
      try {
        const { error: notifErr } = await supabase
          .from('notifications')
          .insert({
            user_id: mission.user_id,
            type:    'mission_complete',
            title:   'Mission complete',
            body:    `Your "${truncateTitle(mission.title)}" results are ready.`,
            link:    `/dashboard/${missionId}`,
          });
        if (notifErr) {
          logger.warn('Mission run: notification insert failed', { missionId, err: notifErr.message });
        }
      } catch (notifThrow) {
        logger.warn('Mission run: notification insert threw', { missionId, err: notifThrow.message });
      }

      // Email completion.
      try {
        const { data: { user } } = await supabase.auth.admin.getUserById(mission.user_id);
        if (user?.email) {
          await emailService.sendMissionCompletedEmail?.({
            to: user.email,
            name: user.user_metadata?.name || user.email.split('@')[0],
            missionStatement: mission.title || 'Your research mission',
            totalResponses: qualifiedRespondent,
            missionId,
            headline: insights?.executive_summary?.slice(0, 200) || '',
          });
        }
      } catch (mailErr) {
        logger.warn('Mission run: email send failed', { missionId, err: mailErr.message });
      }
    } // end if (!terminalWriteLost) — notification + completion email
  } catch (err) {
    logger.error('Mission run: fatal', { missionId, err: err.message, stack: err.stack });
    const failureReason = String(err && err.message ? err.message : 'Unknown error').slice(0, 500);

    // Pass 44 P0 — auto-refund block REMOVED (was Pass 23 Bug 23.80).
    //
    // Two reasons:
    // 1. Policy: NO REFUNDS, EVER (Pass 42 G4, Terms §5.3). Failed
    //    missions get a support-prioritized re-run, not money back.
    // 2. Forensic: the block was dead code anyway — `createRefund` was
    //    referenced but never imported in this file, so every
    //    invocation threw ReferenceError inside its own try/catch
    //    (same dead-reference pattern as the deriveFilters P0).
    //    No refund was ever actually issued by this path; customers
    //    were being PROMISED refunds in the failure notification that
    //    nothing ever fulfilled. The promise is the bug.
    // Pass 49 — status-scoped, same rationale as the completion write
    // above. An unconditional 'failed' here would overwrite a state that
    // a reaper, an admin force-complete, or a concurrent run had already
    // established — including stamping failure_reason and completed_at
    // over a genuinely completed mission.
    const { error: failWriteErr, matched: failMatched } = await updateMission(supabase, missionId, {
      status: 'failed',
      failure_reason: failureReason,
      completed_at: new Date().toISOString(),
    }, { caller: 'runMission: fatal', scope: { status: 'processing' } });

    const failWriteLost = !failWriteErr && failMatched === 0;
    if (failWriteLost) {
      logger.error('Mission run: FAILURE WRITE LOST — mission is no longer processing; another writer resolved it', {
        missionId,
        attempted: 'status=failed',
        failureReason,
        note: 'customer failure notification and failure email suppressed',
      });
    }

    // Admin alert so ops can see hard-failure missions without paging
    // funnel_events. Dedup pattern matches missionRecovery::alertAdmin.
    // Pass 44 P0 — refund fields removed from payload (NO REFUNDS;
    // the auto-refund block above is gone). action_required tells ops
    // the new contract: prioritize a re-run for the customer.
    try {
      await supabase.from('admin_alerts').insert({
        alert_type: 'mission_pipeline_failure',
        mission_id: missionId,
        user_id:    mission.user_id,
        payload: {
          failure_reason: failureReason,
          paid_amount_cents: mission.paid_amount_cents,
          payment_intent_id: mission.latest_payment_intent_id,
          action_required: 'Customer paid and got nothing — prioritize a manual re-run (admin reanalyze / re-trigger). NO refund per policy.',
          // Pass 49 — true when the scoped 'failed' write no-opped, i.e.
          // this run threw but the row had already been resolved by
          // someone else. Ops should check the CURRENT status before
          // acting; the mission may already be completed.
          terminal_write_noop: failWriteLost,
        },
        resolved: false,
      });
    } catch (alertErr) {
      logger.warn('Mission run: pipeline_failure alert insert failed (non-fatal)', {
        missionId, err: alertErr.message,
      });
    }

    // Pass 44 P0 — no-refund-consistent failure copy (Pass 42 G4 /
    // Terms §5.3). The customer gets a support-prioritized re-run,
    // and the copy says exactly that — no money-back promises.
    const notifBody = `Your "${truncateTitle(mission.title)}" hit a snag before completing. Our team has been notified and will prioritize a re-run of your mission. Contact support if you don't hear from us within one business day.`;
    //
    // Pass 49 — SUPPRESSED when the scoped 'failed' write no-opped. Telling
    // a customer their mission failed, when the row says completed because
    // another writer resolved it, is exactly the zombie-notification bug
    // this pass exists to close.
    if (failWriteLost) {
      logger.error('Mission run: suppressing customer failure notification + failure email (terminal write lost)', {
        missionId, userId: mission.user_id,
      });
    } else {
      try {
        const { error: failNotifErr } = await supabase
          .from('notifications')
          .insert({
            user_id: mission.user_id,
            type:    'mission_failed',
            title:   'Mission failed — re-run prioritized',
            body:    notifBody,
            link:    mission.goal_type === 'creative_attention'
              ? `/creative-results/${missionId}`
              : `/dashboard/${missionId}`,
          });
        if (failNotifErr) {
          logger.warn('Mission run: failure notification insert failed', {
            missionId, err: failNotifErr.message,
          });
        }
      } catch { /* swallowed; logging-only */ }

      // Pass 44 P0 — failure email. sendMissionFailedEmail is the no-refund
      // rewrite of the old sendMissionFailedRefundEmail, whose template
      // promised a refund the removed auto-refund block never issued. The
      // refundAmountUsd/refundFailed arguments went away with that copy.
      try {
        const { data: { user } } = await supabase.auth.admin.getUserById(mission.user_id);
        if (user?.email) {
          await emailService.sendMissionFailedEmail?.({
            to: user.email,
            name: user.user_metadata?.name || user.email.split('@')[0],
            missionTitle: mission.title || 'Your VETT mission',
            missionId,
            // Sanitize the failure reason — strip stack-trace-ish content + cap length.
            friendlyReason: friendlyFailureReason(failureReason),
          });
        }
      } catch (mailErr) {
        logger.warn('Mission run: failure email send failed', { missionId, err: mailErr.message });
      }
    } // end if (!failWriteLost) — failure notification + failure email
  }
}

/**
 * Pass 23 Bug 23.80 — produce a user-safe one-line failure description
 * from the runMission error message. Strips stack frames, file paths,
 * Anthropic API noise, and caps at 180 chars. Categorises common failure
 * modes into clearer language.
 */
function friendlyFailureReason(raw) {
  const r = String(raw || '').slice(0, 400);
  if (/image\/(?:webp|png|gif|jpeg)/i.test(r) && /Anthropic|Vision|messages\.0\.content/.test(r)) {
    return 'The uploaded image format was not accepted by our analysis engine.';
  }
  if (/timeout|TIMEOUT/.test(r)) {
    return 'The analysis took longer than allowed and was stopped.';
  }
  if (/Storage download|signed URL|getPublicUrl/.test(r)) {
    return 'We could not retrieve the uploaded file from storage.';
  }
  if (/parse|JSON|extractJSON/.test(r)) {
    return 'The AI response did not match the expected format.';
  }
  // Generic — first sentence only.
  const firstSentence = r.split(/[.\n]/)[0] || r;
  return firstSentence.slice(0, 180);
}

module.exports = { runMission };
