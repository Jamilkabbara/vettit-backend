/**
 * VETT — Response simulation.
 * For each persona, answers every question in the mission as that persona would.
 * Uses Haiku (highest volume of any call in the pipeline).
 */

const { callClaude, extractJSON } = require('./anthropic');
const { DEFAULT_SIM_TEMPERATURE } = require('./simMeta');
const { WRITING_STYLE } = require('./writingStyle');
const logger = require('../../utils/logger');

/**
 * Pass 47 — the authoritative set of question `type` values the
 * simulator knows how to answer. EVERY type any generator emits MUST
 * appear here AND have an explicit answer-format instruction in the
 * prompt below. The invariant test (test/simulator_type_coverage.test.js)
 * fails if a generator can emit a type not in this set — that's what
 * stops the Pass-46 class of bug (specialized questions silently
 * getting unparseable answers) from ever recurring.
 *
 * 'max_diff_set' (Pass 47) — best/worst trade-off; answer is an object
 * {best, worst}. All other specialized methodologies ride the standard
 * single/multi/rating/text types with metadata the analysis modules key
 * on, so they're already covered here.
 */
const SUPPORTED_QUESTION_TYPES = ['single', 'opinion', 'multi', 'rating', 'text', 'max_diff_set'];

/**
 * Pass 47 — scale the response token budget to the survey length. The
 * old fixed 1500 truncated the JSON for long surveys (roadmap 23Q,
 * naming 20Q, marketing 13Q), silently dropping the TAIL questions so
 * late-funnel stages (sharing intent, final paired comparisons,
 * max-diff sets) got zero answers. ~220 tokens/question covers an
 * answer + reasoning + JSON overhead; floor 1500, cap 8000.
 */
function tokenBudgetFor(questionCount) {
  return Math.min(8000, Math.max(1500, (questionCount || 0) * 220));
}

const SIM_SYSTEM_PROMPT = `You are answering a market-research survey AS the persona described. Stay fully in character.
Use the persona's vocabulary, education level, cultural context, and emotional state.
Be honest about mixed feelings, uncertainty, and ambivalence. Real people rarely give clean answers.
Output must be STRICTLY VALID JSON matching the requested schema, no commentary.
${WRITING_STYLE}`;

/**
 * Simulate answers for one persona across all mission questions.
 * @param {object} persona
 * @param {Array}  questions  mission.questions
 * @param {object} mission    full mission row (for context)
 * @returns {Promise<Array<{question_id, answer}>>}
 */
