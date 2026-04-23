const express = require('express');
const router = express.Router();
const { authenticate } = require('../middleware/auth');
const stripeService = require('../services/stripe');
const emailService = require('../services/email');
const supabase = require('../db/supabase');
const { calculateMissionPrice, extractCountriesFromMission } = require('../utils/pricingEngine');
const { runMission } = require('../jobs/runMission');
const { updateMission } = require('../db/missionSchema');
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
    // extractCountriesFromMission checks targeting.geography.countries first,
    // then falls back to target_audience.aiTargeting.countries so that missions
    // whose targeting column is null (but aiTargeting has countries) price correctly.
    const countries = extractCountriesFromMission(mission);
    const pricing = calculateMissionPrice({
      respondentCount: mission.respondent_count,
      targeting:       mission.targeting || {},
      questionCount:   (mission.questions || []).length,
      countries,
      promoCode:       promo,
    });

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

    // Snapshot pricing onto the mission for audit. Phantom columns
    // (stripe_payment_intent_id, pricing_breakdown) are stripped by
    // sanitizeMissionPatch — Stripe stores the PI id, and breakdown
    // is reconstructable from the individual cost columns.
    await updateMission(supabase, missionId, {
      base_cost_usd:            pricing.baseCost,
      targeting_surcharge_usd:  pricing.targetingSurcharge,
      extra_questions_cost_usd: pricing.extraQuestionsCost,
      total_price_usd:          pricing.total,
      promo_code:               promo?.code || null,
      discount_usd:             pricing.discount,
      status:                   'pending_payment',
    }, { caller: 'POST /payments/create-intent' });

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
      // payment_status + updated_at columns don't exist — sanitizer strips.
      await updateMission(supabase, missionId, {
        status: 'paid',
        paid_at: new Date().toISOString(),
      }, { caller: 'POST /payments/confirm' });

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
          // `mission.mission_statement` used to exist; the column was
          // dropped, so we read from `brief` only. Same for
          // `pricing_breakdown` — reconstruct from cost columns.
          missionStatement: mission.brief || mission.title || '',
          respondentCount:  mission.respondent_count,
          total:            Number(mission.total_price_usd) || 0,
          baseCost:         Number(mission.base_cost_usd)   || 0,
          targetingSurcharge: Number(mission.targeting_surcharge_usd) || 0,
          extraQuestionsCost: Number(mission.extra_questions_cost_usd) || 0,
          discount:           Number(mission.discount_usd) || 0,
          promoCode:          mission.promo_code || null,
        },
      }).catch(e => logger.warn('Failed to send invoice email', e));
    } catch (_) {}

    res.json({ success: true, missionId, status: 'processing' });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/payments/free-launch
 * Used by the VETT100 promo path (and future free-tier grants) to launch a
 * mission without going through Stripe. Validates server-side via DB that the
 * promo code has type='free' and is active, then sets status='paid' and fires
 * runMission() — exactly the same way /confirm does.
 *
 * Previously the frontend VETT100 path only called activateMission() (a bare
 * DB write) without hitting the backend, so runMission() never fired and
 * free-launch missions never generated AI results.
 */
router.post('/free-launch', authenticate, async (req, res, next) => {
  try {
    const { missionId, promoCode } = req.body;
    if (!missionId || !promoCode) {
      return res.status(400).json({ error: 'missionId and promoCode are required' });
    }

    // DB-backed validation: look up the code and confirm it's a free-type code
    const { data: promo } = await supabase
      .from('promo_codes')
      .select('*')
      .eq('code', promoCode.toUpperCase().trim())
      .eq('active', true)
      .single();

    if (!promo) {
      return res.status(403).json({ error: 'Invalid or inactive promo code' });
    }
    if (promo.type !== 'free') {
      return res.status(403).json({ error: 'This promo code cannot be used for free launch' });
    }
    const expired   = promo.expires_at && new Date(promo.expires_at) < new Date();
    const exhausted = promo.max_uses && promo.uses_count >= promo.max_uses;
    if (expired || exhausted) {
      return res.status(403).json({ error: 'Promo code is no longer valid' });
    }

    const { data: mission } = await supabase
      .from('missions')
      .select('id, status, user_id')
      .eq('id', missionId)
      .eq('user_id', req.user.id)
      .single();

    if (!mission) return res.status(404).json({ error: 'Mission not found' });

    const status = (mission.status || '').toLowerCase();

    // Idempotency: already running or done — return success without re-triggering
    if (['processing', 'completed', 'paid'].includes(status)) {
      return res.json({ success: true, missionId, status: 'already_running' });
    }

    // Accept draft, pending_payment, or active (frontend may have pre-flipped it)
    const launchable = ['draft', 'pending_payment', 'active'].includes(status);
    if (!launchable) {
      return res.status(400).json({ error: `Mission cannot be free-launched from status: ${status}` });
    }

    await updateMission(supabase, missionId, {
      status:    'paid',
      paid_at:   new Date().toISOString(),
      promo_code: promoCode.toUpperCase(),
    }, { caller: 'POST /payments/free-launch' });

    // Increment uses_count on the promo row (best-effort)
    supabase.from('promo_codes')
      .update({ uses_count: (promo.uses_count || 0) + 1 })
      .eq('code', promo.code)
      .then(() => {}).catch(() => {});

    setImmediate(() => {
      runMission(missionId).catch(err => {
        logger.error('runMission failed from /free-launch', { missionId, err: err.message });
      });
    });

    logger.info('Free launch triggered', { missionId, promoCode: promoCode.toUpperCase() });
    res.json({ success: true, missionId, status: 'processing' });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
