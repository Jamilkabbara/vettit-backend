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
const { DEFAULT_SIM_TEMPERATURE } = require('./simMeta');
const { WRITING_STYLE } = require('./writingStyle');
const logger = require('../../utils/logger');
const { resolveEffectiveTargeting } = require('../missions/effectiveTargeting');
const { identity, isNearDuplicate, allowedTopName } = require('./panelDistinctness');

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

// ── Panel diversity ──────────────────────────────────────────────────────
// An identical prompt returns the model's single most likely persona. The
// recruit loop asked for one persona at a time with the same prompt and got
// "Marcus, 34, Austin" 239 times out of 240 (10ecb820). Temperature does not
// fix that; information does. Every batch now carries (a) a code-assigned
// age and gender slot per persona, spread evenly across the requested ranges,
// and (b) a summary of who is already in the panel. The guard in
// generatePersonas then rejects any clone that still slips through
// (panelDistinctness.js is the definition) and tops up.

/** Parse "25-34", "55+", "18 - 24" into [lo, hi]. */
function parseAgeRange(r) {
  const m = String(r).match(/(\d{2})\s*(?:-|–|to)\s*(\d{2})/);
  if (m) return [Number(m[1]), Number(m[2])];
  const plus = String(r).match(/(\d{2})\s*\+/);
  if (plus) return [Number(plus[1]), Math.min(Number(plus[1]) + 15, 80)];
  return null;
}

/**
 * Deterministic, evenly spread slot for panel position `index`. Ages follow a
 * golden-ratio sequence over the union of the requested ranges, so any run of
 * consecutive slots (a batch of 1 or of 10, a resumed run) is spread out.
 */
function slotFor(index, targeting) {
  const demo = targeting.demographics || {};
  const ranges = (demo.ageRanges || targeting.ageRanges || []).map(parseAgeRange).filter(Boolean);
  const spans = ranges.length ? ranges : [[18, 65]];
  const total = spans.reduce((s, [lo, hi]) => s + (hi - lo + 1), 0);
  let pos = Math.floor(((index * 0.6180339887498949) % 1) * total);
  let age = spans[0][0];
  for (const [lo, hi] of spans) {
    const width = hi - lo + 1;
    if (pos < width) { age = lo + pos; break; }
    pos -= width;
  }
  const allowed = (demo.genders || targeting.genders || [])
    .map((g) => String(g).toLowerCase())
    .filter((g) => /^(male|female|men|women|man|woman)$/.test(g))
    .map((g) => (g.startsWith('f') || g.startsWith('wom') ? 'female' : 'male'));
  const genders = allowed.length ? [...new Set(allowed)] : ['female', 'male'];
  return { age, gender: genders[index % genders.length] };
}