async function simulateResponses(persona, questions, mission) {
  // Pass 27 — Brand Lift incrementality. When the persona is tagged
  // _exposure_status=exposed, instruct the model that this persona was
  // exposed to the brand's campaign on the selected channels and shift
  // aided recall / awareness / message association answers upward. control
  // personas answer at category baseline. Simulation-honesty PR: the prompt
  // previously DICTATED numeric lift ranges (+20-40pp recall etc.), so the
  // measured lift partially recovered prompt-injected numbers. The ranges are
  // removed - lift is now an emergent model property; only qualitative
  // realism guardrails remain (see SIM_VERSION in simMeta.js for the
  // comparability break with earlier missions).
  const isBrandLift = mission.goal_type === 'brand_lift';
  const exposure = persona._exposure_status;
  // §2.2 — inject the ACTUAL selected channels (MBC, Shahid, TOD, …) so the
  // exposed persona's recall + ad_channels_seen reflect the campaign's real
  // media plan instead of the model defaulting to generic digital channels.
  const channelNames = Array.isArray(mission.campaign_channels)
    ? mission.campaign_channels
      .map((c) => (typeof c === 'string' ? c : (c && (c.display_name || c.id)) || ''))
      .map((s) => String(s).trim()).filter(Boolean)
    : [];
  const channelClause = channelNames.length
    ? ` specifically on these channels: ${channelNames.join(', ')}. If any question asks which channels/platforms you saw the ad on, answer ONLY with channels from that list`
    : '';
  const exposureBlock = isBrandLift && exposure === 'exposed'
    ? `\n\nIncrementality flag: this persona was EXPOSED to the brand's campaign${channelClause}. When answering aided ad recall, brand awareness, consideration, intent, NPS, and message association, reflect that exposure with realistic uplift over baseline. Don't exaggerate — many exposed people still don't recall, and lift never pushes every metric to 100%.`
    : isBrandLift && exposure === 'control'
    ? `\n\nIncrementality flag: this persona is in the CONTROL group. They were NOT exposed to the brand's campaign. They answer at category baseline — they may still recognize the brand if it has prior equity, but they do NOT show campaign-specific message association.`
    : '';

  // Pass 47 — answer-format guidance now covers EVERY supported type,
  // and rating respects the question's own scale (NPS 0-10, CES 1-7,
  // appeal 1-10) instead of the old hardcoded "1 to 5", which under-
  // reported every non-5-point scale. max_diff_set gets an explicit
  // best/worst object contract the roadmap analysis module consumes.
  const formatInstructions = `Answer every question below as this persona. Match the answer FORMAT to the question's (type):
- "single" / "opinion" → pick exactly ONE option, returned as the option's EXACT text.
- "multi"              → an ARRAY of 1-N options the persona genuinely agrees with (exact option text).
- "rating"            → a whole number on THIS question's scale. When options are provided they list the valid numbers (e.g. 0-10 for NPS, 1-7 for CES) — answer within that range. If no options, use 1 to 5.
- "max_diff_set"      → from the options, choose the SINGLE MOST important and the SINGLE LEAST important. Answer as an object: {"best": "<exact option text>", "worst": "<exact option text>"} — best and worst MUST differ.
- "text"              → 1-3 sentences in the persona's voice (free text).

Answer EVERY question — do not skip any, even late ones. For EVERY answer also include a "reasoning" field: 1-2 sentences explaining why this persona answered that way given their context (job, family, anxieties, decision triggers). Be specific, never generic.`;

  const buildPrompt = (qs) => `You are this persona:
${JSON.stringify(persona, null, 2)}

Mission brief: ${mission.brief || mission.mission_statement || ''}${exposureBlock}

${formatInstructions}

Questions:
${qs.map((q, i) => {
  const opts = (q.options && q.options.length) ? `\n   options: ${JSON.stringify(q.options)}` : '';
  return `${i + 1}. [${q.id}] (${q.type}) ${q.text}${opts}`;
}).join('\n')}

Return ONLY this JSON (answer shape matches each question's type):
{
  "responses": [
    { "question_id": "q1", "answer": "Option A", "reasoning": "..." },
    { "question_id": "q2", "answer": ["Option A", "Option C"], "reasoning": "..." },
    { "question_id": "q3", "answer": 4, "reasoning": "..." },
    { "question_id": "q_maxdiff", "answer": { "best": "Feature X", "worst": "Feature Y" }, "reasoning": "..." },
    { "question_id": "q_text", "answer": "I'm honestly torn. The price feels high but...", "reasoning": "..." }
  ]
}`;

  // Pass 47 — dedup + parse a single model response into {question_id → row}.
  const parseInto = (text, acc) => {
    try {
      const parsed = extractJSON(text);
      const raw = Array.isArray(parsed.responses) ? parsed.responses : [];
      for (const r of raw) {
        if (!r || typeof r.question_id !== 'string') continue;
        if (acc.has(r.question_id)) continue; // first answer per id wins (Pass 32 X1)
        acc.set(r.question_id, r);
      }
    } catch (err) {
      logger.warn('Response sim parse failed', { personaId: persona.id, err: err.message });
    }
  };

  const answersById = new Map();
  const response = await callClaude({
    temperature: DEFAULT_SIM_TEMPERATURE,
    callType:  'response_sim',
    missionId: mission.id,
    userId:    mission.user_id,
    messages:  [{ role: 'user', content: buildPrompt(questions) }],
    systemPrompt: SIM_SYSTEM_PROMPT,
    maxTokens: tokenBudgetFor(questions.length),
    enablePromptCache: true,
  });
  parseInto(response.text, answersById);

  // Pass 47 — retry ONCE for any questions left unanswered (truncation,
  // a dropped tail, or a parse hiccup). Re-ask only the missing ones so
  // the retry is cheap and can't itself truncate. This is what lifts
  // late-funnel stages (sharing intent, final paired comparisons) and
  // big max-diff batteries from "0 answers" to fully covered.
  const missing = questions.filter((q) => !answersById.has(q.id));
  if (missing.length > 0) {
    logger.info('Response sim: retrying missing questions', {
      personaId: persona.id, missing: missing.length, total: questions.length,
    });
    try {
      const retry = await callClaude({
        temperature: DEFAULT_SIM_TEMPERATURE,
        callType:  'response_sim',
        missionId: mission.id,
        userId:    mission.user_id,
        messages:  [{ role: 'user', content: buildPrompt(missing) }],
        systemPrompt: SIM_SYSTEM_PROMPT,
        maxTokens: tokenBudgetFor(missing.length),
        enablePromptCache: true,
      });
      parseInto(retry.text, answersById);
    } catch (err) {
      logger.warn('Response sim retry failed (non-fatal)', { personaId: persona.id, err: err.message });
    }
  }

  // answersById is already deduped (first answer per question_id wins,
  // Pass 32 X1) and merged across the initial call + the missing-question
  // retry. Return rows in question order.
  try {
    const ordered = questions.map((q) => answersById.get(q.id)).filter(Boolean);
    if (ordered.length < questions.length) {
      logger.warn('Response sim: persona still under-answered after retry', {
        personaId: persona.id, answered: ordered.length, total: questions.length,
      });
    }
    return ordered;
  } catch (err) {
    logger.warn('Response sim assembly failed', { personaId: persona.id, err: err.message });
    return [];
  }
}

