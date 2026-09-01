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
 * @param {object}   [opts]
 * @param {Function} [opts.shouldAbort]  Pass 49 mid-run kill switch. Called
 *   once per concurrency wave (NOT per persona). Return truthy to stop
 *   simulating and return the partial `out` collected so far. It is a plain
 *   synchronous predicate so it costs nothing: the caller does its own
 *   throttled status read from `onProgress` and just flips a boolean here.
 *   Aborting RETURNS partial work — it never throws, because throwing would
 *   route into runMission's fatal handler and try to write 'failed' over
 *   whatever terminal state the other writer set.
 * @returns {Promise<Array>} flat array of { persona_id, persona_profile, question_id, answer }
 */
async function simulateAllResponses(personas, questions, mission, onProgress, opts = {}) {
  const CONCURRENCY = 8;
  const { shouldAbort = null } = opts;
  const out = [];
  let completed = 0;
  let aborted = false;

  // Pre-index questions by id for O(1) screening lookups.
  const questionById = Object.fromEntries((questions || []).map(q => [q.id, q]));

  for (let i = 0; i < personas.length; i += CONCURRENCY) {
    // Pass 49 — wave boundary is the clean break point: no in-flight
    // simulation is discarded, and everything already collected is kept.
    if (shouldAbort && shouldAbort()) {
      aborted = true;
      logger.warn('simulateAllResponses: aborted mid-run by shouldAbort', {
        missionId: mission?.id, completed, total: personas.length,
      });
      break;
    }
    const wave = personas.slice(i, i + CONCURRENCY).map(async (persona) => {
      const responses = await simulateResponses(persona, questions, mission);

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

      for (const r of keptResponses) {
        out.push({
          persona_id:      persona.id,
          persona_profile: personaProfile,
          question_id:     r.question_id,
          answer:          r.answer,
          // Pass 22 Bug 22.14 — reasoning trace passed through to runMission
          // for persistence into persona_response_reasoning when the mission
          // is small enough (<=50 personas).
          reasoning:       typeof r.reasoning === 'string' ? r.reasoning : null,
        });
      }

      completed += 1;
      if (onProgress) onProgress(completed, personas.length);
    });
    await Promise.all(wave);
  }

  // Pass 32 X1 — contract verification. The customer paid for
  // mission.respondent_count personas; out is the flat
  // (persona × question) row list. Expected total = personas × Q
  // when no screening kicked in, less when some personas got
  // screened out. We log when actual diverges by >25% so production
  // monitoring can flag mid-flight regressions early.
  // Pass 49 — an aborted run is short BY DESIGN; the divergence warn below
  // would be pure noise (and misleading in the logs) for that case.
  const expectedRows = aborted ? 0 : personas.length * (questions || []).length;
  if (expectedRows > 0) {
    const ratio = out.length / expectedRows;
    if (ratio < 0.5 || ratio > 1.5) {
      const Logger = require('../../utils/logger');
      Logger.warn('simulateAllResponses: row count diverges from expected', {
        missionId: mission?.id,
        personaCount: personas.length,
        questionCount: (questions || []).length,
        expected: expectedRows,
        actual: out.length,
        ratio: Number(ratio.toFixed(2)),
      });
    }
  }

  return out;
}

// Pass 42 A2 — passesScreening exported so the recruitment loop in
// services/ai/recruitLoop.js can apply the same screening logic
// without duplicating it.
module.exports = {
  simulateResponses,
  simulateAllResponses,
  passesScreening,
  // Pass 47 — exported for the type-coverage invariant test + reuse.
  SUPPORTED_QUESTION_TYPES,
  tokenBudgetFor,
};
