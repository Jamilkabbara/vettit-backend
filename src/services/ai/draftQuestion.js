/**
 * VETT — AI draft of ONE extra survey question (ad-hoc, untagged).
 *
 * ── Why this is not "generate a survey" ─────────────────────────────
 * claudeAI.generateSurvey builds a METHODOLOGY INSTRUMENT: every
 * question it emits carries analysis tags (kind / dimension /
 * methodology / funnel_stage / kpi_category / churn_stage / vw_band /
 * gg_anchor_index / feature_id / kano_type / candidate_id /
 * is_paired_comparison / is_lift_question / concept_id / ...) and the
 * deterministic analysis modules in services/analysis/* select on
 * exactly those tags. Example, audienceProfiling.js:153:
 *
 *     const q = qs.find((qq) => qq && qq.kind === 'attitudinal'
 *                            && qq.dimension === d);
 *
 * A user-added ad-hoc question is a DIFFERENT KIND OF OBJECT. It is
 * not part of any battery, it has no methodological role, and nothing
 * downstream should ever treat it as one. If such a question carried
 * even a plausible-looking tag it would be pulled into a methodology
 * bucket and silently corrupt the numbers the customer paid for —
 * a Van Westendorp price curve built partly from a question the
 * generator never designed, an attitudinal segmentation whose
 * dimension vector includes an off-battery item, and so on.
 *
 * ── The guarantee ───────────────────────────────────────────────────
 * This module NEVER emits methodology metadata. That is enforced by
 * CONSTRUCTION, not by prompt discipline: buildDraftQuestion() copies
 * an explicit allowlist of structural keys out of the model output
 * into a fresh object literal. There is no spread, no rest, no
 * delete-the-bad-keys pass. Any key the model invents — including
 * tags that do not exist yet — is dropped because it was never
 * copied, so this cannot rot as new methodologies add new tags.
 *
 * The result carries an explicit positive marker instead:
 *
 *     source: 'user_drafted'
 *
 * so the question is structurally distinguishable from a generated
 * one in both directions: it HAS a marker generated questions lack,
 * and it LACKS every tag generated questions carry.
 *
 * Every analysis module enters its methodology buckets through a
 * POSITIVE tag predicate (q.kind === X, q.funnel_stage === Y,
 * q.methodology === Z, q.feature_id != null, q.concept_id truthy,
 * q.is_paired_comparison === true, ...). An object carrying none of
 * those keys fails all of them and is simply not selected — it does
 * not crash and it does not land in a bucket. See
 * test/draft_question_analysis_tolerance.test.js, which runs the real
 * computeAnalysis() for every goal type with an untagged question
 * appended and asserts the output is byte-identical to the run
 * without it.
 */

const logger = require('../../utils/logger');
const { callClaude, extractJSON } = require('./anthropic');

/**
 * ── Per-mission draft cap ───────────────────────────────────────────
 *
 * Number chosen at 3. The reasoning, so a future change is an informed
 * one rather than a guess:
 *
 *  1. ANALYTICAL DILUTION. A drafted question is untagged by design,
 *     so it contributes nothing to the methodology math — it shows up
 *     only as a raw per-question distribution in the generic block
 *     (services/analysis/index.js computeResearch). Generated surveys
 *     run 5-14 questions of structured battery. Allowing an unbounded
 *     number of unstructured questions lets a user quietly run a
 *     second, shapeless survey alongside the instrument they paid for
 *     and then judge the product on the half that has no methodology
 *     behind it. Three is comfortably enough for "I also want to ask
 *     about X, Y and Z" while keeping the battery dominant.
 *
 *  2. INSTRUMENT LENGTH. Every added question costs respondent
 *     attention; satisficing and drop-off rise with length. 14 (the
 *     generator's ceiling) + 3 keeps the worst case at 17 items.
 *
 *  3. COST. Each accepted draft is billed per respondent for the whole
 *     mission, so the cap bounds the marginal cost a user can add to a
 *     priced mission after quoting.
 *
 * NOTE ON WHAT THIS CAP IS AND IS NOT: it caps ACCEPTED (persisted)
 * drafts per mission, which is the product-meaningful limit. It does
 * NOT cap the number of draft CALLS — a user may draft and discard
 * repeatedly. That axis is deliberately left to the rate limiters
 * already stacked on the /api/ai mount in app.js (aiLimiter 10/min
 * and aiHourlyLimiter 80/hr per IP), which exist precisely to bound
 * LLM call volume; duplicating that bound here would give two
 * disagreeing limits on the same resource.
 */