/**
 * Check whether a persona's answer to a screening question passes the gate.
 *
 * Bug 1/2 fix: question may carry EITHER the new `qualifying_answers` array
 * (set by AI generator and frontend multi-toggle) OR the legacy
 * `screening_continue_on` / `qualifyingAnswer` fields. Prefer in order:
 *   qualifying_answers → screening_continue_on → qualifyingAnswer (single)
 *
 * @param {object} question  — the question object
 * @param {*}      answer    — the simulated answer
 * @returns {boolean}  true = passes (continue), false = screened out
 */
function passesScreening(question, answer) {
  if (!question.isScreening) return true; // non-screening questions always pass

  // Build the allowed-answers list from whichever field is present
  let continueOn = null;
  if (Array.isArray(question.qualifying_answers) && question.qualifying_answers.length > 0) {
    continueOn = question.qualifying_answers;
  } else if (Array.isArray(question.screening_continue_on) && question.screening_continue_on.length > 0) {
    continueOn = question.screening_continue_on;
  } else if (question.qualifyingAnswer) {
    continueOn = [question.qualifyingAnswer];
  }

  if (!continueOn || continueOn.length === 0) return true; // no gate defined → pass

  const norm = (v) => String(v ?? '').trim().toLowerCase();
  const answerNorm = norm(answer);
  return continueOn.some(c => norm(c) === answerNorm);
}

/**
 * ── Batch-path fault tolerance policy ────────────────────────────────
 *
 * Before this, the wave barrier was `await Promise.all(wave)` with NO
 * per-persona try/catch. A single failed Anthropic call — one 429, one
 * 529, one socket timeout — rejected the whole wave, propagated through
 * jobs/runMission.js into the fatal handler and marked a PAID mission
 * `failed`. Nothing is persisted incrementally on this path, so the
 * customer lost the entire run after minutes of burn.
 *
 * The recruitment loop (services/ai/recruitLoop.js) already had the
 * right posture: catch per persona, treat the failure as a wasted
 * generation, keep going. This mirrors it, with three additions the
 * batch path needs because it has no outer loop to top the order back up:
 *
 *  1. ONE deferred recovery sweep. Failures are collected across ALL
 *     waves and re-attempted once at the END of the run, not inline.
 *     By then the whole batch has elapsed, so a rate-limit window has
 *     almost certainly closed — a same-instant retry against a 429
 *     mostly just burns another call. This is a persona-level recovery
 *     sweep, NOT request-level retry/backoff; adding real backoff in
 *     services/ai/anthropic.js is the natural follow-up.
 *
 *  2. An HONEST count. The caller gets attempted / succeeded / failed
 *     and the failed persona ids, so jobs/runMission.js can prune the
 *     persona list before it derives total_simulated_count,
 *     qualified_respondent_count, qualification_rate and
 *     recruited_persona_count. Silently delivering N-1 while four
 *     columns still claim N is the failure mode that already bit this
 *     codebase (persona-id collision, n=59 of a 60-respondent order).
 *
 *  3. A failure ceiling. Dropping 1 of 60 is a partial delivery;
 *     dropping 55 of 60 is a failed mission dressed up as a success.
 *     Past the ceiling we throw, which routes to runMission's fatal
 *     handler → mission marked `failed` → the existing auto-refund
 *     messaging. Nothing is persisted before this point on the batch
 *     path, so the abort leaves no half-written state.
 *
 * Concurrency is UNCHANGED at 8 (see CONCURRENCY below).
 */

