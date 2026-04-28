/**
 * VETT — Chat routes.
 * - POST /api/chat/message      Non-streaming: returns full reply
 * - POST /api/chat/stream       SSE: streams reply token-by-token
 * - GET  /api/chat/session      Fetch existing session + history
 * - POST /api/chat/buy-overage  Create Checkout Session for +50 messages ($5)
 *                               (Pass 23 Bug 23.0e v2: redirect to Stripe Checkout)
 * - POST /api/chat/confirm-overage  Idempotent confirm + credit (kept as
 *                               webhook-race fallback; primary credit happens
 *                               via the existing payment_intent.succeeded
 *                               webhook handler when metadata.purpose='chat_overage')
 */

const express = require('express');
const router  = express.Router();

const { authenticate } = require('../middleware/auth');
const stripeService = require('../services/stripe');
const supabase  = require('../db/supabase');
const chat      = require('../services/ai/chat');
const logger    = require('../utils/logger');

const FRONTEND_URL = process.env.FRONTEND_URL || 'https://www.vettit.ai';

// Hard cap so a buggy frontend can't DOS the model
const MAX_MESSAGE_LEN = 4000;

// ─── POST /api/chat/message ──────────────────────────────────
router.post('/message', authenticate, async (req, res, next) => {
  try {
    const { scope, missionId, message } = req.body;
    if (!scope || !message)      return res.status(400).json({ error: 'scope and message are required' });
    if (!chat.QUOTAS[scope])     return res.status(400).json({ error: `Unknown scope: ${scope}` });
    if (message.length > MAX_MESSAGE_LEN) {
      return res.status(400).json({ error: `Message too long (max ${MAX_MESSAGE_LEN} chars)` });
    }

    const result = await chat.sendMessage({
      userId: req.user.id,
      scope,
      missionId: missionId || null,
      userMessage: message,
    });

    if (result.blocked) return res.status(402).json(result);
    res.json(result);
  } catch (err) { next(err); }
});

// ─── POST /api/chat/stream ────────────────────────────────────
// Server-Sent Events. Client reads `data: { "delta": "..." }` lines until `data: [DONE]`.
router.post('/stream', authenticate, async (req, res, next) => {
  try {
    const { scope, missionId, message } = req.body;
    if (!scope || !message)  return res.status(400).json({ error: 'scope and message are required' });
    if (!chat.QUOTAS[scope]) return res.status(400).json({ error: `Unknown scope: ${scope}` });
    if (message.length > MAX_MESSAGE_LEN) {
      return res.status(400).json({ error: `Message too long (max ${MAX_MESSAGE_LEN} chars)` });
    }

    // SSE headers
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders?.();

    const writeEvent = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);

    const result = await chat.streamMessage({
      userId: req.user.id,
      scope,
      missionId: missionId || null,
      userMessage: message,
      onDelta: (chunk) => writeEvent({ delta: chunk }),
    });

    if (result.blocked) {
      writeEvent({ blocked: true, ...result });
    } else {
      writeEvent({
        done: true,
        sessionId: result.sessionId,
        quota: result.quota,
        model: result.model,
      });
    }
    res.write('data: [DONE]\n\n');
    res.end();
  } catch (err) {
    logger.error('Chat stream error', { err: err.message });
    try {
      res.write(`data: ${JSON.stringify({ error: err.message })}\n\n`);
      res.write('data: [DONE]\n\n');
      res.end();
    } catch (_) { next(err); }
  }
});

// ─── GET /api/chat/session ────────────────────────────────────
router.get('/session', authenticate, async (req, res, next) => {
  try {
    const { scope, missionId } = req.query;
    if (!scope || !chat.QUOTAS[scope]) {
      return res.status(400).json({ error: 'scope is required (results|dashboard|setup)' });
    }
    const summary = await chat.getSessionSummary({
      userId: req.user.id, scope, missionId: missionId || null,
    });
    res.json(summary);
  } catch (err) { next(err); }
});

