const express = require('express');
const { randomUUID } = require('crypto');
const router = express.Router();
const { authenticate, optionalAuthenticate } = require('../middleware/auth');
const supabase = require('../db/supabase');
const { calculateMissionPrice, deriveFilters } = require('../utils/pricingEngine');
const { runMission } = require('../jobs/runMission');
const logger = require('../utils/logger');

// ── Generate-responses idempotency guard ──────────────────────────────
// runMission is already triggered from /api/payments/confirm on successful
// Stripe confirmation. The frontend's ActiveMissionPage *also* pings the
// generate-responses endpoint on mount as a belt-and-suspenders measure
// (webhooks can lag, the /confirm call can race with the nav, etc.).
// We guard against double-fires so the mission doesn't get two parallel
// persona-generation runs racing to insert into mission_responses.
//
// In-memory is sufficient: runMission itself flips missions.status → 'processing'
// within a few ms of starting, so the DB becomes the persistent guard
// after the first call. This Set only prevents sub-second re-triggers
// from the same container.
const activeRuns = new Set();
const TERMINAL_OR_RUNNING = new Set(['processing', 'completed', 'paid', 'failed']);

/**
 * GET /api/missions — list user's missions (ordered most-recent first).
 */
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

/**
 * GET /api/missions/:id — single mission, user-scoped.
 */
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

/**
 * POST /api/missions — create a new mission draft.
 * Accepts the full mission config; computes price server-side; stores snapshot.
 */
