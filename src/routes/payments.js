const express = require('express');
const router = express.Router();
const { authenticate } = require('../middleware/auth');
const stripeService = require('../services/stripe');
const emailService = require('../services/email');
const supabase = require('../db/supabase');
const { calculateMissionPrice, extractCountriesFromMission } = require('../utils/pricingEngine');
const { runMission } = require('../jobs/runMission');
const { updateMission } = require('../db/missionSchema');
const { logPaymentError, shapeStripeError } = require('../services/paymentErrors');
const logger = require('../utils/logger');

/**
 * POST /api/payments/create-intent
 * Called when the user clicks "Launch Mission" — creates a Stripe PaymentIntent.
 * SERVER-SIDE PRICING: recalculates from scratch using the mission row, never trusts client totals.
 */
router.post('/create-intent', authenticate, async (req, res, next) => {
  const { missionId, promoCode } = req.body || {};
  let mission = null;
  let pricing = null;

  try {
    if (!missionId) return res.status(400).json({ error: 'missionId is required' });

    const { data: missionRow, error: missionError } = await supabase
      .from('missions')
      .select('*')
      .eq('id', missionId)
      .eq('user_id', req.user.id)
      .single();

    if (missionError || !missionRow) return res.status(404).json({ error: 'Mission not found' });
    mission = missionRow;

    const status = (mission.status || 'draft').toLowerCase();
    // Pass 22 Bug 22.23: short-circuit on terminal mission states. If the
    // mission is already paid/processing/completed, the user should be
    // redirected to results — not asked to pay again. Returning 409 makes
    // the error path explicit and prevents PI sprawl on accidental retries.
    if (['paid', 'processing', 'completed'].includes(status)) {
      logger.info('Payments create-intent: mission already paid', { missionId, status });
      return res.status(409).json({
        error: 'Mission already paid',
        status,
        redirectTo: `/results/${missionId}`,
      });
    }
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
    const countries = extractCountriesFromMission(mission);
    pricing = calculateMissionPrice({
      respondentCount: mission.respondent_count,
      targeting:       mission.targeting || {},
      questionCount:   (mission.questions || []).length,
      countries,
      promoCode:       promo,
    });

    if (pricing.totalCents < 50) {
      return res.status(400).json({ error: 'Minimum payment is $0.50' });
    }

    // Pass 22 Bug 22.23 — IDEMPOTENCY GUARD ────────────────────────────────
    // Before creating a fresh PI, check if this mission already has an
    // in-flight one we can resume. The forensic audit found 6+ stuck
    // mission/PI pairs because the old code minted a new PI on every retry.
    //
    // Resume conditions (all in services/stripe.js assessPIResumability):
    //   * status in {requires_payment_method, requires_confirmation,
    //                requires_action, processing}
    //   * created < 24h ago
    //   * amount matches the freshly-recalculated total (catches promo drift)
    if (mission.latest_payment_intent_id) {
      const existingPI = await stripeService.retrievePaymentIntent(mission.latest_payment_intent_id);
      const verdict = stripeService.assessPIResumability(existingPI, pricing.totalCents);
      if (verdict.resumable) {
        logger.info('Payments create-intent: resuming existing PI', {
          missionId,
          paymentIntentId: existingPI.id,
          status: existingPI.status,
        });
        return res.json({
          clientSecret:    existingPI.client_secret,
          paymentIntentId: existingPI.id,
          pricing,
          resumed:         true,
        });
      }
      logger.info('Payments create-intent: existing PI not resumable, creating new', {
        missionId,
        existingPI: mission.latest_payment_intent_id,
        existingStatus: existingPI?.status,
        reason: verdict.reason,
      });
    }
    // ─────────────────────────────────────────────────────────────────────

    // Pass 23 Bug 23.0d — Stripe metadata salvage fallback ───────────────
    // The Bali forensic showed missions can have orphan PIs in Stripe
    // (created by older code paths or by a manual recovery) that aren't
    // tracked on missions.latest_payment_intent_id. Without this fallback,
    // create-intent always mints a fresh PI even when a perfectly-good
    // resumable one already exists in Stripe — driving the multi-PI
    // sprawl observed in the audit.
    //
    // Strategy: before creating a new PI, search Stripe by
    // metadata['missionId'] for any salvageable PI from the last 24h that
    // matches the current price. If found, backfill the row column
    // (preventing future drift) and resume.
    if (!mission.latest_payment_intent_id) {
      try {
        const salvaged = await stripeService.findSalvageablePI(missionId, pricing.totalCents);
        if (salvaged) {
          logger.info('Payments create-intent: salvaged orphan PI from Stripe metadata', {
            missionId,
            salvagedPI: salvaged.id,
            status: salvaged.status,
          });
          // Backfill the row column so subsequent create-intent calls hit
          // the fast path above and not this Stripe-search path.
          await updateMission(supabase, missionId, {
            latest_payment_intent_id: salvaged.id,
          }, { caller: 'POST /payments/create-intent: salvage-backfill' });
          return res.json({
            clientSecret:    salvaged.client_secret,
            paymentIntentId: salvaged.id,
            pricing,
            resumed:         true,
            salvaged:        true,
          });
        }
      } catch (searchErr) {
        // Stripe Search API can fail or be eventually-consistent; never
        // block create-intent on a salvage failure. Just fall through to
        // creating a fresh PI.
        logger.warn('Payments create-intent: salvage search failed (non-fatal)', {
          missionId, err: searchErr.message,
        });
      }
    }
    // ─────────────────────────────────────────────────────────────────────

    // Get user email for the Stripe receipt
    const { data: { user } } = await supabase.auth.admin.getUserById(req.user.id);

    const { clientSecret, paymentIntentId } = await stripeService.createPaymentIntent({
      amountCents: pricing.totalCents,
      missionId,
      userId: req.user.id,
      userEmail: user?.email,
      pricingBreakdown: pricing,
    });

    // Snapshot pricing + the new PI id onto the mission for audit and
    // future-retry idempotency. latest_payment_intent_id is whitelisted
    // by missionSchema.js (Pass 22 Bug 22.23 entry).
    await updateMission(supabase, missionId, {
      base_cost_usd:             pricing.baseCost,
      targeting_surcharge_usd:   pricing.targetingSurcharge,
      extra_questions_cost_usd:  pricing.extraQuestionsCost,
      total_price_usd:           pricing.total,
      promo_code:                promo?.code || null,
      discount_usd:              pricing.discount,
      status:                    'pending_payment',
      latest_payment_intent_id:  paymentIntentId,
    }, { caller: 'POST /payments/create-intent' });

    logger.info('Payment intent created', { missionId, amount: pricing.total, paymentIntentId });

    res.json({ clientSecret, paymentIntentId, pricing });
  } catch (err) {
    // Pass 22 Bug 22.9 — log the failure to payment_errors before bubbling.
    const shaped = shapeStripeError(err);
    logPaymentError({
      userId:                req.user?.id,
      missionId,
      stripePaymentIntentId: null,
      errorCode:             shaped.errorCode,
      errorMessage:          shaped.errorMessage || err.message,
      declineCode:           shaped.declineCode,
      paymentMethod:         shaped.paymentMethod,
      amountCents:           pricing?.totalCents ?? null,
      currency:              'usd',
      stage:                 'create_intent',
      userAgent:             req.headers?.['user-agent'] || null,
    }).catch(() => {});
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
  const { missionId, paymentIntentId } = req.body || {};
  try {
    if (!missionId || !paymentIntentId) {
      return res.status(400).json({ error: 'missionId and paymentIntentId are required' });
    }

    const payment = await stripeService.verifyPayment(paymentIntentId);
    if (!payment.success) {
      // Pass 22 Bug 22.9 — log the verify-failure to payment_errors so the
      // admin viewer surfaces "user reached confirm but Stripe says PI not
      // succeeded" cases (3DS abandoned, wallet sheet dismissed, etc).
      logPaymentError({
        userId:                req.user?.id,
        missionId,
        stripePaymentIntentId: paymentIntentId,
        errorCode:             `pi_status:${payment.status}`,
        errorMessage:          'Payment not confirmed by Stripe',
        declineCode:           null,
        paymentMethod:         null,
        amountCents:           Number.isFinite(payment.amountCents) ? payment.amountCents : null,
        currency:              'usd',
        stage:                 'confirm',
        userAgent:             req.headers?.['user-agent'] || null,
      }).catch(() => {});
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
    // Pass 22 Bug 22.9 — confirm catch logs to payment_errors.
    const shaped = shapeStripeError(err);
    logPaymentError({
      userId:                req.user?.id,
      missionId,
      stripePaymentIntentId: paymentIntentId,
      errorCode:             shaped.errorCode,
      errorMessage:          shaped.errorMessage || err.message,
      declineCode:           shaped.declineCode,
      paymentMethod:         shaped.paymentMethod,
      amountCents:           null,
      currency:              'usd',
      stage:                 'confirm',
      userAgent:             req.headers?.['user-agent'] || null,
    }).catch(() => {});
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

/**
 * Pass 22 Bug 22.9 + Pass 23 Bug 23.0c — POST /api/payments/errors/log
 *
 * Frontend reports a Stripe-related failure that happened on the client
 * side (confirmCardPayment caught error, wallet sheet dismissed, Element
 * not mounted in 5s, etc.) so the row lands in payment_errors alongside
 * backend errors.
 *
 * Pass 23 Bug 23.0c — auth is now OPTIONAL. The Bali Safari forensic
 * showed the original logger silently failed because the user's session
 * had expired before the Element timeout fired, returning 401 from this
 * endpoint and swallowing the only telemetry we'd have. The whole point
 * of mount-failure capture is logging failures that happen pre-auth or
 * with stale sessions. user_id is best-effort resolved from the
 * Authorization JWT if present; null otherwise.
 *
 * Pass 23 Bug 23.0a / 23.0c — added stages:
 *   client_element_mount_timeout — 5s ready-event timeout
 *   elements_provider_error      — Stripe Elements provider onError
 *
 * Always returns 202 — never block the user-visible error path on
 * telemetry. Rate limiter is mounted at the route level in app.js so
 * abusive volume gets dropped without affecting the rest of the API.
 */
async function resolveUserIdFromAuth(req) {
  const auth = req.headers?.authorization || '';
  if (!auth.startsWith('Bearer ')) return null;
  const token = auth.slice('Bearer '.length).trim();
  if (!token) return null;
  try {
    const { data, error } = await supabase.auth.getUser(token);
    if (error || !data?.user?.id) return null;
    return data.user.id;
  } catch (_) {
    return null;
  }
}

router.post('/errors/log', async (req, res) => {
  const b = req.body || {};
  const allowedStages = new Set([
    'client_confirm_card',
    'client_wallet_payment_method',
    'client_chat_overage',
    'client_element_not_ready',
    // Pass 23 Bug 23.0a / 23.0c additions
    'client_element_mount_timeout',
    'elements_provider_error',
  ]);
  const stage = allowedStages.has(b.stage) ? b.stage : 'client_unknown';

  // Best-effort user_id resolution. Anon emits land with user_id=null;
  // session_id-less mount failures still land for forensic.
  const userId = await resolveUserIdFromAuth(req);

  const id = await logPaymentError({
    userId,
    missionId:             b.missionId             || null,
    stripePaymentIntentId: b.stripePaymentIntentId || null,
    errorCode:             b.errorCode             || null,
    errorMessage:          b.errorMessage          || null,
    declineCode:           b.declineCode           || null,
    paymentMethod:         b.paymentMethod         || null,
    amountCents:           Number.isFinite(b.amountCents) ? b.amountCents : null,
    currency:              b.currency || 'usd',
    stage,
    userAgent:             req.headers?.['user-agent'] || null,
    viewportWidth:         Number.isFinite(b.viewportWidth) ? b.viewportWidth : null,
  });

  // 202 Accepted — telemetry is fire-and-forget; client should never
  // gate UX on this response. (Was 201; matches the funnel.js ingestion
  // pattern from Pass 22 Bug 22.1.)
  res.status(202).json({ logged: !!id, id });
});

module.exports = router;
