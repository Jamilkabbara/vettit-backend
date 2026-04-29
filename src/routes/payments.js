/**
 * VETT — payment routes.
 *
 * Pass 23 Bug 23.0e v2: full Stripe Checkout migration.
 *   * REPLACED  POST /create-intent  → POST /create-checkout-session
 *   * NEW       GET  /checkout-session/:id  (success-page polling)
 *   * REMOVED   POST /confirm  (Stripe webhooks are authoritative)
 *   * KEPT      POST /errors/log  (anon-friendly client-error telemetry)
 *   * KEPT      POST /free-launch  ($0 promo path, no Stripe involved)
 *
 * Why the migration: after Pass 22 ready-event gating, Pass 23 Bug 23.0a
 * 2-frame rAF + 5s timeout + retry, anon telemetry, and idempotent
 * create-intent + Stripe metadata salvage, Safari Mac still reproduced
 * the iframe-mount race. The fix surrenders inline Elements UX in favour
 * of a redirect to checkout.stripe.com — standard pattern for $9-$199
 * SaaS that works reliably across the device matrix.
 */

const express = require('express');
const router = express.Router();
const { authenticate } = require('../middleware/auth');
const stripeService = require('../services/stripe');
const supabase = require('../db/supabase');
const { calculateMissionPrice, extractCountriesFromMission } = require('../utils/pricingEngine');
const { runMission } = require('../jobs/runMission');
const { updateMission } = require('../db/missionSchema');
const { logPaymentError, shapeStripeError } = require('../services/paymentErrors');
const logger = require('../utils/logger');

const FRONTEND_URL = process.env.FRONTEND_URL || 'https://www.vettit.ai';

/**
 * POST /api/payments/create-checkout-session
 *
 * Creates a Stripe Checkout Session for a mission and returns its URL.
 * Frontend redirects: window.location.href = url. SERVER-SIDE PRICING:
 * recalculates from scratch using the mission row, never trusts client
 * totals. Promo codes can be applied either pre-Session (via promoCode
 * body field, baked into unit_amount) OR Stripe-side via
 * allow_promotion_codes (one-off coupons).
 */
router.post('/create-checkout-session', authenticate, async (req, res, next) => {
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
    // Already-paid short-circuit — frontend redirects to results.
    if (['paid', 'processing', 'completed'].includes(status)) {
      logger.info('Payments create-checkout-session: mission already paid', { missionId, status });
      return res.status(409).json({
        error: 'Mission already paid',
        status,
        redirectTo: `/results/${missionId}`,
      });
    }
    if (status !== 'draft' && status !== 'pending_payment') {
      return res.status(400).json({ error: 'Mission is not in draft status' });
    }

    // Resolve promo code (if any). Validation happens server-side; the
    // promo_codes table is RLS-locked from clients (Pass 23 Bug 23.1).
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

    // Recalculate price server-side — single source of truth.
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

    // Get user email for the receipt.
    const { data: { user } } = await supabase.auth.admin.getUserById(req.user.id);

    const session = await stripeService.createCheckoutSession({
      amountCents:        pricing.totalCents,
      missionId,
      userId:             req.user.id,
      userEmail:          user?.email,
      pricingBreakdown:   pricing,
      productName:        mission.title || 'Research Mission',
      productDescription: `${mission.respondent_count || 0} qualified respondents`,
      successUrl:         `${FRONTEND_URL}/payment-success?session_id={CHECKOUT_SESSION_ID}`,
      cancelUrl:          `${FRONTEND_URL}/payment-cancel?mission_id=${missionId}`,
      metadata: {
        promoCode: promo?.code || '',
      },
    });

    // Snapshot pricing + the new checkout_session_id (Pass 23 Bug 23.0e
    // v2) AND latest_payment_intent_id (the PI Stripe creates synchronously
    // when the Session is created). Both whitelisted in missionSchema.
    await updateMission(supabase, missionId, {
      base_cost_usd:             pricing.baseCost,
      targeting_surcharge_usd:   pricing.targetingSurcharge,
      extra_questions_cost_usd:  pricing.extraQuestionsCost,
      total_price_usd:           pricing.total,
      promo_code:                promo?.code || null,
      discount_usd:              pricing.discount,
      status:                    'pending_payment',
      checkout_session_id:       session.id,
      latest_payment_intent_id:  session.paymentIntentId,
    }, { caller: 'POST /payments/create-checkout-session' });

    logger.info('Checkout Session created', {
      missionId, sessionId: session.id, amount: pricing.total,
    });

    res.json({
      url: session.url,
      sessionId: session.id,
      pricing,
    });
  } catch (err) {
    // Log the failure to payment_errors before bubbling.
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
      stage:                 'create_checkout_session',
      userAgent:             req.headers?.['user-agent'] || null,
    }).catch(() => {});
    next(err);
  }
});

