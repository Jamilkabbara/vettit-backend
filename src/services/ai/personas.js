/**
 * VETT — Persona generation.
 *
 * Generates N synthetic respondent personas matching the mission's targeting.
 * Uses Haiku (high volume, low cost) with prompt caching on the stable system prompt.
 *
 * Pass 23 Bug 23.25 v2 — constraint-based generation. We tell the model
 * about the screener criteria + screening questions up front so every
 * generated persona is one who would qualify. This replaces the prior
 * generate-then-filter pipeline (which under-delivered when the screener
 * was strict because most random personas failed) with a generate-to-spec
 * pipeline that always delivers. Screening still runs in simulate.js as a
 * defensive belt-and-suspenders check; runMission's defensive-retry loop
 * catches the rare model miss.
 */

const { callClaude, extractJSON } = require('./anthropic');
const { WRITING_STYLE } = require('./writingStyle');
const logger = require('../../utils/logger');

// Stable system prompt, cached across all calls within a mission to cut costs ~50% on inputs.
const PERSONA_SYSTEM_PROMPT = `You are VETT's persona simulation engine. Your job is to create realistic, diverse synthetic market-research respondents that match a given targeting specification.

Rules:
- Each persona must feel like a real individual, not a demographic template.
- Distribute attributes realistically across the sample (don't cluster, reflect plausible population statistics).
- Give each persona a believable interior life: motivations, anxieties, day-to-day habits, decision triggers.
- Never use real names of public figures. Use first names plausible for the target geography and gender.
- Stay within the targeting constraints supplied. If a constraint is missing, use the most reasonable distribution for the market.
- When screening criteria are provided, every persona MUST satisfy ALL of them. Make the persona's profile, behaviors, and stated answers consistent with those criteria. The persona must believably exist within the gated segment, not be a random sample who happens to be evaluated against the gate.
- Output must be STRICTLY VALID JSON matching the requested schema, no commentary, no markdown code fences around the JSON.

You understand MENA, Gulf, European, US, and global markets equally well. You handle B2B, B2C, and niche segments.
${WRITING_STYLE}`;

/**
 * Build the screener-constraint block injected into every batch prompt.
 * Pass 23 Bug 23.25 v2 — pulls both:
 *   1. mission.screener_criteria (Pass 22 Bug 22.24 user-editable JSON)
 *   2. The screening questions in mission.questions, with their qualifying
 *      answers so the model knows the exact gate values it must satisfy.
 *
 * `stricter=true` (passed by the runMission retry path) tells the model the
 * previous attempt missed and asks for an extra-careful pass.
 */
function buildScreenerConstraints(mission, { stricter = false } = {}) {
  const screenerCriteria = mission.screener_criteria || null;
  const screeningQs = (mission.questions || []).filter(
    (q) => q && (q.isScreening || q.is_screening),
  );
  if (!screenerCriteria && screeningQs.length === 0) return '';

  const lines = ['', 'SCREENING CRITERIA (the persona MUST satisfy these — not "could pass", but "is"):'];
  if (screenerCriteria) {
    if (typeof screenerCriteria === 'string') {
      lines.push(`- ${screenerCriteria}`);
    } else if (Array.isArray(screenerCriteria)) {
      for (const c of screenerCriteria) lines.push(`- ${typeof c === 'string' ? c : JSON.stringify(c)}`);
    } else if (typeof screenerCriteria === 'object') {
      for (const [k, v] of Object.entries(screenerCriteria)) {
        lines.push(`- ${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`);
      }
    }
  }
  if (screeningQs.length > 0) {
    lines.push('Screening questions (the persona must answer with one of the qualifying answers):');
    for (const q of screeningQs) {
      const qualifying =
        Array.isArray(q.qualifying_answers) && q.qualifying_answers.length > 0
          ? q.qualifying_answers
          : Array.isArray(q.screening_continue_on) && q.screening_continue_on.length > 0
            ? q.screening_continue_on
            : q.qualifyingAnswer
              ? [q.qualifyingAnswer]
              : null;
      const qText = q.text || q.question || q.title || '(unnamed)';
      const qAnswers = qualifying ? qualifying.join(' OR ') : 'no specific gate';
      lines.push(`  Q: "${qText}" — qualifying answers: ${qAnswers}`);
    }
  }
  if (stricter) {
    lines.push('');
    lines.push(
      'CRITICAL: a previous generation attempt produced personas that did NOT satisfy these criteria. ' +
      'Be especially careful this time. Each persona must be UNAMBIGUOUSLY inside the gated segment ' +
      'across all attributes — profession, geography, behavior, stated answer to the screener.',
    );
  }
  return lines.join('\n');
}