/**
 * Fraction of personas that may fail to simulate before the whole run is
 * treated as a failed mission rather than a partial delivery. Strictly
 * greater-than: exactly 20% is tolerated, 20.1% aborts.
 *
 * Why 20% — OWNER: this is the one number to tune.
 *  - The smallest paid tier is 10 respondents (pricingEngine.js
 *    CA_MIN_RESPONDENTS / `sniff_test`). 20% there is 2 personas, i.e.
 *    the widest ratio that still absorbs two independent transient
 *    blips on the smallest order without failing a paid mission.
 *  - On the large tiers (100 / 250) 20% means 20 / 50 personas lost.
 *    A loss that big is not a blip — it is a systemic condition (bad
 *    key, sustained rate limit, model outage) and shipping it as a
 *    success is exactly the dressed-up failure we are trying to avoid.
 *  - It is strictly tighter than the pre-existing row-count monitoring
 *    warn further down this file, which only fires once HALF the rows
 *    are already gone. That was an alarm, never a delivery gate.
 *  - Everything below the ceiling still delivers, but delivers HONESTLY:
 *    the shortfall reaches the persisted counters, it is not hidden.
 */
const MAX_SIMULATION_FAILURE_RATIO = 0.20;

/** Number of deferred end-of-run recovery sweeps over failed personas. */
const SIM_RECOVERY_SWEEPS = 1;

/** Pull the diagnostically useful bits off an SDK / network error. */
function describeSimError(err) {
  return {
    message: (err && err.message) || String(err),
    // Anthropic SDK APIError carries `status` (429 / 529 / 500 …).
    status:  (err && (err.status ?? err.statusCode)) ?? null,
    // `code` for socket errors (ETIMEDOUT, ECONNRESET), `error.type` for API errors.
    code:    (err && (err.code || (err.error && err.error.type))) || null,
    name:    (err && err.name) || null,
  };
}

/**
 * Simulate responses for all personas with capped concurrency.
 *
 * Screening gate (Part D.2): after simulation, personas that fail a
 * screening question have their non-screening responses discarded and
 * are flagged with `screened_out: true` in their persona_profile so
 * the results page can build a funnel card.
 *
 * @param {Array}  personas
 * @param {Array}  questions
 * @param {object} mission
 * @param {Function} [onProgress]  called with (completed, total)
 * @param {object}  [options]
 * @param {boolean} [options.enforceFailureCeiling=true]  when false, report the
 *        failures but never throw. Used for the screener-replacement top-up in
 *        runMission: those batches are tiny (often 1-2 personas), so one loss
 *        is >20% by arithmetic and would fail a mission whose MAIN batch is
 *        perfectly healthy. A replacement we cannot simulate simply doesn't
 *        become a replacement.
 * @returns {Promise<{
 *   responses: Array,        flat { persona_id, persona_profile, question_id, answer }
 *   attempted: number,       personas handed to us
 *   succeeded: number,       personas that produced >= 1 response row
 *   failed: number,          personas dropped after the recovery sweep
 *   failureRatio: number,
 *   failedPersonaIds: Array,
 *   failures: Array          [{ personaId, message, status, code, name, attempts }]
 * }>}
 *
 * NOTE: the return type changed from a bare Array to this object so the
 * failure count cannot be silently lost by a downstream .filter()/.map()
 * (a property hung off the array would have been). A stale caller fails
 * loudly on `.map is not a function` instead of quietly counting wrong.
 */
