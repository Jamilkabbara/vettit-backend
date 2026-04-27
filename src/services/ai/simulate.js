/**
 * VETT — Response simulation.
 * For each persona, answers every question in the mission as that persona would.
 * Uses Haiku (highest volume of any call in the pipeline).
 */

const { callClaude, extractJSON } = require('./anthropic');
const { WRITING_STYLE } = require('./writingStyle');
const logger = require('../../utils/logger');

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
  const userPrompt = `You are this persona:
${JSON.stringify(persona, null, 2)}

Mission brief: ${mission.brief || mission.mission_statement || ''}

Answer every question below as this persona. For each question:
- "single" / "opinion" → pick ONE option from the provided options
- "multi"              → pick 1-N options from the provided options (only select what the persona actually agrees with)
- "rating"             → a whole number 1 to 5
- "text"               → 1-3 sentences in the persona's voice (free text)

For EVERY answer, also include a "reasoning" field: 1 to 2 sentences explaining
why this persona answered that way given their context. Be specific to the
persona (their job, family, anxieties, decision triggers). Do not be generic.

Questions:
${questions.map((q, i) => {
  const opts = (q.options && q.options.length) ? `\n   options: ${JSON.stringify(q.options)}` : '';
  return `${i + 1}. [${q.id}] (${q.type}) ${q.text}${opts}`;
}).join('\n')}

Return ONLY this JSON:
{
  "responses": [
    { "question_id": "q1", "answer": "Option A", "reasoning": "1-2 sentences in persona's voice." },
    { "question_id": "q2", "answer": ["Option A", "Option C"], "reasoning": "..." },
    { "question_id": "q3", "answer": 4, "reasoning": "..." },
    { "question_id": "q4", "answer": "I'm honestly torn. The price feels high but...", "reasoning": "..." }
  ]
}`;

  const response = await callClaude({
    callType:  'response_sim',
    missionId: mission.id,
    userId:    mission.user_id,
    messages:  [{ role: 'user', content: userPrompt }],
    systemPrompt: SIM_SYSTEM_PROMPT,
    maxTokens: 1500,
    enablePromptCache: true,
  });

  try {
    const parsed = extractJSON(response.text);
    return parsed.responses || [];
  } catch (err) {
    logger.warn('Response sim parse failed', { personaId: persona.id, err: err.message });
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
 * @returns {Promise<Array>} flat array of { persona_id, persona_profile, question_id, answer }
 */
async function simulateAllResponses(personas, questions, mission, onProgress) {
  const CONCURRENCY = 8;
  const out = [];
  let completed = 0;

  // Pre-index questions by id for O(1) screening lookups.
  const questionById = Object.fromEntries((questions || []).map(q => [q.id, q]));

  for (let i = 0; i < personas.length; i += CONCURRENCY) {
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

  return out;
}

module.exports = { simulateResponses, simulateAllResponses };
