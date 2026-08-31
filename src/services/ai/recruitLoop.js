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
const { normalizeAnswerForStorage } = require('../../utils/answerValue');
const fetchAllResponses = require('../../db/fetchAllResponses');
// Pass 48 — idempotent persistence. A resumed (or concurrently re-entered)
// run must never re-insert a (persona_id, question_id) it already stored.
const { persistResponseRows, responseKey } = require('./persistResponses');

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

  // ── Pass 46 Phase 2 — RESUME SUPPORT (audit P1-3) ──────────────────────
  // The loop persists each qualified persona's responses immediately (see
  // the qualify block below), so a process restart mid-run can pick up
  // where it left off instead of orphaning the mission until the stuck-
  // processing reaper fails it. On entry we load any rows a previous
  // attempt persisted and rebuild the in-memory state from them.
  const qualifiedResponses = []; // flat list, persona × question
  const qualifiedPersonas  = []; // persona objects (tagged for brand_lift)
  let recruitedCount = 0;
  let qualifiedCount = 0;

  const { data: priorRows, error: priorErr } = await fetchAllResponses(supabase, {
    missionId,
    columns: 'persona_id, persona_profile, question_id, answer, exposure_status',
    eq: { screened_out: false },
    label: 'recruitLoop:resume',
  });
  if (priorErr) {
    logger.warn('Recruitment loop: prior-rows read failed (starting fresh)', {
      missionId, err: priorErr.message,
    });
  }
  // Pass 48 — the natural keys already stored for this mission. Seeded
  // from the very rows we read above (no extra query) and mutated by
  // persistResponseRows as each persona is written, so the per-persona
  // insert below can skip anything a previous attempt already persisted.
  // The DB unique index is the authority under concurrency; this set is
  // the cheap sequential-resume guard.
  const persistedKeys = new Set();
  // Persona ids are LLM-assigned sequentially ("P001", "P002", … — see
  // personas.js "Starting persona ID index"), so a resumed run can
  // regenerate an id it already holds. Counting that persona twice would
  // let the loop "hit target" with fewer distinct respondents than the
  // customer paid for, so it is treated as a wasted generation.
  const knownPersonaIds = new Set();
  if (Array.isArray(priorRows) && priorRows.length > 0) {
    const personasById = new Map();
    for (const r of priorRows) {
      persistedKeys.add(responseKey(missionId, r.persona_id, r.question_id));
      if (r.persona_id && !personasById.has(r.persona_id)) {
        personasById.set(r.persona_id, r.persona_profile || { id: r.persona_id, persona_id: r.persona_id });
      }
      qualifiedResponses.push({
        persona_id:      r.persona_id,
        persona_profile: r.persona_profile,
        question_id:     r.question_id,
        answer:          r.answer,
        reasoning:       null, // reasoning is not resumable (memory-only pre-restart)
      });
    }
    qualifiedPersonas.push(...personasById.values());
    for (const pid of personasById.keys()) knownPersonaIds.add(pid);
    qualifiedCount = personasById.size;
    recruitedCount = Math.max(Number(mission.recruited_persona_count) || 0, qualifiedCount);
  }
  const isResume = qualifiedCount > 0;

  logger.info(isResume ? 'Recruitment loop: RESUMING' : 'Recruitment loop: starting', {
    missionId,
    target,
    ceilingUsd: ceiling,
    maxPersonas,
    goalType: mission.goal_type,
    resumedQualified: qualifiedCount,
    resumedRecruited: recruitedCount,
  });

  // On a fresh start zero the counters; on resume DO NOT reset
  // recruited_persona_count or ai_spend_usd_actual — the spend already
  // incurred is real and the ceiling check must see it.
  await updateMission(supabase, missionId, isResume ? {
    recruitment_status: 'recruiting',
  } : {
    recruitment_status: 'recruiting',
    recruited_persona_count: 0,
    ai_spend_usd_actual: 0,
  }, { caller: isResume ? 'recruitLoop: resume' : 'recruitLoop: start' });

  // Pass 44 P0 — track WHY the loop exited so the terminal status is
  // honest. Pre-Pass-44, every non-target exit was labeled
  // 'ceiling_hit', including transient persona-gen failures (429s),
  // which produced partial deliveries blamed on "strict screener" at
  // 3% budget spend.
  let breakReason = null; // 'ceiling' | 'max_personas' | 'persona_gen_failed' | 'persona_gen_empty'
  // Pass 46 Phase 2 — rows whose incremental insert failed; runMission's
  // completion insert picks these up so no qualified data is ever lost.
  const unpersistedResponses = [];

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

    // ── Pass 48 — duplicate-persona guard ──────────────────────────────
    // The generator was asked for ids starting at recruitedCount, but on
    // a resume (or a concurrent second run of the same mission) it can
    // still hand back an id we already hold. Simulating and counting it
    // would (a) add a second, DIVERGENT set of answers for one persona
    // and (b) inflate qualifiedCount so the loop terminates below the
    // real distinct-respondent target. Discard before paying for the
    // survey; the max-personas guard bounds the retry.
    if (persona.id && knownPersonaIds.has(persona.id)) {
      logger.warn('Recruitment loop: generated a persona_id already persisted; discarding', {
        missionId, personaId: persona.id, recruitedCount, qualifiedCount,
      });
      continue;
    }

    // ── Pass 46 Phase 2 — brand_lift exposure tagging IN-LOOP ──────────
    // simulate.js branches on persona._exposure_status to inject the
    // exposed-uplift / control-baseline instructions. The old loop path
    // tagged personas in runMission AFTER the loop returned, i.e. AFTER
    // simulation — so every loop-path brand_lift persona answered at
    // baseline and the persisted exposure labels were post-hoc cosmetics
    // with no lift signal in the data. Tag BEFORE simulating, alternating
    // by recruitment order for an ~50/50 split among qualifiers.
    if (mission.goal_type === 'brand_lift') {
      persona._exposure_status = recruitedCount % 2 === 1 ? 'exposed' : 'control';
    }

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

    // ── Pass 47 — zero-response guard (audit finding) ──────────────────
    // A persona that produced NO parseable responses must NOT count as
    // qualified. The roadmap mission (Pass 46) "completed" target_hit
    // qualified=5 with ZERO persisted rows because empty personas slid
    // through: keptResponses was empty, no screening question failed (no
    // answers to check), so the persona qualified with nothing. With the
    // simulator's retry this should be rare, but the guard is the
    // invariant: qualified ⇒ at least one real response. Wasted, not
    // qualified; the loop generates another persona.
    if (!Array.isArray(responses) || responses.length === 0) {
      logger.warn('Recruitment loop: persona produced zero responses; wasted, not qualified', {
        missionId, personaIndex: recruitedCount,
      });
      continue;
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
    if (persona.id) knownPersonaIds.add(persona.id);
    const personaResponses = [];
    for (const r of keptResponses) {
      const entry = {
        persona_id:      persona.id,
        persona_profile: persona,
        question_id:     r.question_id,
        answer:          r.answer,
        reasoning:       typeof r.reasoning === 'string' ? r.reasoning : null,
      };
      qualifiedResponses.push(entry);
      personaResponses.push(entry);
    }
    qualifiedCount += 1;

    // ── Pass 46 Phase 2 — persist THIS persona's rows immediately ──────
    // This is what makes the loop resumable: a restart reconstructs
    // state from mission_responses instead of starting over. Same row
    // shape as runMission's completion insert (which is skipped for the
    // loop path now — see responses_already_persisted in the result).
    // Insert failures are non-fatal: the rows ride along in
    // unpersistedResponses and runMission's completion insert picks
    // them up.
    const insertRows = personaResponses.map((r) => ({
      mission_id:      missionId,
      persona_id:      r.persona_id,
      persona_profile: r.persona_profile,
      question_id:     r.question_id,
      // Never store SQL null against the NOT NULL JSONB column — a skip
      // (not_applicable) is stored as the sentinel string, not null (else the
      // whole chunk insert 23502s and the rows silently vanish).
      answer:          normalizeAnswerForStorage(r.answer),
      screened_out:    false,
      exposure_status: persona._exposure_status || 'not_applicable',
    }));
    //
    // Pass 48 — routed through persistResponseRows so a resumed or
    // concurrently re-entered run cannot append a second copy of a
    // persona it already stored. `persistedKeys` was seeded from the
    // prior-rows read above and is mutated here as rows are written.
    const persistResult = await persistResponseRows(supabase, missionId, insertRows, {
      knownKeys: persistedKeys,
      caller: 'recruitLoop: incremental',
    });
    if (persistResult.skipped > 0) {
      logger.warn('Recruitment loop: persona rows already persisted — skipped re-insert', {
        missionId, personaId: persona.id, skipped: persistResult.skipped,
      });
    }
    if (persistResult.error) {
      logger.warn('Recruitment loop: incremental persist failed (will retry at completion)', {
        missionId, personaId: persona.id, err: persistResult.error.message,
      });
      unpersistedResponses.push(...personaResponses);
    }

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
  // Pass 45 T2b — 'ceiling_hit' may ONLY mean the spend ceiling
  // tripped (breakReason='ceiling'). Infra exits (persona_gen_failed /
  // persona_gen_empty / max_personas) now get 'incomplete' — no DB
  // CHECK constrains recruitment_status, and conflating infra
  // failures with budget exhaustion misled both customers (strict-
  // screener framing) and ops (no re-run signal). Pass 44 added the
  // retry/backoff + alert; this closes the labeling half.
  const terminalStatus = reachedTarget
    ? 'target_hit'
    : (breakReason === 'ceiling' ? 'ceiling_hit' : 'incomplete');
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
    // Pass 46 Phase 2 — the loop persists qualified rows incrementally
    // (resume support); runMission must NOT bulk-insert `responses`
    // again. Only the rows whose incremental insert failed need a
    // second chance at completion.
    responsesAlreadyPersisted: true,
    unpersistedResponses,
    resumed: isResume,
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