async function simulateAllResponses(personas, questions, mission, onProgress, options = {}) {
  const enforceFailureCeiling = options.enforceFailureCeiling !== false;
  // UNCHANGED — raising this is deliberately a separate change, landed
  // only after allSettled is verified in production.
  const CONCURRENCY = 8;
  const out = [];
  let completed = 0;
  const missionId = mission && mission.id;
  const roster = Array.isArray(personas) ? personas : [];

  // Pre-index questions by id for O(1) screening lookups.
  const questionById = Object.fromEntries((questions || []).map(q => [q.id, q]));

  // personaId → failure record. Keyed so the recovery sweep can clear
  // an entry when the retry succeeds.
  const failures = new Map();
  const keyOf = (persona, idx) => persona.persona_id || persona.id || `idx:${idx}`;

  /**
   * Run ONE persona end-to-end. Throws on failure; the caller decides.
   * Rows are staged locally and only appended once the persona is known
   * good, so a throw can never leave a half-written persona in `out`.
   */
  async function runPersona(persona) {
    const responses = await simulateResponses(persona, questions, mission);

    // Mirror recruitLoop's zero-response guard: a persona that produced
    // NO parseable answers is not a respondent. simulateResponses swallows
    // parse errors and returns [], so without this the batch path would
    // count an empty persona toward the delivered n — the same silent
    // overstatement the loop path already refuses.
    if (!Array.isArray(responses) || responses.length === 0) {
      const e = new Error('persona produced zero parseable responses');
      e.code = 'ZERO_RESPONSES';
      throw e;
    }

    // ── Screening gate ──────────────────────────────────────────────────
    // Walk through responses in order. Once a screening question is
    // answered with a non-qualifying response, mark the persona as
    // screened out and discard all subsequent answers.
    let screenedOut = false;
    const keptResponses = [];

    for (const r of responses) {
      const q = questionById[r.question_id];
      if (!screenedOut) {
        keptResponses.push(r);
        if (q && q.isScreening && !passesScreening(q, r.answer)) {
          screenedOut = true; // stop keeping further responses
        }
      }
      // Screened-out responses after the gate are intentionally dropped.
    }
    // ───────────────────────────────────────────────────────────────────

    const personaProfile = screenedOut
      ? { ...persona, screened_out: true }
      : persona;

    const staged = keptResponses.map((r) => ({
      persona_id:      persona.id,
      persona_profile: personaProfile,
      question_id:     r.question_id,
      answer:          r.answer,
      // Pass 22 Bug 22.14 — reasoning trace passed through to runMission
      // for persistence into persona_response_reasoning when the mission
      // is small enough (<=50 personas).
      reasoning:       typeof r.reasoning === 'string' ? r.reasoning : null,
    }));

    out.push(...staged);

    completed += 1;
    if (onProgress) onProgress(completed, roster.length);
  }

  /**
   * Drive `list` through capped-concurrency waves. One persona's
   * rejection can no longer take the wave with it: Promise.allSettled
   * waits for every task and hands back each outcome individually.
   */
  async function runWaves(list, { attempt }) {
    for (let i = 0; i < list.length; i += CONCURRENCY) {
      const slice = list.slice(i, i + CONCURRENCY);
      const settled = await Promise.allSettled(
        slice.map((entry) => runPersona(entry.persona)),
      );
      settled.forEach((res, idx) => {
        const { persona, key } = slice[idx];
        if (res.status === 'fulfilled') {
          failures.delete(key); // recovery sweep succeeded
          return;
        }
        const detail = describeSimError(res.reason);
        failures.set(key, { personaId: key, attempts: attempt, ...detail });
        logger.warn('simulateAllResponses: persona simulation failed', {
          missionId,
          personaId: key,
          attempt,
          status: detail.status,
          code: detail.code,
          err: detail.message,
        });
      });
    }
  }

  const entries = roster.map((persona, idx) => ({ persona, key: keyOf(persona, idx) }));
  await runWaves(entries, { attempt: 1 });

  // ── Deferred recovery sweep ────────────────────────────────────────
  // Retry each failed persona ONCE, after every wave has run. The delay
  // is free (it is the rest of the batch) and is what makes the retry
  // worth making at all against a rate-limit window.
  for (let sweep = 1; sweep <= SIM_RECOVERY_SWEEPS && failures.size > 0; sweep += 1) {
    const retryKeys = new Set(failures.keys());
    const retryEntries = entries.filter((e) => retryKeys.has(e.key));
    logger.warn('simulateAllResponses: recovery sweep for failed personas', {
      missionId, sweep, count: retryEntries.length, of: roster.length,
    });
    await runWaves(retryEntries, { attempt: sweep + 1 });
  }

  const attempted = roster.length;
  const failed = failures.size;
  const succeeded = attempted - failed;
  const failureRatio = attempted > 0 ? failed / attempted : 0;
  const failureList = Array.from(failures.values());

  if (failed > 0) {
    logger.error('simulateAllResponses: personas lost to simulation failures', {
      missionId,
      attempted,
      succeeded,
      failed,
      failureRatio: Number(failureRatio.toFixed(4)),
      failedPersonaIds: failureList.map((f) => f.personaId),
      // First few reasons, so the Railway line is diagnosable without a join.
      reasons: failureList.slice(0, 5).map((f) => ({
        personaId: f.personaId, status: f.status, code: f.code, err: f.message,
      })),
    });
  }

  // ── Failure ceiling ────────────────────────────────────────────────
  if (enforceFailureCeiling && attempted > 0 && failureRatio > MAX_SIMULATION_FAILURE_RATIO) {
    const err = new Error(
      `simulation failed for ${failed}/${attempted} personas `
      + `(${(failureRatio * 100).toFixed(1)}% > ${(MAX_SIMULATION_FAILURE_RATIO * 100).toFixed(0)}% ceiling); `
      + 'refusing to deliver a gutted sample as a completed mission',
    );
    err.code = 'SIMULATION_FAILURE_THRESHOLD';
    err.attempted = attempted;
    err.failed = failed;
    err.succeeded = succeeded;
    throw err;
  }

  // Pass 32 X1 — contract verification. The customer paid for
  // mission.respondent_count personas; out is the flat
  // (persona × question) row list. Expected total = personas × Q
  // when no screening kicked in, less when some personas got
  // screened out. We log when actual diverges by >25% so production
  // monitoring can flag mid-flight regressions early.
  //
  // Denominator is now `succeeded`, not the full roster: personas we
  // already reported as lost must not re-trigger this alarm.
  const expectedRows = succeeded * (questions || []).length;
  if (expectedRows > 0) {
    const ratio = out.length / expectedRows;
    if (ratio < 0.5 || ratio > 1.5) {
      logger.warn('simulateAllResponses: row count diverges from expected', {
        missionId,
        personaCount: succeeded,
        failedPersonaCount: failed,
        questionCount: (questions || []).length,
        expected: expectedRows,
        actual: out.length,
        ratio: Number(ratio.toFixed(2)),
      });
    }
  }

  return {
    responses: out,
    attempted,
    succeeded,
    failed,
    failureRatio,
    failedPersonaIds: failureList.map((f) => f.personaId),
    failures: failureList,
  };
}

// Pass 42 A2 — passesScreening exported so the recruitment loop in
// services/ai/recruitLoop.js can apply the same screening logic
// without duplicating it.
module.exports = {
  simulateResponses,
  simulateAllResponses,
  passesScreening,
  // Fault-tolerance knobs — owner-tunable; exported for the tests that
  // pin the threshold behaviour.
  MAX_SIMULATION_FAILURE_RATIO,
  SIM_RECOVERY_SWEEPS,
  // Pass 47 — exported for the type-coverage invariant test + reuse.
  SUPPORTED_QUESTION_TYPES,
  tokenBudgetFor,
};
