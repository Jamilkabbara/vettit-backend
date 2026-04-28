const Stripe = require('stripe');
const logger = require('../utils/logger');

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

/**
 * Create a Stripe PaymentIntent for a mission
 */
async function createPaymentIntent({ amountCents, missionId, userId, userEmail, pricingBreakdown }) {
  const paymentIntent = await stripe.paymentIntents.create({
    amount: amountCents,
    currency: 'usd',
    metadata: {
      missionId,
      userId,
      userEmail,
      baseCost: pricingBreakdown.baseCost,
      total: pricingBreakdown.total,
    },
    receipt_email: userEmail,
    description: `Vettit Mission #${missionId}`,
  });

  logger.info('Stripe PaymentIntent created', { missionId, amount: amountCents });

  return {
    clientSecret: paymentIntent.client_secret,
    paymentIntentId: paymentIntent.id,
  };
}

/**
 * Verify a payment was successful
 */
async function verifyPayment(paymentIntentId) {
  const paymentIntent = await stripe.paymentIntents.retrieve(paymentIntentId);
  return {
    success: paymentIntent.status === 'succeeded',
    status: paymentIntent.status,
    amountCents: paymentIntent.amount,
    missionId: paymentIntent.metadata.missionId,
  };
}

/**
 * Pass 22 Bug 22.23 — Retrieve a Stripe PI by id. Returns the raw PI on
 * success or null on any failure (404, network, etc.). Never throws — the
 * caller decides whether to fall back to creating a fresh PI.
 *
 * Used by /api/payments/create-intent to resume an in-flight PI rather than
 * sprawl a fresh one on every retry.
 */
async function retrievePaymentIntent(paymentIntentId) {
  if (!paymentIntentId) return null;
  try {
    return await stripe.paymentIntents.retrieve(paymentIntentId);
  } catch (err) {
    logger.warn('Stripe PI retrieve failed (returning null)', {
      paymentIntentId,
      err: err.message,
    });
    return null;
  }
}

/**
 * Pass 22 Bug 22.23 — States from which the same PI can still be confirmed by
 * the user. Anything outside this set means "create a new PI."
 *
 * Stripe PI lifecycle reference:
 *   requires_payment_method → no PM attached or last attempt failed (most stuck PIs)
 *   requires_confirmation   → PM attached, awaiting confirm (rare in our flow)
 *   requires_action         → 3DS / SCA pending — same checkout session
 *   processing              → async (e.g. bank transfer) — wait, do not duplicate
 *   succeeded / canceled    → terminal
 */
const RESUMABLE_PI_STATUSES = new Set([
  'requires_payment_method',
  'requires_confirmation',
  'requires_action',
  'processing',
]);

/**
 * Pass 22 Bug 22.23 — Decide whether a PI returned from Stripe is still safe
 * to reuse for the same mission, or whether we should abandon it and mint a
 * new one. Three conditions must all hold:
 *
 *   1) status is in RESUMABLE_PI_STATUSES
 *   2) PI age < 24h (Stripe expires PIs in some states; quotes drift)
 *   3) PI amount matches the freshly-recalculated server-side total
 *      (promo applied/removed, country tier changed, etc.)
 *
 * Returns { resumable: boolean, reason: string }.
 */
function assessPIResumability(pi, expectedAmountCents) {
  if (!pi) return { resumable: false, reason: 'no_pi' };
  if (pi.status === 'succeeded') return { resumable: false, reason: 'already_succeeded' };
  if (pi.status === 'canceled')  return { resumable: false, reason: 'canceled' };
  if (!RESUMABLE_PI_STATUSES.has(pi.status)) {
    return { resumable: false, reason: `terminal_status:${pi.status}` };
  }

  // Freshness — created is unix seconds; allow 24h.
  const ageSec = Math.floor(Date.now() / 1000) - (pi.created || 0);
  if (ageSec > 24 * 60 * 60) {
    return { resumable: false, reason: 'stale_>24h' };
  }

  // Price drift — refuse to reuse a PI whose amount doesn't match the
  // current quote. Promo applied, promo removed, country re-targeting, etc.
  if (Number.isFinite(expectedAmountCents) && pi.amount !== expectedAmountCents) {
    return { resumable: false, reason: `amount_drift:${pi.amount}_vs_${expectedAmountCents}` };
  }

  return { resumable: true, reason: 'ok' };
}