/**
 * GET /api/payments/checkout-session/:id
 *
 * Returns minimal Checkout Session status for the /payment-success page
 * to poll. Frontend polls this every 2s until status='complete' or until
 * the 90s timeout fires.
 *
 * Pass 23 Bug 23.52 — anon-friendly. The user's Supabase auth session can
 * expire during a 60+ second Stripe Checkout flow (especially on Apple
 * Pay biometric or 3D Secure interstitials). When the user lands back on
 * /payment-success their cookie may be stale. The Checkout Session id
 * (`cs_xxx_<32 random hex>`) is sufficiently random + secret to act as a
 * capability token on its own — leaking it to a third party gives no
 * material advantage (the response only carries status + missionId, no
 * PII). Removing the auth requirement here means the polling loop works
 * even before the user re-signs in, and the page can branch on auth
 * separately to render either the spinner or a sign-in CTA.
 *
 * If a userId was authenticated AND it doesn't match session.metadata.userId,
 * we still 403 — defends against guessing attacks if anyone ever brute-
 * forces a Checkout id (mathematically near-impossible but cheap to
 * defend).
 */
router.get('/checkout-session/:id', async (req, res, next) => {
  try {
    const session = await stripeService.retrieveCheckoutSession(req.params.id);
    if (!session) return res.status(404).json({ error: 'Session not found' });

    // Soft ownership guard — only enforced if request carried a Bearer.
    // Without auth the response is still safe (no PII, polling-only data).
    const authHeader = req.headers.authorization;
    if (authHeader && authHeader.startsWith('Bearer ')) {
      try {
        const token = authHeader.slice(7);
        const { data: { user } } = await supabase.auth.getUser(token);
        const sessionUserId = session.metadata?.userId;
        if (user?.id && sessionUserId && sessionUserId !== user.id) {
          return res.status(403).json({ error: 'Forbidden' });
        }
      } catch { /* token invalid → treat as anon, don't block */ }
    }

    res.json({
      id:               session.id,
      status:           session.status,           // open | complete | expired
      paymentStatus:    session.payment_status,   // paid | unpaid | no_payment_required
      paymentIntentId:  typeof session.payment_intent === 'string'
                          ? session.payment_intent
                          : session.payment_intent?.id || null,
      missionId:        session.metadata?.missionId || null,
      amountTotal:      session.amount_total,
      currency:         session.currency,
    });
  } catch (err) { next(err); }
});

/**
 * POST /api/payments/free-launch
 * VETT100 + future $0 promo path. Validates promo, sets status='paid',
 * fires runMission. No Stripe involvement.
 */
router.post('/free-launch', authenticate, async (req, res, next) => {
  try {
    const { missionId, promoCode } = req.body;
    if (!missionId || !promoCode) {
      return res.status(400).json({ error: 'missionId and promoCode are required' });
    }

    const { data: promo } = await supabase
      .from('promo_codes')
      .select('*')
      .eq('code', promoCode.toUpperCase().trim())
      .eq('active', true)
      .single();

    if (!promo) return res.status(403).json({ error: 'Invalid or inactive promo code' });
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
    if (['processing', 'completed', 'paid'].includes(status)) {
      return res.json({ success: true, missionId, status: 'already_running' });
    }
    const launchable = ['draft', 'pending_payment', 'active'].includes(status);
    if (!launchable) {
      return res.status(400).json({ error: `Mission cannot be free-launched from status: ${status}` });
    }

    await updateMission(supabase, missionId, {
      status:    'paid',
      paid_at:   new Date().toISOString(),
      promo_code: promoCode.toUpperCase(),
    }, { caller: 'POST /payments/free-launch' });

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
 * Frontend reports a Stripe-related failure (confirmCardPayment catch,
 * wallet sheet dismissed, redirect-flow error, etc.) so the row lands in
 * payment_errors alongside backend errors.
 *
 * Auth is OPTIONAL. user_id best-effort resolved from the Authorization
 * Bearer JWT if present; null otherwise. Lets us capture mount failures
 * that fire pre-auth or with stale sessions (the original Bali Safari
 * failure mode, now resolved by the Checkout migration but the endpoint
 * remains for redirect-flow edge cases and future API integrations).
 *
 * Always returns 202; rate limiter is mounted at /api/payments/errors/log
 * level in app.js (10/min/IP).
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
    // Legacy Elements stages — kept so historic rows keep their semantic
    // group, even though the Elements integration has been removed.
    'client_confirm_card',
    'client_wallet_payment_method',
    'client_chat_overage',
    'client_element_not_ready',
    'client_element_mount_timeout',
    'elements_provider_error',
    // Pass 23 Bug 23.0e v2 — Checkout flow stages.
    'client_checkout_redirect_failed',  // window.location.href set failed (rare)
    'client_checkout_polling_timeout',  // /payment-success page gave up polling
  ]);
  const stage = allowedStages.has(b.stage) ? b.stage : 'client_unknown';

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

  res.status(202).json({ logged: !!id, id });
});

module.exports = router;
