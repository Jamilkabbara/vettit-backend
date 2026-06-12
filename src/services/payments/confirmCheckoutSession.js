/**
 * Pass 46 Phase 2 — checkout-session success fallback (audit P0-1).
 *
 * The Pass 46 audit found the live Stripe account has ZERO webhook
 * endpoints configured, so the authoritative payment trigger
 * (payment_intent.succeeded → runMission) never fires for real
 * payments: a paying customer's mission sat in pending_payment until
 * the recovery cron swept rows older than 6 HOURS.
 *
 * This module closes the gap from the path that always runs: the
 * frontend success page polls GET /api/payments/checkout-session/:id
 * every 2s. When that poll observes the session complete+paid, we
 * idempotently mark the mission paid and fire the pipeline — exactly
 * what the webhook handler would have done. Configuring the webhook
 * (Phase 2 ops step) then covers the user-never-returns case; the two
 * triggers are idempotent against each other via the status guard
 * here plus runMission's processing claim.
 */

const logger = require('../../utils/logger');
const { updateMission } = require('../../db/missionSchema');

/**
 * Statuses past which a payment trigger is a duplicate/replay.
 * Mirrors the webhook handler's POST_PAYMENT_STATUSES semantics.
 */
const POST_PAYMENT_STATUSES = new Set(['paid', 'processing', 'completed', 'failed']);

/**
 * Idempotently confirm a paid Checkout Session's mission and trigger
 * the pipeline. Safe to call repeatedly (poll loop) and concurrently
 * with the webhook.
 *
 * @param {object} deps { supabase, runMission } — injected for testability
 * @param {object} session Stripe Checkout Session (status/payment_status/metadata/amount_total/payment_intent)
 * @returns {Promise<{triggered: boolean, reason: string}>}
 */
async function confirmCheckoutSessionPaid({ supabase, runMission }, session) {
  const missionId = session?.metadata?.missionId;
  if (!missionId) return { triggered: false, reason: 'no_mission_in_metadata' };
  if (session.status !== 'complete' || session.payment_status !== 'paid') {
    return { triggered: false, reason: 'session_not_paid' };
  }

  const { data: mission, error } = await supabase
    .from('missions')
    .select('id, status, user_id')
    .eq('id', missionId)
    .single();
  if (error || !mission) {
    logger.warn('checkout-session fallback: mission fetch failed', {
      missionId, err: error?.message,
    });
    return { triggered: false, reason: 'mission_not_found' };
  }
  if (POST_PAYMENT_STATUSES.has(mission.status)) {
    return { triggered: false, reason: `already_${mission.status}` };
  }

  const piId = typeof session.payment_intent === 'string'
    ? session.payment_intent
    : session.payment_intent?.id || null;

  await updateMission(supabase, missionId, {
    status:  'paid',
    paid_at: new Date().toISOString(),
    latest_payment_intent_id: piId,
    paid_amount_cents: Number.isFinite(session.amount_total) ? session.amount_total : null,
  }, { caller: 'payments:checkout-session-poll fallback' });

  logger.warn('checkout-session fallback CONFIRMED payment → triggering pipeline', {
    missionId, sessionId: session.id, pi: piId,
  });

  // Funnel event — server-side, mirrors the webhook handler.
  try {
    await supabase.from('funnel_events').insert({
      user_id:    mission.user_id,
      event_type: 'mission_paid',
      mission_id: missionId,
      metadata:   { amount_cents: session.amount_total, source: 'checkout_session_poll_fallback' },
    });
  } catch { /* non-fatal */ }

  setImmediate(() => {
    runMission(missionId).catch((err) => {
      logger.error('runMission failed from checkout-session fallback', {
        missionId, err: err.message,
      });
    });
  });

  return { triggered: true, reason: 'confirmed' };
}

module.exports = { confirmCheckoutSessionPaid, POST_PAYMENT_STATUSES };
