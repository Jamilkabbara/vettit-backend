const express = require('express');
const router = express.Router();
const { constructWebhookEvent } = require('../services/stripe');
const supabase = require('../db/supabase');
const logger = require('../utils/logger');
const { runMission } = require('../jobs/runMission');

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
      const missionId = pi.metadata?.missionId;
      if (missionId) {
        await supabase
          .from('missions')
          .update({
            payment_status: 'paid',
            status: 'paid',
            paid_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          })
          .eq('id', missionId);
        logger.info('Payment confirmed via webhook → triggering mission run', { missionId, amount: pi.amount });

        // Trigger the synthetic-audience pipeline as a fire-and-forget background job.
        // Stripe wants the webhook ack in <15s, so we don't await completion.
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
        await supabase
          .from('missions')
          .update({ payment_status: 'failed', status: 'failed', updated_at: new Date().toISOString() })
          .eq('id', missionId);

        // User-facing notification
        const { data: mission } = await supabase
          .from('missions').select('user_id, title').eq('id', missionId).single();
        if (mission?.user_id) {
          await supabase.from('notifications').insert({
            user_id: mission.user_id,
            type:    'payment_failed',
            title:   'Payment failed',
            body:    'We could not process the payment for your mission. Please try again.',
            link:    `/missions/${missionId}`,
          }).then(()=>{}).catch(()=>{});
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