/**
 * Create a refund.
 *
 * Pass 23 Bug 23.25 — extended to take optional `amountCents` (partial refund),
 * `idempotencyKey` (so a runMission retry doesn't double-refund the same gap),
 * and `metadata` (forensic). Backwards-compatible with the old signature: if
 * `amountCents` is omitted Stripe issues a full refund as before.
 *
 * Reason values Stripe accepts: 'duplicate' | 'fraudulent' | 'requested_by_customer'.
 * For partial-delivery refunds we pass 'requested_by_customer' (closest semantic
 * fit) and put the real reason in metadata so the Stripe Dashboard surfaces it.
 */
async function createRefund({
  paymentIntentId,
  amountCents,
  idempotencyKey,
  metadata = {},
  reason = 'requested_by_customer',
}) {
  const params = {
    payment_intent: paymentIntentId,
    reason,
  };
  if (Number.isFinite(amountCents) && amountCents > 0) {
    params.amount = Math.floor(amountCents);
  }
  if (metadata && typeof metadata === 'object') {
    params.metadata = metadata;
  }
  const opts = idempotencyKey ? { idempotencyKey } : undefined;
  const refund = await stripe.refunds.create(params, opts);
  logger.info('Stripe refund created', {
    paymentIntentId, refundId: refund.id,
    amountCents: refund.amount, status: refund.status, idempotencyKey: idempotencyKey || null,
  });
  return refund;
}

/**
 * Construct webhook event (validates Stripe signature)
 */
function constructWebhookEvent(payload, signature) {
  return stripe.webhooks.constructEvent(
    payload,
    signature,
    process.env.STRIPE_WEBHOOK_SECRET
  );
}

/**
 * Pass 23 Bug 23.0d — find an orphaned PI for this mission via Stripe
 * metadata search.
 *
 * Used as a salvage fallback in /api/payments/create-intent when
 * mission.latest_payment_intent_id is NULL (legacy mission predating Bug
 * 22.23, or row column drifted out of sync). Without this fallback, the
 * route always creates a fresh PI even when a perfectly-good resumable
 * one already exists in Stripe.
 *
 * Returns the most recently created salvageable PI, or null if none.
 *
 * Salvageable conditions:
 *   * status in RESUMABLE_PI_STATUSES (no terminal states)
 *   * created < 24h ago (Stripe expires unattended PIs around this window)
 *   * amount === expectedAmountCents (catches promo / pricing drift)
 *
 * Stripe Search API note: it has eventual consistency (~1-2s). For a
 * just-created PI, search may not return it. That's fine — the row-column
 * fast-path above covers fresh PIs; salvage is only for orphans.
 */
async function findSalvageablePI(missionId, expectedAmountCents) {
  if (!missionId) return null;
  try {
    const result = await stripe.paymentIntents.search({
      query: `metadata['missionId']:'${missionId}'`,
      limit: 10,
    });
    if (!result?.data || result.data.length === 0) return null;

    const cutoffSec = Math.floor(Date.now() / 1000) - 24 * 60 * 60;
    const salvageable = result.data
      .filter((pi) => RESUMABLE_PI_STATUSES.has(pi.status))
      .filter((pi) => (pi.created || 0) > cutoffSec)
      .filter((pi) => pi.amount === expectedAmountCents)
      .sort((a, b) => (b.created || 0) - (a.created || 0));

    return salvageable[0] || null;
  } catch (err) {
    logger.warn('findSalvageablePI search failed', { missionId, err: err.message });
    return null;
  }
}

