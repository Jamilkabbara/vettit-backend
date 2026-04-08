const express = require('express');
const router = express.Router();
const { authenticate } = require('../middleware/auth');
const supabase = require('../db/supabase');
const { calculatePricing } = require('../utils/pricingEngine');
const logger = require('../utils/logger');

// GET /api/missions — list all missions for user
router.get('/', authenticate, async (req, res, next) => {
  try {
    const { data, error } = await supabase
      .from('missions')
      .select('*')
      .eq('user_id', req.user.id)
      .order('created_at', { ascending: false });

    if (error) throw error;
    res.json(data);
  } catch (err) {
    next(err);
  }
});

// GET /api/missions/:id — get single mission
router.get('/:id', authenticate, async (req, res, next) => {
  try {
    const { data, error } = await supabase
      .from('missions')
      .select('*')
      .eq('id', req.params.id)
      .eq('user_id', req.user.id)
      .single();

    if (error || !data) return res.status(404).json({ error: 'Mission not found' });
    res.json(data);
  } catch (err) {
    next(err);
  }
});

// POST /api/missions — create a new mission (draft)
router.post('/', authenticate, async (req, res, next) => {
  try {
    const {
      goal, subject, objective, missionStatement,
      questions, targetingConfig, respondentCount,
      missionType = 'validate',
    } = req.body;

    // Server-side pricing calculation — source of truth
    const pricing = calculatePricing({
      respondentCount: respondentCount || 100,
      questions: questions || [],
      targeting: targetingConfig || {},
      isScreeningActive: (questions || []).some(q => q.isScreening),
    });

    const { data, error } = await supabase
      .from('missions')
      .insert({
        user_id: req.user.id,
        mission_type: missionType,
        goal,
        subject,
        objective,
        mission_statement: missionStatement,
        questions: questions || [],
        targeting_config: targetingConfig || {},
        respondent_count: respondentCount || 100,
        price: pricing.total,
        pricing_breakdown: pricing,
        status: 'draft',
      })
      .select()
      .single();

    if (error) throw error;
    logger.info('Mission created', { userId: req.user.id, missionId: data.id });
    res.status(201).json(data);
  } catch (err) {
    next(err);
  }
});

// PATCH /api/missions/:id — update mission (auto-save)
router.patch('/:id', authenticate, async (req, res, next) => {
  try {
    const updates = req.body;

    // Recalculate pricing if relevant fields changed
    if (updates.respondentCount || updates.questions || updates.targetingConfig) {
      const { data: existing } = await supabase
        .from('missions')
        .select('questions, targeting_config, respondent_count')
        .eq('id', req.params.id)
        .eq('user_id', req.user.id)
        .single();

      const pricing = calculatePricing({
        respondentCount: updates.respondentCount || existing?.respondent_count || 100,
        questions: updates.questions || existing?.questions || [],
        targeting: updates.targetingConfig || existing?.targeting_config || {},
        isScreeningActive: (updates.questions || existing?.questions || []).some(q => q.isScreening),
      });

      updates.price = pricing.total;
      updates.pricing_breakdown = pricing;
    }

    // Map camelCase to snake_case for DB
    const dbUpdates = {};
    if (updates.missionStatement) dbUpdates.mission_statement = updates.missionStatement;
    if (updates.questions) dbUpdates.questions = updates.questions;
    if (updates.targetingConfig) dbUpdates.targeting_config = updates.targetingConfig;
    if (updates.respondentCount) dbUpdates.respondent_count = updates.respondentCount;
    if (updates.price) dbUpdates.price = updates.price;
    if (updates.pricing_breakdown) dbUpdates.pricing_breakdown = updates.pricing_breakdown;
    if (updates.status) dbUpdates.status = updates.status;
    dbUpdates.updated_at = new Date().toISOString();

    const { data, error } = await supabase
      .from('missions')
      .update(dbUpdates)
      .eq('id', req.params.id)
      .eq('user_id', req.user.id)
      .select()
      .single();

    if (error) throw error;
    res.json(data);
  } catch (err) {
    next(err);
  }
});

// DELETE /api/missions/:id — archive a mission
router.delete('/:id', authenticate, async (req, res, next) => {
  try {
    const { error } = await supabase
      .from('missions')
      .update({ status: 'archived', updated_at: new Date().toISOString() })
      .eq('id', req.params.id)
      .eq('user_id', req.user.id);

    if (error) throw error;
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

// GET /api/missions/:id/pricing — get real-time pricing for a mission config
router.post('/pricing/calculate', authenticate, async (req, res, next) => {
  try {
    const { respondentCount, questions, targetingConfig, isScreeningActive } = req.body;
    const pricing = calculatePricing({ respondentCount, questions, targeting: targetingConfig, isScreeningActive });
    res.json(pricing);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
