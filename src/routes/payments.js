const express = require('express');
const router = express.Router();
const { authenticate } = require('../middleware/auth');
const stripeService = require('../services/stripe');
const pollfishService = require('../services/pollfish');
const emailService = require('../services/email');
const supabase = require('../db/supabase');
const { calculatePricing } = require('../utils/pricingEngine');
const logger = require('../utils/logger');

// POST /api/payments/create-intent
// Called when user clicks "Launch Mission" — creates Stripe payment intent
router.post('/create-intent', authenticate, async (req, res, next) => {
  try {
    const { missionId } = req.body;
    if (!missionId) return res.status(400).json({ error: 'missionId is required' });

    // Fetch the mission
    const { data: mission, error: missionError } = await supabase
      .from('missions')
      .select('*')
      .eq('id', missionId)
      .eq('user_id', req.user.id)
      .single();

    if (missionError || !mission) return res.status(404).json({ error: 'Mission not found' });
    if (mission.status !== 'draft') return res.status(400).json({ error: 'Mission is not in draft status' });

    // ALWAYS recalculate price server-side — never trust frontend price
    const pricing = calculatePricing({
      respondentCount: mission.respondent_count,
      questions: mission.questions || [],
      targeting: mission.targeting_config || {},
      isScreeningActive: (mission.questions || []).some(q => q.isScreening),
    });

    if (pricing.totalCents < 50) {
      return res.status(400).json({ error: 'Minimum payment is $0.50' });
    }

    // Get user email for receipt
    const { data: { user } } = await supabase.auth.admin.getUserById(req.user.id);

    const { clientSecret, paymentIntentId } = await stripeService.createPaymentIntent({
      amountCents: pricing.totalCents,
      missionId,
      userId: req.user.id,
      userEmail: user.email,
      pricingBreakdown: pricing,
    });

    // Store the payment intent ID on the mission
    await supabase
      .from('missions')
      .update({ stripe_payment_intent_id: paymentIntentId, price: pricing.total, pricing_breakdown: pricing })
      .eq('id', missionId);

    logger.info('Payment intent created', { missionId, amount: pricing.total });

    res.json({
      clientSecret,
      paymentIntentId,
      pricing, // Send confirmed pricing back to frontend
    });
  } catch (err) {
    next(err);
  }
});

// POST /api/payments/confirm
// Called after Stripe payment succeeds on frontend — launch survey
router.post('/confirm', authenticate, async (req, res, next) => {
  try {
    const { missionId, paymentIntentId } = req.body;
    if (!missionId || !paymentIntentId) {
      return res.status(400).json({ error: 'missionId and paymentIntentId are required' });
    }

    // Verify payment with Stripe
    const payment = await stripeService.verifyPayment(paymentIntentId);
    if (!payment.success) {
      return res.status(400).json({ error: 'Payment not confirmed by Stripe' });
    }

    // Fetch mission
    const { data: mission } = await supabase
      .from('missions')
      .select('*')
      .eq('id', missionId)
      .eq('user_id', req.user.id)
      .single();

    if (!mission) return res.status(404).json({ error: 'Mission not found' });

    // Launch survey on Pollfish
    const pollfishResult = await pollfishService.createSurvey({
      missionId,
      questions: mission.questions,
      targeting: mission.targeting_config,
      respondentCount: mission.respondent_count,
      missionStatement: mission.mission_statement,
    });

    // Update mission to active
    await supabase
      .from('missions')
      .update({
        status: 'active',
        pollfish_survey_id: pollfishResult.pollfishSurveyId,
        launched_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq('id', missionId);

    // Send launch confirmation email
    const { data: { user } } = await supabase.auth.admin.getUserById(req.user.id);
    const { data: profile } = await supabase.from('profiles').select('full_name').eq('id', req.user.id).single();

    await emailService.sendMissionLaunchedEmail({
      to: user.email,
      name: profile?.full_name,
      missionStatement: mission.mission_statement,
      respondentCount: mission.respondent_count,
      estimatedTime: mission.time_estimate || 'a few hours',
      missionId,
    }).catch(e => logger.warn('Failed to send launch email', e));

    // Send invoice email
    await emailService.sendInvoiceEmail({
      to: user.email,
      name: profile?.full_name,
      invoiceData: {
        missionId,
        missionStatement: mission.mission_statement,
        respondentCount: mission.respondent_count,
        ...mission.pricing_breakdown,
      },
    }).catch(e => logger.warn('Failed to send invoice email', e));

    logger.info('Mission launched', { missionId, pollfishId: pollfishResult.pollfishSurveyId });

    res.json({ success: true, missionId, status: 'active' });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
