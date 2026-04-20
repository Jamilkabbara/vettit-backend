const express = require('express');
const router = express.Router();
const { authenticate } = require('../middleware/auth');
const stripeService = require('../services/stripe');
const emailService = require('../services/email');
const supabase = require('../db/supabase');
const { calculateMissionPrice, deriveFilters } = require('../utils/pricingEngine');
const { runMission } = require('../jobs/runMission');
const logger = require('../utils/logger');

/**
 * POST /api/payments/create-intent
 * Called when the user clicks "Launch Mission" — creates a Stripe PaymentIntent.
 * SERVER-SIDE PRICING: recalculates from scratch using the mission row, never trusts client totals.
 */
router.post('/create-intent', authenticate, async (req, res, next) => {
  try {
    const { missionId, promoCode } = req.body;
    if (!missionId) return res.status(400).json({ error: 'missionId is required' });

    const { data: mission, error: missionError } = await supabase
      .from('missions')
      .select('*')
      .eq('id', missionId)
      .eq('user_id', req.user.id)
      .single();

    if (missionError || !mission) return res.status(404).json({ error: 'Mission not found' });

    const status = (mission.status || 'draft').toLowerCase();
    if (status !== 'draft' && status !== 'pending_payment') {
      return res.status(400).json({ error: 'Mission is not in draft status' });
    }

    // Resolve promo code (if any)
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

    // Recalculate server-side — SINGLE SOURCE OF TRUTH
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

    // Get user email for the Stripe receipt
    const { data: { user } } = await supabase.auth.admin.getUserById(req.user.id);

    const { clientSecret, paymentIntentId } = await stripeService.createPaymentIntent({
      amountCents: pricing.totalCents,
      missionId,
      userId: req.user.id,
      userEmail: user?.email,
      pricingBreakdown: pricing,
    });

    // Snapshot pricing onto the mission for audit
    await supabase
      .from('missions')
      .update({
        stripe_payment_intent_id: paymentIntentId,
        base_cost_usd:            pricing.baseCost,
        targeting_surcharge_usd:  pricing.targetingSurcharge,
        extra_questions_cost_usd: pricing.extraQuestionsCost,
        total_price_usd:          pricing.total,
        promo_code:               promo?.code || null,
        discount_usd:             pricing.discount,
        pricing_breakdown:        pricing,
        status:                   'pending_payment',
      })
      .eq('id', missionId);

    logger.info('Payment intent created', { missionId, amount: pricing.total });

    res.json({ clientSecret, paymentIntentId, pricing });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/payments/confirm
 * Client calls this after Stripe confirms the payment on the frontend.
 * This is a fallback in case the webhook hasn't arrived yet — it idempotently
 * verifies payment and triggers the synthetic-audience pipeline.
 */
router.post('/confirm', authenticate, async (req, res, next) => {
  try {
    const { missionId, paymentIntentId } = req.body;
    if (!missionId || !paymentIntentId) {
      return res.status(400).json({ error: 'missionId and paymentIntentId are required' });
    }

    const payment = await stripeService.verifyPayment(paymentIntentId);
    if (!payment.success) {
      return res.status(400).json({ error: 'Payment not confirmed by Stripe' });
    }

    const { data: mission } = await supabase
      .from('missions')
      .select('*')
      .eq('id', missionId)
      .eq('user_id', req.user.id)
      .single();

    if (!mission) return res.status(404).json({ error: 'Mission not found' });

    // Idempotency: if already processing/completed, skip re-trigger
    const alreadyRunning = ['processing', 'completed', 'paid'].includes((mission.status || '').toLowerCase());

    if (!alreadyRunning) {
      await supabase
        .from('missions')
        .update({
          status: 'paid',
          payment_status: 'paid',
          paid_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        })
        .eq('id', missionId);

      // Fire-and-forget: the synthetic audience pipeline
      setImmediate(() => {
        runMission(missionId).catch(err => {
          logger.error('runMission failed from /confirm', { missionId, err: err.message });
        });
      });
    }

    // Best-effort invoice email
    try {
      const { data: { user } } = await supabase.auth.admin.getUserById(req.user.id);
      const { data: profile } = await supabase
        .from('profiles').select('first_name, last_name, full_name').eq('id', req.user.id).single();
      const name = profile?.full_name || [profile?.first_name, profile?.last_name].filter(Boolean).join(' ');
      await emailService.sendInvoiceEmail?.({
        to: user?.email,
        name,
        invoiceData: {
          missionId,
          missionStatement: mission.brief || mission.mission_statement || '',
          respondentCount: mission.respondent_count,
          ...(mission.pricing_breakdown || {}),
        },
      }).catch(e => logger.warn('Failed to send invoice email', e));
    } catch (_) {}

    res.json({ success: true, missionId, status: 'processing' });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