/**
 * Generate N personas in batches of BATCH_SIZE.
 * @param {object} mission  Full mission row
 * @param {number} count    How many personas to generate
 * @param {object} [options]
 * @param {boolean} [options.stricter=false]  Pass 23 Bug 23.25 v2 — set on retry rounds
 *                                            after a constraint violation; the model gets
 *                                            an extra-careful instruction.
 * @param {number}  [options.startOffset=0]    Persona id offset; used by the retry path
 *                                            so replacement IDs don't collide with the
 *                                            originals.
 * @returns {Promise<Array>} Array of persona objects
 */
async function generatePersonas(mission, count, options = {}) {
  const BATCH_SIZE = 10;
  const batches = Math.ceil(count / BATCH_SIZE);
  const targeting = mission.targeting || {};
  const startOffset = Number(options.startOffset) || 0;
  const allPersonas = [];

  logger.info('Persona generation starting', {
    missionId: mission.id, count, batches, stricter: !!options.stricter, startOffset,
  });

  // Launch batches in parallel (capped concurrency of 5 to avoid rate limits)
  const CONCURRENCY = 5;
  for (let i = 0; i < batches; i += CONCURRENCY) {
    const wave = [];
    for (let j = i; j < Math.min(i + CONCURRENCY, batches); j++) {
      const batchCount = Math.min(BATCH_SIZE, count - j * BATCH_SIZE);
      const startIndex = startOffset + j * BATCH_SIZE;
      wave.push(generatePersonaBatch(mission, targeting, batchCount, startIndex, options));
    }
    const results = await Promise.all(wave);
    for (const batch of results) allPersonas.push(...batch);
  }

  logger.info('Persona generation complete', { missionId: mission.id, generated: allPersonas.length });
  return allPersonas.slice(0, count);
}

async function generatePersonaBatch(mission, targeting, batchCount, startIndex, options = {}) {
  const countries = targeting.geography?.countries?.join(', ') || 'Global';
  const cities = targeting.geography?.cities?.join(', ') || 'Any';
  const ageRanges = targeting.demographics?.ageRanges?.join(', ') || '18-65';
  const genders = targeting.demographics?.genders?.join(', ') || 'All';
  const b2b = targeting.b2b || targeting.professional;
  const psycho = targeting.psychographics;
  const screenerBlock = buildScreenerConstraints(mission, { stricter: !!options.stricter });

  const userPrompt = `Generate ${batchCount} synthetic respondents for this research mission.

Mission goal: ${mission.goal_type || 'general research'}
Brief: ${mission.brief || mission.mission_statement || ''}

Targeting constraints:
- Countries: ${countries}
- Cities: ${cities}
- Age ranges: ${ageRanges}
- Genders: ${genders}
${b2b ? `- B2B/Professional: ${JSON.stringify(b2b)}` : ''}
${psycho ? `- Psychographics: ${JSON.stringify(psycho)}` : ''}
${screenerBlock}

Starting persona ID index: P${String(startIndex + 1).padStart(3, '0')}

Return ONLY this JSON:
{
  "personas": [
    {
      "id": "P001",
      "first_name": "Layla",
      "age": 28,
      "gender": "female",
      "country": "AE",
      "city": "Dubai",
      "occupation": "Product Manager",
      "industry": "Fintech",
      "seniority": "mid",
      "income_band": "mid",
      "education": "Bachelor's",
      "marital_status": "single",
      "psychographics": ["tech-forward", "career-driven", "time-poor"],
      "values": ["efficiency", "family", "status"],
      "pain_points": ["juggling work and personal life"],
      "decision_style": "analytical",
      "short_bio": "A 28-year-old Dubai-based PM who ..."
    }
  ]
}

Generate exactly ${batchCount} personas. Vary ALL attributes realistically. IDs must be sequential starting from P${String(startIndex + 1).padStart(3, '0')}.`;

  const response = await callClaude({
    callType: 'persona_gen',
    missionId: mission.id,
    userId: mission.user_id,
    messages: [{ role: 'user', content: userPrompt }],
    systemPrompt: PERSONA_SYSTEM_PROMPT,
    maxTokens: 4000,
    enablePromptCache: true,
  });

  try {
    const parsed = extractJSON(response.text);
    return parsed.personas || [];
  } catch (err) {
    logger.warn('Persona batch parse failed — skipping batch', { err: err.message });
    return [];
  }
}

module.exports = { generatePersonas };
