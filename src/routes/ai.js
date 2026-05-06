const express = require('express');
const router = express.Router();
const { optionalAuthenticate } = require('../middleware/auth');
const ai = require('../services/claudeAI');
const { callClaude, extractJSON } = require('../services/ai/anthropic');
const logger = require('../utils/logger');

// POST /api/ai/generate-survey
//
// Pass 28 B — accepts clarify_answers (or legacy `clarify`) and
// mission_assets. When goal_type === 'brand_lift', claudeAI.generateSurvey
// branches into a brand-lift specific prompt that returns 10-14
// funnel-staged questions with funnel_stage / kpi_category /
// is_lift_question / channel_id metadata.
router.post('/generate-survey', optionalAuthenticate, async (req, res, next) => {
  try {
    const {
      goal,
      goal_type,
      description,
      targetingHints,
      clarify_answers,
      clarify,
      mission_assets,
    } = req.body;
    const resolvedGoal = goal_type || goal;
    if (!resolvedGoal || !description) return res.status(400).json({ error: 'goal and description are required' });
    if (description.length < 20) return res.status(400).json({ error: 'Description too short. Please provide more detail.' });

    const result = await ai.generateSurvey({
      goal: resolvedGoal,
      description,
      targetingHints,
      clarify: clarify_answers || clarify || {},
      missionAssets: Array.isArray(mission_assets) ? mission_assets : [],
    });
    logger.info('Survey generated', { userId: req.user?.id, goal: resolvedGoal });
    res.json(result);
  } catch (err) {
    next(err);
  }
});

// POST /api/ai/clarify — adaptive clarify questions (Phase 2).
//
// The setup page sends the user's goal + free-text brief. We return 0-5
// short, targeted clarify questions with chip options that the UI
// renders in place of the static Market/Stage/Price cards.
//
// Contract:
//   Request:  { goal: string|null, brief: string }
//   Response: { questions: Array<{ id, question, chips: [{id,label}], defaultChipId? }> }
//
// Frontend aborts after 800 ms, so we use Haiku (fast + cheap) and cap
// max_tokens tightly. Invalid JSON → 400; empty array is legitimate
// (brief is already complete). If the brief looks like gibberish we
// return 400 so the UI shows a "please elaborate" hint.
const CLARIFY_SYSTEM_PROMPT = `You are a research-operations assistant helping a market-research platform understand what a user wants to study before generating a survey. Given a goal and a free-text brief, decide whether any short clarifying questions would meaningfully improve the survey. Return ONLY strict JSON — no prose, no markdown fences.

Rules:
- Ask 0 to 5 questions. ZERO is the correct answer when the brief is complete.
- Never ask about information already stated in the brief.
- Each question is under 10 words, plain English, no jargon.
- Each question has 3-4 chip-style answer options, each under 5 words.
- Prefer concrete dimensions: target market/geography, product stage, pricing sensitivity, audience type, timeframe.
- Reject gibberish: if the brief has no discernible subject, return an error object instead of questions.`;

router.post('/clarify', optionalAuthenticate, async (req, res, next) => {
  try {
    const { goal, brief } = req.body || {};
    const briefStr = typeof brief === 'string' ? brief.trim() : '';
    if (briefStr.length < 10) {
      return res.status(400).json({ error: 'brief too short' });
    }

    const userPrompt = `Goal: ${goal || 'general_research'}
Brief: "${briefStr}"

Return this exact JSON shape:
{
  "questions": [
    {
      "id": "market",
      "question": "Which market are you targeting?",
      "chips": [
        { "id": "us", "label": "US" },
        { "id": "uk", "label": "UK" },
        { "id": "mena", "label": "MENA" },
        { "id": "global", "label": "Global" }
      ],
      "defaultChipId": "global"
    }
  ]
}

If the brief already answers everything, return { "questions": [] }.
If the brief is gibberish/non-English/one-word, return { "error": "gibberish" } instead.`;

    const response = await callClaude({
      callType: 'adaptive_clarify',
      userId: req.user?.id,
      systemPrompt: CLARIFY_SYSTEM_PROMPT,
      messages: [{ role: 'user', content: userPrompt }],
      maxTokens: 600,
    });

    let parsed;
    try {
      parsed = extractJSON(response.text);
    } catch (err) {
      logger.warn('clarify: parse failed, returning empty questions', { err: err.message });
      return res.json({ questions: [] });
    }

    if (parsed.error) {
      return res.status(400).json({ error: parsed.error });
    }

    const raw = Array.isArray(parsed.questions) ? parsed.questions : [];
    const questions = raw
      .slice(0, 5)
      .map((q) => {
        if (!q || typeof q !== 'object') return null;
        const id = typeof q.id === 'string' && q.id ? q.id : null;
        const question = typeof q.question === 'string' && q.question ? q.question : null;
        const chips = Array.isArray(q.chips)
          ? q.chips
              .filter((c) => c && typeof c === 'object' && typeof c.id === 'string' && typeof c.label === 'string')
              .map((c) => ({ id: c.id, label: c.label }))
              .slice(0, 4)
          : [];
        if (!id || !question || chips.length < 2) return null;
        const out = { id, question, chips };
        if (typeof q.defaultChipId === 'string' && chips.some((c) => c.id === q.defaultChipId)) {
          out.defaultChipId = q.defaultChipId;
        }
        return out;
      })
      .filter(Boolean);

    res.json({ questions });
  } catch (err) {
    logger.warn('clarify: upstream failure, returning empty', { err: err.message });
    // Frontend treats empty as "fall back to static cards" — never surface
    // the AI failure to the user mid-setup.
    res.json({ questions: [] });
  }
});

