const express = require('express');
const router = express.Router();
const { constructWebhookEvent } = require('../services/stripe');
const supabase = require('../db/supabase');
const logger = require('../utils/logger');

// Stripe webhooks need raw body — this route is mounted BEFORE json parser in app.js
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
          .update({ payment_status: 'paid', updated_at: new Date().toISOString() })
          .eq('id', missionId);
        logger.info('Payment confirmed via webhook', { missionId, amount: pi.amount });
      }
      break;
    }

    case 'payment_intent.payment_failed': {
      const pi = event.data.object;
      const missionId = pi.metadata?.missionId;
      if (missionId) {
        await supabase
          .from('missions')
          .update({ payment_status: 'failed', updated_at: new Date().toISOString() })
          .eq('id', missionId);
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

// Pollfish webhook — called when a survey completes
router.post('/pollfish', express.json(), async (req, res) => {
  try {
    const { survey_id, status, completed_responses } = req.body;
    logger.info('Pollfish webhook received', { survey_id, status });

    if (status === 'completed' && survey_id) {
      const { data: mission } = await supabase
        .from('missions')
        .select('id')
        .eq('pollfish_survey_id', survey_id)
        .single();

      if (mission) {
        await supabase
          .from('missions')
          .update({ status: 'completed', updated_at: new Date().toISOString() })
          .eq('id', mission.id);
        logger.info('Mission completed via Pollfish webhook', { missionId: mission.id });
      }
    }

    res.json({ received: true });
  } catch (err) {
    logger.error('Pollfish webhook error', err);
    res.status(500).json({ error: 'Webhook processing failed' });
  }
});

module.exports = router;
