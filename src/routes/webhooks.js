const express = require('express');
const router = express.Router();
const { constructWebhookEvent } = require('../services/stripe');
const supabase = require('../db/supabase');
const logger = require('../utils/logger');
const { runMission } = require('../jobs/runMission');
const { updateMission } = require('../db/missionSchema');
const emailService = require('../services/email');

// Stripe webhooks need the raw body — this route is mounted BEFORE the JSON parser in app.js.
router.post('/stripe', express.raw({ type: 'application/json' }), async (req, res) => {
  const sig = req.headers['stripe-signature'];

  let event;
  try {
    event = constructWebhookEvent(req.body, sig);
  } catch (err) {
    logger.error('Stripe webhook signature verification failed:', err.message);
    return res.status(400).json({ error: `Webhook error: ${err.message}` });
  }

  logger.info('Stripe webhook received', { type: event.type });

  switch (event.type) {
    case 'payment_intent.succeeded': {
      const pi = event.data.object;

      // ─ Chat overage purchase ─────────────────────────────
      if (pi.metadata?.purpose === 'chat_overage') {
        const sessionId = pi.metadata.sessionId;
        if (sessionId) {
          try {
            // Idempotent: track which PaymentIntents have been applied
            const { data: existing } = await supabase
              .from('chat_sessions').select('metadata, quota_overage_purchased')
              .eq('id', sessionId).maybeSingle();
            const granted = existing?.metadata?.granted_payment_intents || [];
            if (!granted.includes(pi.id)) {
              const bump = Number(pi.metadata.messagesGranted || 50);
              await supabase.from('chat_sessions').update({
                quota_overage_purchased: (existing?.quota_overage_purchased || 0) + bump,
                metadata: { granted_payment_intents: [...granted, pi.id] },
                updated_at: new Date().toISOString(),
              }).eq('id', sessionId);
              logger.info('Chat overage credited via webhook', { sessionId, bump });
            }
          } catch (e) {
            logger.error('Chat overage webhook credit failed', { sessionId, err: e.message });
          }
        }
        break;
      }

      // ─ Mission payment ───────────────────────────────────
      const missionId = pi.metadata?.missionId;
      if (missionId) {
        // payment_status + updated_at columns don't exist in public.missions
        // — sanitizer strips them. `status: 'paid'` is the canonical signal.
        await updateMission(supabase, missionId, {
          status: 'paid',
          paid_at: new Date().toISOString(),
        }, { caller: 'webhook:payment_intent.succeeded' });
        logger.info('Payment confirmed via webhook → triggering mission run', { missionId, amount: pi.amount });

        // Trigger the synthetic-audience pipeline as a fire-and-forget background job.
        // Stripe wants the webhook ack in <15s, so we don't await completion.
        // This is the AUTHORITATIVE trigger — the frontend also pings
        // /api/missions/:id/generate-responses as a belt-and-suspenders
        // measure, and that endpoint is idempotent so a double-fire is safe.
        setImmediate(() => {
          runMission(missionId).catch(err => {
            logger.error('runMission failed from webhook', { missionId, err: err.message });
          });
        });
      }
      break;
    }

    case 'payment_intent.payment_failed': {
      const pi = event.data.object;
      const missionId = pi.metadata?.missionId;
      if (missionId) {
        await updateMission(supabase, missionId, {
          status: 'failed',
        }, { caller: 'webhook:payment_intent.payment_failed' });

        // User-facing notification + email. `mission_statement` was dropped
        // from schema; use `brief` or `title` for the email copy.
        const { data: mission } = await supabase
          .from('missions').select('user_id, title, brief').eq('id', missionId).single();
        if (mission?.user_id) {
          await supabase.from('notifications').insert({
            user_id: mission.user_id,
            type:    'payment_failed',
            title:   'Payment failed',
            body:    'We could not process the payment for your mission. Please try again.',
            link:    `/missions/${missionId}`,
          }).then(()=>{}).catch(()=>{});

          try {
            const { data: { user } } = await supabase.auth.admin.getUserById(mission.user_id);
            const { data: profile } = await supabase
              .from('profiles').select('first_name, last_name, full_name').eq('id', mission.user_id).maybeSingle();
            const name = profile?.full_name || [profile?.first_name, profile?.last_name].filter(Boolean).join(' ');
            if (user?.email) {
              await emailService.sendPaymentFailedEmail({
                to: user.email,
                name,
                missionStatement: mission.brief || mission.title || '',
                missionId,
                reason: pi.last_payment_error?.message || '',
              });
            }
          } catch (e) { logger.warn('payment_failed email skipped', { err: e.message }); }
        }
        logger.warn('Payment failed via webhook', { missionId });
      }
      break;
    }

    case 'charge.refunded': {
      const charge = event.data.object;
      logger.info('Charge refunded', { chargeId: charge.id, amount: charge.amount_refunded });
      break;
    }

    default:
      logger.debug('Unhandled webhook event type', { type: event.type });
  }

  res.json({ received: true });
});

module.exports = router;