// POST /api/ai/refine-question
router.post('/refine-question', optionalAuthenticate, async (req, res, next) => {
  try {
    const { questionText, questionType, missionContext } = req.body;
    if (!questionText) return res.status(400).json({ error: 'questionText is required' });

    const result = await ai.refineQuestion({ questionText, questionType, missionContext });
    res.json(result);
  } catch (err) {
    next(err);
  }
});

// POST /api/ai/refine-description
//
// Refines a single survey question. The endpoint is named
// "refine-description" for historical reasons — the frontend's
// aiService.refineQuestion() has always POSTed here with the shape:
//   { text, type, options, goal, context }
// and expects back:
//   { text, type?, options? }
//
// We also accept the spec'd shape from PROMPT_3 (question/goal_type)
// and the legacy shape (rawDescription/goal) so older clients keep
// working while new ones migrate.
//
// Cheap heuristic first: if the text already ends with a refinement
// marker we added in the frontend's local fallback ("— and why?",
// "— elaborate"), return it as-is with { noChangeNeeded: true }. This
// avoids spending tokens re-refining an already-refined question.
const REFINE_MARKERS = [' — and why', ' — elaborate', '— and why', '— elaborate'];

router.post('/refine-description', optionalAuthenticate, async (req, res, next) => {
  try {
    const body = req.body || {};

    // Normalise across the three accepted shapes.
    const questionText =
      (typeof body.text === 'string' && body.text) ||
      (typeof body.question === 'string' && body.question) ||
      (typeof body.rawDescription === 'string' && body.rawDescription) ||
      '';
    const questionType = typeof body.type === 'string' ? body.type : undefined;
    const questionOptions = Array.isArray(body.options) ? body.options : undefined;
    const goal = body.goal || body.goal_type || null;
    const context = typeof body.context === 'string' ? body.context : undefined;

    if (!questionText || questionText.trim().length < 3) {
      return res.status(400).json({ error: 'question text is required' });
    }

    // Heuristic: already-refined text (ends with our fallback markers)
    // short-circuits with noChangeNeeded so the caller surfaces a
    // "nothing to improve" toast instead of paying for another call.
    const trimmed = questionText.trim();
    if (REFINE_MARKERS.some((m) => trimmed.includes(m))) {
      return res.json({
        text: trimmed,
        refined: trimmed,
        type: questionType,
        options: questionOptions,
        noChangeNeeded: true,
      });
    }

    // Delegate to the existing claudeAI.refineQuestion helper (Sonnet).
    // It returns { refinedText, explanation } — map to the frontend shape.
    const result = await ai.refineQuestion({
      questionText: trimmed,
      questionType: questionType || 'single',
      missionContext: context || (goal ? `Goal: ${goal}` : ''),
    });

    const refinedText =
      typeof result?.refinedText === 'string' && result.refinedText.trim().length > 0
        ? result.refinedText.trim()
        : trimmed;

    res.json({
      text: refinedText,
      refined: refinedText,
      type: questionType,
      options: questionOptions,
      explanation: result?.explanation,
    });
  } catch (err) {
    logger.warn('refine-description failed', { err: err.message });
    // Non-fatal: frontend has a local fallback, but surface the error
    // so it can log the upstream failure and route to the fallback.
    res.status(500).json({ error: 'Refinement unavailable' });
  }
});

// POST /api/ai/suggest-targeting
router.post('/suggest-targeting', optionalAuthenticate, async (req, res, next) => {
  try {
    const { missionStatement, description, goal } = req.body;
    if (!description) return res.status(400).json({ error: 'description is required' });

    const result = await ai.suggestTargeting({ missionStatement, description, goal });
    res.json(result);
  } catch (err) {
    next(err);
  }
});

// POST /api/ai/analyse-results
router.post('/analyse-results', optionalAuthenticate, async (req, res, next) => {
  try {
    const { missionId, questions, resultData, missionStatement, targetingUsed } = req.body;
    if (!questions || !resultData) return res.status(400).json({ error: 'questions and resultData are required' });

    const result = await ai.analyseResults({ missionStatement, questions, resultData, targetingUsed });
    logger.info('Results analysed by AI', { userId: req.user?.id, missionId });
    res.json(result);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
