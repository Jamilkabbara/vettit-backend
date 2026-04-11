const express = require('express');
const router = express.Router();
const { optionalAuthenticate } = require('../middleware/auth');
const ai = require('../services/claudeAI');
const logger = require('../utils/logger');

// POST /api/ai/generate-survey
router.post('/generate-survey', optionalAuthenticate, async (req, res, next) => {
  try {
    const { goal, description, targetingHints } = req.body;
    if (!goal || !description) return res.status(400).json({ error: 'goal and description are required' });
    if (description.length < 20) return res.status(400).json({ error: 'Description too short. Please provide more detail.' });

    const result = await ai.generateSurvey({ goal, description, targetingHints });
    logger.info('Survey generated', { userId: req.user?.id, goal });
    res.json(result);
  } catch (err) {
    next(err);
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
router.post('/refine-description', optionalAuthenticate, async (req, res, next) => {
  try {
    const { rawDescription, goal } = req.body;
    if (!rawDescription) return res.status(400).json({ error: 'rawDescription is required' });

    const result = await ai.refineMissionDescription({ rawDescription, goal });
    res.json(result);
  } catch (err) {
    next(err);
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