/** Compact "who is already here" block. Bounded so a 1,000-person panel stays a small prompt. */
function buildPanelSoFar(prior) {
  if (!prior || prior.length === 0) return '';
  const count = (key) => {
    const m = new Map();
    for (const p of prior) {
      const v = identity(p)[key];
      if (v) m.set(v, (m.get(v) || 0) + 1);
    }
    return [...m.entries()].sort((a, b) => b[1] - a[1]);
  };
  const names = count('name').map(([n]) => n).slice(0, 250);
  const fmt = (rows, max) => rows.slice(0, max).map(([v, c]) => `${v} (${c})`).join(', ');
  return `
ALREADY IN THIS PANEL (${prior.length} respondents). Each new persona must be a different person from all of them:
- First names already used, do not reuse any: ${names.join(', ')}
- Cities so far: ${fmt(count('city'), 30)}
- Occupations so far: ${fmt(count('occupation'), 40)}
Spread new personas across cities and occupations that are under-represented above, within the targeting.`;
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
 * @param {Array}   [options.priorPersonas]    Everyone already in the panel. New personas
 *                                            are told about them and must not duplicate them.
 * @returns {Promise<Array>} Array of persona objects
 */
/**
 * Pass 49 — bounded top-up rounds when de-duplication leaves us short.
 * Bounded so a model that keeps re-emitting the same ids cannot spin.
 */
const MAX_TOPUP_ROUNDS = 3;

/** Id-space stride between top-up rounds, to keep replacement ids clear. */
const PERSONA_ID_ROUND_STRIDE = 1000;

async function generatePersonas(mission, count, options = {}) {
  const BATCH_SIZE = 10;
  const CONCURRENCY = 5;
  // The targeting the customer sees on their dashboard, not only the saved
  // column: the setup page never saves targeting, and an empty column used to
  // prompt "Countries: Global" (see services/missions/effectiveTargeting.js).
  const effective = resolveEffectiveTargeting(mission);
  const targeting = effective.targeting || {};
  const startOffset = Number(options.startOffset) || 0;
  const missionId = mission.id;

  // Pass 49 — persona ids are ASSIGNED BY THE MODEL, not by us. The prompt
  // asks for "sequential starting from P<startIndex+1>" and even shows
  // "id": "P001" in its example schema, so a batch can (and does) ignore the
  // offset and re-emit an id another batch already produced. The 5 batches in
  // a wave run in parallel and cannot see each other's output.
  //
  // Observed on a fresh 60-respondent run (e8c8f1e1, 2026-08-31): a batch
  // parse failed and retried, generation reported 61 for count=60, and two
  // DIFFERENT simulated people carried the same persona_id. Before the
  // pass-48 unique index that silently persisted as one persona_id holding
  // two profiles and two sets of answers — corrupting every distribution
  // computed off the table. With the index it became a short count instead:
  // 12 rows skipped, analysis.n=59 against respondent_count=60. A customer
  // paid for 60 and received 59.
  //
  // Same failure the recruit loop already guards (recruitLoop.js ~L286
  // "generated a persona_id already persisted; discarding"). This is the
  // batch path's equivalent: drop the collision, then top up so the
  // requested count is still delivered.
  //
  // Why DROP rather than RENUMBER the colliding persona: a re-emitted id is
  // ambiguous evidence. It can mean two distinct people that happened to
  // collide (renumbering would be right) or the model re-emitting the SAME
  // person twice (renumbering would silently clone a respondent into the
  // sample and inflate n). Dropping is correct under both readings; the
  // top-up pays for the replacement.
  const seen = new Set();
  const excluded = options.excludeIds;
  for (const id of (excluded instanceof Set ? excluded : Array.isArray(excluded) ? excluded : [])) {
    if (id) seen.add(String(id));
  }
  const kept = [];
  let droppedDuplicate = 0;
  let droppedNoId = 0;
  let droppedClone = 0;

  // Everyone the new personas must differ from: the panel so far plus what
  // this call has already kept. Opinions do not exist yet at this point, so
  // this is the identity half of panelDistinctness's rule.
  const prior = Array.isArray(options.priorPersonas) ? options.priorPersonas.filter(Boolean) : [];
  const panel = prior.map(identity);
  const nameCounts = new Map();
  for (const p of panel) if (p.name) nameCounts.set(p.name, (nameCounts.get(p.name) || 0) + 1);
  // Half the measured ceiling: generation keeps well clear of the line the
  // panel is judged against.
  const panelSize = Math.max(prior.length + count, Number(options.panelSize) || 0);
  const nameCap = Math.max(1, Math.floor(allowedTopName(panelSize) / 2));

  const absorb = (batch) => {
    for (const persona of (batch || [])) {
      if (kept.length >= count) break; // never return more than requested
      const rawId = persona && (persona.persona_id || persona.id);
      if (!rawId) { droppedNoId += 1; continue; }
      const key = String(rawId);
      if (seen.has(key)) { droppedDuplicate += 1; continue; }
      const me = identity(persona);
      if (panel.some((p) => isNearDuplicate(me, p)) || (me.name && (nameCounts.get(me.name) || 0) >= nameCap)) {
        droppedClone += 1;
        continue;
      }
      seen.add(key);
      panel.push(me);
      if (me.name) nameCounts.set(me.name, (nameCounts.get(me.name) || 0) + 1);
      kept.push(persona);
    }
  };

  // One generation round: `need` personas, ids starting at `offset`.
  const runRound = async (need, offset) => {
    const batches = Math.ceil(need / BATCH_SIZE);
    for (let i = 0; i < batches; i += CONCURRENCY) {
      const wave = [];
      for (let j = i; j < Math.min(i + CONCURRENCY, batches); j += 1) {
        const batchCount = Math.min(BATCH_SIZE, need - j * BATCH_SIZE);
        const startIndex = offset + j * BATCH_SIZE;
        wave.push({ batchCount, startIndex });
      }
      // Batches in a wave run in parallel, so they cannot see each other.
      // Each gets the panel as it stood when the wave began, and distinct
      // slots; the guard in absorb() catches any cross-batch clone.
      const soFar = [...prior, ...kept];
      const results = await Promise.all(wave.map(({ batchCount, startIndex }) =>
        generatePersonaBatch(mission, targeting, batchCount, startIndex, { ...options, soFar })));
      for (const batch of results) absorb(batch);
    }
  };

  logger.info('Persona generation starting', {
    missionId, count, batches: Math.ceil(count / BATCH_SIZE),
    targetingSource: effective.source, countries: effective.countries,
    stricter: !!options.stricter, startOffset, excludedIds: seen.size,
  });

  await runRound(count, startOffset);

  // ── Top up ────────────────────────────────────────────────────────────
  // Shortfall here means duplicate ids were dropped, or a batch was dropped
  // entirely after its parse retry. Either way the customer paid for `count`
  // distinct respondents, so ask for the difference. Each round starts its
  // ids well clear of everything used so far to make another collision
  // unlikely; the dedupe above is what makes it IMPOSSIBLE rather than
  // unlikely, so a round that still collides simply tops up again.
  let topUpRounds = 0;
  let nextOffset = startOffset + count;
  while (kept.length < count && topUpRounds < MAX_TOPUP_ROUNDS) {
    topUpRounds += 1;
    const need = count - kept.length;
    nextOffset += PERSONA_ID_ROUND_STRIDE;
    logger.warn('Persona generation: short after de-duplication, topping up', {
      missionId, need, have: kept.length, requested: count,
      droppedDuplicate, droppedNoId, droppedClone, topUpRound: topUpRounds, nextOffset,
    });
    await runRound(need, nextOffset);
  }

  if (kept.length < count) {
    // FAIL LOUD in the log. Do not throw: a short persona set still produces
    // a usable (smaller) report, and throwing here would fail a paid mission
    // outright. runMission's own accounting reports the real delivered n.
    logger.error('Persona generation: still short after top-up rounds', {
      missionId, requested: count, generated: kept.length,
      droppedDuplicate, droppedNoId, droppedClone, topUpRounds,
    });
  }

  logger.info('Persona generation complete', {
    missionId,
    generated: kept.length,
    requested: count,
    uniqueIds: new Set(kept.map((p) => String(p.persona_id || p.id))).size,
    droppedDuplicate,
    droppedNoId,
    droppedClone,
    topUpRounds,
  });
  return kept;
}

async function generatePersonaBatch(mission, targeting, batchCount, startIndex, options = {}) {
  // Read BOTH the nested (geography.countries) and flat (targeting.countries)
  // shapes — a flat targeting object silently fell through to "Global", so the
  // generator was unconstrained and emitted off-target strays (e.g. an "AE"
  // persona in an SA+EG study, anchored by the example below).
  const geo = targeting.geography || {};
  const demo = targeting.demographics || {};
  const countries = (geo.countries || targeting.countries || []).join(', ') || 'Global';
  const cities = (geo.cities || targeting.cities || []).join(', ') || 'Any';
  const ageRanges = (demo.ageRanges || targeting.ageRanges || []).join(', ') || '18-65';
  const genders = (demo.genders || targeting.genders || []).join(', ') || 'All';
  const b2b = targeting.b2b || targeting.professional;
  const psycho = targeting.psychographics;
  const screenerBlock = buildScreenerConstraints(mission, { stricter: !!options.stricter });
  const slotLines = Array.from({ length: batchCount }, (_, i) => {
    const slot = slotFor(startIndex + i, targeting);
    return `- P${String(startIndex + i + 1).padStart(3, '0')}: ${slot.gender}, age ${slot.age}`;
  }).join('\n');

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

${buildPanelSoFar(options.soFar)}

Starting persona ID index: P${String(startIndex + 1).padStart(3, '0')}

Persona slots (one persona per slot, in this order; age and gender are fixed, everything else is yours to vary; if a slot contradicts the screening criteria, the screening criteria win):
${slotLines}

Return ONLY this JSON:
{
  "personas": [
    {
      "id": "<slot id>",
      "first_name": "<first name plausible for the country and gender>",
      "age": <slot age>,
      "gender": "<slot gender>",
      "country": "<ISO country code within the targeting>",
      "city": "<city>",
      "occupation": "<occupation>",
      "industry": "<industry>",
      "seniority": "<junior|mid|senior|executive|n/a>",
      "income_band": "<low|lower-mid|mid|upper-mid|high>",
      "education": "<highest education>",
      "marital_status": "<status>",
      "psychographics": ["<trait>", "<trait>", "<trait>"],
      "values": ["<value>", "<value>", "<value>"],
      "pain_points": ["<pain point>"],
      "decision_style": "<style>",
      "short_bio": "<one or two sentences>"
    }
  ]
}

Generate exactly ${batchCount} personas, one per slot. Every persona must be a different person: no two share a first name, and none repeats a first name already in the panel.`;

  // 10 rich personas (prose bios + several arrays) overflowed the old 4000-token
  // cap → truncated JSON → "Unexpected end of JSON input" → the WHOLE batch was
  // silently dropped (run a39ce46e: 70/80). Give the batch real headroom
  // (persona_gen runs on haiku-4-5, which supports it) and retry once on a parse
  // failure before giving up — same treatment as the synthesis fix (#74).
  const callAndParse = async () => {
    const response = await callClaude({
      temperature: DEFAULT_SIM_TEMPERATURE,
      callType: 'persona_gen',
      missionId: mission.id,
      userId: mission.user_id,
      messages: [{ role: 'user', content: userPrompt }],
      systemPrompt: PERSONA_SYSTEM_PROMPT,
      maxTokens: 8000,
      enablePromptCache: true,
    });
    try {
      return extractJSON(response.text).personas || [];
    } catch (err) {
      logger.warn('Persona batch parse failed (will retry once)', { missionId: mission.id, err: err.message });
      return null;
    }
  };
  let personas = await callAndParse();
  if (personas == null) personas = await callAndParse();
  if (personas == null) {
    logger.error('Persona batch dropped after retry — generated n will fall short', {
      missionId: mission.id, batchCount, startIndex,
    });
    return [];
  }
  return personas;
}

module.exports = { generatePersonas, slotFor, buildPanelSoFar };