const DRAFT_QUESTION_CAP = 3;

/** The positive marker every drafted question carries. */
const USER_DRAFTED_SOURCE = 'user_drafted';

/**
 * Every methodology / analysis tag the generators emit, as of Pass 49.
 * This list is NOT used to filter (buildDraftQuestion allowlists
 * instead, so unknown future tags are also dropped). It exists so the
 * test suite can assert on the absence of each one by name, and so a
 * reader can see exactly what "no methodology metadata" means.
 */
const METHODOLOGY_TAG_KEYS = Object.freeze([
  'kind',
  'dimension',
  'methodology',
  'funnel_stage',
  'kpi_category',
  'churn_stage',
  'vw_band',
  'gg_anchor_index',
  'feature_id',
  'feature_set',
  'kano_type',
  'candidate_id',
  'criterion',
  'is_paired_comparison',
  'is_turf',
  'is_lift_question',
  'is_final_choice',
  'concept_id',
  'brand_id',
  'channel_id',
  'currency',
  'category',
  'qualifying_answers',
  'screening_continue_on',
]);

/**
 * The COMPLETE set of keys a drafted question may carry on the wire.
 * The endpoint's contract is equality with this set, not merely the
 * absence of METHODOLOGY_TAG_KEYS — that way a tag invented after this
 * file was written is caught by the same assertion.
 *
 * `isScreening` is deliberately NOT here. It is a UI/screening-gate
 * field that MissionControlQuestions.emit() stamps on every question
 * by array position once the draft is accepted; the endpoint has no
 * business asserting a position it cannot know.
 */
const DRAFT_QUESTION_KEYS = Object.freeze(['text', 'type', 'options', 'source']);

/** Question types the frontend renders (aiService.ts VALID_TYPES). */
const VALID_TYPES = Object.freeze(['single', 'multi', 'rating', 'opinion', 'text']);

/** Loose model output → a type we actually render. */
const TYPE_ALIASES = Object.freeze({
  single_choice: 'single',
  multiple_choice: 'multi',
  yesno: 'single',
  likert: 'opinion',
  nps: 'rating',
  scale: 'rating',
  open: 'text',
  open_ended: 'text',
});

const MIN_OPTIONS = 2;
const MAX_OPTIONS = 6;
const MAX_TEXT_LEN = 240;
const MAX_OPTION_LEN = 60;

function normaliseType(raw) {
  const t = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  const mapped = TYPE_ALIASES[t] || t;
  return VALID_TYPES.includes(mapped) ? mapped : 'single';
}

/**
 * Build the question we return to the client.
 *
 * THIS IS THE NO-METADATA GUARANTEE. Keys are copied one at a time
 * from an allowlist into a fresh literal. Adding a spread here, or
 * switching to "copy everything then delete the tags", would break
 * the guarantee — the whole point is that a tag the model invents
 * tomorrow is dropped without anyone updating a denylist.
 *
 * @param {object} raw parsed model output (untrusted)
 * @returns {{text:string,type:string,options:string[],source:string}|null}
 */
function buildDraftQuestion(raw) {
  if (!raw || typeof raw !== 'object') return null;

  const text = typeof raw.text === 'string' ? raw.text.trim().slice(0, MAX_TEXT_LEN) : '';
  if (text.length < 5) return null;

  const type = normaliseType(raw.type);

  let options = [];
  if (type === 'single' || type === 'multi') {
    const seen = new Set();
    options = (Array.isArray(raw.options) ? raw.options : [])
      .map((o) => (typeof o === 'string' ? o.trim().slice(0, MAX_OPTION_LEN) : ''))
      .filter((o) => {
        if (!o) return false;
        const k = o.toLowerCase();
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
      })
      .slice(0, MAX_OPTIONS);
    // A choice question with fewer than two answers is degenerate.
    // Downgrade rather than reject: the user still gets a usable draft.
    if (options.length < MIN_OPTIONS) return { text, type: 'text', options: [], source: USER_DRAFTED_SOURCE };
  } else if (type === 'opinion') {
    options = ['Agree', 'Neutral', 'Disagree'];
  }

  // Explicit, closed literal. No spread. No rest. No delete pass.
  return {
    text,
    type,
    options,
    source: USER_DRAFTED_SOURCE,
  };
}