// ─── POST /api/chat/buy-overage ──────────────────────────────
// Pass 23 Bug 23.0e v2: creates a Stripe Checkout Session and returns
// its URL. Frontend redirects: window.location.href = url. The
// payment_intent_data.metadata fields are inherited onto the underlying
// PI, so the existing payment_intent.succeeded webhook handler (which
// already handles metadata.purpose='chat_overage') credits the session
// without modification.
router.post('/buy-overage', authenticate, async (req, res, next) => {
  try {
    const { sessionId } = req.body;
    if (!sessionId) return res.status(400).json({ error: 'sessionId is required' });

    // Verify ownership
    const { data: session } = await supabase
      .from('chat_sessions').select('id, user_id, scope, mission_id')
      .eq('id', sessionId).single();
    if (!session)                  return res.status(404).json({ error: 'Chat session not found' });
    if (session.user_id !== req.user.id) return res.status(403).json({ error: 'Forbidden' });

    const { data: { user } } = await supabase.auth.admin.getUserById(req.user.id);

    // Pick where to send the user back. Prefer the Referer header (the
    // page that triggered the chat overage modal). Falls back to the
    // dashboard if Referer is missing or off-site.
    const referer = req.headers?.referer || '';
    const safeReturn = referer.startsWith(FRONTEND_URL) ? referer : `${FRONTEND_URL}/missions`;

    const checkout = await stripeService.createCheckoutSession({
      amountCents:        chat.OVERAGE_PRICE_USD * 100,
      missionId:          session.mission_id || null,
      userId:             req.user.id,
      userEmail:          user?.email,
      pricingBreakdown:   { baseCost: chat.OVERAGE_PRICE_USD, total: chat.OVERAGE_PRICE_USD },
      productName:        `VETT chat overage +${chat.OVERAGE_MESSAGES} messages`,
      productDescription: `Adds ${chat.OVERAGE_MESSAGES} messages to your chat session`,
      // Custom return path encodes the chat session id and the page the
      // user was on, so /payment-success can call /api/chat/confirm-overage
      // and bounce back.
      successUrl:         `${FRONTEND_URL}/payment-success?session_id={CHECKOUT_SESSION_ID}&kind=chat_overage&chat_session_id=${encodeURIComponent(sessionId)}&return=${encodeURIComponent(safeReturn)}`,
      cancelUrl:          `${FRONTEND_URL}/payment-cancel?kind=chat_overage&return=${encodeURIComponent(safeReturn)}`,
      // The payment_intent_data.metadata is what the existing
      // payment_intent.succeeded webhook handler reads. purpose='chat_overage'
      // routes the credit to chat_sessions; sessionId scopes the credit.
      metadata: {
        purpose:         'chat_overage',
        sessionId,
        messagesGranted: String(chat.OVERAGE_MESSAGES),
      },
    });

    res.json({
      url: checkout.url,
      sessionId: checkout.id,
      paymentIntentId: checkout.paymentIntentId,
      amountUsd: chat.OVERAGE_PRICE_USD,
      messagesGranted: chat.OVERAGE_MESSAGES,
    });
  } catch (err) { next(err); }
});

// ─── POST /api/chat/confirm-overage ──────────────────────────
// Fallback for when the webhook is slow — client can confirm directly.
// Webhook (see routes/webhooks.js) handles this primarily.
router.post('/confirm-overage', authenticate, async (req, res, next) => {
  try {
    const { sessionId, paymentIntentId } = req.body;
    if (!sessionId || !paymentIntentId) {
      return res.status(400).json({ error: 'sessionId and paymentIntentId are required' });
    }

    const pi = await stripe.paymentIntents.retrieve(paymentIntentId);
    if (pi.status !== 'succeeded') {
      return res.status(400).json({ error: `Payment status: ${pi.status}` });
    }
    if (pi.metadata.purpose !== 'chat_overage' || pi.metadata.sessionId !== sessionId) {
      return res.status(400).json({ error: 'PaymentIntent does not match session' });
    }

    // Verify ownership
    const { data: session } = await supabase
      .from('chat_sessions').select('id, user_id').eq('id', sessionId).single();
    if (!session || session.user_id !== req.user.id) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    // Idempotent credit — only grant if not already recorded against this PI
    const { data: prior } = await supabase
      .from('chat_sessions').select('metadata').eq('id', sessionId).maybeSingle();
    const granted = prior?.metadata?.granted_payment_intents || [];
    if (granted.includes(paymentIntentId)) {
      const summary = await chat.getSessionSummary({
        userId: req.user.id,
        scope: req.body.scope || 'results',
        missionId: req.body.missionId || null,
      });
      return res.json({ alreadyGranted: true, quota: summary.quota });
    }

    await chat.grantOverage(sessionId);
    // Record PI to prevent double-grant
    await supabase.from('chat_sessions').update({
      metadata: { granted_payment_intents: [...granted, paymentIntentId] },
    }).eq('id', sessionId);

    logger.info('Chat overage granted', { sessionId, paymentIntentId });
    res.json({ success: true, messagesGranted: chat.OVERAGE_MESSAGES });
  } catch (err) { next(err); }
});

module.exports = router;