router.post('/', authenticate, async (req, res, next) => {
  try {
    const {
      goalType, goal, title, brief, missionStatement,
      questions, targeting, targetingConfig, respondentCount,
    } = req.body;

    const respCount   = respondentCount || 100;
    const finalTarget = targeting || targetingConfig || {};
    const finalQs     = questions || [];

    const filters = deriveFilters(finalTarget);
    const pricing = calculateMissionPrice(respCount, filters, finalQs.length);

    const insertRow = {
      user_id:                 req.user.id,
      title:                   title || brief?.slice(0, 60) || missionStatement?.slice(0, 60) || 'Untitled mission',
      goal_type:               goalType || goal || 'general_research',
      brief:                   brief || missionStatement || '',
      mission_statement:       missionStatement || brief || '',
      questions:               finalQs,
      targeting:               finalTarget,
      targeting_config:        finalTarget,
      respondent_count:        respCount,
      base_cost_usd:           pricing.baseCost,
      targeting_surcharge_usd: pricing.targetingSurcharge,
      extra_questions_cost_usd: pricing.extraQuestionsCost,
      total_price_usd:         pricing.total,
      price:                   pricing.total,
      pricing_breakdown:       pricing,
      status:                  'draft',
    };

    const { data, error } = await supabase
      .from('missions')
      .insert(insertRow)
      .select()
      .single();

    if (error) throw error;
    logger.info('Mission created', { userId: req.user.id, missionId: data.id });
    res.status(201).json(data);
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/missions/draft — idempotent autosave endpoint for the Setup page.
 * Creates or updates a draft keyed by optional clientDraftId.
 */
router.post('/draft', authenticate, async (req, res, next) => {
  try {
    const {
      missionId, goalType, title, brief, missionStatement,
      questions, targeting, respondentCount,
    } = req.body;

    const respCount   = respondentCount || 100;
    const finalTarget = targeting || {};
    const finalQs     = questions || [];
    const filters     = deriveFilters(finalTarget);
    const pricing     = calculateMissionPrice(respCount, filters, finalQs.length);

    const row = {
      title:             title || 'Untitled draft',
      goal_type:         goalType || 'general_research',
      brief:             brief || '',
      mission_statement: missionStatement || brief || '',
      questions:         finalQs,
      targeting:         finalTarget,
      targeting_config:  finalTarget,
      respondent_count:  respCount,
      base_cost_usd:     pricing.baseCost,
      targeting_surcharge_usd: pricing.targetingSurcharge,
      extra_questions_cost_usd: pricing.extraQuestionsCost,
      total_price_usd:   pricing.total,
      price:             pricing.total,
      pricing_breakdown: pricing,
      status:            'draft',
      updated_at:        new Date().toISOString(),
    };

    let result;
    if (missionId) {
      const { data, error } = await supabase
        .from('missions')
        .update(row)
        .eq('id', missionId)
        .eq('user_id', req.user.id)
        .select()
        .single();
      if (error) throw error;
      result = data;
    } else {
      const { data, error } = await supabase
        .from('missions')
        .insert({ ...row, user_id: req.user.id })
        .select()
        .single();
      if (error) throw error;
      result = data;
    }
    res.json(result);
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/missions/calculate-price — public (optional auth).
 * Used by the Setup page for live pricing display as the user toggles targeting.
 * NEVER treat this as authoritative — the final charge is computed inside /payments/create-intent.
 */
router.post('/calculate-price', optionalAuthenticate, async (req, res, next) => {
  try {
    const { respondentCount, activeFilters, filters, targeting, questions, promoCode } = req.body;

    const respCount = respondentCount || 100;
    const resolvedFilters = Array.isArray(activeFilters)
      ? activeFilters
      : Array.isArray(filters)
        ? filters
        : deriveFilters(targeting || {});
    const qCount = Array.isArray(questions) ? questions.length : (req.body.questionCount || 5);

    let promo = null;
    if (promoCode) {
      const { data } = await supabase
        .from('promo_codes').select('*').eq('code', promoCode).eq('active', true).single();
      if (data) {
        const expired = data.expires_at && new Date(data.expires_at) < new Date();
        const exhausted = data.max_uses && data.uses_count >= data.max_uses;
        if (!expired && !exhausted) promo = data;
      }
    }

    const pricing = calculateMissionPrice(respCount, resolvedFilters, qCount, promo);
    res.json(pricing);
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/missions/launch — validate price & create PaymentIntent in one call (convenience).
 */
router.post('/launch', authenticate, async (req, res, next) => {
  try {
    const { missionId, promoCode } = req.body;
    if (!missionId) return res.status(400).json({ error: 'missionId is required' });

    // Forward to the payments route logic by calling the Stripe helper directly.
    // We do this inline to keep the request shape identical to /payments/create-intent.
    const stripeService = require('../services/stripe');

    const { data: mission } = await supabase
      .from('missions')
      .select('*')
      .eq('id', missionId)
      .eq('user_id', req.user.id)
      .single();
    if (!mission) return res.status(404).json({ error: 'Mission not found' });

    let promo = null;
    if (promoCode) {
      const { data } = await supabase
        .from('promo_codes').select('*').eq('code', promoCode).eq('active', true).single();
      if (data) promo = data;
    }

    const filters = deriveFilters(mission.targeting || mission.targeting_config || {});
    const pricing = calculateMissionPrice(
      mission.respondent_count,
      filters,
      (mission.questions || []).length,
      promo
    );

    if (pricing.totalCents < 50) {
      return res.status(400).json({ error: 'Minimum payment is $0.50' });
    }

    const { data: { user } } = await supabase.auth.admin.getUserById(req.user.id);
    const { clientSecret, paymentIntentId } = await stripeService.createPaymentIntent({
      amountCents: pricing.totalCents,
      missionId,
      userId: req.user.id,
      userEmail: user?.email,
      pricingBreakdown: pricing,
    });

    await supabase
      .from('missions')
      .update({
        stripe_payment_intent_id: paymentIntentId,
        total_price_usd: pricing.total,
        price: pricing.total,
        pricing_breakdown: pricing,
        promo_code: promo?.code || null,
        discount_usd: pricing.discount,
        status: 'pending_payment',
      })
      .eq('id', missionId);

    res.json({ clientSecret, paymentIntentId, pricing });
  } catch (err) {
    next(err);
  }
});

/**
 * PATCH /api/missions/:id — partial update (autosave).
 */
router.patch('/:id', authenticate, async (req, res, next) => {
  try {
    const updates = req.body;

    if (updates.respondentCount || updates.questions || updates.targeting || updates.targetingConfig) {
      const { data: existing } = await supabase
        .from('missions')
        .select('questions, targeting, targeting_config, respondent_count')
        .eq('id', req.params.id)
        .eq('user_id', req.user.id)
        .single();

      const respCount = updates.respondentCount || existing?.respondent_count || 100;
      const finalTarget = updates.targeting || updates.targetingConfig || existing?.targeting || existing?.targeting_config || {};
      const finalQs = updates.questions || existing?.questions || [];
      const pricing = calculateMissionPrice(respCount, deriveFilters(finalTarget), finalQs.length);

      updates.price = pricing.total;
      updates.pricing_breakdown = pricing;
      updates.total_price_usd = pricing.total;
      updates.base_cost_usd = pricing.baseCost;
      updates.targeting_surcharge_usd = pricing.targetingSurcharge;
      updates.extra_questions_cost_usd = pricing.extraQuestionsCost;
    }

    const dbUpdates = {};
    if (updates.title) dbUpdates.title = updates.title;
    if (updates.brief) dbUpdates.brief = updates.brief;
    if (updates.goalType) dbUpdates.goal_type = updates.goalType;
    if (updates.missionStatement) dbUpdates.mission_statement = updates.missionStatement;
    if (updates.questions) dbUpdates.questions = updates.questions;
    if (updates.targeting || updates.targetingConfig) {
      dbUpdates.targeting = updates.targeting || updates.targetingConfig;
      dbUpdates.targeting_config = updates.targeting || updates.targetingConfig;
    }
    if (updates.respondentCount) dbUpdates.respondent_count = updates.respondentCount;
    if (updates.price != null) dbUpdates.price = updates.price;
    if (updates.pricing_breakdown) dbUpdates.pricing_breakdown = updates.pricing_breakdown;
    if (updates.total_price_usd != null) dbUpdates.total_price_usd = updates.total_price_usd;
    if (updates.base_cost_usd != null) dbUpdates.base_cost_usd = updates.base_cost_usd;
    if (updates.targeting_surcharge_usd != null) dbUpdates.targeting_surcharge_usd = updates.targeting_surcharge_usd;
    if (updates.extra_questions_cost_usd != null) dbUpdates.extra_questions_cost_usd = updates.extra_questions_cost_usd;
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

/**
 * POST /api/missions/:id/generate-responses
 *
 * Fire-and-forget trigger for the synthetic-audience pipeline. Called
 * by the ActiveMissionPage on mount so the generator runs even if the
 * Stripe webhook is delayed or /api/payments/confirm hasn't reached us
 * yet. Returns 202 immediately; all long work happens in the background.
 *
 * Idempotency: if the mission is already processing/completed/paid we
 * return 202 with `status: 'already_running'` and DO NOT re-trigger.
 * The in-memory activeRuns Set covers the sub-second window before
 * runMission flips the DB status.
 */
router.post('/:id/generate-responses', authenticate, async (req, res, next) => {
  try {
    const missionId = req.params.id;

    const { data: mission, error } = await supabase
      .from('missions')
      .select('id, user_id, status, respondent_count')
      .eq('id', missionId)
      .eq('user_id', req.user.id)
      .single();

    if (error || !mission) {
      return res.status(404).json({ error: 'Mission not found' });
    }

    const currentStatus = (mission.status || 'draft').toLowerCase();

    // Already in-flight or done — never re-trigger.
    if (activeRuns.has(missionId) || TERMINAL_OR_RUNNING.has(currentStatus)) {
      logger.info('generate-responses: idempotent skip', { missionId, currentStatus });
      return res.status(202).json({
        jobId: `mission-${missionId}`,
        status: 'already_running',
        missionStatus: currentStatus,
      });
    }

    // Only allow kicking off runs from a paid state. We accept 'paid' above
    // and also 'pending_payment' here so that if Stripe's webhook is late
    // but the client already saw the confirmation, we still proceed — the
    // frontend only calls this from ActiveMissionPage which is post-payment.
    // Block 'draft' outright so nothing runs before payment.
    if (currentStatus === 'draft') {
      return res.status(400).json({
        error: 'Mission has not been paid for yet',
        missionStatus: currentStatus,
      });
    }

    const jobId = randomUUID();
    activeRuns.add(missionId);

    setImmediate(() => {
      runMission(missionId)
        .catch((err) => {
          logger.error('generate-responses: runMission failed', {
            missionId,
            jobId,
            err: err.message,
            stack: err.stack,
          });
        })
        .finally(() => {
          activeRuns.delete(missionId);
        });
    });

    logger.info('generate-responses: queued', {
      missionId,
      jobId,
      respondentCount: mission.respondent_count,
    });

    return res.status(202).json({ jobId, status: 'queued' });
  } catch (err) {
    next(err);
  }
});

/**
 * DELETE /api/missions/:id — archive.
 */
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

// Back-compat alias used by the current frontend client
router.post('/pricing/calculate', optionalAuthenticate, async (req, res, next) => {
  try {
    const { respondentCount, questions, targetingConfig, targeting, activeFilters, promoCode } = req.body;
    const respCount = respondentCount || 100;
    const resolvedFilters = Array.isArray(activeFilters)
      ? activeFilters
      : deriveFilters(targetingConfig || targeting || {});
    const qCount = Array.isArray(questions) ? questions.length : 5;

    let promo = null;
    if (promoCode) {
      const { data } = await supabase
        .from('promo_codes').select('*').eq('code', promoCode).eq('active', true).single();
      if (data) promo = data;
    }

    const pricing = calculateMissionPrice(respCount, resolvedFilters, qCount, promo);
    res.json(pricing);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
