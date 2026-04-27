/**
 * VETT — payment_errors writer.
 *
 * Pass 22 Bug 22.9: every Stripe failure path now writes a row here so the
 * admin viewer (and post-hoc forensic) has the data to diagnose checkout
 * failures. Before this service, payment errors were silently next(err)'d to
 * the global error handler with zero telemetry.
 *
 * Best-effort by design — a failure to write a payment_errors row should
 * never block the user-visible error response. We log warnings and move on.
 *
 * Stage values (kept as a closed set so the admin viewer can group cleanly):
 *   create_intent              — backend route /api/payments/create-intent
 *   confirm                    — backend route /api/payments/confirm
 *   webhook_payment_failed     — Stripe webhook payment_intent.payment_failed
 *   client_confirm_card        — frontend confirmCardPayment(card) catch
 *   client_wallet_payment_method — frontend wallet (Apple/Google Pay) catch
 *   client_chat_overage        — frontend OverageModal confirmCardPayment catch
 */

const supabase = require('../db/supabase');
const logger = require('../utils/logger');

/**
 * Write a payment error row. Always best-effort: returns null on failure
 * after logging a warning. Never throws.
 *
 * @param {object} input
 * @param {string|null} input.userId
 * @param {string|null} input.missionId
 * @param {string|null} input.stripePaymentIntentId
 * @param {string|null} input.errorCode             — e.g. 'card_declined', 'authentication_required'
 * @param {string|null} input.errorMessage
 * @param {string|null} input.declineCode           — e.g. 'insufficient_funds'
 * @param {string|null} input.paymentMethod         — 'card' | 'apple_pay' | 'google_pay' | 'link' | etc.
 * @param {number|null} input.amountCents
 * @param {string|null} input.currency
 * @param {string|null} input.stage                 — see stage values above
 * @param {string|null} input.userAgent             — raw User-Agent (frontend) or null (backend-only)
 * @param {string|null} input.browser               — derived; nullable
 * @param {string|null} input.os                    — derived; nullable
 * @param {number|null} input.viewportWidth         — window.innerWidth
 */
async function logPaymentError(input) {
  try {
    const row = {
      user_id:                  input.userId               || null,
      mission_id:               input.missionId            || null,
      stripe_payment_intent_id: input.stripePaymentIntentId || null,
      error_code:               input.errorCode            || null,
      error_message:            (input.errorMessage || '').toString().slice(0, 1000) || null,
      decline_code:             input.declineCode          || null,
      payment_method:           input.paymentMethod        || null,
      amount_cents:             Number.isFinite(input.amountCents) ? input.amountCents : null,
      currency:                 input.currency             || null,
      stage_at_failure:         input.stage                || null,
      user_agent:               (input.userAgent || '').toString().slice(0, 1000) || null,
      browser:                  input.browser              || null,
      os:                       input.os                   || null,
      viewport_width:           Number.isFinite(input.viewportWidth) ? input.viewportWidth : null,
    };

    const { data, error } = await supabase.from('payment_errors').insert(row).select('id').single();
    if (error) {
      logger.warn('payment_errors insert failed (non-fatal)', {
        stage: input.stage,
        missionId: input.missionId,
        err: error.message,
      });
      return null;
    }
    logger.info('payment_error logged', {
      id: data.id,
      stage: input.stage,
      missionId: input.missionId,
      errorCode: input.errorCode,
    });
    return data.id;
  } catch (err) {
    logger.warn('payment_errors logger crashed (non-fatal)', {
      stage: input?.stage,
      err: err.message,
    });
    return null;
  }
}

/**
 * Extract the Stripe error fields from a thrown error or PI status object.
 * Stripe errors have shape { code, message, decline_code, payment_method }.
 * PIs in failure states carry the same info on `last_payment_error`.
 */
function shapeStripeError(err) {
  if (!err || typeof err !== 'object') {
    return { errorCode: null, errorMessage: String(err || ''), declineCode: null, paymentMethod: null };
  }
  // err is either a thrown Stripe error or a PI's last_payment_error
  const e = err.last_payment_error || err;
  return {
    errorCode:    e.code         || e.type      || null,
    errorMessage: (e.message || '').toString() || null,
    declineCode:  e.decline_code || null,
    paymentMethod: (e.payment_method && e.payment_method.type) || null,
  };
}

module.exports = { logPaymentError, shapeStripeError };
