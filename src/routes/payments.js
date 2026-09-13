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
const {
  calculateMissionPrice,
  extractCountriesFromMission,
  validateMissionPricing,
  MAX_SELF_SERVE_RESPONDENTS,
  SELF_SERVE_LEAD_CAPTURE,
  aiSpendCeilingUsd,
  listPriceUsd,
} = require('../utils/pricingEngine');
const { runMission } = require('../jobs/runMission');
const { updateMission } = require('../db/missionSchema');
const { logPaymentError, shapeStripeError } = require('../services/paymentErrors');
// Pass 46 Phase 2 — success-poll fallback trigger (audit P0-1: the live
// Stripe account had no webhook configured, so paid missions never
// started until the 6h recovery cron).
const { confirmCheckoutSessionPaid } = require('../services/payments/confirmCheckoutSession');
const { isComingSoon, notAvailableError } = require('../config/comingSoon');
// media_type is a price on Creative Attention ($19 image / $49 video) and the
// browser writes it. This derives it from the stored object instead.
const { verifyCreativeMediaType } = require('../services/media/creativeMediaType');
// One authority for "may this code be used" and for spending a use of it.
// See src/services/promo/promoCodes.js for why the increment cannot be done
// here with a read, an addition and an un-awaited write.
const {
  resolveUsablePromo,
  recordFreeLaunchRedemption,
  releasePromoUse,
  promoUnusableReason,
} = require('../services/promo/promoCodes');
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

    // §A0 — authoritative gate: never open a Stripe session for a not-yet-live
    // (Coming Soon) type. Fires immediately after the mission is resolved,
    // BEFORE any status/pricing logic and well before createCheckoutSession —
    // so a gated mission (however it was created) can never authorise a charge,
    // only a clean not_available. Backend is the source of truth.
    if (isComingSoon(mission.goal_type)) {
      logger.warn('Payments create-checkout-session: blocked Coming-Soon goal_type', {
        missionId, goal_type: mission.goal_type,
      });
      return res.status(403).json(notAvailableError(mission.goal_type));
    }

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
    // "Usable" (active, unexpired, uses left) is decided in one place now, so
    // a code that is out of uses cannot be honoured on one route and refused
    // on the next.
    const promo = await resolveUsablePromo(supabase, promoCode);

    // Pass 23 Bug 23.61 — fail-closed pricing validation. Reject
    // mismatched {goal_type, tier, media_type} BEFORE computing price
    // so a Creative Attention mission can't accidentally checkout at
    // a Sniff Test rate ($1.80) — the forensic that surfaced this bug
    // (mission a24d3776 paid $1.80 for an Image-tier creative analysis
    // that should have been $19).
    //
    // Pass 51 — this block used to sit BELOW the `free`-promo diversion, so a
    // $0 promo skipped it entirely: an unpriceable mission (brand_lift under
    // the 100 floor, creative_attention with no media_type, anything above the
    // self-serve cap) got { free: true } back and completed via /free-launch,
    // which ran it without a single floor ever being checked. Price is not the
    // only thing this validates — it is also the methodology gate — so it has
    // to run before ANY exit from this route, paid or free.
    // ── media_type is derived from the stored creative, not from the row ─────
    //
    // Creative Attention charges $19 for an image and $49 for a video, and
    // media_type is what picks between them. The browser writes that column on
    // the client-side mission INSERT (the RLS INSERT policy blocks status and
    // the payment columns, not this one), and until now nothing server-side
    // ever compared it to the file. A row that says "image" over an uploaded
    // mp4 bought the full 30-frame video analysis for the image price - the
    // analysis pipeline branches on the attachment, not on this column, so it
    // did the video work regardless.
    //
    // The block below used to look like verification and was not: it stamped
    // `media_type: mission.media_type || null`, the row's own value copied back
    // onto the row.
    //
    // Fails closed ONLY on a definite disagreement. An unreadable or
    // unrecognised object leaves the question unanswered, and an unanswered
    // question must not block a legitimate purchase - the run gate re-derives
    // before any money is spent.
    const mediaCheck = await verifyCreativeMediaType(supabase, mission);
    if (mediaCheck.mismatch) {
      logger.warn('Payments create-checkout-session: media_type disagrees with the stored creative', {
        missionId, declared: mediaCheck.declared, detected: mediaCheck.derived,
        source: mediaCheck.source, format: mediaCheck.format,
      });
      return res.status(400).json({
        error: 'The creative you uploaded does not match the analysis type on this mission.',
        reason: 'media_type_mismatch',
        declared: mediaCheck.declared,
        detected: mediaCheck.derived,
      });
    }
    // What the price is computed from from here on. Derived when we could read
    // the object, the row's own value when we could not.
    const pricedMediaType = mediaCheck.checked ? mediaCheck.derived : (mission.media_type || null);

    const validation = validateMissionPricing({
      goalType:        mission.goal_type,
      respondentCount: mission.respondent_count,
      mediaType:       pricedMediaType,
    });
    if (!validation.valid) {
      logger.warn('Payments create-checkout-session: pricing validation failed', {
        missionId, goal_type: mission.goal_type, media_type: mission.media_type,
        respondent_count: mission.respondent_count, error: validation.error,
      });
      return res.status(400).json({
        error: 'Mission pricing is not valid for checkout',
        reason: validation.error,
      });
    }

    // Free / 100%-off promos ($0) never touch Stripe. The pricing engine
    // intentionally does not zero a `free`-type code (it only discounts
    // percentage/flat), and a $0 Session would fail the <$0.50 minimum below
    // anyway — so a `free` code sent here would otherwise checkout at FULL
    // price. The dedicated /api/payments/free-launch path (which re-validates
    // the code server-side, enforces the Coming-Soon gate, marks the mission
    // paid, and runs it) is the correct $0 route. Signal the client to complete
    // via that path. Only `type === 'free'` diverts; percentage/flat/no-promo
    // fall through to the normal Stripe session below, entirely unchanged.
    //
    // Position matters: this now sits AFTER validateMissionPricing. The
    // short-circuit itself is unchanged — same condition, same response body —
    // it just no longer outruns the gate.
    if (promo && promo.type === 'free') {
      return res.json({ free: true, missionId, promoCode: promo.code });
    }

    // Recalculate price server-side — single source of truth.
    // Pass 23 Bug 23.61 fix — pass goalType + mediaType so the engine
    // routes to the right ladder (Creative Attention flat-per-asset
    // vs Brand Lift statistical-sample vs default volume).
    const countries = extractCountriesFromMission(mission);
    pricing = calculateMissionPrice({
      respondentCount: mission.respondent_count,
      targeting:       mission.targeting || {},
      questionCount:   (mission.questions || []).length,
      countries,
      promoCode:       promo,
      goalType:        mission.goal_type,
      mediaType:       pricedMediaType,
    });

    // PR A — fail-closed guard. An Enterprise/custom-tier mission has no
    // self-serve price. validateMissionPricing above
    // already rejects it, but this never lets a $0-base charge (or a surcharge-
    // only charge on a $0 base) reach Stripe even if that gate ever changes.
    //
    // customQuote is set for any mission above
    // MAX_SELF_SERVE_RESPONDENTS, so this is the money-side backstop for a
    // draft that was created before the cap existed. The response carries the
    // lead-capture destination so the client has somewhere to send the buyer.
    if (pricing.customQuote) {
      return res.status(400).json({
        error: 'This study size requires a custom quote, please contact sales.',
        reason: 'enterprise_custom_quote',
        maxSelfServeRespondents: MAX_SELF_SERVE_RESPONDENTS,
        leadCapture: SELF_SERVE_LEAD_CAPTURE,
      });
    }

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
      // Pass 36 A0d — redirect to /processing/{id} immediately so the
      // customer sees their mission booting up rather than being
      // bounced to a generic /payment-success or /setup. /processing
      // polls mission status and auto-redirects to /results when
      // status='completed'. May 11 demo went to /setup after pay,
      // which was the wrong page entirely.
      successUrl:         `${FRONTEND_URL}/processing/${missionId}?session_id={CHECKOUT_SESSION_ID}`,
      // Pass 23 Bug 23.71 — flow-aware cancel URL. Was hardcoded to
      // /payment-cancel which then bounced to a generic setup page; user
      // lost their CA upload + form state. Cancel-URL now takes the user
      // back to the right setup surface with retry=true so the page can
      // hydrate the draft mission and show a "Payment cancelled — click
      // pay to retry" banner.
      cancelUrl:          (mission.goal_type === 'creative_attention'
        ? `${FRONTEND_URL}/creative-attention/new?retry=true&mission_id=${missionId}`
        : `${FRONTEND_URL}/setup?goal=${encodeURIComponent(mission.goal_type || 'validate')}&retry=true&mission_id=${missionId}`),
      metadata: {
        promoCode: promo?.code || '',
      },
    });

    // Snapshot pricing + the new checkout_session_id (Pass 23 Bug 23.0e
    // v2) AND latest_payment_intent_id (the PI Stripe creates synchronously
    // when the Session is created). Both whitelisted in missionSchema.
    //
    // Pass 23 Bug 23.61 — also stamp `tier` and `media_type` so the
    // audit trail on every paid mission carries the resolved tier id.
    // The frontend should send these on mission INSERT, but we re-stamp
    // here as belt-and-suspenders since validation passed.
    const resolvedTierId = validation.tier?.id || null;
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
      tier:                      resolvedTierId,
      // Was `mission.media_type || null` - the row's own value written back,
      // which verified nothing. A row whose media_type disagrees with the
      // stored object never reaches this line now; one that is simply MISSING
      // gets filled in from the object.
      media_type:                mission.media_type || pricedMediaType,
      // Pass 43 T1a - recompute the authoritative recruitment-loop
      // columns at checkout. The client-side Setup insert (Pass 43 T1a
      // frontend) writes a PROVISIONAL ceiling from the pre-checkout
      // price estimate; this is the first point we know the final
      // surcharges, so we recompute. target_qualified_count ==
      // respondent_count. Without this a mission that came through the
      // client insert path with a NULL or stale ceiling silently
      // bypasses the recruitment loop.
      //
      // THE BASIS IS THE LIST PRICE, NOT THE CHARGE. This line used to read
      // `aiSpendCeilingUsd(pricing.total)`, and `pricing` here is the
      // POST-PROMO quote - the one that pays Stripe. So a mission bought with
      // a 50%-off code got half the compute budget of an identical full-price
      // mission, for identical work: same respondent count, same recruit loop,
      // same model calls. The ceiling governs compute, not revenue, so it does
      // not move with a discount. Handing aiSpendCeilingUsd the whole
      // breakdown makes it read `subtotal` (pre-discount) for itself, which is
      // also what free-launch and POST /missions do.
      target_qualified_count:    mission.respondent_count,
      ai_spend_ceiling_usd:      aiSpendCeilingUsd(pricing),
      recruitment_status:        'pending',
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

    // Pass 46 Phase 2 — P0-1 fallback: the success page polls this
    // endpoint every 2s after Stripe redirects back. If the session is
    // complete+paid, confirm the mission and fire the pipeline NOW
    // instead of waiting for a webhook that (audit finding) was never
    // configured. Idempotent: status guard inside + runMission's claim.
    // Fire-and-forget so the poll response stays fast.
    setImmediate(() => {
      confirmCheckoutSessionPaid({ supabase, runMission }, session).catch((err) => {
        logger.error('checkout-session fallback crashed', {
          sessionId: session.id, err: err.message,
        });
      });
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
    // Cheap early refusal on the row we just read. It is NOT the enforcement -
    // two requests can read the same count - it just saves the work below for
    // a code that is plainly finished. The claim further down is what decides.
    if (promoUnusableReason(promo)) {
      return res.status(403).json({ error: 'Promo code is no longer valid' });
    }

    // Widened from {id, status, user_id, goal_type, respondent_count,
    // media_type}: this route now prices the mission server-side, so it needs
    // the same inputs create-checkout-session reads (targeting, questions,
    // target_audience) plus brief_attachment to check the creative.
    const { data: mission } = await supabase
      .from('missions')
      .select('id, status, user_id, goal_type, respondent_count, media_type, '
            + 'targeting, questions, target_audience, brief_attachment')
      .eq('id', missionId)
      .eq('user_id', req.user.id)
      .single();

    if (!mission) return res.status(404).json({ error: 'Mission not found' });

    // §A0 — free-launch pays ($0) + RUNS a mission without Stripe. Never let it
    // launch a not-yet-live type. Fires before status checks / updateMission / run.
    if (isComingSoon(mission.goal_type)) {
      logger.warn('Free-launch: blocked Coming-Soon goal_type', { missionId, goal_type: mission.goal_type });
      return res.status(403).json(notAvailableError(mission.goal_type));
    }

    const status = (mission.status || '').toLowerCase();
    if (['processing', 'completed', 'paid'].includes(status)) {
      return res.json({ success: true, missionId, status: 'already_running' });
    }
    const launchable = ['draft', 'pending_payment', 'active'].includes(status);
    if (!launchable) {
      return res.status(400).json({ error: `Mission cannot be free-launched from status: ${status}` });
    }

    // Pass 51 — the same fail-closed pricing gate create-checkout-session
    // runs. This route is a door in its own right, not a continuation of that
    // one: PayButton.tsx and DashboardPage.tsx both POST here directly once
    // they see { free: true }, and nothing stops a client POSTing here first.
    // Reordering the gate over there closes the referred path; this closes the
    // route. $0 is a price, and a mission that cannot be priced or cannot
    // support its own methodology must not RUN either, which is what this
    // endpoint authorises.
    //
    // Placed after the status guards so the already_running short-circuit
    // stays idempotent for missions that predate the floors, and before
    // updateMission so no status flip or run can happen on a failure.
    // The same server-side media_type derivation create-checkout-session runs.
    // A free launch does not charge, but it does authorise the run, and the
    // run is where the video-vs-image difference is actually spent.
    const mediaCheck = await verifyCreativeMediaType(supabase, mission);
    if (mediaCheck.mismatch) {
      logger.warn('Free-launch: media_type disagrees with the stored creative', {
        missionId, declared: mediaCheck.declared, detected: mediaCheck.derived,
        source: mediaCheck.source, format: mediaCheck.format,
      });
      return res.status(400).json({
        error: 'The creative you uploaded does not match the analysis type on this mission.',
        reason: 'media_type_mismatch',
        declared: mediaCheck.declared,
        detected: mediaCheck.derived,
      });
    }
    const pricedMediaType = mediaCheck.checked ? mediaCheck.derived : (mission.media_type || null);

    const validation = validateMissionPricing({
      goalType:        mission.goal_type,
      respondentCount: mission.respondent_count,
      mediaType:       pricedMediaType,
    });
    if (!validation.valid) {
      logger.warn('Free-launch: pricing validation failed', {
        missionId, goal_type: mission.goal_type, media_type: mission.media_type,
        respondent_count: mission.respondent_count, error: validation.error,
      });
      return res.status(400).json({
        error: 'Mission pricing is not valid for checkout',
        reason: validation.error,
      });
    }

    // ── Price the mission server-side, twice, for two different questions ───
    //
    // WHAT THEY ARE CHARGED is the price with the free code applied. The
    // engine zeroes a `free`-type promo (discount = subtotal), so this is $0,
    // and writing it keeps the payment-covers-run gate coherent: $0 owed
    // against $0 captured.
    //
    // WHAT THE RUN MAY SPEND is a fraction of the LIST price. The ceiling
    // exists to bound cost against the work, and a free mission does exactly
    // the same work as a paid one. Deriving it from the $0 charge would set it
    // to $0, and runMission refuses any mission whose ceiling is not positive -
    // a free launch would never start. 30% of list is the same rule
    // create-checkout-session and POST /missions apply.
    //
    // This used to price the mission TWICE, once with the promo and once
    // without, to get at the list number. It does not need to: `subtotal` on a
    // breakdown is pre-discount by construction, so one quote carries both
    // answers and aiSpendCeilingUsd reads the list one off the object. Two
    // calls meant two sets of inputs that could drift apart; there is now one.
    const priceInputs = {
      respondentCount: mission.respondent_count,
      targeting:       mission.targeting || {},
      questionCount:   (mission.questions || []).length,
      countries:       extractCountriesFromMission(mission),
      goalType:        mission.goal_type,
      mediaType:       pricedMediaType,
    };
    const chargedPricing = calculateMissionPrice({ ...priceInputs, promoCode: promo });
    const freeLaunchCeilingUsd = aiSpendCeilingUsd(chargedPricing);

    logger.info('Free-launch: server-computed governors', {
      missionId,
      target_qualified_count: mission.respondent_count,
      ai_spend_ceiling_usd:   freeLaunchCeilingUsd,
      list_price_usd:         listPriceUsd(chargedPricing),
      charged_usd:            chargedPricing.total,
      media_type_source:      mediaCheck.source,
    });

    // ── Spend the use BEFORE the mission is marked paid ─────────────────────
    //
    // The old code marked the mission paid and then fired an un-awaited
    // read-modify-write at uses_count. Two launches in the same second both
    // read the same count, both wrote the same count back, and both ran: the
    // 26th use of a 25-use code was free. This claim is a single conditional
    // statement the database arbitrates, so of two requests racing the last
    // use exactly one is told it got it.
    //
    // Order matters, and both orders can lose something. Claim first and a
    // launch that then fails to be marked paid would burn a use - so the
    // failure path hands it straight back below. Mark paid first and a code
    // that filled up in between would have already run the mission for free,
    // which is the loss that cannot be undone. So: claim, then pay, then run.
    //
    // A retried request never reaches here: the status guard above returns
    // already_running for a mission that is already paid.
    const claim = await recordFreeLaunchRedemption(supabase, {
      code: promo.code, missionId,
    });
    if (!claim.claimed) {
      logger.warn('Free-launch: promo claim refused', {
        missionId, promoCode: promo.code, reason: claim.reason,
      });
      return res.status(403).json({
        error: claim.reason === 'exhausted'
          ? 'This promo code has been fully redeemed'
          : 'Promo code is no longer valid',
        reason: claim.reason,
      });
    }

    try {
      await updateMission(supabase, missionId, {
        status:    'paid',
        paid_at:   new Date().toISOString(),
        promo_code: promoCode.toUpperCase(),
        // ── The two governors of the recruit loop, written by the SERVER ────
        //
        // This route used to write only the three lines above. Both numbers
        // the recruit loop is governed by - how many qualified respondents to
        // chase, and how much AI spend is allowed chasing them - were then
        // whatever the browser put on the row at INSERT. The RLS INSERT policy
        // blocks status, paid_at, paid_amount_cents, promo_code and
        // ai_spend_usd_actual; it does not block these two, and `authenticated`
        // holds INSERT on both columns.
        //
        // Neither live gate caught it. runMission only requires the ceiling to
        // be a positive number, and the payment-covers-run gate prices a
        // free-promo mission at $0 owed against $0 captured, which passes by
        // construction.
        //
        // The pass-51 trigger cannot cover this either: it fires ON UPDATE OF
        // respondent_count, total_price_usd, and its ceiling branch only
        // recomputes when the new price is above zero - which a free launch's
        // never is. So these are written here explicitly rather than left to
        // the database.
        target_qualified_count: mission.respondent_count,
        ai_spend_ceiling_usd:   freeLaunchCeilingUsd,
        recruitment_status:     'pending',
        // What the customer was actually charged. Zero, and recorded as zero
        // rather than left holding a client-written estimate.
        total_price_usd:        chargedPricing.total,
        base_cost_usd:          chargedPricing.baseCost,
        targeting_surcharge_usd:  chargedPricing.targetingSurcharge,
        extra_questions_cost_usd: chargedPricing.extraQuestionsCost,
        discount_usd:           chargedPricing.discount,
      }, { caller: 'POST /payments/free-launch' });
    } catch (err) {
      // The mission did not become paid, so the customer did not get the
      // launch they spent the use on. Give it back before rethrowing.
      await releasePromoUse(supabase, {
        code: promo.code, missionId, source: 'free_launch_rollback',
      });
      throw err;
    }

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