/**
 * Pass 23 Bug 23.0e v2 — create a Stripe Checkout Session for a mission.
 *
 * Replaces the previous PaymentIntent + Stripe Elements integration. The
 * user is redirected to checkout.stripe.com (Stripe-hosted form) which
 * works reliably across all browsers including Safari (where iframe
 * Element mount kept failing despite multiple defensive layers).
 *
 * payment_intent_data.metadata is inherited by the underlying PI, so
 * existing payment_intent.succeeded / payment_intent.payment_failed
 * webhook handlers continue to work without modification (mission_id /
 * userId etc. land on the PI metadata exactly as before).
 *
 * Returns { id, url, paymentIntentId } where url is the redirect target.
 * paymentIntentId is set immediately because Stripe creates the PI
 * synchronously when the Session is created.
 */
async function createCheckoutSession({
  amountCents,
  missionId,
  userId,
  userEmail,
  pricingBreakdown,
  productName,
  productDescription,
  successUrl,
  cancelUrl,
  metadata = {},
}) {
  const session = await stripe.checkout.sessions.create({
    mode: 'payment',
    payment_method_types: ['card'],
    payment_method_options: {
      card: { request_three_d_secure: 'automatic' },
    },
    line_items: [{
      price_data: {
        currency: 'usd',
        product_data: {
          name: productName || `Vettit Mission`,
          description: productDescription || undefined,
        },
        unit_amount: amountCents,
      },
      quantity: 1,
    }],
    customer_email: userEmail,
    success_url: successUrl,
    cancel_url:  cancelUrl,
    // 1-hour expiry on Sessions; user can re-create via "Resume checkout".
    expires_at: Math.floor(Date.now() / 1000) + 60 * 60,
    // Stripe-native promotion code field on the Checkout page. Pre-applied
    // promos via our /api/pricing/quote bake into the unit_amount; this
    // toggle lets users enter additional codes Stripe-side if we ever
    // sync our promo_codes table to Stripe Coupons.
    allow_promotion_codes: true,
    // Session-level metadata for checkout.session.* webhook events.
    metadata: {
      missionId: missionId || '',
      userId:    userId    || '',
      ...metadata,
    },
    // Inherited onto the underlying PaymentIntent — keeps the existing
    // payment_intent.succeeded / payment_failed webhook handlers working.
    payment_intent_data: {
      metadata: {
        missionId: missionId || '',
        userId:    userId    || '',
        userEmail: userEmail || '',
        baseCost:  pricingBreakdown?.baseCost ?? '',
        total:     pricingBreakdown?.total    ?? '',
        ...metadata,
      },
      receipt_email: userEmail,
      description:   productName ? `Vettit Mission: ${productName}` : `Vettit Mission`,
    },
  });

  logger.info('Stripe Checkout Session created', {
    missionId, sessionId: session.id, paymentIntentId: session.payment_intent,
  });

  return {
    id: session.id,
    url: session.url,
    paymentIntentId: typeof session.payment_intent === 'string'
      ? session.payment_intent
      : session.payment_intent?.id || null,
  };
}

/**
 * Pass 23 Bug 23.0e v2 — retrieve a Stripe Checkout Session by id. Returns
 * the raw session object on success or null on any failure. Never throws.
 * Used by GET /api/payments/checkout-session/:id (frontend polling on
 * /payment-success page) and by the webhook handler.
 */
async function retrieveCheckoutSession(sessionId) {
  if (!sessionId) return null;
  try {
    return await stripe.checkout.sessions.retrieve(sessionId);
  } catch (err) {
    logger.warn('Stripe Checkout Session retrieve failed (returning null)', {
      sessionId, err: err.message,
    });
    return null;
  }
}

module.exports = {
  createPaymentIntent,
  verifyPayment,
  retrievePaymentIntent,
  assessPIResumability,
  findSalvageablePI,
  RESUMABLE_PI_STATUSES,
  createRefund,
  constructWebhookEvent,
  // Pass 23 Bug 23.0e v2 — Checkout Session migration
  createCheckoutSession,
  retrieveCheckoutSession,
};
