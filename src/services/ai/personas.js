/**
 * VETT — Persona generation.
 * Generates N synthetic respondent personas matching the mission's targeting.
 * Uses Haiku (high volume, low cost) with prompt caching on the stable system prompt.
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
- Output must be STRICTLY VALID JSON matching the requested schema, no commentary, no markdown code fences around the JSON.

You understand MENA, Gulf, European, US, and global markets equally well. You handle B2B, B2C, and niche segments.
${WRITING_STYLE}`;

/**
 * Generate N personas in batches of BATCH_SIZE.
 * @param {object} mission  Full mission row
 * @param {number} count    How many personas to generate
 * @returns {Promise<Array>} Array of persona objects
 */
async function generatePersonas(mission, count) {
  const BATCH_SIZE = 10;
  const batches = Math.ceil(count / BATCH_SIZE);
  const targeting = mission.targeting || {};
  const allPersonas = [];

  logger.info('Persona generation starting', { missionId: mission.id, count, batches });

  // Launch batches in parallel (capped concurrency of 5 to avoid rate limits)
  const CONCURRENCY = 5;
  for (let i = 0; i < batches; i += CONCURRENCY) {
    const wave = [];
    for (let j = i; j < Math.min(i + CONCURRENCY, batches); j++) {
      const batchCount = Math.min(BATCH_SIZE, count - j * BATCH_SIZE);
      const startIndex = j * BATCH_SIZE;
      wave.push(generatePersonaBatch(mission, targeting, batchCount, startIndex));
    }
    const results = await Promise.all(wave);
    for (const batch of results) allPersonas.push(...batch);
  }

  logger.info('Persona generation complete', { missionId: mission.id, generated: allPersonas.length });
  return allPersonas.slice(0, count);
}

async function generatePersonaBatch(mission, targeting, batchCount, startIndex) {
  const countries = targeting.geography?.countries?.join(', ') || 'Global';
  const cities = targeting.geography?.cities?.join(', ') || 'Any';
  const ageRanges = targeting.demographics?.ageRanges?.join(', ') || '18-65';
  const genders = targeting.demographics?.genders?.join(', ') || 'All';
  const b2b = targeting.b2b || targeting.professional;
  const psycho = targeting.psychographics;

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