/**
 * Count questions already marked as user drafts on a mission.
 * Anything without the marker is a generated question and does not
 * count against the user's ad-hoc budget.
 */
function countUserDrafts(questions) {
  if (!Array.isArray(questions)) return 0;
  return questions.filter((q) => q && typeof q === 'object' && q.source === USER_DRAFTED_SOURCE).length;
}

const SYSTEM_PROMPT = `You draft ONE extra survey question for a market-research study. You are not writing a survey and not designing a methodology — the study already has its questions. The user wants to bolt on a single ad-hoc question of their own.

Return ONLY strict JSON. No prose, no markdown fences.

Shape:
{ "text": "...", "type": "single|multi|rating|opinion|text", "options": ["...", "..."] }

Rules:
- Exactly ONE question. Never an array, never a battery.
- "text" is under 25 words, plain English, neutral, non-leading, and asks about ONE thing.
- Never ask for personally identifying information (name, email, phone, address, exact date of birth, ID numbers).
- "single" and "multi" need 2 to 6 short, mutually distinct options.
- "rating" is a 1-5 scale and takes no options. "text" is open-ended and takes no options. "opinion" is agree/disagree and takes no options.
- Do NOT restate or duplicate a question the study already asks.
- Output ONLY the four keys above. Do not add analysis, methodology, scoring, stage, category, or tagging fields of any kind. This question is deliberately untagged.`;

/** Trim mission context so a long brief cannot balloon the prompt. */
function clip(v, n) {
  return typeof v === 'string' && v.trim() ? v.trim().slice(0, n) : '';
}

/**
 * Draft a single ad-hoc question.
 *
 * @param {object}   params
 * @param {string}   params.prompt        what the user asked for
 * @param {object}   params.mission       mission row (goal_type, brief, title, questions)
 * @param {string}   [params.userId]      for ai_calls attribution
 * @returns {Promise<object>} the drafted question (no methodology tags)
 * @throws when the model returns nothing usable
 */
async function draftQuestion({ prompt, mission, userId = null }) {
  const ask = clip(prompt, 400);
  const brief = clip(mission?.brief || mission?.title, 600);
  const goal = clip(mission?.goal_type, 60) || 'research';

  const existing = (Array.isArray(mission?.questions) ? mission.questions : [])
    .map((q) => clip(q && q.text, 160))
    .filter(Boolean)
    .slice(0, 20);

  const userPrompt = `Study goal: ${goal}
Study brief: ${brief || '(none provided)'}

Questions the study already asks:
${existing.length ? existing.map((t, i) => `${i + 1}. ${t}`).join('\n') : '(none yet)'}

The user wants to add one more question. In their words:
"${ask}"

Draft that single question now as JSON.`;

  const response = await callClaude({
    callType: 'question_draft',
    userId,
    missionId: mission?.id || null,
    systemPrompt: SYSTEM_PROMPT,
    messages: [{ role: 'user', content: userPrompt }],
    maxTokens: 400,
  });

  let parsed;
  try {
    parsed = extractJSON(response.text);
  } catch (err) {
    logger.warn('draftQuestion: model output was not parseable JSON', { err: err.message });
    throw new Error('draft_unparseable');
  }

  // Unwrap a { "question": {...} } envelope if the model added one.
  //
  // No array handling here on purpose: extractJSON matches the first
  // `{` to the last `}`, so a multi-question array like [{a},{b}]
  // yields invalid JSON and throws above. That is the behaviour we
  // want — a drafter asked for ONE question that returns several has
  // ignored its instructions, and silently keeping element 0 would
  // hide that. A single-element [{...}] still parses, as the inner
  // object.
  const candidate = parsed && typeof parsed === 'object'
    && parsed.question && typeof parsed.question === 'object'
    ? parsed.question
    : parsed;

  const question = buildDraftQuestion(candidate);
  if (!question) {
    logger.warn('draftQuestion: model output had no usable question text');
    throw new Error('draft_unusable');
  }
  return question;
}

module.exports = {
  DRAFT_QUESTION_CAP,
  USER_DRAFTED_SOURCE,
  METHODOLOGY_TAG_KEYS,
  DRAFT_QUESTION_KEYS,
  VALID_TYPES,
  buildDraftQuestion,
  countUserDrafts,
  draftQuestion,
};
