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
 * Create a refund
 */
async function createRefund({ paymentIntentId, reason = 'requested_by_customer' }) {
  const refund = await stripe.refunds.create({
    payment_intent: paymentIntentId,
    reason,
  });
  logger.info('Stripe refund created', { paymentIntentId, refundId: refund.id });
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

module.exports = { createPaymentIntent, verifyPayment, createRefund, constructWebhookEvent };
